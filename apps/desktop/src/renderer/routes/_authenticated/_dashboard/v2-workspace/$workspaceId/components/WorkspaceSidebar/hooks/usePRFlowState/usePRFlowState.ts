import { workspaceTrpc } from "@superset/workspace-client";
import { useMemo } from "react";
import { useIsGitRepo } from "renderer/hooks/host-service/useIsGitRepo";
import {
	type PullRequest as FlowPullRequest,
	getPRFlowState,
	type PRFlowState,
} from "../../components/PRActionHeader/utils/getPRFlowState";

interface UsePRFlowStateResult {
	flowState: PRFlowState;
	onRetry: () => void;
}

export function usePRFlowState(workspaceId: string): UsePRFlowStateResult {
	// (NON-GIT WORKSPACE) No PR / branch-sync state for a non-git folder — skip
	// both queries. Stays true until the query positively resolves non-git so a
	// real repo never flicker-skips on mount. The PR header that consumes this
	// flow state isn't rendered for a non-git folder (see WorkspaceSidebar), but
	// this hook still runs.
	const isGitRepo = useIsGitRepo(workspaceId);
	const prQuery = workspaceTrpc.git.getPullRequest.useQuery(
		{ workspaceId },
		{
			enabled: isGitRepo && !!workspaceId,
			refetchInterval: 10_000,
			refetchOnWindowFocus: true,
			staleTime: 10_000,
		},
	);

	const syncQuery = workspaceTrpc.git.getBranchSyncStatus.useQuery(
		{ workspaceId },
		{
			enabled: isGitRepo && !!workspaceId,
			refetchInterval: 10_000,
			refetchOnWindowFocus: true,
			staleTime: 5_000,
		},
	);

	const flowState = useMemo(
		() =>
			getPRFlowState({
				pr: (prQuery.data as FlowPullRequest | null) ?? null,
				sync: syncQuery.data ?? null,
				isLoading: prQuery.isLoading || syncQuery.isLoading,
				isAgentRunning: false,
				loadError:
					(prQuery.error as Error | null) ??
					(syncQuery.error as Error | null) ??
					null,
			}),
		[
			prQuery.data,
			prQuery.error,
			prQuery.isLoading,
			syncQuery.data,
			syncQuery.error,
			syncQuery.isLoading,
		],
	);

	return {
		flowState,
		onRetry: () => {
			void prQuery.refetch();
			void syncQuery.refetch();
		},
	};
}
