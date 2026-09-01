import { Trans, useLingui } from "@lingui/react/macro";
import { errorMessage } from "@superset/i18n/errors";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "@superset/ui/context-menu";
import { toast } from "@superset/ui/sonner";
import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useCallback } from "react";
import {
	LuArrowUpRight,
	LuGitBranch,
	LuPanelLeftClose,
	LuPanelLeftOpen,
	LuTrash2,
} from "react-icons/lu";
import { GATED_FEATURES, usePaywall } from "renderer/components/Paywall";
import { useCopyToClipboard } from "renderer/hooks/useCopyToClipboard";
import { navigateToV2Workspace } from "renderer/routes/_authenticated/_dashboard/utils/workspace-navigation";
import type { AccessibleV2Workspace } from "renderer/routes/_authenticated/_dashboard/v2-workspaces/hooks/useAccessibleV2Workspaces";
import { useDashboardSidebarState } from "renderer/routes/_authenticated/hooks/useDashboardSidebarState";

export interface V2WorkspaceActions {
	/** Navigate to the workspace (paywall-gated for remote hosts). */
	open: () => void;
	addToSidebar: () => void;
	removeFromSidebar: () => void;
	/**
	 * (RECYCLE-BIN) Despite the name this opens NO destroy dialog — every
	 * delete entry point soft-deletes to the project's Recycle Bin. Kept
	 * under the upstream name so both surfaces (list row, board card) keep
	 * calling the same action.
	 */
	openDeleteDialog: () => void;
}

interface V2WorkspaceContextMenuProps {
	workspace: AccessibleV2Workspace;
	/** Hiding the current route's workspace from the sidebar is blocked. */
	isCurrentRoute?: boolean;
	/** Rendered as the context-menu trigger; receives the shared actions so
	 * inline affordances (pin cell, trash button, card click) reuse them. */
	children: (actions: V2WorkspaceActions) => ReactNode;
}

/**
 * Right-click menu + delete-dialog wiring shared by the list rows and the
 * board cards. Owns the workspace actions so both surfaces stay identical.
 */
export function V2WorkspaceContextMenu({
	workspace,
	isCurrentRoute = false,
	children,
}: V2WorkspaceContextMenuProps) {
	const { t } = useLingui();
	const navigate = useNavigate();
	const { gateFeature } = usePaywall();
	const {
		ensureWorkspaceInSidebar,
		hideWorkspaceInSidebar,
		archiveWorkspace,
		deleteWorkspace,
		unarchiveWorkspace,
	} = useDashboardSidebarState();
	const { copyToClipboard } = useCopyToClipboard();
	const isMainWorkspace = workspace.type === "main";

	const open = useCallback(() => {
		const go = () => navigateToV2Workspace(workspace.id, navigate);
		if (workspace.hostType === "local-device") {
			go();
			return;
		}
		gateFeature(GATED_FEATURES.REMOTE_ACCESS, go);
	}, [gateFeature, navigate, workspace.hostType, workspace.id]);

	const addToSidebar = useCallback(() => {
		const add = () => {
			// An archived thread is already in the sidebar's data — restore it
			// instead of re-inserting (ensureWorkspaceInSidebar no-ops on it).
			if (workspace.isArchived) {
				unarchiveWorkspace(workspace.id);
			} else {
				ensureWorkspaceInSidebar(workspace.id, workspace.projectId);
			}
		};
		if (workspace.hostType === "local-device") {
			add();
			return;
		}
		gateFeature(GATED_FEATURES.REMOTE_ACCESS, add);
	}, [
		ensureWorkspaceInSidebar,
		unarchiveWorkspace,
		gateFeature,
		workspace.hostType,
		workspace.id,
		workspace.isArchived,
		workspace.projectId,
	]);

	const removeFromSidebar = useCallback(() => {
		if (isCurrentRoute) return;
		// Hide directly (synchronous optimistic write) rather than routing
		// through the intent store + RemoveFromSidebarMount effect, which adds
		// an extra render cycle of latency. The list view is never a workspace
		// route, so there's no active workspace to navigate away from.
		//
		if (isMainWorkspace) {
			// (MASTER-ARCHIVE-ONLY) Master / non-git master cards ARCHIVE
			// (recoverable under the project's Archived section) — they can
			// never be hard-removed/hidden.
			archiveWorkspace(workspace.id, workspace.projectId);
		} else {
			// Always hide (keep the row with isHidden) rather than delete: the
			// auto-add-local-workspaces hook treats a missing v2WorkspaceLocalState
			// row as never-seen and would re-pin it. The tombstone row preserves the
			// unpin intent.
			hideWorkspaceInSidebar(workspace.id, workspace.projectId);
		}
	}, [
		isCurrentRoute,
		isMainWorkspace,
		archiveWorkspace,
		hideWorkspaceInSidebar,
		workspace.id,
		workspace.projectId,
	]);

	const handleCopyBranchName = useCallback(async () => {
		try {
			await copyToClipboard(workspace.branch);
			toast.success(
				t({
					id: "dashboard.workspaces.contextMenu.branchNameCopied",
					message: "Branch name copied",
				}),
			);
		} catch (error) {
			toast.error(
				t({
					id: "dashboard.workspaces.contextMenu.copyBranchNameFailed",
					message: `Failed to copy branch name: ${errorMessage(
						error,
						t({
							id: "dashboard.workspaces.contextMenu.unknownError",
							message: "Unknown error",
						}),
					)}`,
				}),
			);
		}
	}, [copyToClipboard, workspace.branch, t]);

	// (RECYCLE-BIN) The trash affordance is a SILENT soft-delete — it moves the
	// thread to its project's Recycle Bin (deletedAt + isHidden) instead of
	// opening the destroy dialog. The real git destroy is reachable ONLY from
	// in-bin "Delete permanently" / "Empty Recycle Bin". Mains never reach here
	// (the affordance only renders for non-main rows; deleteWorkspace refuses a
	// main anyway).
	const openDeleteDialog = useCallback(() => {
		deleteWorkspace(workspace.id, workspace.projectId);
	}, [deleteWorkspace, workspace.id, workspace.projectId]);

	return (
		<ContextMenu>
			<ContextMenuTrigger asChild>
				{children({
					open,
					addToSidebar,
					removeFromSidebar,
					openDeleteDialog,
				})}
			</ContextMenuTrigger>
			<ContextMenuContent onCloseAutoFocus={(event) => event.preventDefault()}>
				<ContextMenuItem onSelect={open}>
					<LuArrowUpRight className="size-4" />
					<Trans id="dashboard.workspaces.contextMenu.open">Open</Trans>
				</ContextMenuItem>
				<ContextMenuItem onSelect={handleCopyBranchName}>
					<LuGitBranch className="size-4" />
					<Trans id="dashboard.workspaces.contextMenu.copyBranchName">
						Copy Branch Name
					</Trans>
				</ContextMenuItem>
				<ContextMenuSeparator />
				{workspace.isInSidebar ? (
					<ContextMenuItem
						onSelect={removeFromSidebar}
						disabled={isCurrentRoute}
					>
						<LuPanelLeftClose className="size-4" />
						<Trans id="dashboard.workspaces.contextMenu.unpinFromSidebar">
							Hide from Sidebar
						</Trans>
					</ContextMenuItem>
				) : (
					<ContextMenuItem onSelect={addToSidebar}>
						<LuPanelLeftOpen className="size-4" />
						<Trans id="dashboard.workspaces.contextMenu.pinToSidebar">
							Show on Sidebar
						</Trans>
					</ContextMenuItem>
				)}
				{!isMainWorkspace ? (
					<>
						<ContextMenuSeparator />
						{/* (RECYCLE-BIN) Silent soft-delete to the project's Recycle Bin —
						    not a destroy dialog. */}
						<ContextMenuItem
							onSelect={openDeleteDialog}
							className="text-destructive focus:text-destructive"
						>
							<LuTrash2 className="size-4 text-destructive" />
							<Trans id="dashboard.workspaces.contextMenu.delete">Delete</Trans>
						</ContextMenuItem>
					</>
				) : null}
			</ContextMenuContent>
		</ContextMenu>
	);
}
