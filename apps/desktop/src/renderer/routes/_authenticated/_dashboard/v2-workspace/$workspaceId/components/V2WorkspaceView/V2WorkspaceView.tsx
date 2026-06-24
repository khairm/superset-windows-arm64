import { Workspace } from "@superset/panes";
import { workspaceTrpc } from "@superset/workspace-client";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useQuickOpenStore } from "renderer/commandPalette/ui/QuickOpen/quickOpenStore";
import { useV2UserPreferences } from "renderer/hooks/useV2UserPreferences";
import { useHotkey } from "renderer/hotkeys";
import { CommandPalette } from "renderer/screens/main/components/CommandPalette";
import { ResizablePanel } from "renderer/screens/main/components/ResizablePanel";
import { getV2NotificationSourcesForTab } from "renderer/stores/v2-notifications";
import { useWorkspace } from "../../../providers/WorkspaceProvider";
import { useBrowserShellInteractionPassthrough } from "../../hooks/useBrowserShellInteractionPassthrough";
import { useClearActivePaneAttention } from "../../hooks/useClearActivePaneAttention";
import { useConsumeAutomationRunLink } from "../../hooks/useConsumeAutomationRunLink";
import { useConsumeOpenUrlRequest } from "../../hooks/useConsumeOpenUrlRequest";
import { useDefaultContextMenuActions } from "../../hooks/useDefaultContextMenuActions";
import { useDefaultPaneActions } from "../../hooks/useDefaultPaneActions";
import { useDirtyTabCloseGuard } from "../../hooks/useDirtyTabCloseGuard";
import { usePaneRegistry } from "../../hooks/usePaneRegistry";
import { renderBrowserTabIcon } from "../../hooks/usePaneRegistry/components/BrowserPane";
import { useV2PresetExecution } from "../../hooks/useV2PresetExecution";
import { useV2TerminalLauncher } from "../../hooks/useV2TerminalLauncher";
import { useV2WorkspacePaneLayout } from "../../hooks/useV2WorkspacePaneLayout";
import { useV2WorkspaceRun } from "../../hooks/useV2WorkspaceRun";
import { useWorkspaceFileNavigation } from "../../hooks/useWorkspaceFileNavigation";
import { useWorkspaceHotkeys } from "../../hooks/useWorkspaceHotkeys";
import { useWorkspacePaneOpeners } from "../../hooks/useWorkspacePaneOpeners";
import { WorkspaceGitStatusProvider } from "../../providers/WorkspaceGitStatusProvider";
import { FileDocumentStoreProvider } from "../../state/fileDocumentStore";
import type { PaneViewerData } from "../../types";
import type { V2WorkspaceUrlOpenTarget } from "../../utils/openUrlInV2Workspace";
import { AddTabMenu } from "../AddTabMenu";
import { BackgroundTerminalsButton } from "../BackgroundTerminalsButton";
import { V2NotificationStatusIndicator } from "../V2NotificationStatusIndicator";
import { V2PresetsBar } from "../V2PresetsBar";
import { V2WorkspaceRunButton } from "../V2WorkspaceRunButton";
import { WorkspaceBranchLabel } from "../WorkspaceBranchLabel";
import { WorkspaceEmptyState } from "../WorkspaceEmptyState";
import { WorkspaceMissingWorktreeState } from "../WorkspaceMissingWorktreeState";
import { WorkspaceSidebar } from "../WorkspaceSidebar";

/**
 * Optional URL/deep-link search params. Passed by the v2-workspace route from
 * `Route.useSearch()`; all `undefined` when mounted outside the route (e.g. the
 * Kanban collapse-split via V2WorkspaceMount), which the consumers no-op on.
 */
export interface WorkspaceSearch {
	terminalId?: string;
	chatSessionId?: string;
	focusRequestId?: string;
	openUrl?: string;
	openUrlTarget?: V2WorkspaceUrlOpenTarget;
	openUrlRequestId?: string;
}

interface V2WorkspaceViewProps extends WorkspaceSearch {
	/**
	 * (KANBAN) Extra control rendered at the trailing end of the tab bar —
	 * the collapse-split injects its "back to Board" button here. Not a URL
	 * search param.
	 */
	tabBarTrailingExtra?: ReactNode;
}

/**
 * The full workspace centre — terminals / changes / files — for whichever
 * workspace is in the surrounding WorkspaceProvider. Extracted from the route
 * page so the Kanban collapse-split can mount the exact same view. Includes the
 * missing-worktree guard (previously in the outer route component).
 */
export function V2WorkspaceView(search: V2WorkspaceViewProps) {
	const { workspace } = useWorkspace();
	const workspaceStatusQuery = workspaceTrpc.workspace.get.useQuery(
		{ id: workspace.id },
		{
			refetchOnWindowFocus: true,
			retry: false,
		},
	);

	// Guard BEFORE mounting the content (so its hooks don't initialize a pane
	// layout against a dead worktree) — matches the original route structure.
	if (workspaceStatusQuery.data?.worktreeExists === false) {
		return (
			<WorkspaceMissingWorktreeState
				workspaceId={workspace.id}
				worktreePath={workspaceStatusQuery.data?.worktreePath}
				onRefresh={() => {
					void workspaceStatusQuery.refetch();
				}}
				isRefreshing={workspaceStatusQuery.isFetching}
			/>
		);
	}

	return <V2WorkspaceCenter {...search} />;
}

function V2WorkspaceCenter({
	terminalId,
	chatSessionId,
	focusRequestId,
	openUrl,
	openUrlTarget,
	openUrlRequestId,
	tabBarTrailingExtra,
}: V2WorkspaceViewProps) {
	const { workspace } = useWorkspace();
	const workspaceId = workspace.id;

	const {
		preferences: v2UserPreferences,
		setRightSidebarOpen,
		setRightSidebarTab,
		setRightSidebarWidth,
		setShowPresetsBar,
	} = useV2UserPreferences();
	const showPresetsBar = v2UserPreferences.showPresetsBar;
	const sidebarOpen = v2UserPreferences.rightSidebarOpen;
	const { store } = useV2WorkspacePaneLayout();
	useClearActivePaneAttention({ store });
	const launcher = useV2TerminalLauncher();
	const {
		matchedPresets,
		newTabPresets,
		executePreset,
		resolvePresetCommands,
	} = useV2PresetExecution({
		store,
		launcher,
	});
	const workspaceRun = useV2WorkspaceRun({
		store,
		launcher,
		matchedPresets,
		resolvePresetCommands,
	});
	useConsumeAutomationRunLink({
		store,
		workspaceId,
		terminalId,
		chatSessionId,
		focusRequestId,
	});
	useConsumeOpenUrlRequest({
		store,
		url: openUrl,
		target: openUrlTarget,
		requestId: openUrlRequestId,
	});

	const {
		openFilePane,
		openFilePaneFromTreeClick,
		revealPath,
		selectedFilePath,
		pendingReveal,
		recentFiles,
		openFilePaths,
	} = useWorkspaceFileNavigation({
		store,
		setRightSidebarOpen,
		setRightSidebarTab,
	});

	const paneRegistry = usePaneRegistry({
		onOpenFile: openFilePane,
		onRevealPath: revealPath,
		launcher,
		store,
	});
	const defaultContextMenuActions = useDefaultContextMenuActions({
		paneRegistry,
		launcher,
	});
	const {
		openDiffPane,
		addTerminalTab,
		addChatTab,
		addBrowserTab,
		openCommentPane,
	} = useWorkspacePaneOpeners({
		store,
		launcher,
		newTabPresets,
		executePreset,
	});

	const quickOpenOpen = useQuickOpenStore(
		(s) => s.open && s.target?.workspaceId === workspaceId,
	);
	const closeQuickOpen = useQuickOpenStore((s) => s.close);
	const openQuickOpenFor = useQuickOpenStore((s) => s.openFor);
	const handleQuickOpen = useCallback(
		() => openQuickOpenFor({ workspaceId }),
		[openQuickOpenFor, workspaceId],
	);
	const handleQuickOpenChange = useCallback(
		(next: boolean) => {
			if (!next) closeQuickOpen();
		},
		[closeQuickOpen],
	);
	const handleQuickOpenSelectFile = useCallback(
		(filePath: string, openInNewTab?: boolean) => {
			setRightSidebarOpen(true);
			setRightSidebarTab("files");
			openFilePane(filePath, openInNewTab);
		},
		[openFilePane, setRightSidebarOpen, setRightSidebarTab],
	);
	const defaultPaneActions = useDefaultPaneActions({ launcher });
	const onBeforeCloseTab = useDirtyTabCloseGuard();

	const sidebarWidth = v2UserPreferences.rightSidebarWidth ?? 340;
	const [isSidebarResizing, setIsSidebarResizing] = useState(false);
	const { onSidebarResizeDragging, onWorkspaceInteractionStateChange } =
		useBrowserShellInteractionPassthrough({ sidebarOpen });
	const handleSidebarResizingChange = useCallback(
		(resizing: boolean) => {
			setIsSidebarResizing(resizing);
			onSidebarResizeDragging(resizing);
		},
		[onSidebarResizeDragging],
	);

	const [sidebarSlotEl, setSidebarSlotEl] = useState<HTMLElement | null>(() =>
		typeof document !== "undefined"
			? document.getElementById("workspace-right-sidebar-slot")
			: null,
	);
	useEffect(() => {
		if (sidebarSlotEl) return;
		setSidebarSlotEl(document.getElementById("workspace-right-sidebar-slot"));
	}, [sidebarSlotEl]);

	useWorkspaceHotkeys({
		store,
		matchedPresets,
		executePreset,
		addTerminalTab,
		paneRegistry,
		launcher,
	});
	useHotkey("QUICK_OPEN", handleQuickOpen);
	useHotkey("RUN_WORKSPACE_COMMAND", () => {
		void workspaceRun.toggleWorkspaceRun();
	});

	const workspaceRunButton = (
		<V2WorkspaceRunButton
			projectId={workspace.projectId}
			definition={workspaceRun.definition}
			isRunning={workspaceRun.isRunning}
			isPending={workspaceRun.isPending}
			canForceStop={workspaceRun.canForceStop}
			onToggle={workspaceRun.toggleWorkspaceRun}
			onForceStop={workspaceRun.forceStopWorkspaceRun}
		/>
	);

	return (
		<FileDocumentStoreProvider>
			<WorkspaceGitStatusProvider
				workspaceId={workspaceId}
				store={store}
				sidebarOpen={sidebarOpen}
			>
				<div className="flex min-h-0 min-w-0 flex-1">
					<div
						className="flex min-h-0 min-w-[320px] flex-1 flex-col overflow-hidden"
						data-workspace-id={workspaceId}
					>
						<Workspace<PaneViewerData>
							key={workspaceId}
							registry={paneRegistry}
							paneActions={defaultPaneActions}
							contextMenuActions={defaultContextMenuActions}
							renderTabIcon={renderBrowserTabIcon}
							renderTabAccessory={(tab) => (
								<V2NotificationStatusIndicator
									sources={getV2NotificationSourcesForTab(tab)}
								/>
							)}
							renderBelowTabBar={() =>
								showPresetsBar ? (
									<V2PresetsBar
										matchedPresets={matchedPresets}
										executePreset={executePreset}
										showPresetsBar={showPresetsBar}
										onToggleShowPresetsBar={setShowPresetsBar}
										trailing={workspaceRunButton}
									/>
								) : (
									<div className="flex h-8 min-w-0 shrink-0 items-center border-b border-border bg-background px-2">
										{workspaceRunButton}
									</div>
								)
							}
							renderAddTabMenu={() => (
								<AddTabMenu
									onAddTerminal={addTerminalTab}
									onAddChat={addChatTab}
									onAddBrowser={addBrowserTab}
									showPresetsBar={showPresetsBar}
									onToggleShowPresetsBar={setShowPresetsBar}
								/>
							)}
							renderTabBarTrailing={() => (
								<>
									<WorkspaceBranchLabel branch={workspace.branch} />
									<BackgroundTerminalsButton
										workspaceId={workspaceId}
										store={store}
									/>
									{tabBarTrailingExtra}
								</>
							)}
							renderEmptyState={() => (
								<WorkspaceEmptyState
									onOpenBrowser={addBrowserTab}
									onOpenChat={addChatTab}
									onOpenQuickOpen={handleQuickOpen}
									onOpenTerminal={addTerminalTab}
								/>
							)}
							onBeforeCloseTab={onBeforeCloseTab}
							onInteractionStateChange={onWorkspaceInteractionStateChange}
							store={store}
						/>
					</div>
				</div>
				{sidebarOpen &&
					sidebarSlotEl &&
					createPortal(
						<ResizablePanel
							width={sidebarWidth}
							onWidthChange={setRightSidebarWidth}
							isResizing={isSidebarResizing}
							onResizingChange={handleSidebarResizingChange}
							minWidth={240}
							maxWidth={640}
							handleSide="left"
							onDoubleClickHandle={() => setRightSidebarWidth(340)}
						>
							<WorkspaceSidebar
								workspaceId={workspaceId}
								onSelectFile={openFilePaneFromTreeClick}
								onSelectDiffFile={openDiffPane}
								onOpenComment={openCommentPane}
								onSearch={handleQuickOpen}
								selectedFilePath={selectedFilePath}
								pendingReveal={pendingReveal}
							/>
						</ResizablePanel>,
						sidebarSlotEl,
					)}
			</WorkspaceGitStatusProvider>
			<CommandPalette
				workspaceId={workspaceId}
				open={quickOpenOpen}
				onOpenChange={handleQuickOpenChange}
				onSelectFile={handleQuickOpenSelectFile}
				variant="v2"
				recentlyViewedFiles={recentFiles}
				openFilePaths={openFilePaths}
			/>
		</FileDocumentStoreProvider>
	);
}
