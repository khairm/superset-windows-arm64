import { buildHostRoutingKey } from "@superset/shared/host-routing";
import { alert } from "@superset/ui/atoms/Alert";
import { toast } from "@superset/ui/sonner";
import { useNavigate } from "@tanstack/react-router";
import { TRPCClientError } from "@trpc/client";
import { useCallback, useState } from "react";
import { useRelayUrl } from "renderer/hooks/useRelayUrl";
import { useV2UserPreferences } from "renderer/hooks/useV2UserPreferences/useV2UserPreferences";
import { getHostServiceClientByUrl } from "renderer/lib/host-service-client";
import { useDashboardSidebarSectionRename } from "renderer/routes/_authenticated/_dashboard/components/DashboardSidebar/components/DashboardSidebarSectionRenameContext";
import { useDashboardSidebarState } from "renderer/routes/_authenticated/hooks/useDashboardSidebarState";
import { useOptimisticCollectionActions } from "renderer/routes/_authenticated/hooks/useOptimisticCollectionActions";
import { useCollections } from "renderer/routes/_authenticated/providers/CollectionsProvider";
import { useLocalHostService } from "renderer/routes/_authenticated/providers/LocalHostServiceProvider";
import { useOpenNewWorkspaceModal } from "renderer/stores/new-workspace-modal";
import type { DashboardSidebarProject } from "../../../../types";

interface UseDashboardSidebarProjectSectionActionsOptions {
	project: DashboardSidebarProject;
}

/** The dirty-worktree race: preflight reported clean but the worktree was dirty
 * by destroy time. The host returns a CONFLICT — the only error we silently
 * force-retry (mirroring useDestroyWorkspace's normalizeError). Every other
 * refusal must surface so the item is left in the bin, not force-destroyed. */
function isConflictError(error: unknown): boolean {
	return (
		error instanceof TRPCClientError &&
		(error.data as { code?: string } | undefined)?.code === "CONFLICT"
	);
}

export function useDashboardSidebarProjectSectionActions({
	project,
}: UseDashboardSidebarProjectSectionActionsOptions) {
	const openModal = useOpenNewWorkspaceModal();
	const navigate = useNavigate();
	const { v2Projects: projectActions } = useOptimisticCollectionActions();
	const { requestSectionRename } = useDashboardSidebarSectionRename();
	const collections = useCollections();
	const { machineId, activeHostUrl } = useLocalHostService();
	const relayUrl = useRelayUrl();
	// (RECYCLE-BIN) Honor the same delete-local-branch preference the per-item
	// "Delete permanently" dialog uses (useDestroyDialogState reads this), so
	// "Empty Recycle Bin" doesn't silently diverge by always keeping branches.
	const { preferences } = useV2UserPreferences();
	const deleteLocalBranch = preferences.deleteLocalBranch;
	const {
		createSection,
		deleteSection,
		removeProjectFromSidebar,
		removeWorkspaceFromSidebar,
		renameSection,
		restoreWorkspace,
		toggleProjectCollapsed,
		toggleSectionCollapsed,
	} = useDashboardSidebarState();

	const [isRenaming, setIsRenaming] = useState(false);
	const [renameValue, setRenameValue] = useState(project.name);

	const startRename = () => {
		setRenameValue(project.name);
		setIsRenaming(true);
	};

	const cancelRename = () => {
		setIsRenaming(false);
		setRenameValue(project.name);
	};

	const submitRename = () => {
		setIsRenaming(false);
		const trimmed = renameValue.trim();
		if (!trimmed || trimmed === project.name) return;
		projectActions.renameProject(project.id, trimmed);
	};

	const handleOpenInFinder = () => {
		toast.info("Open in Finder is coming soon");
	};

	const handleOpenSettings = () => {
		navigate({
			to: "/settings/projects/$projectId",
			params: { projectId: project.id },
		});
	};

	const confirmRemoveFromSidebar = () => {
		alert({
			title: "Remove project from sidebar?",
			description:
				"This will remove workspaces from the sidebar and delete all project sections. The workspaces or projects won't be deleted.",
			actions: [
				{ label: "Cancel", variant: "outline", onClick: () => {} },
				{
					label: "Remove",
					variant: "destructive",
					onClick: () => removeProjectFromSidebar(project.id),
				},
			],
		});
	};

	const handleNewWorkspace = () => {
		openModal(project.id);
	};

	const handleNewSection = () => {
		const sectionId = createSection(project.id);
		requestSectionRename(sectionId);
		if (project.isCollapsed) {
			toggleProjectCollapsed(project.id);
		}
	};

	// --- Recycle Bin (RECYCLE-BIN) -------------------------------------------

	// Resolve a workspace to its owning host-service base URL, mirroring
	// useWorkspaceHostTarget: a local-device workspace uses the active local host;
	// a remote one is reached through the relay's host routing key. Returns null
	// when the host can't be resolved (e.g. local host not booted) so the caller
	// skips that item rather than throwing mid-loop.
	const resolveWorkspaceHostUrl = useCallback(
		(workspaceId: string): string | null => {
			const workspace = collections.v2Workspaces.get(workspaceId);
			if (!workspace) return null;
			if (machineId && workspace.hostId === machineId) {
				return activeHostUrl;
			}
			return `${relayUrl}/hosts/${buildHostRoutingKey(
				workspace.organizationId,
				workspace.hostId,
			)}`;
		},
		[collections, machineId, activeHostUrl, relayUrl],
	);

	// Bulk-restore every soft-deleted thread in this project's bin straight back
	// to active (clears every state flag, per restoreWorkspace).
	const restoreAllDeleted = useCallback(() => {
		for (const workspace of project.deletedWorkspaces) {
			restoreWorkspace(workspace.id);
		}
	}, [project.deletedWorkspaces, restoreWorkspace]);

	// Empty the bin: ONE confirm, then loop the EXISTING destroy per item, each
	// followed by removing the local sidebar row. Best-effort per item: a failure
	// is toasted but doesn't abort the rest. NEVER auto-purges on its own — this is
	// user-initiated only.
	//
	// Per-item force is NOT applied up front. We mirror useDestroyDialogState.run's
	// escalation: a non-forced destroy first, force-retried ONLY on the
	// dirty-worktree race (kind === "conflict"). Any other refusal (the host
	// blocking the delete, e.g. dirty/unpushed work it won't drop) is counted as
	// failed and LEFT in the bin — bulk-empty must not silently nuke work the
	// per-item "Delete permanently" path would have blocked or warned on.
	const emptyRecycleBin = useCallback(() => {
		const items = project.deletedWorkspaces;
		if (items.length === 0) return;
		alert({
			title: `Empty Recycle Bin (${items.length})?`,
			description: `This permanently deletes every workspace in this project's Recycle Bin — the worktrees are removed from disk and the cloud records deleted (local git branches are ${
				deleteLocalBranch ? "also deleted" : "kept"
			}). Items with uncommitted or unpushed work the host refuses to delete are left in the bin. This cannot be undone.`,
			actions: [
				{ label: "Cancel", variant: "outline", onClick: () => {} },
				{
					label: "Delete permanently",
					variant: "destructive",
					onClick: async () => {
						let failed = 0;
						for (const workspace of items) {
							// (MASTER-ARCHIVE-ONLY) A main can never legitimately be in the
							// bin (deleteWorkspace refuses them), but if one ever leaks in,
							// skip it rather than ask the host to destroy it — the host
							// hard-rejects mains anyway and it would just count as failed.
							if (workspace.type === "main") continue;
							const hostUrl = resolveWorkspaceHostUrl(workspace.id);
							if (!hostUrl) {
								failed += 1;
								continue;
							}
							const client = getHostServiceClientByUrl(hostUrl);
							const destroy = (force: boolean) =>
								client.workspaceCleanup.destroy.mutate({
									workspaceId: workspace.id,
									deleteBranch: deleteLocalBranch,
									force,
								});
							try {
								try {
									await destroy(false);
								} catch (firstError) {
									// Force-retry ONLY on the dirty-worktree race (preflight
									// clean, dirty by destroy time) — every other refusal is
									// surfaced as a failure and the item stays in the bin.
									if (isConflictError(firstError)) {
										await destroy(true);
									} else {
										throw firstError;
									}
								}
								removeWorkspaceFromSidebar(workspace.id);
							} catch (error) {
								failed += 1;
								console.error("[emptyRecycleBin] destroy failed", {
									workspaceId: workspace.id,
									error,
								});
							}
						}
						if (failed > 0) {
							toast.error(
								`Emptied Recycle Bin, but ${failed} item${failed === 1 ? "" : "s"} could not be deleted.`,
							);
						}
					},
				},
			],
		});
	}, [
		project.deletedWorkspaces,
		resolveWorkspaceHostUrl,
		removeWorkspaceFromSidebar,
		deleteLocalBranch,
	]);

	return {
		cancelRename,
		confirmRemoveFromSidebar,
		deleteSection,
		emptyRecycleBin,
		handleNewSection,
		handleNewWorkspace,
		handleOpenInFinder,
		handleOpenSettings,
		isRenaming,
		renameSection,
		renameValue,
		restoreAllDeleted,
		setRenameValue,
		startRename,
		submitRename,
		toggleSectionCollapsed,
	};
}
