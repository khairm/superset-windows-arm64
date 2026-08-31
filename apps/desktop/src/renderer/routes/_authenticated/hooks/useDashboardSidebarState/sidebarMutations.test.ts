import { describe, expect, it } from "bun:test";
import {
	applyAutomaticSnoozeReturn,
	applyWorkspaceExitCleanup,
	cancelWorkspaceExitCleanup,
	removeProjectFromSidebarState,
	resolveSidebarRowProjectId,
	type SidebarWorkspaceRow,
	tombstoneSidebarWorkspaceRecord,
} from "./sidebarMutations";

/**
 * Minimal in-memory stand-in for a TanStack DB collection, implementing only
 * the surface the sidebar mutations touch (`get`/`insert`/`update`/`delete`
 * plus a `.state` Map).
 */
function makeCollection<T>(getKey: (item: T) => string) {
	const state = new Map<string, T>();
	return {
		state,
		get: (key: string) => state.get(key),
		insert: (item: T) => {
			state.set(getKey(item), structuredClone(item));
		},
		update: (key: string, producer: (draft: T) => void) => {
			const existing = state.get(key);
			if (!existing) return;
			const draft = structuredClone(existing);
			producer(draft);
			state.set(key, draft);
		},
		delete: (keys: string | string[]) => {
			for (const key of Array.isArray(keys) ? keys : [keys]) {
				state.delete(key);
			}
		},
	};
}

type LocalStateRow = {
	workspaceId: string;
	createdAt: Date;
	sidebarState: {
		projectId: string;
		tabOrder: number;
		sectionId: string | null;
		isHidden: boolean;
		pinnedAt: number | null;
	};
	paneLayout: { version: number; tabs: unknown[]; activeTabId: string | null };
};

function localStateRow(
	workspaceId: string,
	projectId: string,
	overrides: Partial<LocalStateRow["sidebarState"]> = {},
): LocalStateRow {
	return {
		workspaceId,
		createdAt: new Date("2026-01-01T00:00:00.000Z"),
		sidebarState: {
			projectId,
			tabOrder: 1,
			sectionId: null,
			isHidden: false,
			pinnedAt: null,
			...overrides,
		},
		paneLayout: { version: 1, tabs: [], activeTabId: null },
	};
}

function makeCollections() {
	return {
		v2WorkspaceLocalState: makeCollection<LocalStateRow>(
			(row) => row.workspaceId,
		),
		v2SidebarSections: makeCollection<{
			sectionId: string;
			projectId: string;
		}>((row) => row.sectionId),
		v2SidebarProjects: makeCollection<{ projectId: string }>(
			(row) => row.projectId,
		),
	};
}

type Collections = ReturnType<typeof makeCollections>;

// The functions accept the real `AppCollections` Pick; our fakes implement the
// touched subset, so cast through the parameter type.
function asRemoveArg(collections: Collections) {
	return collections as unknown as Parameters<
		typeof removeProjectFromSidebarState
	>[0];
}
function asTombstoneArg(collections: Collections) {
	return collections as unknown as Parameters<
		typeof tombstoneSidebarWorkspaceRecord
	>[0];
}

const noopCleanup = () => {};

describe("removeProjectFromSidebarState", () => {
	it("tombstones the project's worktrees — existing rows and this device's row-less ones — and deletes sections and the project record", () => {
		const collections = makeCollections();
		// Explicitly-placed worktree (has a visible local-state row).
		collections.v2WorkspaceLocalState.insert(
			localStateRow("ws-placed", "proj-1", { sectionId: "sec-1" }),
		);
		const workspaces: SidebarWorkspaceRow[] = [
			{
				id: "ws-placed",
				projectId: "proj-1",
				hostId: "machine-1",
				type: "worktree",
			},
			// This device's worktree with no row yet — the reconciler would re-pin it.
			{
				id: "ws-rowless",
				projectId: "proj-1",
				hostId: "machine-1",
				type: "worktree",
			},
		];
		collections.v2SidebarSections.insert({
			sectionId: "sec-1",
			projectId: "proj-1",
		});
		collections.v2SidebarProjects.insert({ projectId: "proj-1" });

		const cleaned: string[] = [];
		removeProjectFromSidebarState(
			asRemoveArg(collections),
			workspaces,
			"proj-1",
			"machine-1",
			(rows) => {
				for (const row of rows) cleaned.push(String(row.workspaceId));
			},
		);

		// Existing row hidden (kept); row-less worktree gets an inserted tombstone.
		expect(
			collections.v2WorkspaceLocalState.get("ws-placed")?.sidebarState.isHidden,
		).toBe(true);
		expect(
			collections.v2WorkspaceLocalState.get("ws-rowless")?.sidebarState
				.isHidden,
		).toBe(true);
		expect(collections.v2SidebarSections.get("sec-1")).toBeUndefined();
		expect(collections.v2SidebarProjects.get("proj-1")).toBeUndefined();
		// Only the pre-existing row had live runtimes to tear down.
		expect(cleaned).toEqual(["ws-placed"]);
	});

	it("tombstones the project's mains too so a passive route mount can't resurrect the removed project (REMOVE-STICKY)", () => {
		const collections = makeCollections();
		collections.v2WorkspaceLocalState.insert(
			localStateRow("ws-main", "proj-1"),
		);
		const workspaces: SidebarWorkspaceRow[] = [
			{ id: "ws-main", projectId: "proj-1", hostId: "machine-1", type: "main" },
			{
				id: "ws-main-rowless",
				projectId: "proj-1",
				hostId: "machine-1",
				type: "main",
			},
		];
		collections.v2SidebarProjects.insert({ projectId: "proj-1" });

		removeProjectFromSidebarState(
			asRemoveArg(collections),
			workspaces,
			"proj-1",
			"machine-1",
			noopCleanup,
		);

		// Existing main row hidden; a row-less local main gets an inserted
		// tombstone. An explicit re-open (Workspaces page / project setup) pulls
		// a hidden main back to active via ensureSidebarWorkspaceRecord.
		expect(
			collections.v2WorkspaceLocalState.get("ws-main")?.sidebarState.isHidden,
		).toBe(true);
		expect(
			collections.v2WorkspaceLocalState.get("ws-main-rowless")?.sidebarState
				.isHidden,
		).toBe(true);
		expect(collections.v2SidebarProjects.get("proj-1")).toBeUndefined();
	});

	it("tombstones a main-workspace row with its pin cleared", () => {
		// Mains are tombstoned like every other row on project removal
		// ((REMOVE-STICKY) tightening); the tombstone clears pinnedAt so the
		// row can't linger as a pinned invisible orphan. The master's return
		// path is (MASTER-ALWAYS-ACTIVE): re-adding the project resurfaces it.
		const collections = makeCollections();
		collections.v2WorkspaceLocalState.insert(
			localStateRow("ws-main", "proj-1", { pinnedAt: 1753000000000 }),
		);
		const workspaces: SidebarWorkspaceRow[] = [
			{ id: "ws-main", projectId: "proj-1", hostId: "machine-1", type: "main" },
		];
		collections.v2SidebarProjects.insert({ projectId: "proj-1" });

		removeProjectFromSidebarState(
			asRemoveArg(collections),
			workspaces,
			"proj-1",
			"machine-1",
			noopCleanup,
		);

		const row = collections.v2WorkspaceLocalState.get("ws-main");
		expect(row?.sidebarState.pinnedAt).toBeNull();
		// Tombstoned: hidden until (MASTER-ALWAYS-ACTIVE) resurfaces it when
		// the project row returns to the sidebar.
		expect(row?.sidebarState.isHidden).toBe(true);
	});

	it("leaves workspaces from other projects untouched", () => {
		const collections = makeCollections();
		collections.v2WorkspaceLocalState.insert(
			localStateRow("ws-other", "proj-2"),
		);
		const workspaces: SidebarWorkspaceRow[] = [
			{
				id: "ws-other",
				projectId: "proj-2",
				hostId: "machine-1",
				type: "worktree",
			},
		];
		collections.v2SidebarProjects.insert({ projectId: "proj-1" });

		removeProjectFromSidebarState(
			asRemoveArg(collections),
			workspaces,
			"proj-1",
			"machine-1",
			noopCleanup,
		);

		expect(
			collections.v2WorkspaceLocalState.get("ws-other")?.sidebarState.isHidden,
		).toBe(false);
	});

	it("does not tombstone a same-project worktree on another host (guards the hostId filter)", () => {
		const collections = makeCollections();
		// Same project, different host, no local-state row: the local reconciler
		// can't re-pin it and it isn't rendered here, so it must not get a
		// tombstone row — only this device's row-less worktrees do.
		const workspaces: SidebarWorkspaceRow[] = [
			{
				id: "ws-remote",
				projectId: "proj-1",
				hostId: "machine-2",
				type: "worktree",
			},
		];
		collections.v2SidebarProjects.insert({ projectId: "proj-1" });

		removeProjectFromSidebarState(
			asRemoveArg(collections),
			workspaces,
			"proj-1",
			"machine-1",
			noopCleanup,
		);

		expect(collections.v2WorkspaceLocalState.get("ws-remote")).toBeUndefined();
	});
});

describe("tombstoneSidebarWorkspaceRecord", () => {
	it("inserts a hidden row when none exists and does not run pane cleanup", () => {
		const collections = makeCollections();
		const cleaned: string[] = [];

		tombstoneSidebarWorkspaceRecord(
			asTombstoneArg(collections),
			"ws-new",
			"proj-1",
			(rows) => {
				for (const row of rows) cleaned.push(String(row.workspaceId));
			},
		);

		expect(
			collections.v2WorkspaceLocalState.get("ws-new")?.sidebarState.isHidden,
		).toBe(true);
		expect(cleaned).toEqual([]);
	});

	it("hides an existing row, clears its section and pin, and runs pane cleanup", () => {
		const collections = makeCollections();
		collections.v2WorkspaceLocalState.insert(
			localStateRow("ws-1", "proj-1", {
				sectionId: "sec-1",
				pinnedAt: 1753000000000,
			}),
		);
		const cleaned: string[] = [];

		tombstoneSidebarWorkspaceRecord(
			asTombstoneArg(collections),
			"ws-1",
			"proj-1",
			(rows) => {
				for (const row of rows) cleaned.push(String(row.workspaceId));
			},
		);

		const row = collections.v2WorkspaceLocalState.get("ws-1");
		expect(row?.sidebarState.isHidden).toBe(true);
		expect(row?.sidebarState.sectionId).toBeNull();
		expect(row?.sidebarState.pinnedAt).toBeNull();
		expect(cleaned).toEqual(["ws-1"]);
	});
});

// (RECYCLE-BIN-SESSIONS) A session's projectId is legitimately null, so every
// lifecycle insert path (soft delete, snooze) has to tell "caller says
// project-less" apart from "caller said nothing". Collapsing the two (a `??`)
// is what made deleting or snoozing a session with no local-state row fail.
describe("resolveSidebarRowProjectId", () => {
	it("honours an EXPLICIT null so a session soft-deletes / snoozes", () => {
		expect(resolveSidebarRowProjectId(null, null)).toBeNull();
	});

	it("keeps an explicit null even when the host record has a project", () => {
		expect(resolveSidebarRowProjectId(null, "proj-1")).toBeNull();
	});

	it("falls back to the host record when the caller passed nothing", () => {
		expect(resolveSidebarRowProjectId(undefined, "proj-1")).toBe("proj-1");
		expect(resolveSidebarRowProjectId(undefined, null)).toBeNull();
	});

	it("prefers the caller's projectId over the host record", () => {
		expect(resolveSidebarRowProjectId("proj-2", "proj-1")).toBe("proj-2");
	});

	it("lets a project-less row snooze instead of refusing it", () => {
		// The old `!resolvedProjectId` guard in snoozeWorkspace treated null as
		// unresolvable and returned early, so a session with no local-state row
		// silently never snoozed. Null is now a resolved answer, not a failure.
		expect(resolveSidebarRowProjectId(null, null)).toBeNull();
		expect(resolveSidebarRowProjectId(undefined, null)).toBeNull();
	});

	it("lets a project-less row archive instead of refusing it", () => {
		// archiveWorkspace had the same collapsing guard, and
		// RemoveFromSidebarMount already feeds it `string | null` — so "Remove
		// from Sidebar" on a session with no local-state row silently did nothing.
		expect(resolveSidebarRowProjectId(null, null)).toBeNull();
		expect(resolveSidebarRowProjectId(null, "proj-1")).toBeNull();
	});
});

describe("applyWorkspaceExitCleanup", () => {
	// The helper only ever WRITES these, so the fixture keeps the payload fields
	// opaque — asserting on them is the test's job, not the type's.
	interface ExitCleanupFixture {
		paneLayout: unknown;
		workspaceRunTerminals: unknown;
		pendingMigratedTerminals: unknown;
		sidebarState: {
			pinnedAt: number | null;
			runtimeCleanupPendingAt: number | null;
		};
	}

	function exitedRow(): ExitCleanupFixture {
		return {
			paneLayout: {
				version: 1,
				tabs: [{ id: "tab-1", panes: {} }],
				activeTabId: "tab-1",
			},
			workspaceRunTerminals: { "run-1": { terminalId: "term-1" } },
			pendingMigratedTerminals: [
				{ terminalId: "term-2", cwd: null, v1PaneId: null },
			],
			sidebarState: { pinnedAt: 111, runtimeCleanupPendingAt: null },
		};
	}

	it("clears every piece of runtime state the row owns", () => {
		const row = exitedRow();

		applyWorkspaceExitCleanup(
			row as unknown as Parameters<typeof applyWorkspaceExitCleanup>[0],
			999,
		);

		expect(row.paneLayout).toEqual({
			version: 1,
			tabs: [],
			activeTabId: null,
		});
		expect(row.workspaceRunTerminals).toEqual({});
		expect(row.pendingMigratedTerminals).toEqual([]);
	});

	it("unpins the row, so restoring it cannot resurrect the pin", () => {
		const row = exitedRow();

		applyWorkspaceExitCleanup(
			row as unknown as Parameters<typeof applyWorkspaceExitCleanup>[0],
			999,
		);

		expect(row.sidebarState.pinnedAt).toBeNull();
	});

	it("stamps the host debt so the reconciler retries it after a restart", () => {
		// Stamped whichever machine owns the workspace: the reconciler routes to a
		// remote owner over the relay, and an owner that is switched off right now
		// is the exact case the durable stamp exists for.
		const row = exitedRow();

		applyWorkspaceExitCleanup(
			row as unknown as Parameters<typeof applyWorkspaceExitCleanup>[0],
			999,
		);

		expect(row.sidebarState.runtimeCleanupPendingAt).toBe(999);
	});
});

describe("applyAutomaticSnoozeReturn", () => {
	it("clears the Snooze timer without cancelling pending host cleanup", () => {
		const sidebarState = {
			snoozeUntil: 123 as number | null,
			snoozeLaunchId: "launch-1" as string | null,
			runtimeCleanupPendingAt: 999 as number | null,
		};

		applyAutomaticSnoozeReturn(sidebarState);

		expect(sidebarState.snoozeUntil).toBeNull();
		expect(sidebarState.snoozeLaunchId).toBeNull();
		expect(sidebarState.runtimeCleanupPendingAt).toBe(999);
	});
});

describe("cancelWorkspaceExitCleanup", () => {
	it("clears a pending host cleanup", () => {
		const sidebarState = { runtimeCleanupPendingAt: 999 as number | null };

		cancelWorkspaceExitCleanup(sidebarState);

		expect(sidebarState.runtimeCleanupPendingAt).toBeNull();
	});

	it("is a no-op for a row that owes nothing", () => {
		const sidebarState = { runtimeCleanupPendingAt: null };

		cancelWorkspaceExitCleanup(sidebarState);

		expect(sidebarState.runtimeCleanupPendingAt).toBeNull();
	});
});
