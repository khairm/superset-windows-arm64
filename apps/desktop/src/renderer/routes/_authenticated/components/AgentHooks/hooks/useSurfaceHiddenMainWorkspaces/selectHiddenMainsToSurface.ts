import {
	getWorkspaceSidebarBucket,
	isLocalMainWorkspaceInSidebarScope,
} from "renderer/routes/_authenticated/providers/CollectionsProvider/dashboardSidebarLocal";
import type { WorkspaceForPlacement } from "../usePlaceWorktreesInSidebar/selectWorktreesToPlace";

/**
 * The workspace fields BOTH sidebar reconcilers select on. Derived from the
 * placement type rather than redeclared so the two cannot drift into
 * disagreeing about what a row is. It is a `Pick` because the placement
 * selector also gates on `hostReachable`/`createdByUserId` (remote hosts,
 * #7100) and this reconciler is local-mains-only, so requiring them here
 * would make callers invent values the predicate never reads.
 */
export type LocalWorkspaceForPlacement = Pick<
	WorkspaceForPlacement,
	"id" | "projectId" | "hostId"
> & {
	/**
	 * Upstream desktop-v1.30.1 retired "main" from the placement union when it
	 * retired the main-workspace concept; the fork's master row still carries
	 * it, and it is the whole predicate below.
	 */
	type: WorkspaceForPlacement["type"] | "main";
};

/**
 * The classifier-relevant half of a `v2WorkspaceLocalState` row. Every field is
 * optional and nullable on purpose: `withReadHeal` does not validate reads, so a
 * persisted row can come back with fields missing or of the wrong shape. The
 * bucket classifier tolerates that, and so must anything that feeds it.
 */
export type HiddenMainSidebarState = {
	isHidden?: boolean | null;
	archivedAt?: number | null;
	snoozeUntil?: number | null;
	snoozeLaunchId?: string | null;
	completedAt?: number | null;
	deletedAt?: number | null;
};

/** A local-state row as the hook's live query selects it: flat, id-carrying. */
export type HiddenMainSidebarRow = HiddenMainSidebarState & {
	workspaceId: string;
};

/**
 * A `v2SidebarProjects` row as the hook's live query selects it. `isHidden` is
 * optional and nullable for the same reason the state fields above are: rows
 * persisted before the flag existed read back undefined.
 */
export type SidebarProjectVisibilityRow = {
	projectId: string;
	isHidden?: boolean | null;
};

/**
 * (MASTER-ALWAYS-ACTIVE) Chooses which master ("main") workspaces are stuck in
 * the legacy "hidden" bucket and must be returned to the ACTIVE sidebar list.
 * Kept free of React so it can be unit-tested directly.
 *
 * A hidden main renders NOWHERE: the active lane skips it (isHidden), and the
 * Archived section skips it too (`isWorkspaceArchived` has `&& type !== "main"`,
 * so a main without `archivedAt` is never archived). Rows in that state are
 * produced by whole-project removal and by pre-(MASTER-ARCHIVE-ONLY) master-card
 * removes, and there is no surface left to recover them from — hence a
 * reconciler rather than a user action.
 *
 * The predicate, in order:
 *  - a known machine (`machineId`), and the workspace is a `main` on it;
 *  - it has a project, and that project is VISIBLE in the user's sidebar — the
 *    shared `isLocalMainWorkspaceInSidebarScope` gate, fed only the project
 *    rows that are not `isHidden`;
 *  - a local-state ROW EXISTS. Row-LESS mains are NOT ours: `usePlaceWorktreesInSidebar`
 *    places every local workspace, masters included, so one is only ever
 *    momentarily row-less and must never be selected here (inserting a row for
 *    one would take it out of the placement path);
 *  - and the row buckets as "hidden".
 *
 * State is read ONLY through `getWorkspaceSidebarBucket`, never raw
 * `isHidden`/`archivedAt`. The classifier's precedence (deleted > completed >
 * archived > snoozed > hidden > active) IS the whole exclusion list — a binned,
 * completed, archived, snoozed or already-active main falls out for free, and a
 * future bucket inserted ahead of "hidden" excludes itself automatically.
 *
 * This deliberately overrides (REMOVE-STICKY) for mains only: re-adding a
 * removed project resurrects its master. Removing the project still removes it
 * — `removeProjectFromSidebarState` marks the project's `v2SidebarProjects`
 * row hidden (it cannot delete it: upstream's `usePlaceProjectsInSidebar`
 * re-places row-less projects), and a hidden project row is NOT in scope here,
 * so the predicate is false for as long as the project stays removed.
 */
export function selectHiddenMainsToSurface(
	localWorkspaces: readonly LocalWorkspaceForPlacement[],
	localStateRows: readonly HiddenMainSidebarRow[],
	sidebarProjectRows: readonly SidebarProjectVisibilityRow[],
	machineId: string | null,
	nowMs: number,
): Array<{ id: string; projectId: string }> {
	if (machineId === null) return [];

	const rowsByWorkspaceId = new Map(
		localStateRows.map((row) => [row.workspaceId, row]),
	);
	const sidebarProjectIds = new Set(
		sidebarProjectRows
			.filter((row) => row.isHidden !== true)
			.map((row) => row.projectId),
	);

	return localWorkspaces.flatMap(
		(workspace): Array<{ id: string; projectId: string }> => {
			if (workspace.type !== "main") return [];
			if (
				!isLocalMainWorkspaceInSidebarScope(workspace, {
					sidebarProjectIds,
					machineId,
				})
			) {
				return [];
			}

			// Row-less mains belong to the placement reconciler — leave them alone;
			// writing a row here would change owner.
			const row = rowsByWorkspaceId.get(workspace.id);
			if (row === undefined) return [];

			if (getWorkspaceSidebarBucket(row, nowMs, "main") !== "hidden") return [];

			return [{ id: workspace.id, projectId: workspace.projectId }];
		},
	);
}
