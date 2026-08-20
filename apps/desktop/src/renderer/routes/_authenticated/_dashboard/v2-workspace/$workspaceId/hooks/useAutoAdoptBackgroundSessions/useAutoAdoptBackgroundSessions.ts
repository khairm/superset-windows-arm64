import type { WorkspaceStore } from "@superset/panes";
import { workspaceTrpc } from "@superset/workspace-client";
import { useEffect } from "react";
import { useWorkspaceEvent } from "renderer/hooks/host-service/useWorkspaceEvent";
import { logStressEvent } from "renderer/lib/performance/stress-instrumentation";
import { getTerminalBackgroundMarkerIdsKey } from "renderer/lib/terminal/terminal-background-intents";
import type { StoreApi } from "zustand/vanilla";
import {
	getAttachedTerminalIdsKey,
	getBackgroundTerminalSessions,
	parseAttachedTerminalIdsKey,
} from "../../components/BackgroundTerminalsButton/BackgroundTerminalsButton.utils";
import type { PaneViewerData } from "../../types";
import { focusOrAddTerminalPane } from "../../utils/focusTerminalPane";

interface UseAutoAdoptBackgroundSessionsArgs {
	store: StoreApi<WorkspaceStore<PaneViewerData>>;
	workspaceId: string;
	isLayoutReady: boolean;
}

/**
 * When a workspace is opened, running terminal daemon sessions that have no
 * pane get their panes created automatically instead of sitting behind the
 * background-terminals dropdown — this is the only surface for sessions
 * launched outside the desktop (e.g. `superset workspaces create --agent …`
 * from the CLI, which writes no pane layout of its own).
 *
 * Gated on pane-layout hydration so the attached-pane check runs against the
 * real layout, not an empty store. The adoption itself is idempotent —
 * already-attached panes are filtered out and re-adoption just focuses the
 * existing pane — so it reruns freely as the session list settles. That's
 * what lets a session that lands slightly after open (a CLI race, a poll
 * refresh) still get a pane, instead of being stranded by a one-shot pass
 * that fired on a premature or empty list. Deliberately backgrounded sessions
 * (marker set) are always skipped.
 */
export function useAutoAdoptBackgroundSessions({
	store,
	workspaceId,
	isLayoutReady,
}: UseAutoAdoptBackgroundSessionsArgs): void {
	const sessionsQuery = workspaceTrpc.terminal.list.useQuery(
		{ workspaceId },
		{ enabled: isLayoutReady, refetchOnWindowFocus: false },
	);
	const sessions = sessionsQuery.data?.sessions;
	// Don't act on a cached list still being refetched — it may name a session
	// killed while the workspace was closed, which would adopt a ghost pane.
	const isFetchingSessions = sessionsQuery.isFetching;

	// (MASTER-PLUS-LAUNCH) The `isFetching` gate above only covers the
	// mount-time race. A session created AFTER the list settles — the
	// `agents.run` / CLI case — produces no query change at all, so without
	// the host's lifecycle event it never gets a pane.
	//
	// The event that carries it is `terminal:lifecycle` / `created`, added on
	// the host for exactly this: the pre-existing eventTypes are `exit` and the
	// two OSC 133 command markers, and cmd.exe (this fork's Windows fallback
	// shell) has no OSC 133 scanner at all — so on cmd a new session used to
	// emit NOTHING until it died.
	//
	// `created` ONLY. The other eventTypes cannot add a session to the list, and
	// the command markers fire on every shell command the user runs — refetching
	// the whole list (a daemon RPC plus a re-render of every consumer) for each
	// one is pure waste.
	const utils = workspaceTrpc.useUtils();
	useWorkspaceEvent(
		"terminal:lifecycle",
		workspaceId,
		(payload) => {
			if (payload.eventType !== "created") return;
			void utils.terminal.list.invalidate({ workspaceId });
		},
		isLayoutReady,
	);

	useEffect(() => {
		if (!isLayoutReady || !sessions || isFetchingSessions) return;

		const state = store.getState();
		const marked = new Set(
			parseAttachedTerminalIdsKey(
				getTerminalBackgroundMarkerIdsKey(workspaceId),
			),
		);
		const toAdopt = getBackgroundTerminalSessions(
			sessions,
			parseAttachedTerminalIdsKey(getAttachedTerminalIdsKey(state.tabs)),
		).filter((session) => !marked.has(session.terminalId));
		if (toAdopt.length === 0) return;

		// Oldest→newest so tabs read chronologically; restore the active tab so
		// adoption never steals focus.
		const restoreActiveTabId = state.tabs.length > 0 ? state.activeTabId : null;
		for (const session of toAdopt.reverse()) {
			focusOrAddTerminalPane(store, session.terminalId);
		}
		if (restoreActiveTabId) {
			store.getState().setActiveTab(restoreActiveTabId);
		}
		logStressEvent("background-terminals.auto-adopt", {
			count: toAdopt.length,
			workspaceId,
		});
	}, [isLayoutReady, isFetchingSessions, sessions, store, workspaceId]);
}
