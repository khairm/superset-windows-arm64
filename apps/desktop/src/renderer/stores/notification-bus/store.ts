import { create } from "zustand";

/**
 * (BUS-RESYNC) Live connection state of EVERY host event bus the v2
 * notification controller subscribes to — the local host and every relayed
 * host — written by the subscribers themselves, one entry per host URL.
 *
 * The offline pill reads only this. Deriving its own bus set from the
 * workspace/host queries would let the two drift: a relay socket can be down
 * while the local host is fine (dots frozen for those workspaces, no warning),
 * and a window with no local host at all still holds relay subscriptions.
 */
export interface NotificationBusStatusState {
	/** hostUrl -> when it went down (ms), or null while it is connected. */
	buses: Record<string, number | null>;
	setNotificationBusConnected: (hostUrl: string, connected: boolean) => void;
	removeNotificationBus: (hostUrl: string) => void;
}

export const useNotificationBusStatusStore =
	create<NotificationBusStatusState>()((set) => ({
		buses: {},
		setNotificationBusConnected: (hostUrl, connected) => {
			set((state) => {
				const registered = hostUrl in state.buses;
				const since = state.buses[hostUrl];
				if (connected) {
					if (registered && since === null) return state;
					return { buses: { ...state.buses, [hostUrl]: null } };
				}
				// Keep the ORIGINAL down-time. partysocket emits close AND error per
				// failed attempt, and restarting the clock on each one would hold the
				// pill below its grace window forever on a host that is retrying.
				if (registered && since !== null) return state;
				return { buses: { ...state.buses, [hostUrl]: Date.now() } };
			});
		},
		removeNotificationBus: (hostUrl) => {
			set((state) => {
				if (!(hostUrl in state.buses)) return state;
				const { [hostUrl]: _removed, ...buses } = state.buses;
				return { buses };
			});
		},
	}));

/**
 * The longest-running continuous disconnect across every registered bus, or
 * null when they are all up. A primitive, so pill re-renders track the value
 * rather than the map identity.
 */
export function selectEarliestNotificationBusDisconnect(
	state: NotificationBusStatusState,
): number | null {
	let earliest: number | null = null;
	for (const since of Object.values(state.buses)) {
		if (since === null) continue;
		if (earliest === null || since < earliest) earliest = since;
	}
	return earliest;
}

/**
 * Which hosts are down, as a comma-joined label (a primitive, for the same
 * re-render reason as above). "" when they are all up.
 *
 * (OFFLINE-RELAY-HOST) Naming them is not cosmetic. The pill aggregates every
 * bus the notification controller subscribes to, which now includes a relay
 * socket per off-machine host in the sidebar — and a host that is simply
 * switched off is a NORMAL condition whose socket may never hold open, which
 * would otherwise render as a permanent unexplained "offline" badge. Saying
 * WHICH host is down at least makes that state diagnosable from the UI.
 * OPEN QUESTION for e2e verification: if a relay socket for an offline host can
 * never connect, this pill should probably distinguish "a host you have open is
 * unreachable" from "your own dots are frozen" rather than merging them. Do not
 * redesign bus registration to paper over it without measuring first.
 */
export function selectDisconnectedNotificationBusLabel(
	state: NotificationBusStatusState,
): string {
	const down: string[] = [];
	for (const [hostUrl, since] of Object.entries(state.buses)) {
		if (since === null) continue;
		down.push(describeBusHost(hostUrl));
	}
	return down.sort().join(", ");
}

function describeBusHost(hostUrl: string): string {
	try {
		return new URL(hostUrl).host || hostUrl;
	} catch {
		return hostUrl;
	}
}
