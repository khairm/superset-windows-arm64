/**
 * (SESSIONS-PROJECT) `/v1/tree` and the badge counts over a fixture containing
 * a session workspace — the rows that used to fall out of both because they
 * have no `project_id` to be grouped under.
 */

import { describe, expect, it } from "bun:test";
import { handleTree } from "./read-api";
import { SESSIONS_PROJECT_NAME } from "./session-project";
import {
	mirrorProject,
	mirrorWorkspace,
	NOW,
	projectRow,
	snapshot,
	type TreeFixture,
	terminalRow as terminal,
	treeDeps,
	workspaceRow,
} from "./test-fixtures";
import type { SealedRequestContext, TreeResponse } from "./types";

/** As `workspaces.createSession` writes it: real worktree, NO project. */
function sessionWorkspaceRow(id: string) {
	return workspaceRow(id, null, {
		branch: "main",
		worktreePath: `C:/Users/me/.superset/sessions/${id}`,
		type: "session",
	});
}

const FULL_CTX = {
	granted: ["tree.read"],
	device: { revokedAtMs: null, writesDisabledAtMs: null },
} as unknown as SealedRequestContext;

async function tree(fixture: TreeFixture): Promise<TreeResponse> {
	return handleTree(treeDeps(fixture), FULL_CTX, { includeIdle: true });
}

const BASE_PROJECTS = [projectRow("p-git", "repo")];

describe("(SESSIONS-PROJECT) handleTree", () => {
	it("renders a session under the synthetic Sessions project instead of dropping it for having no project_id", async () => {
		const response = await tree({
			projects: BASE_PROJECTS,
			workspaces: [
				workspaceRow("w-branch", "p-git"),
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
