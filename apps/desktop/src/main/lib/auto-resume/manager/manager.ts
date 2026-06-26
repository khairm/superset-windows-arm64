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
const MAX_CONCURRENT_SENDS = 2; // throttle the account-global rate-limit cohort
// Quiescence: wait for the transcript to settle before treating an error as turn-ending
// (Claude auto-retries transient 529s within the same turn).
const FINALITY_DEBOUNCE_MS = 8_000;

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

	start(deps: ManagerDeps): void {
		this.deps = deps;
		this.registry.load();
		this.timer = setInterval(() => void this.tick(), TICK_MS);
		this.timer.unref?.();
		// Reconcile overdue entries shortly after start (post-seed; non-blocking).
		setTimeout(() => void this.tick(), 5_000).unref?.();
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
		let resumeAtMs = now + backoffDelayMs(0);
		if (cls.mode === "schedule" && cls.reset) {
			const r = resolveResetTime(
				cls.reset.timeText,
				cls.reset.tz,
				c.recordTimestampMs,
				now,
			);
			if (r.kind === "at") resumeAtMs = r.epochMs + RESET_BUFFER_MS;
			else if (r.kind === "fire-now") resumeAtMs = now;
			// stale / unparsed -> fall back to the backoff cadence (resumeAtMs above)
		}

		// Smart re-handle: a fresh failure for a session that already has an armed entry
		// updates that entry instead of creating a duplicate.
		const existing = this.registry.findBySession(c.sessionId);
		if (existing) {
			const updated =
				cls.mode === "schedule" && cls.reset
					? applyReschedule(existing, resumeAtMs, now)
					: existing;
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
			failureId: makeFailureId(c.sessionId, c.transcriptPath, c.offset),
			agent: "claude",
			sessionId: c.sessionId,
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
		if (this.registry.cancelSession(sessionId) > 0) {
			this.emit({ kind: "cancelled", sessionId });
		}
	}

	/** Cancel by host-service terminal id (what the renderer pane knows). */
	cancelForTerminal(terminalId: string): void {
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
		let launched = 0;
		for (const entry of this.registry.armed()) {
			const decision = decideFire(entry, now);
			if (decision.action === "giveUp") {
				this.registry.setState(entry.failureId, "gaveUp");
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
			if (launched >= MAX_CONCURRENT_SENDS) continue;
			launched++;
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
				this.emit({
					kind: "resolved",
					sessionId: entry.sessionId,
					terminalId: entry.terminalId,
				});
				return;
			}
			const orgId = this.deps?.getOrganizationId();
			if (!orgId || !entry.terminalId || !entry.workspaceId) {
				this.registry.setState(entry.failureId, "gaveUp");
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
			// Not sent: decide retry vs give-up by reason.
			if (
				outcome.reason === "busy" ||
				outcome.reason.startsWith("http_") ||
				outcome.reason === "no_manifest" ||
				outcome.reason === "fetch_error" ||
				outcome.reason === "AbortError"
			) {
				// transient — leave armed, retry next tick (no count change)
				return;
			}
			// not_found / wrong_workspace / exited / agent_mismatch / bad_response => unrecoverable
			this.registry.setState(entry.failureId, "done");
			this.emit({
				kind: "skipped",
				sessionId: entry.sessionId,
				terminalId: entry.terminalId,
				reason: outcome.reason,
			});
		} finally {
			this.inFlight.delete(entry.failureId);
		}
	}
}

export const autoResumeManager = new AutoResumeManager();
