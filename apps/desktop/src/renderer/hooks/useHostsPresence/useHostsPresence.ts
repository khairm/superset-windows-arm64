/**
 * (CLOUD-SEVERANCE-P2) Host presence is a relay concept, and there is no relay.
 *
 * Upstream polled `${relayUrl}/presence` and `${relayUrl}/health` with a raw
 * `fetch` every thirty seconds to decide whether OTHER machines in the
 * organization were online. Two reasons it is gone rather than repointed:
 * this fork has exactly one host — the machine the app is running on, whose
 * reachability the coordinator already reports — and a raw `fetch` is invisible
 * to the severed tRPC link, so leaving it would have kept a live poll to
 * `relay.superset.sh` running behind a transport everyone assumed was dead.
 *
 * Returning null is the contract every call site already handles: it means
 * "no presence information", and each one falls back to the host row's own
 * `isOnline`.
 */

export interface HostPresenceTarget {
	organizationId: string;
	machineId: string;
}

export function useHostsPresence(
	_targets: HostPresenceTarget[],
): Map<string, boolean> | null {
	return null;
}
