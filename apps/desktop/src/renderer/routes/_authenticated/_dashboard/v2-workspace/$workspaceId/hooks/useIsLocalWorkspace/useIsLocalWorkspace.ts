import { useHostWorkspaces } from "renderer/routes/_authenticated/providers/HostWorkspacesProvider";
import { useLocalHostService } from "renderer/routes/_authenticated/providers/LocalHostServiceProvider";

/**
 * Whether the workspace runs on THIS machine's host service. `null` until the
 * workspace row resolves. Local-only actions (spawning a browser/editor on a
 * filesystem path) must gate on `=== true` — a path resolved by a REMOTE
 * host service does not exist locally.
 *
 * (KANBAN HOST SOURCE) Resolved against the host-served workspace lists — the
 * Electric mirror lacks post-migration rows, which left new local branches
 * permanently stuck at `null`.
 */
export function useIsLocalWorkspace(workspaceId: string): boolean | null {
	const { workspaces } = useHostWorkspaces();
	const { machineId } = useLocalHostService();
	const row = workspaces.find((w) => w.id === workspaceId);
	if (!row || !machineId) return null;
	return row.hostId === machineId;
}
