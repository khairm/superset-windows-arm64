import { Trans } from "@lingui/react/macro";
import { useMatchRoute, useParams } from "@tanstack/react-router";
import { HiOutlineWifi } from "react-icons/hi2";
import { ZoomStable } from "renderer/components/ZoomStable";
import { useIsV2CloudEnabled } from "renderer/hooks/useIsV2CloudEnabled";
import { useOnlineStatus } from "renderer/hooks/useOnlineStatus";
import { useV2UserPreferences } from "renderer/hooks/useV2UserPreferences";
import { useZoomFactor } from "renderer/hooks/useZoomFactor";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useWorkspaceSidebarStore } from "renderer/stores/workspace-sidebar-state";
import { AppMenuButton } from "../AppMenuButton";
import { NavigationControls } from "../NavigationControls";
import { RightSidebarToggle } from "../RightSidebarToggle";
import { SidebarToggle } from "../SidebarToggle";
import { WindowControlsInset } from "../WindowControlsInset";
import { OpenInMenuButton } from "./components/OpenInMenuButton";
import { ResourceConsumption } from "./components/ResourceConsumption";

export function TopBar() {
	const matchRoute = useMatchRoute();
	const { data: platform } = electronTrpc.window.getPlatform.useQuery();
	const { workspaceId } = useParams({ strict: false });
	const isV2WorkspaceRoute =
		matchRoute({ to: "/v2-workspace/$workspaceId", fuzzy: true }) !== false;
	const { data: workspace } = electronTrpc.workspaces.get.useQuery(
		{ id: workspaceId ?? "" },
		{ enabled: !!workspaceId },
	);
	const isOnline = useOnlineStatus();
	const zoomFactor = useZoomFactor();
	const isV2CloudEnabled = useIsV2CloudEnabled();
	const isSidebarCollapsed = useWorkspaceSidebarStore((s) => s.isCollapsed());
	// `RightSidebarToggle` used to read this preference itself; upstream lifted
	// the state out to its callers, and the same preference drives the workspace
	// view's own `sidebarOpen`.
	const { preferences: v2UserPreferences, setRightSidebarOpen } =
		useV2UserPreferences();
	const toggleRightSidebar = () => setRightSidebarOpen((prev) => !prev);
	// Default to Mac layout while loading to avoid overlap with traffic lights
	const isMac = platform === undefined || platform === "darwin";
	// In v2 the expanded sidebar lives outside the TopBar column, so the TopBar
	// starts to the right of it and the sidebar header hosts the traffic-light
	// pad + SidebarToggle. When the sidebar is closed or collapsed (too narrow
	// for the pad), bring the toggle and pad back into the TopBar.
	const sidebarHostsChrome = isV2CloudEnabled && !isSidebarCollapsed;

	// Counter-scale the inset and bar height so both stay a constant physical
	// size under page zoom, keeping the fixed macOS traffic lights aligned.
	const trafficLightInset =
		isMac && !sidebarHostsChrome ? `${80 / zoomFactor}px` : "16px";
	const barStyle = isMac ? { height: `${48 / zoomFactor}px` } : undefined;

	return (
		<div
			// Window-drag regions live on the empty leaf elements (traffic-light
			// spacer + title filler), never on this container: `no-drag` carve-outs
			// under a `drag` ancestor are lost inside zoomed/masked/scrollable
			// wrappers, which makes the whole bar swallow clicks.
			className="gap-2 h-12 w-full flex items-center justify-between relative bg-muted/45 dark:bg-muted/35"
			style={barStyle}
		>
			<div className="flex items-center h-full">
				<div
					className="drag h-full shrink-0"
					style={{ width: trafficLightInset }}
				/>
				{!sidebarHostsChrome && (
					<ZoomStable enabled={isMac} className="flex items-center gap-1.5">
						{!isMac && <AppMenuButton />}
						<SidebarToggle />
						<NavigationControls />
						{!isV2CloudEnabled && <ResourceConsumption surface="v1" />}
					</ZoomStable>
				)}
			</div>

			<div className="drag h-full min-w-0 flex-1" />

			{/* (CLOUD-SEVERANCE-P2) No organization switcher here. It was already
			    v1-only and this fork is pinned to v2, but it is also the last thing
			    that should come back: it lists organizations from the cloud and its
			    only working action would be a log-out that cannot happen. */}
			<div className="flex items-center gap-3 h-full pr-4 shrink-0">
				{/* (FORK-PORTS-OFF) */}
				{!isOnline && (
					<div className="flex items-center gap-1.5 text-xs text-muted-foreground bg-muted px-2 py-1 rounded">
						<HiOutlineWifi className="size-3.5" />
						<span>
							<Trans>Offline</Trans>
						</span>
					</div>
				)}
				{workspace?.worktreePath ? (
					<OpenInMenuButton
						worktreePath={workspace.worktreePath}
						branch={workspace.worktree?.branch}
						projectId={workspace.project?.id}
					/>
				) : null}
				{isV2WorkspaceRoute && (
					<RightSidebarToggle
						isOpen={v2UserPreferences.rightSidebarOpen}
						onToggle={toggleRightSidebar}
					/>
				)}
				{!isMac && <WindowControlsInset />}
			</div>
		</div>
	);
}
