/**
 * (ALERT-RETIRE-ON-EXIT) THE VISIBLE-CLEAR HOP.
 *
 * A turn that ends while the user is looking at the pane never raises a green:
 * the transition answers `axes: null` and clears the source instead. Nothing
 * downstream then calls the mark-read helper, so the phone card the host minted
 * for that same finish stood for six hours while the user watched the agent
 * finish on screen. This file pins the hop that closes it — and, just as
 * importantly, the three shapes that must NOT fire it.
 *
 * The transport is faked at `getHostServiceClientByUrl`, the same seam
 * `companionAlertSync` is tested through.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { WorkspaceState } from "@superset/panes";
import type { AgentLifecyclePayload } from "@superset/workspace-client";
import type { PaneViewerData } from "renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/types";

interface SeenCall {
	workspaceId: string;
	terminalId: string;
	seenThroughAt: number;
}

let seenCalls: SeenCall[] = [];

mock.module("renderer/lib/host-service-client", () => ({
	getHostServiceClient: () => ({}),
	isHostServiceConnectionError: () => false,
	hostServiceQueryRetry: () => false,
	hostServiceQueryRetryDelay: () => 0,
	getHostServiceClientByUrl: () => ({
		companion: {
			markLifecycleSeen: {
				mutate: async (input: SeenCall) => {
					seenCalls.push(input);
					return { accepted: true };
				},
			},
			syncAlertContexts: { mutate: async () => ({ accepted: true }) },
			retireStaleReadyAlerts: { mutate: async () => ({ accepted: true }) },
		},
	}),
}));

// NOTHING ELSE IS MOCKED, deliberately. `mock.module` is process-wide in Bun
// and leaks into every other file in the same run: stubbing
// `renderer/lib/trpc-client` here took down an unrelated suite's keyboard-layout
// store on import. The chime path is not reached anyway — the entry point below
// is the status half, which never rings.

const { markV2AgentLifecycleTargetSeen } = await import("./lifecycleEvents");
const { registerWorkspaceHost, unregisterWorkspaceHost } = await import(
	"./companionAlertSync"
);
const { useV2NotificationStore } = await import(
	"renderer/stores/v2-notifications"
);
const { resetV2NotificationStoreForTest } = await import(
	"renderer/stores/v2-notifications/resetForTest"
);

const HOST = "http://host-a";
const WORKSPACE = "workspace-1";
const TERMINAL = "terminal-1";

/** `terminal-1` is the ACTIVE pane of the ACTIVE tab; `terminal-2` is not. */
const layout: WorkspaceState<PaneViewerData> = {
	version: 1,
	activeTabId: "tab-active",
	tabs: [
		{
			id: "tab-active",
			createdAt: 1,
			activePaneId: "pane-visible",
			layout: { type: "pane", paneId: "pane-visible" },
			panes: {
				"pane-visible": {
					id: "pane-visible",
					kind: "terminal",
					data: { terminalId: TERMINAL },
				},
			},
		},
		{
			id: "tab-background",
			createdAt: 2,
			activePaneId: "pane-hidden",
			layout: { type: "pane", paneId: "pane-hidden" },
			panes: {
				"pane-hidden": {
					id: "pane-hidden",
					kind: "terminal",
					data: { terminalId: "terminal-2" },
				},
			},
		},
	],
} as unknown as WorkspaceState<PaneViewerData>;

function payload(
	overrides: Partial<AgentLifecyclePayload> = {},
): AgentLifecyclePayload {
	return {
		eventType: "Stop",
		terminalId: TERMINAL,
		occurredAt: 5_000,
		...overrides,
	};
}

function fire(overrides: Partial<AgentLifecyclePayload> = {}): void {
	markV2AgentLifecycleTargetSeen({
		workspaceId: WORKSPACE,
		payload: payload(overrides),
		paneLayout: layout,
		fromReplay: false,
	});
}

/**
 * The presence half of the hop's gate. `test-setup.ts` installs a plain-object
 * `document` with neither field on it, so both are supplied here — and reset
 * before every test, because a test that hides the window must not hide it for
 * the next one.
 */
const presence = globalThis.document as unknown as {
	hidden: boolean;
	hasFocus: () => boolean;
};

const settle = async () => {
	for (let i = 0; i < 5; i++) await Promise.resolve();
};

beforeEach(() => {
	seenCalls = [];
	presence.hidden = false;
	presence.hasFocus = () => true;
	resetV2NotificationStoreForTest();
	registerWorkspaceHost(WORKSPACE, HOST);
	// `getCurrentWorkspaceId` reads the route out of the hash, and the test
	// harness aliases `window` to `globalThis` with no `location` on it.
	(globalThis as { location?: { hash: string } }).location = {
		hash: `#/v2-workspace/${WORKSPACE}`,
	};
});

describe("(ALERT-RETIRE-ON-EXIT) the visible-clear hop", () => {
	it("reports a visible Stop with the OUTCOME instant", async () => {
		fire({ eventType: "Stop", occurredAt: 5_000 });
		await settle();
		expect(seenCalls).toEqual([
			{
				workspaceId: WORKSPACE,
				terminalId: TERMINAL,
				// `payload.occurredAt`, which is what the alert id was hashed from —
				// never the binding's `lastEventAt`.
				seenThroughAt: 5_000,
			},
		]);
	});

	it("reports a visible Failed too", async () => {
		fire({ eventType: "Failed", occurredAt: 6_000 });
		await settle();
		expect(seenCalls).toEqual([
			{
				workspaceId: WORKSPACE,
				terminalId: TERMINAL,
				seenThroughAt: 6_000,
			},
		]);
	});

	it("marks the terminal seen LOCALLY as well as reporting", async () => {
		fire({ eventType: "Stop", occurredAt: 5_000 });
		await settle();
		// Without the local mark the next resync compares the binding against an
		// absent seen record and re-raises the very green this cleared.
		expect(useV2NotificationStore.getState().terminalSeenAt[TERMINAL]).toBe(
			5_000,
		);
	});

	it("does NOT report BackgroundRunning — it mints no alert", async () => {
		fire({ eventType: "BackgroundRunning", occurredAt: 5_000 });
		await settle();
		expect(seenCalls).toEqual([]);
	});

	it("does NOT report a turn end on a pane the user cannot see", async () => {
		markV2AgentLifecycleTargetSeen({
			workspaceId: WORKSPACE,
			payload: payload({ terminalId: "terminal-2", occurredAt: 5_000 }),
			paneLayout: layout,
			fromReplay: false,
		});
		await settle();
		expect(seenCalls).toEqual([]);
	});

	/**
	 * THE FEATURE'S PRIMARY SCENARIO, and the one layout visibility gets wrong.
	 * A turn finishing on the active pane while the machine is locked or the
	 * user is out of the room is exactly the finish the phone alert exists for —
	 * and `targetVisible` is true for all of it, because it only describes where
	 * the pane sits. Retracting there is both wrong and irreversible.
	 */
	it("does NOT report while the window is hidden", async () => {
		presence.hidden = true;
		fire({ eventType: "Stop", occurredAt: 5_000 });
		await settle();
		expect(seenCalls).toEqual([]);
	});

	it("does NOT report while the window is unfocused", async () => {
		presence.hasFocus = () => false;
		fire({ eventType: "Stop", occurredAt: 5_000 });
		await settle();
		expect(seenCalls).toEqual([]);
	});

	/**
	 * The bus-resync replays every host binding through this same helper. Two
	 * separate reasons it must stay silent: the replayed instant is the
	 * binding's `lastEventAt`, which advances for events that mint no alert at
	 * all (so the retraction would name a finish that never had a card), and a
	 * relaunch replays each idle tab's resting turn-end — including `Failed`,
	 * whose card is meant to survive a relaunch until the user looks.
	 */
	it("does NOT report on the replay path, however visible and focused", async () => {
		markV2AgentLifecycleTargetSeen({
			workspaceId: WORKSPACE,
			payload: payload({ eventType: "Stop", occurredAt: 5_000 }),
			paneLayout: layout,
			fromReplay: true,
		});
		markV2AgentLifecycleTargetSeen({
			workspaceId: WORKSPACE,
			payload: payload({ eventType: "Failed", occurredAt: 6_000 }),
			paneLayout: layout,
			fromReplay: true,
		});
		await settle();
		expect(seenCalls).toEqual([]);
		// And no local mark either — the replay is not evidence of a read.
		expect(
			useV2NotificationStore.getState().terminalSeenAt[TERMINAL],
		).toBeUndefined();
	});

	/**
	 * `wasAwaitingPermission` ALSO produces `axes: null`, and on an invisible
	 * pane. That is a question being answered, not a chat being read, so the
	 * `targetVisible` clause — not the axes one — is what has to exclude it.
	 */
	it("does NOT report a cleared permission on an invisible pane", async () => {
		useV2NotificationStore
			.getState()
			.applySourceAxes(
				{ type: "terminal", id: "terminal-2" },
				WORKSPACE,
				{ set: ["permission"], clear: [] },
				4_000,
			);
		markV2AgentLifecycleTargetSeen({
			workspaceId: WORKSPACE,
			payload: payload({ terminalId: "terminal-2", occurredAt: 5_000 }),
			paneLayout: layout,
			fromReplay: false,
		});
		await settle();
		expect(seenCalls).toEqual([]);
	});

	it("does NOT report Start, PermissionRequest or Attached", async () => {
		for (const eventType of [
			"Start",
			"PermissionRequest",
			"Attached",
		] as const) {
			fire({ eventType, occurredAt: 5_000 });
		}
		await settle();
		expect(seenCalls).toEqual([]);
	});

	it("is silent when the workspace has no known host", async () => {
		unregisterWorkspaceHost(WORKSPACE, HOST);
		fire({ eventType: "Stop", occurredAt: 5_000 });
		await settle();
		expect(seenCalls).toEqual([]);
		// The LOCAL mark still lands: it is what stops the resync re-raising.
		expect(useV2NotificationStore.getState().terminalSeenAt[TERMINAL]).toBe(
			5_000,
		);
	});
});
