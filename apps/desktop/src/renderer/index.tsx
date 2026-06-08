import { initSentry } from "./lib/sentry";

// (AN) boot diagnostic: first renderer body statement. Prefixed [agent-dots]
// so the (W.1) main-process console forwarder relays it to main.log in prod
// — the decisive "did the renderer JS actually start" signal vs a
// main-process / navigation stall before any renderer code runs.
console.log(
	"[agent-dots] [boot-renderer] entry eval start +" +
		(typeof performance !== "undefined" ? Math.round(performance.now()) : 0) +
		"ms",
);

initSentry();

import { createRouter, RouterProvider } from "@tanstack/react-router";
import ReactDom from "react-dom/client";
import { BootErrorBoundary } from "./components/BootErrorBoundary";
import {
	cleanupBootErrorHandling,
	initBootErrorHandling,
	isBootErrorReported,
	markBootMounted,
	reportBootError,
} from "./lib/boot-errors";
import { persistentHistory } from "./lib/persistent-hash-history";
import { posthog } from "./lib/posthog";
import { electronQueryClient } from "./providers/ElectronTRPCProvider";
import { NotFound } from "./routes/not-found";
import { routeTree } from "./routeTree.gen";

import "./globals.css";
import "./styles/bundled-fonts.css";

const rootElement = document.querySelector("app");
initBootErrorHandling(rootElement);

const router = createRouter({
	routeTree,
	history: persistentHistory,
	defaultPreload: "intent",
	defaultNotFoundComponent: NotFound,
	context: {
		queryClient: electronQueryClient,
	},
});

const unsubscribe = router.subscribe("onResolved", (event) => {
	posthog.capture("$pageview", {
		$current_url: event.toLocation.pathname,
	});
});

const handleDeepLink = (path: string) => {
	console.log("[deep-link] Navigating to:", path);
	router.navigate({ to: path });
};
const ipcRenderer = window.ipcRenderer as typeof window.ipcRenderer | undefined;
if (ipcRenderer) {
	ipcRenderer.on("deep-link-navigate", handleDeepLink);
} else {
	reportBootError(
		"Renderer preload not available (window.ipcRenderer missing)",
	);
}

if (import.meta.hot) {
	import.meta.hot.dispose(() => {
		unsubscribe();
		if (ipcRenderer) {
			ipcRenderer.off("deep-link-navigate", handleDeepLink);
		}
		cleanupBootErrorHandling();
	});
}

declare module "@tanstack/react-router" {
	interface Register {
		router: typeof router;
	}
}

if (!rootElement) {
	reportBootError("Missing <app> root element");
} else if (!isBootErrorReported()) {
	ReactDom.createRoot(rootElement).render(
		<BootErrorBoundary
			onError={(error) => reportBootError("Render failed", error)}
		>
			<RouterProvider router={router} />
		</BootErrorBoundary>,
	);
	markBootMounted();
}
