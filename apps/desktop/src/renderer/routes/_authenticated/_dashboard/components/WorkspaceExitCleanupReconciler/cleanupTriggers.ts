/**
 * (WORKTREE-EXIT-CLEANUP) What makes a pending cleanup try again, and what
 * stops a trigger being lost when one lands mid-sweep.
 */

import type { HostConnectionState } from "@superset/workspace-client";

/**
 * Turns one host's connection-status stream into retry triggers, from a seed
 * read off the live socket when the subscription starts.
 *
 * THE SEED IS THE ONLY THING SUPPRESSED. A host ALREADY open when this begins
 * is one the sweep is running against anyway, so its open is not news. Every
 * other open is: a host that was DOWN when the cleanup became pending had no
 * sweep reach it at all, and a host that dropped and came back lost whatever
 * was in flight over the old socket.
 *
 * Deliberately NOT `isEventBusReopen`. That helper suppresses the first open
 * for a different reason — its consumer's queries fetch on mount, so the first
 * open is already covered — and applying it here swallowed the one trigger this
 * feature exists for: the owning machine coming back after being off, which is
 * the ONLY open a subscription that started offline will ever see.
 */
export function createReopenTrigger(
	isOpenAtStart: boolean,
): (state: HostConnectionState) => boolean {
	let wasOpen = isOpenAtStart;
	return (state) => {
		const isOpen = state === "open";
		const opened = isOpen && !wasOpen;
		wasOpen = isOpen;
		return opened;
	};
}

/**
 * The local host-services, as a value that changes whenever one of them is a
 * DIFFERENT process than before.
 *
 * The secret is what carries that, not the port: a host-service restart reuses
 * its preferred port, so its URL is stable across exactly the event most likely
 * to unstick a pending cleanup. It mints a fresh secret on every spawn, so
 * folding that in is what turns "the local host came back" into a change the
 * reconciler can see.
 */
export function localHostFingerprint(
	connections: readonly { port: number; secret: string }[] | undefined,
): string {
	return (connections ?? [])
		.map((connection) => `${connection.port}:${connection.secret}`)
		.sort()
		.join(",");
}

/**
 * Where the CURRENT debt has to be sent, as a value that changes whenever any
 * pending workspace's owner resolves DIFFERENTLY.
 *
 * This replaces a plain "some owner resolved" boolean in the sweep effect's
 * dependencies, which was a latch: with two pending workspaces owned by two
 * machines, the first machine coming up flipped it true, and the second machine
 * coming up an hour later changed nothing the effect could see — so that second
 * workspace's debt sat until the next app start. Keying on the pairs makes
 * every LATER resolution a change of its own.
 *
 * Sorted, so re-reading the same routing in a different order is the same key.
 * An unresolved owner reads as an empty URL rather than being left out:
 * dropping the id would make "this owner went away" and "this workspace is no
 * longer pending" the same key.
 */
export function cleanupRoutingKey(
	targets: ReadonlyMap<string, { readonly ownerHostUrl: string | null }>,
): string {
	return [...targets]
		.map(
			([workspaceId, target]) =>
				`${workspaceId}=>${target.ownerHostUrl ?? ""}`,
		)
		.sort()
		.join("|");
}

/** Runs a sweep, or queues one rerun if a sweep is already going. */
export type SweepQueue = (workspaceIds: readonly string[]) => Promise<void>;

/**
 * Serialises sweeps and remembers ONE rerun for after the current sweep
 * settles.
 *
 * Dropping a trigger that arrives mid-sweep (the obvious dedupe) loses exactly
 * the one that matters: a reconnect landing while the pre-reconnect attempt is
 * still timing out against the dead socket. That attempt is going to fail, and
 * without the queued rerun the cleanup would then sit until the next app start.
 *
 * `rerun` supplies the ids at the moment the rerun starts rather than when it
 * was queued, so a workspace exited or restored in between is handled as it
 * stands now.
 */
export function createSweepQueue(
	run: (workspaceIds: readonly string[]) => Promise<void>,
	rerun: () => readonly string[],
): SweepQueue {
	let running = false;
	let queued = false;
	return async (workspaceIds) => {
		if (running) {
			queued = true;
			return;
		}
		running = true;
		try {
			await run(workspaceIds);
			while (queued) {
				queued = false;
				await run(rerun());
			}
		} finally {
			running = false;
		}
	};
}
