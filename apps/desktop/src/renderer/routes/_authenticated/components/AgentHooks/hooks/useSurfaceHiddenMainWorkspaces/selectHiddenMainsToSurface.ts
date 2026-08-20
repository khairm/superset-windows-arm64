import {
	getWorkspaceSidebarBucket,
	isLocalMainWorkspaceInSidebarScope,
} from "renderer/routes/_authenticated/providers/CollectionsProvider/dashboardSidebarLocal";
import type { LocalWorkspaceForPlacement } from "../usePlaceLocalWorktreesInSidebar/selectWorktreesToPlace";

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
 *  - it has a project, and that project is in the user's sidebar — the shared
 *    `isLocalMainWorkspaceInSidebarScope` gate, so this stays an exact
 *    complement of `isAutoIncludedLocalMainWorkspace`;
 *  - a local-state ROW EXISTS. Row-LESS mains are NOT ours: they surface
 *    through `isAutoIncludedLocalMainWorkspace` and must never be selected here
 *    (inserting a row for one would take them out of that gated path);
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
 * (its `v2SidebarProjects` row is gone, so the predicate is false).
 */
export function selectHiddenMainsToSurface(
	localWorkspaces: readonly LocalWorkspaceForPlacement[],
	localStateRows: readonly HiddenMainSidebarRow[],
	sidebarProjectRows: readonly { projectId: string }[],
	machineId: string | null,
	nowMs: number,
): Array<{ id: string; projectId: string }> {
	if (machineId === null) return [];

	const rowsByWorkspaceId = new Map(
		localStateRows.map((row) => [row.workspaceId, row]),
	);
	const sidebarProjectIds = new Set(
		sidebarProjectRows.map((row) => row.projectId),
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

			// Row-less mains belong to isAutoIncludedLocalMainWorkspace — leave them
			// alone; they are already visible and writing a row would change owner.
			const row = rowsByWorkspaceId.get(workspace.id);
			if (row === undefined) return [];

			if (getWorkspaceSidebarBucket(row, nowMs, "main") !== "hidden") return [];

			return [{ id: workspace.id, projectId: workspace.projectId }];
		},
	);
}
