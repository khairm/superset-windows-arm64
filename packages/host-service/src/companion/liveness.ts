/**
 * (BRIDGE-LIVENESS) Does this terminal still exist?
 *
 * ---------------------------------------------------------------------------
 * THE BUG THIS MODULE IS THE ANSWER TO
 * ---------------------------------------------------------------------------
 * `terminal_sessions.status = 'active' AND ended_at IS NULL` is NOT liveness and
 * never was. A row leaves `active` only via an explicit dispose or a live
 * in-process `onExit`; a host-service crash, a force-quit or a machine reboot
 * leaves it `active` forever, and the reaper only ever walked daemon -> row, so
 * nothing corrected it. Measured on this machine: 403 rows matched that
 * predicate, spanning 77 days, of which 3 had been attached in the last 24 h.
 * Eight of them were frozen on `PermissionRequest`, so the phone badged eight
 * blocked agents that had not existed for weeks — the cry-wolf failure the whole
 * protocol was written to avoid.
 *
 * ---------------------------------------------------------------------------
 * THE FAILURE DIRECTION IS FIXED: UNCERTAINTY MEANS LIVE
 * ---------------------------------------------------------------------------
 * Hiding a terminal that is alive hides a blocked agent — the one thing the
 * companion exists to surface. Showing one that is dead costs a stale row. So
 * every uncertainty resolves to LIVE, and `false` is returned ONLY on positive,
 * fresh evidence of death:
 *
 *   this process has no session for it, AND
 *   a daemon listing taken within the trust window did not contain it, AND
 *   nothing has touched the row inside the activity grace.
 *
 * Consequences of that ordering, all deliberate:
 *  - daemon unreachable        -> no evidence -> everything is live
 *  - daemon listing EMPTY      -> no evidence during the documented ~90 s
 *                                 adoption warm-up, evidence after it
 *  - snapshot older than the
 *    trust window              -> no evidence -> everything is live
 *
 * ---------------------------------------------------------------------------
 * WHY `isLive` IS SYNCHRONOUS
 * ---------------------------------------------------------------------------
 * The answer path consults this 4-6 times per answer sequence through
 * `findActiveHostTerminalId`, inside guard adapters that must not each pay a
 * daemon round trip. So the daemon listing is a SNAPSHOT refreshed by the two
 * async read handlers (`/v1/tree`, `/v1/heartbeat`) that already await, plus an
 * opportunistic background refresh whenever a synchronous caller finds the
 * snapshot older than its TTL. A synchronous caller therefore reads at worst a
 * slightly stale snapshot — and staleness fails toward live.
 *
 * This is a DISPLAY-AND-EXPIRY predicate, not an answer guard. The answer path
 * still proves liveness for real with `isLiveTerminalSession` (guard `session`)
 * before it types anything; nothing here can turn a dead terminal into a
 * writable one.
 */

/** How old a snapshot may get before a synchronous read kicks a refresh. */
export const LIVENESS_SNAPSHOT_TTL_MS = 3_000;

/**
 * How old a snapshot may get before it stops counting as EVIDENCE. Past this,
 * absence from the listing proves nothing and everything reads as live.
 */
export const LIVENESS_SNAPSHOT_MAX_TRUST_MS = 60_000;

/**
 * A row touched this recently is live regardless of the snapshot: it may have
 * been created after the listing was taken. Covers the birth race without
 * needing a second daemon round trip.
 */
export const LIVENESS_ACTIVITY_GRACE_MS = 60_000;

/**
 * How long after bridge start an EMPTY daemon listing is treated as "no
 * evidence" rather than "nothing is alive". Mirrors the documented port-scan
 * warm-up (`PORT_SCAN_WARMUP_DELAYS_MS`, max 90 s): a just-adopted daemon may
 * not list its sessions yet, and trusting that emptiness would hide every live
 * terminal on the machine at exactly the moment the user reopens the app.
 */
export const LIVENESS_DAEMON_WARMUP_MS = 90_000;

/**
 * How long a read handler will WAIT for a refresh before proceeding on what it
 * already has. `getDaemonClient` blocks on the daemon bootstrap by design, so
 * without this a `/v1/tree` landing during an adoption would hang behind it.
 */
export const LIVENESS_REFRESH_TIMEOUT_MS = 2_000;

export interface TerminalLiveness {
	/**
	 * Refresh the daemon snapshot if it is older than the TTL. Awaited by the
	 * async read handlers; never throws (a daemon failure degrades to "no
	 * evidence", which shows everything).
	 */
	refresh(): Promise<void>;
	/**
	 * `false` only on fresh positive evidence of death — see the module header.
	 *
	 * `lastActivityMs` is the newest instant host.db records for the row
	 * (`last_attached_at` / `created_at`). Pass it when you have it: it is what
	 * keeps a terminal created after the snapshot from reading as dead.
	 */
	isLive(hostTerminalId: string, lastActivityMs?: number | null): boolean;
	/** Diagnostics only. Never a control-flow input. */
	describe(): {
		hasSnapshot: boolean;
		aliveCount: number;
		takenAtMs: number | null;
	};
}

export interface TerminalLivenessDeps {
	/** `isLiveTerminalSession` — a live session in THIS process. */
	hasInProcessSession(hostTerminalId: string): boolean;
	/** Ids the pty-daemon currently reports as alive. */
	listDaemonAliveIds(): Promise<string[]>;
	now(): number;
	/** Bridge start instant, for the daemon warm-up window. */
	startedAtMs: number;
	log(event: Record<string, unknown>): void;
}

interface LivenessSnapshot {
	aliveIds: Set<string>;
	takenAtMs: number;
}

export function createTerminalLiveness(
	deps: TerminalLivenessDeps,
): TerminalLiveness {
	let snapshot: LivenessSnapshot | null = null;
	let inFlight: Promise<void> | null = null;
	let lastFaultLoggedAtMs = 0;

	/**
	 * Coalesced so the heartbeat, the tree and any number of opportunistic
	 * synchronous kicks share one daemon round trip. A slow `list()` right after
	 * adoption is exactly when several callers pile up.
	 */
	function run(): Promise<void> {
		if (inFlight !== null) return inFlight;
		inFlight = deps
			.listDaemonAliveIds()
			.then((ids) => {
				const takenAtMs = deps.now();
				if (
					ids.length === 0 &&
					takenAtMs - deps.startedAtMs < LIVENESS_DAEMON_WARMUP_MS
				) {
					// Warm-up: an empty listing here is indistinguishable from a daemon
					// that has not finished adopting. Keep whatever we had (which may be
					// null) rather than manufacturing evidence that hides everything.
					return;
				}
				snapshot = { aliveIds: new Set(ids), takenAtMs };
			})
			.catch((error) => {
				// The daemon is unreachable, so we know nothing. Drop the snapshot
				// rather than keep serving an old one: "no evidence" shows every
				// terminal, which is the direction that cannot hide a blocked agent.
				snapshot = null;
				const nowMs = deps.now();
				if (nowMs - lastFaultLoggedAtMs > 60_000) {
					lastFaultLoggedAtMs = nowMs;
					deps.log({
						what: "daemon liveness listing failed; every terminal reads as live until it recovers",
						error: error instanceof Error ? error.message : String(error),
					});
				}
			})
			.finally(() => {
				inFlight = null;
			});
		return inFlight;
	}

	function isFresh(snap: LivenessSnapshot, nowMs: number): boolean {
		return nowMs - snap.takenAtMs <= LIVENESS_SNAPSHOT_MAX_TRUST_MS;
	}

	return {
		async refresh() {
			const nowMs = deps.now();
			if (
				snapshot !== null &&
				nowMs - snapshot.takenAtMs < LIVENESS_SNAPSHOT_TTL_MS
			) {
				return;
			}
			// BOUNDED. `getDaemonClient` deliberately blocks on the daemon bootstrap
			// rather than reporting it unreachable, which is right for the desktop's
			// own session list and wrong for a phone request: a tree read must never
			// hang behind an adoption. The listing keeps running and updates the
			// snapshot whenever it lands; this request just stops waiting for it and
			// proceeds on what it has — which, with no snapshot, means showing
			// everything.
			//
			// The timer is CLEARED when the listing wins, and deliberately NOT
			// `unref`'d: an unref'd timer does not hold the event loop open, so with
			// a listing that never settles there would be nothing left to run and
			// the await would hang forever — which is the exact failure this bound
			// exists to prevent. Measured: it hung.
			const pending = run();
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, LIVENESS_REFRESH_TIMEOUT_MS);
				void pending.finally(() => {
					clearTimeout(timer);
					resolve();
				});
			});
		},

		isLive(hostTerminalId, lastActivityMs) {
			// 1. This process owns a live session for it. Nothing else can outrank
			//    that — it is the same fact the answer path's `session` guard proves.
			if (deps.hasInProcessSession(hostTerminalId)) return true;

			const nowMs = deps.now();
			const snap = snapshot;

			if (snap === null || !isFresh(snap, nowMs)) {
				// No usable evidence. Kick a refresh for the NEXT caller and show.
				if (inFlight === null) void run();
				return true;
			}
			if (
				nowMs - snap.takenAtMs >= LIVENESS_SNAPSHOT_TTL_MS &&
				inFlight === null
			) {
				void run();
			}
			if (snap.aliveIds.has(hostTerminalId)) return true;

			// 3. The row may simply be newer than the snapshot.
			if (
				typeof lastActivityMs === "number" &&
				nowMs - lastActivityMs <= LIVENESS_ACTIVITY_GRACE_MS
			) {
				return true;
			}
			return false;
		},

		describe() {
			return {
				hasSnapshot: snapshot !== null,
				aliveCount: snapshot?.aliveIds.size ?? 0,
				takenAtMs: snapshot?.takenAtMs ?? null,
			};
		},
	};
}
