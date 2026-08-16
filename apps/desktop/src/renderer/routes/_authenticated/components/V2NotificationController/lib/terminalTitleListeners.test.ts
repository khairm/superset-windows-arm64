/**
 * (ALERT-CONTEXT-NAMES) Title-listener reconciliation.
 *
 * The defect these pin cost nothing visible at the call site and everything at
 * runtime: subscribing by terminal id alone made the registry mint a shadow
 * `(terminalId, terminalId)` entry, which both swallowed the events and poisoned
 * every later `getTitle` for that terminal.
 */

import { describe, expect, it } from "bun:test";
import type { WorkspaceState } from "@superset/panes";
import {
	subscribeTerminalTitleListeners,
	type TerminalTitleRegistry,
} from "./terminalTitleListeners";

interface Subscription {
	terminalId: string;
	instanceId: string | undefined;
	listener: () => void;
}

/**
 * A registry double that models the REAL lifecycle, not a convenient one:
 *
 *  - `getOrCreateEntry` announces only when it actually CREATES an entry, and
 *    returns early for one that already exists. So `registerInstance` on a live
 *    pair is a no-op, exactly as the real registry is.
 *  - `disposeEntry` deletes the entry AND `disposeTransport` clears that
 *    transport's title listeners. So `disposeInstance` kills the pair's live
 *    listeners as well as removing it — a teardown recorded against the old
 *    transport is inert afterwards, and a title event reaches nothing.
 *
 * `fireTitle` therefore only reaches listeners attached to the runtime that is
 * live RIGHT NOW, which is what makes "the listener was reinstalled" a real
 * assertion rather than a bookkeeping one.
 */
function fakeRegistry(existing: Array<[string, string]>) {
	const key = (terminalId: string, instanceId: string) =>
		`${terminalId}\u0000${instanceId}`;
	const keys = new Set(existing.map(([t, i]) => key(t, i)));
	const subscriptions: Subscription[] = [];
	const unsubscribed: Subscription[] = [];
	const hasInstanceCalls: Array<[string, string]> = [];
	const instanceListeners = new Set<
		(terminalId: string, instanceId: string) => void
	>();
	/** Live title listeners per pair — the transport's own listener set. */
	const liveListeners = new Map<string, Set<() => void>>();
	const registry: TerminalTitleRegistry = {
		hasInstance(terminalId, instanceId) {
			hasInstanceCalls.push([terminalId, instanceId]);
			return keys.has(key(terminalId, instanceId));
		},
		onTitleChange(terminalId, listener, instanceId) {
			const subscription: Subscription = { terminalId, instanceId, listener };
			subscriptions.push(subscription);
			const pair = key(terminalId, instanceId ?? terminalId);
			let set = liveListeners.get(pair);
			if (!set) {
				set = new Set();
				liveListeners.set(pair, set);
			}
			set.add(listener);
			return () => {
				unsubscribed.push(subscription);
				liveListeners.get(pair)?.delete(listener);
			};
		},
		onInstanceRegistered(listener) {
			instanceListeners.add(listener);
			return () => {
				instanceListeners.delete(listener);
			};
		},
	};
	return {
		registry,
		subscriptions,
		unsubscribed,
		hasInstanceCalls,
		/**
		 * `mount()` -> `getOrCreateEntry`. Announces ONLY on real creation; an
		 * existing pair returns early and announces nothing.
		 */
		registerInstance(terminalId: string, instanceId: string) {
			const pair = key(terminalId, instanceId);
			if (keys.has(pair)) return;
			keys.add(pair);
			for (const listener of [...instanceListeners]) {
				listener(terminalId, instanceId);
			}
		},
		/** The parked-runtime cap: `disposeEntry` + `disposeTransport`. */
		disposeInstance(terminalId: string, instanceId: string) {
			const pair = key(terminalId, instanceId);
			keys.delete(pair);
			liveListeners.get(pair)?.clear();
		},
		/** A title event on the runtime that is live right now. */
		fireTitle(terminalId: string, instanceId: string) {
			for (const listener of [
				...(liveListeners.get(key(terminalId, instanceId)) ?? []),
			]) {
				listener();
			}
		},
		liveInstanceObservers: () => instanceListeners.size,
	};
}

function layout(
	panes: Array<{ paneId: string; terminalId?: string; kind?: string }>,
): WorkspaceState<unknown> {
	return {
		tabs: [
			{
				id: "tab-1",
				createdAt: 0,
				activePaneId: panes[0]?.paneId ?? null,
				layout: { type: "pane", paneId: panes[0]?.paneId ?? "" },
				panes: Object.fromEntries(
					panes.map((pane) => [
						pane.paneId,
						{
							id: pane.paneId,
							kind: pane.kind ?? "terminal",
							data: pane.terminalId ? { terminalId: pane.terminalId } : {},
						},
					]),
				),
			},
		],
	} as unknown as WorkspaceState<unknown>;
}

describe("(ALERT-CONTEXT-NAMES) subscribeTerminalTitleListeners", () => {
	it("subscribes against the PANE id, which is the runtime instance id", () => {
		const { registry, subscriptions } = fakeRegistry([
			["terminal-1", "pane-1"],
		]);
		subscribeTerminalTitleListeners({
			layouts: [layout([{ paneId: "pane-1", terminalId: "terminal-1" }])],
			registry,
			onTitleChange: () => {},
		});
		expect(subscriptions).toHaveLength(1);
		// The bug was passing no instance id, which the registry reads as the
		// DEFAULT (terminalId, terminalId) entry and creates on demand.
		expect(subscriptions[0]?.instanceId).toBe("pane-1");
		expect(subscriptions[0]?.terminalId).toBe("terminal-1");
	});

	it("never addresses a runtime that does not exist", () => {
		const { registry, subscriptions, hasInstanceCalls } = fakeRegistry([]);
		subscribeTerminalTitleListeners({
			layouts: [layout([{ paneId: "pane-1", terminalId: "terminal-1" }])],
			registry,
			onTitleChange: () => {},
		});
		// Checked, and then left alone — creating an entry here would materialise
		// a runtime for a pane nobody has opened.
		expect(hasInstanceCalls).toEqual([["terminal-1", "pane-1"]]);
		expect(subscriptions).toHaveLength(0);
	});

	it("checks the EXACT pair — a live sibling instance authorises nothing", () => {
		// A runtime under a DIFFERENT pane must not authorise subscribing to this
		// one: that is precisely how the shadow entry used to be minted. The pair
		// goes on the waiting list instead.
		const { registry, subscriptions } = fakeRegistry([
			["terminal-1", "pane-other"],
		]);
		subscribeTerminalTitleListeners({
			layouts: [layout([{ paneId: "pane-1", terminalId: "terminal-1" }])],
			registry,
			onTitleChange: () => {},
		});
		expect(subscriptions).toHaveLength(0);
	});

	it("subscribes one listener per PANE when a terminal is open twice", () => {
		const { registry, subscriptions } = fakeRegistry([
			["terminal-1", "pane-1"],
			["terminal-1", "pane-2"],
		]);
		subscribeTerminalTitleListeners({
			layouts: [
				layout([
					{ paneId: "pane-1", terminalId: "terminal-1" },
					{ paneId: "pane-2", terminalId: "terminal-1" },
				]),
			],
			registry,
			onTitleChange: () => {},
		});
		expect(subscriptions.map((s) => s.instanceId).sort()).toEqual([
			"pane-1",
			"pane-2",
		]);
	});

	it("ignores panes that are not terminals", () => {
		const { registry, subscriptions, hasInstanceCalls } = fakeRegistry([
			["terminal-1", "pane-1"],
		]);
		subscribeTerminalTitleListeners({
			layouts: [
				layout([
					{ paneId: "pane-1", terminalId: "terminal-1" },
					{ paneId: "pane-2", kind: "diff" },
				]),
			],
			registry,
			onTitleChange: () => {},
		});
		expect(hasInstanceCalls).toHaveLength(1);
		expect(subscriptions).toHaveLength(1);
	});

	it("spans every layout it is given, and tolerates unhydrated ones", () => {
		const { registry, subscriptions } = fakeRegistry([
			["terminal-1", "pane-1"],
			["terminal-2", "pane-2"],
		]);
		subscribeTerminalTitleListeners({
			layouts: [
				layout([{ paneId: "pane-1", terminalId: "terminal-1" }]),
				null,
				undefined,
				layout([{ paneId: "pane-2", terminalId: "terminal-2" }]),
			],
			registry,
			onTitleChange: () => {},
		});
		expect(subscriptions.map((s) => s.terminalId).sort()).toEqual([
			"terminal-1",
			"terminal-2",
		]);
	});

	it("tears down EVERY listener it created", () => {
		const { registry, subscriptions, unsubscribed } = fakeRegistry([
			["terminal-1", "pane-1"],
			["terminal-2", "pane-2"],
		]);
		const stop = subscribeTerminalTitleListeners({
			layouts: [
				layout([
					{ paneId: "pane-1", terminalId: "terminal-1" },
					{ paneId: "pane-2", terminalId: "terminal-2" },
				]),
			],
			registry,
			onTitleChange: () => {},
		});
		expect(subscriptions).toHaveLength(2);
		stop();
		expect(unsubscribed).toHaveLength(2);
	});

	it("forwards a title change to the caller", () => {
		const { registry, subscriptions } = fakeRegistry([
			["terminal-1", "pane-1"],
		]);
		let fired = 0;
		subscribeTerminalTitleListeners({
			layouts: [layout([{ paneId: "pane-1", terminalId: "terminal-1" }])],
			registry,
			onTitleChange: () => {
				fired++;
			},
		});
		subscriptions[0]?.listener();
		expect(fired).toBe(1);
	});

	it("returns a teardown that is safe with nothing subscribed", () => {
		const { registry } = fakeRegistry([]);
		const stop = subscribeTerminalTitleListeners({
			layouts: [null],
			registry,
			onTitleChange: () => {},
		});
		expect(() => stop()).not.toThrow();
	});
});

/**
 * THE LIFECYCLE THE PANE-KEY FIX ALONE DID NOT CLOSE.
 *
 * `V2NotificationController` is rendered above `Outlet`, so on the commit that
 * adds a terminal pane its effect runs BEFORE the pane's own effect creates the
 * runtime. `hasInstance` is correctly false, the pair is skipped — and mounting
 * the runtime changes no layout state, so nothing ever re-runs reconciliation.
 * Without a creation signal, that terminal never gets a title listener at all.
 */
describe("(ALERT-CONTEXT-NAMES) pending instances", () => {
	it("installs the exact listener when the instance appears WITHOUT a layout change", () => {
		const { registry, subscriptions, registerInstance } = fakeRegistry([]);
		let synced = 0;
		subscribeTerminalTitleListeners({
			layouts: [layout([{ paneId: "pane-1", terminalId: "terminal-1" }])],
			registry,
			onTitleChange: () => {
				synced++;
			},
		});
		// Reconciliation found nothing — exactly the real render order.
		expect(subscriptions).toHaveLength(0);
		expect(synced).toBe(0);

		// The pane's own effect mounts the runtime. No layout tick accompanies it.
		registerInstance("terminal-1", "pane-1");

		expect(subscriptions).toHaveLength(1);
		expect(subscriptions[0]).toMatchObject({
			terminalId: "terminal-1",
			instanceId: "pane-1",
		});
		// And the context is re-synced, because the runtime may already have a
		// title the reconciliation pass could not read.
		expect(synced).toBe(1);
	});

	it("forwards title changes from a listener installed that way", () => {
		const { registry, subscriptions, registerInstance } = fakeRegistry([]);
		let synced = 0;
		subscribeTerminalTitleListeners({
			layouts: [layout([{ paneId: "pane-1", terminalId: "terminal-1" }])],
			registry,
			onTitleChange: () => {
				synced++;
			},
		});
		registerInstance("terminal-1", "pane-1");
		expect(synced).toBe(1);
		subscriptions[0]?.listener();
		expect(synced).toBe(2);
	});

	it("ignores an instance that is not one of ITS pending pairs", () => {
		const { registry, subscriptions, registerInstance } = fakeRegistry([]);
		let synced = 0;
		subscribeTerminalTitleListeners({
			layouts: [layout([{ paneId: "pane-1", terminalId: "terminal-1" }])],
			registry,
			onTitleChange: () => {
				synced++;
			},
		});
		// A different terminal, and the same terminal under a different pane.
		registerInstance("terminal-2", "pane-2");
		registerInstance("terminal-1", "pane-other");
		expect(subscriptions).toHaveLength(0);
		expect(synced).toBe(0);
	});

	it("re-announcing an already-live pair changes nothing", () => {
		// The real `getOrCreateEntry` returns early for an existing entry and
		// announces nothing, so this is a no-op by construction — asserted so the
		// double cannot drift into announcing it.
		const { registry, subscriptions, registerInstance } = fakeRegistry([]);
		subscribeTerminalTitleListeners({
			layouts: [layout([{ paneId: "pane-1", terminalId: "terminal-1" }])],
			registry,
			onTitleChange: () => {},
		});
		registerInstance("terminal-1", "pane-1");
		expect(subscriptions).toHaveLength(1);
		registerInstance("terminal-1", "pane-1");
		expect(subscriptions).toHaveLength(1);
	});

	it("waits for only the pairs that were missing, subscribing the rest at once", () => {
		const { registry, subscriptions, registerInstance } = fakeRegistry([
			["terminal-1", "pane-1"],
		]);
		subscribeTerminalTitleListeners({
			layouts: [
				layout([
					{ paneId: "pane-1", terminalId: "terminal-1" },
					{ paneId: "pane-2", terminalId: "terminal-2" },
				]),
			],
			registry,
			onTitleChange: () => {},
		});
		expect(subscriptions.map((s) => s.instanceId)).toEqual(["pane-1"]);
		registerInstance("terminal-2", "pane-2");
		expect(subscriptions.map((s) => s.instanceId).sort()).toEqual([
			"pane-1",
			"pane-2",
		]);
	});

	it("watches for instances whenever anything is desired, present or not", () => {
		// The observer used to be armed only when something was MISSING, so a
		// workspace whose runtimes were all live got no observer at all — and
		// therefore no way back after the parked-runtime cap disposed one.
		const present = fakeRegistry([["terminal-1", "pane-1"]]);
		subscribeTerminalTitleListeners({
			layouts: [layout([{ paneId: "pane-1", terminalId: "terminal-1" }])],
			registry: present.registry,
			onTitleChange: () => {},
		});
		expect(present.liveInstanceObservers()).toBe(1);

		const absent = fakeRegistry([]);
		subscribeTerminalTitleListeners({
			layouts: [layout([{ paneId: "pane-1", terminalId: "terminal-1" }])],
			registry: absent.registry,
			onTitleChange: () => {},
		});
		expect(absent.liveInstanceObservers()).toBe(1);
	});

	it("arms no observer when the layouts want nothing", () => {
		const { registry, liveInstanceObservers } = fakeRegistry([]);
		subscribeTerminalTitleListeners({
			layouts: [null, layout([{ paneId: "pane-1", kind: "diff" }])],
			registry,
			onTitleChange: () => {},
		});
		expect(liveInstanceObservers()).toBe(0);
	});

	it("stops waiting once torn down — a late instance installs nothing", () => {
		const { registry, subscriptions, registerInstance, liveInstanceObservers } =
			fakeRegistry([]);
		let synced = 0;
		const stop = subscribeTerminalTitleListeners({
			layouts: [layout([{ paneId: "pane-1", terminalId: "terminal-1" }])],
			registry,
			onTitleChange: () => {
				synced++;
			},
		});
		stop();
		expect(liveInstanceObservers()).toBe(0);

		registerInstance("terminal-1", "pane-1");
		expect(subscriptions).toHaveLength(0);
		expect(synced).toBe(0);
	});

	it("tears down a listener that was installed late", () => {
		const { registry, subscriptions, unsubscribed, registerInstance } =
			fakeRegistry([]);
		const stop = subscribeTerminalTitleListeners({
			layouts: [layout([{ paneId: "pane-1", terminalId: "terminal-1" }])],
			registry,
			onTitleChange: () => {},
		});
		registerInstance("terminal-1", "pane-1");
		expect(subscriptions).toHaveLength(1);
		stop();
		expect(unsubscribed).toHaveLength(1);
	});
});

/**
 * THE PARKED-RUNTIME ROUND TRIP.
 *
 * `disposeEntry` deletes the registry entry and `disposeTransport` clears that
 * transport's title listeners, while the pane stays in the PERSISTED layout —
 * so nothing about the layout changes and reconciliation never re-runs.
 * Re-opening the workspace recreates the exact pair and announces it. A helper
 * that only tracked initially-MISSING pairs had nothing left watching by then:
 * the recreated transport got no listener and its title never re-synced again.
 */
describe("(ALERT-CONTEXT-NAMES) disposed and recreated runtimes", () => {
	it("reinstalls the exact listener after a dispose, with no layout change", () => {
		const {
			registry,
			subscriptions,
			registerInstance,
			disposeInstance,
			fireTitle,
		} = fakeRegistry([["terminal-1", "pane-1"]]);
		let synced = 0;
		subscribeTerminalTitleListeners({
			layouts: [layout([{ paneId: "pane-1", terminalId: "terminal-1" }])],
			registry,
			onTitleChange: () => {
				synced++;
			},
		});
		// Present at reconciliation, so subscribed straight away and live.
		expect(subscriptions).toHaveLength(1);
		fireTitle("terminal-1", "pane-1");
		expect(synced).toBe(1);

		// The parked-runtime cap disposes it: entry gone, transport listeners
		// cleared. The pane is still in the layout.
		disposeInstance("terminal-1", "pane-1");
		fireTitle("terminal-1", "pane-1");
		expect(synced).toBe(1);

		// Re-opening the workspace recreates the exact pair. No layout change.
		registerInstance("terminal-1", "pane-1");

		expect(subscriptions).toHaveLength(2);
		expect(subscriptions[1]).toMatchObject({
			terminalId: "terminal-1",
			instanceId: "pane-1",
		});
		// The sync fires on re-registration — the fresh transport may already
		// carry a title, and it emits no event for one it was created with.
		expect(synced).toBe(2);
		// And the reinstalled listener is genuinely live.
		fireTitle("terminal-1", "pane-1");
		expect(synced).toBe(3);
	});

	it("survives several dispose/recreate cycles without leaking listeners", () => {
		const { registry, unsubscribed, registerInstance, disposeInstance } =
			fakeRegistry([["terminal-1", "pane-1"]]);
		const stop = subscribeTerminalTitleListeners({
			layouts: [layout([{ paneId: "pane-1", terminalId: "terminal-1" }])],
			registry,
			onTitleChange: () => {},
		});
		for (let i = 0; i < 3; i++) {
			disposeInstance("terminal-1", "pane-1");
			registerInstance("terminal-1", "pane-1");
		}
		// Each re-install replaced its predecessor rather than stacking.
		expect(unsubscribed).toHaveLength(3);
		stop();
		// Exactly one listener was live at teardown.
		expect(unsubscribed).toHaveLength(4);
	});

	it("only the recreated pair is re-subscribed, not its neighbours", () => {
		const { registry, subscriptions, registerInstance, disposeInstance } =
			fakeRegistry([
				["terminal-1", "pane-1"],
				["terminal-2", "pane-2"],
			]);
		subscribeTerminalTitleListeners({
			layouts: [
				layout([
					{ paneId: "pane-1", terminalId: "terminal-1" },
					{ paneId: "pane-2", terminalId: "terminal-2" },
				]),
			],
			registry,
			onTitleChange: () => {},
		});
		expect(subscriptions).toHaveLength(2);

		disposeInstance("terminal-2", "pane-2");
		registerInstance("terminal-2", "pane-2");
		expect(subscriptions).toHaveLength(3);
		expect(subscriptions[2]).toMatchObject({
			terminalId: "terminal-2",
			instanceId: "pane-2",
		});
	});

	it("ignores a recreation of a pair these layouts never wanted", () => {
		const { registry, subscriptions, registerInstance, disposeInstance } =
			fakeRegistry([["terminal-1", "pane-1"]]);
		let synced = 0;
		subscribeTerminalTitleListeners({
			layouts: [layout([{ paneId: "pane-1", terminalId: "terminal-1" }])],
			registry,
			onTitleChange: () => {
				synced++;
			},
		});
		disposeInstance("terminal-9", "pane-9");
		registerInstance("terminal-9", "pane-9");
		expect(subscriptions).toHaveLength(1);
		expect(synced).toBe(0);
	});

	it("stops reinstalling once torn down", () => {
		const { registry, subscriptions, registerInstance, disposeInstance } =
			fakeRegistry([["terminal-1", "pane-1"]]);
		const stop = subscribeTerminalTitleListeners({
			layouts: [layout([{ paneId: "pane-1", terminalId: "terminal-1" }])],
			registry,
			onTitleChange: () => {},
		});
		stop();
		disposeInstance("terminal-1", "pane-1");
		registerInstance("terminal-1", "pane-1");
		expect(subscriptions).toHaveLength(1);
	});
});
