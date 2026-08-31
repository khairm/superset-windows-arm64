import { useCallback, useMemo } from "react";
import { useHostProjects } from "renderer/hooks/host-projects/useHostProjects";
import { useDashboardSidebarState } from "renderer/routes/_authenticated/hooks/useDashboardSidebarState";
import { useCollections } from "renderer/routes/_authenticated/providers/CollectionsProvider";
import { kanbanBoundCardId } from "renderer/routes/_authenticated/providers/CollectionsProvider/dashboardSidebarLocal";
import { useHostWorkspaces } from "renderer/routes/_authenticated/providers/HostWorkspacesProvider";
import {
	buildCompletedWorkspaceCard,
	type CompleteWorkspaceCardResult,
	classifyWorkspaceCompletion,
} from "../../utils/completeWorkspaceCard";

export type { CompleteWorkspaceCardResult };

export function useCompleteWorkspaceCard() {
	const collections = useCollections();
	const { completeWorkspace } = useDashboardSidebarState();
	const { projects } = useHostProjects();
	const { workspaces } = useHostWorkspaces();

	const projectNameById = useMemo(() => {
		const names = new Map<string, string>();
		for (const project of projects) names.set(project.projectKey, project.name);
		return names;
	}, [projects]);
	const workspaceById = useMemo(() => {
		const byId = new Map<string, (typeof workspaces)[number]>();
		for (const workspace of workspaces) byId.set(workspace.id, workspace);
		return byId;
	}, [workspaces]);

	return useCallback(
		(
			workspaceId: string,
			requestedCardId?: string,
		): CompleteWorkspaceCardResult => {
			const cardId = requestedCardId ?? kanbanBoundCardId(workspaceId);
			const existingCard = collections.v2KanbanCards.get(cardId) ?? null;
			const workspace = workspaceById.get(workspaceId);
			const verdict = classifyWorkspaceCompletion({
				workspaceId,
				requestedCardId,
				existingCard,
				workspace,
				projectIsInSidebar:
					workspace?.projectId != null &&
					collections.v2SidebarProjects.get(workspace.projectId) !== undefined,
			});
			if (!verdict.ok) return verdict;
			const { workspace: eligible, projectId } = verdict;

			const completedAt = Date.now();
			const completedCard = buildCompletedWorkspaceCard({
				workspace: eligible,
				projectName: projectNameById.get(projectId) ?? null,
				existingCard,
				completedAt,
			});

			const persistCardIntent = () => {
				if (existingCard) {
					return collections.v2KanbanCards.update(cardId, (draft) => {
						Object.assign(draft, completedCard);
					});
				}
				return collections.v2KanbanCards.insert(completedCard);
			};
			if (!completeWorkspace(workspaceId, completedAt, persistCardIntent)) {
				return {
					ok: false,
					reason: `Failed to complete workspace ${workspaceId}`,
					canFreezeCard: false,
				};
			}
			return { ok: true };
		},
		[collections, completeWorkspace, projectNameById, workspaceById],
	);
}
