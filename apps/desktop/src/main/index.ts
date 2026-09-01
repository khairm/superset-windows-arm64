import path from "node:path";
import log from "electron-log/main";
import { installWindowsChildProcessPatch } from "./lib/windows-child-process-patch";

installWindowsChildProcessPatch();

import { pathToFileURL } from "node:url";
import {
	setAgentSetupTemplatesDir,
	setupAgentIntegrations,
	writeSharedDisabledAgentIds,
} from "@superset/agent-setup";
import { i18n, initI18nAsync } from "@superset/i18n";
import { settings } from "@superset/local-db";
import { getHostId, getHostName } from "@superset/shared/host-info";
import {
	applyWindowsUserEnvToProcess,
	WIN_USER_ENV_MERGED_BY_PARENT,
} from "@superset/shared/windows-user-env";
import { app, dialog, Notification, net, protocol, session } from "electron";
import { makeAppSetup } from "lib/electron-app/factories/app/setup";
import { loadToken } from "lib/trpc/routers/auth/utils/auth-functions";
import { applyShellEnvToProcess } from "lib/trpc/routers/workspaces/utils/shell-env";
import { env as mainEnv } from "main/env.main";
import {
	DEFAULT_CONFIRM_ON_QUIT,
	PLATFORM,
	PROTOCOL_SCHEME,
} from "shared/constants";
import { LOCAL_AUTH_TOKEN_PLACEHOLDER } from "shared/local-identity";
import { initAppState } from "./lib/app-state";
import { requestAppleEventsAccess } from "./lib/apple-events-permission";
import { isUpdateReadyToInstall, setupAutoUpdater } from "./lib/auto-updater";
import { startBrowserBridge } from "./lib/browser/browser-bridge";
import { downloadManager } from "./lib/browser/download-manager";
import { installBundledCliShim } from "./lib/bundled-cli";
import { resolveDevWorkspaceName } from "./lib/dev-workspace-name";
import { setWorkspaceDockIcon } from "./lib/dock-icon";
import { installEgressFence } from "./lib/egress-fence";
import { loadWebviewBrowserExtension } from "./lib/extensions";
import { getHostServiceCoordinator } from "./lib/host-service-coordinator";
import { resolveAppLocale } from "./lib/language";
import { localDb } from "./lib/local-db";
import { resolveLocalOrgId } from "./lib/local-identity/local-org";
import { requestLocalNetworkAccess } from "./lib/local-network-permission";
import { menuEmitter } from "./lib/menu-events";
import { PAGE_SCHEME, pageProtocolHandler } from "./lib/pageContent";
import {
	THUMBNAIL_SCHEME,
	thumbnailProtocolHandler,
} from "./lib/pageThumbnails";
import {
	initTanstackDbPersistence,
	shutdownTanstackDbPersistence,
} from "./lib/persistence/persistence";
import { syncInstalledPluginMcpServers } from "./lib/plugin-installs";
import { portForwardManager } from "./lib/port-forward";
import { ensureProjectIconsDir, getProjectIconPath } from "./lib/project-icons";
import { runQuitCleanup } from "./lib/quit-sequence";
import { initSentry } from "./lib/sentry";
import {
	prewarmTerminalRuntime,
	reconcileDaemonSessions,
} from "./lib/terminal";
import {
	disposeTerminalHostClient,
	getTerminalHostClient,
} from "./lib/terminal-host/client";
import { disposeTray, initTray } from "./lib/tray";
import { getFocusedOrLastWindow } from "./lib/window-registry/window-registry";
import { startNetworkLogger, stopNetworkLogger } from "./network-logger";
import { isNetworkLoggingEnabled } from "./network-logger/policy";
import { sweepNetworkLogs } from "./network-logger-sweep";
import {
	createPlatformWindow,
	initAppServices,
	markAppQuitting,
	persistOpenWindows,
	restoreWindows,
} from "./windows/main";

console.log("[main] Local database ready:", !!localDb);
const IS_DEV = process.env.NODE_ENV === "development";

void applyShellEnvToProcess().catch((error) => {
	console.error("[main] Failed to apply shell environment:", error);
});

// Dev mode: label the app with the workspace name so multiple worktrees are distinguishable
if (IS_DEV) {
	const workspaceName = resolveDevWorkspaceName();
	if (workspaceName) {
		app.setName(`Superset (${workspaceName})`);
	}
}

// Dev mode: register with execPath + app script so macOS launches Electron with our entry point
if (process.defaultApp) {
	if (process.argv.length >= 2) {
		app.setAsDefaultProtocolClient(PROTOCOL_SCHEME, process.execPath, [
			path.resolve(process.argv[1]),
		]);
	}
} else {
	app.setAsDefaultProtocolClient(PROTOCOL_SCHEME);
}

async function processDeepLink(url: string): Promise<void> {
	// (CLOUD-SEVERANCE-P2) The auth branch is gone. `superset://auth-callback`
	// links carried a session token from a browser into this process; with no
	// cloud to issue one, the only thing honouring them could still do is let
	// an arbitrary link rewrite the identity the host-service runs under.
	// Unrecognised links fall through to navigation, which is inert.

	console.log("[main] Processing deep link:", url);

	// Non-auth deep links: extract path and navigate in renderer
	// e.g. superset://tasks/my-slug -> /tasks/my-slug
	const path = `/${url.split("://")[1]}`;
	focusMainWindow();

	const target = getFocusedOrLastWindow();
	target?.webContents.send("deep-link-navigate", path);
}

function findDeepLinkInArgv(argv: string[]): string | undefined {
	return argv.find((arg) => arg.startsWith(`${PROTOCOL_SCHEME}://`));
}

export function focusMainWindow(): void {
	const target = getFocusedOrLastWindow();
	if (target) {
		if (target.isMinimized()) {
			target.restore();
		}
		target.show();
		// Windows holds a foreground lock: show()/focus() alone leave the window
		// buried in z-order when another app owns the foreground, so relaunching
		// Superset (which routes here via the second-instance handler) looks like
		// it did nothing. A brief always-on-top pin is exempt from the lock and
		// forces the window to the top; release it on the next tick so it isn't
		// left permanently pinned above other apps. No-op cost on macOS/Linux.
		if (process.platform === "win32") {
			target.setAlwaysOnTop(true);
			target.focus();
			setTimeout(() => {
				if (!target.isDestroyed()) target.setAlwaysOnTop(false);
			}, 250);
		} else {
			target.focus();
		}
	} else {
		// Triggers window creation via makeAppSetup's activate handler
		app.emit("activate");
	}
}

function registerWithMacOSNotificationCenter() {
	if (!PLATFORM.IS_MAC || !Notification.isSupported()) return;

	const registrationNotification = new Notification({
		title: app.name,
		body: " ",
		silent: true,
	});

	let handled = false;
	const cleanup = () => {
		if (handled) return;
		handled = true;
		registrationNotification.close();
	};

	registrationNotification.on("show", () => {
		cleanup();
		console.log("[notifications] Registered with Notification Center");
	});

	// Fallback timeout in case macOS doesn't fire events
	setTimeout(cleanup, 1000);

	registrationNotification.show();
}

// macOS open-url can fire before the window exists (cold-start via protocol link).
// Queue the URL and process it after initialization.
let pendingDeepLinkUrl: string | null = null;
let appReady = false;

app.on("open-url", async (event, url) => {
	event.preventDefault();
	if (appReady) {
		await processDeepLink(url);
	} else {
		pendingDeepLinkUrl = url;
	}
});

let isQuitting = false;
let skipQuitConfirmation = false;
let forceFullCleanup = false;

export function setSkipQuitConfirmation(): void {
	skipQuitConfirmation = true;
}

export function quitApp(): void {
	setSkipQuitConfirmation();
	app.quit();
}

/** Quit + also stop background services. Tray "Quit Completely". */
export function quitAppCompletely(): void {
	forceFullCleanup = true;
	setSkipQuitConfirmation();
	app.quit();
}

/** Bypasses before-quit. Host-service children self-exit via the parent watchdog. */
export function exitImmediately(): void {
	app.exit(0);
}

function getLanguageSetting(): string | null {
	try {
		const row = localDb.select().from(settings).get();
		return row?.language ?? null;
	} catch {
		return null;
	}
}

function getConfirmOnQuitSetting(): boolean {
	try {
		const row = localDb.select().from(settings).get();
		return row?.confirmOnQuit ?? DEFAULT_CONFIRM_ON_QUIT;
	} catch {
		return DEFAULT_CONFIRM_ON_QUIT;
	}
}

app.on("before-quit", async (event) => {
	if (isQuitting) return;

	const isDev = process.env.NODE_ENV === "development";
	if (
		!PLATFORM.IS_WINDOWS &&
		!skipQuitConfirmation &&
		!isDev &&
		getConfirmOnQuitSetting()
	) {
		event.preventDefault();

		try {
			const { response } = await dialog.showMessageBox({
				type: "question",
				buttons: [
					i18n._({ id: "main.quit.confirm", message: "Quit" }),
					i18n._({ id: "main.dialog.cancel", message: "Cancel" }),
				],
				defaultId: 0,
				cancelId: 1,
				title: i18n._({ id: "main.quit.title", message: "Quit Superset" }),
				message: i18n._({
					id: "main.quit.message",
					message: "Are you sure you want to quit?",
				}),
			});

			if (response === 1) {
				return;
			}
		} catch (error) {
			console.error("[main] Quit confirmation dialog failed:", error);
		}
	}

	isQuitting = true;
	// (NETLOG-OFF) Flush the opt-in netlog before the rest of the shutdown; a
	// no-op on every run that never started it, which is the default.
	await stopNetworkLogger();
	// Local port-forward listeners hold no state worth draining; drop them so
	// nothing keeps 127.0.0.1:<port> bound after the app is gone.
	portForwardManager.stopAll();
	// Snapshot all open windows (bounds + org) before they close, so relaunch
	// restores them. markAppQuitting() stops per-window close handlers from
	// shrinking the set as windows close one-by-one.
	markAppQuitting();
	persistOpenWindows();
	await runQuitCleanup({
		isDev,
		forceFullCleanup,
		isUpdateInstalling: isUpdateReadyToInstall(),
		stopHostServices: () => getHostServiceCoordinator().stopAll(),
		teardownTerminalHost,
		disposeTerminalHostClient,
		shutdownPersistence: shutdownTanstackDbPersistence,
		disposeTray,
		forceExit: (code) => app.exit(code),
	});
});

/**
 * Fully stop the v1 terminal-host process. Do not call this for update
 * installs: terminal-host owns the PTY subprocesses, so shutdown is
 * destructive and prevents reattach on next launch.
 */
async function teardownTerminalHost(): Promise<void> {
	try {
		await getTerminalHostClient().shutdownIfRunning({ killSessions: true });
	} catch (err) {
		console.warn("[main] terminal-host dev shutdown failed:", err);
	}
	disposeTerminalHostClient();
}

process.on("uncaughtException", (error) => {
	if (isQuitting) return;
	console.error("[main] Uncaught exception:", error);
});

process.on("unhandledRejection", (reason) => {
	if (isQuitting) return;
	console.error("[main] Unhandled rejection:", reason);
});

// Without these handlers, Electron may not quit when electron-vite sends SIGTERM
if (process.env.NODE_ENV === "development") {
	let signalHandled = false;
	const handleTerminationSignal = (signal: string) => {
		if (signalHandled) return;
		signalHandled = true;
		console.log(`[main] Received ${signal}, quitting...`);
		getHostServiceCoordinator().stopAll();
		void Promise.allSettled([teardownTerminalHost()]).finally(() =>
			app.exit(0),
		);
	};

	process.on("SIGTERM", () => handleTerminationSignal("SIGTERM"));
	process.on("SIGINT", () => handleTerminationSignal("SIGINT"));

	// Fallback: electron-vite may exit without signaling the child Electron process
	const parentPid = process.ppid;
	const isParentAlive = (): boolean => {
		try {
			process.kill(parentPid, 0);
			return true;
		} catch {
			return false;
		}
	};

	const parentCheckInterval = setInterval(() => {
		if (!isParentAlive()) {
			console.log("[main] Parent process exited, quitting...");
			clearInterval(parentCheckInterval);
			handleTerminationSignal("parent-exit");
		}
	}, 1000);
	parentCheckInterval.unref();
}

protocol.registerSchemesAsPrivileged([
	{
		scheme: "superset-icon",
		privileges: {
			standard: true,
			secure: true,
			bypassCSP: true,
			supportFetchAPI: true,
		},
	},
	{
		scheme: "superset-font",
		privileges: {
			standard: true,
			secure: true,
			bypassCSP: true,
			supportFetchAPI: true,
		},
	},
	{
		scheme: "superset-app",
		privileges: {
			standard: true,
			secure: true,
			supportFetchAPI: true,
			corsEnabled: true,
		},
	},
	{
		scheme: PAGE_SCHEME,
		privileges: {
			standard: true,
			secure: true,
		},
	},
	{
		scheme: THUMBNAIL_SCHEME,
		privileges: {
			standard: true,
			secure: true,
			bypassCSP: true,
			supportFetchAPI: true,
		},
	},
]);

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
	app.exit(0);
} else {
	// Windows/Linux: protocol URL arrives as argv on the second instance
	app.on("second-instance", async (_event, argv) => {
		// An auto-update restart spawns the replacement while this process
		// still holds the single-instance lock; don't build windows mid-quit.
		if (isQuitting) return;
		const url = findDeepLinkInArgv(argv);
		if (url) {
			// processDeepLink focuses the window on every one of its paths.
			await processDeepLink(url);
			return;
		}
		// The desktop entry's "New Window" action (GNOME top-bar/dock app
		// menus) relaunches the executable with --new-window, and the
		// single-instance lock lands it here. A plain relaunch keeps the
		// Electron-standard behavior of focusing the running app, so a
		// Start-menu or launcher re-click never stacks extra windows. The
		// listener-count check covers the boot window before initAppServices
		// registers the handler; falling back to focus matches pre-ready
		// behavior instead of dropping the event silently.
		if (
			argv.includes("--new-window") &&
			menuEmitter.listenerCount("new-window") > 0
		) {
			console.log("[main] Second instance requested a new window");
			menuEmitter.emit("new-window");
			return;
		}
		focusMainWindow();
	});

	(async () => {
		// (AN) Boot phase timing + blocked-event-loop guard. We log each
		// startup milestone so an intermittent stall lands in one labeled
		// phase instead of a silent gap, and the lag monitor fires loud if
		// the main event loop is ever blocked (e.g. a synchronous fs walk) —
		// the failure mode behind the multi-minute blank-window cold start.
		const bootMs = () => Math.round(process.uptime() * 1000);
		let __anLagLast = Date.now();
		const __anLagTimer = setInterval(() => {
			const now = Date.now();
			const drift = now - __anLagLast - 1000;
			if (drift > 1500) {
				log.error(
					"[boot] event-loop BLOCKED for ~" + drift + "ms +" + bootMs() + "ms",
				);
			}
			__anLagLast = now;
		}, 1000);
		__anLagTimer.unref?.();
		// (WIN-USER-ENV) Started here rather than awaited here, so a cold
		// PowerShell overlaps Electron's own init instead of adding to it. It
		// never rejects; the await below is where its ordering guarantees apply.
		const windowsUserEnvMerge = applyWindowsUserEnvToProcess();
		log.info("[boot] awaiting app.whenReady +" + bootMs() + "ms");
		await app.whenReady();
		log.info("[boot] app.whenReady resolved +" + bootMs() + "ms");
		// (WIN-USER-ENV) Awaited HERE: before the coordinator spawns its
		// host-service child (which inherits `...process.env`) and before
		// keep-awake's companion gate reads `SUPERSET_COMPANION_BRIDGE`, so
		// neither can race it. Rationale:
		// packages/shared/src/windows-user-env.ts.
		if ((await windowsUserEnvMerge).ok) {
			// Children inherit this env, so one spawn per boot covers all of them.
			// Only on success — a failed merge leaves the child's own read as the
			// retry rather than suppressing it.
			process.env[WIN_USER_ENV_MERGED_BY_PARENT] = "1";
		}
		// (CLOUD-SEVERANCE-P1) First thing after whenReady, before any protocol
		// handler or window exists: install the LOG-ONLY egress fence so no
		// session request can slip past unobserved. createPlatformWindow() throws
		// if this did not run.
		installEgressFence();
		// (CLOUD-SEVERANCE-P2) The boot-time proxy warm-up probe is gone along
		// with the host it was resolving a route to.
		// Persisted language setting wins; otherwise infer from OS preferences
		// (plans/20260826-i18n-strategy.md). Menus are built later in
		// initAppServices/initTray, so a plain activate is enough here.
		await initI18nAsync(resolveAppLocale(getLanguageSetting()));
		registerWithMacOSNotificationCenter();
		requestAppleEventsAccess();
		requestLocalNetworkAccess();

		// Must register on both default session and the app's custom partition
		const iconProtocolHandler = (request: Request) => {
			const url = new URL(request.url);
			const projectId = url.pathname.replace(/^\//, "");
			const iconPath = getProjectIconPath(projectId);
			if (!iconPath) {
				return new Response("Not found", { status: 404 });
			}
			return net.fetch(pathToFileURL(iconPath).toString());
		};
		protocol.handle("superset-icon", iconProtocolHandler);
		session
			.fromPartition("persist:superset")
			.protocol.handle("superset-icon", iconProtocolHandler);

		// Register custom protocol for serving renderer files.
		// Dynamic imports (code-split chunks) fail on file:// protocol in Electron on Windows.
		const rendererDir = path.join(__dirname, "../renderer");
		const appProtocolHandler = (request: Request) => {
			let urlPath = new URL(request.url).pathname;
			if (urlPath.startsWith("/")) urlPath = urlPath.slice(1);
			const filePath = path.join(rendererDir, urlPath);
			return net.fetch(pathToFileURL(filePath).toString());
		};
		protocol.handle("superset-app", appProtocolHandler);
		session
			.fromPartition("persist:superset")
			.protocol.handle("superset-app", appProtocolHandler);

		// (CLOUD-SEVERANCE-P2) The Windows CORS shim is DELETED. It existed so
		// the superset-app:// origin could reach api.superset.sh, whose CORS
		// policy did not recognise it. Phase 1 stripped the shim's telemetry
		// patterns but kept the API one because sign-in still needed it —
		// nothing signs in now, and a shim that smooths the path to a severed
		// host is the last thing that should outlive it.

		protocol.handle(PAGE_SCHEME, pageProtocolHandler);
		session
			.fromPartition("persist:superset")
			.protocol.handle(PAGE_SCHEME, pageProtocolHandler);

		protocol.handle(THUMBNAIL_SCHEME, thumbnailProtocolHandler);
		session
			.fromPartition("persist:superset")
			.protocol.handle(THUMBNAIL_SCHEME, thumbnailProtocolHandler);

		// Serve system fonts (e.g. SF Mono on macOS) via custom protocol
		// so the renderer can use @font-face with font-src 'self' CSP
		if (process.platform === "darwin") {
			const SYSTEM_FONT_DIRS = [
				"/System/Applications/Utilities/Terminal.app/Contents/Resources/Fonts",
				"/System/Library/Fonts",
				"/Library/Fonts",
			];
			const fontProtocolHandler = async (request: Request) => {
				const url = new URL(request.url);
				const filename = path.basename(url.pathname);
				if (!/\.(otf|ttf|woff2?)$/i.test(filename)) {
					return new Response("Not found", { status: 404 });
				}
				for (const dir of SYSTEM_FONT_DIRS) {
					const fontPath = path.join(dir, filename);
					try {
						return await net.fetch(pathToFileURL(fontPath).toString());
					} catch {
						// Not in this directory
					}
				}
				return new Response("Not found", { status: 404 });
			};
			protocol.handle("superset-font", fontProtocolHandler);
			session
				.fromPartition("persist:superset")
				.protocol.handle("superset-font", fontProtocolHandler);
		}

		ensureProjectIconsDir();
		setWorkspaceDockIcon();
		initSentry();
		log.info("[boot] step initAppState start +" + bootMs() + "ms");
		await initAppState();
		log.info("[boot] step initAppState done +" + bootMs() + "ms");
		initTanstackDbPersistence();

		// (NETLOG-OFF) Upstream deleted its netlog writer outright and now only
		// reclaims the stranded directory. The fork keeps the writer as a
		// maintainer-only diagnostic, so take upstream's sweep on every run
		// except the one that was explicitly asked to record. The gate that
		// actually decides still lives inside startNetworkLogger().
		if (isNetworkLoggingEnabled(process.env)) {
			try {
				log.info("[boot] step startNetworkLogger start +" + bootMs() + "ms");
				await startNetworkLogger();
				log.info("[boot] step startNetworkLogger done +" + bootMs() + "ms");
			} catch (error) {
				console.error("[main] Failed to start network logger:", error);
			}
		} else {
			sweepNetworkLogs();
		}

		log.info(
			"[boot] step loadWebviewBrowserExtension start +" + bootMs() + "ms",
		);
		await loadWebviewBrowserExtension();
		log.info(
			"[boot] step loadWebviewBrowserExtension done +" + bootMs() + "ms",
		);

		// Must happen before renderer restore runs
		log.info("[boot] step reconcileDaemonSessions start +" + bootMs() + "ms");
		await reconcileDaemonSessions();
		log.info("[boot] step reconcileDaemonSessions done +" + bootMs() + "ms");
		prewarmTerminalRuntime();

		// Must be listening before any host-service spawns: the child learns the
		// bridge endpoint/secret from its env, so a late bridge means browser
		// control stays dark until the next respawn.
		try {
			await startBrowserBridge();
		} catch (error) {
			console.error("[main] Failed to start browser bridge:", error);
		}
		downloadManager.start();

		const hostServiceCoordinator = getHostServiceCoordinator();
		// (CLOUD-SEVERANCE-P2) The host-service — and therefore every terminal —
		// used to exist only while a cloud session did: no stored token meant no
		// config, no reconcile, no host. That coupling is what turned an expired
		// session into "sign in with Google again before you can open a shell".
		// The organization is now resolved from what is on this disk, once and
		// permanently (see local-org.ts), and the cloud token is whatever is left
		// over — a placeholder when there is none, because the host-service's env
		// schema requires a non-empty value and nothing local ever authenticates
		// with it.
		// The resolver refuses to guess when it cannot tell which organization
		// owns this machine's data. That refusal has to REACH the user: thrown
		// from here it would land in the boot IIFE, which has no catch, and the
		// process-level handler only writes to a log — so the app would simply
		// never open a window and look dead, with the one instruction that fixes
		// it (write the id into fork-local-org.json) buried in a file nobody has
		// been told to read.
		let localOrganizationId: string;
		try {
			localOrganizationId = (
				await resolveLocalOrgId(async () => (await loadToken()).organizationIds)
			).organizationId;
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			log.error("[boot] local organization resolution failed:", detail);
			dialog.showErrorBox("Superset cannot start", detail);
			app.exit(1);
			return;
		}
		// The renderer process inherits this environment, which is how the
		// preload bridge can hand the id to the first render synchronously.
		// Set before any window is created.
		process.env.FORK_LOCAL_ORG_ID = localOrganizationId;
		// The synthetic host row the renderer serves in place of the cloud host
		// registry has to name THIS machine with the same id the coordinator and
		// the host-service use, or every host-keyed row would belong to a host
		// nothing can reach.
		process.env.FORK_LOCAL_MACHINE_ID = getHostId();
		process.env.FORK_LOCAL_HOST_NAME = getHostName();
		// The stored token is deliberately NOT read here. Nothing authenticates
		// with it any more — the host-service's cloud client is severed and its
		// local callers use the coordinator's PSK — so reading it would buy a
		// value no one checks at the cost of a ~400ms synchronous key
		// derivation on the path that starts the user's terminals.
		hostServiceCoordinator.setConfigProvider(async () => ({
			authToken: LOCAL_AUTH_TOKEN_PLACEHOLDER,
			cloudApiUrl: mainEnv.NEXT_PUBLIC_API_URL,
		}));

		const reconcileHostServices = async () => {
			try {
				await hostServiceCoordinator.reconcile([localOrganizationId], {
					authToken: LOCAL_AUTH_TOKEN_PLACEHOLDER,
					cloudApiUrl: mainEnv.NEXT_PUBLIC_API_URL,
				});
			} catch (error) {
				console.error("[main] host-service reconcile failed:", error);
			}
		};
		void reconcileHostServices();
		// (CLOUD-SEVERANCE-P2) Upstream tore every host-service down whenever the
		// stored token changed, because a new token could belong to a different
		// account whose workspaces must not be served by the previous account's
		// host. There is no account here any more: the organization is frozen on
		// disk and no token change can move it. Keeping those listeners would be
		// actively dangerous rather than merely dead — anything that could write
		// the token store would kill every running terminal as a side effect.

		try {
			// The vite build copies @superset/agent-setup's templates next to this
			// bundle; see vite/helpers.ts.
			setAgentSetupTemplatesDir(path.join(__dirname, "templates"));
			const settingsRow = localDb.select().from(settings).get();
			const disabledAgentHooks = settingsRow?.disabledAgentHooks ?? [];
			// Mirror the disable list so CLI-launched host-services on this machine
			// honor it instead of re-provisioning disabled agent hooks.
			writeSharedDisabledAgentIds(disabledAgentHooks);
			setupAgentIntegrations({ disabledAgentIds: disabledAgentHooks });
		} catch (error) {
			console.error("[main] Failed to set up agent integrations:", error);
		}
		try {
			// Converge agent MCP configs on the installed-plugin set, so
			// installs/uninstalls that missed a mid-session sync land here.
			syncInstalledPluginMcpServers();
		} catch (error) {
			console.error("[main] Failed to sync installed plugins:", error);
		}
		try {
			installBundledCliShim();
		} catch (error) {
			console.error("[main] Failed to install bundled CLI shim:", error);
		}

		if (IS_DEV) {
			hostServiceCoordinator.enableDevReload(async () => ({
				authToken: LOCAL_AUTH_TOKEN_PLACEHOLDER,
				cloudApiUrl: mainEnv.NEXT_PUBLIC_API_URL,
			}));
		}

		log.info("[boot] step makeAppSetup start +" + bootMs() + "ms");
		initAppServices();
		await makeAppSetup(
			() => createPlatformWindow({ orgId: null }),
			restoreWindows,
		);
		log.info("[boot] step makeAppSetup done +" + bootMs() + "ms");
		setupAutoUpdater();
		initTray();

		const coldStartUrl = findDeepLinkInArgv(process.argv);
		if (coldStartUrl) {
			await processDeepLink(coldStartUrl);
		}
		if (pendingDeepLinkUrl) {
			await processDeepLink(pendingDeepLinkUrl);
			pendingDeepLinkUrl = null;
		}

		appReady = true;
	})();
}
