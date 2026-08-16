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
let acceptSeen = true;
let rejectSeen = false;
let snapshotRows: SnapshotRow[] = [];
let knownTerminalIds: string[] = [];
let hostNow = 10_000;

interface SnapshotRow {
	terminalId: string;
	originWorkspaceId: string;
	lastEventType: string;
	lastEventAt: number;
	pendingPermission: boolean | null;
}

mock.module("renderer/lib/host-service-client", () => ({
	getHostServiceClientByUrl: () => ({
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
		},
	}),
}));

const { useV2NotificationStore } = await import(
	"renderer/stores/v2-notifications"
);
const { registerWorkspaceHost, unregisterWorkspaceHost } = await import(
	"./companionAlertSync"
);
const {
	__peekRepairOutcomeForTest,
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
	acceptSeen = true;
	rejectSeen = false;
	snapshotRows = [row()];
	knownTerminalIds = ["terminal-1"];
	hostNow = 10_000;
	__resetRepairCooldownsForTest();
	registerWorkspaceHost(WORKSPACE, HOST);
	useV2NotificationStore.setState({
		sources: {},
		terminalSeenAt: {},
		outstandingReadyAt: {},
		shellRunningTerminals: {},
		backgroundRunningTerminals: {},
	});
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
