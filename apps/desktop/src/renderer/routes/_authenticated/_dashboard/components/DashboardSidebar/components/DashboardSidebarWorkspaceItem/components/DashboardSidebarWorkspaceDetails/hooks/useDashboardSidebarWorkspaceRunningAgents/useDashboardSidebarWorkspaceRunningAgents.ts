import {
	BUILTIN_AGENT_LABELS,
	type BuiltinAgentId,
} from "@superset/shared/agent-catalog";
import { useMemo } from "react";
import { useTerminalAgentBindings } from "renderer/hooks/host-service/useTerminalAgentBindings";
import type { DisplayStatus } from "renderer/screens/main/components/StatusIndicator";
import {
	useV2WorkspaceOpenTerminalIds,
	useV2WorkspaceTerminalStatuses,
	type V2NotificationSource,
} from "renderer/stores/v2-notifications";

/**
 * (CHIP-DOT-UNIFY) State of a bound agent's chip dot: the fork's shared
 * per-source DisplayStatus (red/yellow/blue/green — the SAME primitive every
 * other dot surface derives from), or `idle` when the source has no active
 * status.
 */
export type RunningAgentStatus = DisplayStatus | "idle";

export interface DashboardSidebarRunningAgent {
	/** Stable key for React lists, derived from the notification source. */
	sourceKey: string;
	source: V2NotificationSource;
	/** Host terminal the agent is bound to. */
	terminalId: string;
	/** Built-in agent id (`claude`, `codex`, …) — drives label + icon. */
	agentId: BuiltinAgentId;
	/** Fork per-source display status, or `idle` when no axis is active. */
	status: RunningAgentStatus;
	/** When the agent process was bound (ms since epoch), used for stable order. */
	startedAt: number;
	/** Agent display name (e.g. "Claude"). */
	label: string;
}

/**
 * Live list of agents bound to a workspace's OPEN terminal tabs, newest
 * binding last.
 *
 * (CHIP-DOT-UNIFY) Both halves of upstream's original pipeline are replaced
 * with the fork's dot primitives so the chips can never disagree with the
 * tab/pane/rollup dots:
 *  - LIVENESS comes from the open-pane layout gate
 *    ({@link useV2WorkspaceOpenTerminalIds}) — NOT from
 *    `terminal_sessions.status`, which stays `active` forever for a
 *    closed-tab/daemon-surviving pty and trapped stale chips (e.g. a
 *    permission-red 40h after its tab was closed). A closed tab is
 *    unrepresentable, exactly like every other dot surface.
 *  - STATUS comes from {@link useV2WorkspaceTerminalStatuses} (the shared
 *    (AY)/(DOT-AXES) per-source primitive) — NOT from the host binding's raw
 *    `lastEventType`, whose 4-case mapping read the fork's event vocabulary
 *    (`SubagentActive`, `BackgroundRunning`, …) as idle.
 * The host binding still provides identity: which agent (logo/label) and
 * `startedAt` ordering.
 */
export function useDashboardSidebarWorkspaceRunningAgents(
	workspaceId: string,
	enabled = true,
): DashboardSidebarRunningAgent[] {
	const bindings = useTerminalAgentBindings(workspaceId, { enabled });
	const openTerminalIds = useV2WorkspaceOpenTerminalIds(workspaceId);
	const terminalStatuses = useV2WorkspaceTerminalStatuses(workspaceId);

	return useMemo(() => {
		const statusByTerminal = new Map<string, DisplayStatus>();
		for (const entry of terminalStatuses) {
			statusByTerminal.set(entry.terminalId, entry.status);
		}
		const agents: DashboardSidebarRunningAgent[] = [];
		for (const binding of bindings.values()) {
			if (!openTerminalIds.has(binding.terminalId)) continue;
			agents.push({
				sourceKey: `terminal:${binding.terminalId}`,
				source: { type: "terminal", id: binding.terminalId },
				terminalId: binding.terminalId,
				agentId: binding.agentId,
				status: statusByTerminal.get(binding.terminalId) ?? "idle",
				startedAt: binding.startedAt,
				label: BUILTIN_AGENT_LABELS[binding.agentId] ?? binding.agentId,
			});
		}
		agents.sort((a, b) => a.startedAt - b.startedAt);
		return agents;
	}, [bindings, openTerminalIds, terminalStatuses]);
}
