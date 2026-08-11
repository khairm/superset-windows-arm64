import { useEffect } from "react";
import { useNavigateAwayFromWorkspace } from "renderer/routes/_authenticated/_dashboard/components/DashboardSidebar/hooks/useNavigateAwayFromWorkspace";
import { useDashboardSidebarState } from "renderer/routes/_authenticated/hooks/useDashboardSidebarState";
import { useDeleteWorkspaceIntent } from "renderer/stores/delete-workspace-intent";

/**
 * (RECYCLE-BIN) Headless consumer for every "Delete workspace" entry point
 * (sidebar row, board card, command palette, close-workspace hotkey,
 * missing-worktree screen — they all request through the delete-workspace
 * intent store). Delete is a SILENT soft-delete: it moves the thread to its
 * project's Recycle Bin (deletedAt + isHidden) and navigates off its route — it
 * does NOT open the destroy dialog, so upstream's archive-first destroy
 * pipeline (and its teardown-failure re-open pane) is only ever reached from
 * in-bin "Delete permanently" / "Empty Recycle Bin". Mirrors
 * RemoveFromSidebarMount (callers fire imperatively and can't use the
 * router/collections hooks directly). This mount still lives at the
 * command-palette host level so it survives the row unmounting under it.
 *
 * Mains never reach here (the command is registered only for non-main
 * workspaces; deleteWorkspace no-ops a main anyway).
 */
export function DeleteWorkspaceMount() {
	const target = useDeleteWorkspaceIntent((s) => s.target);
	const close = useDeleteWorkspaceIntent((s) => s.close);
	const { deleteWorkspace } = useDashboardSidebarState();
	const { navigateAwayFromWorkspace } = useNavigateAwayFromWorkspace();

	useEffect(() => {
		if (!target) return;
		// One-shot consumer: the body is fully synchronous and the collection
		// writes are idempotent; close() resets target to null so each request is
		// handled exactly once — and that reset is also what lets a repeat delete of
		// the SAME id re-fire (the next request is a fresh, non-null target object,
		// so the effect's identity-based dependency changes again). close() is
		// id-scoped upstream, so a request that superseded this one is left alone.
		const workspaceId = target.workspaceId;
		navigateAwayFromWorkspace(workspaceId);
		deleteWorkspace(workspaceId);
		close(workspaceId);
	}, [target, navigateAwayFromWorkspace, deleteWorkspace, close]);

	return null;
}
