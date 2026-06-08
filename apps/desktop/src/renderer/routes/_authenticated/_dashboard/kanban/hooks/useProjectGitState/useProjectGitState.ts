import { useQuery } from "@tanstack/react-query";
import { useWorkspaceHostUrl } from "renderer/hooks/host-service/useWorkspaceHostUrl";
import { getHostServiceClientByUrl } from "renderer/lib/host-service-client";
import { useProjectMainWorkspaceId } from "../useProjectMainWorkspaceId";

export interface ProjectGitState {
	mainWorkspaceId: string | null;
	/** True once the git.isRepo query has resolved (so isGitRepo is trustworthy). */
	isResolved: boolean;
	/** Defaults true until resolved (matches useIsGitRepo ergonomics). */
	isGitRepo: boolean;
}

/**
 * Resolved git-ness for a PROJECT (via its main workspace). The promote dialog
 * must NOT decide create-vs-merge until this is resolved — `useIsGitRepo`
 * defaults `true` while loading, which would wrongly route a non-git folder
 * through branch-create. Shares the `["is-git-repo", …]` query cache with the
 * sidebar's useIsGitRepo (same key) so it's usually instant.
 */
export function useProjectGitState(
	projectId: string | null | undefined,
	hostId?: string | null,
): ProjectGitState {
	const mainWorkspaceId = useProjectMainWorkspaceId(projectId || null, hostId);
	const hostUrl = useWorkspaceHostUrl(mainWorkspaceId ?? "");
	const enabled = Boolean(mainWorkspaceId) && Boolean(hostUrl);

	const { data, isSuccess } = useQuery({
		queryKey: ["is-git-repo", hostUrl, mainWorkspaceId],
		enabled,
		queryFn: () => {
			if (!hostUrl || !mainWorkspaceId) return null;
			return getHostServiceClientByUrl(hostUrl).git.isRepo.query({
				workspaceId: mainWorkspaceId,
			});
		},
		refetchOnWindowFocus: false,
		staleTime: Number.POSITIVE_INFINITY,
	});

	return {
		mainWorkspaceId,
		// Resolved ONLY on success — a failed probe must NOT count as resolved
		// (that would fall back to isGitRepo:true and re-enable branch-create for
		// an unknown/non-git project). On error, Confirm stays disabled.
		isResolved: enabled && isSuccess,
		isGitRepo: data?.isGitRepo ?? true,
	};
}
