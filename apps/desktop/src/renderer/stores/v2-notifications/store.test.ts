import { beforeEach, describe, expect, it } from "bun:test";
import {
	getHighestPriorityDisplayStatus,
	getV2NotificationSourcesForPane,
	getV2NotificationSourcesForTab,
	selectV2ChatNotificationStatus,
	selectV2PaneNotificationStatus,
	selectV2SourcesNotificationStatus,
	selectV2TabNotificationStatus,
	selectV2TerminalNotificationStatus,
	selectV2WorkspaceNotificationStatus,
	useV2NotificationStore,
} from "./store";

const terminalPane = {
	id: "pane-1",
	kind: "terminal",
	data: { terminalId: "terminal-1" },
};
const secondTerminalPane = {
	id: "pane-2",
	kind: "terminal",
	data: { terminalId: "terminal-2" },
};
// Upstream retired the chat pane kind, but the store still folds a chat
// source into the shared dot primitive, so the path stays covered.
const chatPane = {
	id: "pane-3",
	kind: "chat",
	data: { sessionId: "session-1" },
};
const tab = {
	id: "tab-1",
	createdAt: 0,
	activePaneId: "pane-1",
	layout: { type: "pane", paneId: "pane-1" } as const,
	panes: {
		"pane-1": terminalPane,
		"pane-2": secondTerminalPane,
	},
};

describe("v2 notification store", () => {
	beforeEach(() => {
		useV2NotificationStore.setState({ sources: {} });
	});

	it("maps panes and tabs to typed notification sources", () => {
		expect(getV2NotificationSourcesForPane(terminalPane)).toEqual([
			{ type: "terminal", id: "terminal-1" },
		]);
		expect(getV2NotificationSourcesForTab(tab)).toEqual([
			{ type: "terminal", id: "terminal-1" },
			{ type: "terminal", id: "terminal-2" },
		]);
	});

	it("folds display statuses using the shared dot precedence", () => {
		expect(
			getHighestPriorityDisplayStatus([
				"review",
				"background-running",
				"shell-running",
				"working",
				"permission",
			]),
		).toBe("permission");
		expect(
			getHighestPriorityDisplayStatus([null, "review", "shell-running"]),
		).toBe("shell-running");
		expect(getHighestPriorityDisplayStatus([null])).toBeNull();
	});

	it("derives workspace, tab, pane, terminal, and chat status from sources", () => {
		const store = useV2NotificationStore.getState();
		store.setTerminalStatus("terminal-1", "workspace-1", "working", 100);
		store.setTerminalStatus("terminal-2", "workspace-1", "permission", 101);
		store.setTerminalStatus("terminal-3", "workspace-2", "review", 102);
		store.setChatStatus("session-1", "workspace-1", "review", 103);

		const state = useV2NotificationStore.getState();
		expect(selectV2WorkspaceNotificationStatus("workspace-1")(state)).toBe(
			"permission",
		);
		expect(selectV2TabNotificationStatus("workspace-1", tab)(state)).toBe(
			"permission",
		);
		expect(
			selectV2PaneNotificationStatus("workspace-1", terminalPane)(state),
		).toBe("working");
		expect(selectV2PaneNotificationStatus("workspace-1", chatPane)(state)).toBe(
			"review",
		);
		expect(
			selectV2TerminalNotificationStatus("workspace-1", "terminal-2")(state),
		).toBe("permission");
		expect(
			selectV2ChatNotificationStatus("workspace-1", "session-1")(state),
		).toBe("review");
		expect(
			selectV2SourcesNotificationStatus("workspace-1", [
				{ type: "terminal", id: "terminal-1" },
				{ type: "terminal", id: "terminal-2" },
			])(state),
		).toBe("permission");
		expect(
			selectV2TerminalNotificationStatus("workspace-1", "terminal-3")(state),
		).toBeNull();
	});

	it("clears only review attention for a source", () => {
		const store = useV2NotificationStore.getState();
		store.setTerminalStatus("terminal-1", "workspace-1", "review", 100);
		store.setTerminalStatus("terminal-2", "workspace-1", "permission", 101);

		store.clearSourceAttention(
			{ type: "terminal", id: "terminal-1" },
			"workspace-1",
		);
		store.clearSourceAttention(
			{ type: "terminal", id: "terminal-2" },
			"workspace-1",
		);

		const state = useV2NotificationStore.getState();
		expect(state.sources["terminal:terminal-1"]).toBeUndefined();
		expect(state.sources["terminal:terminal-2"]?.status).toBe("permission");
	});

	it("clears only review attention for a workspace", () => {
		const store = useV2NotificationStore.getState();
		store.setTerminalStatus("terminal-1", "workspace-1", "review", 100);
		store.setTerminalStatus("terminal-2", "workspace-1", "working", 101);
		store.setChatStatus("session-1", "workspace-1", "permission", 102);
		store.setTerminalStatus("terminal-3", "workspace-2", "review", 103);

		store.clearWorkspaceAttention("workspace-1");

		const state = useV2NotificationStore.getState();
		expect(state.sources["terminal:terminal-1"]).toBeUndefined();
		expect(state.sources["terminal:terminal-2"]?.status).toBe("working");
		expect(state.sources["chat:session-1"]?.status).toBe("permission");
		expect(state.sources["terminal:terminal-3"]?.status).toBe("review");
	});

	describe("(DOT-AXES) layered status axes", () => {
		const source = { type: "terminal", id: "terminal-1" } as const;

		it("a working assert never stomps a latched permission; answer-evidence clears it", () => {
			const store = useV2NotificationStore.getState();
			// AskUserQuestion pending -> red.
			store.applySourceAxes(
				source,
				"workspace-1",
				{ set: ["permission"], clear: [] },
				100,
			);
			// Background agents' tool completions (SubagentActive) assert
			// working while the question is still pending: dot must stay red.
			store.applySourceAxes(
				source,
				"workspace-1",
				{ set: ["working"], clear: [] },
				101,
			);
			expect(
				useV2NotificationStore.getState().sources["terminal:terminal-1"]
					?.status,
			).toBe("permission");
			// The question is answered (main-loop Start): red clears, the
			// already-latched working axis shows through.
			store.applySourceAxes(
				source,
				"workspace-1",
				{ set: ["working"], clear: ["permission", "review"] },
				102,
			);
			expect(
				useV2NotificationStore.getState().sources["terminal:terminal-1"]
					?.status,
			).toBe("working");
		});

		it("removes the entry when the last axis clears", () => {
			const store = useV2NotificationStore.getState();
			store.applySourceAxes(
				source,
				"workspace-1",
				{ set: ["review"], clear: [] },
				100,
			);
			store.applySourceAxes(
				source,
				"workspace-1",
				{ set: [], clear: ["permission", "working", "review"] },
				101,
			);
			expect(
				useV2NotificationStore.getState().sources["terminal:terminal-1"],
			).toBeUndefined();
		});

		it("a clear-only op never reaches across workspaces", () => {
			const store = useV2NotificationStore.getState();
			store.applySourceAxes(
				source,
				"workspace-1",
				{ set: ["permission"], clear: [] },
				100,
			);
			store.applySourceAxes(
				source,
				"workspace-2",
				{ set: [], clear: ["permission", "working"] },
				101,
			);
			expect(
				useV2NotificationStore.getState().sources["terminal:terminal-1"]
					?.status,
			).toBe("permission");
		});

		it("an assert from another workspace replaces the entry wholesale", () => {
			const store = useV2NotificationStore.getState();
			store.applySourceAxes(
				source,
				"workspace-1",
				{ set: ["permission"], clear: [] },
				100,
			);
			store.applySourceAxes(
				source,
				"workspace-2",
				{ set: ["working"], clear: [] },
				101,
			);
			const entry =
				useV2NotificationStore.getState().sources["terminal:terminal-1"];
			expect(entry?.workspaceId).toBe("workspace-2");
			expect(entry?.status).toBe("working");
		});

		it("review survives a Detached-style transient clear", () => {
			const store = useV2NotificationStore.getState();
			// Turn ended unseen (review latched), then background agents kept
			// the working axis up.
			store.applySourceAxes(
				source,
				"workspace-1",
				{ set: ["review"], clear: ["permission", "working"] },
				100,
			);
			store.applySourceAxes(
				source,
				"workspace-1",
				{ set: ["working"], clear: [] },
				101,
			);
			expect(
				useV2NotificationStore.getState().sources["terminal:terminal-1"]
					?.status,
			).toBe("working");
			// The agent detaches: transient axes die, the unseen green remains.
			store.applySourceAxes(
				source,
				"workspace-1",
				{ set: [], clear: ["permission", "working"] },
				102,
			);
			expect(
				useV2NotificationStore.getState().sources["terminal:terminal-1"]
					?.status,
			).toBe("review");
		});
	});

	/**
	 * (ALERT-CONTEXT-NAMES) The boolean is what decides whether a companion
	 * retraction goes on the wire. It has to mean exactly "a green dot went
	 * away" — not "a seen mark was recorded", which happens on every focus
	 * change and would retract phone notifications for chats nobody opened.
	 */
	describe("(ALERT-CONTEXT-NAMES) markTerminalSeen reports what it removed", () => {
		const seenSource = { type: "terminal", id: "terminal-1" } as const;

		beforeEach(() => {
			useV2NotificationStore.setState({ sources: {}, terminalSeenAt: {} });
		});

		it("returns true when it actually dropped a review entry", () => {
			const store = useV2NotificationStore.getState();
			store.applySourceAxes(
				seenSource,
				"workspace-1",
				{ set: ["review"], clear: [] },
				100,
			);
			expect(store.markTerminalSeen("terminal-1", 100)).toBe(true);
			expect(
				useV2NotificationStore.getState().sources["terminal:terminal-1"],
			).toBeUndefined();
		});

		it("returns false when there was nothing green to clear", () => {
			const store = useV2NotificationStore.getState();
			expect(store.markTerminalSeen("terminal-1", 100)).toBe(false);
			// It still recorded the seen mark: the return value is about the DOT,
			// not about whether the call did anything at all.
			expect(
				useV2NotificationStore.getState().terminalSeenAt["terminal-1"],
			).toBe(100);
		});

		it("returns false for a source that is red or yellow, not green", () => {
			const store = useV2NotificationStore.getState();
			store.applySourceAxes(
				seenSource,
				"workspace-1",
				{ set: ["permission"], clear: [] },
				100,
			);
			expect(store.markTerminalSeen("terminal-1", 100)).toBe(false);
		});

		it("returns false on the SECOND call — one green, one retraction", () => {
			const store = useV2NotificationStore.getState();
			store.applySourceAxes(
				seenSource,
				"workspace-1",
				{ set: ["review"], clear: [] },
				100,
			);
			expect(store.markTerminalSeen("terminal-1", 100)).toBe(true);
			expect(store.markTerminalSeen("terminal-1", 100)).toBe(false);
			expect(store.markTerminalSeen("terminal-1", 200)).toBe(false);
		});
	});

	/**
	 * (ONE-BUZZ-UNTIL-READ) The outstanding-ready record. The green dot is a
	 * transient — the agent starting work again deletes it — while the phone's
	 * notification survives until something retracts it. This record is what
	 * remembers, across that gap, WHICH finish is still on a device.
	 */
	describe("(ONE-BUZZ-UNTIL-READ) outstandingReadyAt", () => {
		const seenSource = { type: "terminal", id: "terminal-1" } as const;

		beforeEach(() => {
			useV2NotificationStore.setState({
				sources: {},
				terminalSeenAt: {},
				outstandingReadyAt: {},
			});
		});

		it("records the instant a review axis was SET", () => {
			useV2NotificationStore
				.getState()
				.applySourceAxes(
					seenSource,
					"workspace-1",
					{ set: ["review"], clear: [] },
					100,
				);
			expect(
				useV2NotificationStore.getState().outstandingReadyAt["terminal-1"],
			).toBe(100);
		});

		it("SURVIVES the agent going back to work", () => {
			const store = useV2NotificationStore.getState();
			store.applySourceAxes(
				seenSource,
				"workspace-1",
				{ set: ["review"], clear: [] },
				100,
			);
			store.applySourceAxes(
				seenSource,
				"workspace-1",
				{ set: ["working"], clear: ["permission", "review"] },
				200,
			);
			const state = useV2NotificationStore.getState();
			// The dot is gone; the notification on the phone is not.
			expect(state.sources["terminal:terminal-1"]?.status).toBe("working");
			expect(state.outstandingReadyAt["terminal-1"]).toBe(100);
		});

		it("survives the seen mark that clears the dot", () => {
			const store = useV2NotificationStore.getState();
			store.applySourceAxes(
				seenSource,
				"workspace-1",
				{ set: ["review"], clear: [] },
				100,
			);
			expect(store.markTerminalSeen("terminal-1", 100)).toBe(true);
			// Only a report a HOST consumed retires it — `markTerminalSeen` has no
			// idea whether the mutation landed.
			expect(
				useV2NotificationStore.getState().outstandingReadyAt["terminal-1"],
			).toBe(100);
		});

		it("is superseded by a newer finish, never regressed by an older one", () => {
			const store = useV2NotificationStore.getState();
			for (const at of [100, 300, 200]) {
				store.applySourceAxes(
					seenSource,
					"workspace-1",
					{ set: ["review"], clear: [] },
					at,
				);
			}
			expect(
				useV2NotificationStore.getState().outstandingReadyAt["terminal-1"],
			).toBe(300);
		});

		it("is not written by a red or a yellow", () => {
			const store = useV2NotificationStore.getState();
			store.applySourceAxes(
				seenSource,
				"workspace-1",
				{ set: ["permission"], clear: [] },
				100,
			);
			store.applySourceAxes(
				seenSource,
				"workspace-1",
				{ set: ["working"], clear: [] },
				200,
			);
			expect(
				useV2NotificationStore.getState().outstandingReadyAt["terminal-1"],
			).toBeUndefined();
		});

		it("is dropped by an explicit clear and by the terminal going away", () => {
			const store = useV2NotificationStore.getState();
			store.applySourceAxes(
				seenSource,
				"workspace-1",
				{ set: ["review"], clear: [] },
				100,
			);
			store.clearOutstandingReady("terminal-1", 100);
			expect(
				useV2NotificationStore.getState().outstandingReadyAt["terminal-1"],
			).toBeUndefined();

			store.applySourceAxes(
				seenSource,
				"workspace-1",
				{ set: ["review"], clear: [] },
				300,
			);
			store.markTerminalSeen("terminal-1", 300);
			store.pruneTerminalSeen("terminal-1");
			const state = useV2NotificationStore.getState();
			expect(state.outstandingReadyAt["terminal-1"]).toBeUndefined();
			expect(state.terminalSeenAt["terminal-1"]).toBeUndefined();
		});

		/**
		 * (ONE-BUZZ-UNTIL-READ) COMPARE-AND-CLEAR. A report is a network round
		 * trip, and the agent does not stop working during it: finish B can land
		 * while the read of finish A is still in the air. Clearing on A's
		 * acknowledgement would throw away B's only evidence — the next `Start`
		 * then clears B's green and opening the chat would report nothing, so B's
		 * card sits on the phone until it expires.
		 */
		it("keeps a NEWER record when an older report is acknowledged", () => {
			const store = useV2NotificationStore.getState();
			store.applySourceAxes(
				seenSource,
				"workspace-1",
				{ set: ["review"], clear: [] },
				100,
			);
			// Finish B lands while A's report is in flight.
			store.applySourceAxes(
				seenSource,
				"workspace-1",
				{ set: ["review"], clear: [] },
				200,
			);
			store.clearOutstandingReady("terminal-1", 100);
			expect(
				useV2NotificationStore.getState().outstandingReadyAt["terminal-1"],
			).toBe(200);

			// B's own report retires it.
			store.clearOutstandingReady("terminal-1", 200);
			expect(
				useV2NotificationStore.getState().outstandingReadyAt["terminal-1"],
			).toBeUndefined();
		});

		it("clears when the acknowledgement covers more than the record", () => {
			const store = useV2NotificationStore.getState();
			store.applySourceAxes(
				seenSource,
				"workspace-1",
				{ set: ["review"], clear: [] },
				100,
			);
			store.clearOutstandingReady("terminal-1", 5_000);
			expect(
				useV2NotificationStore.getState().outstandingReadyAt["terminal-1"],
			).toBeUndefined();
		});
	});
});
