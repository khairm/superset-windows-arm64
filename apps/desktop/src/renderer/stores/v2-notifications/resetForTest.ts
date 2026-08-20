import { type V2NotificationState, useV2NotificationStore } from "./store";

/**
 * Every DATA key on the store — the maps, not the actions.
 *
 * Derived rather than listed so that adding a map to `V2NotificationState`
 * fails to compile until the reset below empties it too. Four suites used to
 * inline the same seven-field `setState`, and a store that grew an eighth map
 * would have left it seeded from whichever test ran before.
 */
type V2NotificationDataKey = {
	[K in keyof V2NotificationState]: V2NotificationState[K] extends (
		...args: never[]
	) => unknown
		? never
		: K;
}[keyof V2NotificationState];

const EMPTY_STATE: { [K in V2NotificationDataKey]: V2NotificationState[K] } = {
	sources: {},
	manualUnread: {},
	terminalSeenAt: {},
	outstandingReadyAt: {},
	shellRunningTerminals: {},
	backgroundRunningTerminals: {},
	agentTerminals: {},
};

/**
 * Empty every axis the dots are rendered from, for one test.
 *
 * TEST-ONLY. The store is a process-global singleton and bun runs a file's
 * tests sequentially in one process, so a suite that seeds a dot leaks it into
 * the next one unless this runs in `beforeEach`.
 */
export function resetV2NotificationStoreForTest(): void {
	useV2NotificationStore.setState({ ...EMPTY_STATE });
}
