import { useCallback, useRef, useSyncExternalStore } from "react";
import type { SidebarProjectSortMode } from "renderer/routes/_authenticated/providers/CollectionsProvider/dashboardSidebarLocal/schema";
// Not the barrel: other test files mock it process-wide.
import { useHostWorkspaceActivityStore } from "renderer/routes/_authenticated/providers/HostWorkspacesProvider/hostWorkspaceActivityStoreContext";
import type { WorkspaceActivityMap } from "renderer/routes/_authenticated/providers/HostWorkspacesProvider/utils/createWorkspaceActivityStore";
import type { DashboardSidebarProject } from "../../types";
import {
	sortDashboardSidebarProjects,
	stabiliseSortedProjects,
} from "../../utils/sortDashboardSidebarProjects";

interface SortedProjectsCache {
	activityById: WorkspaceActivityMap | null;
	orderedGroups: DashboardSidebarProject[];
	sortMode: SidebarProjectSortMode;
	result: DashboardSidebarProject[];
}

const subscribeToNothing = () => () => {};

/**
 * (ACTIVITY-SPLIT) Sorts inside a `useSyncExternalStore` snapshot, so an
 * activity tick that keeps the order returns the previous array and React
 * skips the render.
 */
export function useSortedSidebarProjects(
	orderedGroups: DashboardSidebarProject[],
	sortMode: SidebarProjectSortMode,
): DashboardSidebarProject[] {
	const store = useHostWorkspaceActivityStore();
	const cacheRef = useRef<SortedProjectsCache | null>(null);
	const getSnapshot = useCallback(() => {
		const activityById = sortMode === "active" ? store.get() : null;
		const cache = cacheRef.current;
		if (
			cache &&
			cache.activityById === activityById &&
			cache.orderedGroups === orderedGroups &&
			cache.sortMode === sortMode
		) {
			return cache.result;
		}
		const result =
			sortMode === "manual"
				? orderedGroups
				: stabiliseSortedProjects(
						cache?.result ?? [],
						sortDashboardSidebarProjects(orderedGroups, sortMode, activityById),
					);
		cacheRef.current = { activityById, orderedGroups, sortMode, result };
		return result;
	}, [store, orderedGroups, sortMode]);
	return useSyncExternalStore(
		sortMode === "active" ? store.subscribe : subscribeToNothing,
		getSnapshot,
	);
}
