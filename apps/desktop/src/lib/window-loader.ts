import type { BrowserWindow } from "electron";
import log from "electron-log/main";
import { env } from "shared/env.shared";

/** Window IDs defined in the router configuration */
type WindowId = "main" | "about";

/**
 * Load an Electron window with the appropriate URL for TanStack Router.
 * Uses hash-based routing for compatibility with Electron's file:// protocol.
 *
 * - Development: loads from Vite dev server at http://localhost:PORT/#/
 * - Production: loads from built HTML file with hash routing (#/)
 */
export function registerRoute(props: {
	id: WindowId;
	browserWindow: BrowserWindow;
	htmlFile: string;
	query?: Record<string, string>;
}): void {
	const isDev = env.NODE_ENV === "development";

	if (isDev) {
		// Development: load from Vite dev server with hash routing
		const url = `http://localhost:${env.DESKTOP_VITE_PORT}/#/`;
		console.log("[window-loader] Loading development URL:", url);
		props.browserWindow.loadURL(url);
	} else if (process.platform === "win32") {
		// Production (Windows): use custom protocol for proper dynamic import support.
		// file:// protocol breaks ES module dynamic imports (code-split chunks) on Windows.
		const url = "superset-app://app/index.html#/";
		console.log("[window-loader] Loading custom protocol URL:", url);
		props.browserWindow.loadURL(url);
	} else {
		// Production (macOS/Linux): load from file with hash routing
		// TanStack Router uses hash-based routing, so we always start at #/
		console.log("[window-loader] Loading file:", props.htmlFile);
		props.browserWindow.loadFile(props.htmlFile, { hash: "/" });
	}

	// (AN) Boot diagnostics: navigation kickoff + load-phase markers + a
	// liveness heartbeat. If heartbeats STOP during a slow startup the main
	// event loop is BLOCKED (a synchronous task) rather than the navigation
	// being slow — the distinction that pins the ~5-min cold-start stall.
	const __anBootMs = () => Math.round(process.uptime() * 1000);
	log.info("[boot] navigation kicked off (" + props.id + ") +" + __anBootMs() + "ms");
	const __anHeartbeat = setInterval(() => {
		log.info(
			"[boot] still-loading (" + props.id + ") isLoading=" +
				props.browserWindow.webContents.isLoading() + " +" + __anBootMs() + "ms",
		);
	}, 5000);
	__anHeartbeat.unref?.();
	props.browserWindow.webContents.on("did-start-loading", () => {
		log.info("[boot] did-start-loading (" + props.id + ") +" + __anBootMs() + "ms");
	});
	props.browserWindow.webContents.on("dom-ready", () => {
		log.info("[boot] dom-ready (" + props.id + ") +" + __anBootMs() + "ms");
	});

	// Log successful loads
	props.browserWindow.webContents.on("did-finish-load", () => {
		clearInterval(__anHeartbeat);
		log.info("[boot] did-finish-load (" + props.id + ") +" + __anBootMs() + "ms");
		console.log(
			"[window-loader] Successfully loaded:",
			props.browserWindow.webContents.getURL(),
		);
	});

	// Log and handle load failures
	props.browserWindow.webContents.on(
		"did-fail-load",
		(_event, errorCode, errorDescription, validatedURL) => {
			console.error("[window-loader] Failed to load URL:", validatedURL);
			console.error("[window-loader] Error code:", errorCode);
			console.error("[window-loader] Error description:", errorDescription);
		},
	);
}
