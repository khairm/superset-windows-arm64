/**
 * (MANUAL-DISMISS) The 60-second periodic resync.
 *
 * The reconnect-triggered resync repairs a bus that DIED. It cannot repair a
 * disagreement that opens up while the socket stays UP — another window
 * dismissing a workspace's statuses is the case that motivated this: the host
 * knows, this renderer's socket saw nothing, and no reconnect is ever coming.
 *
 * What is asserted here is the tick's lifecycle, not the reconciliation itself
 * (`resyncAgentStatus.test.ts` owns that): it fires on an open socket, it never
 * overlaps a request already on the wire, and it stops when the socket does.
 */

import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	jest,
	mock,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// happy-dom over the preloaded plain-object document — this renders a real
// component tree. Bun runs test files sequentially in one process and
// happy-dom's globals are process-wide, so we MUST unregister in afterAll or
// unrelated renderer suites inherit readonly DOM globals.
const alreadyRegistered = GlobalRegistrator.isRegistered;
if (!alreadyRegistered) GlobalRegistrator.register();
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type ConnectionListener = (status: { state: string }) => void;

let connectionListeners: ConnectionListener[] = [];
let busState = "open";
let resyncCalls = 0;
let pendingResyncs: ((value: unknown) => void)[] = [];

/**
 * `mock.module` is PROCESS-GLOBAL and there is no unmock, so every stub here
 * outlives this file and is inherited by whatever bun runs next.
 *
 * Each one is therefore the REAL module with a single export overridden,
 * rather than a hand-written object: a stub that merely looks complete enough
 * for this test took down unrelated suites twice (a missing
 * `electronTrpc.createClient`, then a missing `setClientMachineId`), and it
 * would do so again the next time one of these modules grows an export.
 * electron-trpc is the exception — its export is a tRPC proxy that cannot be
 * spread — so that one names `createClient` explicitly. For the same reason
 * only the exports this test genuinely needs to neutralise are overridden: the
 * workspaces here have no hydrated pane layout, so the alert-context, title-
 * listener and lifecycle paths do nothing anyway and are left real.
 *
 * Re-installed in `beforeEach` too: another file mocking the same module wins
 * globally the moment it loads, whichever order bun picks.
 */
const realHostEventBus = await import("renderer/lib/host-event-bus");
const realHostServiceAuth = await import("renderer/lib/host-service-auth");
const realResyncAgentStatus = await import("../../lib/resyncAgentStatus");
const realCompanionAlertSync = await import("../../lib/companionAlertSync");

function installMocks(): void {
	mock.module("renderer/lib/electron-trpc", () => ({
		electronTrpc: {
			// `renderer/lib/trpc-client` calls this at module load.
			createClient: () => ({}),
			Provider: ({ children }: { children?: unknown }) => children,
			useContext: () => ({}),
			useUtils: () => ({}),
			settings: {
				getNotificationVolume: { useQuery: () => ({ data: 100 }) },
				getNotificationSoundsMuted: { useQuery: () => ({ data: false }) },
			},
		},
	}));

	mock.module("renderer/lib/host-event-bus", () => ({
		...realHostEventBus,
		getHostEventBus: () => ({
			on: () => () => {},
			subscribeConnectionStatus: (listener: ConnectionListener) => {
				connectionListeners.push(listener);
				return () => {
					connectionListeners = connectionListeners.filter(
						(entry) => entry !== listener,
					);
				};
			},
			retain: () => () => {},
			getConnectionStatus: () => ({ state: busState }),
		}),
	}));

	mock.module("renderer/lib/host-service-auth", () => ({
		...realHostServiceAuth,
		refreshHostServiceSecrets: async () => {},
	}));

	mock.module("../../lib/resyncAgentStatus", () => ({
		...realResyncAgentStatus,
		resyncAgentStatusFromHost: () => {
			resyncCalls++;
			return new Promise((resolve) => {
				pendingResyncs.push(resolve);
			});
		},
	}));

	// ONLY the sender is stubbed. The rest of this module is local bookkeeping
	// (the workspace→host map among it), and neutering that leaked into the
	// sidebar suite, whose companion report then had no host to go to.
	mock.module("../../lib/companionAlertSync", () => ({
		...realCompanionAlertSync,
		queueAlertContextSync: () => {},
	}));
}

installMocks();

const { act, cleanup, render } = await import("@testing-library/react");
const React = await import("react");
// Imported, not re-declared: a re-declared 60_000 keeps this suite green
// against a tuning change it no longer describes.
const { HostNotificationSubscriber, PERIODIC_RESYNC_MS, RESYNC_DEADLINE_MS } =
	await import("./HostNotificationSubscriber");

const HOST = "http://host-a";

const workspaces = [
	{ workspaceId: "workspace-1", workspaceName: "W", paneLayout: null },
];
/** A grown workspace set — a different `workspacesKey`, so a fresh resync. */
const moreWorkspaces = [
	...workspaces,
	{ workspaceId: "workspace-2", workspaceName: "W2", paneLayout: null },
];
const evenMoreWorkspaces = [
	...moreWorkspaces,
	{ workspaceId: "workspace-3", workspaceName: "W3", paneLayout: null },
];

/** Let the mocked resync settle so its `finally` releases the in-flight flag. */
async function settleResyncs(result: unknown = { applied: 0 }): Promise<void> {
	const resolvers = pendingResyncs;
	pendingResyncs = [];
	await act(async () => {
		for (const resolve of resolvers) resolve(result);
		await Promise.resolve();
		await Promise.resolve();
	});
}

function mount() {
	return render(
		React.createElement(HostNotificationSubscriber, {
			hostUrl: HOST,
			workspaces,
		}),
	);
}

/** Swap the workspace set, which is what moves `workspacesKey`. */
function rerenderWith(
	view: ReturnType<typeof mount>,
	next: typeof workspaces,
): void {
	act(() => {
		view.rerender(
			React.createElement(HostNotificationSubscriber, {
				hostUrl: HOST,
				workspaces: next,
			}),
		);
	});
}

function emitConnection(state: string): void {
	act(() => {
		for (const listener of [...connectionListeners]) listener({ state });
	});
}

describe("(MANUAL-DISMISS) HostNotificationSubscriber periodic resync", () => {
	beforeEach(() => {
		connectionListeners = [];
		busState = "open";
		resyncCalls = 0;
		pendingResyncs = [];
		installMocks();
		jest.useFakeTimers();
	});

	afterEach(() => {
		cleanup();
		jest.useRealTimers();
	});

	afterAll(async () => {
		if (!alreadyRegistered) await GlobalRegistrator.unregister();
	});

	/**
	 * `runResync` early-returns on an unchanged epoch+workspace key, and on a
	 * quiet socket that key never changes — the guard is there to stop hydration
	 * re-requesting, not to stop this. Clearing it is the tick's job.
	 */
	it("re-asks the host every interval on an open socket", async () => {
		mount();
		expect(resyncCalls).toBe(1);
		await settleResyncs();

		act(() => {
			jest.advanceTimersByTime(PERIODIC_RESYNC_MS);
		});
		expect(resyncCalls).toBe(2);
		await settleResyncs();

		act(() => {
			jest.advanceTimersByTime(PERIODIC_RESYNC_MS);
		});
		expect(resyncCalls).toBe(3);
		await settleResyncs();
	});

	/**
	 * The overlap the tick-local guard could not stop. A workspace-key change is
	 * an EDGE — it went straight past a guard that lived in `runPeriodicResync`
	 * — so it started resync B on top of a live resync A, and A's `finally` then
	 * released the shared flag while B was still on the wire, letting the next
	 * tick start C alongside B. Serialization now lives in `runResync`, which
	 * every caller goes through.
	 */
	it("defers a workspace-key change until the in-flight resync settles", async () => {
		const view = mount();
		expect(resyncCalls).toBe(1);

		// The mount's resync is deliberately left on the wire.
		rerenderWith(view, moreWorkspaces);
		expect(resyncCalls).toBe(1);

		// Deferred, not dropped: it runs the moment the first one settles.
		await settleResyncs();
		expect(resyncCalls).toBe(2);

		await settleResyncs();
		expect(resyncCalls).toBe(2);
	});

	/** Only the LATEST key is held — an intermediate set is already history. */
	it("collapses several mid-flight key changes into one follow-up", async () => {
		const view = mount();
		expect(resyncCalls).toBe(1);

		rerenderWith(view, moreWorkspaces);
		rerenderWith(view, evenMoreWorkspaces);
		expect(resyncCalls).toBe(1);

		await settleResyncs();
		expect(resyncCalls).toBe(2);

		await settleResyncs();
		expect(resyncCalls).toBe(2);
	});

	/**
	 * A tick that arrives mid-flight is SUPPRESSED rather than queued: it carries
	 * the same key the live request was issued under, so it has nothing to add.
	 * The next tick covers it.
	 *
	 * The in-flight request here is started OFF-CYCLE (a workspace-key change 45s
	 * into the interval) so the tick lands while it is still inside its deadline.
	 * A request started BY a tick is always older than the 30s deadline by the
	 * time the next one arrives, and the deadline has released it — which is the
	 * point of the deadline and is covered below.
	 */
	it("suppresses a tick while a resync is still in flight", async () => {
		const view = mount();
		expect(resyncCalls).toBe(1);
		await settleResyncs();

		act(() => {
			jest.advanceTimersByTime(45_000);
		});
		// Deliberately left unresolved, 15s short of the next tick.
		rerenderWith(view, moreWorkspaces);
		expect(resyncCalls).toBe(2);

		act(() => {
			jest.advanceTimersByTime(15_000);
		});
		expect(resyncCalls).toBe(2);

		await settleResyncs();
		act(() => {
			jest.advanceTimersByTime(PERIODIC_RESYNC_MS);
		});
		expect(resyncCalls).toBe(3);
		await settleResyncs();
	});

	it("stops ticking when the socket closes, and resumes on reconnect", async () => {
		mount();
		await settleResyncs();

		emitConnection("closed");
		act(() => {
			jest.advanceTimersByTime(PERIODIC_RESYNC_MS * 3);
		});
		expect(resyncCalls).toBe(1);

		// A reconnect runs its own resync and re-arms the interval.
		emitConnection("open");
		expect(resyncCalls).toBe(2);
		await settleResyncs();
		act(() => {
			jest.advanceTimersByTime(PERIODIC_RESYNC_MS);
		});
		expect(resyncCalls).toBe(3);
		await settleResyncs();
	});

	it("stops ticking on unmount", async () => {
		const view = mount();
		await settleResyncs();

		view.unmount();
		act(() => {
			jest.advanceTimersByTime(PERIODIC_RESYNC_MS * 3);
		});
		expect(resyncCalls).toBe(1);
	});

	/**
	 * A host that accepts the socket and then never answers the snapshot query.
	 * Nothing closes, so the disconnect path that clears the gate never runs, and
	 * the request's own settle is the thing that is not coming — without a
	 * deadline the tick is retired for the life of the socket.
	 */
	it("releases the gate after the deadline so the tick resumes on a hung request", async () => {
		mount();
		expect(resyncCalls).toBe(1);

		// Still inside the deadline: a slow-but-alive host must not be asked twice.
		act(() => {
			jest.advanceTimersByTime(RESYNC_DEADLINE_MS - 1_000);
		});
		expect(resyncCalls).toBe(1);

		// Past it, the abandoned request no longer owns the gate, so the next
		// periodic tick goes out. (Its own reply, if it ever lands, is discarded
		// by the generation guard.)
		act(() => {
			jest.advanceTimersByTime(PERIODIC_RESYNC_MS);
		});
		expect(resyncCalls).toBe(2);
	});

	/** A key queued behind a hung request is drained by the deadline, not lost. */
	it("drains a queued workspace key when the deadline expires", async () => {
		const view = mount();
		expect(resyncCalls).toBe(1);

		rerenderWith(view, moreWorkspaces);
		expect(resyncCalls).toBe(1);

		act(() => {
			jest.advanceTimersByTime(RESYNC_DEADLINE_MS);
		});
		expect(resyncCalls).toBe(2);
	});
});
