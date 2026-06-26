import { appendFileSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { settings, workspaces, worktrees } from "@superset/local-db";
import { eq } from "drizzle-orm";
import type { BrowserWindow } from "electron";
import { app, dialog, Notification, nativeTheme } from "electron";
import log from "electron-log/main";
import { createWindow } from "lib/electron-app/factories/windows/create";
import { createAppRouter } from "lib/trpc/routers";
import { localDb } from "main/lib/local-db";
import { DEFAULT_CONFIRM_ON_QUIT, NOTIFICATION_EVENTS, PLATFORM } from "shared/constants";
import {
	env,
	getWorkspaceName as getEnvWorkspaceName,
} from "shared/env.shared";
import type { AgentLifecycleEvent } from "shared/notification-types";
import { createIPCHandler } from "trpc-electron/main";
import { productName } from "~/package.json";
import {
	startAgentJsonlWatcher,
	stopAgentJsonlWatcher,
} from "../lib/agent-jsonl-watcher";
import { appState } from "../lib/app-state";
import { browserManager } from "../lib/browser/browser-manager";
import { createApplicationMenu } from "../lib/menu";
import { playNotificationSound } from "../lib/notification-sound";
import { NotificationManager } from "../lib/notifications/notification-manager";
import {
	notificationsApp,
	notificationsEmitter,
} from "../lib/notifications/server";
import {
	extractWorkspaceIdFromUrl,
	getNotificationTitle,
	getWorkspaceName,
} from "../lib/notifications/utils";
import {
	getInitialWindowBounds,
	loadWindowState,
	saveWindowState,
} from "../lib/window-state";
import { getWorkspaceRuntimeRegistry } from "../lib/workspace-runtime";
import { findActiveOrganizationId } from "../lib/auto-resume/host-send/host-send";
import { autoResumeManager } from "../lib/auto-resume/manager/manager";

// Singleton IPC handler to prevent duplicate handlers on window reopen (macOS)
let ipcHandler: ReturnType<typeof createIPCHandler> | null = null;

function getWorkspaceNameFromDb(workspaceId: string | undefined): string {
	if (!workspaceId) return "Workspace";
	try {
		const workspace = localDb
			.select()
			.from(workspaces)
			.where(eq(workspaces.id, workspaceId))
			.get();
		const worktree = workspace?.worktreeId
			? localDb
					.select()
					.from(worktrees)
					.where(eq(worktrees.id, workspace.worktreeId))
					.get()
			: undefined;
		return getWorkspaceName({ workspace, worktree });
	} catch (error) {
		console.error("[notifications] Failed to get workspace name:", error);
		return "Workspace";
	}
}

let currentWindow: BrowserWindow | null = null;

// Routers receive this getter so they always see the current window, not a stale reference
const getWindow = () => currentWindow;

// invalidate() alone may not rebuild corrupted GPU layers — a tiny resize
// forces Chromium to reconstruct the compositor layer tree.
const forceRepaint = (win: BrowserWindow) => {
	if (win.isDestroyed()) return;
	win.webContents.invalidate();
	if (win.isMaximized() || win.isFullScreen()) return;
	const [width, height] = win.getSize();
	win.setSize(width + 1, height);
	setTimeout(() => {
		if (!win.isDestroyed()) win.setSize(width, height);
	}, 32);
};

// GPU process restarts don't repaint existing compositor layers automatically.
app.on("child-process-gone", (_event, details) => {
	if (details.type === "GPU") {
		console.warn("[main-window] GPU process gone:", details.reason);
		const win = getWindow();
		if (win) forceRepaint(win);
	}
});

export async function MainWindow() {
	log.info("[boot] MainWindow() entered +" + Math.round(process.uptime() * 1000) + "ms");
	const savedWindowState = loadWindowState();
	const initialBounds = getInitialWindowBounds(savedWindowState);
	let persistedZoomLevel = savedWindowState?.zoomLevel;

	const isDev = env.NODE_ENV === "development";
	const workspaceName = isDev ? getEnvWorkspaceName() : undefined;
	const windowTitle = workspaceName
		? `${productName} — ${workspaceName}`
		: productName;

	const window = createWindow({
		id: "main",
		title: windowTitle,
		width: initialBounds.width,
		height: initialBounds.height,
		x: initialBounds.x,
		y: initialBounds.y,
		minWidth: 400,
		minHeight: 400,
		show: false,
		backgroundColor: nativeTheme.shouldUseDarkColors ? "#252525" : "#ffffff",
		center: initialBounds.center,
		movable: true,
		resizable: true,
		alwaysOnTop: false,
		autoHideMenuBar: true,
		...(process.platform === "win32" ? { titleBarStyle: "hidden" as const, titleBarOverlay: { color: "#1f1f1f", symbolColor: "#e6e6e6", height: 36 } } : { frame: false, titleBarStyle: "hidden" as const, trafficLightPosition: { x: 16, y: 16 } }),
		webPreferences: {
			preload: join(__dirname, "../preload/index.js"),
			webviewTag: true,
			// Isolate Electron session from system browser cookies
			// This ensures desktop uses bearer token auth, not web cookies
			partition: "persist:superset",
		},
	});

	createApplicationMenu();

	currentWindow = window;

	// macOS Sequoia+: background throttling can corrupt GPU compositor layers
	if (PLATFORM.IS_MAC) {
		window.webContents.setBackgroundThrottling(false);
	}

	if (isDev) {
		window.webContents.on(
			"console-message",
			(_event, level, message, line, sourceId) => {
				const shouldForward =
					level >= 2 ||
					message.includes("[stress]") ||
					message.includes("[main]");
				if (!shouldForward) return;

				const details = sourceId ? ` (${sourceId}:${line})` : "";
				const formatted = `[renderer-console] ${message}${details}`;
				if (level >= 3) {
					log.error(formatted);
				} else if (level >= 2) {
					log.warn(formatted);
				} else {
					log.info(formatted);
				}
			},
		);

		window.on("unresponsive", () => {
			log.warn("[main-window] Renderer became unresponsive", {
				url: window.webContents.getURL(),
			});
		});
		window.on("responsive", () => {
			log.info("[main-window] Renderer became responsive", {
				url: window.webContents.getURL(),
			});
		});
	}

	// Forward renderer warning/error messages to main process stdout for Windows debugging.
	if (PLATFORM.IS_WINDOWS) {
		window.webContents.on(
			"console-message",
			(_event, level, message, line, sourceId) => {
				if (level < 2) return;
				const levelStr =
					["verbose", "info", "warning", "error"][level] ?? "unknown";
				const source = sourceId ? ` (${sourceId}:${line})` : "";
				const formatted = `[renderer:${levelStr}] ${message}${source}`;
				if (level === 3) console.error(formatted);
				else console.warn(formatted);
			},
		);
	}

	// (AB) Silence electron-log's console transport so [agent-dots] lines do
	// NOT leak into any attached parent console / pipe / external Claude Code TUI.
	// Main.log file transport continues normally. Without this, [agent-dots] lines
	// emitted via log.info(message) below were corrupting external pwsh Claude
	// sessions' TUI rendering for this cwd's Claude sessions. Codex-confirmed
	// root cause 2026-05-26 via electron-log docs.
	log.transports.console.level = false;

	// (W.1) Production diagnostic: persist renderer "[agent-dots]" console lines to
	// electron-log (main.log) so the agent-status-dots pipeline + the v2-workspace
	// blank-pane diagnostics survive a shipped build (no devtools session).
	// Logging only -- never alters behaviour. Inserted deterministically by (W.1)
	// because main.ts is AI-edited and a line-anchored hunk drifts.
	window.webContents.on(
		"console-message",
		(_event, _level, message) => {
			try {
				if (typeof message === "string" && message.startsWith("[agent-dots]")) {
					log.info(message);
				} else if (
					typeof message === "string" &&
					message.startsWith("[render-dot]")
				) {
					// (render-dot) Persist renderer dot-render snapshots to a
					// SEPARATE log so the actually-rendered colour can be matched
					// against the watcher emit log by source key + workspaceId.
					// Append-only with a simple ~2 MB rotation; never throws.
					try {
						const p = join(homedir(), ".superset", "agent-dot-render.log");
						try {
							if (statSync(p).size > 2 * 1024 * 1024) {
								renameSync(p, `${p}.prev`);
							}
						} catch {
							// no existing file to rotate
						}
						appendFileSync(p, `${new Date().toISOString()} ${message}\n`, "utf8");
					} catch {
						// never let render-dot logging crash the main process
					}
				}
			} catch {
				// never let logging crash the main process
			}
		},
	);

	// [WISPR-DIAG] Enable Electron's accessibility support so xterm's
	// screenReaderMode:true (which adds aria-* to the hidden <textarea>) is
	// actually visible to Windows UI Automation. Wispr Flow's voice input uses
	// UIA (IUIAutomationValuePattern/TextPattern); without UIA exposure, ARIA on
	// the textarea is invisible to it and injection silently no-ops — keyboard
	// + Ctrl+V still work because they route through xterm's keydown listener
	// and paste handler, not UIA. Electron only fully materializes its
	// accessibility tree on Windows when this flag is set OR when a registered
	// screen reader is detected (Wispr Flow does NOT register as a screen reader).
	//
	// NOTE: logs via electron-log `log.info` (NOT console.log). This snippet runs
	// in the MAIN process; the (W.1) forwarder only relays RENDERER console
	// messages to main.log, so a main-process console.log would never surface.
	// `log` is in scope here — (W.1)/(AB) use it at this same anchor.
	try {
		const { app } = require("electron") as typeof import("electron");
		log.info("[agent-dots] [wispr-diag] electron-accessibility-before " + JSON.stringify({
			isAccessibilitySupportEnabled: typeof (app as any).isAccessibilitySupportEnabled === "function" ? (app as any).isAccessibilitySupportEnabled() : null,
			accessibilitySupportEnabled: (app as any).accessibilitySupportEnabled,
			electronVersion: process.versions.electron,
			chromeVersion: process.versions.chrome,
			platform: process.platform,
			arch: process.arch,
		}));
		if (typeof (app as any).setAccessibilitySupportEnabled === "function") {
			(app as any).setAccessibilitySupportEnabled(true);
			log.info("[agent-dots] [wispr-diag] setAccessibilitySupportEnabled(true) called");
		}
		log.info("[agent-dots] [wispr-diag] electron-accessibility-after " + JSON.stringify({
			isAccessibilitySupportEnabled: typeof (app as any).isAccessibilitySupportEnabled === "function" ? (app as any).isAccessibilitySupportEnabled() : null,
		}));
	} catch (_e) {
		try { log.info("[agent-dots] [wispr-diag] electron-accessibility-error " + String(_e)); } catch (_e2) { /* swallow */ }
	}

	if (ipcHandler) {
		ipcHandler.attachWindow(window);
	} else {
		ipcHandler = createIPCHandler({
			router: createAppRouter(getWindow),
			windows: [window],
		});
	}

	const server = notificationsApp.listen(
		env.DESKTOP_NOTIFICATIONS_PORT,
		"127.0.0.1",
		() => {
			console.log(
				`[notifications] Listening on http://127.0.0.1:${env.DESKTOP_NOTIFICATIONS_PORT}`,
			);
		},
	);

	// Windows: forward agent state from Claude's JSONL session transcripts
	// to notificationsEmitter, sidestepping the bash-only hook chain that
	// silently fails on Windows. See PATCHES.md (Patch: agent-jsonl-watcher)
	// and the fork's project memory `superset-windows-hook-chain-broken`.
	log.info("[boot] startAgentJsonlWatcher (seed scan deferred) +" + Math.round(process.uptime() * 1000) + "ms");
	// (AUTO-RESUME) Detect+auto-resume Claude chats that died on an API failure.
	autoResumeManager.start({
		emitter: notificationsEmitter,
		getOrganizationId: findActiveOrganizationId,
	});
	startAgentJsonlWatcher({
		notificationsEmitter,
		onClaudeApiError: (info) => autoResumeManager.onClaudeApiErrorSignal(info),
	});
	log.info("[boot] startAgentJsonlWatcher returned +" + Math.round(process.uptime() * 1000) + "ms");

	const notificationManager = new NotificationManager({
		isSupported: () => Notification.isSupported(),
		createNotification: (opts) => new Notification(opts),
		playSound: playNotificationSound,
		onNotificationClick: (ids) => {
			window.show();
			window.focus();
			if (ids.workspaceId && ids.terminalId) {
				notificationsEmitter.emit(
					NOTIFICATION_EVENTS.FOCUS_V2_NOTIFICATION_SOURCE,
					{
						workspaceId: ids.workspaceId,
						source: { type: "terminal", id: ids.terminalId },
					},
				);
				return;
			}
			notificationsEmitter.emit(NOTIFICATION_EVENTS.FOCUS_TAB, ids);
		},
		getVisibilityContext: () => ({
			isFocused: window.isFocused(),
			currentWorkspaceId: extractWorkspaceIdFromUrl(
				window.webContents.getURL(),
			),
			tabsState: appState.data?.tabsState,
		}),
		getWorkspaceName: getWorkspaceNameFromDb,
		getNotificationTitle: (event) =>
			getNotificationTitle({
				tabId: event.tabId,
				paneId: event.paneId,
				tabs: appState.data?.tabsState?.tabs,
				panes: appState.data?.tabsState?.panes,
			}),
	});
	notificationManager.start();

	notificationsEmitter.on(
		NOTIFICATION_EVENTS.AGENT_LIFECYCLE,
		(event: AgentLifecycleEvent) => {
			notificationManager.handleAgentLifecycle(event);
		},
	);

	// Forward low-volume terminal lifecycle events to the renderer via the existing
	// notifications subscription. This is used only for correctness (e.g. clearing
	// stuck agent lifecycle statuses when terminal panes aren't mounted).
	getWorkspaceRuntimeRegistry()
		.getDefault()
		.terminal.on(
			"terminalExit",
			(event: {
				paneId: string;
				exitCode: number;
				signal?: number;
				reason?: "killed" | "exited" | "error";
			}) => {
				notificationsEmitter.emit(NOTIFICATION_EVENTS.TERMINAL_EXIT, {
					paneId: event.paneId,
					exitCode: event.exitCode,
					signal: event.signal,
					reason: event.reason,
				});
			},
		);

	// macOS Sequoia+: occluded/minimized windows can lose compositor layers
	if (PLATFORM.IS_MAC) {
		window.on("restore", () => {
			window.webContents.invalidate();
		});
		window.on("show", () => {
			window.webContents.invalidate();
		});
	}

	// Persist window bounds on move/resize so state survives app.exit(0)
	// (which skips the close handler — e.g. electron-vite SIGTERM during dev).
	// Gated by `initialized` so the initial maximize() doesn't immediately
	// write isMaximized: true back to disk before the user touches the window.
	let initialized = false;
	let hasCompletedFirstLoad = false;
	let saveTimeout: ReturnType<typeof setTimeout> | null = null;
	const debouncedSave = () => {
		if (!initialized || window.isDestroyed()) return;
		if (saveTimeout) clearTimeout(saveTimeout);
		saveTimeout = setTimeout(() => {
			if (window.isDestroyed()) return;
			const isMaximized = window.isMaximized();
			const bounds = isMaximized
				? window.getNormalBounds()
				: window.getBounds();
			const zoomLevel = window.webContents.getZoomLevel();
			saveWindowState({
				x: bounds.x,
				y: bounds.y,
				width: bounds.width,
				height: bounds.height,
				isMaximized,
				zoomLevel,
			});
			persistedZoomLevel = zoomLevel;
		}, 500);
	};
	window.on("move", debouncedSave);
	window.on("resize", debouncedSave);
	window.webContents.on("zoom-changed", () => {
		setTimeout(() => {
			if (window.isDestroyed()) return;
			persistedZoomLevel = window.webContents.getZoomLevel();
			debouncedSave();
		}, 0);
	});

		// (T) hidden-window watchdog — failsafe for "all Superset.exe processes alive
	// but no window" on Windows ARM64. The main window is created `show: false`
	// and only revealed by the did-finish-load / did-fail-load handlers; we've
	// seen launches where NEITHER fires (renderer crash mid-load with no reload,
	// or a load/visibility race under the superset-app:// protocol), leaving the
	// window permanently hidden. Applied as an INLINE fixup that ADDS independent
	// webContents listeners (EventEmitter allows many) rather than modifying the
	// AI-edited handler bodies — that modification is what made the old git-apply
	// (T) drift and hard-abort. Depends only on `window` + `log` (both in scope
	// here, used by W.1/AA.1/AB) and a stable anchor, so it can't drift.
	const SHOW_WATCHDOG_MS = 12_000;
	let __twFirstLoadDone = false;
	let __twReloadAttempts = 0;
	const __twShowWatchdog = setTimeout(() => {
		if (window.isDestroyed() || window.isVisible()) return;
		log.error(
			"[main-window] show-watchdog fired: window still hidden after timeout — forcing show",
			{
				timeoutMs: SHOW_WATCHDOG_MS,
				url: window.webContents.getURL(),
				isLoading: window.webContents.isLoading(),
				isCrashed: window.webContents.isCrashed(),
			},
		);
		try {
			window.show();
			window.focus();
		} catch (_e) {
			/* window may have been destroyed between the guard and show() */
		}
	}, SHOW_WATCHDOG_MS);
	__twShowWatchdog.unref?.();
	window.webContents.on("did-finish-load", () => {
		__twFirstLoadDone = true;
		clearTimeout(__twShowWatchdog);
		log.info("[main-window] did-finish-load (watchdog cleared)");
	});
	window.webContents.on(
		"did-fail-load",
		(_event, errorCode, errorDescription, validatedURL) => {
			log.error("[main-window] did-fail-load", {
				errorCode,
				errorDescription,
				url: validatedURL,
			});
			clearTimeout(__twShowWatchdog);
			if (!__twFirstLoadDone && !window.isDestroyed() && !window.isVisible()) {
				try {
					window.show();
				} catch (_e) {
					/* ignore */
				}
			}
		},
	);
	window.webContents.on("render-process-gone", (_event, details) => {
		log.error("[main-window] render-process-gone", details);
		// Reload once if the renderer dies before the first successful load —
		// otherwise the show trigger never fires; the watchdog is the backstop.
		if (
			!__twFirstLoadDone &&
			!window.isDestroyed() &&
			details.reason !== "clean-exit" &&
			__twReloadAttempts < 1
		) {
			__twReloadAttempts += 1;
			log.warn("[main-window] reloading renderer after early crash", {
				attempt: __twReloadAttempts,
				reason: details.reason,
			});
			try {
				window.webContents.reload();
			} catch (_e) {
				/* ignore */
			}
		}
	});

window.webContents.on("did-finish-load", () => {
		console.log("[main-window] Renderer loaded successfully");
		log.info("[startup] cold start: " + Math.round(process.uptime() * 1000) + "ms (process start -> did-finish-load)");

		if (persistedZoomLevel !== undefined) {
			window.webContents.setZoomLevel(persistedZoomLevel);
		}

		if (!hasCompletedFirstLoad) {
			if (initialBounds.isMaximized) {
				window.maximize();
			}
			window.show();
			initialized = true;
			hasCompletedFirstLoad = true;
		}
	});

	window.webContents.on(
		"did-fail-load",
		(_event, errorCode, errorDescription, validatedURL) => {
			console.error("[main-window] Failed to load renderer:");
			console.error(`  Error code: ${errorCode}`);
			console.error(`  Description: ${errorDescription}`);
			console.error(`  URL: ${validatedURL}`);
			// Show the window anyway so user can see something is wrong
			window.show();
		},
	);

	window.webContents.on("render-process-gone", (_event, details) => {
		console.error("[main-window] Renderer process gone:", details);
		log.error("[main-window] Renderer process gone", details);
	});

	window.webContents.on("preload-error", (_event, preloadPath, error) => {
		console.error("[main-window] Preload script error:");
		console.error(`  Path: ${preloadPath}`);
		console.error(`  Error:`, error);
	});

	window.on("close", (event) => {
		// Windows: show quit confirmation BEFORE the window closes.
		// The before-quit handler fires too late on Windows (window is already gone).
		

		// Save window state first, before any cleanup
		const isMaximized = window.isMaximized();
		const bounds = isMaximized ? window.getNormalBounds() : window.getBounds();
		const zoomLevel = window.webContents.getZoomLevel();
		saveWindowState({
			x: bounds.x,
			y: bounds.y,
			width: bounds.width,
			height: bounds.height,
			isMaximized,
			zoomLevel,
		});
		persistedZoomLevel = zoomLevel;

		browserManager.unregisterAll();
		server.close();
		notificationManager.dispose();
		stopAgentJsonlWatcher();
		notificationsEmitter.removeAllListeners();
		getWorkspaceRuntimeRegistry().getDefault().terminal.detachAllListeners();
		ipcHandler?.detachWindow(window);
		currentWindow = null;
	});

	return window;
}
