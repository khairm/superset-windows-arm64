import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { getHostServiceClientByUrl } from "renderer/lib/host-service-client";
import { useWorkspaceEvent } from "../useWorkspaceEvent";
import { useWorkspaceHostUrl } from "../useWorkspaceHostUrl";

/**
 * (NON-GIT WORKSPACE) True when the workspace's worktree is a real git repo.
 *
 * Defaults to `true` while the `git.isRepo` query is loading so git UI never
 * flicker-hides for a genuine repo on mount — we only HIDE git affordances once
 * we positively know the folder is non-git (`isGitRepo === false`). Mirrors the
 * `useDiffStats` ergonomics (host client by URL + tanstack query + `git:changed`
 * live invalidation) so a mid-session `git init`/de-init is re-detected.
 */
export function useIsGitRepo(workspaceId: string, enabled = true): boolean {
	const hostUrl = useWorkspaceHostUrl(workspaceId);
	const queryClient = useQueryClient();
	const queryKey = useMemo(
		() => ["is-git-repo", hostUrl, workspaceId] as const,
		[hostUrl, workspaceId],
	);

	const queryEnabled = enabled && Boolean(workspaceId) && Boolean(hostUrl);

	const { data } = useQuery({
		queryKey,
		enabled: queryEnabled,
		queryFn: () => {
			if (!hostUrl) return null;
			return getHostServiceClientByUrl(hostUrl).git.isRepo.query({
				workspaceId,
			});
		},
		refetchOnWindowFocus: false,
		staleTime: Number.POSITIVE_INFINITY,
	});

	const invalidate = useCallback(() => {
		void queryClient.invalidateQueries({ queryKey });
	}, [queryClient, queryKey]);

	useWorkspaceEvent("git:changed", workspaceId, invalidate, queryEnabled);

	// Default true until the query resolves: only hide git UI once we positively
	// know the folder is non-git.
	return data?.isGitRepo ?? true;
}
