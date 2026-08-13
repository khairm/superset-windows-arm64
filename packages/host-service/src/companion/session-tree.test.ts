/**
 * (SESSIONS-PROJECT) `/v1/tree` and the badge counts over a fixture containing
 * a session workspace — the rows that used to fall out of both because they
 * have no `project_id` to be grouped under.
 */

import { describe, expect, it } from "bun:test";
import type { PendingQuestion } from "./question-store";
import {
	type HostBindingRow,
	type HostDbReader,
	type HostProjectRow,
	type HostTerminalRow,
	type HostWorkspaceRow,
	handleTree,
	type ReadDeps,
} from "./read-api";
import { SESSIONS_PROJECT_NAME } from "./session-project";
import type {
	SidebarMirrorSnapshot,
	SidebarProjectMirrorRow,
	SidebarWorkspaceMirrorRow,
} from "./sidebar-filter";
import type { SealedRequestContext, TreeResponse } from "./types";

const NOW = Date.now();
const ORG = "org-this-machine";
const LAUNCH = "launch-1";

function mirrorWorkspace(
	workspaceId: string,
	overrides: Partial<SidebarWorkspaceMirrorRow> = {},
): SidebarWorkspaceMirrorRow {
	return {
		workspaceId,
		projectId: "p-git",
		isHidden: false,
		archivedAt: null,
		snoozeUntil: null,
		snoozeLaunchId: null,
		completedAt: null,
		deletedAt: null,
		pinnedAt: null,
		tabOrder: 0,
		...overrides,
	};
}

function mirrorProject(projectId: string): SidebarProjectMirrorRow {
	return { projectId, tabOrder: 0, isPinned: false, isCollapsed: false };
}

function snapshot(
	workspaces: SidebarWorkspaceMirrorRow[],
	projects: SidebarProjectMirrorRow[],
): SidebarMirrorSnapshot {
	return {
		meta: {
			lastFullSyncAtMs: NOW - 1_000,
			appLaunchId: LAUNCH,
			organizationId: ORG,
			workspaceCount: workspaces.length,
			projectCount: projects.length,
		},
		workspaces,
		projects,
	};
}

interface TreeFixture {
	projects: HostProjectRow[];
	workspaces: HostWorkspaceRow[];
	terminals: HostTerminalRow[];
	bindings: HostBindingRow[];
	mirror: SidebarMirrorSnapshot;
	pendingByHostTerminal?: Record<string, PendingQuestion>;
}

function treeDeps(fixture: TreeFixture): ReadDeps {
	const db: HostDbReader = {
		listProjects: () => fixture.projects,
		listWorkspaces: () => fixture.workspaces,
		listActiveTerminals: () => fixture.terminals,
		listBindings: () => fixture.bindings,
		findWorkspace: (id) => fixture.workspaces.find((w) => w.id === id) ?? null,
		findBinding: (id) =>
			fixture.bindings.find((b) => b.terminalId === id) ?? null,
		findTerminal: (id) => fixture.terminals.find((t) => t.id === id) ?? null,
		readSidebarMirror: () => fixture.mirror,
		resolveTerminal: () => null,
		resolveActiveTerminal: () => null,
		resolveTranscriptPath: () => null,
		resolveTerminalActivityMs: () => NOW,
		close: () => {},
	};
	const pending = fixture.pendingByHostTerminal ?? {};
	return {
		db,
		log: () => {},
		questions: {
			byHostTerminal: (hostTerminalId: string) =>
				pending[hostTerminalId] ?? null,
			unanswerableReason: () => null,
			headline: (question: PendingQuestion) =>
				question.questions[0]?.header ?? "",
			reconcile: async () => [],
			oldestPendingAgeMs: () => null,
		} as unknown as ReadDeps["questions"],
		liveness: {
			refresh: async () => {},
			isLive: () => true,
			isProvablyGone: () => false,
			describe: () => ({
				hasSnapshot: true,
				aliveCount: fixture.terminals.length,
				takenAtMs: NOW,
			}),
		},
		organizationId: ORG,
		versions: { appVersion: "0", hostServiceVersion: "0", forkTag: "0" },
		bridgeStartedMs: NOW,
		ledger: { currentEpoch: () => "epoch" } as unknown as ReadDeps["ledger"],
		currentGseq: () => 7,
		onQuestionsSettled: () => {},
	};
}

function terminal(
	id: string,
	originWorkspaceId: string,
	overrides: Partial<HostTerminalRow> = {},
): HostTerminalRow {
	return {
		id,
		originWorkspaceId,
		status: "active",
		createdAt: NOW - 100_000,
		lastAttachedAt: NOW - 1_000,
		endedAt: null,
		...overrides,
	};
}

/** As `workspaces.createSession` writes it: real worktree, NO project. */
function sessionWorkspaceRow(id: string): HostWorkspaceRow {
	return {
		id,
		projectId: null,
		name: id,
		branch: "main",
		worktreePath: `C:/Users/me/.superset/sessions/${id}`,
		type: "session",
		createdAt: NOW - 200_000,
	};
}

function repoWorkspaceRow(id: string, projectId: string): HostWorkspaceRow {
	return {
		id,
		projectId,
		name: id,
		branch: id,
		worktreePath: `C:/wt/${id}`,
		type: "worktree",
		createdAt: NOW - 200_000,
	};
}

const FULL_CTX = {
	granted: ["tree.read"],
	device: { revokedAtMs: null, writesDisabledAtMs: null },
} as unknown as SealedRequestContext;

async function tree(fixture: TreeFixture): Promise<TreeResponse> {
	return handleTree(treeDeps(fixture), FULL_CTX, { includeIdle: true });
}

const BASE_PROJECTS: HostProjectRow[] = [
	{ id: "p-git", name: "repo", repoPath: "C:/repo", worktreeBaseDir: null },
];

describe("(SESSIONS-PROJECT) handleTree", () => {
	it("renders a session under the synthetic Sessions project instead of dropping it for having no project_id", async () => {
		const response = await tree({
			projects: BASE_PROJECTS,
			workspaces: [
				repoWorkspaceRow("w-branch", "p-git"),
				sessionWorkspaceRow("w-session"),
			],
			terminals: [
				terminal("t-branch", "w-branch"),
				terminal("t-session", "w-session"),
			],
			bindings: [],
			mirror: snapshot(
				[mirrorWorkspace("w-branch", { projectId: "p-git" })],
				[mirrorProject("p-git")],
			),
		});
		expect(response.projects.map((p) => p.name).sort()).toEqual([
			SESSIONS_PROJECT_NAME,
			"repo",
		]);
		const sessions = response.projects.find(
			(p) => p.name === SESSIONS_PROJECT_NAME,
		);
		expect(sessions?.workspaces.map((w) => w.name)).toEqual(["w-session"]);
		// Kind stays `unknown`: the group is not a repository, so `plain`/`git`
		// would be an invented fact about a project host.db does not have.
		expect(sessions?.kind).toBe("unknown");
		// Both terminals counted — the badge must agree with the screen.
		expect(response.counts.idle).toBe(2);
	});

	it("drops a session the user binned — a synthetic group is not an exemption from curation", async () => {
		const response = await tree({
			projects: BASE_PROJECTS,
			workspaces: [sessionWorkspaceRow("w-session")],
			terminals: [terminal("t-session", "w-session")],
			bindings: [],
			mirror: snapshot(
				[
					mirrorWorkspace("w-session", {
						projectId: "superset:sessions",
						deletedAt: NOW - 10,
					}),
				],
				[mirrorProject("p-git")],
			),
		});
		expect(response.projects).toEqual([]);
		expect(response.counts).toMatchObject({ needsInput: 0, idle: 0 });
	});

	it("groups a session the user dragged under a repo with that repo, not under Sessions", async () => {
		const response = await tree({
			projects: BASE_PROJECTS,
			workspaces: [sessionWorkspaceRow("w-session")],
			terminals: [terminal("t-session", "w-session")],
			bindings: [],
			mirror: snapshot(
				[mirrorWorkspace("w-session", { projectId: "p-git" })],
				[mirrorProject("p-git")],
			),
		});
		expect(response.projects.map((p) => p.name)).toEqual(["repo"]);
		expect(response.projects[0]?.workspaces.map((w) => w.name)).toEqual([
			"w-session",
		]);
	});
});
