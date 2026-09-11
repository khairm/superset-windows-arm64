import type { WorkspaceStore } from "@superset/panes";
import { workspaceTrpc } from "@superset/workspace-client";
import { useEffect, useRef } from "react";
import type { StoreApi } from "zustand/vanilla";
import type { PaneViewerData } from "../../types";
import { focusOrAddTerminalPane } from "../../utils/focusTerminalPane";

interface UseConsumeAutomationRunLinkArgs {
	store: StoreApi<WorkspaceStore<PaneViewerData>>;
	workspaceId: string;
	paneLayoutReady: boolean;
	tabId: string | undefined;
	terminalId: string | undefined;
	focusRequestId: string | undefined;
}

/**
 * When the workspace is opened via a deep link from an automation run
 * (`?terminalId=...`), ensure the corresponding pane is present and focused.
 * The underlying session already exists on the host-service from the
 * dispatcher — we just re-adopt it in the pane store. A run whose agent was
 * since relaunched into a fresh terminal (an account-switch restart) is
 * followed to that terminal, so the link still lands on the conversation.
 */
export function useConsumeAutomationRunLink({
	store,
	workspaceId,
	paneLayoutReady,
	tabId,
	terminalId,
	focusRequestId,
}: UseConsumeAutomationRunLinkArgs): void {
	const consumedRef = useRef<Set<string>>(new Set());
	const terminalSessionsQuery = workspaceTrpc.terminal.list.useQuery(
		{ workspaceId },
		{
			enabled: terminalId != null,
			refetchOnWindowFocus: false,
		},
	);
	const linkedTerminalIsLive =
		terminalId != null &&
		terminalSessionsQuery.isSuccess &&
		terminalSessionBelongsToWorkspace({
			sessions: terminalSessionsQuery.data.sessions,
			terminalId,
			workspaceId,
		});
	// Only a dead link is worth a successor lookup — the live case is the
	// common one and needs nothing more than the session list.
	const successorQuery = workspaceTrpc.terminalAgents.resumedSuccessor.useQuery(
		{ workspaceId, terminalId: terminalId ?? "" },
		{
			enabled:
				terminalId != null &&
				terminalSessionsQuery.isSuccess &&
				!linkedTerminalIsLive,
			refetchOnWindowFocus: false,
		},
	);
	// undefined = still resolving; null = nothing to open.
	const targetTerminalId = linkedTerminalIsLive
		? terminalId
		: successorQuery.isSuccess
			? (successorQuery.data?.terminalId ?? null)
			: undefined;
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
		// `undefined` means the successor lookup is still resolving; consuming
		// the link now would burn its key before we know where it points.
		if (!paneLayoutReady || targetTerminalId === undefined) return;
		consumeTerminalAutomationRunLink({
			store,
			workspaceId,
			paneLayoutReady,
			terminalId,
			focusRequestId,
			terminalSessionsReady: terminalSessionsQuery.isSuccess,
			terminalSessions: terminalSessionsQuery.data?.sessions,
			resumedTerminalId: targetTerminalId,
			consumedKeys: consumedRef.current,
		});
	}, [
		store,
		terminalId,
		focusRequestId,
		terminalSessionsQuery.isSuccess,
		terminalSessionsQuery.data,
		targetTerminalId,
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
	resumedTerminalId,
	consumedKeys,
}: AutomationRunLinkBaseArgs & {
	workspaceId: string;
	terminalId: string | undefined;
	terminalSessionsReady: boolean;
	terminalSessions:
		| Array<{ terminalId: string; workspaceId: string }>
		| undefined;
	/**
	 * Where the run's agent lives now when the linked terminal is gone — an
	 * account-switch restart relaunches it into a fresh terminal. `null` when
	 * nothing resumed it; omitted by callers that do not look one up.
	 */
	resumedTerminalId?: string | null;
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
		if (resumedTerminalId) {
			focusOrAddTerminalPane(store, resumedTerminalId);
			return true;
		}
		console.warn(
			"[automation-run-link] Ignoring terminal link: not in this workspace and not resumed elsewhere",
			{ terminalId, workspaceId },
		);
		return true;
	}
	focusOrAddTerminalPane(store, terminalId);
	return true;
}

export function getAutomationRunLinkConsumeKey({
	type,
	id,
	focusRequestId,
}: {
	type: "terminal" | "tab";
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
