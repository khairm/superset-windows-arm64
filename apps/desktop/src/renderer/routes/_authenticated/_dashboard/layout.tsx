import { FORK_PORT_SCAN_DISABLED } from "@superset/shared/fork-disabled-features";
import { createFileRoute, Outlet, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { CommandPaletteHost } from "renderer/commandPalette";
import { Redirect } from "renderer/components/Redirect";
import { useIsV2CloudEnabled } from "renderer/hooks/useIsV2CloudEnabled";
import { useHotkey } from "renderer/hotkeys";
import { useActiveRoute } from "renderer/lib/active-route";
import { DEFAULT_SETTINGS_ROUTE } from "renderer/lib/cloud-severed-routes";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { DashboardSidebar } from "renderer/routes/_authenticated/_dashboard/components/DashboardSidebar";
import { DashboardSidebarPortsProvider } from "renderer/routes/_authenticated/_dashboard/components/DashboardSidebar/providers/DashboardSidebarPortsProvider";
import { PortForwardsProvider } from "renderer/routes/_authenticated/_dashboard/components/DashboardSidebar/providers/PortForwardsProvider";
import { KanbanReconciler } from "renderer/routes/_authenticated/_dashboard/components/KanbanReconciler";
import { WorkspaceExitCleanupReconciler } from "renderer/routes/_authenticated/_dashboard/components/WorkspaceExitCleanupReconciler";
import { useDevSeedV2Sidebar } from "renderer/routes/_authenticated/hooks/useDevSeedV2Sidebar";
import { ResizablePanel } from "renderer/screens/main/components/ResizablePanel";
import { WorkspaceSidebar } from "renderer/screens/main/components/WorkspaceSidebar";
import { useSidebarSectionsCollapseStore } from "renderer/stores/sidebar-sections-collapse";
import { syncPersistedStoreAcrossWindows } from "renderer/stores/syncPersistedStoreAcrossWindows";
import { useV2NotificationStore } from "renderer/stores/v2-notifications";
import {
	COLLAPSED_WORKSPACE_SIDEBAR_WIDTH,
	DEFAULT_WORKSPACE_SIDEBAR_WIDTH,
	MAX_WORKSPACE_SIDEBAR_WIDTH,
	useWorkspaceSidebarStore,
} from "renderer/stores/workspace-sidebar-state";
import { ContentBoundary } from "../components/ContentBoundary";
import { AddRepositoryModals } from "./components/AddRepositoryModals";
import { CrossVersionMismatchState } from "./components/CrossVersionMismatchState";
import { DashboardWorkspaceHotkeys } from "./components/DashboardWorkspaceHotkeys";
import { TopBar } from "./components/TopBar";
import {
	selectCurrentWorkspaceId,
	selectOnDashboardViewRoute,
	selectOnNewWorkspaceRoute,
	selectOnV2WorkspaceRoute,
} from "./layout.utils";

export const Route = createFileRoute("/_authenticated/_dashboard")({
	component: DashboardLayout,
});

function DashboardLayout() {
	const navigate = useNavigate();

	const isV2CloudEnabled = useIsV2CloudEnabled();
	useDevSeedV2Sidebar();
	useEffect(() => {
		const stopWorkspaceSidebarSync = syncPersistedStoreAcrossWindows(
			useWorkspaceSidebarStore,
		);
		const stopSectionCollapseSync = syncPersistedStoreAcrossWindows(
			useSidebarSectionsCollapseStore,
		);
		const stopAgentStateSync = syncPersistedStoreAcrossWindows(
			useV2NotificationStore,
		);

		return () => {
			stopWorkspaceSidebarSync();
			stopSectionCollapseSync();
			stopAgentStateSync();
		};
	}, []);
	// Get current workspace from route to pre-select project in new workspace modal
	// (NAV-LOCAL-RENDER) Primitive selects: a v2-to-v2 click changes none of
	// them, so this layout does not render.
	const currentWorkspaceId = useActiveRoute(selectCurrentWorkspaceId);
	const onV1WorkspaceRoute = currentWorkspaceId !== null;
	const onV2WorkspaceRoute = useActiveRoute(selectOnV2WorkspaceRoute);
	const onNewWorkspaceRoute = useActiveRoute(selectOnNewWorkspaceRoute);
	const onDashboardViewRoute = useActiveRoute(selectOnDashboardViewRoute);
	const versionMismatch =
		(isV2CloudEnabled && onV1WorkspaceRoute) ||
		(!isV2CloudEnabled && onV2WorkspaceRoute);

	const { data: currentWorkspace } = electronTrpc.workspaces.get.useQuery(
		{ id: currentWorkspaceId ?? "" },
		{ enabled: !!currentWorkspaceId },
	);

	const {
		isOpen: isWorkspaceSidebarOpen,
		toggleCollapsed: toggleWorkspaceSidebarCollapsed,
		setOpen: setWorkspaceSidebarOpen,
		width: workspaceSidebarWidth,
		setWidth: setWorkspaceSidebarWidth,
		isResizing: isWorkspaceSidebarResizing,
		setIsResizing: setWorkspaceSidebarIsResizing,
		isCollapsed: isWorkspaceSidebarCollapsed,
	} = useWorkspaceSidebarStore();

	// Global hotkeys for dashboard
	useHotkey("OPEN_SETTINGS", () => navigate({ to: DEFAULT_SETTINGS_ROUTE }));
	useHotkey("SHOW_HOTKEYS", () => navigate({ to: "/settings/keyboard" }));
	useHotkey("TOGGLE_WORKSPACE_SIDEBAR", () => {
		if (!isWorkspaceSidebarOpen) {
			setWorkspaceSidebarOpen(true);
		} else {
			toggleWorkspaceSidebarCollapsed();
		}
	});

	// Collapsed rail on the v2 workspace route: the rail's headroom strip
	// continues the pane tab bar, so the panel must not draw its own
	// full-height border — the sidebar's inner border (which stops below the
	// strip) is the only divider.
	const railContinuesTabBar =
		isV2CloudEnabled &&
		onV2WorkspaceRoute &&
		!versionMismatch &&
		isWorkspaceSidebarOpen &&
		isWorkspaceSidebarCollapsed();

	const sidebarPanel = isWorkspaceSidebarOpen && (
		<ResizablePanel
			width={workspaceSidebarWidth}
			onWidthChange={setWorkspaceSidebarWidth}
			isResizing={isWorkspaceSidebarResizing}
			onResizingChange={setWorkspaceSidebarIsResizing}
			minWidth={COLLAPSED_WORKSPACE_SIDEBAR_WIDTH}
			maxWidth={MAX_WORKSPACE_SIDEBAR_WIDTH}
			handleSide="right"
			clampWidth={false}
			className={railContinuesTabBar ? "border-r-0" : undefined}
			onDoubleClickHandle={() =>
				setWorkspaceSidebarWidth(DEFAULT_WORKSPACE_SIDEBAR_WIDTH)
			}
		>
			{isV2CloudEnabled ? (
				<DashboardSidebar isCollapsed={isWorkspaceSidebarCollapsed()} />
			) : (
				<WorkspaceSidebar
					isCollapsed={isWorkspaceSidebarCollapsed()}
					activeProjectId={currentWorkspace?.projectId ?? null}
					activeProjectName={currentWorkspace?.project?.name ?? null}
				/>
			)}
		</ResizablePanel>
	);

	// Only lift the sidebar out of the TopBar column when v2 + expanded.
	// Collapsed/closed sidebars stay inside so the TopBar runs full-width.
	const sidebarOutsideColumn =
		isV2CloudEnabled &&
		isWorkspaceSidebarOpen &&
		!isWorkspaceSidebarCollapsed();

	// On the v2 workspace route with an open sidebar the TopBar row is merged
	// into the pane tab bar (which provides the drag region and hosts the
	// right-sidebar toggle). Expanded sidebars host the traffic-light pad in
	// their header; collapsed rails host it via their headroom spacer plus the
	// tab bar's leading inset. Only a fully closed sidebar keeps the TopBar,
	// whose inset then keeps content clear of the macOS traffic lights. The
	// new-workspace page brings its own drag strip, and the dashboard views
	// (automations/tasks/workspaces) carry drag fillers in their own headers,
	// so they hide the TopBar whenever the expanded sidebar sits outside the
	// column — otherwise it renders as an empty strip above their headers.
	const hideTopBar =
		(onV2WorkspaceRoute &&
			!versionMismatch &&
			isV2CloudEnabled &&
			isWorkspaceSidebarOpen) ||
		((onNewWorkspaceRoute || onDashboardViewRoute) && sidebarOutsideColumn);

	return (
		// (FORK-PORTS-OFF)
		<DashboardSidebarPortsProvider enabled={!FORK_PORT_SCAN_DISABLED}>
			<PortForwardsProvider>
				{/* (FORK-PORTS-OFF) */}
				<div className="flex h-full w-full overflow-hidden">
					<CommandPaletteHost />
					<KanbanReconciler />
					{/* (WORKTREE-EXIT-CLEANUP) Mounted here, not in the workspace route:
					    the thread that owes its host a teardown is by definition not the
					    one on screen. Losing this mount silently strands every pending
					    cleanup, so the marker is load-bearing. */}
					<WorkspaceExitCleanupReconciler />
					{sidebarOutsideColumn && sidebarPanel}
					<div className="flex flex-1 flex-col min-w-0 min-h-0">
						{!hideTopBar && <TopBar />}
						<div className="flex flex-1 min-h-0 min-w-0 overflow-hidden">
							{!sidebarOutsideColumn && sidebarPanel}
							<div className="relative flex flex-1 min-h-0 min-w-0">
								{versionMismatch ? (
									// A v2 user on a stale v1 workspace route has nothing to go
									// back to, so send them somewhere actionable instead of a
									// dead-end "pick a workspace" screen. v1 users keep the
									// static state — /new-workspace is a v2-only surface.
									isV2CloudEnabled ? (
										<Redirect to="/new-workspace" replace />
									) : (
										<CrossVersionMismatchState />
									)
								) : (
									<ContentBoundary>
										<Outlet />
									</ContentBoundary>
								)}
							</div>
						</div>
					</div>
					<div
						id="workspace-right-sidebar-slot"
						className="flex h-full shrink-0"
					/>
					<AddRepositoryModals />
					<DashboardWorkspaceHotkeys
						currentWorkspaceId={currentWorkspaceId}
						currentWorkspace={currentWorkspace}
					/>
				</div>
			</PortForwardsProvider>
		</DashboardSidebarPortsProvider>
	);
}
