import { eq } from "@tanstack/db";
import { useLiveQuery } from "@tanstack/react-db";
import { useCollections } from "renderer/routes/_authenticated/providers/CollectionsProvider";
import { useLocalHostService } from "renderer/routes/_authenticated/providers/LocalHostServiceProvider";

/**
 * Whether the workspace runs on THIS machine's host service. `null` until the
 * workspace row resolves. Local-only actions (spawning a browser/editor on a
 * filesystem path) must gate on `=== true` — a path resolved by a REMOTE
 * host service does not exist locally.
 */
export function useIsLocalWorkspace(workspaceId: string): boolean | null {
	const collections = useCollections();
	const { machineId } = useLocalHostService();
	const { data: rows = [] } = useLiveQuery(
		(q) =>
			q
				.from({ workspaces: collections.v2Workspaces })
				.where(({ workspaces }) => eq(workspaces.id, workspaceId))
				.select(({ workspaces }) => ({ hostId: workspaces.hostId })),
		[collections, workspaceId],
	);
	const row = rows[0];
	if (!row || !machineId) return null;
	return row.hostId === machineId;
}
