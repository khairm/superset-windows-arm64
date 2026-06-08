import { eq } from "@tanstack/db";
import { useLiveQuery } from "@tanstack/react-db";
import { useCollections } from "renderer/routes/_authenticated/providers/CollectionsProvider";

/**
 * Resolve a project's MAIN workspace id (`type === "main"`) — the entry point a
 * non-git / multi-repo repo exposes (it has no branches/worktrees). Used by the
 * promote flow to decide git-ness and to merge a Queued card into a non-git
 * repo's existing main card.
 *
 * v2 permits one main workspace PER HOST, so when a hostId is given (the local
 * machine, for promote) the match is scoped to that host — otherwise the first
 * main across hosts is returned.
 */
export function useProjectMainWorkspaceId(
	projectId: string | null | undefined,
	hostId?: string | null,
): string | null {
	const collections = useCollections();
	const { data } = useLiveQuery(
		(q) =>
			q
				.from({ w: collections.v2Workspaces })
				.where(({ w }) => eq(w.projectId, projectId ?? "")),
		[collections, projectId],
	);
	if (!projectId) return null;
	const main = (data ?? []).find(
		(w) => w.type === "main" && (hostId ? w.hostId === hostId : true),
	);
	return main?.id ?? null;
}
