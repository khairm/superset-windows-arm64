import { useMemo, useState } from "react";
import { useIsV2CloudEnabled } from "renderer/hooks/useIsV2CloudEnabled";
import { useOpenNewWorkspace } from "renderer/hooks/useOpenNewWorkspace";
import { useQuickCreateWorkspace } from "renderer/hooks/useQuickCreateWorkspace";
import { useHotkey } from "renderer/hotkeys";
import { useActiveRoute, v2WorkspaceIdOf } from "renderer/lib/active-route";
import type { ElectronRouterOutputs } from "renderer/lib/electron-trpc";
import { useHostWorkspaces } from "renderer/routes/_authenticated/providers/HostWorkspacesProvider";
import { DeleteWorkspaceDialog } from "renderer/screens/main/components/WorkspaceSidebar/WorkspaceListItem/components";
import { useDeleteWorkspaceIntent } from "renderer/stores/delete-workspace-intent";

/**
 * v1 only — v2 deletes go through the globally-mounted DeleteWorkspaceMount
 * (see delete-workspace-intent store), which in this fork is a SILENT
 * soft-delete into the project's Recycle Bin. Only the legacy
 * (non-v2-cloud) WorkspaceSidebar still opens a destroy dialog here.
 */
type DeleteTarget = {
	workspaceId: string;
	workspaceName: string;
	workspaceType: "worktree" | "branch";
};

interface DashboardWorkspaceHotkeysProps {
	/** v1 only, so a v2 click leaves both unchanged. */
	currentWorkspaceId: string | null;
	currentWorkspace: ElectronRouterOutputs["workspaces"]["get"] | undefined;
}

// (NAV-LOCAL-RENDER) The hotkeys that need the open workspace live in this
// leaf, so a workspace click does not re-render DashboardLayout.
export function DashboardWorkspaceHotkeys({
	currentWorkspaceId,
	currentWorkspace,
}: DashboardWorkspaceHotkeysProps) {
	const openNewWorkspace = useOpenNewWorkspace();
	const quickCreateWorkspace = useQuickCreateWorkspace();
	const isV2CloudEnabled = useIsV2CloudEnabled();
	const { workspaces: hostWorkspaces } = useHostWorkspaces();
	const currentV2WorkspaceId = useActiveRoute((matched) =>
		v2WorkspaceIdOf(matched.pathname, { fuzzy: true }),
	);
	const currentV2Workspace = useMemo(
		() =>
			currentV2WorkspaceId != null
				? (hostWorkspaces.find(
						(workspace) => workspace.id === currentV2WorkspaceId,
					) ?? null)
				: null,
		[hostWorkspaces, currentV2WorkspaceId],
	);

	useHotkey("NEW_WORKSPACE", () =>
		openNewWorkspace(
			currentWorkspace?.projectId ?? currentV2Workspace?.projectId ?? undefined,
		),
	);
	useHotkey(
		"QUICK_CREATE_WORKSPACE",
		() => quickCreateWorkspace(currentV2Workspace?.projectId ?? null),
		{ enabled: isV2CloudEnabled },
	);

	const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);

	useHotkey(
		"CLOSE_WORKSPACE",
		() => {
			if (currentWorkspaceId && currentWorkspace) {
				setDeleteTarget({
					workspaceId: currentWorkspaceId,
					workspaceName: currentWorkspace.name,
					workspaceType: currentWorkspace.type,
				});
				return;
			}

			if (
				currentV2WorkspaceId &&
				currentV2Workspace &&
				currentV2Workspace.type !== "main"
			) {
				// (RECYCLE-BIN) Close-workspace routes through the globally-mounted
				// DeleteWorkspaceMount like every other v2 delete entry point — and
				// that mount is a SILENT soft-delete here: it moves the thread to its
				// project's Recycle Bin and navigates off the route. The real git
				// destroy lives only behind in-bin "Delete permanently". Mains never
				// reach here (deleteWorkspace would no-op them anyway).
				useDeleteWorkspaceIntent.getState().request({
					workspaceId: currentV2WorkspaceId,
					workspaceName: currentV2Workspace.name || currentV2Workspace.branch,
				});
			}
		},
		{
			enabled:
				(!!currentWorkspaceId && !!currentWorkspace) ||
				(!!currentV2WorkspaceId && !!currentV2Workspace),
		},
	);

	if (!deleteTarget) return null;
	return (
		<DeleteWorkspaceDialog
			workspaceId={deleteTarget.workspaceId}
			workspaceName={deleteTarget.workspaceName}
			workspaceType={deleteTarget.workspaceType}
			open={true}
			onOpenChange={(open) => {
				if (!open) setDeleteTarget(null);
			}}
		/>
	);
}
