import { toast } from "@superset/ui/sonner";
import {
	useMatchRoute,
	useNavigate,
	useRouterState,
} from "@tanstack/react-router";
import { useState } from "react";
import { useCopyToClipboard } from "renderer/hooks/useCopyToClipboard";
import { getHostServiceClientByUrl } from "renderer/lib/host-service-client";
import { showHostServiceUnavailableToast } from "renderer/lib/host-service-unavailable";
import { electronTrpcClient } from "renderer/lib/trpc-client";
import { useDashboardSidebarSectionRename } from "renderer/routes/_authenticated/_dashboard/components/DashboardSidebar/components/DashboardSidebarSectionRenameContext";
import { useDashboardSidebarState } from "renderer/routes/_authenticated/hooks/useDashboardSidebarState";
import { useOptimisticCollectionActions } from "renderer/routes/_authenticated/hooks/useOptimisticCollectionActions";
import {
	computeSnoozeUntil,
	type SnoozeDuration,
} from "renderer/routes/_authenticated/providers/CollectionsProvider/dashboardSidebarLocal";
import { useLocalHostService } from "renderer/routes/_authenticated/providers/LocalHostServiceProvider";
import { useRemoveFromSidebarIntent } from "renderer/stores/remove-workspace-from-sidebar-intent";
import {
	useV2NotificationStore,
	useV2WorkspaceIsUnread,
} from "renderer/stores/v2-notifications";

interface UseDashboardSidebarWorkspaceItemActionsOptions {
	workspaceId: string;
	projectId: string;
	workspaceName: string;
	branch: string;
	isMainWorkspace?: boolean;
}

export function useDashboardSidebarWorkspaceItemActions({
	workspaceId,
	projectId,
	workspaceName,
	branch,
	isMainWorkspace = false,
}: UseDashboardSidebarWorkspaceItemActionsOptions) {
	const navigate = useNavigate();
	const matchRoute = useMatchRoute();
	const hostService = useLocalHostService();
	const { activeHostUrl } = hostService;
	const { copyToClipboard } = useCopyToClipboard();
	const { v2Workspaces: workspaceActions } = useOptimisticCollectionActions();
	const { requestSectionRename } = useDashboardSidebarSectionRename();
	const clearWorkspaceAttention = useV2NotificationStore(
		(s) => s.clearWorkspaceAttention,
	);
	const setManualUnread = useV2NotificationStore((s) => s.setManualUnread);
	const isUnread = useV2WorkspaceIsUnread(workspaceId);
	const {
		archiveWorkspace,
		createSection,
		deleteWorkspace,
		moveWorkspaceToSection,
		removeWorkspaceFromSidebar,
		restoreWorkspace,
		snoozeWorkspace,
		unarchiveWorkspace,
		unsnoozeWorkspace,
	} = useDashboardSidebarState();

	const [isRenaming, setIsRenaming] = useState(false);
	const [renameValue, setRenameValue] = useState(workspaceName);
	const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);

	// (KANBAN) When the kanban view is showing, sidebar selection opens the
	// workspace INSIDE the collapse-split (board rail stays) instead of
	// navigating away from the board.
	const onKanban = !!matchRoute({ to: "/kanban", fuzzy: true });
	const kanbanOpenWorkspaceId = useRouterState({
		select: (s) => (s.location.search as { cardId?: string }).cardId,
	});

	const isActive =
		!!matchRoute({
			to: "/v2-workspace/$workspaceId",
			params: { workspaceId },
			fuzzy: true,
		}) ||
		(onKanban && kanbanOpenWorkspaceId === workspaceId);

	const handleClick = () => {
		if (isRenaming) return;
		// Per-tab mark-as-read: workspace click navigates only. The
		// downstream useClearActivePaneAttention hook clears just the
		// active terminal's source on focus, so unfocused terminals keep
		// their unread dot until the user actually visits them — matching
		// the per-terminal-dots indicator we render in the sidebar row.
		if (onKanban) {
			navigate({ to: "/kanban", search: { cardId: workspaceId } });
			return;
		}
		navigate({
			to: "/v2-workspace/$workspaceId",
			params: { workspaceId },
		});
	};

	const startRename = () => {
		setRenameValue(workspaceName);
		setIsRenaming(true);
	};

	const cancelRename = () => {
		setIsRenaming(false);
		setRenameValue(workspaceName);
	};

	const submitRename = () => {
		setIsRenaming(false);
		const trimmed = renameValue.trim();
		if (!trimmed || trimmed === workspaceName) return;
		workspaceActions.renameWorkspace(workspaceId, trimmed);
	};

	const handleDeleted = () => {
		removeWorkspaceFromSidebar(workspaceId);
	};

	const handleRemoveFromSidebar = () => {
		useRemoveFromSidebarIntent.getState().request({
			workspaceId,
			workspaceName,
			projectId,
			isMain: isMainWorkspace,
		});
	};

	const handleSnooze = (duration: SnoozeDuration) => {
		snoozeWorkspace(workspaceId, computeSnoozeUntil(duration));
	};

	const handleUnsnooze = () => {
		unsnoozeWorkspace(workspaceId);
	};

	const handleArchive = () => {
		archiveWorkspace(workspaceId);
	};

	const handleUnarchive = () => {
		unarchiveWorkspace(workspaceId);
	};

	// (RECYCLE-BIN) The default-mode Delete is now a SILENT soft-delete — no
	// dialog, no toast — moving the thread to the project's Recycle Bin. The real
	// git destroy lives behind "Delete permanently" inside the bin (the existing
	// destroy dialog, opened via setIsDeleteDialogOpen).
	const handleDelete = () => {
		deleteWorkspace(workspaceId, projectId);
	};

	const handleRestore = () => {
		restoreWorkspace(workspaceId);
	};

	const handleCreateSection = () => {
		const sectionId = createSection(projectId);
		moveWorkspaceToSection(workspaceId, projectId, sectionId);
		requestSectionRename(sectionId);
	};

	const resolveWorktreePath = async (): Promise<string | null> => {
		if (!activeHostUrl) {
			showHostServiceUnavailableToast(hostService, {
				action: "resolve the workspace path",
			});
			return null;
		}
		const workspace = await getHostServiceClientByUrl(
			activeHostUrl,
		).workspace.get.query({ id: workspaceId });
		if (!workspace?.worktreePath) {
			toast.error("Workspace path is not available");
			return null;
		}
		return workspace.worktreePath;
	};

	const handleOpenInFinder = async () => {
		try {
			const path = await resolveWorktreePath();
			if (!path) return;
			await electronTrpcClient.external.openInFinder.mutate(path);
		} catch (error) {
			toast.error(
				`Failed to open in Finder: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
		}
	};

	const handleCopyPath = async () => {
		try {
			const path = await resolveWorktreePath();
			if (!path) return;
			await copyToClipboard(path);
			toast.success("Path copied");
		} catch (error) {
			toast.error(
				`Failed to copy path: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
		}
	};

	const handleToggleUnread = () => {
		if (isUnread) {
			clearWorkspaceAttention(workspaceId);
		} else {
			setManualUnread(workspaceId);
		}
	};

	const handleCopyBranchName = async () => {
		if (!branch) {
			toast.error("Branch name is not available");
			return;
		}
		try {
			await copyToClipboard(branch);
			toast.success("Branch name copied");
		} catch (error) {
			toast.error(
				`Failed to copy branch name: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
		}
	};

	return {
		cancelRename,
		handleClick,
		handleCopyPath,
		handleCopyBranchName,
		handleCreateSection,
		handleDelete,
		handleDeleted,
		handleArchive,
		handleOpenInFinder,
		handleRemoveFromSidebar,
		handleRestore,
		handleSnooze,
		handleToggleUnread,
		handleUnarchive,
		handleUnsnooze,
		isActive,
		isDeleteDialogOpen,
		isRenaming,
		isUnread,
		moveWorkspaceToSection,
		renameValue,
		setIsDeleteDialogOpen,
		setRenameValue,
		startRename,
		submitRename,
	};
}
