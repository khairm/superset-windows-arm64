// (AUTO-RESUME) Orchestrator (MAIN). Owns the registry + the durable periodic scheduler.
// Detection feeds onClaudeFailure(); a 30s tick drives decideFire -> fire-time gates ->
// host-service send -> afterSend. Cancel/takeover and the global toggle tombstone entries
// so a reload/restart can't resurrect a resume the user already took over.

import type { EventEmitter } from "node:events";
import { NOTIFICATION_EVENTS } from "shared/constants";
import { classifyClaudeFailure } from "../classifier/classifier";
import { readConfig, writeConfig } from "../config/config";
import { RESUME_MESSAGE, sendResumeViaHost } from "../host-send/host-send";
import {
	afterSend,
	applyReschedule,
	backoffDelayMs,
	decideFire,
	jitterFor,
	makeFailureId,
	RESET_BUFFER_MS,
	type ResumeEntry,
	ResumeRegistry,
} from "../registry/registry";
import { resolveResetTime } from "../reset-time/reset-time";
import {
	isStillLastMeaningfulFailure,
	readLastApiError,
} from "../transcript-tail/transcript-tail";

const TICK_MS = 30_000;
const STARTUP_RECONCILE_MS = 20_000; // let the watcher/dot state settle before firing
const MAX_CONCURRENT_SENDS = 2; // throttle the account-global rate-limit cohort
// Quiescence: wait for the transcript to settle before treating an error as turn-ending
// (Claude auto-retries transient 529s within the same turn).
const FINALITY_DEBOUNCE_MS = 8_000;
// If the user touches a terminal within this window of a failure, treat it as takeover
// and never arm (covers the pre-arm window before an entry exists to cancel).
const RECENT_INTERACTION_MS = 20_000;
// Give up loudly after this many consecutive transport failures (auth/manifest breakage)
// instead of spinning every tick for the whole 24h budget.
const MAX_TRANSPORT_FAILURES = 8;

/** Lightweight signal from the JSONL watcher: this session just wrote an API error. */
export interface ApiErrorSignal {
	sessionId: string;
	cwd: string;
	paneId?: string;
	terminalId?: string;
	workspaceId?: string;
	transcriptPath: string;
}

export interface FailureCandidate {
	sessionId: string;
	cwd: string;
	paneId?: string;
	terminalId?: string;
	workspaceId?: string;
	transcriptPath: string;
	offset: number;
	recordTimestampMs: number;
	error: string | null;
	apiErrorStatus: number | null;
	text: string;
}

interface ManagerDeps {
	emitter: EventEmitter;
	getOrganizationId: () => string | null;
}

export class AutoResumeManager {
	private readonly registry = new ResumeRegistry();
	private deps: ManagerDeps | null = null;
	private timer: NodeJS.Timeout | null = null;
	private inFlight = new Set<string>();
	private pending = new Map<
		string,
		{ timer: NodeJS.Timeout; info: ApiErrorSignal }
	>();
	// terminalId -> last user-interaction time (pre-arm takeover suppression).
	private recentInteraction = new Map<string, number>();
	// failureId -> consecutive transport-failure count (capped, then give up loud).
	private transportFailures = new Map<string, number>();

	start(deps: ManagerDeps): void {
		this.deps = deps;
		this.registry.load();
		this.timer = setInterval(() => void this.tick(), TICK_MS);
		this.timer.unref?.();
		// Reconcile overdue entries after start (post-seed; non-blocking). Delayed so the
		// watcher/dot state has settled before any fire.
		setTimeout(() => void this.tick(), STARTUP_RECONCILE_MS).unref?.();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}

	private emit(payload: Record<string, unknown>): void {
		this.deps?.emitter.emit(NOTIFICATION_EVENTS.AUTO_RESUME_STATE, payload);
	}

	/**
	 * Watcher signal: a session just appended an API error. Debounce, then confirm the
	 * error is genuinely turn-ending (quiescent + still the last meaningful record) before
	 * classifying — Claude auto-retries transient errors within a turn.
	 */
	onClaudeApiErrorSignal(info: ApiErrorSignal): void {
		const prev = this.pending.get(info.sessionId);
		if (prev) clearTimeout(prev.timer);
		const timer = setTimeout(() => {
			this.pending.delete(info.sessionId);
			void this.resolveSignal(info);
		}, FINALITY_DEBOUNCE_MS);
		timer.unref?.();
		this.pending.set(info.sessionId, { timer, info });
	}

	private async resolveSignal(info: ApiErrorSignal): Promise<void> {
		const last = await readLastApiError(info.transcriptPath);
		if (!last) return;
		const stillFinal = await isStillLastMeaningfulFailure(
			info.transcriptPath,
			last.offset,
		);
		if (!stillFinal) return; // the turn moved on (retried / progressed)
		this.onClaudeFailure({
			sessionId: info.sessionId,
			cwd: info.cwd,
			paneId: info.paneId,
			terminalId: info.terminalId,
			workspaceId: info.workspaceId,
			transcriptPath: info.transcriptPath,
			offset: last.offset,
			recordTimestampMs: last.timestampMs,
			error: last.error,
			apiErrorStatus: last.apiErrorStatus,
			text: last.text,
		});
	}

	/** Detection entry point: a turn-ending Claude API error (finality already confirmed). */
	onClaudeFailure(c: FailureCandidate): void {
		const cls = classifyClaudeFailure({
			error: c.error,
			apiErrorStatus: c.apiErrorStatus,
			text: c.text,
		});
		if (!cls.resumable) {
			this.emit({
				kind: "notify",
				sessionId: c.sessionId,
				failureClass: cls.class,
				terminalId: c.terminalId,
			});
			return;
		}
		const cfg = readConfig();
		if (!cfg.enabled) {
			this.emit({
				kind: "notify",
				sessionId: c.sessionId,
				failureClass: cls.class,
				terminalId: c.terminalId,
			});
			return;
		}
		// Fail closed: a write needs a validated terminal target from MAIN's pane map.
		if (!c.terminalId || !c.workspaceId) {
			this.emit({
				kind: "notify",
				sessionId: c.sessionId,
				failureClass: cls.class,
				reason: "no_target",
			});
			return;
		}

		const now = Date.now();

		// Pre-arm takeover: if the user touched this terminal moments ago, they're handling
		// it — don't arm (covers the window before any entry exists to cancel).
		const lastTouch = this.recentInteraction.get(c.terminalId);
		if (lastTouch !== undefined && now - lastTouch < RECENT_INTERACTION_MS) {
			return;
		}

		const failureId = makeFailureId(c.sessionId, c.transcriptPath, c.offset);
		let resumeAtMs = now + backoffDelayMs(0);
		if (cls.mode === "schedule" && cls.reset) {
			const r = resolveResetTime(
				cls.reset.timeText,
				cls.reset.tz,
				c.recordTimestampMs,
				now,
			);
			// Buffer past the reset + per-failure jitter so an account-wide cohort whose
			// limits all clear at the same instant doesn't fire in lockstep (and re-trip it).
			const jit = jitterFor(failureId);
			if (r.kind === "at") resumeAtMs = r.epochMs + RESET_BUFFER_MS + jit;
			else if (r.kind === "fire-now") resumeAtMs = now + RESET_BUFFER_MS + jit;
			// stale / unparsed -> fall back to the backoff cadence (resumeAtMs above)
		}

		// Smart re-handle: a fresh failure for a session that already has an armed entry
		// RE-ANCHORS that entry to the latest error (so the fire-time finality check uses
		// the new offset) while preserving the escalation counters — never a duplicate.
		const existing = this.registry.findBySession(c.sessionId);
		if (existing) {
			let updated: ResumeEntry = {
				...existing,
				transcriptPath: c.transcriptPath,
				offset: c.offset,
				paneId: c.paneId ?? existing.paneId,
				terminalId: c.terminalId,
				workspaceId: c.workspaceId,
				failureClass: cls.class,
				mode: cls.mode === "schedule" ? "schedule" : "backoff",
			};
			if (cls.mode === "schedule" && cls.reset) {
				updated = applyReschedule(updated, resumeAtMs, now);
			}
			if (updated.state === "gaveUp") {
				this.registry.setState(existing.failureId, "gaveUp");
				this.emit({
					kind: "gaveUp",
					sessionId: c.sessionId,
					terminalId: c.terminalId,
					failureClass: cls.class,
				});
				return;
			}
			this.registry.upsert(updated);
			this.emit({
				kind: "rehandle",
				sessionId: c.sessionId,
				terminalId: c.terminalId,
				failureClass: cls.class,
			});
			return;
		}

		const entry: ResumeEntry = {
			failureId,
			agent: "claude",
			sessionId: c.sessionId,
			orgId: this.deps?.getOrganizationId() ?? undefined,
			paneId: c.paneId,
			terminalId: c.terminalId,
			workspaceId: c.workspaceId,
			transcriptPath: c.transcriptPath,
			offset: c.offset,
			failureClass: cls.class,
			mode: cls.mode === "schedule" ? "schedule" : "backoff",
			resumeAtMs,
			sentCount: 0,
			rescheduleCount: 0,
			state: "armed",
			createdAt: now,
			firstArmedAt: now,
		};
		if (this.registry.armIfNew(entry)) {
			this.emit({
				kind: "armed",
				sessionId: c.sessionId,
				terminalId: c.terminalId,
				failureClass: cls.class,
				resumeAtMs,
			});
		}
	}

	/** A user interaction with the terminal (or a manual write) = takeover; cancel. */
	cancelForSession(sessionId: string): void {
		const prev = this.pending.get(sessionId);
		if (prev) {
			clearTimeout(prev.timer);
			if (prev.info.terminalId) {
				this.recentInteraction.set(prev.info.terminalId, Date.now());
			}
			this.pending.delete(sessionId);
		}
		if (this.registry.cancelSession(sessionId) > 0) {
			this.emit({ kind: "cancelled", sessionId });
		}
	}

	/** Cancel by host-service terminal id (what the renderer pane knows). */
	cancelForTerminal(terminalId: string): void {
		// Record the interaction so a failure currently in the finality-debounce window
		// (no entry yet) is not armed afterwards.
		this.recentInteraction.set(terminalId, Date.now());
		// Drop any pending (not-yet-armed) signal for this terminal.
		for (const [key, p] of [...this.pending]) {
			if (p.info.terminalId === terminalId) {
				clearTimeout(p.timer);
				this.pending.delete(key);
			}
		}
		if (this.registry.cancelByTerminal(terminalId) > 0) {
			this.emit({ kind: "cancelled", terminalId });
		}
	}

	setEnabled(enabled: boolean): void {
		writeConfig({ enabled });
		if (!enabled) {
			this.registry.cancelAll();
			this.emit({ kind: "disabled" });
		}
	}

	getConfig() {
		return readConfig();
	}

	getArmedSummary(): Array<
		Pick<
			ResumeEntry,
			"sessionId" | "terminalId" | "failureClass" | "resumeAtMs" | "sentCount"
		>
	> {
		return this.registry.armed().map((e) => ({
			sessionId: e.sessionId,
			terminalId: e.terminalId,
			failureClass: e.failureClass,
			resumeAtMs: e.resumeAtMs,
			sentCount: e.sentCount,
		}));
	}

	private async tick(): Promise<void> {
		if (!this.deps) return;
		if (!readConfig().enabled) return;
		const now = Date.now();
		for (const entry of this.registry.armed()) {
			const decision = decideFire(entry, now);
			if (decision.action === "giveUp") {
				this.registry.setState(entry.failureId, "gaveUp");
				this.transportFailures.delete(entry.failureId);
				this.emit({
					kind: "gaveUp",
					sessionId: entry.sessionId,
					terminalId: entry.terminalId,
					failureClass: entry.failureClass,
				});
				continue;
			}
			if (decision.action !== "fire") continue;
			if (this.inFlight.has(entry.failureId)) continue;
			// Global concurrency cap — fire() adds to inFlight synchronously (before its
			// first await), so inFlight.size already reflects this-tick launches.
			if (this.inFlight.size >= MAX_CONCURRENT_SENDS) break;
			void this.fire(entry);
		}
	}

	private async fire(entry: ResumeEntry): Promise<void> {
		this.inFlight.add(entry.failureId);
		try {
			// Finality gate: still the last meaningful record? (else it self-recovered /
			// the user took over / our previous resume already landed).
			const stillFailed = await isStillLastMeaningfulFailure(
				entry.transcriptPath,
				entry.offset,
			);
			if (!stillFailed) {
				this.registry.setState(entry.failureId, "done");
				this.transportFailures.delete(entry.failureId);
				this.emit({
					kind: "resolved",
					sessionId: entry.sessionId,
					terminalId: entry.terminalId,
				});
				return;
			}
			// The finality read above awaited; if the user took over in that window the
			// entry was deleted/tombstoned — don't send into their live session.
			if (!this.registry.get(entry.failureId)) return;
			// Target the host that produced this transcript (pinned at arm time), not just
			// "the first live host" — multi-org desktops run several.
			const orgId = entry.orgId ?? this.deps?.getOrganizationId() ?? null;
			if (!orgId || !entry.terminalId || !entry.workspaceId) {
				// Host not resolvable yet — transient, retry under the cap (never silent giveUp).
				this.recordTransientFailure(entry, "no_host");
				return;
			}
			const outcome = await sendResumeViaHost({
				organizationId: orgId,
				workspaceId: entry.workspaceId,
				terminalId: entry.terminalId,
				expectedAgentSessionId: entry.sessionId,
				failureId: entry.failureId,
				data: RESUME_MESSAGE,
			});
			if (outcome.sent) {
				this.transportFailures.delete(entry.failureId);
				// A takeover during the in-flight send deleted the entry — do NOT resurrect
				// it via upsert (that would re-arm a cancelled resume).
				if (!this.registry.get(entry.failureId)) return;
				const advanced = afterSend(entry, Date.now());
				this.registry.upsert(advanced);
				this.emit({
					kind: advanced.state === "gaveUp" ? "gaveUp" : "sent",
					sessionId: entry.sessionId,
					terminalId: entry.terminalId,
					failureClass: entry.failureClass,
					sentCount: advanced.sentCount,
				});
				return;
			}
			// Only a definitive, terminal-specific rejection ends the chain. not_found /
			// agent_mismatch / bad_response are transient (a wrong/just-starting host, or a
			// binding that populates slightly late) and retry under the cap instead of
			// permanently abandoning the resume.
			const TERMINAL_REASONS = new Set([
				"wrong_workspace",
				"exited",
				"ambiguous",
			]);
			if (TERMINAL_REASONS.has(outcome.reason)) {
				this.registry.setState(entry.failureId, "done");
				this.transportFailures.delete(entry.failureId);
				this.emit({
					kind: "skipped",
					sessionId: entry.sessionId,
					terminalId: entry.terminalId,
					reason: outcome.reason,
				});
				return;
			}
			this.recordTransientFailure(entry, outcome.reason);
		} finally {
			this.inFlight.delete(entry.failureId);
		}
	}

	/** Count a transient transport failure; give up loudly after the cap so a permanent
	 * auth/manifest breakage doesn't spin every tick for the whole 24h budget. */
	private recordTransientFailure(entry: ResumeEntry, reason: string): void {
		const n = (this.transportFailures.get(entry.failureId) ?? 0) + 1;
		this.transportFailures.set(entry.failureId, n);
		if (n >= MAX_TRANSPORT_FAILURES) {
			this.transportFailures.delete(entry.failureId);
			this.registry.setState(entry.failureId, "gaveUp");
			this.emit({
				kind: "gaveUp",
				sessionId: entry.sessionId,
				terminalId: entry.terminalId,
				failureClass: entry.failureClass,
				reason,
			});
		}
		// else: leave armed, retry next tick.
	}
}

export const autoResumeManager = new AutoResumeManager();
