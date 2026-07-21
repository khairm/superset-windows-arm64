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
		"pane-3": chatPane,
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
		expect(getV2NotificationSourcesForPane(chatPane)).toEqual([
			{ type: "chat", id: "session-1" },
		]);
		expect(getV2NotificationSourcesForTab(tab)).toEqual([
			{ type: "terminal", id: "terminal-1" },
			{ type: "terminal", id: "terminal-2" },
			{ type: "chat", id: "session-1" },
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
});
