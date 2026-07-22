import { useHostWorkspaces } from "renderer/routes/_authenticated/providers/HostWorkspacesProvider";

/**
 * Resolve a project's MAIN workspace id (`type === "main"`) — the entry point a
 * non-git / multi-repo repo exposes (it has no branches/worktrees). Used by the
 * promote flow to decide git-ness and to merge a Queued card into a non-git
 * repo's existing main card.
 *
 * v2 permits one main workspace PER HOST, so when a hostId is given (the local
 * machine, for promote) the match is scoped to that host — otherwise the first
 * main across hosts is returned.
 *
 * (KANBAN HOST SOURCE) Resolved against the host-served workspace lists — the
 * Electric mirror lacks post-migration rows.
 */
export function useProjectMainWorkspaceId(
	projectId: string | null | undefined,
	hostId?: string | null,
): string | null {
	const { workspaces } = useHostWorkspaces();
	if (!projectId) return null;
	const main = workspaces.find(
		(w) =>
			w.projectId === projectId &&
			w.type === "main" &&
			(hostId ? w.hostId === hostId : true),
	);
	return main?.id ?? null;
}
