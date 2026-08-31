import { describe, expect, it } from "bun:test";
import { isExitCleanupPending } from "./isExitCleanupPending";

describe("(WORKTREE-EXIT-CLEANUP) isExitCleanupPending", () => {
	it("treats an unhydrated query as pending, whatever it answered with", () => {
		// The regression this exists for: an unhydrated live query answers with
		// zero rows, which reads identically to "nothing owed". Adoption gets one
		// shot at the same mount, so guessing wrong here is unrecoverable — it
		// rebuilds panes for the terminals the user just closed.
		expect(isExitCleanupPending(false, [])).toBe(true);
		expect(
			isExitCleanupPending(false, [{ runtimeCleanupPendingAt: null }]),
		).toBe(true);
	});

	it("is pending once hydrated with a stamp", () => {
		expect(
			isExitCleanupPending(true, [{ runtimeCleanupPendingAt: 1_700_000_000 }]),
		).toBe(true);
	});

	it("lifts once hydrated with no stamp", () => {
		expect(
			isExitCleanupPending(true, [{ runtimeCleanupPendingAt: null }]),
		).toBe(false);
	});

	it("lifts for a workspace with no local-state row at all", () => {
		// A workspace that was never exited has no row. Hydrated and empty is the
		// one empty result that genuinely means "nothing owed".
		expect(isExitCleanupPending(true, [])).toBe(false);
	});
});
