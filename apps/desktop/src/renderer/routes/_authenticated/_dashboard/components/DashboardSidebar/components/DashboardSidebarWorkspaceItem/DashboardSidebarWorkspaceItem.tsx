import { useLingui } from "@lingui/react/macro";
import { errorMessage } from "@superset/i18n/errors";
import { toast } from "@superset/ui/sonner";
import {
	type KeyboardEvent,
	type MouseEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useIsGitRepo } from "renderer/hooks/host-service/useIsGitRepo";
import { cloudTrpc } from "renderer/lib/cloud-trpc";
import { useOptimisticActions } from "renderer/routes/_authenticated/hooks/useOptimisticActions";
import { useCollections } from "renderer/routes/_authenticated/providers/CollectionsProvider";
import { RenameBranchDialog } from "renderer/screens/main/components/WorkspaceSidebar/WorkspaceListItem/components";
import {
	getHighestPriorityDisplayStatus,
	useV2WorkspaceDisplayStatus,
	useV2WorkspaceTabChips,
} from "renderer/stores/v2-notifications";
import { useWorkspaceAgentsRowEnabled } from "renderer/stores/workspace-agents-row";
import { canMarkWorkspaceCompleted } from "../../../../kanban/utils/completeWorkspaceCard";
import {
	useDashboardSidebarHoverActions,
	useDashboardSidebarIsHovered,
} from "../../providers/DashboardSidebarHoverProvider";
import type { WorkspaceSelectionEvent } from "../../providers/DashboardSidebarSelectionProvider";
import { useSidebarWorkspaceStatus } from "../../providers/DashboardSidebarWorkspaceStatusProvider";
import type {
	DashboardSidebarWorkspace,
	DashboardSidebarWorkspaceIndentation,
} from "../../types";
import { ClaudeAccountIndicator } from "./components/ClaudeAccountIndicator";
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
	onHoverCardOpen?: (workspaceId: string) => void | Promise<void>;
	shortcutLabel?: string;
	isCollapsed?: boolean;
	isInSection?: boolean;
	sectionState?: "snoozed" | "archived" | "deleted";
	indentation?: DashboardSidebarWorkspaceIndentation;
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
	indentation,
	isSelected = false,
	onSelectionClick,
	pinnedContext,
}: DashboardSidebarWorkspaceItemProps) {
	const { t } = useLingui();
	// TODO(SUPER-2116): belongs in the create-environment flow; this offers
	// itself on workspaces that are not "ready" and cannot be promoted.
	const promoteToEnvironment = cloudTrpc.environment.promote.useMutation();

	const handlePromoteToEnvironment = useCallback(() => {
		toast.promise(
			promoteToEnvironment.mutateAsync({
				cloudWorkspaceId: workspace.id,
				name: workspace.name,
			}),
			{
				loading: t({
					message: "Saving as an environment...",
				}),
				success: (created) =>
					t({
						message: `Saved "${created?.name}" as an environment`,
					}),
				error: (error) => errorMessage(error),
			},
		);
	}, [promoteToEnvironment, workspace.id, workspace.name, t]);

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
	const isSessionWorkspace = workspace.type === "session";
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
	// fallback (agent wins). Drives the workspace-icon dot, and stays the fork's
	// own rollup rather than the shared store's terminal-only `status`.
	const workspaceStatus = useV2WorkspaceDisplayStatus(id);
	// Line counts come from the sidebar's shared status store, which upstream
	// moved off the per-row git query (it is populated for the active row only).
	const { diffStats } = useSidebarWorkspaceStatus(id);
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
		pendingName,
		handleClearStatus,
		handleClick,
		handleCopyPath,
		handleCopyBranchName,
		handleCopyWorkspaceId,
		handleCreateSection,
		handleDelete,
		handleDeletePermanently,
		handleArchive,
		handleMarkCompleted,
		handleMoveToSection,
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
		renameValue,
		setRenameValue,
		startRename,
		submitRename,
	} = useDashboardSidebarWorkspaceItemActions({
		workspaceId: id,
		projectId,
		isSessionWorkspace,
		workspaceName: name,
		branch,
		pullRequestUrl: pullRequest?.url ?? null,
		isCloudWorkspace: hostType === "cloud",
		isMainWorkspace,
		isPinned: workspace.isPinned,
	});

	// Renders the submitted name until the store reports it, so the row never
	// falls back to the pre-rename value for a frame.
	const displayWorkspace = useMemo(
		() =>
			pendingName === null ? workspace : { ...workspace, name: pendingName },
		[pendingName, workspace],
	);

	const { v2Workspaces: v2WorkspaceActions } = useOptimisticActions();
	const [renameBranchTarget, setRenameBranchTarget] = useState<string | null>(
		null,
	);
	const handleAfterBranchRename = (newBranchName: string) => {
		v2WorkspaceActions.updateWorkspace(id, { branch: newBranchName });
	};
	const isPending = pendingTransaction?.type === "insert";

	const {
		requestOpen: hoverRequestOpen,
		requestClose: hoverRequestClose,
		syncIfHovered: hoverSyncIfHovered,
	} = useDashboardSidebarHoverActions();
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

	const isHovered = useDashboardSidebarIsHovered(id);
	useEffect(() => {
		// Fires on the committed hover only (hoveredId set after OPEN_DELAY or an
		// open-card switch), never on transient row mouseenter.
		if (isHovered && hostType === "local-device") void onHoverCardOpen?.(id);
	}, [isHovered, hostType, onHoverCardOpen, id]);
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
					aria-label={
						isPending
							? workspace.type === "session"
								? t({
										message: `Creating session: ${name}`,
									})
								: t({
										message: `Creating workspace: ${name}`,
									})
							: undefined
					}
				/>
				{!isPending && hostType === "local-device" && (
					<ClaudeAccountIndicator workspaceId={id} collapsed />
				)}
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
							isSessionWorkspace={isSessionWorkspace}
							isInSection={isInSection}
							isUnread={isUnread}
							hasStatus={!!workspaceStatus}
							hasPullRequest={!!pullRequest}
							isLocalWorkspace={hostType === "local-device"}
							isNonGit={isNonGit}
							isLocalMainWorkspace={
								isMainWorkspace && hostType === "local-device"
							}
							onPromoteToEnvironment={
								hostType === "cloud" ? handlePromoteToEnvironment : undefined
							}
							isPinned={workspace.isPinned}
							onTogglePin={handleTogglePin}
							onCreateSection={handleCreateSection}
							showDeleteHotkey={isActive}
							onMoveToSection={handleMoveToSection}
							onOpenInFinder={handleOpenInFinder}
							onCopyPath={handleCopyPath}
							onCopyBranchName={handleCopyBranchName}
							onCopyWorkspaceId={handleCopyWorkspaceId}
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
				workspace={displayWorkspace}
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
				indentation={indentation}
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
						isSessionWorkspace={isSessionWorkspace}
						isInSection={isInSection}
						isUnread={isUnread}
						hasStatus={!!workspaceStatus}
						hasPullRequest={!!pullRequest}
						onCreateSection={handleCreateSection}
						onMoveToSection={handleMoveToSection}
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
						onCopyWorkspaceId={handleCopyWorkspaceId}
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
