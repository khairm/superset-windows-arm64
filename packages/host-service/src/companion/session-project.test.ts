/**
 * (SESSIONS-PROJECT) The synthetic Sessions group — ids and curation.
 *
 * A session is an ORDINARY workspace row (`workspaces.createSession`: real id,
 * real worktree under `~/.superset/sessions`, `type = "session"`) with one
 * difference: `project_id` is NULL, because a session is not a branch of any
 * repo. Everything project-shaped therefore dropped it, and the two rules below
 * are what put it back without inventing a workspace that nothing can adopt.
 */

import { describe, expect, it } from "bun:test";
import {
	isSessionsProjectId,
	placementProjectId,
	SESSIONS_PROJECT_ID,
} from "./session-project";
import { createSidebarCuration } from "./sidebar-filter";
import {
	mirrorProject,
	mirrorWorkspace,
	NOW,
	ORG,
	snapshot,
} from "./test-fixtures";

/** A session workspace as `host.db` holds it: real id, NO project. */
const SESSION_WORKSPACE = {
	id: "w-session",
	projectId: null,
	type: "session",
};

describe("(SESSIONS-PROJECT) placement", () => {
	it("maps a missing project onto the synthetic group and leaves a real one alone", () => {
		expect(placementProjectId(null)).toBe(SESSIONS_PROJECT_ID);
		expect(placementProjectId(undefined)).toBe(SESSIONS_PROJECT_ID);
		expect(placementProjectId("")).toBe(SESSIONS_PROJECT_ID);
		expect(placementProjectId("p-git")).toBe("p-git");
		expect(isSessionsProjectId(SESSIONS_PROJECT_ID)).toBe(true);
		expect(isSessionsProjectId("p-git")).toBe(false);
	});
});

describe("(SESSIONS-PROJECT) curation", () => {
	it("shows a session although no `sidebar_project_state` row exists for the synthetic project — a project that CANNOT have a row must not read as one the user removed", () => {
		const curation = createSidebarCuration(
			snapshot([], [mirrorProject("p-git")]),
			NOW,
			ORG,
		);
		expect(curation.enabled).toBe(true);
		expect(curation.effectiveProjectId(SESSION_WORKSPACE)).toBe(
			SESSIONS_PROJECT_ID,
		);
		expect(curation.projectVerdict(SESSIONS_PROJECT_ID)).toBe("show");
		expect(curation.workspaceVerdict(SESSION_WORKSPACE)).toBe("show");
	});

	it("still hides a session the user binned or removed — membership is exempt, the rows under it are not", () => {
		const binned = createSidebarCuration(
			snapshot(
				[
					mirrorWorkspace(SESSION_WORKSPACE.id, {
						projectId: SESSIONS_PROJECT_ID,
						deletedAt: NOW - 10,
					}),
				],
				[],
			),
			NOW,
			ORG,
		);
		expect(binned.workspaceVerdict(SESSION_WORKSPACE)).toBe("deleted");

		const removed = createSidebarCuration(
			snapshot(
				[
					mirrorWorkspace(SESSION_WORKSPACE.id, {
						projectId: SESSIONS_PROJECT_ID,
						isHidden: 1,
					}),
				],
				[],
			),
			NOW,
			ORG,
		);
		// `archived`, not `hidden`: a session is not a `main` workspace, so
		// removing it is the recoverable act the sidebar calls archiving.
		expect(removed.workspaceVerdict(SESSION_WORKSPACE)).toBe("archived");
	});

	it("honours a session the user DRAGGED under a real repo — the mirrored placement still wins over the synthetic fallback", () => {
		const curation = createSidebarCuration(
			snapshot(
				[mirrorWorkspace(SESSION_WORKSPACE.id, { projectId: "p-git" })],
				[mirrorProject("p-git")],
			),
			NOW,
			ORG,
		);
		expect(curation.effectiveProjectId(SESSION_WORKSPACE)).toBe("p-git");
		expect(curation.workspaceVerdict(SESSION_WORKSPACE)).toBe("show");
	});

	it("places a session under the synthetic group even when curation is DISABLED — the pass-through must not answer NULL, which no consumer can group", () => {
		const passThrough = createSidebarCuration(
			{ meta: null, workspaces: [], projects: [] },
			NOW,
			ORG,
		);
		expect(passThrough.enabled).toBe(false);
		expect(passThrough.effectiveProjectId(SESSION_WORKSPACE)).toBe(
			SESSIONS_PROJECT_ID,
		);
	});
});
