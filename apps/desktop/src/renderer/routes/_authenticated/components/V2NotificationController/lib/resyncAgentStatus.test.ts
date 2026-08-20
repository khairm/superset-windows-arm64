/**
 * (ALERT-CONTEXT-NAMES) The resync's COMPANION REPAIR path.
 *
 * The repair re-sends a "the user read this chat" report that never reached its
 * host — the desktop was closed, or the bus was dead, when the user cleared the
 * dot. Everything about it is a judgement call about evidence, and the two
 * defects it has had were both about eligibility rather than mechanics: one made
 * the branch unreachable in its own headline case, the other recorded a failed
 * attempt as a completed repair.
 *
 * Only the repair is exercised here. The surrounding dot reconciliation has its
 * own coverage and is deliberately left alone.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

interface SeenCall {
	workspaceId: string;
	terminalId: string;
	seenThroughAt: number;
}

let seenCalls: SeenCall[] = [];
/**
 * (ALERT-RETIRE-ON-EXIT) Every relaunch boundary the resync reported.
 *
 * `seenAtReport` is the seeded seen mark for `terminal-1` AS THE REPORT WENT
 * OUT. The host answers this report by retracting pre-launch ready cards, so
 * the ordering it pins is a safety property, not a detail: the report may only
 * leave after the reconciliation that took those finishes over.
 */
let relaunchCalls: Array<{
	hostUrl: string;
	boundaryMs: number;
	seenAtReport: number | undefined;
}> = [];
let acceptSeen = true;
let rejectSeen = false;
let snapshotRows: SnapshotRow[] = [];
let knownTerminalIds: string[] = [];
let hostNow: number | undefined = 10_000;

interface SnapshotRow {
	terminalId: string;
	originWorkspaceId: string;
	lastEventType: string;
	lastEventAt: number;
	pendingPermission: boolean | null;
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
	getHostServiceClientByUrl: (hostUrl: string) => ({
		notifications: {
			agentStatusSnapshot: {
				query: async () => ({
					rows: snapshotRows,
					knownTerminalIds,
					hostNow,
				}),
			},
		},
		companion: {
			markLifecycleSeen: {
				mutate: async (input: SeenCall) => {
					seenCalls.push(input);
					if (rejectSeen) throw new Error("host gone");
					return { accepted: acceptSeen };
				},
			},
			syncAlertContexts: {
				mutate: async () => ({ accepted: true }),
			},
			retireStaleReadyAlerts: {
				mutate: async (input: { boundaryMs: number }) => {
					relaunchCalls.push({
						hostUrl,
						boundaryMs: input.boundaryMs,
						seenAtReport:
							useV2NotificationStore.getState().terminalSeenAt["terminal-1"],
					});
					return { accepted: true };
				},
			},
		},
	}),
}));

const { useV2NotificationStore } = await import(
	"renderer/stores/v2-notifications"
);
const { resetV2NotificationStoreForTest } = await import(
	"renderer/stores/v2-notifications/resetForTest"
);
const {
	registerWorkspaceHost,
	resetRelaunchBoundaryLatchForTest,
	unregisterWorkspaceHost,
} = await import("./companionAlertSync");
const {
	__peekRepairOutcomeForTest,
	__resetColdStartForTest,
	__resetRepairCooldownsForTest,
	resyncAgentStatusFromHost,
} = await import("./resyncAgentStatus");

const HOST = "http://host-a";
const WORKSPACE = "workspace-1";

function workspaces() {
	return new Map([
		[
			WORKSPACE,
			{ workspaceId: WORKSPACE, workspaceName: "W", paneLayout: null },
		],
	]);
}

function row(overrides: Partial<SnapshotRow> = {}): SnapshotRow {
	return {
		terminalId: "terminal-1",
		originWorkspaceId: WORKSPACE,
		// A clean turn end — the shape that raises a green.
		lastEventType: "Stop",
		lastEventAt: 5_000,
		pendingPermission: false,
		...overrides,
	};
}

/** The user has read this terminal through `at` (host clock). */
function seenThrough(terminalId: string, at: number): void {
	useV2NotificationStore.setState((state) => ({
		terminalSeenAt: { ...state.terminalSeenAt, [terminalId]: at },
	}));
}

/**
 * (ONE-BUZZ-UNTIL-READ) A finish this machine saw go green and has not yet had
 * a host confirm as read — the phone is still showing it.
 */
function outstandingReady(terminalId: string, at: number): void {
	useV2NotificationStore.setState((state) => ({
		outstandingReadyAt: { ...state.outstandingReadyAt, [terminalId]: at },
	}));
}

const settle = async () => {
	for (let i = 0; i < 6; i++) await Promise.resolve();
};

beforeEach(() => {
	seenCalls = [];
	relaunchCalls = [];
	acceptSeen = true;
	rejectSeen = false;
	snapshotRows = [row()];
	knownTerminalIds = ["terminal-1"];
	hostNow = 10_000;
	__resetRepairCooldownsForTest();
	registerWorkspaceHost(WORKSPACE, HOST);
	resetV2NotificationStoreForTest();
});

afterEach(() => {
	unregisterWorkspaceHost(WORKSPACE, HOST);
	__resetRepairCooldownsForTest();
});

describe("(ALERT-CONTEXT-NAMES) resync companion repair — eligibility", () => {
	/**
	 * THE HEADLINE CASE, and the one an earlier revision could not reach. When
	 * the user is sitting ON the pane, the replay routes through `targetVisible`
	 * and CLEARS the source instead of setting `review` — so an eligibility test
	 * that read the store's post-replay entry found nothing to repair in exactly
	 * the situation the repair exists for (dot cleared, mutation lost, user still
	 * on that pane at reconnect).
	 */
	it("repairs a read terminal even though the replay left no review entry", async () => {
		seenThrough("terminal-1", 5_000);
		const result = await resyncAgentStatusFromHost({
			hostUrl: HOST,
			workspaces: workspaces(),
		});
		await settle();
		expect(
			useV2NotificationStore.getState().sources["terminal:terminal-1"]?.status,
		).not.toBe("review");
		expect(seenCalls).toEqual([
			{
				workspaceId: WORKSPACE,
				terminalId: "terminal-1",
				seenThroughAt: 5_000,
			},
		]);
		expect(result?.seenRepairsSent).toBe(1);
	});

	it("does not repair a green the user has NOT read through", async () => {
		seenThrough("terminal-1", 4_999);
		await resyncAgentStatusFromHost({
			hostUrl: HOST,
			workspaces: workspaces(),
		});
		await settle();
		expect(seenCalls).toHaveLength(0);
	});

	/**
	 * (ONE-BUZZ-UNTIL-READ) The replay paints a green for this row, but a
	 * re-derivation of the past is not evidence that a device is holding a
	 * notification — and inventing a record here would make the NEXT resync
	 * report a read for it.
	 */
	it("does not invent an outstanding record out of its own replay", async () => {
		seenThrough("terminal-1", 4_999);
		await resyncAgentStatusFromHost({
			hostUrl: HOST,
			workspaces: workspaces(),
		});
		await settle();
		const state = useV2NotificationStore.getState();
		expect(state.sources["terminal:terminal-1"]?.status).toBe("review");
		expect(state.outstandingReadyAt["terminal-1"]).toBeUndefined();
	});

	it("does not repair a terminal with no seen mark at all", async () => {
		await resyncAgentStatusFromHost({
			hostUrl: HOST,
			workspaces: workspaces(),
		});
		await settle();
		expect(seenCalls).toHaveLength(0);
	});

	/**
	 * (ONE-BUZZ-UNTIL-READ) The row's last event is a `Start`: nothing about it
	 * would raise a green, so the eligibility test above never looks at it — yet
	 * the phone is still holding the finish from before it, and the seen mark
	 * says the user read the chat. The outstanding record is the only thing that
	 * knows which finish that was.
	 */
	it("repairs an OUTSTANDING finish whose row has moved on to a Start", async () => {
		snapshotRows = [row({ lastEventType: "Start", lastEventAt: 6_000 })];
		outstandingReady("terminal-1", 5_000);
		seenThrough("terminal-1", 6_000);
		const result = await resyncAgentStatusFromHost({
			hostUrl: HOST,
			workspaces: workspaces(),
		});
		await settle();
		expect(seenCalls).toEqual([
			{
				workspaceId: WORKSPACE,
				terminalId: "terminal-1",
				// The FINISH's instant, not the `Start` the row now rests on.
				seenThroughAt: 5_000,
			},
		]);
		expect(result?.seenRepairsSent).toBe(1);
		expect(
			useV2NotificationStore.getState().outstandingReadyAt["terminal-1"],
		).toBeUndefined();
	});

	it("does not repair an outstanding finish the user has not read past", async () => {
		snapshotRows = [row({ lastEventType: "Start", lastEventAt: 6_000 })];
		outstandingReady("terminal-1", 5_000);
		seenThrough("terminal-1", 4_000);
		await resyncAgentStatusFromHost({
			hostUrl: HOST,
			workspaces: workspaces(),
		});
		await settle();
		expect(seenCalls).toHaveLength(0);
	});

	it("keeps an outstanding record no host consumed", async () => {
		acceptSeen = false;
		snapshotRows = [row({ lastEventType: "Start", lastEventAt: 6_000 })];
		outstandingReady("terminal-1", 5_000);
		seenThrough("terminal-1", 6_000);
		await resyncAgentStatusFromHost({
			hostUrl: HOST,
			workspaces: workspaces(),
		});
		await settle();
		expect(seenCalls).toHaveLength(1);
		expect(
			useV2NotificationStore.getState().outstandingReadyAt["terminal-1"],
		).toBe(5_000);
	});

	it("does not repair an event that would never have raised a green", async () => {
		// `Attached` is an idle signal — no axes at all, so no alert ever existed.
		snapshotRows = [row({ lastEventType: "Attached" })];
		seenThrough("terminal-1", 5_000);
		await resyncAgentStatusFromHost({
			hostUrl: HOST,
			workspaces: workspaces(),
		});
		await settle();
		expect(seenCalls).toHaveLength(0);
	});

	it("does not repair a turn-end that landed on a PENDING PERMISSION", async () => {
		// The real transition clears rather than greens for this row, so no `g`
		// alert was minted and there is nothing to retract. Passing an empty
		// `statuses` map would have hidden the pending permission and called it
		// eligible.
		snapshotRows = [row({ pendingPermission: true })];
		seenThrough("terminal-1", 5_000);
		await resyncAgentStatusFromHost({
			hostUrl: HOST,
			workspaces: workspaces(),
		});
		await settle();
		expect(seenCalls).toHaveLength(0);
	});

	it("skips a row whose workspace this subscriber does not own", async () => {
		snapshotRows = [row({ originWorkspaceId: "someone-elses-workspace" })];
		seenThrough("terminal-1", 5_000);
		await resyncAgentStatusFromHost({
			hostUrl: HOST,
			workspaces: workspaces(),
		});
		await settle();
		expect(seenCalls).toHaveLength(0);
	});
});

describe("(ALERT-CONTEXT-NAMES) resync companion repair — bounds and rotation", () => {
	function manyRows(count: number): SnapshotRow[] {
		return Array.from({ length: count }, (_, i) =>
			row({ terminalId: `terminal-${i}` }),
		);
	}

	it("caps one epoch and defers the rest rather than bursting", async () => {
		snapshotRows = manyRows(25);
		knownTerminalIds = snapshotRows.map((r) => r.terminalId);
		for (const r of snapshotRows) seenThrough(r.terminalId, 5_000);

		const result = await resyncAgentStatusFromHost({
			hostUrl: HOST,
			workspaces: workspaces(),
		});
		await settle();
		expect(result?.seenRepairsSent).toBe(10);
		expect(result?.seenRepairsDeferred).toBe(15);
		expect(seenCalls).toHaveLength(10);
	});

	it("ROTATES: the next epoch covers rows the last one could not", async () => {
		snapshotRows = manyRows(25);
		knownTerminalIds = snapshotRows.map((r) => r.terminalId);
		for (const r of snapshotRows) seenThrough(r.terminalId, 5_000);

		await resyncAgentStatusFromHost({
			hostUrl: HOST,
			workspaces: workspaces(),
		});
		await settle();
		const firstBatch = seenCalls.map((call) => call.terminalId);
		expect(firstBatch).toHaveLength(10);

		seenCalls = [];
		await resyncAgentStatusFromHost({
			hostUrl: HOST,
			workspaces: workspaces(),
		});
		await settle();
		const secondBatch = seenCalls.map((call) => call.terminalId);
		expect(secondBatch).toHaveLength(10);
		// Without the cooldown, every epoch re-spent its whole budget on the same
		// first ten rows and everything past them starved forever.
		for (const terminalId of secondBatch) {
			expect(firstBatch).not.toContain(terminalId);
		}
	});

	it("does not re-report a terminal it has just repaired", async () => {
		seenThrough("terminal-1", 5_000);
		await resyncAgentStatusFromHost({
			hostUrl: HOST,
			workspaces: workspaces(),
		});
		await settle();
		expect(seenCalls).toHaveLength(1);

		seenCalls = [];
		const result = await resyncAgentStatusFromHost({
			hostUrl: HOST,
			workspaces: workspaces(),
		});
		await settle();
		expect(seenCalls).toHaveLength(0);
		expect(result?.seenRepairsSkipped).toBe(1);
	});
});

describe("(ALERT-CONTEXT-NAMES) resync companion repair — failure is not repair", () => {
	it("records an ACCEPTED report under the long repair cooldown", async () => {
		seenThrough("terminal-1", 5_000);
		await resyncAgentStatusFromHost({
			hostUrl: HOST,
			workspaces: workspaces(),
		});
		await settle();
		expect(__peekRepairOutcomeForTest(`${HOST}:terminal-1`)).toBe("repaired");
	});

	it("records an UNCONSUMED report under the short retry cooldown", async () => {
		// `accepted: false` is the documented transient while a host's bridge
		// finishes registering. Filing it as a repair would suppress the retry for
		// half an hour and lose the retraction entirely.
		acceptSeen = false;
		seenThrough("terminal-1", 5_000);
		await resyncAgentStatusFromHost({
			hostUrl: HOST,
			workspaces: workspaces(),
		});
		await settle();
		expect(__peekRepairOutcomeForTest(`${HOST}:terminal-1`)).toBe("failed");
	});

	it("records a REJECTED report under the short retry cooldown too", async () => {
		rejectSeen = true;
		seenThrough("terminal-1", 5_000);
		await resyncAgentStatusFromHost({
			hostUrl: HOST,
			workspaces: workspaces(),
		});
		await settle();
		expect(__peekRepairOutcomeForTest(`${HOST}:terminal-1`)).toBe("failed");
	});

	it("keys the cooldown per HOST, so two hosts' terminals are separate subjects", async () => {
		seenThrough("terminal-1", 5_000);
		await resyncAgentStatusFromHost({
			hostUrl: HOST,
			workspaces: workspaces(),
		});
		await settle();
		expect(__peekRepairOutcomeForTest(`${HOST}:terminal-1`)).not.toBeNull();
		expect(__peekRepairOutcomeForTest("http://host-b:terminal-1")).toBeNull();
	});
});
/**
 * (MANUAL-DISMISS) `pendingPermission: false` — the answer the loop used to
 * throw away.
 *
 * The host reads its marker directory and gives one of three answers: a
 * question is pending, none is, or it could not tell. Only the first two were
 * ever acted on, and "none is" is the retraction half: a red latched from a
 * question whose answer arrived while the bus was down, or one the user has
 * since dismissed, was RE-CONFIRMED by every resync instead of being taken
 * down by it. The replayed `lastEventType` cannot do the job — a turn-end
 * carries no answer-evidence and deliberately leaves the permission axis alone.
 */
describe("(MANUAL-DISMISS) pendingPermission: false retracts a latched red", () => {
	const source = { type: "terminal", id: "terminal-1" } as const;

	function latchRed(workspaceId: string, at: number): void {
		useV2NotificationStore
			.getState()
			.applySourceAxes(
				source,
				workspaceId,
				{ set: ["permission"], clear: [] },
				at,
			);
	}

	it("clears the permission axis the host says nothing backs", async () => {
		latchRed(WORKSPACE, 1_000);
		snapshotRows = [row({ lastEventAt: 5_000, pendingPermission: false })];

		const result = await resyncAgentStatusFromHost({
			hostUrl: HOST,
			workspaces: workspaces(),
		});
		await settle();

		const entry =
			useV2NotificationStore.getState().sources["terminal:terminal-1"];
		expect(entry?.axes.permission).toBeUndefined();
		expect(entry?.status).not.toBe("permission");
		expect(result?.retractedPermission).toBe(1);
	});

	/**
	 * THE INVARIANT: NO AUTOMATIC PATH DROPS A LIVE RED.
	 *
	 * `pendingPermission: false` means "no marker file", and a marker is only
	 * ever written for `PreToolUse:AskUserQuestion`. An ordinary tool-permission
	 * prompt (Claude's `Notification` event on the "permission_prompt" matcher,
	 * and the same shape from the sh-template agents) latches its red with a
	 * `PermissionRequest` binding and NO marker, so "no marker" says nothing
	 * about it — yet the periodic resync replayed the row, read `false` as an
	 * answer, and took the dot down while the prompt was still on screen blocking
	 * the agent. The occurredAt fence does not catch it: row and latch carry the
	 * SAME instant, and `5_000 > 5_000` is false.
	 */
	it("does NOT retract while the host's own last word is a PermissionRequest", async () => {
		latchRed(WORKSPACE, 5_000);
		snapshotRows = [
			row({
				lastEventType: "PermissionRequest",
				lastEventAt: 5_000,
				pendingPermission: false,
			}),
		];

		const result = await resyncAgentStatusFromHost({
			hostUrl: HOST,
			workspaces: workspaces(),
		});
		await settle();

		const entry =
			useV2NotificationStore.getState().sources["terminal:terminal-1"];
		expect(entry?.axes.permission).toBe(5_000);
		expect(entry?.status).toBe("permission");
		expect(result?.retractedPermission).toBe(0);
	});

	/**
	 * Same fence the unknown branch carries: an entry belonging to another
	 * workspace is not this row's dot to retract. (Whatever the replay itself
	 * does with a cross-workspace entry is the replay's business; the counter is
	 * the honest witness for this branch.)
	 */
	it("does not retract an entry belonging to a different workspace", async () => {
		latchRed("workspace-2", 1_000);
		snapshotRows = [row({ lastEventAt: 5_000, pendingPermission: false })];

		const result = await resyncAgentStatusFromHost({
			hostUrl: HOST,
			workspaces: workspaces(),
		});
		await settle();

		expect(result?.retractedPermission).toBe(0);
	});

	/**
	 * The snapshot is OLDER truth than anything the open bus is delivering while
	 * it is in flight. A PermissionRequest that landed after the request went out
	 * must not be retracted by a row that predates it — the occurredAt fence at
	 * the top of the loop skips the whole row, and it still does.
	 */
	it("leaves a NEWER local PermissionRequest alone", async () => {
		latchRed(WORKSPACE, 9_000);
		snapshotRows = [row({ lastEventAt: 5_000, pendingPermission: false })];

		const result = await resyncAgentStatusFromHost({
			hostUrl: HOST,
			workspaces: workspaces(),
		});
		await settle();

		const entry =
			useV2NotificationStore.getState().sources["terminal:terminal-1"];
		expect(entry?.status).toBe("permission");
		expect(entry?.axes.permission).toBe(9_000);
		expect(result?.retractedPermission).toBe(0);
		expect(result?.skippedNewerLocal).toBe(1);
	});

	/**
	 * (MANUAL-DISMISS) CROSS-WINDOW CONVERGENCE, as far as this path can carry
	 * it. A second window dismissed the workspace; THIS renderer's socket saw
	 * nothing and no reconnect is coming, so the periodic resync is the only way
	 * its red ever comes down — and it does, because the host no longer has a
	 * marker to back it AND its binding has been forced off `PermissionRequest`
	 * to `Stop` by the dismiss, which is what licenses the retraction at all.
	 *
	 * The GREEN does not converge the same way and is not expected to: the seen
	 * watermark is per-renderer (sessionStorage), the snapshot carries no read
	 * state, so this window keeps its own unread green until its own user reads
	 * it. Only the red is a claim about the host's durable truth.
	 */
	it("takes down a red another window dismissed", async () => {
		const store = useV2NotificationStore.getState();
		store.applySourceAxes(
			source,
			WORKSPACE,
			{ set: ["permission"], clear: [] },
			1_000,
		);
		snapshotRows = [
			row({
				lastEventType: "Stop",
				lastEventAt: 5_000,
				pendingPermission: false,
			}),
		];

		const result = await resyncAgentStatusFromHost({
			hostUrl: HOST,
			workspaces: workspaces(),
		});
		await settle();

		const entry =
			useV2NotificationStore.getState().sources["terminal:terminal-1"];
		expect(entry?.axes.permission).toBeUndefined();
		expect(entry?.status).not.toBe("permission");
		expect(result?.retractedPermission).toBe(1);
	});

	/**
	 * The durability half of the fix. After a "Clear Status" the store is empty
	 * and the seen watermark sits at the host's `lastEventAt`, so the very next
	 * resync — which replays the same resting turn-end the host still holds —
	 * must not put either dot back.
	 */
	it("does not resurrect a dismissed workspace's dots", async () => {
		seenThrough("terminal-1", 5_000);
		snapshotRows = [
			row({
				lastEventType: "Stop",
				lastEventAt: 5_000,
				pendingPermission: false,
			}),
		];

		await resyncAgentStatusFromHost({
			hostUrl: HOST,
			workspaces: workspaces(),
		});
		await settle();

		expect(
			useV2NotificationStore.getState().sources["terminal:terminal-1"],
		).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// (ALERT-RETIRE-ON-EXIT) the relaunch boundary
// ---------------------------------------------------------------------------

/**
 * (ALERT-RETIRE-ON-EXIT) The resync is the only thing that can put this
 * desktop's launch on a HOST's clock — it derives the boundary from the host's
 * own `hostNow` less the renderer's elapsed monotonic time — so it is where the
 * report belongs.
 *
 * EACH TEST USES ITS OWN HOST URL. `hostSessionBoundaries` is module state that
 * deliberately outlives a resync (a launch happens once), so a host another
 * test has already boundaried cannot be re-tested here.
 */
describe("(ALERT-RETIRE-ON-EXIT) the relaunch boundary report", () => {
	beforeEach(() => {
		// The tests above deliberately populate the store before their first
		// resync, which decides this session WARM for the whole module. A relaunch
		// only exists on a cold start, so it is re-decided here.
		__resetColdStartForTest();
		resetRelaunchBoundaryLatchForTest();
		resetV2NotificationStoreForTest();
	});

	it("reports a FLOORED boundary once per host, AFTER the seeding pass", async () => {
		const hostA = "http://host-relaunch-a";
		// Far enough ahead of the row's 5_000 that the cold-start seed cannot be
		// squeezed out by however long this process has been up.
		hostNow = 1_000_000;
		await resyncAgentStatusFromHost({
			hostUrl: hostA,
			workspaces: workspaces(),
		});
		await settle();
		expect(relaunchCalls).toHaveLength(1);
		expect(relaunchCalls[0]?.hostUrl).toBe(hostA);
		const reported = relaunchCalls[0]?.boundaryMs ?? Number.NaN;
		// The map keeps the fractional value; the WIRE gets an integer, because
		// the tRPC input is `.int()` and would refuse anything else.
		expect(Number.isInteger(reported)).toBe(true);
		expect(reported).toBeLessThanOrEqual(hostNow ?? 0);
		// THE ORDERING. The row's pre-launch finish was already seeded seen when
		// the report went out, so the cards the host is about to retract are ones
		// this renderer has demonstrably taken over.
		expect(relaunchCalls[0]?.seenAtReport).toBe(5_000);

		// A second epoch on the same host finds it latched and says nothing.
		await resyncAgentStatusFromHost({
			hostUrl: hostA,
			workspaces: workspaces(),
		});
		await settle();
		expect(relaunchCalls).toHaveLength(1);
	});

	it("reports each host separately", async () => {
		const hostB = "http://host-relaunch-b";
		await resyncAgentStatusFromHost({
			hostUrl: hostB,
			workspaces: workspaces(),
		});
		await settle();
		expect(relaunchCalls.map((call) => call.hostUrl)).toEqual([hostB]);
	});

	it("SKIPS the report when cold-start seeding was skipped", async () => {
		// A host too old to answer `hostNow` leaves the boundary unset, which
		// disables seeding for it. There is no launch instant to report either,
		// and guessing one with this machine's clock would retire alerts against
		// a timeline the host has never been on.
		const hostC = "http://host-relaunch-c";
		hostNow = undefined;
		await resyncAgentStatusFromHost({
			hostUrl: hostC,
			workspaces: workspaces(),
		});
		await settle();
		expect(relaunchCalls).toHaveLength(0);
	});

	/**
	 * A reply that lands after its socket closed describes a connection that no
	 * longer exists, and the epoch that replaced it runs its own resync. Reported
	 * from there, the retraction would take down every pre-launch ready card
	 * having reconciled nothing — and the acknowledgement latch would make that
	 * loss permanent for the launch, since no later epoch re-reports.
	 */
	it("says NOTHING when the epoch guard discards the reply", async () => {
		const hostE = "http://host-relaunch-e";
		const result = await resyncAgentStatusFromHost({
			hostUrl: hostE,
			workspaces: workspaces(),
			isCurrent: () => false,
		});
		await settle();
		expect(result?.discarded).toBe(true);
		expect(relaunchCalls).toEqual([]);

		// The next live epoch on that host still reports it.
		await resyncAgentStatusFromHost({
			hostUrl: hostE,
			workspaces: workspaces(),
			isCurrent: () => true,
		});
		await settle();
		expect(relaunchCalls).toHaveLength(1);
	});

	it("retries on the next epoch when the host did not consume it", async () => {
		// The acknowledgement latch, not the boundary map, is what suppresses a
		// repeat — so a report a still-registering bridge refused comes back.
		const hostD = "http://host-relaunch-d";
		await resyncAgentStatusFromHost({
			hostUrl: hostD,
			workspaces: workspaces(),
		});
		await settle();
		expect(relaunchCalls).toHaveLength(1);

		resetRelaunchBoundaryLatchForTest();
		await resyncAgentStatusFromHost({
			hostUrl: hostD,
			workspaces: workspaces(),
		});
		await settle();
		expect(relaunchCalls).toHaveLength(2);
		// Same launch, same instant — the map kept the fractional value and the
		// floor is recomputed from it.
		expect(relaunchCalls[1]?.boundaryMs).toBe(relaunchCalls[0]?.boundaryMs);
	});
});
