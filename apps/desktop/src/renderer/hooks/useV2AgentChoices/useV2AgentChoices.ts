import { resolveAgentLaunchPresetId } from "@superset/shared/agent-models";
import { useMemo } from "react";
import type { AgentSelectAgent } from "renderer/components/AgentSelect";
import { useV2AgentConfigs } from "renderer/hooks/useV2AgentConfigs";

interface UseV2AgentChoicesResult {
	agents: AgentSelectAgent[];
	isFetched: boolean;
}

/**
 * Every agent the user can launch, straight from the host's
 * `host_agent_configs` table.
 *
 * (CLOUD-SEVERANCE-P2) The list used to end with a synthetic "Superset" row.
 * That agent was never a host config — it was routed by id inside
 * `runAgentInWorkspace` into a hosted chat session, which the host now refuses
 * outright. Offering it in a picker would hand the user a launch that can only
 * come back as an error. Filtered here rather than in the shared agent catalog:
 * the catalog is upstream's and churns every release, this hook is the one
 * thing every desktop picker reads.
 */
export function useV2AgentChoices(
	hostUrl: string | null,
): UseV2AgentChoicesResult {
	const query = useV2AgentConfigs(hostUrl);
	const agents = useMemo<AgentSelectAgent[]>(() => {
		const terminalAgents: AgentSelectAgent[] = (query.data ?? []).map(
			(config) => ({
				id: config.id,
				label: config.label,
				// Prefer the user's icon override (built-in key or uploaded data
				// URI); fall back to the preset-implied icon.
				iconId: config.iconId ?? config.presetId,
				presetId: config.presetId,
				launchPresetId: resolveAgentLaunchPresetId(
					config.presetId,
					config.command,
				),
			}),
		);
		return terminalAgents;
	}, [query.data]);

	return { agents, isFetched: query.isFetched };
}
