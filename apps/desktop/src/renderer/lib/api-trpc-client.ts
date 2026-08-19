import type { AppRouter } from "@superset/trpc";
import { createTRPCProxyClient } from "@trpc/client";
import { cloudSeveredLink } from "./cloud-severed-link";

/**
 * (CLOUD-SEVERANCE-P2) The imperative cloud client, severed.
 *
 * Same wall as the React client — see cloud-severed-link.ts. Kept as an export
 * rather than deleted because upstream call sites across the renderer import
 * it, and a choke point here costs one file per nightly merge where deleting
 * them all would cost ninety.
 */
export const apiTrpcClient = createTRPCProxyClient<AppRouter>({
	links: [cloudSeveredLink],
});
