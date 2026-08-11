import { create } from "zustand";

export interface DestroyWorkspaceTarget {
	workspaceId: string;
	workspaceName: string;
}

/**
 * (RECYCLE-BIN) Drives the single globally-mounted permanent-destroy dialog
 * (DestroyWorkspaceMount). The fork's ordinary Delete is a silent soft-delete
 * (see delete-workspace-intent), so upstream's archive-first
 * `workspaceCleanup.destroy` is only ever reached from in-bin "Delete
 * permanently" — the sidebar bin row and the kanban bin sub-section. Both of
 * those are host-sourced rows: the destroy writes its archive tombstone at
 * step 0, the row leaves `workspace.list` immediately, and a bin row whose
 * host record is gone drops out of `rawSidebarWorkspaces` (a kanban card the
 * same way). A dialog mounted UNDER such a row therefore unmounts the instant
 * the destroy starts, taking the teardown-failure force-retry pane
 * ("skipTeardown") with it — the one failure branch that shows no toast. This
 * store is the fork's equivalent of the hoist upstream applied to its own
 * delete dialog.
 *
 * `open` is tracked separately from `target` so the dialog stays mounted
 * (latched) through an in-flight destroy and can re-open itself on a teardown
 * failure. `setOpen`/`close` take the workspaceId so a stale callback from a
 * superseded destroy (a new `request` replaced the target mid-flight) can't
 * close or reopen the new target's dialog.
 */
interface DestroyWorkspaceIntentState {
	target: DestroyWorkspaceTarget | null;
	open: boolean;
	request: (target: DestroyWorkspaceTarget) => void;
	setOpen: (workspaceId: string, open: boolean) => void;
	close: (workspaceId: string) => void;
}

export const useDestroyWorkspaceIntent = create<DestroyWorkspaceIntentState>(
	(set) => ({
		target: null,
		open: false,
		request: (target) => set({ target, open: true }),
		setOpen: (workspaceId, open) =>
			set((state) =>
				state.target?.workspaceId === workspaceId ? { open } : state,
			),
		close: (workspaceId) =>
			set((state) =>
				state.target?.workspaceId === workspaceId
					? { target: null, open: false }
					: state,
			),
	}),
);
