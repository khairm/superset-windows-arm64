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

export function invalidateClaudeWorkspaceAccountState(
	queryClient: QueryClient,
	hostUrl: string,
	workspaceId: string,
): Promise<void> {
	return Promise.all([
		queryClient.invalidateQueries({
			queryKey: claudeWorkspaceAccountStateQueryKey(hostUrl, workspaceId),
		}),
		queryClient.invalidateQueries({
			queryKey: claudeWorkspaceAccountStatesQueryKey(hostUrl),
		}),
	]).then(() => undefined);
}

export function updateClaudeWorkspaceAccountStateCaches(
	queryClient: QueryClient,
	hostUrl: string,
	workspaceId: string,
	update: (current: ClaudeWorkspaceAccountState) => ClaudeWorkspaceAccountState,
): void {
	const stateKey = claudeWorkspaceAccountStateQueryKey(hostUrl, workspaceId);
	if (queryClient.getQueryData(stateKey) === undefined) {
		void queryClient.invalidateQueries({ queryKey: stateKey });
	} else {
		queryClient.setQueryData<ClaudeWorkspaceAccountState>(
			stateKey,
			(current) => current && update(current),
		);
	}

	const statesKey = claudeWorkspaceAccountStatesQueryKey(hostUrl);
	let found = false;
	queryClient.setQueryData<ClaudeWorkspaceAccountStates>(statesKey, (current) =>
		current?.map((state) => {
			if (state.workspaceId !== workspaceId) return state;
			found = true;
			return { ...update(state), workspaceId };
		}),
	);
	if (!found) void queryClient.invalidateQueries({ queryKey: statesKey });
}
