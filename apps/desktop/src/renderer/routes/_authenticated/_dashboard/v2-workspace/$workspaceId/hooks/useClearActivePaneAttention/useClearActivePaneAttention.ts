import type { WorkspaceStore } from "@superset/panes";
import { useEffect } from "react";
import { useTerminalAgentBindings } from "renderer/hooks/host-service/useTerminalAgentBindings";
import { useV2PaneNotificationStatus } from "renderer/hooks/host-service/useV2NotificationStatus";
import { useWorkspace } from "renderer/routes/_authenticated/_dashboard/v2-workspace/providers/WorkspaceProvider";
import { markTerminalSeenAndReportRead } from "renderer/routes/_authenticated/components/V2NotificationController/lib/companionAlertSync";
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
	const activePaneStatus = useV2PaneNotificationStatus(
		workspace.id,
		activePane,
	);
	const bindings = useTerminalAgentBindings(workspace.id);

	useEffect(() => {
		if (activePaneStatus !== "review") return;
		for (const source of getV2NotificationSourcesForPane(activePane)) {
			if (source.type !== "terminal") continue;
			// Seen marks are host-clock only: mark "seen through the binding's
			// last event". Mixing in the renderer clock would poison the
			// monotonic comparison whenever the clocks drift.
			const binding = bindings.get(source.id);
			if (!binding) continue;
			// (ALERT-CONTEXT-NAMES) ONE OF THE TWO USER-INTENT SITES. The user
			// focused the pane, which is them reading the chat — so the phone's
			// ready-for-review notification is stale and comes down. The helper
			// owns the ordering that makes that correct (read the review stamp
			// before the mark deletes it) and reports only when a green really
			// went away: this effect runs on every focus change.
			markTerminalSeenAndReportRead({
				workspaceId: workspace.id,
				terminalId: source.id,
				lastEventAt: binding.lastEventAt,
			});
		}
	}, [activePane, activePaneStatus, bindings, workspace.id]);
}
