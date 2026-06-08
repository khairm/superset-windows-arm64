import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { getHostServiceClientByUrl } from "renderer/lib/host-service-client";
import { useIsGitRepo } from "../useIsGitRepo";
import { useWorkspaceEvent } from "../useWorkspaceEvent";
import { useWorkspaceHostUrl } from "../useWorkspaceHostUrl";

export interface DiffStats {
	additions: number;
	deletions: number;
}

export function useDiffStats(
	workspaceId: string,
	enabled = true,
): DiffStats | null {
	const hostUrl = useWorkspaceHostUrl(workspaceId);
	// (NON-GIT WORKSPACE) Skip the git.getStatus fan-out for non-git folders —
	// the marker branch must never reach a git command. `useIsGitRepo` stays
	// true until the query positively resolves non-git, so real repos never
	// flicker-skip on mount.
	const isGitRepo = useIsGitRepo(workspaceId);
	const queryClient = useQueryClient();
	const queryKey = useMemo(
		() => ["diff-stats", hostUrl, workspaceId] as const,
		[hostUrl, workspaceId],
	);
	// Skip the per-row git.getStatus RPC + git:changed subscription when the row
	// is parked in a Snoozed/Archived section (caller passes enabled=false), so
	// revealing a large section doesn't fan out an unbounded burst of requests.
	const isEnabled = enabled && Boolean(workspaceId) && Boolean(hostUrl);

	const { data: status } = useQuery({
		queryKey,
		// Non-git folders skip the git.getStatus query (AE); a row parked in a
		// Snoozed/Archived section also skips it (feature passes enabled=false).
		enabled: isGitRepo && isEnabled,
		queryFn: () => {
			if (!hostUrl) return null;
			return getHostServiceClientByUrl(hostUrl).git.getStatus.query({
				workspaceId,
				priority: "background",
			});
		},
		refetchOnWindowFocus: false,
		staleTime: Number.POSITIVE_INFINITY,
	});

	const invalidate = useCallback(() => {
		void queryClient.invalidateQueries({ queryKey });
	}, [queryClient, queryKey]);

	useWorkspaceEvent("git:changed", workspaceId, invalidate, isEnabled);

	return useMemo<DiffStats | null>(() => {
		if (!status) return null;

		const byPath = new Map<string, { additions: number; deletions: number }>();
		for (const file of status.againstBase) byPath.set(file.path, file);
		for (const file of status.staged) byPath.set(file.path, file);
		for (const file of status.unstaged) byPath.set(file.path, file);

		let additions = 0;
		let deletions = 0;
		for (const file of byPath.values()) {
			additions += file.additions;
			deletions += file.deletions;
		}
		return { additions, deletions };
	}, [status]);
}
