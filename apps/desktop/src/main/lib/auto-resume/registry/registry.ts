// (AUTO-RESUME) Durable failure registry + pure scheduling state machine.
//
// Owns the on-disk list of armed auto-resume entries (~/.superset/auto-resume/registry.json)
// and the pure transitions the scheduler drives. Persistence makes the 5-send cap, the
// fire-at-reset-time, and cancel/takeover tombstones survive a renderer reload AND a full
// app restart (the scheduler reconciles overdue entries on startup instead of restarting
// the cadence). Identity is stable per failure: sessionId + transcriptPath + byte offset.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FailureClass } from "../classifier/classifier";

export const AUTO_RESUME_DIR = path.join(
	os.homedir(),
	".superset",
	"auto-resume",
);
const REGISTRY_PATH = path.join(AUTO_RESUME_DIR, "registry.json");

// Cadence: wait 60s then TRIPLE the gap, max 5 sends, then give up.
export const BACKOFF_BASE_MS = 60_000;
export const BACKOFF_FACTOR = 3;
export const MAX_SENDS = 5;
export const MAX_RESCHEDULES = 3;
export const WALLCLOCK_BUDGET_MS = 24 * 60 * 60 * 1000;
// Per-terminal jitter to break the account-global "thundering herd" at reset+30s.
export const JITTER_MAX_MS = 120_000;
export const RESET_BUFFER_MS = 30_000;

export type EntryState = "armed" | "sent" | "cancelled" | "gaveUp" | "done";

export interface ResumeEntry {
	failureId: string;
	agent: "claude" | "codex";
	sessionId: string;
	paneId?: string;
	terminalId?: string;
	workspaceId?: string;
	transcriptPath: string;
	offset: number;
	failureClass: FailureClass;
	mode: "schedule" | "backoff";
	resumeAtMs: number;
	sentCount: number;
	rescheduleCount: number;
	state: EntryState;
	createdAt: number;
	firstArmedAt: number;
	lastSendAt?: number;
}

/** Gap before send number `sentCount` (0-indexed): 60, 180, 540, 1620, 4860s. */
export function backoffDelayMs(sentCount: number): number {
	return BACKOFF_BASE_MS * BACKOFF_FACTOR ** sentCount;
}

function jitter(failureId: string): number {
	// Deterministic-but-spread offset derived from the id (no Math.random needed).
	let h = 0;
	for (let i = 0; i < failureId.length; i++) {
		h = (h * 31 + failureId.charCodeAt(i)) >>> 0;
	}
	return h % JITTER_MAX_MS;
}

export type FireDecision =
	| { action: "fire" }
	| { action: "wait" }
	| { action: "giveUp" };

/** What should happen to an armed entry at `nowMs`? */
export function decideFire(entry: ResumeEntry, nowMs: number): FireDecision {
	if (entry.state !== "armed") return { action: "wait" };
	if (entry.sentCount >= MAX_SENDS) return { action: "giveUp" };
	if (nowMs - entry.firstArmedAt > WALLCLOCK_BUDGET_MS)
		return { action: "giveUp" };
	if (nowMs >= entry.resumeAtMs) return { action: "fire" };
	return { action: "wait" };
}

/** Advance an entry after a successful send: schedule the next escalation step. */
export function afterSend(entry: ResumeEntry, nowMs: number): ResumeEntry {
	const sentCount = entry.sentCount + 1;
	if (
		sentCount >= MAX_SENDS ||
		nowMs - entry.firstArmedAt > WALLCLOCK_BUDGET_MS
	) {
		return { ...entry, sentCount, state: "gaveUp", lastSendAt: nowMs };
	}
	return {
		...entry,
		sentCount,
		lastSendAt: nowMs,
		state: "armed",
		// Next attempt uses the next escalation gap; the fire-time transcript gate
		// makes this a no-op once the agent actually resumed.
		resumeAtMs: nowMs + backoffDelayMs(sentCount) + jitter(entry.failureId),
	};
}

/**
 * Smart re-handle: a fresh failure arrived for a session that already has an armed/sent
 * entry. A rate-limit-with-time reschedules to the NEW time (bounded); anything else just
 * keeps the existing escalation. Returns the updated entry (or "gaveUp").
 */
export function applyReschedule(
	entry: ResumeEntry,
	newResumeAtMs: number,
	nowMs: number,
): ResumeEntry {
	const rescheduleCount = entry.rescheduleCount + 1;
	if (
		rescheduleCount > MAX_RESCHEDULES ||
		entry.sentCount >= MAX_SENDS ||
		nowMs - entry.firstArmedAt > WALLCLOCK_BUDGET_MS
	) {
		return { ...entry, rescheduleCount, state: "gaveUp" };
	}
	return {
		...entry,
		rescheduleCount,
		state: "armed",
		resumeAtMs: newResumeAtMs + jitter(entry.failureId),
	};
}

// --- durable storage ------------------------------------------------------
export function makeFailureId(
	sessionId: string,
	transcriptPath: string,
	offset: number,
): string {
	// Stable identity; offset disambiguates repeated failures in one session.
	return `${sessionId}:${path.basename(transcriptPath)}:${offset}`;
}

export class ResumeRegistry {
	private entries = new Map<string, ResumeEntry>();

	load(): void {
		try {
			const raw = fs.readFileSync(REGISTRY_PATH, "utf8");
			const parsed = JSON.parse(raw) as ResumeEntry[];
			this.entries = new Map(parsed.map((e) => [e.failureId, e]));
		} catch {
			this.entries = new Map();
		}
	}

	private persist(): void {
		try {
			fs.mkdirSync(AUTO_RESUME_DIR, { recursive: true, mode: 0o700 });
			// Drop terminal states so the file can't grow unbounded.
			const keep = [...this.entries.values()].filter(
				(e) => e.state === "armed" || e.state === "sent",
			);
			fs.writeFileSync(REGISTRY_PATH, JSON.stringify(keep), { mode: 0o600 });
		} catch {
			// best-effort; an unwritable registry only loses durability, not safety
		}
	}

	get(failureId: string): ResumeEntry | undefined {
		return this.entries.get(failureId);
	}

	findBySession(sessionId: string): ResumeEntry | undefined {
		for (const e of this.entries.values()) {
			if (
				e.sessionId === sessionId &&
				(e.state === "armed" || e.state === "sent")
			) {
				return e;
			}
		}
		return undefined;
	}

	armed(): ResumeEntry[] {
		return [...this.entries.values()].filter((e) => e.state === "armed");
	}

	upsert(entry: ResumeEntry): void {
		this.entries.set(entry.failureId, entry);
		this.persist();
	}

	/** Idempotent: arming an already-known failureId is a no-op (returns false). */
	armIfNew(entry: ResumeEntry): boolean {
		if (this.entries.has(entry.failureId)) return false;
		this.entries.set(entry.failureId, entry);
		this.persist();
		return true;
	}

	setState(failureId: string, state: EntryState): void {
		const e = this.entries.get(failureId);
		if (!e) return;
		e.state = state;
		if (state === "cancelled" || state === "gaveUp" || state === "done") {
			this.entries.delete(failureId);
		}
		this.persist();
	}

	cancelSession(sessionId: string): number {
		let n = 0;
		for (const e of [...this.entries.values()]) {
			if (e.sessionId === sessionId) {
				this.entries.delete(e.failureId);
				n++;
			}
		}
		if (n > 0) this.persist();
		return n;
	}

	cancelByTerminal(terminalId: string): number {
		let n = 0;
		for (const e of [...this.entries.values()]) {
			if (e.terminalId === terminalId) {
				this.entries.delete(e.failureId);
				n++;
			}
		}
		if (n > 0) this.persist();
		return n;
	}

	cancelAll(): void {
		this.entries.clear();
		this.persist();
	}
}
