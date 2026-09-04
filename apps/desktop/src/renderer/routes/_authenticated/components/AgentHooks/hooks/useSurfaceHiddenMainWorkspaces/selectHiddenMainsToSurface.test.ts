import { describe, expect, it } from "bun:test";
import {
	APP_LAUNCH_ID,
	getWorkspaceSidebarBucket,
	type SidebarWorkspaceBucket,
} from "renderer/routes/_authenticated/providers/CollectionsProvider/dashboardSidebarLocal";
import {
	type HiddenMainSidebarRow,
	type HiddenMainSidebarState,
	type LocalWorkspaceForPlacement,
	selectHiddenMainsToSurface,
} from "./selectHiddenMainsToSurface";

const MACHINE = "machine-1";
const NOW = 1_000_000;

const MAIN: LocalWorkspaceForPlacement = {
	id: "main-1",
	projectId: "p1",
	type: "main",
	hostId: MACHINE,
};

/** The legacy stranded shape: hidden, never archived. */
const HIDDEN: HiddenMainSidebarState = { isHidden: true };

/** Local-state rows the way the hook's live query hands them over: flat. */
function rows(
	...entries: Array<[string, HiddenMainSidebarState]>
): HiddenMainSidebarRow[] {
	return entries.map(([workspaceId, state]) => ({ workspaceId, ...state }));
}

function surface(
	workspaces: readonly LocalWorkspaceForPlacement[],
	localStateRows: readonly HiddenMainSidebarRow[],
	sidebarProjectRows: readonly { projectId: string }[] = [{ projectId: "p1" }],
	machineId: string | null = MACHINE,
): Array<{ id: string; projectId: string }> {
	return selectHiddenMainsToSurface(
		workspaces,
		localStateRows,
		sidebarProjectRows,
		machineId,
		NOW,
	);
}

describe("selectHiddenMainsToSurface", () => {
	it("surfaces a hidden main whose project is in the sidebar", () => {
		expect(surface([MAIN], rows(["main-1", HIDDEN]))).toEqual([
			{ id: "main-1", projectId: "p1" },
		]);
	});

	it("skips a row-LESS main — isAutoIncludedLocalMainWorkspace owns those", () => {
		// Inserting a row for one of these would take it out of the gated
		// auto-include path it is already visible through.
		expect(surface([MAIN], rows())).toEqual([]);
	});

	it("skips a main that is not on this machine", () => {
		expect(
			surface([{ ...MAIN, hostId: "other-machine" }], rows(["main-1", HIDDEN])),
		).toEqual([]);
	});

	it("skips a main with no project", () => {
		expect(
			surface([{ ...MAIN, projectId: null }], rows(["main-1", HIDDEN])),
		).toEqual([]);
	});

	it("skips a main whose project is not in the sidebar", () => {
		// This is what keeps "Remove project from sidebar" sticky: the project's
		// v2SidebarProjects row is gone, so the predicate is false.
		expect(surface([MAIN], rows(["main-1", HIDDEN]), [])).toEqual([]);
	});

	it("returns nothing when the machine id is unknown", () => {
		expect(
			surface([MAIN], rows(["main-1", HIDDEN]), [{ projectId: "p1" }], null),
		).toEqual([]);
	});

	it("never surfaces worktrees or sessions", () => {
		expect(
			surface(
				[
					{ ...MAIN, id: "wt-1", type: "worktree" },
					{ ...MAIN, id: "sess-1", type: "session", projectId: null },
				],
				rows(["wt-1", HIDDEN], ["sess-1", HIDDEN]),
			),
		).toEqual([]);
	});

	it("surfaces only the hidden mains out of a mixed set", () => {
		expect(
			surface(
				[
					MAIN,
					{ ...MAIN, id: "main-2" },
					{ ...MAIN, id: "main-3" },
					{ ...MAIN, id: "wt-1", type: "worktree" },
				],
				rows(
					["main-1", HIDDEN],
					["main-2", { isHidden: false }],
					["main-3", HIDDEN],
					["wt-1", HIDDEN],
				),
			),
		).toEqual([
			{ id: "main-1", projectId: "p1" },
			{ id: "main-3", projectId: "p1" },
		]);
	});

	it("carries the workspace's project id, not the row's", () => {
		// ensureWorkspaceInSidebar repairs the row's projectId from this value, so
		// a row that lost or never had one is healed rather than trusted.
		expect(
			surface(
				[{ ...MAIN, projectId: "p2" }],
				rows(["main-1", HIDDEN]),
				[{ projectId: "p2" }],
			),
		).toEqual([{ id: "main-1", projectId: "p2" }]);
	});

	it("is idempotent: a surfaced (now active) main is not selected again", () => {
		// ensureWorkspaceInSidebar clears isHidden, so the next pass sees "active".
		expect(surface([MAIN], rows(["main-1", { isHidden: false }]))).toEqual([]);
	});
});

// Everything the reconciler must NOT touch is excluded by the bucket
// classifier, never by a local isHidden/archivedAt read. Each case asserts the
// bucket as well as the selection: anyone inserting a new bucket AHEAD of
// "hidden" in getWorkspaceSidebarBucket's precedence chain breaks these first.
describe("selectHiddenMainsToSurface — only the 'hidden' bucket is repaired", () => {
	const cases: Array<{
		name: string;
		state: HiddenMainSidebarState;
		bucket: SidebarWorkspaceBucket;
	}> = [
		{
			name: "an archived main (archivedAt stamped by a master-card remove)",
			state: { isHidden: true, archivedAt: NOW - 1 },
			bucket: "archived",
		},
		{
			name: "a main snoozed on a timer",
			state: { isHidden: true, snoozeUntil: NOW + 60_000 },
			bucket: "snoozed",
		},
		{
			name: "a main snoozed until next launch",
			state: { isHidden: true, snoozeLaunchId: APP_LAUNCH_ID },
			bucket: "snoozed",
		},
		{
			name: "a binned main (RECYCLE-BIN soft delete)",
			state: { isHidden: true, deletedAt: NOW - 1 },
			bucket: "deleted",
		},
		{
			name: "a completed main (kanban Completed column)",
			state: { isHidden: true, completedAt: NOW - 1 },
			bucket: "completed",
		},
		{
			name: "an already-active main",
			state: { isHidden: false },
			bucket: "active",
		},
	];

	for (const { name, state, bucket } of cases) {
		it(`leaves ${name} alone`, () => {
			expect(
				getWorkspaceSidebarBucket({ sidebarState: state }, NOW, "main"),
			).toBe(bucket);
			expect(surface([MAIN], rows(["main-1", state]))).toEqual([]);
		});
	}

	it("repairs the 'hidden' bucket, and only it", () => {
		expect(
			getWorkspaceSidebarBucket({ sidebarState: HIDDEN }, NOW, "main"),
		).toBe("hidden");
		expect(surface([MAIN], rows(["main-1", HIDDEN]))).toEqual([
			{ id: "main-1", projectId: "p1" },
		]);
	});

	it("treats an EXPIRED timer snooze on a hidden main as hidden again", () => {
		const expired: HiddenMainSidebarState = {
			isHidden: true,
			snoozeUntil: NOW - 1,
		};
		expect(
			getWorkspaceSidebarBucket({ sidebarState: expired }, NOW, "main"),
		).toBe("hidden");
		expect(surface([MAIN], rows(["main-1", expired]))).toEqual([
			{ id: "main-1", projectId: "p1" },
		]);
	});

	it("ignores a launch-id snooze from a PREVIOUS app launch", () => {
		const stale: HiddenMainSidebarState = {
			isHidden: true,
			snoozeLaunchId: "some-older-launch",
		};
		expect(
			getWorkspaceSidebarBucket({ sidebarState: stale }, NOW, "main"),
		).toBe("hidden");
		expect(surface([MAIN], rows(["main-1", stale]))).toEqual([
			{ id: "main-1", projectId: "p1" },
		]);
	});
});

describe("selectHiddenMainsToSurface — remove-project interaction", () => {
	// removeProjectFromSidebarState tombstones EVERY row of the project first and
	// deletes the v2SidebarProjects row last. This is the shape after the
	// tombstone loop but before the project row goes: mains, worktrees and
	// sessions all hidden, project row still present. It is also exactly what a
	// later RE-ADD of the project recreates.
	const tombstoned = rows(
		["main-1", HIDDEN],
		["wt-1", HIDDEN],
		["sess-1", HIDDEN],
	);
	const workspaces: LocalWorkspaceForPlacement[] = [
		MAIN,
		{ ...MAIN, id: "wt-1", type: "worktree" },
		{ ...MAIN, id: "sess-1", type: "session" },
	];

	it("keeps the whole project removed while its sidebar row is gone", () => {
		expect(surface(workspaces, tombstoned, [])).toEqual([]);
	});

	it("resurrects ONLY the master once the project is back in the sidebar", () => {
		// (MASTER-ALWAYS-ACTIVE) deliberately overrides (REMOVE-STICKY) for mains.
		// The tombstoned worktree and session stay removed.
		expect(surface(workspaces, tombstoned)).toEqual([
			{ id: "main-1", projectId: "p1" },
		]);
	});
});

describe("selectHiddenMainsToSurface — unvalidated rows", () => {
	// withReadHeal does not validate READS, so a persisted row can come back with
	// fields missing or of the wrong type. The classifier tolerates that; so must
	// the selector — a throw here would break the always-mounted reconciler and
	// take the sidebar down with it.
	it("does not throw on a row with no state fields at all", () => {
		expect(() => surface([MAIN], rows(["main-1", {}]))).not.toThrow();
		// An empty row is "active", not "hidden" — nothing to repair.
		expect(surface([MAIN], rows(["main-1", {}]))).toEqual([]);
	});

	it("does not throw on null-valued state fields", () => {
		const nulled: HiddenMainSidebarState = {
			isHidden: null,
			archivedAt: null,
			snoozeUntil: null,
			snoozeLaunchId: null,
			completedAt: null,
			deletedAt: null,
		};
		expect(surface([MAIN], rows(["main-1", nulled]))).toEqual([]);
	});

	it("does not throw on wrongly-typed state fields", () => {
		const garbage = {
			isHidden: true,
			snoozeUntil: "not-a-number",
			snoozeLaunchId: 42,
		} as unknown as HiddenMainSidebarState;
		expect(() => surface([MAIN], rows(["main-1", garbage]))).not.toThrow();
		// A non-numeric snoozeUntil is not a live snooze, so the row is still the
		// stranded hidden main it looks like.
		expect(surface([MAIN], rows(["main-1", garbage]))).toEqual([
			{ id: "main-1", projectId: "p1" },
		]);
	});
});
