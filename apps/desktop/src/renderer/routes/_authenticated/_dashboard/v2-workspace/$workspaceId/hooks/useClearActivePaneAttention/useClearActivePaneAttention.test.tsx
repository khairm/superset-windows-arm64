/**
 * (ALERT-RETIRE-ON-EXIT) A READ IS THE USER LOOKING, NOT THE STORE CHANGING.
 *
 * This effect re-runs on things the user had no part in: a status flipping to
 * `review` because an agent finished, a bindings live-query tick, a resync
 * replay writing the store. Each of those used to report the active pane as
 * read — and with the window hidden or behind another app, that retracted the
 * phone card for a finish nobody had looked at, which nothing can undo.
 *
 * So the report is gated on presence, and presence is a DEPENDENCY rather than
 * a one-off read: the case this exists for is a user coming back to a window
 * that has been hidden for an hour, and nothing else here re-renders when they
 * do.
 *
 * The transport is faked at `getHostServiceClientByUrl`, the same seam
 * `companionAlertSync` is tested through; everything below it is the real
 * store, the real helper and a real mounted component.
 */

import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// happy-dom over the preloaded plain-object document — this renders a real
// component tree AND needs real `document.hidden` / focus events. Bun runs test
// files sequentially in one process and happy-dom's globals are process-wide,
// so we MUST unregister in afterAll or unrelated renderer suites inherit
// readonly DOM globals.
const alreadyRegistered = GlobalRegistrator.isRegistered;
if (!alreadyRegistered) GlobalRegistrator.register();
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

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

const WORKSPACE = "workspace-1";
const TERMINAL = "terminal-1";
const HOST = "http://host-a";

/** What the mocked host-service hooks answer, per test. */
let paneStatus: string | undefined = "review";
let bindings = new Map<string, { lastEventAt: number }>();

mock.module("renderer/hooks/host-service/useTerminalAgentBindings", () => ({
	useTerminalAgentBindings: () => bindings,
}));
mock.module("renderer/hooks/host-service/useV2NotificationStatus", () => ({
	useV2PaneNotificationStatus: () => paneStatus,
}));
mock.module(
	"renderer/routes/_authenticated/_dashboard/v2-workspace/providers/WorkspaceProvider",
	() => ({ useWorkspace: () => ({ workspace: { id: WORKSPACE } }) }),
);

const { act, cleanup, render } = await import("@testing-library/react");
const React = await import("react");
const { createWorkspaceStore } = await import("@superset/panes");
const { useV2NotificationStore } = await import(
	"renderer/stores/v2-notifications"
);
const { resetV2NotificationStoreForTest } = await import(
	"renderer/stores/v2-notifications/resetForTest"
);
const { registerWorkspaceHost, unregisterWorkspaceHost } = await import(
	"renderer/routes/_authenticated/components/V2NotificationController/lib/companionAlertSync"
);
const { useClearActivePaneAttention } = await import(
	"./useClearActivePaneAttention"
);

// biome-ignore lint/suspicious/noExplicitAny: the pane store's viewer data is not the subject here
type AnyStore = any;

function createStore(): AnyStore {
	return createWorkspaceStore({
		initialState: {
			version: 1,
			activeTabId: "tab-1",
			tabs: [
				{
					id: "tab-1",
					createdAt: 1,
					activePaneId: "pane-1",
					layout: { type: "pane", paneId: "pane-1" },
					panes: {
						"pane-1": {
							id: "pane-1",
							kind: "terminal",
							data: { terminalId: TERMINAL },
						},
					},
				},
			],
		},
	});
}

function Probe({ store }: { store: AnyStore }) {
	useClearActivePaneAttention({ store });
	return null;
}

const settle = async () => {
	for (let i = 0; i < 5; i++) await Promise.resolve();
};

/** happy-dom's document, with the two fields the presence predicate reads. */
const dom = globalThis.document as Document & { hasFocus: () => boolean };

function setPresent(present: boolean): void {
	Object.defineProperty(dom, "hidden", {
		value: !present,
		configurable: true,
	});
	dom.hasFocus = () => present;
}

/** The user comes back to the window, exactly as the OS reports it. */
function returnToWindow(): void {
	act(() => {
		setPresent(true);
		globalThis.dispatchEvent(new Event("focus"));
	});
}

beforeEach(() => {
	seenCalls = [];
	paneStatus = "review";
	bindings = new Map([[TERMINAL, { lastEventAt: 5_000 }]]);
	setPresent(true);
	resetV2NotificationStoreForTest();
	registerWorkspaceHost(WORKSPACE, HOST);
	// A finish the user has not read: the green dot and its instant.
	useV2NotificationStore
		.getState()
		.applySourceAxes(
			{ type: "terminal", id: TERMINAL },
			WORKSPACE,
			{ set: ["review"], clear: [] },
			5_000,
		);
});

afterEach(() => {
	cleanup();
	unregisterWorkspaceHost(WORKSPACE, HOST);
});

afterAll(() => {
	if (!alreadyRegistered) GlobalRegistrator.unregister();
});

describe("(ALERT-RETIRE-ON-EXIT) useClearActivePaneAttention", () => {
	it("reports the pane the user has open in a shown, focused window", async () => {
		render(React.createElement(Probe, { store: createStore() }));
		await settle();
		expect(seenCalls).toEqual([
			{ workspaceId: WORKSPACE, terminalId: TERMINAL, seenThroughAt: 5_000 },
		]);
	});

	it("reports NOTHING while the window is hidden", async () => {
		setPresent(false);
		render(React.createElement(Probe, { store: createStore() }));
		await settle();
		expect(seenCalls).toEqual([]);
		// And the green is still there for the user to come back to.
		expect(
			useV2NotificationStore.getState().terminalSeenAt[TERMINAL],
		).toBeUndefined();
	});

	it("reports NOTHING while the window is merely unfocused", async () => {
		dom.hasFocus = () => false;
		render(React.createElement(Probe, { store: createStore() }));
		await settle();
		expect(seenCalls).toEqual([]);
	});

	it("reports when the user comes BACK to the window", async () => {
		setPresent(false);
		render(React.createElement(Probe, { store: createStore() }));
		await settle();
		expect(seenCalls).toEqual([]);

		returnToWindow();
		await settle();
		expect(seenCalls).toEqual([
			{ workspaceId: WORKSPACE, terminalId: TERMINAL, seenThroughAt: 5_000 },
		]);
	});

	it("does not report a pane with nothing outstanding on it", async () => {
		paneStatus = "idle";
		resetV2NotificationStoreForTest();
		registerWorkspaceHost(WORKSPACE, HOST);
		render(React.createElement(Probe, { store: createStore() }));
		await settle();
		expect(seenCalls).toEqual([]);
	});
});
