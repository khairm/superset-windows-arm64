import { setScreenLocked } from "renderer/hooks/useUserPresent";
import { electronTrpc } from "renderer/lib/electron-trpc";

/** (PRESENCE-SCREEN-LOCK) Feeds main's lock state into the away check. */
export function ScreenLockSubscriber() {
	electronTrpc.window.screenLock.useSubscription(undefined, {
		onData: setScreenLocked,
		onError: (error) => {
			console.error("[screen-lock] subscription failed:", error);
		},
	});

	return null;
}
