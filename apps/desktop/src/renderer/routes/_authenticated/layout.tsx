import { WorkerPoolContextProvider } from "@pierre/diffs/react";
import { Button } from "@superset/ui/button";
import { Spinner } from "@superset/ui/spinner";
import {
	createFileRoute,
	Outlet,
	useLocation,
	useNavigate,
} from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { DndProvider } from "react-dnd";
import { HiOutlineWifi } from "react-icons/hi2";
import { NewWorkspaceModal } from "renderer/components/NewWorkspaceModal";
import { Redirect } from "renderer/components/Redirect";
import { env } from "renderer/env.renderer";
import { useDelayElapsed } from "renderer/hooks/useDelayElapsed";
import { useIsV2CloudEnabled } from "renderer/hooks/useIsV2CloudEnabled";
import { useOnlineStatus } from "renderer/hooks/useOnlineStatus";
import { useSettingsExternalChangeListener } from "renderer/hooks/useSettingsExternalChangeListener";
import { authClient, getAuthToken } from "renderer/lib/auth-client";
import {
	CLOUD_SEVERED_FALLBACK_ROUTE,
	DEFAULT_SETTINGS_ROUTE,
	isCloudSeveredRoute,
} from "renderer/lib/cloud-severed-routes";
import { dragDropManager } from "renderer/lib/dnd";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { terminalRuntimeRegistry } from "renderer/lib/terminal/terminal-runtime-registry";
import { showWorkspaceAutoNameWarningToast } from "renderer/lib/workspaces/showWorkspaceAutoNameWarningToast";
import { InitGitDialog } from "renderer/react-query/projects/InitGitDialog";
import { DaemonAutoUpdateFailureDialog } from "renderer/routes/_authenticated/components/DaemonAutoUpdateFailureDialog";
import { DashboardNewWorkspaceModal } from "renderer/routes/_authenticated/components/DashboardNewWorkspaceModal";
import { DiffThemeSync } from "renderer/routes/_authenticated/components/DiffThemeSync";
import {
	V1AutoMigration,
	V1MigrationContinuity,
} from "renderer/routes/_authenticated/components/V1AutoMigration";
import {
	V1FlipNotice,
	V2FlipWelcome,
} from "renderer/routes/_authenticated/components/V1FlipNotice";
import { V1ImportModal } from "renderer/routes/_authenticated/components/V1ImportModal";
import { WorkspaceInitEffects } from "renderer/screens/main/components/WorkspaceInitEffects";
import { useSettingsStore } from "renderer/stores/settings-state";
import { useTabsStore } from "renderer/stores/tabs/store";
import { useAgentHookListener } from "renderer/stores/tabs/useAgentHookListener";
import { setPaneWorkspaceRunState } from "renderer/stores/tabs/workspace-run";
import { useWorkspaceInitStore } from "renderer/stores/workspace-init";
import { NOTIFICATION_EVENTS } from "shared/constants";
import { AgentHooks } from "./components/AgentHooks";
import { DockBadgeController } from "./components/DockBadgeController";
import { FileMenuListener } from "./components/FileMenuListener";
import { AutoResumeController } from "./components/AutoResumeController/AutoResumeController";
import { GlobalBrowserLifecycle } from "./components/GlobalBrowserLifecycle";
import { TeardownLogsDialog } from "./components/TeardownLogsDialog";
import { V2NotificationController } from "./components/V2NotificationController";
import { createPierreWorker } from "./lib/pierreWorker";
import { CollectionsProvider } from "./providers/CollectionsProvider";
import { HostWorkspacesProvider } from "./providers/HostWorkspacesProvider";
import { LocalHostServiceProvider } from "./providers/LocalHostServiceProvider";

export const Route = createFileRoute("/_authenticated")({
	component: AuthenticatedLayout,
});

const signInRedirect = <Redirect to="/sign-in" replace />;
const cloudSeveredRedirect = (
	<Redirect to={CLOUD_SEVERED_FALLBACK_ROUTE} replace />
);

const SESSION_PENDING_TIMEOUT_MS = 15_000;

function AuthenticatedLayout() {
	const {
		data: session,
		isPending,
		isRefetching,
		refetch,
	} = authClient.useSession();
	const hasLocalToken = !!getAuthToken();
	const isOnline = useOnlineStatus();
	const navigate = useNavigate();
	const location = useLocation();
	const setOriginRoute = useSettingsStore((s) => s.setOriginRoute);
	const utils = electronTrpc.useUtils();
	const shownWorkspaceInitWarningsRef = useRef(new Set<string>());
	const isV2CloudEnabled = useIsV2CloudEnabled();

	// (CLOUD-SEVERANCE-P2) There is no signed-out state to be in.
	const isSignedIn = true;

	const isAuthPending =
		(isPending || (isRefetching && !session?.user && hasLocalToken)) &&
		!env.SKIP_ENV_VALIDATION;
	const authPendingTimedOut = useDelayElapsed(
		isAuthPending,
		SESSION_PENDING_TIMEOUT_MS,
	);

	useAgentHookListener();
	useSettingsExternalChangeListener();

	// Seed the parked-terminal eviction cap from settings (SUPER-1545).
	const { data: parkedRuntimeCap } =
		electronTrpc.settings.getTerminalParkedRuntimeCap.useQuery();
	useEffect(() => {
		if (parkedRuntimeCap !== undefined) {
			terminalRuntimeRegistry.setParkedRuntimeCap(parkedRuntimeCap);
		}
	}, [parkedRuntimeCap]);

	// Update workspace-run pane state on terminal exit
	electronTrpc.notifications.subscribe.useSubscription(undefined, {
		onData: (event) => {
			if (
				event.type === NOTIFICATION_EVENTS.FOCUS_V2_NOTIFICATION_SOURCE &&
				event.data
			) {
				localStorage.setItem("lastViewedWorkspaceId", event.data.workspaceId);
				const source = event.data.source;
				void navigate({
					to: "/v2-workspace/$workspaceId",
					params: { workspaceId: event.data.workspaceId },
					search:
						source.type === "terminal"
							? {
									terminalId: source.id,
									focusRequestId: crypto.randomUUID(),
								}
							: {
									chatSessionId: source.id,
									focusRequestId: crypto.randomUUID(),
								},
				});
				return;
			}

			if (
				event.type !== NOTIFICATION_EVENTS.TERMINAL_EXIT ||
				!event.data?.paneId
			) {
				return;
			}
			const pane = useTabsStore.getState().panes[event.data.paneId];
			if (pane?.workspaceRun?.state === "running") {
				const nextState =
					event.data.reason === "killed"
						? "stopped-by-user"
						: "stopped-by-exit";
				setPaneWorkspaceRunState(event.data.paneId, nextState);
			}
		},
	});

	useEffect(() => {
		if (!location.pathname.startsWith("/settings")) {
			setOriginRoute(location.pathname);
		}
	}, [location.pathname, setOriginRoute]);

	// Workspace initialization progress subscription
	const updateInitProgress = useWorkspaceInitStore((s) => s.updateProgress);
	electronTrpc.workspaces.onInitProgress.useSubscription(undefined, {
		onData: (progress) => {
			updateInitProgress(progress);
			if (
				progress.warning &&
				!shownWorkspaceInitWarningsRef.current.has(progress.workspaceId)
			) {
				shownWorkspaceInitWarningsRef.current.add(progress.workspaceId);
				showWorkspaceAutoNameWarningToast({
					description: progress.warning,
					onOpenModelAuthSettings: () => {
						void navigate({ to: "/settings/models" });
					},
				});
			}
			if (progress.step === "ready" || progress.step === "failed") {
				// Invalidate both the grouped list AND the specific workspace
				utils.workspaces.getAllGrouped.invalidate();
				utils.workspaces.get.invalidate({ id: progress.workspaceId });
			}
		},
		onError: (error) => {
			console.error("[workspace-init-subscription] Subscription error:", error);
		},
	});

	// Menu navigation subscription
	electronTrpc.menu.subscribe.useSubscription(undefined, {
		onData: (event) => {
			if (event.type === "open-settings") {
				// (CLOUD-SEVERANCE-P2) The bare "Settings…" menu item used to land on
				// the account page, which is now one of the severed routes — it would
				// bounce the user straight back out to their workspace.
				const target = event.data.section
					? `/settings/${event.data.section}`
					: DEFAULT_SETTINGS_ROUTE;
				navigate({ to: target as "/settings/appearance" });
			} else if (event.type === "open-workspace") {
				navigate({ to: `/workspace/${event.data.workspaceId}` });
			}
		},
	});

	// Never redirect while the session is unresolved — a redirect held open
	// across re-renders loops the router until the renderer OOMs (#5729).
	if (isAuthPending) {
		return (
			<div className="relative flex h-screen w-screen flex-col items-center justify-center gap-4 bg-background">
				<div className="drag absolute inset-x-0 top-0 h-12" />
				<Spinner className="size-8" />
				{authPendingTimedOut && (
					<>
						<div className="text-center select-text cursor-text">
							<h2 className="text-lg font-medium">
								Still restoring your session
							</h2>
							<p className="text-sm text-muted-foreground">
								Superset can't confirm your sign-in with the server.
							</p>
						</div>
						{/* (CLOUD-SEVERANCE-P2) Retry is the only way out of here now.
						    The sign-out escape hatch existed to let a user re-authenticate
						    against a server that was refusing them; there is no server and
						    no second identity to return to, so the button could only strand
						    them on a sign-in screen that redirects back here. */}
						<Button variant="outline" size="sm" onClick={() => refetch()}>
							Retry
						</Button>
					</>
				)}
			</div>
		);
	}

	if (!isSignedIn && hasLocalToken && !isOnline) {
		return (
			<div className="relative flex h-screen w-screen flex-col items-center justify-center gap-4 bg-background">
				<div className="drag absolute inset-x-0 top-0 h-12" />
				<HiOutlineWifi className="size-12 text-muted-foreground" />
				<div className="text-center">
					<h2 className="text-lg font-medium">You're offline</h2>
					<p className="text-sm text-muted-foreground">
						Connect to the internet to continue
					</p>
				</div>
				<Button variant="outline" size="sm" onClick={() => refetch()}>
					Retry
				</Button>
			</div>
		);
	}

	if (!isSignedIn) {
		return signInRedirect;
	}

	// (CLOUD-SEVERANCE-P2) Account deletion, organization creation and the
	// onboarding flow were all things the cloud asked this app to show. The
	// local identity is never pending deletion, always has its organization and
	// is always onboarded, so these three gates could only ever fire wrongly —
	// and two of them pointed at routes that no longer render.
	//
	// This is the one place a severed route is stopped. Every entry point to
	// them is gone, but a saved location or a deep link still arrives here, and
	// it arrives as a render (not a route load) so the check lives in the
	// component body where it sees every navigation.
	if (isCloudSeveredRoute(location.pathname)) {
		return cloudSeveredRedirect;
	}

	return (
		<DndProvider manager={dragDropManager}>
			<CollectionsProvider>
				<GlobalBrowserLifecycle />
				<LocalHostServiceProvider>
					<HostWorkspacesProvider>
						<WorkerPoolContextProvider
							poolOptions={{ workerFactory: createPierreWorker, poolSize: 8 }}
							highlighterOptions={{ preferredHighlighter: "shiki-wasm" }}
						>
							<DiffThemeSync />
							<AgentHooks />
							<FileMenuListener />
							<V2NotificationController />
							<AutoResumeController />
							<DockBadgeController />
							<DaemonAutoUpdateFailureDialog />
							<Outlet />
							<V1ImportModal />
							{isV2CloudEnabled ? (
								<>
									<V1MigrationContinuity />
									<V2FlipWelcome />
								</>
							) : (
								<V1FlipNotice />
							)}
							<V1AutoMigration />
							<WorkspaceInitEffects />
							{isV2CloudEnabled ? (
								<DashboardNewWorkspaceModal />
							) : (
								<NewWorkspaceModal />
							)}
							<InitGitDialog />
							<TeardownLogsDialog />
						</WorkerPoolContextProvider>
					</HostWorkspacesProvider>
				</LocalHostServiceProvider>
			</CollectionsProvider>
		</DndProvider>
	);
}
