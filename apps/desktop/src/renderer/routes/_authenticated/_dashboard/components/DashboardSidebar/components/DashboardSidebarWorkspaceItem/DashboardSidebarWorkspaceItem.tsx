import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDiffStats } from "renderer/hooks/host-service/useDiffStats";
import { useIsGitRepo } from "renderer/hooks/host-service/useIsGitRepo";
import { useOptimisticCollectionActions } from "renderer/routes/_authenticated/hooks/useOptimisticCollectionActions";
import { useDeletingWorkspaces } from "renderer/routes/_authenticated/providers/DeletingWorkspacesProvider";
import { RenameBranchDialog } from "renderer/screens/main/components/WorkspaceSidebar/WorkspaceListItem/components";
import {
	useV2WorkspaceDisplayStatus,
	useV2WorkspaceTerminalStatuses,
} from "renderer/stores/v2-notifications";
import { useDashboardSidebarHover } from "../../providers/DashboardSidebarHoverProvider";
import type { DashboardSidebarWorkspace } from "../../types";
import { DashboardSidebarDeleteDialog } from "../DashboardSidebarDeleteDialog";
import { DashboardSidebarCollapsedWorkspaceButton } from "./components/DashboardSidebarCollapsedWorkspaceButton";
import { DashboardSidebarExpandedWorkspaceRow } from "./components/DashboardSidebarExpandedWorkspaceRow";
import { DashboardSidebarWorkspaceContextMenu } from "./components/DashboardSidebarWorkspaceContextMenu/DashboardSidebarWorkspaceContextMenu";
import { useDashboardSidebarWorkspaceItemActions } from "./hooks/useDashboardSidebarWorkspaceItemActions";

interface DashboardSidebarWorkspaceItemProps {
	workspace: DashboardSidebarWorkspace;
	onHoverCardOpen?: () => void;
	shortcutLabel?: string;
	isCollapsed?: boolean;
	isInSection?: boolean;
	sectionState?: "snoozed" | "archived";
}

export function DashboardSidebarWorkspaceItem({
	workspace,
	onHoverCardOpen,
	shortcutLabel,
	isCollapsed = false,
	isInSection = false,
	sectionState,
}: DashboardSidebarWorkspaceItemProps) {
	const {
		id,
		projectId,
		accentColor = null,
		hostType,
		hostIsOnline,
		name,
		branch,
		pendingTransaction,
		pullRequest,
	} = workspace;
	const isMainWorkspace = workspace.type === "main";
	// Snoozed/archived rows live in a collapsible section — don't fire their
	// per-row git status RPC + subscription (A6: avoid a reveal-time RPC storm).
	const diffStats = useDiffStats(id, !sectionState);
	// (AY) Display status merges the agent rollup with the shell-running blue
	// fallback (agent wins). Drives the workspace-icon dot.
	const workspaceStatus = useV2WorkspaceDisplayStatus(id);
	// (NON-GIT WORKSPACE) flag the icon once we positively know it is non-git.
	const isNonGit = !useIsGitRepo(id, pendingTransaction?.type !== "insert");
	const terminalStatuses = useV2WorkspaceTerminalStatuses(id);
	const {
		cancelRename,
		handleClick,
		handleCopyPath,
		handleCopyBranchName,
		handleCreateSection,
		handleDeleted,
		handleArchive,
		handleOpenInFinder,
		handleRemoveFromSidebar,
		handleSnooze,
		handleToggleUnread,
		handleUnarchive,
		handleUnsnooze,
		isActive,
		isDeleteDialogOpen,
		isUnread,
		isRenaming,
		moveWorkspaceToSection,
		renameValue,
		setIsDeleteDialogOpen,
		setRenameValue,
		startRename,
		submitRename,
	} = useDashboardSidebarWorkspaceItemActions({
		workspaceId: id,
		projectId,
		workspaceName: name,
		branch,
		isMainWorkspace,
	});

	const { v2Workspaces: v2WorkspaceActions } = useOptimisticCollectionActions();
	const [renameBranchTarget, setRenameBranchTarget] = useState<string | null>(
		null,
	);
	const handleAfterBranchRename = (newBranchName: string) => {
		v2WorkspaceActions.updateWorkspace(id, { branch: newBranchName });
	};
	const isPending = pendingTransaction?.type === "insert";
	// Keep the delete dialog outside the hidden wrapper below — the destroy
	// flow reopens it into an error pane on conflict/teardown-failed.
	const isDeleting = useDeletingWorkspaces().isDeleting(id);

	const {
		hoveredId: hoverHoveredId,
		requestOpen: hoverRequestOpen,
		requestClose: hoverRequestClose,
		syncIfHovered: hoverSyncIfHovered,
	} = useDashboardSidebarHover();
	const rowRef = useRef<HTMLDivElement>(null);
	const hoverEligible = !isPending;
	const hoverPayload = useMemo(
		() => ({ workspace, onEditBranchClick: setRenameBranchTarget }),
		[workspace],
	);

	const handleMouseEnter = useCallback(() => {
		if (!hoverEligible || !rowRef.current) return;
		hoverRequestOpen(id, rowRef.current, hoverPayload);
	}, [hoverEligible, hoverRequestOpen, id, hoverPayload]);
	const handleMouseLeave = useCallback(() => {
		if (!hoverEligible) return;
		hoverRequestClose(id);
	}, [hoverEligible, hoverRequestClose, id]);

	const isHovered = hoverHoveredId === id;
	useEffect(() => {
		if (isHovered && hostType === "local-device") onHoverCardOpen?.();
	}, [isHovered, hostType, onHoverCardOpen]);
	useEffect(() => {
		if (!isHovered) return;
		hoverSyncIfHovered(id, hoverPayload);
	}, [isHovered, hoverSyncIfHovered, id, hoverPayload]);

	if (isCollapsed) {
		const content = (
			// biome-ignore lint/a11y/noStaticElementInteractions: hover handlers drive a non-interactive popover, no new keyboard semantics
			<div
				ref={rowRef}
				onMouseEnter={handleMouseEnter}
				onMouseLeave={handleMouseLeave}
				className="relative flex w-full justify-center"
			>
				{(accentColor || isActive) && (
					<div
						className="absolute inset-y-0 left-0 w-0.5"
						style={{
							backgroundColor: accentColor ?? "var(--color-foreground)",
						}}
					/>
				)}
				<DashboardSidebarCollapsedWorkspaceButton
					hostType={hostType}
					workspaceType={workspace.type}
					hostIsOnline={hostIsOnline}
					isActive={isActive}
					workspaceStatus={workspaceStatus}
					onClick={handleClick}
					isCreatePending={isPending}
					pullRequestState={pullRequest?.state ?? null}
					isNonGit={isNonGit}
					aria-label={isPending ? `Creating workspace: ${name}` : undefined}
				/>
			</div>
		);

		return (
			<>
				<div hidden={isDeleting}>
					{isPending ? (
						content
					) : (
						<DashboardSidebarWorkspaceContextMenu
							projectId={projectId}
							isInSection={isInSection}
							isUnread={isUnread}
							isLocalWorkspace={hostType === "local-device"}
							isNonGit={isNonGit}
							isPinned={isMainWorkspace && hostType === "local-device"}
							onCreateSection={handleCreateSection}
							showDeleteHotkey={isActive}
							onMoveToSection={(targetSectionId) =>
								moveWorkspaceToSection(id, projectId, targetSectionId)
							}
							onOpenInFinder={handleOpenInFinder}
							onCopyPath={handleCopyPath}
							onCopyBranchName={handleCopyBranchName}
							onRename={startRename}
							onDelete={
								isMainWorkspace ? undefined : () => setIsDeleteDialogOpen(true)
							}
							onToggleUnread={handleToggleUnread}
							sectionState={sectionState}
							onSnooze={handleSnooze}
							onUnsnooze={handleUnsnooze}
							onArchive={handleArchive}
							onUnarchive={handleUnarchive}
						>
							{content}
						</DashboardSidebarWorkspaceContextMenu>
					)}
				</div>

				{!isPending && !isMainWorkspace && (
					<DashboardSidebarDeleteDialog
						workspaceId={id}
						workspaceName={name || branch}
						open={isDeleteDialogOpen}
						onOpenChange={setIsDeleteDialogOpen}
						onDeleted={handleDeleted}
					/>
				)}
				{renameBranchTarget && (
					<RenameBranchDialog
						workspaceId={id}
						currentBranchName={renameBranchTarget}
						open={renameBranchTarget !== null}
						onOpenChange={(open) => {
							if (!open) setRenameBranchTarget(null);
						}}
						onAfterRename={handleAfterBranchRename}
					/>
				)}
			</>
		);
	}

	const expandedContent = (
		// biome-ignore lint/a11y/noStaticElementInteractions: hover handlers drive a non-interactive popover, no new keyboard semantics
		<div
			ref={rowRef}
			onMouseEnter={handleMouseEnter}
			onMouseLeave={handleMouseLeave}
		>
			<DashboardSidebarExpandedWorkspaceRow
				workspace={workspace}
				isActive={isActive}
				isRenaming={isRenaming}
				renameValue={renameValue}
				shortcutLabel={shortcutLabel}
				diffStats={isPending ? null : diffStats}
				workspaceStatus={workspaceStatus}
				terminalStatuses={terminalStatuses}
				isInSection={isInSection}
				isNonGit={isNonGit}
				onClick={handleClick}
				onDoubleClick={isPending ? undefined : startRename}
				onRemoveFromSidebarClick={handleRemoveFromSidebar}
				onCloseWorkspaceClick={() => setIsDeleteDialogOpen(true)}
				sectionState={sectionState}
				onRestoreClick={
					sectionState === "snoozed" ? handleUnsnooze : handleUnarchive
				}
				onRenameValueChange={setRenameValue}
				onSubmitRename={submitRename}
				onCancelRename={cancelRename}
			/>
		</div>
	);

	return (
		<>
			<div hidden={isDeleting}>
				{isPending ? (
					expandedContent
				) : (
					<DashboardSidebarWorkspaceContextMenu
						projectId={projectId}
						isInSection={isInSection}
						isUnread={isUnread}
						onCreateSection={handleCreateSection}
						onMoveToSection={(targetSectionId) =>
							moveWorkspaceToSection(id, projectId, targetSectionId)
						}
						isLocalWorkspace={hostType === "local-device"}
						isNonGit={isNonGit}
						isPinned={isMainWorkspace && hostType === "local-device"}
						onOpenInFinder={handleOpenInFinder}
						showDeleteHotkey={isActive}
						onCopyPath={handleCopyPath}
						onCopyBranchName={handleCopyBranchName}
						onRename={startRename}
						onDelete={
							isMainWorkspace ? undefined : () => setIsDeleteDialogOpen(true)
						}
						onToggleUnread={handleToggleUnread}
						sectionState={sectionState}
						onSnooze={handleSnooze}
						onUnsnooze={handleUnsnooze}
						onArchive={handleArchive}
						onUnarchive={handleUnarchive}
					>
						{expandedContent}
					</DashboardSidebarWorkspaceContextMenu>
				)}
			</div>

			{!isPending && !isMainWorkspace && (
				<DashboardSidebarDeleteDialog
					workspaceId={id}
					workspaceName={name || branch}
					open={isDeleteDialogOpen}
					onOpenChange={setIsDeleteDialogOpen}
					onDeleted={handleDeleted}
				/>
			)}
			{renameBranchTarget && (
				<RenameBranchDialog
					workspaceId={id}
					currentBranchName={renameBranchTarget}
					open={renameBranchTarget !== null}
					onOpenChange={(open) => {
						if (!open) setRenameBranchTarget(null);
					}}
					onAfterRename={handleAfterBranchRename}
				/>
			)}
		</>
	);
}
