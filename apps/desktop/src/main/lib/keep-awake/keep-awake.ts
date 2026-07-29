/**
 * (KEEP-AWAKE) Hold Windows awake while an agent is working or a question is
 * pending.
 *
 * WHY THIS EXISTS
 * ---------------
 * The superset-companion phone app runs a liveness watchdog: if the last sync
 * showed `working > 0 || needsInput > 0` and no heartbeat lands for three
 * intervals, it raises "lost contact with the desktop". Without a power
 * request, an ordinary Windows sleep trips that watchdog several times a day.
 * A watchdog that cries wolf every day is muted inside a week, and a muted
 * watchdog is the same as one that was never built. So: while there is real
 * agent work in flight, the machine must stay reachable.
 *
 * BLOCKER TYPE — deliberate choice
 * -------------------------------
 * `prevent-app-suspension`, NOT `prevent-display-sleep`.
 *
 *   - `prevent-app-suspension` keeps the SYSTEM out of sleep/suspend while
 *     letting the display power down normally. On Windows this is
 *     `SetThreadExecutionState(ES_SYSTEM_REQUIRED | ES_CONTINUOUS)`.
 *     The machine stays on the network, the host-service keeps answering, the
 *     phone keeps getting heartbeats — which is the entire point.
 *   - `prevent-display-sleep` additionally pins the monitor on
 *     (`ES_DISPLAY_REQUIRED`). We want the machine reachable, not the screen
 *     lit: a desk lamp left burning all night is a cost with no benefit, and
 *     on a laptop it is a materially worse battery outcome.
 *
 * The blocker does NOT defeat hibernation initiated by the user, a lid close
 * with a hibernate policy, or a hard power loss. Those remain real ways to
 * lose contact and are exactly what the phone-side watchdog is for.
 *
 * ONLY FOR PEOPLE WHO ACTUALLY HAVE THE COMPANION
 * -----------------------------------------------
 * The whole justification above is "the phone must be able to reach this
 * machine". A fork user with no companion gets none of that benefit and would
 * pay for it in battery, so the hold is gated on the companion bridge being
 * enabled AND at least one device being paired (`companion-gate.ts`), evaluated
 * every tick by `index.ts`. This class is deliberately unaware of that: it is
 * handed an activity set and holds or releases accordingly, and a closed gate
 * reaches it as an empty set.
 *
 * SOURCE OF TRUTH
 * ---------------
 * This module owns no agent-state machine of its own. It consumes
 * `AgentActivitySnapshot`s produced by `agent-activity.ts`, which reads the
 * host-service `TerminalAgentStore` — the same store `notifications.hook`
 * writes and the renderer's dots derive from. See that file for why the read
 * crosses a process boundary.
 *
 * Deliberately imports nothing from `electron`: the power service and the
 * logger are injected, so this file is unit-testable outside an Electron
 * runtime (same pattern as `NotificationManager`).
 */

/**
 * Electron's own name for the request. Kept as a typed constant so the
 * deliberate choice above is greppable and cannot drift silently.
 */
export const KEEP_AWAKE_BLOCKER_TYPE = "prevent-app-suspension" as const;

export type KeepAwakeBlockerType = typeof KEEP_AWAKE_BLOCKER_TYPE;

/** The slice of Electron's `powerSaveBlocker` this module uses. */
export interface PowerSaveBlockerLike {
	start(type: KeepAwakeBlockerType): number;
	stop(id: number): void;
	isStarted(id: number): boolean;
}

export interface KeepAwakeLogger {
	info(message: string, meta?: unknown): void;
	warn(message: string, meta?: unknown): void;
	error(message: string, meta?: unknown): void;
}

/**
 * A binding the activity source considers "in flight". `lastEventType` is the
 * host-service `AgentLifecycleEventType` vocabulary verbatim — this module
 * never re-invents or re-maps it.
 *
 * Deliberately only what `update()` consumes. The activity source validates
 * `workspaceId`, `agentId` and `lastEventAt` at the boundary and hard-errors on
 * a malformed row; carrying them here as well made them look like inputs to the
 * blocker decision, which they never were.
 */
export interface ActiveAgent {
	terminalId: string;
	lastEventType: string;
}

/** Why the last transition happened, for the log line and the exposed state. */
export type KeepAwakeTransition = "acquired" | "released" | "unchanged";

/**
 * Snapshot of the blocker, exposed in-process by `KeepAwakeManager.getState()`.
 *
 * IN-PROCESS ONLY, and deliberately minimal. `index.ts` reads `held` and
 * nothing else; the remaining fields are the fail-loud contract the unit tests
 * pin. PROTOCOL.md §7.7 defines the companion's `HeartbeatResponse` and has no
 * keep-awake field, so a blocker fault reaches the user through the desktop log
 * (loudly, below), not through the phone.
 *
 * The reason set behind a hold is NOT here: `acquire()` logs the terminals and
 * event types it acted on, which is where a diagnosis actually starts, and a
 * per-tick copy of that set had no reader at all.
 */
export interface KeepAwakeState {
	/** True iff a power request is currently held AND Electron confirms it. */
	held: boolean;
	/** Electron's blocker id while held; null otherwise. */
	blockerId: number | null;
	blockerType: KeepAwakeBlockerType;
	/** When the CURRENT hold started. Null when not held. */
	heldSinceMs: number | null;
	/**
	 * Non-null when acquiring or releasing FAILED. Never cleared by a merely
	 * quiet tick — only by a subsequent successful transition. A broken power
	 * request must be visible rather than presenting as a mysterious watchdog
	 * alarm on the phone, so it is also logged at error level every time it
	 * happens.
	 */
	failure: string | null;
}

export interface KeepAwakeManagerDeps {
	/** Electron's `powerSaveBlocker`, or a fake in tests. Required. */
	powerSaveBlocker: PowerSaveBlockerLike;
	/** Required — every transition and every failure is logged. */
	logger: KeepAwakeLogger;
	/** Injected for tests; defaults to `Date.now`. */
	now?: () => number;
}

/**
 * Holds at most one power request, driven by successive activity snapshots.
 *
 * Idempotent by construction: `update()` with the same activity set twice in a
 * row performs no Electron call and emits no log line.
 */
export class KeepAwakeManager {
	private readonly blocker: PowerSaveBlockerLike;
	private readonly logger: KeepAwakeLogger;
	private readonly now: () => number;

	private blockerId: number | null = null;
	private heldSinceMs: number | null = null;
	private failure: string | null = null;

	constructor(deps: KeepAwakeManagerDeps) {
		this.blocker = deps.powerSaveBlocker;
		this.logger = deps.logger;
		this.now = deps.now ?? Date.now;
	}

	/**
	 * Apply an activity snapshot. Acquires when `active` is non-empty, releases
	 * when it is empty.
	 *
	 * A FAILED poll must never be passed here as an empty snapshot — that would
	 * silently release the machine to sleep on a transient HTTP error. The
	 * caller is responsible for skipping the update instead (see
	 * `agent-activity.ts`). A CLOSED companion gate is the opposite case: it is
	 * a proven "there is nothing to stay awake for", so the caller passes an
	 * empty set on purpose (see `companion-gate.ts`).
	 */
	update(active: ActiveAgent[]): KeepAwakeTransition {
		const terminalIds = [...new Set(active.map((a) => a.terminalId))].sort();
		const shouldHold = terminalIds.length > 0;
		const isHeld = this.isHeld();

		if (shouldHold && !isHeld) {
			// Derived here rather than every tick: only an acquisition logs it.
			const eventTypes = [
				...new Set(active.map((a) => a.lastEventType)),
			].sort();
			this.acquire(terminalIds, eventTypes);
			return "acquired";
		}
		if (!shouldHold && isHeld) {
			this.release();
			return "released";
		}
		return "unchanged";
	}

	/** Release unconditionally. Safe to call when nothing is held. */
	dispose(): void {
		if (this.isHeld()) {
			this.release();
		}
	}

	getState(): KeepAwakeState {
		return {
			held: this.isHeld(),
			blockerId: this.blockerId,
			blockerType: KEEP_AWAKE_BLOCKER_TYPE,
			heldSinceMs: this.heldSinceMs,
			failure: this.failure,
		};
	}

	private isHeld(): boolean {
		if (this.blockerId === null) return false;
		return this.blocker.isStarted(this.blockerId);
	}

	private acquire(terminalIds: string[], eventTypes: string[]): void {
		const id = this.blocker.start(KEEP_AWAKE_BLOCKER_TYPE);
		// FAIL LOUD. `powerSaveBlocker.start` returns an id unconditionally; the
		// only honest proof the OS honoured the request is `isStarted`. If it
		// did not, say so — every tick, in the log, and in the state this manager
		// exposes. Never pretend the machine is being held awake.
		if (!this.blocker.isStarted(id)) {
			this.blockerId = null;
			this.heldSinceMs = null;
			this.failure =
				`powerSaveBlocker.start("${KEEP_AWAKE_BLOCKER_TYPE}") returned id ${id} ` +
				`but isStarted(${id}) is false — the OS refused the power request. ` +
				`The machine WILL sleep while agents are working.`;
			this.logger.error(`[keep-awake] ${this.failure}`, {
				terminalIds,
				eventTypes,
			});
			return;
		}

		this.blockerId = id;
		this.heldSinceMs = this.now();
		this.failure = null;
		this.logger.info("[keep-awake] acquired", {
			blockerId: id,
			blockerType: KEEP_AWAKE_BLOCKER_TYPE,
			terminalCount: terminalIds.length,
			terminalIds,
			eventTypes,
		});
	}

	private release(): void {
		const id = this.blockerId;
		if (id === null) return;
		const heldForMs =
			this.heldSinceMs === null ? null : this.now() - this.heldSinceMs;

		this.blocker.stop(id);
		// Same rule on the way out: if Electron still reports the request as
		// live after stop(), the machine is pinned awake indefinitely. That is a
		// bug worth shouting about, not a detail to swallow.
		if (this.blocker.isStarted(id)) {
			this.failure =
				`powerSaveBlocker.stop(${id}) did not clear the request — the ` +
				`machine may stay awake indefinitely.`;
			this.logger.error(`[keep-awake] ${this.failure}`, { blockerId: id });
			return;
		}

		this.blockerId = null;
		this.heldSinceMs = null;
		this.failure = null;
		this.logger.info("[keep-awake] released", {
			blockerId: id,
			heldForMs,
			reason:
				"no agent working and no question pending, or the companion gate closed",
		});
	}
}
