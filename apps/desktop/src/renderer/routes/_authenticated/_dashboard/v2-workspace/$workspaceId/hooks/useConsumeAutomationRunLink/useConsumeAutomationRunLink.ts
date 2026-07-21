import type { WorkspaceStore } from "@superset/panes";
import { workspaceTrpc } from "@superset/workspace-client";
import { eq } from "@tanstack/db";
import { useLiveQuery } from "@tanstack/react-db";
import { useEffect, useRef } from "react";
import { useCollections } from "renderer/routes/_authenticated/providers/CollectionsProvider";
import type { StoreApi } from "zustand/vanilla";
import type { ChatPaneData, PaneViewerData } from "../../types";
import { focusOrAddTerminalPane } from "../../utils/focusTerminalPane";

interface UseConsumeAutomationRunLinkArgs {
	store: StoreApi<WorkspaceStore<PaneViewerData>>;
	workspaceId: string;
	paneLayoutReady: boolean;
	tabId: string | undefined;
	terminalId: string | undefined;
	chatSessionId: string | undefined;
	focusRequestId: string | undefined;
}

/**
 * When the workspace is opened via a deep link from an automation run
 * (`?terminalId=...` or `?chatSessionId=...`), ensure the corresponding pane
 * is present and focused. The underlying session already exists on the
 * host-service from the dispatcher — we just re-adopt it in the pane store.
 */
export function useConsumeAutomationRunLink({
	store,
	workspaceId,
	paneLayoutReady,
	tabId,
	terminalId,
	chatSessionId,
	focusRequestId,
}: UseConsumeAutomationRunLinkArgs): void {
	const consumedRef = useRef<Set<string>>(new Set());
	const collections = useCollections();
	const terminalSessionsQuery = workspaceTrpc.terminal.listSessions.useQuery(
		{ workspaceId },
		{
			enabled: terminalId != null,
			refetchOnWindowFocus: false,
		},
	);
	const { data: chatSessionRows, isReady: chatSessionsReady } = useLiveQuery(
		(q) =>
			q
				.from({ chatSessions: collections.chatSessions })
				.where(({ chatSessions }) => eq(chatSessions.id, chatSessionId ?? "")),
		[collections, chatSessionId],
	);
	const chatSession = chatSessionRows?.[0] ?? null;

	useEffect(() => {
		if (!paneLayoutReady) return;
		consumeTabAutomationRunLink({
			store,
			paneLayoutReady,
			tabId,
			focusRequestId,
			consumedKeys: consumedRef.current,
		});
	}, [store, tabId, focusRequestId, paneLayoutReady]);

	useEffect(() => {
		if (!paneLayoutReady) return;
		consumeTerminalAutomationRunLink({
			store,
			workspaceId,
			paneLayoutReady,
			terminalId,
			focusRequestId,
			terminalSessionsReady: terminalSessionsQuery.isSuccess,
			terminalSessions: terminalSessionsQuery.data?.sessions,
			consumedKeys: consumedRef.current,
		});
	}, [
		store,
		terminalId,
		focusRequestId,
		terminalSessionsQuery.isSuccess,
		terminalSessionsQuery.data,
		workspaceId,
		paneLayoutReady,
	]);

	useEffect(() => {
		if (!paneLayoutReady) return;
		consumeChatAutomationRunLink({
			store,
			workspaceId,
			paneLayoutReady,
			chatSessionId,
			focusRequestId,
			chatSessionsReady,
			chatSession,
			consumedKeys: consumedRef.current,
		});
	}, [
		store,
		chatSessionId,
		focusRequestId,
		chatSession,
		chatSessionsReady,
		workspaceId,
		paneLayoutReady,
	]);
}

interface AutomationRunLinkBaseArgs {
	store: StoreApi<WorkspaceStore<PaneViewerData>>;
	paneLayoutReady: boolean;
	focusRequestId: string | undefined;
	consumedKeys: Set<string>;
}

export function consumeTabAutomationRunLink({
	store,
	paneLayoutReady,
	tabId,
	focusRequestId,
	consumedKeys,
}: AutomationRunLinkBaseArgs & { tabId: string | undefined }): boolean {
	if (!paneLayoutReady || !tabId) return false;
	const key = getAutomationRunLinkConsumeKey({
		type: "tab",
		id: tabId,
		focusRequestId,
	});
	if (consumedKeys.has(key)) return false;
	const state = store.getState();
	// (TAB-CHIPS) A stale tab link is a no-op and remains retryable in case the
	// persisted pane layout has not exposed that tab yet.
	if (!state.tabs.some((tab) => tab.id === tabId)) return false;
	consumedKeys.add(key);
	state.setActiveTab(tabId);
	return true;
}

export function consumeTerminalAutomationRunLink({
	store,
	workspaceId,
	paneLayoutReady,
	terminalId,
	focusRequestId,
	terminalSessionsReady,
	terminalSessions,
	consumedKeys,
}: AutomationRunLinkBaseArgs & {
	workspaceId: string;
	terminalId: string | undefined;
	terminalSessionsReady: boolean;
	terminalSessions:
		| Array<{ terminalId: string; workspaceId: string }>
		| undefined;
}): boolean {
	if (!paneLayoutReady || !terminalId || !terminalSessionsReady) return false;
	if (!terminalSessions) {
		throw new Error("Terminal sessions query succeeded without data");
	}
	const key = getAutomationRunLinkConsumeKey({
		type: "terminal",
		id: terminalId,
		focusRequestId,
	});
	if (consumedKeys.has(key)) return false;
	consumedKeys.add(key);
	if (
		!terminalSessionBelongsToWorkspace({
			sessions: terminalSessions,
			terminalId,
			workspaceId,
		})
	) {
		console.warn(
			"[automation-run-link] Ignoring terminal link for another workspace",
			{ terminalId, workspaceId },
		);
		return true;
	}
	focusOrAddTerminalPane(store, terminalId);
	return true;
}

export function consumeChatAutomationRunLink({
	store,
	workspaceId,
	paneLayoutReady,
	chatSessionId,
	focusRequestId,
	chatSessionsReady,
	chatSession,
	consumedKeys,
}: AutomationRunLinkBaseArgs & {
	workspaceId: string;
	chatSessionId: string | undefined;
	chatSessionsReady: boolean;
	chatSession: { v2WorkspaceId: string | null } | null;
}): boolean {
	if (
		!paneLayoutReady ||
		!chatSessionId ||
		!chatSessionsReady ||
		!chatSession
	) {
		return false;
	}
	const key = getAutomationRunLinkConsumeKey({
		type: "chat",
		id: chatSessionId,
		focusRequestId,
	});
	if (consumedKeys.has(key)) return false;
	consumedKeys.add(key);
	if (!chatSessionBelongsToWorkspace({ chatSession, workspaceId })) {
		console.warn(
			"[automation-run-link] Ignoring chat link for another workspace",
			{ chatSessionId, workspaceId },
		);
		return true;
	}
	focusOrAddChatPane(store, chatSessionId);
	return true;
}

export function getAutomationRunLinkConsumeKey({
	type,
	id,
	focusRequestId,
}: {
	type: "terminal" | "chat" | "tab";
	id: string;
	focusRequestId: string | undefined;
}): string {
	return focusRequestId
		? `${type}:${id}:focus:${focusRequestId}`
		: `${type}:${id}`;
}

export function terminalSessionBelongsToWorkspace({
	sessions,
	terminalId,
	workspaceId,
}: {
	sessions: Array<{ terminalId: string; workspaceId: string }>;
	terminalId: string;
	workspaceId: string;
}): boolean {
	return sessions.some(
		(session) =>
			session.terminalId === terminalId && session.workspaceId === workspaceId,
	);
}

export function chatSessionBelongsToWorkspace({
	chatSession,
	workspaceId,
}: {
	chatSession: { v2WorkspaceId: string | null } | null;
	workspaceId: string;
}): boolean {
	return chatSession?.v2WorkspaceId === workspaceId;
}

function focusOrAddChatPane(
	store: StoreApi<WorkspaceStore<PaneViewerData>>,
	sessionId: string,
): void {
	const state = store.getState();
	for (const tab of state.tabs) {
		for (const pane of Object.values(tab.panes)) {
			if (pane.kind !== "chat") continue;
			const data = pane.data as ChatPaneData;
			if (data.sessionId === sessionId) {
				state.setActiveTab(tab.id);
				state.setActivePane({ tabId: tab.id, paneId: pane.id });
				return;
			}
		}
	}
	state.addTab({
		panes: [
			{
				kind: "chat",
				data: { sessionId } as PaneViewerData,
			},
		],
	});
}
