import { useLiveQuery } from "@tanstack/react-db";
import { useEffect, useMemo } from "react";
import { useDashboardSidebarState } from "renderer/routes/_authenticated/hooks/useDashboardSidebarState";
import { useCollections } from "renderer/routes/_authenticated/providers/CollectionsProvider";
import { useHostWorkspaces } from "renderer/routes/_authenticated/providers/HostWorkspacesProvider";
import { useLocalHostService } from "renderer/routes/_authenticated/providers/LocalHostServiceProvider";
import type { LocalWorkspaceForPlacement } from "../usePlaceLocalWorktreesInSidebar/selectWorktreesToPlace";
import { selectHiddenMainsToSurface } from "./selectHiddenMainsToSurface";

/**
 * (MASTER-ALWAYS-ACTIVE) Returns any master ("main") workspace that is stuck in
 * the legacy "hidden" bucket to the ACTIVE sidebar list, and keeps it there.
 *
 * A hidden main has no surface at all — not the active lane, not Archived (a
 * main without `archivedAt` never buckets "archived") — so it cannot be
 * recovered by the user. Whole-project removal and pre-(MASTER-ARCHIVE-ONLY)
 * master-card removes both left rows in that state. This runs on every render
 * of the always-mounted `AgentHooks`, so it repairs existing rows on first
 * render and prevents the state from persisting if anything recreates it.
 *
 * Idempotent by construction: `ensureWorkspaceInSidebar` clears `isHidden`, so
 * the next pass buckets the row "active" and the predicate is false. There is
 * no feedback loop with `useSidebarMirrorSync` either — that hook is a pure
 * observer and writes no collections.
 */
export function useSurfaceHiddenMainWorkspaces(): void {
	const collections = useCollections();
	const { machineId } = useLocalHostService();
	const { ensureWorkspaceInSidebar } = useDashboardSidebarState();

	const { workspaces, isReady: workspacesReady } = useHostWorkspaces();
	// Only this device's mains can ever be selected, so narrow here: on the
	// common path (nothing stranded) the effect below then does no work at all.
	// The selector still re-checks — its predicate is what the tests pin.
	const localMainWorkspaces = useMemo(
		(): LocalWorkspaceForPlacement[] =>
			workspaces
				.filter(
					(workspace) =>
						workspace.type === "main" && workspace.hostId === machineId,
				)
				.map((workspace) => ({
					id: workspace.id,
					projectId: workspace.projectId,
					type: workspace.type,
					hostId: workspace.hostId,
				})),
		[workspaces, machineId],
	);

	// Only the fields the bucket classifier reads. Selecting leaves (rather than
	// the whole nested object) matches useSidebarMirrorSync's query.
	const { data: localStateRows = [], isReady: localStateReady } = useLiveQuery(
		(query) =>
			query
				.from({ state: collections.v2WorkspaceLocalState })
				.select(({ state }) => ({
					workspaceId: state.workspaceId,
					isHidden: state.sidebarState.isHidden,
					archivedAt: state.sidebarState.archivedAt,
					snoozeUntil: state.sidebarState.snoozeUntil,
					snoozeLaunchId: state.sidebarState.snoozeLaunchId,
					completedAt: state.sidebarState.completedAt,
					deletedAt: state.sidebarState.deletedAt,
				})),
		[collections],
	);

	const { data: sidebarProjectRows = [], isReady: sidebarProjectsReady } =
		useLiveQuery(
			(query) =>
				query
					.from({ sidebarProject: collections.v2SidebarProjects })
					.select(({ sidebarProject }) => ({
						projectId: sidebarProject.projectId,
					})),
			[collections],
		);

	useEffect(() => {
		if (!workspacesReady || !localStateReady || !sidebarProjectsReady) return;
		if (localMainWorkspaces.length === 0) return;

		for (const main of selectHiddenMainsToSurface(
			localMainWorkspaces,
			localStateRows,
			sidebarProjectRows,
			machineId,
			Date.now(),
		)) {
			ensureWorkspaceInSidebar(main.id, main.projectId);
		}
	}, [
		ensureWorkspaceInSidebar,
		localStateReady,
		localStateRows,
		localMainWorkspaces,
		machineId,
		sidebarProjectRows,
		sidebarProjectsReady,
		workspacesReady,
	]);
}
