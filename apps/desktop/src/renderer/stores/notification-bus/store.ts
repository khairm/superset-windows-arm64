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
