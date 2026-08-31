import { useWorkspaceExitCleanup } from "./useWorkspaceExitCleanup";

/**
 * (WORKTREE-EXIT-CLEANUP) Mounted once at the dashboard level so a workspace
 * that still owes its host a teardown is retried wherever the user happens to
 * be — the thread they exited is by definition not on screen. Renders nothing.
 */
export function WorkspaceExitCleanupReconciler() {
	useWorkspaceExitCleanup();
	return null;
}
