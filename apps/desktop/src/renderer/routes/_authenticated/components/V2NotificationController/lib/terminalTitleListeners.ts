/**
 * (ALERT-CONTEXT-NAMES) Subscribing to the live titles of the terminals a set
 * of layouts actually has open.
 *
 * EXTRACTED FROM THE SUBSCRIBER SO IT CAN BE TESTED. The rule it encodes is
 * narrow and was got wrong once in a way nothing could observe from outside:
 * V2 keys a terminal runtime by `(terminalId, paneId)`, and subscribing without
 * the pane id makes the registry MINT a `(terminalId, terminalId)` default
 * entry. That shadow entry has no runtime, so no title event ever reaches the
 * listener attached to it — and because `getPrimaryEntry` prefers the default
 * key, every later `getTitle` for that terminal starts answering `undefined`
 * and the next sync pushes `tn: ""`. A wrong tab name is invisible in a unit
 * test of the component; it is obvious in a test of this function.
 */

import type { WorkspaceState } from "@superset/panes";
import { collectTerminalPaneRefs, type TerminalPaneRef } from "./alertContexts";

/**
 * The slice of `terminalRuntimeRegistry` this needs. Narrow on purpose: the
 * only operations allowed here are a NON-CREATING existence check, a subscribe
 * against an exact instance, and a read-only notification that an instance has
 * come into existence.
 */
export interface TerminalTitleRegistry {
	hasInstance(terminalId: string, instanceId: string): boolean;
	onTitleChange(
		terminalId: string,
		listener: () => void,
		instanceId?: string,
	): () => void;
	onInstanceRegistered(
		listener: (terminalId: string, instanceId: string) => void,
	): () => void;
}

/**
 * Subscribe `onTitleChange` to every terminal pane in `layouts`, and return the
 * teardown for all of them.
 *
 * THE DESIRED SET IS KEPT FOR THE WHOLE SUBSCRIPTION, and the registration
 * observer stays armed alongside it. Not just the pairs that were missing at
 * the start - ALL of them - because a pair's runtime can go away and come back
 * without the layout ever changing, and both directions of that have bitten
 * this helper already:
 *
 *   ARRIVING LATE. The notification subscriber renders ABOVE the router, so on
 *   the commit that adds a terminal pane its effect runs BEFORE the pane's own
 *   effect (React runs effects child-last; these are siblings in render order).
 *   `hasInstance` is correctly false, and nothing about mounting the runtime
 *   afterwards touches layout state.
 *
 *   GOING AWAY AND COMING BACK. The parked-runtime cap disposes idle runtimes:
 *   `disposeEntry` deletes the registry entry AND `disposeTransport` CLEARS the
 *   transport's title listeners, while the pane stays in the persisted layout.
 *   Re-opening that workspace recreates the exact pair and announces it - but a
 *   helper that only watched initially-missing pairs had either dropped the
 *   pair after its first install or, if every pair was present at the start,
 *   never armed an observer at all. The recreated transport got no listener,
 *   its title never re-synced, and no layout change was ever coming.
 *
 * So an announcement for ANY desired pair (re)installs that pair's listener,
 * replacing whatever is recorded for it, and fires the sync - the runtime that
 * just registered may already carry a title nothing has read.
 */
export function subscribeTerminalTitleListeners({
	layouts,
	registry,
	onTitleChange,
}: {
	layouts: Iterable<WorkspaceState<unknown> | null | undefined>;
	registry: TerminalTitleRegistry;
	onTitleChange: () => void;
}): () => void {
	/** Every pair these layouts want a listener for, for as long as they do. */
	const desired = new Map<string, TerminalPaneRef>();
	/** The CURRENT listener teardown per pair, replaced on re-registration. */
	const titleUnsubscribes = new Map<string, () => void>();

	function install(ref: TerminalPaneRef): void {
		const key = pairKey(ref);
		// Drop whatever was recorded first. After a dispose the old teardown is
		// inert (the transport cleared its listener set), and after any other
		// re-announcement it is the thing that would otherwise leak.
		titleUnsubscribes.get(key)?.();
		titleUnsubscribes.set(
			key,
			registry.onTitleChange(ref.terminalId, onTitleChange, ref.paneId),
		);
	}

	for (const layout of layouts) {
		if (layout == null) continue;
		for (const ref of collectTerminalPaneRefs(layout)) {
			desired.set(pairKey(ref), ref);
			if (registry.hasInstance(ref.terminalId, ref.paneId)) install(ref);
		}
	}

	const stopWatching =
		desired.size > 0
			? registry.onInstanceRegistered((terminalId, instanceId) => {
					const ref = desired.get(pairKey({ terminalId, paneId: instanceId }));
					if (ref === undefined) return;
					install(ref);
					// The pane that just registered may already carry a title nothing
					// has read: the reconciliation pass could not, and a transport
					// emits no event for a title it was created with.
					onTitleChange();
				})
			: null;

	return () => {
		stopWatching?.();
		for (const unsubscribe of titleUnsubscribes.values()) unsubscribe();
		titleUnsubscribes.clear();
		desired.clear();
	};
}

/** Exact pair identity. The separator cannot occur in either id. */
function pairKey(ref: TerminalPaneRef): string {
	return `${ref.terminalId}\u0000${ref.paneId}`;
}
