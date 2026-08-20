/**
 * (ALERT-CONTEXT-NAMES) The tab-context sender's ORDERING rules.
 *
 * This module is a small state machine over a network call, and every defect it
 * has had was an ordering one: a retry that resurrected a superseded snapshot, a
 * hash recorded for a send the host refused, a fast path that ignored an older
 * send still in flight. None of them are visible in a single call — they need
 * two overlapping ones — so they are tested here rather than reasoned about.
 *
 * The transport is faked at `getHostServiceClientByUrl`, which is the real seam:
 * everything above it is this module's own logic.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { AlertContextSnapshot } from "./alertContexts";

// --- transport double -------------------------------------------------------

interface SyncCall {
	workspaceId: string;
	tabCount: number;
	terminals: Array<{ terminalId: string; tabTitle: string | null }>;
	resolve: (accepted: boolean) => void;
	reject: (error: Error) => void;
}

interface SeenCall {
	workspaceId: string;
	terminalId: string;
	seenThroughAt: number;
	resolve: (accepted: boolean) => void;
	reject: (error: Error) => void;
}

interface RelaunchCall {
	boundaryMs: number;
	resolve: (accepted: boolean) => void;
	reject: (error: Error) => void;
}

let syncCalls: SyncCall[] = [];
let seenCalls: SeenCall[] = [];
let relaunchCalls: RelaunchCall[] = [];
/** When set, sync calls settle immediately with this acceptance. */
let autoAcceptSync: boolean | null = true;
let autoAcceptSeen: boolean | null = true;
let autoAcceptRelaunch: boolean | null = true;
/** When set, the relaunch mutation rejects instead of resolving. */
let relaunchThrows = false;

function makeClient() {
	return {
		companion: {
			syncAlertContexts: {
				mutate: (input: {
					workspaceId: string;
					tabCount: number;
					terminals: Array<{ terminalId: string; tabTitle: string | null }>;
				}) =>
					new Promise<{ accepted: boolean }>((resolve, reject) => {
						const call: SyncCall = {
							...input,
							resolve: (accepted) => resolve({ accepted }),
							reject,
						};
						syncCalls.push(call);
						if (autoAcceptSync !== null) call.resolve(autoAcceptSync);
					}),
			},
			markLifecycleSeen: {
				mutate: (input: {
					workspaceId: string;
					terminalId: string;
					seenThroughAt: number;
				}) =>
					new Promise<{ accepted: boolean }>((resolve, reject) => {
						const call: SeenCall = {
							...input,
							resolve: (accepted) => resolve({ accepted }),
							reject,
						};
						seenCalls.push(call);
						if (autoAcceptSeen !== null) call.resolve(autoAcceptSeen);
					}),
			},
			retireStaleReadyAlerts: {
				mutate: (input: { boundaryMs: number }) =>
					new Promise<{ accepted: boolean }>((resolve, reject) => {
						const call: RelaunchCall = {
							...input,
							resolve: (accepted) => resolve({ accepted }),
							reject,
						};
						relaunchCalls.push(call);
						if (relaunchThrows) {
							call.reject(new Error("host is down"));
							return;
						}
						if (autoAcceptRelaunch !== null) call.resolve(autoAcceptRelaunch);
					}),
			},
		},
	};
}

mock.module("renderer/lib/host-service-client", () => ({
	// The module is replaced whole. Without the query-policy helpers other
	// importers in this graph pull from it, running this file ON ITS OWN dies
	// with "Export named 'hostServiceQueryRetryDelay' not found" before a single
	// test executes.
	getHostServiceClient: () => ({}),
	isHostServiceConnectionError: () => false,
	hostServiceQueryRetry: () => false,
	hostServiceQueryRetryDelay: () => 0,
	getHostServiceClientByUrl: () => makeClient(),
}));

const {
	forgetAlertContextSyncsForHost,
	markTerminalSeenAndReportRead,
	queueAlertContextSync,
	registerWorkspaceHost,
	releaseAlertContextSync,
	reportRelaunchBoundary,
	reportTerminalSeen,
	resetRelaunchBoundaryLatchForTest,
	unregisterWorkspaceHost,
} = await import("./companionAlertSync");
const { useV2NotificationStore } = await import(
	"renderer/stores/v2-notifications"
);

// --- helpers ----------------------------------------------------------------

const HOST = "http://host-a";
const WORKSPACE = "workspace-1";
/** The module debounces by 250 ms; this clears it with slack. */
const DEBOUNCE_MS = 320;

function snapshot(
	tabCount: number,
	terminals: Array<[string, string]> = [["terminal-1", "A"]],
): AlertContextSnapshot {
	return {
		tabCount,
		terminals: terminals.map(([terminalId, tabTitle]) => ({
			terminalId,
			tabTitle,
		})),
	};
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Let the promise chain drain without advancing timers. */
const settle = async () => {
	for (let i = 0; i < 5; i++) await Promise.resolve();
};

async function flush(): Promise<void> {
	await wait(DEBOUNCE_MS);
	await settle();
}

beforeEach(() => {
	syncCalls = [];
	seenCalls = [];
	relaunchCalls = [];
	autoAcceptSync = true;
	autoAcceptSeen = true;
	autoAcceptRelaunch = true;
	relaunchThrows = false;
	resetRelaunchBoundaryLatchForTest();
	releaseAlertContextSync(WORKSPACE);
});

afterEach(() => {
	releaseAlertContextSync(WORKSPACE);
	unregisterWorkspaceHost(WORKSPACE, HOST);
});

// --- the hash guard ---------------------------------------------------------

describe("(ALERT-CONTEXT-NAMES) queueAlertContextSync", () => {
	it("sends one snapshot and carries the wire shape", async () => {
		queueAlertContextSync({
			workspaceId: WORKSPACE,
			hostUrl: HOST,
			snapshot: snapshot(3, [["terminal-1", "Claude"]]),
		});
		await flush();
		expect(syncCalls).toHaveLength(1);
		expect(syncCalls[0]).toMatchObject({
			workspaceId: WORKSPACE,
			tabCount: 3,
			terminals: [{ terminalId: "terminal-1", tabTitle: "Claude" }],
		});
	});

	it("sends `null` rather than an empty string for an absent title", async () => {
		queueAlertContextSync({
			workspaceId: WORKSPACE,
			hostUrl: HOST,
			snapshot: snapshot(1, [["terminal-1", ""]]),
		});
		await flush();
		expect(syncCalls[0]?.terminals).toEqual([
			{ terminalId: "terminal-1", tabTitle: null },
		]);
	});

	it("debounces a burst into ONE send carrying the last snapshot", async () => {
		for (const count of [1, 2, 3, 4]) {
			queueAlertContextSync({
				workspaceId: WORKSPACE,
				hostUrl: HOST,
				snapshot: snapshot(count),
			});
		}
		await flush();
		expect(syncCalls).toHaveLength(1);
		expect(syncCalls[0]?.tabCount).toBe(4);
	});

	it("suppresses a re-send of what the host already accepted", async () => {
		queueAlertContextSync({
			workspaceId: WORKSPACE,
			hostUrl: HOST,
			snapshot: snapshot(2),
		});
		await flush();
		expect(syncCalls).toHaveLength(1);

		queueAlertContextSync({
			workspaceId: WORKSPACE,
			hostUrl: HOST,
			snapshot: snapshot(2),
		});
		await flush();
		expect(syncCalls).toHaveLength(1);
	});

	it("does NOT remember a hash the host refused", async () => {
		// `accepted: false` is the documented transient while a bridge registers.
		// Recording it would leave the host permanently unaware of every title.
		autoAcceptSync = false;
		queueAlertContextSync({
			workspaceId: WORKSPACE,
			hostUrl: HOST,
			snapshot: snapshot(2),
		});
		await flush();
		expect(syncCalls).toHaveLength(1);

		autoAcceptSync = true;
		queueAlertContextSync({
			workspaceId: WORKSPACE,
			hostUrl: HOST,
			snapshot: snapshot(2),
		});
		await flush();
		expect(syncCalls).toHaveLength(2);
	});

	it("does not remember a hash whose transport threw", async () => {
		autoAcceptSync = null;
		queueAlertContextSync({
			workspaceId: WORKSPACE,
			hostUrl: HOST,
			snapshot: snapshot(2),
		});
		await wait(DEBOUNCE_MS);
		syncCalls[0]?.reject(new Error("socket died"));
		await settle();

		autoAcceptSync = true;
		queueAlertContextSync({
			workspaceId: WORKSPACE,
			hostUrl: HOST,
			snapshot: snapshot(2),
		});
		await flush();
		expect(syncCalls).toHaveLength(2);
	});
});

// --- the ordering defects ---------------------------------------------------

describe("(ALERT-CONTEXT-NAMES) sender ordering", () => {
	it("never lets an older in-flight send strand the host (the A/C inversion)", async () => {
		// Host on C. Queue A. Before A settles, queue C again. The equal-hash
		// fast path used to early-return for C, A then landed and was correctly
		// refused the hash — and nothing was left to push C. The host described A
		// forever and every future C was suppressed.
		queueAlertContextSync({
			workspaceId: WORKSPACE,
			hostUrl: HOST,
			snapshot: snapshot(3),
		});
		await flush();
		expect(syncCalls).toHaveLength(1);
		expect(syncCalls[0]?.tabCount).toBe(3);

		autoAcceptSync = null; // A parks in flight
		queueAlertContextSync({
			workspaceId: WORKSPACE,
			hostUrl: HOST,
			snapshot: snapshot(1),
		});
		await wait(DEBOUNCE_MS);
		expect(syncCalls).toHaveLength(2);

		// C queued again while A is still in flight.
		queueAlertContextSync({
			workspaceId: WORKSPACE,
			hostUrl: HOST,
			snapshot: snapshot(3),
		});
		autoAcceptSync = true;
		syncCalls[1]?.resolve(true); // A lands
		await flush();

		// The host must end up on C, not stranded on A.
		expect(syncCalls.length).toBeGreaterThanOrEqual(3);
		expect(syncCalls.at(-1)?.tabCount).toBe(3);
	});

	it("a readiness retry sends the LATEST snapshot, never the one it was armed for", async () => {
		// A refused (arms a retry), B accepted, retry fires — it must not
		// resurrect A.
		autoAcceptSync = false;
		queueAlertContextSync({
			workspaceId: WORKSPACE,
			hostUrl: HOST,
			snapshot: snapshot(1),
		});
		await flush();
		expect(syncCalls).toHaveLength(1);
		expect(syncCalls[0]?.tabCount).toBe(1);

		autoAcceptSync = true;
		queueAlertContextSync({
			workspaceId: WORKSPACE,
			hostUrl: HOST,
			snapshot: snapshot(9),
		});
		await flush();
		expect(syncCalls.at(-1)?.tabCount).toBe(9);

		// Past the first retry backoff (1 s). Nothing older may appear.
		await wait(1_400);
		await settle();
		for (const call of syncCalls) {
			expect(call.tabCount === 1 && syncCalls.indexOf(call) > 0).toBe(false);
		}
		expect(syncCalls.at(-1)?.tabCount).toBe(9);
	});

	it("cancels an armed retry once the desired snapshot is already accepted", async () => {
		autoAcceptSync = false;
		queueAlertContextSync({
			workspaceId: WORKSPACE,
			hostUrl: HOST,
			snapshot: snapshot(4),
		});
		await flush();
		const afterFirst = syncCalls.length;

		autoAcceptSync = true;
		queueAlertContextSync({
			workspaceId: WORKSPACE,
			hostUrl: HOST,
			snapshot: snapshot(5),
		});
		await flush();
		const afterAccept = syncCalls.length;

		// Re-queueing the accepted snapshot is a no-op AND disarms the retry.
		queueAlertContextSync({
			workspaceId: WORKSPACE,
			hostUrl: HOST,
			snapshot: snapshot(5),
		});
		await wait(1_400);
		await settle();
		expect(syncCalls.length).toBe(afterAccept);
		expect(afterAccept).toBeGreaterThan(afterFirst);
	});

	it("re-sends in full after a reconnect forgets the host's state", async () => {
		queueAlertContextSync({
			workspaceId: WORKSPACE,
			hostUrl: HOST,
			snapshot: snapshot(2),
		});
		await flush();
		expect(syncCalls).toHaveLength(1);

		forgetAlertContextSyncsForHost(HOST);
		queueAlertContextSync({
			workspaceId: WORKSPACE,
			hostUrl: HOST,
			snapshot: snapshot(2),
		});
		await flush();
		// The host is a new process as far as we know: the same snapshot must go
		// again rather than be suppressed by a hash it no longer holds.
		expect(syncCalls).toHaveLength(2);
	});

	it("re-sends in full when the workspace moves to another host", async () => {
		queueAlertContextSync({
			workspaceId: WORKSPACE,
			hostUrl: HOST,
			snapshot: snapshot(2),
		});
		await flush();

		queueAlertContextSync({
			workspaceId: WORKSPACE,
			hostUrl: "http://host-b",
			snapshot: snapshot(2),
		});
		await flush();
		expect(syncCalls).toHaveLength(2);
	});

	it("stops sending for a released workspace", async () => {
		queueAlertContextSync({
			workspaceId: WORKSPACE,
			hostUrl: HOST,
			snapshot: snapshot(2),
		});
		releaseAlertContextSync(WORKSPACE);
		await flush();
		expect(syncCalls).toHaveLength(0);
	});
});

// --- the seen report --------------------------------------------------------

describe("(ALERT-CONTEXT-NAMES) reportTerminalSeen", () => {
	it("resolves true when a bridge consumed it", async () => {
		registerWorkspaceHost(WORKSPACE, HOST);
		await expect(
			reportTerminalSeen({
				workspaceId: WORKSPACE,
				terminalId: "terminal-1",
				seenThroughAt: 1_000,
			}),
		).resolves.toBe(true);
		expect(seenCalls).toHaveLength(1);
		expect(seenCalls[0]).toMatchObject({
			terminalId: "terminal-1",
			seenThroughAt: 1_000,
		});
	});

	it("resolves FALSE when no bridge consumed it — the caller must not call that a repair", async () => {
		registerWorkspaceHost(WORKSPACE, HOST);
		autoAcceptSeen = false;
		await expect(
			reportTerminalSeen({
				workspaceId: WORKSPACE,
				terminalId: "terminal-1",
				seenThroughAt: 1_000,
			}),
		).resolves.toBe(false);
	});

	it("resolves false rather than rejecting when the transport throws", async () => {
		registerWorkspaceHost(WORKSPACE, HOST);
		autoAcceptSeen = null;
		const pending = reportTerminalSeen({
			workspaceId: WORKSPACE,
			terminalId: "terminal-1",
			seenThroughAt: 1_000,
		});
		seenCalls[0]?.reject(new Error("host gone"));
		await expect(pending).resolves.toBe(false);
	});

	it("sends nothing for a workspace whose host is unknown", async () => {
		unregisterWorkspaceHost(WORKSPACE, HOST);
		await expect(
			reportTerminalSeen({
				workspaceId: WORKSPACE,
				terminalId: "terminal-1",
				seenThroughAt: 1_000,
			}),
		).resolves.toBe(false);
		expect(seenCalls).toHaveLength(0);
	});

	it("refuses a non-epoch stamp rather than hashing nonsense into an alert id", async () => {
		registerWorkspaceHost(WORKSPACE, HOST);
		for (const seenThroughAt of [0, -1, 1.5, Number.NaN]) {
			await expect(
				reportTerminalSeen({
					workspaceId: WORKSPACE,
					terminalId: "terminal-1",
					seenThroughAt,
				}),
			).resolves.toBe(false);
		}
		expect(seenCalls).toHaveLength(0);
	});

	it("does not let one workspace's unregister silence another host's mapping", async () => {
		registerWorkspaceHost(WORKSPACE, HOST);
		// A stale subscriber for a host that no longer owns it must not clear the
		// mapping the current one installed.
		unregisterWorkspaceHost(WORKSPACE, "http://some-other-host");
		await expect(
			reportTerminalSeen({
				workspaceId: WORKSPACE,
				terminalId: "terminal-1",
				seenThroughAt: 1_000,
			}),
		).resolves.toBe(true);
	});
});

/**
 * (ONE-BUZZ-UNTIL-READ) THE SCENARIO THIS EXISTS FOR, end to end through the
 * real store:
 *
 *   1. the agent finishes while the user is away — green dot, `g` on the phone;
 *   2. the agent starts working again — the dot goes yellow, and the phone is
 *      still showing the finish from step 1;
 *   3. the user opens that chat.
 *
 * Step 3 is a read. Before the outstanding record there was no green left to
 * clear at step 3, so nothing was reported and the notification sat there until
 * its TTL expired.
 */
describe("(ONE-BUZZ-UNTIL-READ) markTerminalSeenAndReportRead", () => {
	const TERMINAL = "terminal-1";
	const source = { type: "terminal", id: TERMINAL } as const;

	beforeEach(() => {
		useV2NotificationStore.setState({
			sources: {},
			terminalSeenAt: {},
			outstandingReadyAt: {},
		});
		registerWorkspaceHost(WORKSPACE, HOST);
	});

	function finish(at: number): void {
		useV2NotificationStore
			.getState()
			.applySourceAxes(source, WORKSPACE, { set: ["review"], clear: [] }, at);
	}

	function startsWorking(at: number): void {
		useV2NotificationStore
			.getState()
			.applySourceAxes(
				source,
				WORKSPACE,
				{ set: ["working"], clear: ["permission", "review"] },
				at,
			);
	}

	it("reports the OUTSTANDING finish when the chat is already running again", async () => {
		finish(5_000);
		startsWorking(6_000);
		expect(
			useV2NotificationStore.getState().sources["terminal:terminal-1"]?.status,
		).toBe("working");

		markTerminalSeenAndReportRead({
			workspaceId: WORKSPACE,
			terminalId: TERMINAL,
			lastEventAt: 6_000,
		});
		await settle();

		// The subject is the FINISH's instant — the one the alert id hashed — not
		// the binding's `lastEventAt`, which has moved on to the `Start`.
		expect(seenCalls).toHaveLength(1);
		expect(seenCalls[0]).toMatchObject({
			terminalId: TERMINAL,
			seenThroughAt: 5_000,
		});
		// Consumed, so the record is retired and a second focus is silent.
		expect(
			useV2NotificationStore.getState().outstandingReadyAt[TERMINAL],
		).toBeUndefined();
		markTerminalSeenAndReportRead({
			workspaceId: WORKSPACE,
			terminalId: TERMINAL,
			lastEventAt: 6_000,
		});
		await settle();
		expect(seenCalls).toHaveLength(1);
	});

	it("prefers the LIVE green over the record when the dot is still up", async () => {
		finish(5_000);
		markTerminalSeenAndReportRead({
			workspaceId: WORKSPACE,
			terminalId: TERMINAL,
			lastEventAt: 7_000,
		});
		await settle();
		expect(seenCalls[0]).toMatchObject({ seenThroughAt: 5_000 });
	});

	it("keeps the record when no host consumed the report", async () => {
		autoAcceptSeen = false;
		finish(5_000);
		startsWorking(6_000);
		markTerminalSeenAndReportRead({
			workspaceId: WORKSPACE,
			terminalId: TERMINAL,
			lastEventAt: 6_000,
		});
		await settle();
		expect(seenCalls).toHaveLength(1);
		// Still outstanding: the resync sweep is what retries it.
		expect(useV2NotificationStore.getState().outstandingReadyAt[TERMINAL]).toBe(
			5_000,
		);
	});

	it("reports NOTHING for a terminal with no green and no record", async () => {
		markTerminalSeenAndReportRead({
			workspaceId: WORKSPACE,
			terminalId: TERMINAL,
			lastEventAt: 6_000,
		});
		await settle();
		expect(seenCalls).toHaveLength(0);
		// It still recorded the seen mark — the report is what is gated.
		expect(useV2NotificationStore.getState().terminalSeenAt[TERMINAL]).toBe(
			6_000,
		);
	});

	it("reports nothing for a red — a permission is not a finish", async () => {
		useV2NotificationStore
			.getState()
			.applySourceAxes(
				source,
				WORKSPACE,
				{ set: ["permission"], clear: [] },
				5_000,
			);
		markTerminalSeenAndReportRead({
			workspaceId: WORKSPACE,
			terminalId: TERMINAL,
			lastEventAt: 6_000,
		});
		await settle();
		expect(seenCalls).toHaveLength(0);
	});

	/**
	 * (ONE-BUZZ-UNTIL-READ) The in-flight race. The report is a round trip and
	 * the agent keeps working during it, so a newer finish can land before the
	 * older read is acknowledged. Clearing unconditionally on that
	 * acknowledgement would delete the NEWER record, and the newer notification
	 * would then have no evidence left to retract it.
	 */
	it("keeps a finish that lands while an older report is in flight", async () => {
		autoAcceptSeen = null; // hold the mutation open
		finish(5_000);
		startsWorking(6_000);
		markTerminalSeenAndReportRead({
			workspaceId: WORKSPACE,
			terminalId: TERMINAL,
			lastEventAt: 6_000,
		});
		await settle();
		expect(seenCalls).toHaveLength(1);

		// B finishes while A's report is still open.
		finish(7_000);
		seenCalls[0]?.resolve(true);
		await settle();

		expect(useV2NotificationStore.getState().outstandingReadyAt[TERMINAL]).toBe(
			7_000,
		);

		// And B is still reportable: opening the chat again names B, not A.
		autoAcceptSeen = true;
		startsWorking(8_000);
		markTerminalSeenAndReportRead({
			workspaceId: WORKSPACE,
			terminalId: TERMINAL,
			lastEventAt: 8_000,
		});
		await settle();
		expect(seenCalls).toHaveLength(2);
		expect(seenCalls[1]).toMatchObject({ seenThroughAt: 7_000 });
		expect(
			useV2NotificationStore.getState().outstandingReadyAt[TERMINAL],
		).toBeUndefined();
	});
});

// --- (ALERT-RETIRE-ON-EXIT) the relaunch boundary ---------------------------

/**
 * (ALERT-RETIRE-ON-EXIT) The boundary is a ONCE-PER-LAUNCH statement, and the
 * latch is what keeps it one. Everything here is about that latch: what sets
 * it, what must not, and what a report the host refused leaves behind.
 */
describe("(ALERT-RETIRE-ON-EXIT) reportRelaunchBoundary", () => {
	it("sends the boundary and answers true on acceptance", async () => {
		await expect(
			reportRelaunchBoundary({ hostUrl: HOST, boundaryMs: 1_700_000_000_000 }),
		).resolves.toBe(true);
		expect(relaunchCalls).toHaveLength(1);
		expect(relaunchCalls[0]?.boundaryMs).toBe(1_700_000_000_000);
	});

	it("says nothing a second time — the host already took this launch", async () => {
		await reportRelaunchBoundary({
			hostUrl: HOST,
			boundaryMs: 1_700_000_000_000,
		});
		await expect(
			reportRelaunchBoundary({ hostUrl: HOST, boundaryMs: 1_700_000_000_000 }),
		).resolves.toBe(false);
		expect(relaunchCalls).toHaveLength(1);
	});

	it("RETRIES after a host that refused it", async () => {
		autoAcceptRelaunch = false;
		await expect(
			reportRelaunchBoundary({ hostUrl: HOST, boundaryMs: 1_700_000_000_000 }),
		).resolves.toBe(false);

		autoAcceptRelaunch = true;
		await expect(
			reportRelaunchBoundary({ hostUrl: HOST, boundaryMs: 1_700_000_000_000 }),
		).resolves.toBe(true);
		expect(relaunchCalls).toHaveLength(2);
	});

	it("never rejects when the transport throws, and retries after", async () => {
		relaunchThrows = true;
		await expect(
			reportRelaunchBoundary({ hostUrl: HOST, boundaryMs: 1_700_000_000_000 }),
		).resolves.toBe(false);

		relaunchThrows = false;
		await expect(
			reportRelaunchBoundary({ hostUrl: HOST, boundaryMs: 1_700_000_000_000 }),
		).resolves.toBe(true);
		expect(relaunchCalls).toHaveLength(2);
	});

	it("refuses a non-integer boundary without touching the wire", async () => {
		await expect(
			reportRelaunchBoundary({
				hostUrl: HOST,
				boundaryMs: 1_700_000_000_000.7,
			}),
		).resolves.toBe(false);
		await expect(
			reportRelaunchBoundary({ hostUrl: HOST, boundaryMs: 0 }),
		).resolves.toBe(false);
		await expect(
			reportRelaunchBoundary({ hostUrl: HOST, boundaryMs: -1 }),
		).resolves.toBe(false);
		await expect(
			reportRelaunchBoundary({ hostUrl: HOST, boundaryMs: Number.NaN }),
		).resolves.toBe(false);
		await expect(
			reportRelaunchBoundary({
				hostUrl: HOST,
				boundaryMs: Number.POSITIVE_INFINITY,
			}),
		).resolves.toBe(false);
		expect(relaunchCalls).toHaveLength(0);
		// And a refusal is not a latch: the real boundary still goes.
		await expect(
			reportRelaunchBoundary({ hostUrl: HOST, boundaryMs: 1_700_000_000_000 }),
		).resolves.toBe(true);
	});

	it("latches PER HOST", async () => {
		await reportRelaunchBoundary({ hostUrl: HOST, boundaryMs: 1_000 });
		await expect(
			reportRelaunchBoundary({ hostUrl: "http://host-b", boundaryMs: 1_000 }),
		).resolves.toBe(true);
		expect(relaunchCalls).toHaveLength(2);
	});

	it("survives a host RECONNECT — a reconnect is not a new launch", async () => {
		await reportRelaunchBoundary({ hostUrl: HOST, boundaryMs: 1_000 });
		// The reconnect repair drops the tab-context memory for this host. The
		// launch boundary is NOT part of that memory: the app did not relaunch.
		forgetAlertContextSyncsForHost(HOST);
		await expect(
			reportRelaunchBoundary({ hostUrl: HOST, boundaryMs: 1_000 }),
		).resolves.toBe(false);
		expect(relaunchCalls).toHaveLength(1);
	});
});
