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
	orgId?: string; // host-service org captured at arm time (fire targets this host)
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
	firstSendAt?: number; // first actual send — the 24h retry budget runs from here
	lastSendAt?: number;
}

/** Gap before send number `sentCount` (0-indexed): 60, 180, 540, 1620, 4860s. */
export function backoffDelayMs(sentCount: number): number {
	return BACKOFF_BASE_MS * BACKOFF_FACTOR ** sentCount;
}

/** Deterministic-but-spread per-failure jitter (no Math.random) to break the
 * account-global "thundering herd" when every chat's reset lands at the same instant. */
export function jitterFor(failureId: string): number {
	let h = 0;
	for (let i = 0; i < failureId.length; i++) {
		h = (h * 31 + failureId.charCodeAt(i)) >>> 0;
	}
	return h % JITTER_MAX_MS;
}

/** The retry budget only runs once we've actually started sending — before the first
 * send an entry may legitimately wait days for a weekly reset (capped at 8d upstream). */
function retryBudgetExceeded(entry: ResumeEntry, nowMs: number): boolean {
	return (
		entry.firstSendAt !== undefined &&
		nowMs - entry.firstSendAt > WALLCLOCK_BUDGET_MS
	);
}

export type FireDecision =
	| { action: "fire" }
	| { action: "wait" }
	| { action: "giveUp" };

/** What should happen to an armed entry at `nowMs`? */
export function decideFire(entry: ResumeEntry, nowMs: number): FireDecision {
	if (entry.state !== "armed") return { action: "wait" };
	if (entry.sentCount >= MAX_SENDS) return { action: "giveUp" };
	if (retryBudgetExceeded(entry, nowMs)) return { action: "giveUp" };
	if (nowMs >= entry.resumeAtMs) return { action: "fire" };
	return { action: "wait" };
}

/** Advance an entry after a successful send: schedule the next escalation step. */
export function afterSend(entry: ResumeEntry, nowMs: number): ResumeEntry {
	const sentCount = entry.sentCount + 1;
	const firstSendAt = entry.firstSendAt ?? nowMs;
	const next = { ...entry, sentCount, firstSendAt, lastSendAt: nowMs };
	if (sentCount >= MAX_SENDS || retryBudgetExceeded(next, nowMs)) {
		return { ...next, state: "gaveUp" };
	}
	return {
		...next,
		state: "armed",
		// Next attempt uses the next escalation gap; the fire-time transcript gate
		// makes this a no-op once the agent actually resumed.
		resumeAtMs: nowMs + backoffDelayMs(sentCount) + jitterFor(entry.failureId),
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
		retryBudgetExceeded(entry, nowMs)
	) {
		return { ...entry, rescheduleCount, state: "gaveUp" };
	}
	return {
		...entry,
		rescheduleCount,
		state: "armed",
		resumeAtMs: newResumeAtMs + jitterFor(entry.failureId),
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

const MAX_TOMBSTONES = 200;

export class ResumeRegistry {
	private entries = new Map<string, ResumeEntry>();
	// Bounded cancel/give-up tombstones: a failureId here can never be re-armed, so a
	// takeover survives a reload/restart even if the same error is somehow re-detected.
	private tombstones: string[] = [];
	private tombstoneSet = new Set<string>();

	load(): void {
		try {
			const raw = fs.readFileSync(REGISTRY_PATH, "utf8");
			const parsed = JSON.parse(raw) as
				| ResumeEntry[]
				| { entries?: ResumeEntry[]; tombstones?: string[] };
			const entries = Array.isArray(parsed) ? parsed : (parsed.entries ?? []);
			const tombstones = Array.isArray(parsed) ? [] : (parsed.tombstones ?? []);
			this.entries = new Map(entries.map((e) => [e.failureId, e]));
			this.tombstones = tombstones.slice(-MAX_TOMBSTONES);
			this.tombstoneSet = new Set(this.tombstones);
		} catch {
			this.entries = new Map();
			this.tombstones = [];
			this.tombstoneSet = new Set();
		}
	}

	private tombstone(failureId: string): void {
		if (this.tombstoneSet.has(failureId)) return;
		this.tombstoneSet.add(failureId);
		this.tombstones.push(failureId);
		if (this.tombstones.length > MAX_TOMBSTONES) {
			const dropped = this.tombstones.shift();
			if (dropped) this.tombstoneSet.delete(dropped);
		}
	}

	private persist(): void {
		try {
			fs.mkdirSync(AUTO_RESUME_DIR, { recursive: true, mode: 0o700 });
			// Drop terminal states so the file can't grow unbounded.
			const keep = [...this.entries.values()].filter(
				(e) => e.state === "armed" || e.state === "sent",
			);
			fs.writeFileSync(
				REGISTRY_PATH,
				JSON.stringify({ entries: keep, tombstones: this.tombstones }),
				{ mode: 0o600 },
			);
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

	/**
	 * Idempotent: arming an already-known OR tombstoned failureId is a no-op
	 * (returns false). The tombstone check keeps a cancelled failure from re-arming.
	 */
	armIfNew(entry: ResumeEntry): boolean {
		if (
			this.entries.has(entry.failureId) ||
			this.tombstoneSet.has(entry.failureId)
		) {
			return false;
		}
		this.entries.set(entry.failureId, entry);
		this.persist();
		return true;
	}

	setState(failureId: string, state: EntryState): void {
		const e = this.entries.get(failureId);
		if (!e) return;
		e.state = state;
		if (state === "cancelled" || state === "gaveUp" || state === "done") {
			if (state !== "done") this.tombstone(failureId);
			this.entries.delete(failureId);
		}
		this.persist();
	}

	cancelSession(sessionId: string): number {
		let n = 0;
		for (const e of [...this.entries.values()]) {
			if (e.sessionId === sessionId) {
				this.tombstone(e.failureId);
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
				this.tombstone(e.failureId);
				this.entries.delete(e.failureId);
				n++;
			}
		}
		if (n > 0) this.persist();
		return n;
	}

	cancelAll(): void {
		for (const id of this.entries.keys()) this.tombstone(id);
		this.entries.clear();
		this.persist();
	}
}
