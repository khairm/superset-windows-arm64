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
	/**
	 * (MASTER-PLUS-LAUNCH) True when the probe that is CURRENTLY in charge
	 * failed. Additive: `isResolved` is untouched, so the kanban promote dialog
	 * keeps failing closed on an errored probe. Callers that need to
	 * distinguish "probe errored" from "probe still running" (the new-workspace
	 * modal's master mode, which must fall back to the branch flow rather than
	 * spin) read this instead.
	 */
	isError: boolean;
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
	/**
	 * (MASTER-PLUS-LAUNCH) Set false when the caller will discard the answer
	 * anyway (the new-workspace modal pointed at a cloud sandbox or a remote
	 * host), so neither probe goes on the wire. Kanban callers leave it alone.
	 */
	enabled = true,
): ProjectGitState {
	const mainWorkspaceId = useProjectMainWorkspaceId(projectId || null, hostId);
	const hostUrl = useWorkspaceHostUrl(mainWorkspaceId ?? "");
	const gitProbeEnabled =
		enabled && Boolean(mainWorkspaceId) && Boolean(hostUrl);

	const {
		data,
		isSuccess,
		isError: gitProbeErrored,
	} = useQuery({
		queryKey: ["is-git-repo", hostUrl, mainWorkspaceId],
		enabled: gitProbeEnabled,
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
		enabled && Boolean(projectId) && Boolean(activeHostUrl) && !mainWorkspaceId;
	const {
		data: multiRepoInfo,
		isSuccess: multiRepoResolved,
		isError: multiRepoProbeErrored,
	} = useQuery({
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

	// (MASTER-PLUS-LAUNCH) Only the ENABLED probe's error counts. TanStack keeps
	// a query's `status: "error"` after it is disabled — it retains the last
	// result rather than resetting — so OR-ing the two errors meant a single
	// transient multi-repo failure before the main workspace hydrated stayed
	// true forever, permanently forcing the modal into the branch flow for a
	// project that had since resolved perfectly well. The two probes are
	// mutually exclusive by construction (`multiRepoEnabled` requires
	// `!mainWorkspaceId`), so exactly one of these can be live at a time; with
	// neither enabled there is no probe to have failed.
	const isError =
		(gitProbeEnabled && gitProbeErrored) ||
		(multiRepoEnabled && multiRepoProbeErrored);

	if (multiRepoEnabled && multiRepoResolved && multiRepoInfo?.isMultiRepo) {
		return {
			mainWorkspaceId: null,
			isResolved: true,
			// Branch-create target: the server fans the branch out per member.
			isGitRepo: true,
			isMultiRepo: true,
			isError,
		};
	}

	return {
		mainWorkspaceId,
		// Resolved ONLY on success — a failed probe must NOT count as resolved
		// (that would fall back to isGitRepo:true and re-enable branch-create for
		// an unknown/non-git project). On error, Confirm stays disabled.
		isResolved: gitProbeEnabled && isSuccess,
		isGitRepo: data?.isGitRepo ?? true,
		isMultiRepo: false,
		isError,
	};
}
