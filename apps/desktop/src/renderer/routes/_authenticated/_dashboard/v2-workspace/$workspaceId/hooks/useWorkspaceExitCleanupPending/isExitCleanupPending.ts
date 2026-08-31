/**
 * (WORKTREE-EXIT-CLEANUP) Whether this workspace still owes its host an exit
 * teardown, decided from the live query's rows and its hydration state.
 *
 * Pure, and in its own module, so it can be tested without dragging the
 * collections provider (and through it the electron-tRPC client) into a unit
 * harness.
 *
 * Not-yet-ready counts as PENDING. An unhydrated live query answers with zero
 * rows, which is indistinguishable from "this workspace owes nothing", and the
 * consumer racing it — background-session adoption — gets one shot at the same
 * mount. Defaulting the other way would rebuild panes for the terminals the
 * user just closed; defaulting this way costs a tick, after which the gate
 * lifts on its own if there is no debt.
 */
export function isExitCleanupPending(
	isQueryReady: boolean,
	rows: readonly { runtimeCleanupPendingAt: number | null }[],
): boolean {
	if (!isQueryReady) return true;
	return rows[0]?.runtimeCleanupPendingAt != null;
}
