/**
 * (SESSIONS-PROJECT) The synthetic "Sessions" project — one id, shared by the
 * renderer sidebar and every host-side consumer of `host.db`.
 *
 * WHAT A SESSION ACTUALLY IS. `workspaces.createSession` inserts an ORDINARY
 * workspace row: a real id, a real `worktree_path` under `~/.superset/sessions`,
 * `type = "session"` — and `project_id = NULL`, because a session is not a
 * branch of any repo. Everything that treats a session as a first-class
 * workspace (attach, adopt, write input, answer a question) therefore works on
 * it already, and nothing here may pretend otherwise.
 *
 * WHAT BREAKS IS GROUPING, AND ONLY GROUPING. Every surface built on the
 * project → workspace → terminal shape iterates `projects` and asks for the
 * workspaces under each one, so a workspace whose `project_id` is NULL belongs
 * to no group and falls out of the list entirely: it was absent from the
 * companion tree, from the badge counts, and — because the renderer mirrors a
 * curation row's PLACEMENT and a session has none — from the curation mirror
 * too. The synthetic id below is the group those rows are placed in.
 *
 * NO DB SCHEMA, DELIBERATELY. Nothing writes this id into `host.db`;
 * `project_id` stays NULL and every existing join keeps meaning what it meant.
 * It exists in the projection layer, and in the renderer's mirror where the
 * placement column is a free-form string the renderer already owns.
 *
 * IT CANNOT COLLIDE with a real `projects.id`: those are uuids, and the
 * `superset:` prefix is not one and is never minted by the host-service.
 */

/** The synthetic project a workspace with no `project_id` is placed under. */
export const SESSIONS_PROJECT_ID = "superset:sessions";

/** Display label. The bridge has no other name to report for the group. */
export const SESSIONS_PROJECT_NAME = "Sessions";

/**
 * Where a workspace SITS, given its own `projects.id` — the synthetic group
 * when it has none.
 *
 * The one place the NULL is interpreted, so the renderer's mirror, the
 * curation filter and the tree cannot drift into three different answers about
 * where a session belongs.
 */
export function placementProjectId(
	projectId: string | null | undefined,
): string {
	return projectId != null && projectId.length > 0
		? projectId
		: SESSIONS_PROJECT_ID;
}

export function isSessionsProjectId(projectId: string): boolean {
	return projectId === SESSIONS_PROJECT_ID;
}
