import type { WorkspaceStore } from "@superset/panes";
import { useEffect, useRef } from "react";
import { useTerminalAgentBindingsState } from "renderer/hooks/host-service/useTerminalAgentBindings";
import { useUserPresent } from "renderer/hooks/useUserPresent";
import { useWorkspace } from "renderer/routes/_authenticated/_dashboard/v2-workspace/providers/WorkspaceProvider";
import {
	knownFinishAt,
	markTerminalSeenAndReportRead,
	reportUserRead,
} from "renderer/routes/_authenticated/components/V2NotificationController/lib/companionAlertSync";
import { getV2NotificationSourcesForPane } from "renderer/stores/v2-notifications";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import type { PaneViewerData } from "../../types";

export function useClearActivePaneAttention({
	store,
}: {
	store: StoreApi<WorkspaceStore<PaneViewerData>>;
}): void {
	const { workspace } = useWorkspace();
	const activePane = useStore(store, (state) => {
		const tab = state.tabs.find(
			(candidate) => candidate.id === state.activeTabId,
		);
		return tab?.activePaneId ? tab.panes[tab.activePaneId] : undefined;
	});
	const { bindings, loaded: bindingsLoaded } = useTerminalAgentBindingsState(
		workspace.id,
	);
	const present = useUserPresent();
	// The terminals already reported in this focus episode: one pane, the user
	// present the whole time. `unstamped` holds the reads sent with no instant
	// before the bindings loaded; they do not count as the episode's report, so
	// a stamped read follows once the bindings arrive.
	const episode = useRef<{
		paneId: string;
		reported: Set<string>;
		unstamped: Set<string>;
	} | null>(null);

	useEffect(() => {
		// NOTHING HERE IS A READ UNLESS THE USER IS THERE. This effect re-runs on
		// events the user had no part in — a bindings live-query tick, a resync
		// replay writing the store — and each of those used to report the pane as
		// read. With the window hidden or behind another app that retracted the
		// phone card for a finish nobody had looked at, which nothing can undo.
		//
		// So the report fires only while the window is shown AND focused, and the
		// presence dependency is what makes coming back to the window count: the
		// pane the user left open is reported the moment they return to it.
		if (!present || activePane === undefined) {
			episode.current = null;
			return;
		}
		if (episode.current?.paneId !== activePane.id) {
			episode.current = {
				paneId: activePane.id,
				reported: new Set(),
				unstamped: new Set(),
			};
		}
		const { reported, unstamped } = episode.current;
		// NOT GATED ON THE GREEN DOT. Looking at the chat is the read, green or
		// not: it is what lets the next finish buzz the phone, and it takes down
		// a card for a finish the agent has already moved past.
		//
		// EVERY REPORT IS A HOST WRITE, so a working agent's stream of events is
		// not re-reported: a bound terminal reports while this renderer holds a
		// finish for it, while its last event is a finish, and once per focus
		// episode otherwise. Buzzing is unaffected: the phone compares an alert's
		// read mark only with the one it last buzzed for.
		for (const source of getV2NotificationSourcesForPane(activePane)) {
			if (source.type !== "terminal") continue;
			const binding = bindings.get(source.id);
			const finishAt = knownFinishAt(source.id);
			if (binding) {
				if (
					finishAt === null &&
					binding.lastEventType !== "Stop" &&
					binding.lastEventType !== "Failed" &&
					reported.has(source.id)
				) {
					continue;
				}
				reported.add(source.id);
				// (ALERT-CONTEXT-NAMES) ONE OF THE USER-INTENT SITES. Seen marks are
				// host-clock only: mixing in the renderer clock would poison the
				// monotonic comparison whenever the clocks drift. The cutoff also
				// covers a finish this renderer holds that the binding has not caught
				// up to yet.
				markTerminalSeenAndReportRead({
					workspaceId: workspace.id,
					terminalId: source.id,
					seenAt: Math.max(binding.lastEventAt, finishAt ?? 0),
				});
				continue;
			}
			// Loaded with no binding: this terminal has no agent to read.
			if (bindingsLoaded) continue;
			// Before the bindings load, the read goes through the finish this
			// renderer holds, or through no instant at all, once per episode.
			if (finishAt === null) {
				if (unstamped.has(source.id)) continue;
				unstamped.add(source.id);
			} else {
				reported.add(source.id);
			}
			reportUserRead({
				workspaceId: workspace.id,
				terminalId: source.id,
				seenThroughAt: finishAt,
			});
		}
	}, [activePane, bindings, bindingsLoaded, present, workspace.id]);
}
