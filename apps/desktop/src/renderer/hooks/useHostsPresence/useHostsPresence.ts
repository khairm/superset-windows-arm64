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
 * desktop-v1.29.0 upstream deleted this hook outright and moved presence onto
 * the host event bus inside `useKnownHosts`, so every call site this module
 * once had is gone and its barrel went with them: nothing imports it, and
 * nothing may. The module is kept ONLY as the record of the severance the
 * manifest row describes — the decision that the relay poll must never come
 * back, on a path a future merge would otherwise re-add without anyone
 * noticing. Returning null was the contract the old call sites handled; it is
 * kept so a re-import is inert rather than a live poll.
 */

export interface HostPresenceTarget {
	organizationId: string;
	machineId: string;
}

export interface HostPresence {
	online: boolean;
	/** Relay timestamp of the host's last keepalive; null if never seen. */
	lastSeenAt: number | null;
}

export function useHostsPresence(
	_targets: HostPresenceTarget[],
): Map<string, HostPresence> | null {
	return null;
}
