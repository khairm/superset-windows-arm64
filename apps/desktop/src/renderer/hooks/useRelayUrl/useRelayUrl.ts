/**
 * (CLOUD-SEVERANCE-P2) The relay base URL, severed.
 *
 * Upstream asked the cloud API for this so the desktop and the host-service
 * would agree on which relay to use for REMOTE hosts. There are no remote
 * hosts here — the only host is loopback — so every consumer of this value
 * feeds it into a code path that is now unreachable.
 *
 * It returns an unroutable scheme rather than an empty string or a loopback
 * address on purpose: if some path ever does dial it, the attempt fails
 * immediately and visibly instead of quietly hitting something real.
 */

export const SEVERED_RELAY_URL = "superset-severed://relay";

export function useRelayUrl(): string {
	return SEVERED_RELAY_URL;
}
