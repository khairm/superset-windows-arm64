import type { NotificationIds } from "shared/notification-types";
import type { Pane, Tab } from "../types";

interface TabsState {
	panes: Record<string, Pane>;
	tabs: Tab[];
}

interface ResolvedTarget extends NotificationIds {
	workspaceId: string; // Required in resolved target
}

/**
 * Normalize a cwd for comparison: lowercase + forward slashes.
 * Windows paths can vary in case ("C:\Users\..." vs "c:\users\...") and
 * separator style depending on how the cwd was captured.
 */
function normalizeCwd(cwd: string): string {
	return cwd.replace(/\\/g, "/").toLowerCase();
}

/**
 * Resolves notification target IDs by looking up missing values from state.
 * Priority: valid paneId > sessionId > cwd (terminal panes) > pane's tab
 * > event tabId > tab's workspace
 *
 * cwd lookup is the fallback path used by the Windows JSONL-watcher
 * (`patches/agent-jsonl-watcher.patch`) — Claude's session transcripts
 * give us cwd but no Superset pane identity, so we match against the live
 * renderer Zustand state here rather than the (debounced/stale)
 * main-process appState.
 */
export function resolveNotificationTarget(
	ids: NotificationIds | undefined,
	state: TabsState,
): ResolvedTarget | null {
	if (!ids) return null;

	const { paneId, sessionId, tabId, workspaceId, cwd } = ids;

	const paneIdFromSession = sessionId
		? Object.entries(state.panes).find(
				([_paneId, pane]) => pane.chat?.sessionId === sessionId,
			)?.[0]
		: undefined;
	const paneIdFromCwd = cwd
		? (() => {
				// Only resolve via cwd when EXACTLY one terminal pane
				// matches — with multiple matches we'd misroute the
				// indicator to whichever pane came first. Wait for a
				// precise mapping (the Python pane-map hook writes one)
				// instead of guessing.
				const target = normalizeCwd(cwd);
				let match: string | undefined;
				for (const [id, p] of Object.entries(state.panes)) {
					if (p.type !== "terminal") continue;
					if (!p.cwd) continue;
					if (normalizeCwd(p.cwd) !== target) continue;
					if (match !== undefined) return undefined; // ambiguous
					match = id;
				}
				return match;
			})()
		: undefined;
	const resolvedPaneId =
		(paneId && state.panes[paneId] ? paneId : undefined) ??
		(paneIdFromSession && state.panes[paneIdFromSession]
			? paneIdFromSession
			: undefined) ??
		(paneIdFromCwd && state.panes[paneIdFromCwd]
			? paneIdFromCwd
			: undefined);
	const pane = resolvedPaneId ? state.panes[resolvedPaneId] : undefined;

	// Resolve tabId: prefer pane's tabId, fallback to event tabId
	const resolvedTabId = pane?.tabId ?? tabId;

	const tab = resolvedTabId
		? state.tabs.find((t) => t.id === resolvedTabId)
		: undefined;

	// Resolve workspaceId: prefer event, fallback to tab's workspace
	const resolvedWorkspaceId = workspaceId || tab?.workspaceId;

	if (!resolvedWorkspaceId) return null;

	return {
		paneId: resolvedPaneId,
		tabId: resolvedTabId,
		workspaceId: resolvedWorkspaceId,
	};
}
