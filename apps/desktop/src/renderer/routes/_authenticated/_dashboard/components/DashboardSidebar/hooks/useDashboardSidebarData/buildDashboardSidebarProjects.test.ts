import { describe, expect, it, spyOn } from "bun:test";
import {
	APP_LAUNCH_ID,
	isWithinRecycleBinWindow,
} from "renderer/routes/_authenticated/providers/CollectionsProvider/dashboardSidebarLocal";
import {
	buildDashboardSidebarInactiveSessionWorkspaces,
	buildDashboardSidebarPinnedWorkspaces,
	buildDashboardSidebarProjects,
	buildDashboardSidebarSessionWorkspaces,
	partitionSidebarWorkspacesByPinned,
	partitionSidebarWorkspacesBySession,
	type SidebarInactiveWorkspaceInput,
	type SidebarProjectInput,
	type SidebarSectionInput,
	type SidebarWorkspaceInput,
} from "./buildDashboardSidebarProjects";

const MACHINE_ID = "machine-1";
const DATE = new Date("2026-01-01T00:00:00.000Z");

function makeProject(
	overrides: Partial<SidebarProjectInput> = {},
): SidebarProjectInput {
	return {
		id: "project-1",
		name: "Project",
		githubOwner: null,
		githubRepoName: null,
		iconUrl: null,
		color: null,
		createdAt: DATE,
		updatedAt: DATE,
		isCollapsed: false,
		isPinned: false,
		...overrides,
	};
}

function makeSection(
	overrides: Partial<SidebarSectionInput> = {},
): SidebarSectionInput {
	return {
		id: "section-1",
		projectId: "project-1",
		name: "Section",
		createdAt: DATE,
		isCollapsed: false,
		tabOrder: 1,
		color: "#abcdef",
		...overrides,
	};
}

function makeWorkspace(
	overrides: Partial<SidebarWorkspaceInput> = {},
): SidebarWorkspaceInput {
	return {
		id: "workspace-1",
		projectId: "project-1",
		hostId: MACHINE_ID,
		type: "worktree",
		hostIsOnline: true,
		name: "Workspace",
		branch: "main",
		taskId: null,
		createdAt: DATE,
		updatedAt: DATE,
		tabOrder: 1,
		sectionId: null,
		pinnedAt: null,
		pendingTransaction: null,
		...overrides,
	};
}

function build(params: {
	sidebarProjects?: SidebarProjectInput[];
	sidebarSections?: SidebarSectionInput[];
	visibleSidebarWorkspaces?: SidebarWorkspaceInput[];
}) {
	return buildDashboardSidebarProjects({
		sidebarProjects: params.sidebarProjects ?? [makeProject()],
		sidebarSections: params.sidebarSections ?? [],
		visibleSidebarWorkspaces: params.visibleSidebarWorkspaces ?? [],
		machineId: MACHINE_ID,
		pullRequestsByWorkspaceId: new Map(),
	});
}

describe("buildDashboardSidebarProjects", () => {
	it("places a workspace inside the section it belongs to", () => {
		const [project] = build({
			sidebarSections: [makeSection({ id: "section-1", tabOrder: 1 })],
			visibleSidebarWorkspaces: [
				makeWorkspace({ id: "workspace-1", sectionId: "section-1" }),
			],
		});

		expect(project.children).toHaveLength(1);
		const [child] = project.children;
		expect(child.type).toBe("section");
		if (child.type !== "section") throw new Error("expected section");
		expect(child.section.workspaces.map((workspace) => workspace.id)).toEqual([
			"workspace-1",
		]);
	});

	it("renders an orphaned-section workspace at top level instead of dropping it", () => {
		const [project] = build({
			sidebarSections: [makeSection({ id: "section-1", tabOrder: 1 })],
			visibleSidebarWorkspaces: [
				makeWorkspace({
					id: "orphan",
					sectionId: "section-deleted",
					tabOrder: 1,
				}),
			],
		});

		const topLevelWorkspaceIds = project.children
			.filter((child) => child.type === "workspace")
			.map((child) => (child.type === "workspace" ? child.workspace.id : null));
		expect(topLevelWorkspaceIds).toContain("orphan");

		const allRenderedIds = project.children.flatMap((child) =>
			child.type === "section"
				? child.section.workspaces.map((workspace) => workspace.id)
				: [child.workspace.id],
		);
		expect(allRenderedIds).toContain("orphan");
	});

	it("orders sections by tabOrder and places each workspace in its section", () => {
		const sections = [
			makeSection({ id: "section-a", name: "A", tabOrder: 2 }),
			makeSection({ id: "section-b", name: "B", tabOrder: 1 }),
		];
		const [project] = build({
			sidebarSections: sections,
			visibleSidebarWorkspaces: [
				makeWorkspace({ id: "ws-in-b", sectionId: "section-b", tabOrder: 1 }),
			],
		});

		const sectionB = project.children.find(
			(child) => child.type === "section" && child.section.id === "section-b",
		);
		expect(sectionB?.type).toBe("section");
		if (sectionB?.type !== "section") throw new Error("expected section-b");
		expect(
			sectionB.section.workspaces.map((workspace) => workspace.id),
		).toEqual(["ws-in-b"]);
		expect(
			project.children
				.filter((child) => child.type === "section")
				.map((child) => (child.type === "section" ? child.section.id : null)),
		).toEqual(["section-b", "section-a"]);
	});

	it("orders multiple orphaned workspaces by tabOrder above the sections", () => {
		const [project] = build({
			sidebarSections: [makeSection({ id: "section-1", tabOrder: 5 })],
			visibleSidebarWorkspaces: [
				makeWorkspace({ id: "orphan-late", sectionId: "gone", tabOrder: 3 }),
				makeWorkspace({ id: "orphan-early", sectionId: "gone", tabOrder: 1 }),
			],
		});

		const renderedTopLevel = project.children.map((child) =>
			child.type === "section"
				? `section:${child.section.id}`
				: child.workspace.id,
		);
		expect(renderedTopLevel).toEqual([
			"orphan-early",
			"orphan-late",
			"section:section-1",
		]);
	});
});

describe("partitionSidebarWorkspacesByPinned", () => {
	it("splits pinned rows out and sorts them by pin time ascending", () => {
		const { pinned, unpinned } = partitionSidebarWorkspacesByPinned([
			makeWorkspace({ id: "unpinned-1" }),
			makeWorkspace({ id: "pinned-late", pinnedAt: 2000 }),
			makeWorkspace({ id: "unpinned-2" }),
			makeWorkspace({ id: "pinned-early", pinnedAt: 1000 }),
		]);

		expect(pinned.map((workspace) => workspace.id)).toEqual([
			"pinned-early",
			"pinned-late",
		]);
		expect(unpinned.map((workspace) => workspace.id)).toEqual([
			"unpinned-1",
			"unpinned-2",
		]);
	});
});

describe("buildDashboardSidebarPinnedWorkspaces", () => {
	it("decorates pinned rows with project identity and drops project-less rows", () => {
		const rows = buildDashboardSidebarPinnedWorkspaces({
			pinnedSidebarWorkspaces: [
				makeWorkspace({ id: "pinned-1", pinnedAt: 1000 }),
				makeWorkspace({
					id: "pinned-orphan",
					projectId: "removed-project",
					pinnedAt: 2000,
				}),
			],
			sidebarProjects: [
				makeProject({ id: "project-1", name: "Superset", iconUrl: "icon.png" }),
			],
			machineId: MACHINE_ID,
			pullRequestsByWorkspaceId: new Map(),
		});

		expect(rows.map((row) => row.id)).toEqual(["pinned-1"]);
		expect(rows[0].projectName).toBe("Superset");
		expect(rows[0].projectIconUrl).toBe("icon.png");
		expect(rows[0].isPinned).toBe(true);
	});
});

describe("sessions (null projectId)", () => {
	it("never places a session row inside a project group", () => {
		const [project] = build({
			visibleSidebarWorkspaces: [
				makeWorkspace({ id: "session-1", projectId: null, type: "session" }),
				makeWorkspace({ id: "workspace-1" }),
			],
		});

		const childIds = project.children.flatMap((child) =>
			child.type === "workspace" ? [child.workspace.id] : [],
		);
		expect(childIds).toEqual(["workspace-1"]);
	});

	it("orders the Sessions section by tabOrder with no repo affordances", () => {
		const rows = buildDashboardSidebarSessionWorkspaces({
			sessionSidebarWorkspaces: [
				makeWorkspace({
					id: "session-b",
					projectId: null,
					type: "session",
					tabOrder: 2,
				}),
				makeWorkspace({
					id: "session-a",
					projectId: null,
					type: "session",
					tabOrder: 1,
				}),
			],
			machineId: MACHINE_ID,
			pullRequestsByWorkspaceId: new Map(),
		});

		expect(rows.map((row) => row.id)).toEqual(["session-a", "session-b"]);
		expect(rows[0].projectId).toBeNull();
		expect(rows[0].repoUrl).toBeNull();
		expect(rows[0].branchExistsOnRemote).toBe(false);
	});

	it("keeps a pinned session in the Pinned section with null project identity", () => {
		const rows = buildDashboardSidebarPinnedWorkspaces({
			pinnedSidebarWorkspaces: [
				makeWorkspace({
					id: "pinned-session",
					projectId: null,
					type: "session",
					pinnedAt: 1000,
				}),
			],
			sidebarProjects: [makeProject()],
			machineId: MACHINE_ID,
			pullRequestsByWorkspaceId: new Map(),
		});

		expect(rows.map((row) => row.id)).toEqual(["pinned-session"]);
		expect(rows[0].projectName).toBeNull();
		expect(rows[0].projectIconUrl).toBeNull();
	});
});

// (SESSION-LIFECYCLE) A snoozed / archived session has no project row to hang
// off, so it renders in its own top-level subsection. These assert the bucket
// rows carry the same ordering and badge semantics as the project-scoped ones.
describe("session lifecycle subsections (SESSION-LIFECYCLE)", () => {
	const NOW = 1_000_000_000;

	function makeInactiveSession(
		overrides: Partial<SidebarInactiveWorkspaceInput> = {},
	): SidebarInactiveWorkspaceInput {
		return {
			...makeWorkspace({ projectId: null, type: "session" }),
			snoozeUntil: null,
			snoozeLaunchId: null,
			archivedAt: null,
			deletedAt: null,
			...overrides,
		};
	}

	it("splits session rows from project-scoped rows", () => {
		const { sessions, projectScoped } = partitionSidebarWorkspacesBySession([
			makeWorkspace({ id: "session-1", projectId: null, type: "session" }),
			makeWorkspace({ id: "workspace-1" }),
			makeWorkspace({ id: "session-2", projectId: null, type: "session" }),
		]);

		expect(sessions.map((row) => row.id)).toEqual(["session-1", "session-2"]);
		expect(projectScoped.map((row) => row.id)).toEqual(["workspace-1"]);
	});

	it("orders snoozed sessions by soonest wake, with next-launch snoozes last", () => {
		const rows = buildDashboardSidebarInactiveSessionWorkspaces({
			sessionSidebarWorkspaces: [
				makeInactiveSession({
					id: "launch",
					snoozeLaunchId: APP_LAUNCH_ID,
				}),
				makeInactiveSession({ id: "later", snoozeUntil: NOW + 90_000_000 }),
				makeInactiveSession({ id: "sooner", snoozeUntil: NOW + 60_000 }),
			],
			variant: "snoozed",
			machineId: MACHINE_ID,
			nowMs: NOW,
		});

		expect(rows.map((row) => row.id)).toEqual(["sooner", "later", "launch"]);
	});

	it("labels remaining snooze time from the passed tick", () => {
		const [soon, launch] = buildDashboardSidebarInactiveSessionWorkspaces({
			sessionSidebarWorkspaces: [
				makeInactiveSession({ id: "soon", snoozeUntil: NOW + 3 * 3_600_000 }),
				makeInactiveSession({ id: "launch", snoozeLaunchId: APP_LAUNCH_ID }),
			],
			variant: "snoozed",
			machineId: MACHINE_ID,
			nowMs: NOW,
		});

		expect(soon.snoozeRemainingLabel).toBe("3h");
		expect(launch.snoozeRemainingLabel).toBe("launch");
	});

	it("orders archived sessions most-recently-archived first", () => {
		const rows = buildDashboardSidebarInactiveSessionWorkspaces({
			sessionSidebarWorkspaces: [
				makeInactiveSession({ id: "old", archivedAt: NOW - 5_000 }),
				makeInactiveSession({ id: "newest", archivedAt: NOW }),
				makeInactiveSession({ id: "middle", archivedAt: NOW - 1_000 }),
			],
			variant: "archived",
			machineId: MACHINE_ID,
			nowMs: NOW,
		});

		expect(rows.map((row) => row.id)).toEqual(["newest", "middle", "old"]);
	});

	it("strips repo affordances, PRs and pin state from an inactive session row", () => {
		const [row] = buildDashboardSidebarInactiveSessionWorkspaces({
			// A pinned session that gets archived leaves the Pinned section, so the
			// row it produces must never claim to be pinned.
			sessionSidebarWorkspaces: [
				makeInactiveSession({ archivedAt: NOW, pinnedAt: 1000 }),
			],
			variant: "archived",
			machineId: MACHINE_ID,
			nowMs: NOW,
		});

		expect(row.projectId).toBeNull();
		expect(row.repoUrl).toBeNull();
		expect(row.branchExistsOnRemote).toBe(false);
		expect(row.pullRequest).toBeNull();
		expect(row.isPinned).toBe(false);
		expect(row.archivedAt).toBe(NOW);
	});

	it("refuses a project-scoped row loudly instead of duplicating it under Sessions", () => {
		const errorSpy = spyOn(console, "error").mockImplementation(() => {});
		try {
			const rows = buildDashboardSidebarInactiveSessionWorkspaces({
				sessionSidebarWorkspaces: [
					makeInactiveSession({ id: "session-1", archivedAt: NOW }),
					makeInactiveSession({
						id: "branch-1",
						projectId: "project-1",
						type: "worktree",
						archivedAt: NOW,
					}),
				],
				variant: "archived",
				machineId: MACHINE_ID,
				nowMs: NOW,
			});

			expect(rows.map((row) => row.id)).toEqual(["session-1"]);
			expect(errorSpy).toHaveBeenCalledTimes(1);
		} finally {
			errorSpy.mockRestore();
		}
	});

	// (RECYCLE-BIN-SESSIONS) A soft-deleted session has no project bin to land
	// in. Before the deleted bucket was partitioned by session-ness these rows
	// were dropped entirely — the project-tree loop skipped them and nothing
	// else rendered them, so the X on a session was an unrecoverable vanish.
	describe("session Recycle Bin (RECYCLE-BIN-SESSIONS)", () => {
		it("splits soft-deleted session rows from project-scoped deleted rows", () => {
			const { sessions, projectScoped } = partitionSidebarWorkspacesBySession([
				makeInactiveSession({ id: "deleted-session", deletedAt: NOW }),
				makeWorkspace({ id: "deleted-branch" }),
			]);

			expect(sessions.map((row) => row.id)).toEqual(["deleted-session"]);
			expect(projectScoped.map((row) => row.id)).toEqual(["deleted-branch"]);
		});

		it("orders the bin most-recently-deleted first and carries deletedAt", () => {
			const rows = buildDashboardSidebarInactiveSessionWorkspaces({
				sessionSidebarWorkspaces: [
					makeInactiveSession({ id: "old", deletedAt: NOW - 5_000 }),
					makeInactiveSession({ id: "newest", deletedAt: NOW }),
					makeInactiveSession({ id: "middle", deletedAt: NOW - 1_000 }),
				],
				variant: "deleted",
				machineId: MACHINE_ID,
				nowMs: NOW,
			});

			expect(rows.map((row) => row.id)).toEqual(["newest", "middle", "old"]);
			expect(rows[0].deletedAt).toBe(NOW);
			expect(rows[0].isPinned).toBe(false);
			expect(rows[0].projectId).toBeNull();
		});

		it("keeps rows older than the retention window in the bin, outside the display filter", () => {
			const retentionDays = 30;
			const dayMs = 24 * 3_600_000;
			const rows = buildDashboardSidebarInactiveSessionWorkspaces({
				sessionSidebarWorkspaces: [
					makeInactiveSession({ id: "recent", deletedAt: NOW - dayMs }),
					makeInactiveSession({ id: "ancient", deletedAt: NOW - 31 * dayMs }),
				],
				variant: "deleted",
				machineId: MACHINE_ID,
				nowMs: NOW,
			});

			// Nothing is ever dropped — retention is a DISPLAY filter the section
			// applies over the full bin (and drives its "N hidden by filter" footer).
			expect(rows.map((row) => row.id)).toEqual(["recent", "ancient"]);
			expect(
				rows
					.filter((row) =>
						isWithinRecycleBinWindow(row.deletedAt, retentionDays, NOW),
					)
					.map((row) => row.id),
			).toEqual(["recent"]);
		});
	});
});
