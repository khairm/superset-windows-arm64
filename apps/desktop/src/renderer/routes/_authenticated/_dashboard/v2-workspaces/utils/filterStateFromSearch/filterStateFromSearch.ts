import { FORK_PULL_REQUESTS_DISABLED } from "@superset/shared/fork-disabled-features";
import type { V2WorkspacesSearch } from "../../page";
import {
	V2_WORKSPACES_AGENT_STATUS_FILTERS,
	V2_WORKSPACES_PR_STATE_FILTERS,
	type V2WorkspacesAgentStatusFilter,
	type V2WorkspacesPrStateFilter,
} from "../../stores/v2WorkspacesFilterStore";

function parseList<T extends string>(
	raw: unknown,
	allowed?: readonly T[],
): T[] {
	if (typeof raw !== "string" || !raw) return [];
	const entries = raw.split(",").filter(Boolean);
	return (
		allowed ? entries.filter((entry) => allowed.includes(entry as T)) : entries
	) as T[];
}

export function filterStateFromSearch(search: V2WorkspacesSearch) {
	return {
		searchQuery: search.q ?? "",
		...(search.device !== undefined && { deviceFilter: search.device }),
		...(search.projects !== undefined && {
			projectFilters: parseList(search.projects),
		}),
		// (FORK-PRS-OFF) With pull requests off nothing can clear this filter.
		...(search.pr !== undefined &&
			!FORK_PULL_REQUESTS_DISABLED && {
				prStateFilters: parseList<V2WorkspacesPrStateFilter>(
					search.pr,
					V2_WORKSPACES_PR_STATE_FILTERS,
				),
			}),
		...(search.agent !== undefined && {
			agentStatusFilters: parseList<V2WorkspacesAgentStatusFilter>(
				search.agent,
				V2_WORKSPACES_AGENT_STATUS_FILTERS,
			),
		}),
		...(search.creators !== undefined && {
			creatorFilters: parseList(search.creators),
		}),
		...(search.pin !== undefined && { pinFilter: search.pin }),
		...(search.view !== undefined && { viewMode: search.view }),
		...(search.archived !== undefined && {
			archivedWindow: search.archived,
		}),
	};
}
