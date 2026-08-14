import {
	type KeyboardEvent,
	type MouseEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useDiffStats } from "renderer/hooks/host-service/useDiffStats";
import { useIsGitRepo } from "renderer/hooks/host-service/useIsGitRepo";
import { useOptimisticCollectionActions } from "renderer/routes/_authenticated/hooks/useOptimisticCollectionActions";
import { useCollections } from "renderer/routes/_authenticated/providers/CollectionsProvider";
import { RenameBranchDialog } from "renderer/screens/main/components/WorkspaceSidebar/WorkspaceListItem/components";
import {
	getHighestPriorityDisplayStatus,
	useV2WorkspaceDisplayStatus,
	useV2WorkspaceTabChips,
} from "renderer/stores/v2-notifications";
import { useWorkspaceAgentsRowEnabled } from "renderer/stores/workspace-agents-row";
import { canMarkWorkspaceCompleted } from "../../../../kanban/utils/completeWorkspaceCard";
import { useDashboardSidebarHover } from "../../providers/DashboardSidebarHoverProvider";
import type { WorkspaceSelectionEvent } from "../../providers/DashboardSidebarSelectionProvider";
import type { DashboardSidebarWorkspace } from "../../types";
import { DashboardSidebarCollapsedWorkspaceButton } from "./components/DashboardSidebarCollapsedWorkspaceButton";
import { DashboardSidebarExpandedWorkspaceRow } from "./components/DashboardSidebarExpandedWorkspaceRow";
import {
	DashboardSidebarWorkspaceBulkContextMenu,
	useWorkspaceRowContextMenu,
} from "./components/DashboardSidebarWorkspaceBulkContextMenu";
import { DashboardSidebarWorkspaceContextMenu } from "./components/DashboardSidebarWorkspaceContextMenu/DashboardSidebarWorkspaceContextMenu";
import { useDashboardSidebarWorkspaceItemActions } from "./hooks/useDashboardSidebarWorkspaceItemActions";

interface DashboardSidebarWorkspaceItemProps {
	workspace: DashboardSidebarWorkspace;
	onHoverCardOpen?: () => void;
	shortcutLabel?: string;
	isCollapsed?: boolean;
	isInSection?: boolean;
	sectionState?: "snoozed" | "archived" | "deleted";
	isSelected?: boolean;
	onSelectionClick?: (event: WorkspaceSelectionEvent) => boolean;
	/**
	 * Set when the row renders inside the top-level Pinned section: shows the
	 * owning project's avatar for cross-project context.
	 */
	/** projectName is null for pinned project-less "session" workspaces. */
	pinnedContext?: { projectName: string | null; projectIconUrl: string | null };
}

export function DashboardSidebarWorkspaceItem({
	workspace,
	onHoverCardOpen,
	shortcutLabel,
	isCollapsed = false,
	isInSection = false,
	sectionState,
	isSelected = false,
	onSelectionClick,
	pinnedContext,
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
	const collections = useCollections();
	const projectIsInSidebar =
		projectId !== null &&
		collections.v2SidebarProjects.get(projectId) !== undefined;
	const canMarkCompleted = canMarkWorkspaceCompleted(
		workspace,
		sectionState,
		projectIsInSidebar,
	);
	// (AY) Display status merges the agent rollup with the shell-running blue
	// fallback (agent wins). Drives the workspace-icon dot.
	const workspaceStatus = useV2WorkspaceDisplayStatus(id);
	// (NON-GIT WORKSPACE) flag the icon once we positively know it is non-git.
	const isNonGit = !useIsGitRepo(id, pendingTransaction?.type !== "insert");
	const tabChips = useV2WorkspaceTabChips(id);
	const workspaceAgentsRowEnabled = useWorkspaceAgentsRowEnabled();
	// (TAB-CHIPS) When the chip experiment is off, preserve the old single name
	// dot by folding every open tab instead of hiding multi-tab status entirely.
	const rowTabCount = workspaceAgentsRowEnabled
		? tabChips.length
		: Math.min(tabChips.length, 1);
	const rowTabStatus = workspaceAgentsRowEnabled
		? (tabChips[0]?.status ?? null)
		: getHighestPriorityDisplayStatus(tabChips.map((tab) => tab.status));
	const {
		cancelRename,
		handleClearStatus,
		handleClick,
		handleCopyPath,
		handleCopyBranchName,
		handleCreateSection,
		handleDelete,
		handleDeletePermanently,
		handleArchive,
		handleMarkCompleted,
		handleOpenInFinder,
		handleRemoveFromSidebar,
		handleRemovePullRequest,
		handleRestore,
		handleSnooze,
		handleTogglePin,
		handleToggleUnread,
		handleUnarchive,
		handleUnsnooze,
		isActive,
		isUnread,
		isRenaming,
		moveWorkspaceToSection,
		renameValue,
		setRenameValue,
		startRename,
		submitRename,
	} = useDashboardSidebarWorkspaceItemActions({
		workspaceId: id,
		projectId,
		workspaceName: name,
		branch,
		isMainWorkspace,
		isPinned: workspace.isPinned,
	});

	// Only the active workspace row shows line counts, so skip the per-item
	// git status query everywhere else. Snoozed/archived rows live in a
	// collapsible section and stay skipped too (A6: avoid a reveal-time RPC
	// storm when a large section is revealed).
	const diffStats = useDiffStats(id, { enabled: isActive && !sectionState });

	const { v2Workspaces: v2WorkspaceActions } = useOptimisticCollectionActions();
	const [renameBranchTarget, setRenameBranchTarget] = useState<string | null>(
		null,
	);
	const handleAfterBranchRename = (newBranchName: string) => {
		v2WorkspaceActions.updateWorkspace(id, { branch: newBranchName });
	};
	const isPending = pendingTransaction?.type === "insert";

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

	const handleMouseEnter = useCallback(
		(event: React.MouseEvent) => {
			if (!hoverEligible || !rowRef.current) return;
			hoverRequestOpen(id, rowRef.current, hoverPayload, {
				x: event.clientX,
				y: event.clientY,
			});
		},
		[hoverEligible, hoverRequestOpen, id, hoverPayload],
	);
	const handleMouseLeave = useCallback(
		(event: React.MouseEvent) => {
			if (!hoverEligible) return;
			hoverRequestClose(id, { x: event.clientX, y: event.clientY });
		},
		[hoverEligible, hoverRequestClose, id],
	);

	const isHovered = hoverHoveredId === id;
	useEffect(() => {
		if (isHovered && hostType === "local-device") onHoverCardOpen?.();
	}, [isHovered, hostType, onHoverCardOpen]);
	useEffect(() => {
		if (!isHovered) return;
		hoverSyncIfHovered(id, hoverPayload);
	}, [isHovered, hoverSyncIfHovered, id, hoverPayload]);

	const handleExpandedClick = useCallback(
		(event: MouseEvent<HTMLElement>) => {
			if (
				onSelectionClick &&
				(event.ctrlKey || event.metaKey || event.shiftKey)
			) {
				event.preventDefault();
				event.stopPropagation();
				return;
			}
			if (onSelectionClick?.(event)) return;
			handleClick();
		},
		[handleClick, onSelectionClick],
	);
	const handleExpandedMouseDown = useCallback(
		(event: MouseEvent<HTMLElement>) => {
			if (!event.ctrlKey && !event.metaKey && !event.shiftKey) return;
			if (
				event.target instanceof Element &&
				event.target.closest("button, input, textarea, [role='menuitem']")
			) {
				return;
			}
			onSelectionClick?.(event);
		},
		[onSelectionClick],
	);
	const { isBulkMenu, onRowContextMenu: handleExpandedContextMenu } =
		useWorkspaceRowContextMenu({
			isSelected,
			canBulkSelect: onSelectionClick != null,
		});
	const handleExpandedKeyboardActivate = useCallback(
		(event: KeyboardEvent<HTMLElement>) => {
			if (onSelectionClick?.(event)) return;
			handleClick();
		},
		[handleClick, onSelectionClick],
	);
	const handleWorkspaceChipsClick = useCallback(
		(event: MouseEvent<HTMLElement>) => {
			if (onSelectionClick?.(event)) return;
			handleClick();
		},
		[handleClick, onSelectionClick],
	);
	if (isCollapsed) {
		const content = (
			// biome-ignore lint/a11y/noStaticElementInteractions: hover handlers drive a non-interactive popover, no new keyboard semantics
			<div
				ref={rowRef}
				onMouseEnter={handleMouseEnter}
				onMouseLeave={handleMouseLeave}
				className="relative flex w-full justify-center"
			>
				{accentColor && (
					<div
						className="absolute inset-y-0 left-0 w-0.5"
						style={{ backgroundColor: accentColor }}
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
				<div>
					{isPending ? (
						content
					) : (
						<DashboardSidebarWorkspaceContextMenu
							workspaceId={id}
							projectId={projectId}
							isInSection={isInSection}
							isUnread={isUnread}
							hasStatus={!!workspaceStatus}
							hasPullRequest={!!pullRequest}
							isLocalWorkspace={hostType === "local-device"}
							isNonGit={isNonGit}
							isLocalMainWorkspace={
								isMainWorkspace && hostType === "local-device"
							}
							isPinned={workspace.isPinned}
							onTogglePin={handleTogglePin}
							onCreateSection={handleCreateSection}
							onMoveToSection={(targetSectionId) =>
								moveWorkspaceToSection(id, projectId, targetSectionId)
							}
							onOpenInFinder={handleOpenInFinder}
							onCopyPath={handleCopyPath}
							onCopyBranchName={handleCopyBranchName}
							onRemoveFromSidebar={handleRemoveFromSidebar}
							onRemovePullRequest={handleRemovePullRequest}
							onRename={isMainWorkspace ? undefined : startRename}
							onDelete={
								isMainWorkspace || sectionState === "deleted"
									? undefined
									: handleDelete
							}
							onRestore={sectionState === "deleted" ? handleRestore : undefined}
							onDeletePermanently={
								sectionState === "deleted" ? handleDeletePermanently : undefined
							}
							onToggleUnread={handleToggleUnread}
							onClearStatus={handleClearStatus}
							sectionState={sectionState}
							onSnooze={handleSnooze}
							onUnsnooze={handleUnsnooze}
							onArchive={handleArchive}
							onUnarchive={handleUnarchive}
							onMarkCompleted={
								canMarkCompleted ? handleMarkCompleted : undefined
							}
						>
							{content}
						</DashboardSidebarWorkspaceContextMenu>
					)}
				</div>

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
				pinnedContext={pinnedContext}
				diffStats={isPending ? null : diffStats}
				workspaceStatus={workspaceStatus}
				tabCount={rowTabCount}
				tabStatus={rowTabStatus}
				isInSection={isInSection}
				isNonGit={isNonGit}
				isBulkSelectable={onSelectionClick != null}
				isSelected={isSelected}
				onClick={handleExpandedClick}
				onMouseDown={handleExpandedMouseDown}
				onContextMenu={handleExpandedContextMenu}
				onKeyboardActivate={handleExpandedKeyboardActivate}
				onWorkspaceChipsClick={handleWorkspaceChipsClick}
				onDetailsStripClick={handleClick}
				onDoubleClick={isPending || isMainWorkspace ? undefined : startRename}
				onRemoveFromSidebarClick={handleRemoveFromSidebar}
				onCloseWorkspaceClick={
					// (RECYCLE-BIN) The expanded-row X is now a SILENT soft-delete for a
					// normal (non-bin) non-main row — it moves the thread to the Recycle
					// Bin instead of opening the destroy dialog. The dialog is reserved
					// for in-bin "Delete permanently" (sectionState === "deleted").
					sectionState === "deleted" ? handleDeletePermanently : handleDelete
				}
				sectionState={sectionState}
				onRestoreClick={
					sectionState === "snoozed"
						? handleUnsnooze
						: sectionState === "deleted"
							? handleRestore
							: handleUnarchive
				}
				onRenameValueChange={setRenameValue}
				onSubmitRename={submitRename}
				onCancelRename={cancelRename}
			/>
		</div>
	);

	return (
		<>
			<div>
				{isPending ? (
					expandedContent
				) : isBulkMenu ? (
					<DashboardSidebarWorkspaceBulkContextMenu>
						{expandedContent}
					</DashboardSidebarWorkspaceBulkContextMenu>
				) : (
					<DashboardSidebarWorkspaceContextMenu
						workspaceId={id}
						projectId={projectId}
						isInSection={isInSection}
						isUnread={isUnread}
						hasStatus={!!workspaceStatus}
						hasPullRequest={!!pullRequest}
						onCreateSection={handleCreateSection}
						onMoveToSection={(targetSectionId) =>
							moveWorkspaceToSection(id, projectId, targetSectionId)
						}
						isLocalWorkspace={hostType === "local-device"}
						isNonGit={isNonGit}
						isLocalMainWorkspace={
							isMainWorkspace && hostType === "local-device"
						}
						isPinned={workspace.isPinned}
						onTogglePin={handleTogglePin}
						onOpenInFinder={handleOpenInFinder}
						onCopyPath={handleCopyPath}
						onCopyBranchName={handleCopyBranchName}
						onRemoveFromSidebar={handleRemoveFromSidebar}
						onRemovePullRequest={handleRemovePullRequest}
						onRename={isMainWorkspace ? undefined : startRename}
						onDelete={
							isMainWorkspace || sectionState === "deleted"
								? undefined
								: handleDelete
						}
						onRestore={sectionState === "deleted" ? handleRestore : undefined}
						onDeletePermanently={
							sectionState === "deleted" ? handleDeletePermanently : undefined
						}
						onToggleUnread={handleToggleUnread}
						onClearStatus={handleClearStatus}
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
