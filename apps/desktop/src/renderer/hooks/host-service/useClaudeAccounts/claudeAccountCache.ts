import type { AppRouter } from "@superset/host-service";
import type { QueryClient } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";

type RouterOutputs = inferRouterOutputs<AppRouter>;

export type ClaudeWorkspaceAccountState =
	RouterOutputs["claudeAccounts"]["getWorkspaceState"];
export type ClaudeWorkspaceAccountStates =
	RouterOutputs["claudeAccounts"]["getWorkspaceStates"];

export const CLAUDE_WORKSPACE_ACCOUNT_STATE_QUERY_KEY = [
	"claude-workspace-account-state",
] as const;
export const CLAUDE_WORKSPACE_ACCOUNT_STATES_QUERY_KEY = [
	"claude-workspace-account-states",
] as const;

export function claudeWorkspaceAccountStateQueryKey(
	hostUrl: string | null,
	workspaceId: string,
) {
	return [
		...CLAUDE_WORKSPACE_ACCOUNT_STATE_QUERY_KEY,
		hostUrl,
		workspaceId,
	] as const;
}

export function claudeWorkspaceAccountStatesQueryKey(hostUrl: string | null) {
	return [...CLAUDE_WORKSPACE_ACCOUNT_STATES_QUERY_KEY, hostUrl] as const;
}

export function updateClaudeWorkspaceAccountStateCaches(
	queryClient: QueryClient,
	hostUrl: string,
	workspaceId: string,
	update: (current: ClaudeWorkspaceAccountState) => ClaudeWorkspaceAccountState,
	missingState?: ClaudeWorkspaceAccountState,
): boolean {
	queryClient.setQueryData<ClaudeWorkspaceAccountState>(
		claudeWorkspaceAccountStateQueryKey(hostUrl, workspaceId),
		(current) => {
			const base = current ?? missingState;
			return base ? update(base) : current;
		},
	);

	let found = false;
	queryClient.setQueryData<ClaudeWorkspaceAccountStates>(
		claudeWorkspaceAccountStatesQueryKey(hostUrl),
		(current) => {
			if (!current) return current;
			const states = current.map((state) => {
				if (state.workspaceId !== workspaceId) return state;
				found = true;
				return { ...update(state), workspaceId };
			});
			if (!found && missingState) {
				states.push({ ...update(missingState), workspaceId });
			}
			return states;
		},
	);
	return found;
}
