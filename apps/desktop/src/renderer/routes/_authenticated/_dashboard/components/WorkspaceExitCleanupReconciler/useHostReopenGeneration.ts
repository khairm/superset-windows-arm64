import { useEffect, useState } from "react";
import { getHostEventBus } from "renderer/lib/host-event-bus";
import { createReopenTrigger } from "./cleanupTriggers";

/**
 * (WORKTREE-EXIT-CLEANUP) A counter that goes up every time one of these hosts'
 * event-bus sockets reaches "open" from a state the sweep could not have run
 * against — a host that was down when the subscription started, or one that
 * dropped and came back.
 *
 * The retry trigger has to be an OBSERVED open, not a change in the target
 * list. A remote host's URL is `${relayUrl}/hosts/${routingKey}` whether that
 * machine is on or off — it is derived from ids, not from reachability — so a
 * key built from URLs never changes when the owner comes back, and the pending
 * cleanup would sit there until the next app start. The socket is the only
 * thing that knows, and it is the same socket the workspace's own data flows
 * over, so an open here means the host really is answering.
 *
 * Only subscribes; never `retain`s. `useHostWorkspaces` already holds a socket
 * open for every non-sandbox target, so listening costs nothing extra — and
 * holding one ourselves for a host with pending cleanup would be a background
 * connection with no screen behind it. Callers must keep sandbox hosts out of
 * `hostUrls` for that reason: the provider counts a held connection as
 * activity, so subscribing to a sandbox would keep its VM awake for as long as
 * the app is open.
 */
export function useHostReopenGeneration(hostUrls: readonly string[]): number {
	const [generation, setGeneration] = useState(0);
	// A stable primitive: the effect must not re-subscribe (and re-seed its
	// "was open" baseline) on every render that rebuilds an equal array.
	const key = [...new Set(hostUrls)].sort().join(",");

	useEffect(() => {
		if (key === "") return;
		const cleanups = key.split(",").map((hostUrl) => {
			const bus = getHostEventBus(hostUrl);
			const isRetryTrigger = createReopenTrigger(
				bus.getConnectionStatus().state === "open",
			);
			return bus.subscribeConnectionStatus((status) => {
				if (isRetryTrigger(status.state)) {
					setGeneration((previous) => previous + 1);
				}
			});
		});
		return () => {
			for (const cleanup of cleanups) cleanup();
		};
	}, [key]);

	return generation;
}
