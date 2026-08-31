import { eq } from "@tanstack/db";
import { useLiveQuery } from "@tanstack/react-db";
import { useCollections } from "renderer/routes/_authenticated/providers/CollectionsProvider";
import { isExitCleanupPending } from "./isExitCleanupPending";

/**
 * (WORKTREE-EXIT-CLEANUP) True while this workspace's exit cleanup is still
 * owed to its host.
 *
 * Its own hook, rather than a read inside `useAutoAdoptBackgroundSessions`,
 * because it is the only thing in that hook that touches the collections
 * provider. Keeping it here leaves the adoption hook reachable from a unit
 * harness without mocking the provider or the live-query library.
 */
export function useWorkspaceExitCleanupPending(workspaceId: string): boolean {
	const collections = useCollections();
	const { data: rows = [], isReady } = useLiveQuery(
		(query) =>
			query
				.from({ state: collections.v2WorkspaceLocalState })
				.where(({ state }) => eq(state.workspaceId, workspaceId))
				.select(({ state }) => ({
					runtimeCleanupPendingAt: state.sidebarState.runtimeCleanupPendingAt,
				})),
		[collections, workspaceId],
	);
	return isExitCleanupPending(isReady, rows);
}
