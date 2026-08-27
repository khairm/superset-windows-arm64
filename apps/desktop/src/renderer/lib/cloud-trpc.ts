import type { AppRouter } from "@superset/trpc";
import { createTRPCReact } from "@trpc/react-query";
import { createContext } from "react";
import { cloudSeveredLink } from "./cloud-severed-link";

// Dedicated context — the library default is shared across all
// createTRPCReact clients; without this, cloudTrpc.Provider shadows
// electronTrpc's hooks for everything mounted beneath it (its
// httpBatchStreamLink then rejects electron IPC subscriptions).
const cloudTrpcContext = createContext(null);

/**
 * React Query hooks for the cloud API. Use this for reading cloud data in
 * components; use `apiTrpcClient` for imperative calls outside React.
 * Distinct from `electronTrpc` (main-process IPC) and `workspaceTrpc`
 * (host-service).
 */
export const cloudTrpc = createTRPCReact<AppRouter>({
	context: cloudTrpcContext,
});

/**
 * Cloud router roots on the shared renderer QueryClient. Drives the 30s
 * staleTime default (set once in ElectronTRPCProvider, not per call site)
 * and the org-switch cache purge. "analytics" and "device" exist on the
 * electron IPC router too and are deliberately absent — their cloud queries
 * fall back to per-site options.
 */
export const CLOUD_TRPC_ROUTER_ROOTS = [
	"admin",
	"apiKey",
	"automation",
	"billing",
	"chat",
	"host",
	"integration",
	"organization",
	"page",
	"pageComment",
	"support",
	"task",
	"team",
	"user",
	"v2Host",
	"v2Project",
] as const;

/**
 * The organization this window's cloud reads are scoped to.
 *
 * Module state is per-renderer, and every window is its own renderer, so this
 * is per-window by construction — two windows cannot see each other's value.
 * Without it the API falls back to the login session's active organization,
 * which is shared by every window: a window switched to another org would read
 * the first window's data.
 *
 * Null until CollectionsProvider resolves the window's org, which is also the
 * pre-sign-in state; the API then applies its session default as before.
 */
let cloudOrganizationId: string | null = null;

export function setCloudOrganizationId(organizationId: string | null): void {
	cloudOrganizationId = organizationId;
}

export const cloudTrpcClient = cloudTrpc.createClient({
	// (CLOUD-SEVERANCE-P2) No HTTP transport, so no org header to send: the
	// window's organization is read straight off `getLocalOrganizationId()`
	// inside the severed link. `cloudOrganizationId` is still tracked above so
	// the per-window org that upstream threads through here has somewhere to
	// land if a transport ever comes back.
	links: [cloudSeveredLink],
});
