import type { BuiltinAgentId } from "@superset/shared/agent-catalog";
import { useMemo } from "react";
import { useTerminalAgentBindings } from "renderer/hooks/host-service/useTerminalAgentBindings";
import type { DisplayStatus } from "renderer/screens/main/components/StatusIndicator";
import { useV2WorkspaceTabChips } from "renderer/stores/v2-notifications";
import { resolveDashboardSidebarTabTitle } from "./utils/resolveDashboardSidebarTabTitle";

export interface DashboardSidebarWorkspaceTabChip {
	tabId: string;
	title: string;
	agentId: BuiltinAgentId | null;
	status: DisplayStatus | null;
}

/**
 * (TAB-CHIPS) Joins ordered pane-layout tabs to host agent identity. Status and
 * liveness stay owned by useV2WorkspaceTabChips: the shared v2 dot primitive
 * folded over panes that are present in the open layout, never host session
 * status or raw agent lifecycle events.
 */
export function useDashboardSidebarWorkspaceTabChips(
	workspaceId: string,
	enabled = true,
): DashboardSidebarWorkspaceTabChip[] {
	const tabs = useV2WorkspaceTabChips(workspaceId, enabled);
	const bindings = useTerminalAgentBindings(workspaceId, { enabled });

	return useMemo(
		() =>
			tabs.map((tab, index) => {
				const activePane = tab.panes.find(
					(pane) => pane.id === tab.activePaneId,
				);
				const activeBinding = activePane?.terminalId
					? bindings.get(activePane.terminalId)
					: undefined;
				const firstBinding =
					activeBinding ??
					tab.panes
						.map((pane) =>
							pane.terminalId ? bindings.get(pane.terminalId) : undefined,
						)
						.find((binding) => binding !== undefined);
				return {
					tabId: tab.tabId,
					title: resolveDashboardSidebarTabTitle(tab, index),
					agentId: firstBinding?.agentId ?? null,
					status: tab.status,
				};
			}),
		[tabs, bindings],
	);
}
