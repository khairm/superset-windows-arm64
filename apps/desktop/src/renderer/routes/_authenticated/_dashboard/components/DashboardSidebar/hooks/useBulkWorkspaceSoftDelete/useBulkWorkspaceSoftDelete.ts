import { useCallback } from "react";
import { useDashboardSidebarState } from "renderer/routes/_authenticated/hooks/useDashboardSidebarState";
import type { DashboardSidebarWorkspace } from "../../types";
import { executeBulkWorkspaceSoftDelete } from "./bulkWorkspaceSoftDelete";

interface UseBulkWorkspaceSoftDeleteOptions {
	selectedWorkspaces: DashboardSidebarWorkspace[];
	/** Reconciles the selection with the rows that actually left the lane. */
	onDeleted: (workspaceIds: string[]) => void;
}

/**
 * (RECYCLE-BIN) Bulk delete is a soft delete: every selected row moves to its
 * Recycle Bin (worktree, branch and terminals untouched) and Restore brings it
 * back — the same silent, lossless move the single-row Delete performs, with no
 * dialog and no toast. This is why the multi-select path no longer opens a
 * destroy dialog: a bulk hard-destroy was the one delete entry point that
 * bypassed the bin.
 */
export function useBulkWorkspaceSoftDelete({
	selectedWorkspaces,
	onDeleted,
}: UseBulkWorkspaceSoftDeleteOptions) {
	const { deleteWorkspace } = useDashboardSidebarState();

	const softDeleteSelection = useCallback(() => {
		const { softDeletedIds } = executeBulkWorkspaceSoftDelete({
			targets: selectedWorkspaces,
			softDelete: (workspace) =>
				deleteWorkspace(workspace.id, workspace.projectId),
		});
		if (softDeletedIds.length === 0) return;
		onDeleted(softDeletedIds);
	}, [deleteWorkspace, onDeleted, selectedWorkspaces]);

	return { softDeleteSelection };
}
