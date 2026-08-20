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

import { beforeEach, describe, expect, it, mock } from "bun:test";
// Type-only, so it is erased before the `mock.module` calls below run — the
// module itself is still loaded dynamically further down like every other one.
import type { DismissedWorkspaceTerminal } from "./useDashboardSidebarWorkspaceItemActions";

interface SeenCall {
	workspaceId: string;
	terminalId: string;
	seenThroughAt: number;
}

let seenCalls: SeenCall[] = [];
let dismissCalls: { workspaceId: string; terminalId?: string }[] = [];
let dismissTerminals: DismissedWorkspaceTerminal[] = [];
let dismissRejects = false;
let errorToasts: string[] = [];

/**
 * `mock.module` is PROCESS-GLOBAL and there is no unmock, so these are
 * re-installed before every test: `resyncAgentStatus.test.ts` mocks the same
 * host-service-client module, and whichever file loads last owns it for the
 * whole process.
 */
function installMocks(): void {
	mock.module("@superset/ui/sonner", () => ({
		toast: {
			error: (message: string) => {
				errorToasts.push(message);
			},
			success: () => {},
			info: () => {},
			warning: () => {},
			message: () => {},
			dismiss: () => {},
		},
		Toaster: () => null,
	}));

	mock.module("renderer/lib/host-service-client", () => ({
		// The module is replaced whole, so the query-policy helpers other
		// importers in this graph pull from it have to be here too.
		getHostServiceClient: () => ({}),
		isHostServiceConnectionError: () => false,
		hostServiceQueryRetry: () => false,
		hostServiceQueryRetryDelay: () => 0,
		getHostServiceClientByUrl: () => ({
			terminalAgents: {
				dismissWorkspaceStatuses: {
					mutate: async (input: {
						workspaceId: string;
						terminalId?: string;
					}) => {
						dismissCalls.push(input);
						if (dismissRejects) throw new Error("host gone");
						return { dismissStartedAtMs: 9_000, terminals: dismissTerminals };
					},
				},
			},
			companion: {
				markLifecycleSeen: {
					mutate: async (input: SeenCall) => {
						seenCalls.push(input);
						return { accepted: true };
					},
				},
			},
		}),
	}));
}

installMocks();

const { useV2NotificationStore } = await import(
	"renderer/stores/v2-notifications"
);
const { resetV2NotificationStoreForTest } = await import(
	"renderer/stores/v2-notifications/resetForTest"
);
const { registerWorkspaceHost } = await import(
	"renderer/routes/_authenticated/components/V2NotificationController/lib/companionAlertSync"
);
const { runClearWorkspaceStatuses } = await import(
	"./useDashboardSidebarWorkspaceItemActions"
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
		lastEventAt: 5_000,
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
		1_000,
	);
	store.applySourceAxes(
		{ type: "terminal", id: "terminal-2" },
		WORKSPACE,
		{ set: ["review"], clear: [] },
		2_000,
	);
	store.setManualUnread(WORKSPACE);
	store.setTerminalShellRunning("terminal-3", WORKSPACE, 1_000);
	store.setTerminalBackgroundRunning("terminal-4", WORKSPACE, 1_000);
}

describe("(MANUAL-DISMISS) runClearWorkspaceStatuses", () => {
	beforeEach(() => {
		seenCalls = [];
		dismissCalls = [];
		dismissTerminals = [];
		dismissRejects = false;
		errorToasts = [];
		attentionClears = 0;
		invalidations = 0;
		installMocks();
		resetV2NotificationStoreForTest();
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
		expect(state.sources["terminal:terminal-1"]?.axes.working).toBe(1_000);
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
			outstandingReadyAt: { ...state.outstandingReadyAt, "terminal-2": 2_000 },
		}));
		dismissTerminals = [
			terminal({ terminalId: "terminal-1", lastEventAt: 5_000 }),
			terminal({
				terminalId: "terminal-2",
				lastEventAt: 6_000,
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
		expect(state.terminalSeenAt["terminal-1"]).toBe(5_000);
		expect(state.terminalSeenAt["terminal-2"]).toBe(6_000);
		// The outstanding record survived the purge, so the read could still be
		// reported — and the host's ack retired it.
		expect(seenCalls).toEqual([
			{
				workspaceId: WORKSPACE,
				terminalId: "terminal-2",
				seenThroughAt: 2_000,
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
				6_000,
			);
		useV2NotificationStore.setState((state) => ({
			outstandingReadyAt: { ...state.outstandingReadyAt, "terminal-2": 2_000 },
		}));
		dismissTerminals = [
			terminal({
				terminalId: "terminal-2",
				lastEventAt: 6_000,
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
		expect(entry?.axes.permission).toBe(6_000);
		expect(entry?.status).toBe("permission");
		// ONLY the red comes back. The review this same terminal was carrying is
		// gone, as is every other terminal's dot — the dismiss still did its job.
		expect(entry?.axes.review).toBeUndefined();
		expect(state.sources["terminal:terminal-1"]).toBeUndefined();
		expect(state.shellRunningTerminals["terminal-3"]).toBeUndefined();
		expect(state.backgroundRunningTerminals["terminal-4"]).toBeUndefined();
		expect(state.terminalSeenAt["terminal-2"]).toBeUndefined();
		expect(seenCalls).toHaveLength(0);
		expect(state.outstandingReadyAt["terminal-2"]).toBe(2_000);
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
});
