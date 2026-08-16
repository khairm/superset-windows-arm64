/**
 * (RECYCLE-BIN) Pure core of the multi-select "Delete N workspaces" action: it
 * soft-deletes every selected row through the SAME `deleteWorkspace` the
 * single-row Delete uses — no host call, no git destroy. Permanent destruction
 * exists only inside the Recycle Bin ("Delete permanently" / "Empty Recycle
 * Bin").
 *
 * Only rows that were ACTUALLY soft-deleted are reported back for deselection:
 *
 *   - mains are excluded up front for the same reason the single-row path
 *     refuses them (MASTER-ARCHIVE-ONLY);
 *   - `softDelete` returns false for the refusals only the sidebar state hook
 *     can see (a workspace whose host record — and therefore its type — can't
 *     be resolved), and those rows stay selected too.
 *
 * A refused row is still sitting in the active lane, so counting it as deleted
 * would drop it from the selection while nothing about it changed.
 */
export function executeBulkWorkspaceSoftDelete<
	Workspace extends { id: string; type: string },
>({
	targets,
	softDelete,
}: {
	targets: readonly Workspace[];
	/** True when the row was soft-deleted; false when the state hook refused. */
	softDelete: (workspace: Workspace) => boolean;
}): {
	softDeletedIds: string[];
	skippedMainIds: string[];
	refusedIds: string[];
} {
	const softDeletedIds: string[] = [];
	const skippedMainIds: string[] = [];
	const refusedIds: string[] = [];

	for (const workspace of targets) {
		if (workspace.type === "main") {
			skippedMainIds.push(workspace.id);
			continue;
		}
		if (!softDelete(workspace)) {
			refusedIds.push(workspace.id);
			continue;
		}
		softDeletedIds.push(workspace.id);
	}

	return { softDeletedIds, skippedMainIds, refusedIds };
}
