/**
 * (MASTER-PLUS-LAUNCH) A session created AFTER the terminal list has settled
 * still has to get a pane.
 *
 * The hook's own `isFetching` gate only covers the mount-time race: on open,
 * the list is refetching and the effect waits for it. Once it has settled,
 * nothing re-runs — a session minted later by the CLI or `agents.run` changes
 * no query input, so before the lifecycle subscription it simply never
 * appeared. What is asserted here is that wiring end to end: an empty settled
 * list, a `terminal:lifecycle` event, the invalidate it triggers, and the pane
 * that follows once the refetched list lands.
 *
 * The event doing the work is the host's `created` eventType, and ONLY that
 * one: the command markers fire on every shell command the user runs, and
 * refetching the session list for each of them is a daemon round trip plus a
 * re-render for nothing. The host side — that a create actually broadcasts
 * `created` — is asserted in
 * `packages/host-service/src/terminal/terminal.created-event.test.ts`.
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
import type { TerminalLifecyclePayload } from "@superset/workspace-client";
import type { PaneViewerData } from "../../types";

// happy-dom over the preloaded plain-object document — this renders a real
// component tree. Bun runs test files sequentially in one process and
// happy-dom's globals are process-wide, so we MUST unregister in afterAll or
// unrelated renderer suites inherit readonly DOM globals.
const alreadyRegistered = GlobalRegistrator.isRegistered;
if (!alreadyRegistered) GlobalRegistrator.register();
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

interface SessionLike {
	terminalId: string;
	workspaceId: string;
	createdAt: number;
}

interface EventSubscription {
	type: string;
	workspaceId: string;
	callback: (payload: TerminalLifecyclePayload) => void;
	enabled: boolean;
}

let sessions: SessionLike[] | undefined;
let isFetching = false;
let invalidateCalls: Array<{ workspaceId: string }> = [];
let subscriptions: EventSubscription[] = [];

/**
 * `mock.module` is PROCESS-GLOBAL and there is no unmock, so each stub here
 * outlives this file. Both are the REAL module with a single export
 * overridden, so a module that later grows an export does not silently lose
 * it for whatever bun runs next. `workspaceTrpc` is a tRPC proxy that cannot
 * be spread, so it is replaced wholesale — only the two members this hook
 * touches exist on it.
 */
const realWorkspaceClient = await import("@superset/workspace-client");
const realUseWorkspaceEvent = await import(
	"renderer/hooks/host-service/useWorkspaceEvent"
);

function installMocks(): void {
	mock.module("@superset/workspace-client", () => ({
		...realWorkspaceClient,
		workspaceTrpc: {
			terminal: {
				list: {
					useQuery: () => ({
						data: sessions ? { sessions } : undefined,
						isFetching,
					}),
				},
			},
			useUtils: () => ({
				terminal: {
					list: {
						invalidate: (input: { workspaceId: string }) => {
							invalidateCalls.push(input);
							return Promise.resolve();
						},
					},
				},
			}),
		},
	}));

	// The real hook resolves the workspace's host through the auth/cloud
	// provider tree, which no unit harness has. Recording the subscription is
	// what this test needs from it anyway.
	mock.module("renderer/hooks/host-service/useWorkspaceEvent", () => ({
		...realUseWorkspaceEvent,
		useWorkspaceEvent: (
			type: string,
			workspaceId: string,
			callback: (payload: TerminalLifecyclePayload) => void,
			enabled = true,
		) => {
			const existing = subscriptions.find(
				(entry) => entry.type === type && entry.workspaceId === workspaceId,
			);
			if (existing) {
				existing.callback = callback;
				existing.enabled = enabled;
				return;
			}
			subscriptions.push({ type, workspaceId, callback, enabled });
		},
	}));
}

installMocks();

const { act, cleanup, render } = await import("@testing-library/react");
const React = await import("react");
const { createWorkspaceStore } = await import("@superset/panes");
const { useAutoAdoptBackgroundSessions } = await import(
	"./useAutoAdoptBackgroundSessions"
);

const WORKSPACE_ID = "workspace-1";

type Store = ReturnType<typeof createWorkspaceStore<PaneViewerData>>;

function createStore(): Store {
	return createWorkspaceStore<PaneViewerData>({
		initialState: { version: 1, tabs: [], activeTabId: null },
	});
}

function Probe({
	store,
	isLayoutReady,
}: {
	store: Store;
	isLayoutReady: boolean;
}) {
	useAutoAdoptBackgroundSessions({
		store,
		workspaceId: WORKSPACE_ID,
		isLayoutReady,
	});
	return null;
}

function mount(store: Store, isLayoutReady = true) {
	return render(React.createElement(Probe, { store, isLayoutReady }));
}

/** Terminal ids of every terminal pane currently in the store. */
function panedTerminalIds(store: Store): string[] {
	const ids: string[] = [];
	for (const tab of store.getState().tabs) {
		for (const pane of Object.values(tab.panes)) {
			if (pane.kind !== "terminal") continue;
			const terminalId = (pane.data as { terminalId?: string } | undefined)
				?.terminalId;
			if (terminalId) ids.push(terminalId);
		}
	}
	return ids;
}

/** Delivers a `terminal:lifecycle` event the way the host event bus would. */
function fireTerminalLifecycle(
	payload: TerminalLifecyclePayload = {
		eventType: "created",
		terminalId: "terminal-1",
		adopted: false,
		occurredAt: 1,
	},
): void {
	const subscription = subscriptions.find(
		(entry) => entry.type === "terminal:lifecycle",
	);
	if (!subscription) throw new Error("no terminal:lifecycle subscription");
	if (!subscription.enabled) return;
	act(() => {
		subscription.callback(payload);
	});
}

describe("(MASTER-PLUS-LAUNCH) useAutoAdoptBackgroundSessions lifecycle refetch", () => {
	beforeEach(() => {
		sessions = [];
		isFetching = false;
		invalidateCalls = [];
		subscriptions = [];
		installMocks();
	});

	afterEach(() => {
		cleanup();
	});

	afterAll(async () => {
		if (!alreadyRegistered) await GlobalRegistrator.unregister();
	});

	it("adopts a session that lands after the list has already settled", async () => {
		const store = createStore();
		const view = mount(store);

		// Settled and empty: nothing to adopt, and no further query change is
		// coming on its own.
		expect(panedTerminalIds(store)).toEqual([]);
		expect(invalidateCalls).toEqual([]);

		// The host announces the CLI-created session.
		fireTerminalLifecycle();
		expect(invalidateCalls).toEqual([{ workspaceId: WORKSPACE_ID }]);

		// The refetch that invalidate triggered lands.
		sessions = [
			{ terminalId: "terminal-1", workspaceId: WORKSPACE_ID, createdAt: 1 },
		];
		await act(async () => {
			view.rerender(React.createElement(Probe, { store, isLayoutReady: true }));
		});

		expect(panedTerminalIds(store)).toEqual(["terminal-1"]);
	});

	it("ignores command markers — only a create is worth a refetch", () => {
		const store = createStore();
		mount(store);

		fireTerminalLifecycle({
			eventType: "command-start",
			terminalId: "terminal-1",
			occurredAt: 2,
		});
		fireTerminalLifecycle({
			eventType: "command-end",
			terminalId: "terminal-1",
			exitCode: 0,
			occurredAt: 3,
		});

		expect(invalidateCalls).toEqual([]);
	});

	it("subscribes for this workspace only once the pane layout is ready", () => {
		const store = createStore();
		mount(store, false);

		const subscription = subscriptions.find(
			(entry) => entry.type === "terminal:lifecycle",
		);
		expect(subscription?.workspaceId).toBe(WORKSPACE_ID);
		expect(subscription?.enabled).toBe(false);
	});

	it("does not adopt while the list is still refetching", async () => {
		const store = createStore();
		isFetching = true;
		sessions = [
			{ terminalId: "terminal-stale", workspaceId: WORKSPACE_ID, createdAt: 1 },
		];
		mount(store);

		expect(panedTerminalIds(store)).toEqual([]);
	});

	it("re-adopting an already-paned session adds no second pane", async () => {
		const store = createStore();
		sessions = [
			{ terminalId: "terminal-1", workspaceId: WORKSPACE_ID, createdAt: 1 },
		];
		const view = mount(store);
		expect(panedTerminalIds(store)).toEqual(["terminal-1"]);

		fireTerminalLifecycle();
		await act(async () => {
			view.rerender(React.createElement(Probe, { store, isLayoutReady: true }));
		});

		expect(panedTerminalIds(store)).toEqual(["terminal-1"]);
	});
});
