import { describe, expect, it } from "bun:test";
import { createWorkspaceStore, type WorkspaceState } from "@superset/panes";
import type { PaneViewerData } from "../../types";
import {
	chatSessionBelongsToWorkspace,
	consumeChatAutomationRunLink,
	consumeTabAutomationRunLink,
	consumeTerminalAutomationRunLink,
	getAutomationRunLinkConsumeKey,
	terminalSessionBelongsToWorkspace,
} from "./useConsumeAutomationRunLink";

const EMPTY_STATE: WorkspaceState<PaneViewerData> = {
	version: 1,
	tabs: [],
	activeTabId: null,
};

function stateWithTab(tabId = "tab-1"): WorkspaceState<PaneViewerData> {
	return {
		version: 1,
		activeTabId: null,
		tabs: [
			{
				id: tabId,
				createdAt: 1,
				activePaneId: "pane-1",
				layout: { type: "pane", paneId: "pane-1" },
				panes: {
					"pane-1": {
						id: "pane-1",
						kind: "terminal",
						data: { terminalId: "terminal-existing" } as PaneViewerData,
					},
				},
			},
		],
	};
}

describe("getAutomationRunLinkConsumeKey", () => {
	it("dedupes plain automation links by source id", () => {
		expect(
			getAutomationRunLinkConsumeKey({
				type: "terminal",
				id: "terminal-1",
				focusRequestId: undefined,
			}),
		).toBe("terminal:terminal-1");
		expect(
			getAutomationRunLinkConsumeKey({
				type: "chat",
				id: "chat-1",
				focusRequestId: undefined,
			}),
		).toBe("chat:chat-1");
		expect(
			getAutomationRunLinkConsumeKey({
				type: "tab",
				id: "tab-1",
				focusRequestId: undefined,
			}),
		).toBe("tab:tab-1");
	});

	it("treats each notification focus request as a fresh command", () => {
		expect(
			getAutomationRunLinkConsumeKey({
				type: "terminal",
				id: "terminal-1",
				focusRequestId: "request-1",
			}),
		).toBe("terminal:terminal-1:focus:request-1");
		expect(
			getAutomationRunLinkConsumeKey({
				type: "terminal",
				id: "terminal-1",
				focusRequestId: "request-2",
			}),
		).toBe("terminal:terminal-1:focus:request-2");
	});
});

describe("automation run link effect bodies", () => {
	it("does not focus, add, or consume any link before pane layout readiness", () => {
		const store = createWorkspaceStore<PaneViewerData>({
			initialState: EMPTY_STATE,
		});
		const consumedKeys = new Set<string>();

		expect(
			consumeTabAutomationRunLink({
				store,
				paneLayoutReady: false,
				tabId: "tab-1",
				focusRequestId: "request-tab",
				consumedKeys,
			}),
		).toBe(false);
		expect(
			consumeTerminalAutomationRunLink({
				store,
				workspaceId: "workspace-1",
				paneLayoutReady: false,
				terminalId: "terminal-1",
				focusRequestId: "request-terminal",
				terminalSessionsReady: true,
				terminalSessions: [
					{ terminalId: "terminal-1", workspaceId: "workspace-1" },
				],
				consumedKeys,
			}),
		).toBe(false);
		expect(
			consumeChatAutomationRunLink({
				store,
				workspaceId: "workspace-1",
				paneLayoutReady: false,
				chatSessionId: "chat-1",
				focusRequestId: "request-chat",
				chatSessionsReady: true,
				chatSession: { v2WorkspaceId: "workspace-1" },
				consumedKeys,
			}),
		).toBe(false);
		expect(store.getState().tabs).toHaveLength(0);
		expect(consumedKeys.size).toBe(0);
	});

	it("keeps a missing tab retryable and dedupes by focus request", () => {
		const store = createWorkspaceStore<PaneViewerData>({
			initialState: EMPTY_STATE,
		});
		const consumedKeys = new Set<string>();
		const common = {
			store,
			paneLayoutReady: true,
			tabId: "tab-1",
			consumedKeys,
		};

		expect(
			consumeTabAutomationRunLink({
				...common,
				focusRequestId: "request-1",
			}),
		).toBe(false);
		expect(consumedKeys.size).toBe(0);

		store.getState().replaceState(stateWithTab());
		let setActiveTabCalls = 0;
		const setActiveTab = store.getState().setActiveTab;
		store.setState({
			setActiveTab: (tabId) => {
				setActiveTabCalls += 1;
				setActiveTab(tabId);
			},
		});

		expect(
			consumeTabAutomationRunLink({
				...common,
				focusRequestId: "request-1",
			}),
		).toBe(true);
		expect(store.getState().activeTabId).toBe("tab-1");
		expect(setActiveTabCalls).toBe(1);
		expect(
			consumeTabAutomationRunLink({
				...common,
				focusRequestId: "request-1",
			}),
		).toBe(false);
		expect(setActiveTabCalls).toBe(1);
		expect(
			consumeTabAutomationRunLink({
				...common,
				focusRequestId: "request-2",
			}),
		).toBe(true);
		expect(setActiveTabCalls).toBe(2);
	});

	it("still adopts a terminal session after pane layout readiness", () => {
		const store = createWorkspaceStore<PaneViewerData>({
			initialState: EMPTY_STATE,
		});

		expect(
			consumeTerminalAutomationRunLink({
				store,
				workspaceId: "workspace-1",
				paneLayoutReady: true,
				terminalId: "terminal-1",
				focusRequestId: "request-1",
				terminalSessionsReady: true,
				terminalSessions: [
					{ terminalId: "terminal-1", workspaceId: "workspace-1" },
				],
				consumedKeys: new Set(),
			}),
		).toBe(true);
		expect(store.getState().tabs).toHaveLength(1);
		expect(
			Object.values(store.getState().tabs[0]?.panes ?? {}).some(
				(pane) =>
					pane.kind === "terminal" &&
					(pane.data as { terminalId?: string }).terminalId === "terminal-1",
			),
		).toBe(true);
	});
});

describe("automation run link ownership checks", () => {
	it("accepts terminal sessions only from the current workspace", () => {
		const sessions = [
			{ terminalId: "terminal-a", workspaceId: "workspace-a" },
			{ terminalId: "terminal-b", workspaceId: "workspace-b" },
		];

		expect(
			terminalSessionBelongsToWorkspace({
				sessions,
				terminalId: "terminal-a",
				workspaceId: "workspace-a",
			}),
		).toBe(true);
		expect(
			terminalSessionBelongsToWorkspace({
				sessions,
				terminalId: "terminal-a",
				workspaceId: "workspace-b",
			}),
		).toBe(false);
	});

	it("accepts chat sessions only from the current v2 workspace", () => {
		expect(
			chatSessionBelongsToWorkspace({
				chatSession: { v2WorkspaceId: "workspace-a" },
				workspaceId: "workspace-a",
			}),
		).toBe(true);
		expect(
			chatSessionBelongsToWorkspace({
				chatSession: { v2WorkspaceId: "workspace-a" },
				workspaceId: "workspace-b",
			}),
		).toBe(false);
		expect(
			chatSessionBelongsToWorkspace({
				chatSession: null,
				workspaceId: "workspace-a",
			}),
		).toBe(false);
		expect(
			chatSessionBelongsToWorkspace({
				chatSession: { v2WorkspaceId: null },
				workspaceId: "workspace-a",
			}),
		).toBe(false);
	});
});
