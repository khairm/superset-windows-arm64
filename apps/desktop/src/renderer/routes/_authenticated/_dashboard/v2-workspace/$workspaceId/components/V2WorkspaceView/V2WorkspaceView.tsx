import { Workspace } from "@superset/panes";
import { workspaceTrpc } from "@superset/workspace-client";
import { useMatchRoute } from "@tanstack/react-router";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useQuickOpenStore } from "renderer/commandPalette/ui/QuickOpen/quickOpenStore";
import { ZoomStable } from "renderer/components/ZoomStable";
import { useV2UserPreferences } from "renderer/hooks/useV2UserPreferences";
import { useZoomFactor } from "renderer/hooks/useZoomFactor";
import { useHotkey } from "renderer/hotkeys";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { NavigationControls } from "renderer/routes/_authenticated/_dashboard/components/NavigationControls";
import { SidebarToggle } from "renderer/routes/_authenticated/_dashboard/components/SidebarToggle";
import { CommandPalette } from "renderer/screens/main/components/CommandPalette";
import { ResizablePanel } from "renderer/screens/main/components/ResizablePanel";
import { useLocalChatEnabled } from "renderer/stores/local-chat";
import { getV2NotificationSourcesForTab } from "renderer/stores/v2-notifications";
import {
	COLLAPSED_WORKSPACE_SIDEBAR_WIDTH,
	useWorkspaceSidebarStore,
} from "renderer/stores/workspace-sidebar-state";
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
	tabId?: string;
	terminalId?: string;
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
	tabId,
	terminalId,
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
	const { store, isLayoutReady } = useV2WorkspacePaneLayout();
	// (CLOUD-SEVERANCE-P2) Off by default; see `stores/local-chat`.
	const isLocalChatEnabled = useLocalChatEnabled();
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
		paneLayoutReady: isLayoutReady,
		tabId,
		terminalId,
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
		addChatV3Tab,
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

	const { data: platform } = electronTrpc.window.getPlatform.useQuery();
	// Default to Mac while loading so window controls don't flash in.
	const isMac = platform === undefined || platform === "darwin";
	const zoomFactor = useZoomFactor();
	const matchRoute = useMatchRoute();
	// This view is ALSO mounted off-route by the Kanban collapse-split
	// (V2WorkspaceMount), where the dashboard layout still renders the TopBar —
	// so mirror the layout's own condition instead of assuming the route.
	const onV2WorkspaceRoute = !!matchRoute({
		to: "/v2-workspace/$workspaceId",
		fuzzy: true,
	});
	const isSidebarPanelOpen = useWorkspaceSidebarStore((s) => s.isOpen);
	const isSidebarPanelCollapsed = useWorkspaceSidebarStore((s) =>
		s.isCollapsed(),
	);
	// On the v2 workspace route the layout hides the TopBar whenever the sidebar
	// is open. An EXPANDED sidebar hosts the traffic-light pad and the
	// sidebar/nav controls in its own header; a COLLAPSED rail is too narrow, so
	// the tab bar takes over that chrome — without this the collapsed rail has no
	// SidebarToggle at all and cannot be expanded again.
	const tabBarHostsChrome =
		onV2WorkspaceRoute && isSidebarPanelOpen && isSidebarPanelCollapsed;

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
									// (CLOUD-SEVERANCE-P2) Upstream leaves `onAddChatV3`
									// unpassed, so chat-v3 has no way in even with its flag
									// on. This is the fork's single entry point to the local
									// chat pane, and it appears only once the user switches
									// it on in Experimental settings.
									onAddChatV3={
										isLocalChatEnabled ? addChatV3Tab : undefined
									}
									onAddBrowser={addBrowserTab}
									showPresetsBar={showPresetsBar}
									onToggleShowPresetsBar={setShowPresetsBar}
								/>
							)}
							renderTabBarLeading={
								tabBarHostsChrome
									? () => (
											<div className="flex h-full items-center">
												{isMac && (
													<div
														className="drag h-full shrink-0"
														style={{
															width: `${Math.max(
																80 / zoomFactor -
																	COLLAPSED_WORKSPACE_SIDEBAR_WIDTH,
																0,
															)}px`,
														}}
													/>
												)}
												<ZoomStable
													enabled={isMac}
													className="flex items-center gap-1.5 px-1"
												>
													<SidebarToggle />
													<NavigationControls />
												</ZoomStable>
											</div>
										)
									: undefined
							}
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
