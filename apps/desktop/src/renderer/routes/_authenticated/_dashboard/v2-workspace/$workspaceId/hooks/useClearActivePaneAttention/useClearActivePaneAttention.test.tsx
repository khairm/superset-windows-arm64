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

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

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

const realHostServiceClient = {
	...(await import("renderer/lib/host-service-client")),
};
mock.module("renderer/lib/host-service-client", () => ({
	...realHostServiceClient,
	getHostServiceClient: () => ({}),
	hostServiceQueryRetry: () => false,
	hostServiceQueryRetryDelay: () => 0,
	getHostServiceClientByUrl: () => ({
		companion: {
			reportLifecycleRead: {
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
interface Binding {
	lastEventAt: number;
	lastEventType: string;
}
let bindings = new Map<string, Binding>();
let bindingsLoaded = true;

// `mock.module` is process-wide: once this file is done, every later file gets
// the real hooks back.
let faking = true;
afterAll(() => {
	faking = false;
});
function whileFaking<Args extends unknown[]>(
	fake: () => unknown,
	real: (...args: Args) => unknown,
): (...args: Args) => unknown {
	return (...args) => (faking ? fake() : real(...args));
}

const realBindings = {
	...(await import("renderer/hooks/host-service/useTerminalAgentBindings")),
};
mock.module("renderer/hooks/host-service/useTerminalAgentBindings", () => ({
	...realBindings,
	useTerminalAgentBindings: whileFaking(
		() => bindings,
		realBindings.useTerminalAgentBindings,
	),
	useTerminalAgentBindingsState: whileFaking(
		() => ({ bindings, loaded: bindingsLoaded }),
		realBindings.useTerminalAgentBindingsState,
	),
}));
const realWorkspaceProvider = {
	...(await import(
		"renderer/routes/_authenticated/_dashboard/v2-workspace/providers/WorkspaceProvider"
	)),
};
mock.module(
	"renderer/routes/_authenticated/_dashboard/v2-workspace/providers/WorkspaceProvider",
	() => ({
		...realWorkspaceProvider,
		useWorkspace: whileFaking(
			() => ({ workspace: { id: WORKSPACE } }),
			realWorkspaceProvider.useWorkspace,
		),
	}),
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
const {
	registerWorkspaceHost,
	resetUserReadsForTest,
	unregisterWorkspaceHost,
} = await import(
	"renderer/routes/_authenticated/components/V2NotificationController/lib/companionAlertSync"
);
const { useClearActivePaneAttention } = await import(
	"./useClearActivePaneAttention"
);
const { setScreenLocked } = await import("renderer/hooks/useUserPresent");

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
const PRESENCE_FIELDS = ["hidden", "hasFocus"] as const;
const originalPresence = PRESENCE_FIELDS.map((field) => ({
	field,
	descriptor: Object.getOwnPropertyDescriptor(document, field),
}));

function setFocused(focused: boolean): void {
	Object.defineProperty(document, "hasFocus", {
		configurable: true,
		value: () => focused,
	});
}

function setPresent(present: boolean): void {
	Object.defineProperty(document, "hidden", {
		configurable: true,
		get: () => !present,
	});
	setFocused(present);
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
	bindings = new Map([
		[TERMINAL, { lastEventAt: at(5_000), lastEventType: "Stop" }],
	]);
	bindingsLoaded = true;
	setPresent(true);
	setScreenLocked(false);
	resetV2NotificationStoreForTest();
	resetUserReadsForTest();
	registerWorkspaceHost(WORKSPACE, HOST);
	// A finish the user has not read: the green dot and its instant.
	useV2NotificationStore
		.getState()
		.applySourceAxes(
			{ type: "terminal", id: TERMINAL },
			WORKSPACE,
			{ set: ["review"], clear: [] },
			at(5_000),
		);
});

afterEach(() => {
	cleanup();
	unregisterWorkspaceHost(WORKSPACE, HOST);
	setScreenLocked(null);
	for (const { field, descriptor } of originalPresence) {
		if (descriptor) Object.defineProperty(document, field, descriptor);
		else Reflect.deleteProperty(document, field);
	}
});

describe("(ALERT-RETIRE-ON-EXIT) useClearActivePaneAttention", () => {
	it("reports the pane the user has open in a shown, focused window", async () => {
		render(React.createElement(Probe, { store: createStore() }));
		await settle();
		expect(seenCalls).toEqual([
			{
				workspaceId: WORKSPACE,
				terminalId: TERMINAL,
				origin: "user",
				seenThroughAt: at(5_000),
			},
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
		setFocused(false);
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
			{
				workspaceId: WORKSPACE,
				terminalId: TERMINAL,
				origin: "user",
				seenThroughAt: at(5_000),
			},
		]);
	});

	it("reports a read for a pane with nothing outstanding on it", async () => {
		resetV2NotificationStoreForTest();
		registerWorkspaceHost(WORKSPACE, HOST);
		render(React.createElement(Probe, { store: createStore() }));
		await settle();
		// No card to retract, but looking at the chat is still the read.
		expect(seenCalls).toEqual([
			{
				workspaceId: WORKSPACE,
				terminalId: TERMINAL,
				origin: "user",
				seenThroughAt: at(5_000),
			},
		]);
		expect(useV2NotificationStore.getState().terminalSeenAt[TERMINAL]).toBe(
			at(5_000),
		);
	});

	it("reads through a finish the binding has not caught up to", async () => {
		resetV2NotificationStoreForTest();
		registerWorkspaceHost(WORKSPACE, HOST);
		useV2NotificationStore
			.getState()
			.applySourceAxes(
				{ type: "terminal", id: TERMINAL },
				WORKSPACE,
				{ set: ["review"], clear: [] },
				at(6_000),
			);
		render(React.createElement(Probe, { store: createStore() }));
		await settle();
		expect(seenCalls.map((call) => call.seenThroughAt)).toEqual([at(6_000)]);
	});

	it("reports a working agent once per focus episode, and every finish", async () => {
		resetV2NotificationStoreForTest();
		registerWorkspaceHost(WORKSPACE, HOST);
		const store = createStore();
		const bindTo = (lastEventAt: number, lastEventType: string) => {
			bindings = new Map([[TERMINAL, { lastEventAt, lastEventType }]]);
		};
		bindTo(at(5_000), "Start");
		const { rerender } = render(React.createElement(Probe, { store }));
		await settle();
		const step = async () => {
			rerender(React.createElement(Probe, { store }));
			await settle();
		};

		bindTo(at(6_000), "Start");
		await step();
		bindTo(at(7_000), "Stop");
		await step();
		bindTo(at(8_000), "Failed");
		await step();
		bindTo(at(9_000), "Start");
		await step();
		useV2NotificationStore.setState((state) => ({
			outstandingReadyAt: {
				...state.outstandingReadyAt,
				[TERMINAL]: at(9_500),
			},
		}));
		bindTo(at(10_000), "Start");
		await step();

		expect(seenCalls.map((call) => call.seenThroughAt)).toEqual([
			at(5_000),
			at(7_000),
			at(8_000),
			at(10_000),
		]);
	});

	it("reports a read before the bindings load, once per focus episode", async () => {
		bindings = new Map();
		bindingsLoaded = false;
		resetV2NotificationStoreForTest();
		registerWorkspaceHost(WORKSPACE, HOST);
		const store = createStore();
		const { rerender } = render(React.createElement(Probe, { store }));
		await settle();
		bindings = new Map();
		rerender(React.createElement(Probe, { store }));
		await settle();
		expect(seenCalls).toEqual([
			{
				workspaceId: WORKSPACE,
				terminalId: TERMINAL,
				origin: "user",
				seenThroughAt: null,
			},
		]);
	});

	it("follows a read made before the bindings load with a stamped one", async () => {
		bindings = new Map();
		bindingsLoaded = false;
		resetV2NotificationStoreForTest();
		registerWorkspaceHost(WORKSPACE, HOST);
		const store = createStore();
		const { rerender } = render(React.createElement(Probe, { store }));
		await settle();
		bindings = new Map([
			[TERMINAL, { lastEventAt: at(5_000), lastEventType: "Start" }],
		]);
		bindingsLoaded = true;
		rerender(React.createElement(Probe, { store }));
		await settle();
		expect(seenCalls.map((call) => call.seenThroughAt)).toEqual([
			null,
			at(5_000),
		]);
	});
});
