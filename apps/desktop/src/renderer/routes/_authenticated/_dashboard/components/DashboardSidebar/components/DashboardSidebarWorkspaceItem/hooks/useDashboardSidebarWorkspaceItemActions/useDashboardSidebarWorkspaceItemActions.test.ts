/**
 * (MANUAL-DISMISS) "Clear Status", the sequence.
 *
 * The defect this covers: the handler called the HOST's
 * `clearWorkspaceStatuses` and a review-only local clear, and never the
 * RENDERER STORE's identically-named `clearWorkspaceStatuses` — so the host
 * went quiet while the red and yellow dots, which are rendered from the store's
 * latched axes, stayed exactly where they were.
 *
 * Driven through the exported `runClearWorkspaceStatuses` rather than the hook:
 * everything under test is ordering and store state, and the React binding
 * around it is three lines that pass two callbacks in.
 */

import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
// Type-only, so it is erased before the `mock.module` calls below run — the
// module itself is still loaded dynamically further down like every other one.
import type { DismissedWorkspaceTerminal } from "./useDashboardSidebarWorkspaceItemActions";

interface SeenCall {
	workspaceId: string;
	terminalId: string;
	origin: string;
	seenThroughAt: number | null;
}

/** Host-clock instants are 13-digit ms values; tests name them as offsets. */
const T0 = 1_700_000_000_000;
const at = (ms: number): number => T0 + ms;

let seenCalls: SeenCall[] = [];
let acceptSeen = true;
let dismissCalls: { workspaceId: string; terminalId?: string }[] = [];
let dismissTerminals: DismissedWorkspaceTerminal[] = [];
let dismissRejects = false;
let errorToasts: string[] = [];
/** What the host's status snapshot answers a resync with. */
let snapshotRows: Array<{
	terminalId: string;
	originWorkspaceId: string;
	lastEventType: string;
	lastEventAt: number;
	pendingPermission: boolean | null;
}> = [];

// Later files inherit these mocks; after this file they get the real code.
let faking = true;
afterAll(() => {
	faking = false;
});
function whileFaking<Args extends unknown[]>(
	fake: (...args: NoInfer<Args>) => unknown,
	real: (...args: Args) => unknown,
): (...args: Args) => unknown {
	return (...args) => (faking ? fake(...args) : real(...args));
}

/**
 * `mock.module` is PROCESS-GLOBAL and there is no unmock, so these are
 * re-installed before every test: `resyncAgentStatus.test.ts` mocks the same
 * host-service-client module, and whichever file loads last owns it for the
 * whole process.
 */
const realHostServiceClient = {
	...(await import("renderer/lib/host-service-client")),
};
const realSonner = { ...(await import("@superset/ui/sonner")) };
const realToast = realSonner.toast;
function installMocks(): void {
	mock.module("@superset/ui/sonner", () => ({
		...realSonner,
		toast: Object.assign(
			(...args: Parameters<typeof realToast>) => realToast(...args),
			realToast,
			{
				error: whileFaking((message) => {
					errorToasts.push(String(message));
				}, realToast.error),
			},
		),
	}));

	mock.module("renderer/lib/host-service-client", () => ({
		...realHostServiceClient,
		getHostServiceClient: whileFaking(
			() => ({}),
			realHostServiceClient.getHostServiceClient,
		),
		hostServiceQueryRetry: whileFaking(
			() => false,
			realHostServiceClient.hostServiceQueryRetry,
		),
		hostServiceQueryRetryDelay: whileFaking(
			() => 0,
			realHostServiceClient.hostServiceQueryRetryDelay,
		),
		getHostServiceClientByUrl: whileFaking(
			() => ({
				terminalAgents: {
					dismissWorkspaceStatuses: {
						mutate: async (input: {
							workspaceId: string;
							terminalId?: string;
						}) => {
							dismissCalls.push(input);
							if (dismissRejects) throw new Error("host gone");
							return {
								dismissStartedAtMs: at(9_000),
								terminals: dismissTerminals,
							};
						},
					},
				},
				companion: {
					reportLifecycleRead: {
						mutate: async (input: SeenCall) => {
							seenCalls.push(input);
							return { accepted: acceptSeen, refusal: null };
						},
					},
				},
				notifications: {
					agentStatusSnapshot: {
						query: async () => ({
							rows: snapshotRows,
							knownTerminalIds: snapshotRows.map((row) => row.terminalId),
							hostNow: at(10_000),
						}),
					},
				},
			}),
			realHostServiceClient.getHostServiceClientByUrl,
		),
	}));
}

installMocks();

const { useV2NotificationStore } = await import(
	"renderer/stores/v2-notifications"
);
const { resetV2NotificationStoreForTest } = await import(
	"renderer/stores/v2-notifications/resetForTest"
);
const {
	markTerminalSeenAndRetract,
	pendingUserReads,
	registerWorkspaceHost,
	resetUserReadsForTest,
} = await import(
	"renderer/routes/_authenticated/components/V2NotificationController/lib/companionAlertSync"
);
const { runClearWorkspaceStatuses } = await import(
	"./useDashboardSidebarWorkspaceItemActions"
);
const {
	__resetColdStartForTest,
	__resetRepairCooldownsForTest,
	resyncAgentStatusFromHost,
} = await import(
	"renderer/routes/_authenticated/components/V2NotificationController/lib/resyncAgentStatus"
);

const HOST = "http://host-a";
const WORKSPACE = "workspace-1";

const settle = async () => {
	for (let i = 0; i < 6; i++) await Promise.resolve();
};

/**
 * What the hook injects. The real one clears the manual mark and reports every
 * bound terminal read; the store action is the same observable outcome (green
 * and the manual mark gone) without restating the companion plumbing, which has
 * its own coverage.
 */
let attentionClears = 0;
function clearWorkspaceAttention(): void {
	attentionClears++;
	useV2NotificationStore.getState().clearWorkspaceAttention(WORKSPACE);
}

let invalidations = 0;
async function invalidateBindings(): Promise<void> {
	invalidations++;
}

function terminal(
	overrides: Partial<DismissedWorkspaceTerminal> = {},
): DismissedWorkspaceTerminal {
	return {
		terminalId: "terminal-1",
		lastEventAt: at(5_000),
		markersRemoved: 1,
		pendingAfter: false,
		questionDismissed: true,
		...overrides,
	};
}

/** A workspace showing every colour at once. */
function seedEveryDot(): void {
	const store = useV2NotificationStore.getState();
	store.applySourceAxes(
		{ type: "terminal", id: "terminal-1" },
		WORKSPACE,
		{ set: ["permission", "working"], clear: [] },
		at(1_000),
	);
	store.applySourceAxes(
		{ type: "terminal", id: "terminal-2" },
		WORKSPACE,
		{ set: ["review"], clear: [] },
		at(2_000),
	);
	store.setManualUnread(WORKSPACE);
	store.setTerminalShellRunning("terminal-3", WORKSPACE, at(1_000));
	store.setTerminalBackgroundRunning("terminal-4", WORKSPACE, at(1_000));
}

describe("(MANUAL-DISMISS) runClearWorkspaceStatuses", () => {
	beforeEach(() => {
		seenCalls = [];
		acceptSeen = true;
		dismissCalls = [];
		dismissTerminals = [];
		dismissRejects = false;
		errorToasts = [];
		snapshotRows = [];
		attentionClears = 0;
		invalidations = 0;
		installMocks();
		resetV2NotificationStoreForTest();
		resetUserReadsForTest();
		registerWorkspaceHost(WORKSPACE, HOST);
	});

	/**
	 * A host that is down must still behave the way this menu item always has:
	 * the green goes, the read is reported, and the states the host owns stay
	 * put. Dropping red locally would be a lie the next resync corrects — the
	 * markers survived the failed call.
	 */
	it("keeps red and yellow latched when the host mutation fails", async () => {
		seedEveryDot();
		dismissRejects = true;

		await runClearWorkspaceStatuses({
			workspaceId: WORKSPACE,
			workspaceHostUrl: HOST,
			clearWorkspaceAttention,
			invalidateBindings,
		});
		await settle();

		const state = useV2NotificationStore.getState();
		expect(attentionClears).toBe(1);
		expect(state.sources["terminal:terminal-2"]).toBeUndefined();
		expect(state.manualUnread[WORKSPACE]).toBeUndefined();
		expect(state.sources["terminal:terminal-1"]?.status).toBe("permission");
		expect(state.sources["terminal:terminal-1"]?.axes.working).toBe(at(1_000));
		// No store purge at all: the blue maps are untouched too.
		expect(state.shellRunningTerminals["terminal-3"]).toBeDefined();
		expect(state.backgroundRunningTerminals["terminal-4"]).toBeDefined();
		expect(errorToasts).toHaveLength(1);
		expect(errorToasts[0]).toContain("Failed to clear agent status");
		expect(invalidations).toBe(0);
	});

	it("does nothing but the local clear when the workspace has no host", async () => {
		seedEveryDot();

		await runClearWorkspaceStatuses({
			workspaceId: WORKSPACE,
			workspaceHostUrl: null,
			clearWorkspaceAttention,
			invalidateBindings,
		});

		expect(attentionClears).toBe(1);
		expect(dismissCalls).toHaveLength(0);
		expect(
			useV2NotificationStore.getState().sources["terminal:terminal-1"]?.status,
		).toBe("permission");
	});

	it("purges every axis and marks each returned terminal seen on success", async () => {
		seedEveryDot();
		// terminal-2's finish is still showing on the phone.
		useV2NotificationStore.setState((state) => ({
			outstandingReadyAt: {
				...state.outstandingReadyAt,
				"terminal-2": at(2_000),
			},
		}));
		dismissTerminals = [
			terminal({ terminalId: "terminal-1", lastEventAt: at(5_000) }),
			terminal({
				terminalId: "terminal-2",
				lastEventAt: at(6_000),
				markersRemoved: 0,
				questionDismissed: false,
			}),
		];

		await runClearWorkspaceStatuses({
			workspaceId: WORKSPACE,
			workspaceHostUrl: HOST,
			clearWorkspaceAttention,
			invalidateBindings,
		});
		await settle();

		const state = useV2NotificationStore.getState();
		expect(dismissCalls).toEqual([{ workspaceId: WORKSPACE }]);
		expect(state.sources).toEqual({});
		expect(state.shellRunningTerminals["terminal-3"]).toBeUndefined();
		expect(state.backgroundRunningTerminals["terminal-4"]).toBeUndefined();
		// Durable across the next resync: the watermark is the HOST's instant, not
		// this machine's clock.
		expect(state.terminalSeenAt["terminal-1"]).toBe(at(5_000));
		expect(state.terminalSeenAt["terminal-2"]).toBe(at(6_000));
		// The outstanding record survived the purge, so the card could still be
		// retracted — and the host's ack retired it.
		expect(seenCalls).toEqual([
			{
				workspaceId: WORKSPACE,
				terminalId: "terminal-2",
				origin: "repair-seen",
				seenThroughAt: at(2_000),
			},
		]);
		expect(state.outstandingReadyAt["terminal-2"]).toBeUndefined();
		expect(errorToasts).toHaveLength(0);
		expect(invalidations).toBe(1);
	});

	/**
	 * A question that arrived while the dismiss was in flight outlived it — and
	 * in the ordinary case it already latched its red IN THIS RENDERER, off the
	 * broadcast, between the click and the reply. The workspace-wide purge then
	 * wiped it and no further PermissionRequest is coming, so the blocked agent
	 * showed no dot at all until the 60s periodic resync. The re-latch is what
	 * closes that hole; the seen mark still has to stay off, because stamping it
	 * read would tell the companion the user has dealt with something they have
	 * never seen.
	 */
	it("keeps the red for a terminal whose newer question survived", async () => {
		seedEveryDot();
		// The surviving question's own broadcast, already applied here.
		useV2NotificationStore
			.getState()
			.applySourceAxes(
				{ type: "terminal", id: "terminal-2" },
				WORKSPACE,
				{ set: ["permission"], clear: [] },
				at(6_000),
			);
		useV2NotificationStore.setState((state) => ({
			outstandingReadyAt: {
				...state.outstandingReadyAt,
				"terminal-2": at(2_000),
			},
		}));
		dismissTerminals = [
			terminal({
				terminalId: "terminal-2",
				lastEventAt: at(6_000),
				pendingAfter: true,
			}),
		];

		await runClearWorkspaceStatuses({
			workspaceId: WORKSPACE,
			workspaceHostUrl: HOST,
			clearWorkspaceAttention,
			invalidateBindings,
		});
		await settle();

		const state = useV2NotificationStore.getState();
		const entry = state.sources["terminal:terminal-2"];
		// The red survives the whole flow, at the HOST's instant.
		expect(entry?.axes.permission).toBe(at(6_000));
		expect(entry?.status).toBe("permission");
		// ONLY the red comes back. The review this same terminal was carrying is
		// gone, as is every other terminal's dot — the dismiss still did its job.
		expect(entry?.axes.review).toBeUndefined();
		expect(state.sources["terminal:terminal-1"]).toBeUndefined();
		expect(state.shellRunningTerminals["terminal-3"]).toBeUndefined();
		expect(state.backgroundRunningTerminals["terminal-4"]).toBeUndefined();
		expect(state.terminalSeenAt["terminal-2"]).toBeUndefined();
		expect(seenCalls).toHaveLength(0);
		expect(state.outstandingReadyAt["terminal-2"]).toBe(at(2_000));
		// The query still has to be refetched: the other bindings did move.
		expect(invalidations).toBe(1);
	});

	/**
	 * A surviving question the host cannot date. The re-latch is skipped rather
	 * than stamped with this machine's clock: every axis timestamp in the store
	 * is HOST clock, and a renderer `Date.now()` planted here is what the next
	 * resync's occurredAt fence would compare host rows against.
	 */
	it("cannot re-latch a surviving question with no binding behind it", async () => {
		seedEveryDot();
		dismissTerminals = [
			terminal({
				terminalId: "terminal-1",
				lastEventAt: null,
				pendingAfter: true,
			}),
		];

		await runClearWorkspaceStatuses({
			workspaceId: WORKSPACE,
			workspaceHostUrl: HOST,
			clearWorkspaceAttention,
			invalidateBindings,
		});
		await settle();

		const state = useV2NotificationStore.getState();
		expect(state.sources).toEqual({});
		expect(state.terminalSeenAt["terminal-1"]).toBeUndefined();
		expect(seenCalls).toHaveLength(0);
		expect(invalidations).toBe(1);
	});
	/**
	 * A leaked marker swept off a terminal nothing is bound to. The host reports
	 * it as a success with no `lastEventAt`, and there is no binding behind it
	 * to have been read — marking it seen would invent a watermark for a
	 * terminal that has no events.
	 */
	it("skips the seen mark when the host reports no binding", async () => {
		seedEveryDot();
		dismissTerminals = [
			terminal({
				terminalId: "terminal-5",
				lastEventAt: null,
				markersRemoved: 1,
			}),
		];

		await runClearWorkspaceStatuses({
			workspaceId: WORKSPACE,
			workspaceHostUrl: HOST,
			clearWorkspaceAttention,
			invalidateBindings,
		});
		await settle();

		const state = useV2NotificationStore.getState();
		expect(state.sources).toEqual({});
		expect(state.terminalSeenAt["terminal-5"]).toBeUndefined();
		expect(seenCalls).toHaveLength(0);
		expect(invalidations).toBe(1);
	});

	it("is not a read: nothing it reports can move the host's read mark", async () => {
		useV2NotificationStore
			.getState()
			.applySourceAxes(
				{ type: "terminal", id: "terminal-2" },
				WORKSPACE,
				{ set: ["review"], clear: [] },
				at(2_000),
			);
		dismissTerminals = [
			terminal({ terminalId: "terminal-1", lastEventAt: at(5_000) }),
			terminal({ terminalId: "terminal-2", lastEventAt: at(6_000) }),
		];

		await runClearWorkspaceStatuses({
			workspaceId: WORKSPACE,
			workspaceHostUrl: HOST,
			// What the hook passes: the same per-terminal helper the dismissal uses.
			clearWorkspaceAttention: () => {
				for (const terminalId of ["terminal-1", "terminal-2"]) {
					markTerminalSeenAndRetract({
						workspaceId: WORKSPACE,
						terminalId,
						seenAt: at(4_000),
					});
				}
			},
			invalidateBindings,
		});
		await settle();

		expect(seenCalls.length).toBeGreaterThan(0);
		expect(new Set(seenCalls.map((call) => call.origin))).toEqual(
			new Set(["repair-seen"]),
		);
		expect(pendingUserReads(HOST)).toEqual([]);
	});

	/**
	 * The way a Clear used to become a read: its report fails, so the seen mark
	 * it wrote and the outstanding record it could not retire both survive; the
	 * agent starts again; and the resync's repair of that record went out as a
	 * read. Every resync repair is a retraction only.
	 */
	it("never turns a failed Clear into a read at the next resync", async () => {
		useV2NotificationStore.setState((state) => ({
			outstandingReadyAt: {
				...state.outstandingReadyAt,
				"terminal-2": at(2_000),
			},
		}));
		dismissTerminals = [
			terminal({ terminalId: "terminal-2", lastEventAt: at(6_000) }),
		];
		acceptSeen = false;

		await runClearWorkspaceStatuses({
			workspaceId: WORKSPACE,
			workspaceHostUrl: HOST,
			clearWorkspaceAttention,
			invalidateBindings,
		});
		await settle();

		expect(seenCalls).toEqual([
			{
				workspaceId: WORKSPACE,
				terminalId: "terminal-2",
				origin: "repair-seen",
				seenThroughAt: at(2_000),
			},
		]);
		const afterClear = useV2NotificationStore.getState();
		expect(afterClear.terminalSeenAt["terminal-2"]).toBe(at(6_000));
		expect(afterClear.outstandingReadyAt["terminal-2"]).toBe(at(2_000));

		// The agent starts again, and the next resync finds the record standing.
		snapshotRows = [
			{
				terminalId: "terminal-2",
				originWorkspaceId: WORKSPACE,
				lastEventType: "Start",
				lastEventAt: at(7_000),
				pendingPermission: false,
			},
		];
		acceptSeen = true;
		__resetColdStartForTest();
		__resetRepairCooldownsForTest();
		await resyncAgentStatusFromHost({
			hostUrl: HOST,
			workspaces: new Map([
				[
					WORKSPACE,
					{
						workspaceId: WORKSPACE,
						workspaceName: "W",
						paneLayout: null,
						rightPaneLayout: null,
					},
				],
			]),
		});
		await settle();

		expect(seenCalls).toHaveLength(2);
		expect(seenCalls[1]).toEqual({
			workspaceId: WORKSPACE,
			terminalId: "terminal-2",
			origin: "repair-seen",
			seenThroughAt: at(2_000),
		});
		expect(
			useV2NotificationStore.getState().outstandingReadyAt["terminal-2"],
		).toBeUndefined();
		expect(pendingUserReads(HOST)).toEqual([]);
	});
});
