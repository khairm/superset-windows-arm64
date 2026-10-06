import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { getHostServiceClientByUrl } from "renderer/lib/host-service-client";
import { useWorkspaceEvent } from "../useWorkspaceEvent";
import { useWorkspaceHostUrl } from "../useWorkspaceHostUrl";

export function getIsGitRepoQueryKey(
	hostUrl: string | null,
	workspaceId: string,
) {
	return ["is-git-repo", hostUrl, workspaceId] as const;
}

/**
 * (NON-GIT WORKSPACE) True when the workspace's worktree is a real git repo.
 *
 * Defaults to `true` while the `git.isRepo` query is loading so git UI never
 * flicker-hides for a genuine repo on mount — we only HIDE git affordances once
 * we positively know the folder is non-git (`isGitRepo === false`). Mirrors the
 * `useDiffStats` ergonomics (host client by URL + tanstack query + `git:changed`
 * live invalidation) so a mid-session `git init`/de-init is re-detected.
 */
export function useIsGitRepo(
	workspaceId: string,
	enabled = true,
	{ live = true }: { live?: boolean } = {},
): boolean {
	const hostUrl = useWorkspaceHostUrl(workspaceId);
	const queryClient = useQueryClient();
	const queryKey = useMemo(
		() => getIsGitRepoQueryKey(hostUrl, workspaceId),
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

	// `live: false` shares the cached answer without holding a host git watch.
	useWorkspaceEvent(
		"git:changed",
		workspaceId,
		invalidate,
		queryEnabled && live, // (SIDEBAR-ROW-NO-GIT-WATCH)
	);

	// Default true until the query resolves: only hide git UI once we positively
	// know the folder is non-git.
	return data?.isGitRepo ?? true;
}
