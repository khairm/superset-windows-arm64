import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { DiffStats } from "renderer/hooks/host-service/useDiffStats";
import { getIsGitRepoQueryKey } from "renderer/hooks/host-service/useIsGitRepo";
import { useWorkspaceHostUrl } from "renderer/hooks/host-service/useWorkspaceHostUrl";
import { getHostServiceClientByUrl } from "renderer/lib/host-service-client";

const STABLE_HOVER_MS = 250;

/**
 * (HOVER-CARD-COLD-STATS) Hover reads the host's cold-cached counts and a
 * disk-only git probe once the pointer rests on a row. It never holds a git
 * watch, so sweeping the sidebar attaches nothing.
 */
export function useHoverCardGitState(
	workspaceId: string | null,
): DiffStats | null {
	const hostUrl = useWorkspaceHostUrl(workspaceId);
	const queryClient = useQueryClient();
	const [stableId, setStableId] = useState<string | null>(null);

	useEffect(() => {
		setStableId(null);
		if (!workspaceId) return;
		const timer = setTimeout(() => setStableId(workspaceId), STABLE_HOVER_MS);
		return () => clearTimeout(timer);
	}, [workspaceId]);

	const restingId = stableId === workspaceId ? stableId : null;

	const { data } = useQuery({
		queryKey: ["hover-diff-stats", hostUrl, restingId],
		enabled: Boolean(restingId) && Boolean(hostUrl),
		queryFn: async () => {
			if (!hostUrl || !restingId) return null;
			const { workspaces } = await getHostServiceClientByUrl(
				hostUrl,
			).git.getDiffStatsByWorkspaces.query({ workspaceIds: [restingId] });
			const row = workspaces.find((entry) => entry.workspaceId === restingId);
			return row
				? { additions: row.additions, deletions: row.deletions }
				: null;
		},
		staleTime: 0,
		gcTime: 0,
		refetchOnWindowFocus: false,
	});

	useEffect(() => {
		if (!restingId || !hostUrl) return;
		let cancelled = false;
		const isRepoKey = getIsGitRepoQueryKey(hostUrl, restingId);
		getHostServiceClientByUrl(hostUrl)
			.git.probeIsRepo.query({ workspaceId: restingId })
			.then(({ result }) => {
				if (cancelled) return;
				if (result === "absent") {
					queryClient.setQueryData(isRepoKey, { isGitRepo: false });
					return;
				}
				const cached = queryClient.getQueryData<{ isGitRepo: boolean }>(
					isRepoKey,
				);
				if (result === "present" && cached?.isGitRepo === false) {
					void queryClient.invalidateQueries({ queryKey: isRepoKey });
				}
			})
			.catch((error: unknown) => {
				console.warn("[hover-card] git probe failed", {
					workspaceId: restingId,
					error,
				});
			});
		return () => {
			cancelled = true;
		};
	}, [restingId, hostUrl, queryClient]);

	return data ?? null;
}
