import { useQuery } from "@tanstack/react-query";
import { useWorkspaceHostUrl } from "renderer/hooks/host-service/useWorkspaceHostUrl";
import { getHostServiceClientByUrl } from "renderer/lib/host-service-client";
import { useLocalHostService } from "renderer/routes/_authenticated/providers/LocalHostServiceProvider";
import { useProjectMainWorkspaceId } from "../useProjectMainWorkspaceId";

export interface ProjectGitState {
	mainWorkspaceId: string | null;
	/** True once the git.isRepo query has resolved (so isGitRepo is trustworthy). */
	isResolved: boolean;
	/** Defaults true until resolved (matches useIsGitRepo ergonomics). */
	isGitRepo: boolean;
	/** (MULTI-REPO WORKSPACE) True for a multi-repo project on the local host. */
	isMultiRepo: boolean;
}

/**
 * Resolved git-ness for a PROJECT (via its main workspace). The promote dialog
 * must NOT decide create-vs-merge until this is resolved — `useIsGitRepo`
 * defaults `true` while loading, which would wrongly route a non-git folder
 * through branch-create. Shares the `["is-git-repo", …]` query cache with the
 * sidebar's useIsGitRepo (same key) so it's usually instant.
 *
 * (MULTI-REPO WORKSPACE) Multi-repo projects have NO main workspace, so the
 * main-workspace probe alone can never resolve them (the dialog would sit on
 * "Checking…" forever). They're detected via the local host's
 * project.getMultiRepoInfo and resolve as branch-create targets — the create
 * fans the branch out across every member repo.
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

	// Multi-repo probe against the LOCAL host (multi-repo projects are
	// local-only by construction). Only consulted when the main-workspace
	// probe can't run — i.e. the project has no main workspace here.
	const { activeHostUrl } = useLocalHostService();
	const multiRepoEnabled =
		Boolean(projectId) && Boolean(activeHostUrl) && !mainWorkspaceId;
	const { data: multiRepoInfo, isSuccess: multiRepoResolved } = useQuery({
		queryKey: ["multi-repo-info", activeHostUrl, projectId],
		enabled: multiRepoEnabled,
		queryFn: () => {
			if (!activeHostUrl || !projectId) return null;
			return getHostServiceClientByUrl(
				activeHostUrl,
			).project.getMultiRepoInfo.query({ projectId });
		},
		refetchOnWindowFocus: false,
		staleTime: Number.POSITIVE_INFINITY,
	});

	if (multiRepoEnabled && multiRepoResolved && multiRepoInfo?.isMultiRepo) {
		return {
			mainWorkspaceId: null,
			isResolved: true,
			// Branch-create target: the server fans the branch out per member.
			isGitRepo: true,
			isMultiRepo: true,
		};
	}

	return {
		mainWorkspaceId,
		// Resolved ONLY on success — a failed probe must NOT count as resolved
		// (that would fall back to isGitRepo:true and re-enable branch-create for
		// an unknown/non-git project). On error, Confirm stays disabled.
		isResolved: enabled && isSuccess,
		isGitRepo: data?.isGitRepo ?? true,
		isMultiRepo: false,
	};
}
