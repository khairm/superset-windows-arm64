import type { AppRouter } from "@superset/host-service";
import { toast } from "@superset/ui/sonner";
import { useQueryClient } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import {
	useMatchRoute,
	useNavigate,
	useRouterState,
} from "@tanstack/react-router";
import { useState } from "react";
import { getTerminalAgentBindingsQueryKey } from "renderer/hooks/host-service/useTerminalAgentBindings";
import { useWorkspaceHostUrl } from "renderer/hooks/host-service/useWorkspaceHostUrl";
import { useCopyToClipboard } from "renderer/hooks/useCopyToClipboard";
import { getHostServiceClientByUrl } from "renderer/lib/host-service-client";
import { showHostServiceUnavailableToast } from "renderer/lib/host-service-unavailable";
import { electronTrpcClient } from "renderer/lib/trpc-client";
import { useDashboardSidebarSectionRename } from "renderer/routes/_authenticated/_dashboard/components/DashboardSidebar/components/DashboardSidebarSectionRenameContext";
import { DASHBOARD_SIDEBAR_PULL_REQUEST_QUERY_KEY_PREFIX } from "renderer/routes/_authenticated/_dashboard/components/DashboardSidebar/hooks/useDashboardSidebarData/derivePullRequestQueryTargets";
import { useSidebarWorkspaceStatus } from "renderer/routes/_authenticated/_dashboard/components/DashboardSidebar/providers/DashboardSidebarWorkspaceStatusProvider";
import { useCompleteWorkspaceCard } from "renderer/routes/_authenticated/_dashboard/kanban/hooks/useCompleteWorkspaceCard";
import { markTerminalSeenAndReportRead } from "renderer/routes/_authenticated/components/V2NotificationController/lib/companionAlertSync";
import { useDashboardSidebarState } from "renderer/routes/_authenticated/hooks/useDashboardSidebarState";
import { useOptimisticActions } from "renderer/routes/_authenticated/hooks/useOptimisticActions";
import {
	computeSnoozeUntil,
	type SnoozeDuration,
} from "renderer/routes/_authenticated/providers/CollectionsProvider/dashboardSidebarLocal";
import { useLocalHostService } from "renderer/routes/_authenticated/providers/LocalHostServiceProvider";
import { useDestroyWorkspaceIntent } from "renderer/stores/destroy-workspace-intent";
import { useRemoveFromSidebarIntent } from "renderer/stores/remove-workspace-from-sidebar-intent";
import {
	getV2TerminalNotificationSource,
	useV2NotificationStore,
} from "renderer/stores/v2-notifications";

/**
 * (MANUAL-DISMISS) One terminal's outcome from the host's
 * `terminalAgents.dismissWorkspaceStatuses` mutation.
 *
 * Inferred from the router rather than restated, so a field the host renames or
 * retypes is a compile error here instead of silent drift. Only two fields are
 * read; the rest are the host's own accounting.
 *
 * `lastEventAt` is the binding's value read back AFTER the clear — HOST clock,
 * never this machine's. `null` means the terminal has no live binding at all (a
 * leaked marker swept off something nothing is bound to), which is a success
 * with nothing to mark seen. `pendingAfter` means a NEWER question arrived
 * while the dismiss was in flight.
 */
export type DismissedWorkspaceTerminal =
	inferRouterOutputs<AppRouter>["terminalAgents"]["dismissWorkspaceStatuses"]["terminals"][number];

/**
 * (MANUAL-DISMISS) "Clear Status", the whole sequence, with the two hook-local
 * pieces passed in.
 *
 * Exported and React-free on purpose: the ORDERING below is the entire fix,
 * and it is what the tests drive.
 *
 * THREE SIMILARLY-NAMED FUNCTIONS MEET HERE, and confusing two of them is what
 * made this menu item do nothing for the red and yellow dots:
 *
 *  1. `terminalAgents.clearWorkspaceStatuses` — HOST mutation. Forces the
 *     host bindings to Stop. Still what the interrupt path calls.
 *  2. `terminalAgents.dismissWorkspaceStatuses` — HOST mutation, the one
 *     called below. Forces the bindings AND removes the pending-permission
 *     markers, so a resync cannot re-derive the red from the host's durable
 *     truth a moment later.
 *  3. `useV2NotificationStore.clearWorkspaceStatuses` — RENDERER store action.
 *     The dots are rendered from ITS latched axes, so nothing on screen changes
 *     until this one runs. The old handler called (1) plus a review-only local
 *     clear and never this, so the host went quiet while the red and yellow
 *     dots stayed exactly where they were.
 *
 * Ordering is deliberate:
 *
 *  - the local review clear goes FIRST, so a click with the host DOWN still
 *    clears green and still reports the read, exactly as it did before;
 *  - the axes the host owns are dropped only once the host has confirmed it
 *    dropped them too. A failure leaves red and yellow latched, which is the
 *    honest state: the markers survived, so the next resync would re-assert
 *    anything dropped locally anyway.
 */
export async function runClearWorkspaceStatuses({
	workspaceId,
	workspaceHostUrl,
	clearWorkspaceAttention,
	invalidateBindings,
}: {
	workspaceId: string;
	workspaceHostUrl: string | null | undefined;
	clearWorkspaceAttention: () => void;
	invalidateBindings: () => Promise<unknown>;
}): Promise<void> {
	clearWorkspaceAttention();
	if (!workspaceHostUrl) return;
	try {
		const result = await getHostServiceClientByUrl(
			workspaceHostUrl,
		).terminalAgents.dismissWorkspaceStatuses.mutate({ workspaceId });
		applyWorkspaceStatusDismissal({
			workspaceId,
			terminals: result.terminals,
		});
		await invalidateBindings();
	} catch (error) {
		toast.error(
			`Failed to clear agent status: ${error instanceof Error ? error.message : "Unknown error"}`,
		);
	}
}

/**
 * (MANUAL-DISMISS) Apply a completed host dismiss to the renderer's dots.
 *
 * The store purge is workspace-wide and comes first — it is what actually
 * changes the pixels. The per-terminal seen mark is what makes the clear
 * DURABLE: it moves the seen watermark to the host's `lastEventAt`, so the next
 * resync replays those rows as already-read instead of re-latching them, and it
 * retires the outstanding ready record through the host-ack compare-and-clear
 * rather than by dropping it locally. (The purge deliberately leaves
 * `outstandingReadyAt` standing for exactly that reason — it is the only
 * remaining evidence of which finish the phone is still showing.)
 *
 * A terminal the host reports as `pendingAfter` is NOT marked seen: a newer
 * question outlived the dismiss, and stamping it read would tell the companion
 * the user has dealt with something they have not seen. Nor is one with a null
 * `lastEventAt` — there is no binding behind it to have read.
 *
 * `pendingAfter` ALSO GETS ITS RED PUT BACK, and the purge is why it has to be
 * done here rather than left to the incoming event. The surviving question is
 * not necessarily in the future: it landed between the click and the mutation's
 * reply, so this renderer has very likely ALREADY latched its red from the
 * broadcast, and the workspace-wide purge a line above just wiped it. No
 * further PermissionRequest is coming — that event has been and gone — so
 * without this the blocked agent shows no dot at all until the 60s periodic
 * resync re-derives it from the host. A re-latch for a red that is genuinely
 * still in flight is harmless: it is the same axis at the same host instant the
 * event itself would set.
 *
 * A `pendingAfter` with a null `lastEventAt` is skipped, because the re-latch
 * has no instant to anchor. Every axis timestamp in this store is HOST clock —
 * the resync's occurredAt fence compares latches against host `lastEventAt`
 * directly — and `applySourceAxes` would otherwise default to `Date.now()` on
 * THIS machine, planting a renderer-clock timestamp that the next resync
 * compares against host time. A relay's skew then either freezes the row
 * (renderer clock ahead: every host row reads as older and is skipped) or drops
 * the red on the next pass. Leaving the dot to the periodic resync is the
 * lesser failure, and the combination is close to unreachable anyway: it means
 * a marker with no binding at all behind it.
 */
function applyWorkspaceStatusDismissal({
	workspaceId,
	terminals,
}: {
	workspaceId: string;
	terminals: readonly DismissedWorkspaceTerminal[];
}): void {
	useV2NotificationStore.getState().clearWorkspaceStatuses(workspaceId);
	for (const terminal of terminals) {
		// No binding behind it: the host swept a leaked marker off a terminal
		// nothing is bound to. The purge above already took its dot, and there is
		// neither a read to report nor an instant to re-latch at.
		if (terminal.lastEventAt === null) continue;
		if (terminal.pendingAfter) {
			useV2NotificationStore
				.getState()
				.applySourceAxes(
					getV2TerminalNotificationSource(terminal.terminalId),
					workspaceId,
					{ set: ["permission"], clear: [] },
					terminal.lastEventAt,
				);
			continue;
		}
		markTerminalSeenAndReportRead({
			workspaceId,
			terminalId: terminal.terminalId,
			lastEventAt: terminal.lastEventAt,
		});
	}
}

interface UseDashboardSidebarWorkspaceItemActionsOptions {
	workspaceId: string;
	/** Null for project-less "session" workspaces. */
	projectId: string | null;
	workspaceName: string;
	branch: string;
	isMainWorkspace?: boolean;
	isPinned?: boolean;
}

export function useDashboardSidebarWorkspaceItemActions({
	workspaceId,
	projectId,
	workspaceName,
	branch,
	isMainWorkspace = false,
	isPinned = false,
}: UseDashboardSidebarWorkspaceItemActionsOptions) {
	const navigate = useNavigate();
	const matchRoute = useMatchRoute();
	const hostService = useLocalHostService();
	const { activeHostUrl } = hostService;
	const { copyToClipboard } = useCopyToClipboard();
	const { v2Workspaces: workspaceActions } = useOptimisticActions();
	const { requestSectionRename } = useDashboardSidebarSectionRename();
	const setManualUnread = useV2NotificationStore((s) => s.setManualUnread);
	const clearManualUnread = useV2NotificationStore((s) => s.clearManualUnread);
	const { bindings, isUnread } = useSidebarWorkspaceStatus(workspaceId);
	const workspaceHostUrl = useWorkspaceHostUrl(workspaceId);
	const queryClient = useQueryClient();

	const clearWorkspaceAttention = () => {
		clearManualUnread(workspaceId);
		// (ALERT-CONTEXT-NAMES) THE SECOND USER-INTENT SITE. "Mark read" is the
		// user saying they have dealt with the thread, so the phone's
		// ready-for-review notifications for it come down too — but only for the
		// terminals that actually HAD a green dot, or a retraction goes on the
		// wire per idle terminal per click. The helper owns that rule and the
		// stamp ordering behind it, and it marks the terminal seen itself, so it
		// REPLACES the provider's plain mark rather than following it. Bindings
		// come from the status store, so this costs no extra query per row.
		for (const binding of bindings.values()) {
			markTerminalSeenAndReportRead({
				workspaceId,
				terminalId: binding.terminalId,
				lastEventAt: binding.lastEventAt,
			});
		}
	};
	const completeWorkspaceCard = useCompleteWorkspaceCard();
	const {
		archiveWorkspace,
		createSection,
		deleteWorkspace,
		moveWorkspaceToSection,
		restoreWorkspace,
		setWorkspacePinned,
		snoozeWorkspace,
		unarchiveWorkspace,
		unsnoozeWorkspace,
	} = useDashboardSidebarState();

	const [isRenaming, setIsRenaming] = useState(false);
	const [renameValue, setRenameValue] = useState(workspaceName);
	/**
	 * The submitted name, held until the store catches up.
	 *
	 * Closing the editor is a React state update while the optimistic cache
	 * patch reaches this row through react-query's notifier, which flushes on
	 * a microtask — so the row renders once with the pre-rename prop in
	 * between, and the old name flashes for a frame.
	 */
	const [pendingName, setPendingName] = useState<string | null>(null);
	if (pendingName !== null && pendingName === workspaceName) {
		setPendingName(null);
	}

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
		setPendingName(trimmed);
		workspaceActions.renameWorkspace(workspaceId, trimmed);
	};

	// (RECYCLE-BIN) In-bin "Delete permanently" — the only path into upstream's
	// real git destroy. Requested through the intent store so the dialog is
	// rendered by the globally-mounted DestroyWorkspaceMount instead of under
	// this row: the destroy tombstones the host workspace at step 0, the bin
	// row (a local record with no host record) immediately drops out of
	// rawSidebarWorkspaces, and a row-local dialog would unmount mid-destroy —
	// silently swallowing the teardown-failure pane and its force-retry
	// ("skipTeardown") offer. The mount drops the local sidebar record when the
	// destroy settles.
	const handleDeletePermanently = () => {
		// Mains are archive-only and never enter the bin; the row-local dialog
		// used to be gated the same way (it was simply never mounted for one).
		if (isMainWorkspace) return;
		useDestroyWorkspaceIntent.getState().request({
			workspaceId,
			workspaceName: workspaceName || branch,
		});
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
		// (SNOOZE-MAIN) projectId lets snoozeWorkspace insert a row for an
		// auto-included main that has none yet.
		snoozeWorkspace(workspaceId, computeSnoozeUntil(duration), projectId);
	};

	const handleUnsnooze = () => {
		unsnoozeWorkspace(workspaceId);
	};

	const handleArchive = () => {
		archiveWorkspace(workspaceId);
	};

	const handleMarkCompleted = () => {
		const result = completeWorkspaceCard(workspaceId);
		if (!result.ok) {
			toast.error("Couldn't mark worktree completed", {
				description: result.reason,
			});
		}
	};

	const handleUnarchive = () => {
		unarchiveWorkspace(workspaceId);
	};

	// (RECYCLE-BIN) The default-mode Delete is now a SILENT soft-delete — no
	// dialog, no toast — moving the thread to the project's Recycle Bin. The real
	// git destroy lives behind "Delete permanently" inside the bin (the existing
	// destroy dialog, requested via handleDeletePermanently).
	const handleDelete = () => {
		deleteWorkspace(workspaceId, projectId);
	};

	const handleRestore = () => {
		restoreWorkspace(workspaceId);
	};

	const handleCreateSection = () => {
		// Sessions get groups in the stacked nesting PR.
		if (projectId === null) return;
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
			clearWorkspaceAttention();
		} else {
			setManualUnread(workspaceId);
		}
	};

	const handleTogglePin = () => {
		setWorkspacePinned(workspaceId, projectId, !isPinned);
	};

	// (MANUAL-DISMISS) The escape hatch for a wedged working/permission dot (an
	// interrupted agent fires no Stop hook). The sequence lives in
	// `runClearWorkspaceStatuses` above, which owns the three-similar-names
	// hazard and the ordering that goes with it.
	const handleClearStatus = () =>
		runClearWorkspaceStatuses({
			workspaceId,
			workspaceHostUrl,
			clearWorkspaceAttention,
			invalidateBindings: () =>
				queryClient.invalidateQueries({
					queryKey: getTerminalAgentBindingsQueryKey(workspaceId),
				}),
		});

	const handleRemovePullRequest = async () => {
		if (!workspaceHostUrl) {
			showHostServiceUnavailableToast(hostService, {
				action: "remove the PR link",
			});
			return;
		}
		try {
			await getHostServiceClientByUrl(
				workspaceHostUrl,
			).pullRequests.unlinkFromWorkspace.mutate({ workspaceId });
			await queryClient.invalidateQueries({
				queryKey: DASHBOARD_SIDEBAR_PULL_REQUEST_QUERY_KEY_PREFIX,
			});
		} catch (error) {
			toast.error(
				`Failed to remove PR link: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
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
		isRenaming,
		isUnread,
		moveWorkspaceToSection,
		pendingName,
		renameValue,
		setRenameValue,
		startRename,
		submitRename,
	};
}
