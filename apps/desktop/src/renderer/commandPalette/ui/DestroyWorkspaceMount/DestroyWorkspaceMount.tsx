import { DashboardSidebarDeleteDialog } from "renderer/routes/_authenticated/_dashboard/components/DashboardSidebar/components/DashboardSidebarDeleteDialog";
import { useDashboardSidebarState } from "renderer/routes/_authenticated/hooks/useDashboardSidebarState";
import { useDestroyWorkspaceIntent } from "renderer/stores/destroy-workspace-intent";

/**
 * (RECYCLE-BIN) The single mount for the permanent-destroy dialog, shared by
 * every "Delete permanently" entry point (sidebar Recycle Bin row, kanban bin
 * sub-section). Sits next to DeleteWorkspaceMount at the command-palette host
 * level — inside the dashboard layout, but ABOVE the sidebar rows and board
 * cards — because upstream's destroy pipeline archives the workspace first:
 * the host row (and the bin row/card rendered from it) disappears the instant
 * the destroy starts, so a row-local dialog would unmount mid-destroy and the
 * teardown-failure force-retry pane would never paint.
 *
 * Closing only flips `open` (the target stays latched) so an in-flight destroy
 * can re-open it on failure; `key` gives each workspace a fresh dialog
 * instance so no error/preview state leaks between targets. On success the
 * local sidebar record — the row that held the bin's `deletedAt` — is dropped
 * here, which is also what prunes the bound kanban card.
 */
export function DestroyWorkspaceMount() {
	const target = useDestroyWorkspaceIntent((s) => s.target);
	const open = useDestroyWorkspaceIntent((s) => s.open);
	const setOpen = useDestroyWorkspaceIntent((s) => s.setOpen);
	const close = useDestroyWorkspaceIntent((s) => s.close);
	const { removeWorkspaceFromSidebar } = useDashboardSidebarState();

	if (!target) return null;
	// Callbacks bind the rendered target's id: a dialog whose destroy is still
	// in flight after a new request replaced the target keeps its own id, so
	// its settle can't touch the new target's dialog.
	const workspaceId = target.workspaceId;
	return (
		<DashboardSidebarDeleteDialog
			key={workspaceId}
			workspaceId={workspaceId}
			workspaceName={target.workspaceName}
			open={open}
			onOpenChange={(next) => setOpen(workspaceId, next)}
			onDeleted={() => {
				removeWorkspaceFromSidebar(workspaceId);
				close(workspaceId);
			}}
		/>
	);
}
