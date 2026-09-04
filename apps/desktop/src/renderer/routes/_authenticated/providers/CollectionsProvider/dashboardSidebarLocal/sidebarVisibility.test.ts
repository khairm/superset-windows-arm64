import { describe, expect, it } from "bun:test";
import {
	getVisibleSidebarWorkspaces,
	getWorkspaceSidebarBucket,
	isAutoIncludedLocalMainWorkspace,
	isWithinRecycleBinWindow,
	isWorkspaceArchived,
} from "./sidebarVisibility";

const gate = {
	localStateWorkspaceIds: new Set<string>(),
	sidebarProjectIds: new Set(["p1"]),
	machineId: "machine-local",
};

describe("isAutoIncludedLocalMainWorkspace", () => {
	it("auto-includes this device's row-less main under a sidebar project", () => {
		expect(
			isAutoIncludedLocalMainWorkspace(
				{ id: "main-local", hostId: "machine-local", projectId: "p1" },
				gate,
			),
		).toBe(true);
	});

	it("does not auto-include a remote host's main — remote surfacing is worktrees and sessions only (#7100)", () => {
		// Every online host has a main for every project it cloned; auto-including
		// those would put a second "main" row under each project per host. Remote
		// mains stay opt-in via an explicit placement row (Workspaces → Pin).
		expect(
			isAutoIncludedLocalMainWorkspace(
				{ id: "main-remote", hostId: "machine-remote", projectId: "p1" },
				gate,
			),
		).toBe(false);
	});

	it("does not auto-include a main whose project is not in the sidebar", () => {
		expect(
			isAutoIncludedLocalMainWorkspace(
				{ id: "main-local", hostId: "machine-local", projectId: "p2" },
				gate,
			),
		).toBe(false);
	});

	it("defers to the explicit row once one exists (hidden tombstone or pin)", () => {
		expect(
			isAutoIncludedLocalMainWorkspace(
				{ id: "main-local", hostId: "machine-local", projectId: "p1" },
				{ ...gate, localStateWorkspaceIds: new Set(["main-local"]) },
			),
		).toBe(false);
	});

	it("never auto-includes a project-less workspace", () => {
		expect(
			isAutoIncludedLocalMainWorkspace(
				{ id: "sess", hostId: "machine-local", projectId: null },
				gate,
			),
		).toBe(false);
	});
});

describe("getVisibleSidebarWorkspaces", () => {
	it("drops hidden rows regardless of which host owns the workspace", () => {
		const rows = [
			{ id: "local-visible", hostId: "machine-local", isHidden: false },
			{ id: "local-hidden", hostId: "machine-local", isHidden: true },
			{ id: "remote-visible", hostId: "machine-remote", isHidden: false },
			{ id: "remote-hidden", hostId: "machine-remote", isHidden: true },
		];

		expect(getVisibleSidebarWorkspaces(rows).map((row) => row.id)).toEqual([
			"local-visible",
			"remote-visible",
		]);
	});
});

// (MASTER-ARCHIVE-ONLY) The bucket classifier is what makes a removed master
// card recoverable: archiveWorkspace stamps archivedAt on the main, and the
// main must then bucket as "archived" (shown under the project's Archived
// section, unarchive-able) rather than vanishing into "hidden". These pure-
// function assertions lock that contract so a future change can't silently
// regress a master card back to hard-hidden.
describe("getWorkspaceSidebarBucket — master cards archive, never hard-hide", () => {
	const NOW = 1_000_000;

	it("buckets a master card with archivedAt as 'archived' (recoverable)", () => {
		expect(
			getWorkspaceSidebarBucket(
				{ isHidden: true, archivedAt: NOW },
				NOW,
				"main",
			),
		).toBe("archived");
		expect(
			isWorkspaceArchived({ isHidden: true, archivedAt: NOW }, "main"),
		).toBe(true);
	});

	it("keeps a master card hidden WITHOUT archivedAt out of 'archived'", () => {
		// Legacy/pre-fix hidden mains + the whole-project removal path set isHidden
		// with no timestamp — they must stay "hidden" (resurrect on reopen), never
		// surface as archived.
		expect(getWorkspaceSidebarBucket({ isHidden: true }, NOW, "main")).toBe(
			"hidden",
		);
		expect(isWorkspaceArchived({ isHidden: true }, "main")).toBe(false);
	});

	it("still archives a removed non-main thread (isHidden, no timestamp)", () => {
		expect(getWorkspaceSidebarBucket({ isHidden: true }, NOW, "branch")).toBe(
			"archived",
		);
	});

	it("completed precedence still wins over archived", () => {
		expect(
			getWorkspaceSidebarBucket(
				{ isHidden: true, archivedAt: NOW, completedAt: NOW },
				NOW,
				"branch",
			),
		).toBe("completed");
	});
});

// (RECYCLE-BIN-SESSIONS) A session row is classified exactly like a project
// thread — the bucket reader never looks at projectId — and the retention
// window is a pure display filter over whatever the bin holds.
describe("soft-deleted rows and the retention display window", () => {
	const NOW = 1_000_000_000;
	const DAY_MS = 24 * 3_600_000;

	it("buckets a soft-deleted session as 'deleted', ahead of every other lane", () => {
		expect(
			getWorkspaceSidebarBucket(
				{
					isHidden: true,
					deletedAt: NOW,
					archivedAt: NOW,
					completedAt: NOW,
					snoozeUntil: NOW + DAY_MS,
				},
				NOW,
				"session",
			),
		).toBe("deleted");
	});

	it("shows items deleted within the last 30 days and hides older ones", () => {
		expect(isWithinRecycleBinWindow(NOW - DAY_MS, 30, NOW)).toBe(true);
		expect(isWithinRecycleBinWindow(NOW - 30 * DAY_MS, 30, NOW)).toBe(true);
		expect(isWithinRecycleBinWindow(NOW - 31 * DAY_MS, 30, NOW)).toBe(false);
	});

	it("always shows a row with no deletedAt rather than filtering it away", () => {
		expect(isWithinRecycleBinWindow(null, 30, NOW)).toBe(true);
	});
});
