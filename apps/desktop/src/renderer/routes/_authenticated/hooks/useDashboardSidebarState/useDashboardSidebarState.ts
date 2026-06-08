import type { Pane, WorkspaceState } from "@superset/panes";
import { useCallback } from "react";
import { terminalRuntimeRegistry } from "renderer/lib/terminal/terminal-runtime-registry";
import { browserRuntimeRegistry } from "renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/hooks/usePaneRegistry/components/BrowserPane/browserRuntimeRegistry";
import {
	extractPaneIds,
	type PaneLifecycleRow,
} from "renderer/routes/_authenticated/components/utils/paneLifecycleRows";
import { useCollections } from "renderer/routes/_authenticated/providers/CollectionsProvider";
import type { AppCollections } from "renderer/routes/_authenticated/providers/CollectionsProvider/collections";
import {
	APP_LAUNCH_ID,
	getNextTabOrder,
	getPrependTabOrder,
	getWorkspaceSidebarBucket,
	isSidebarWorkspaceVisible,
} from "renderer/routes/_authenticated/providers/CollectionsProvider/dashboardSidebarLocal";
import { PROJECT_CUSTOM_COLORS } from "shared/constants/project-colors";

/** The four per-project reveal/collapse booleans on the sidebar project row. */
export type ProjectSectionFlag =
	| "showSnoozed"
	| "showArchived"
	| "snoozedCollapsed"
	| "archivedCollapsed";

type ProjectTopLevelItem = {
	type: "workspace" | "section";
	id: string;
	tabOrder: number;
};

type ProjectTopLevelCollections = Pick<
	AppCollections,
	"v2SidebarSections" | "v2WorkspaceLocalState"
>;

function compareProjectTopLevelItems(
	left: ProjectTopLevelItem,
	right: ProjectTopLevelItem,
): number {
	const orderDelta = left.tabOrder - right.tabOrder;
	if (orderDelta !== 0) return orderDelta;
	if (left.type === right.type) return 0;
	return left.type === "section" ? -1 : 1;
}

function getProjectTopLevelItems(
	collections: ProjectTopLevelCollections,
	projectId: string,
	options: { excludeWorkspaceId?: string; excludeSectionId?: string } = {},
): ProjectTopLevelItem[] {
	return [
		...Array.from(collections.v2WorkspaceLocalState.state.values())
			.filter(
				(item) =>
					item.sidebarState.projectId === projectId &&
					isSidebarWorkspaceVisible(item) &&
					item.sidebarState.sectionId === null &&
					item.workspaceId !== options.excludeWorkspaceId,
			)
			.map((item) => ({
				type: "workspace" as const,
				id: item.workspaceId,
				tabOrder: item.sidebarState.tabOrder,
			})),
		...Array.from(collections.v2SidebarSections.state.values())
			.filter(
				(item) =>
					item.projectId === projectId &&
					item.sectionId !== options.excludeSectionId,
			)
			.map((item) => ({
				type: "section" as const,
				id: item.sectionId,
				tabOrder: item.tabOrder,
			})),
	].sort(compareProjectTopLevelItems);
}

function getFirstSectionIndex(items: ProjectTopLevelItem[]): number {
	const firstSectionIndex = items.findIndex((item) => item.type === "section");
	return firstSectionIndex === -1 ? items.length : firstSectionIndex;
}

function createEmptyPaneLayout(): WorkspaceState<unknown> {
	return {
		version: 1,
		tabs: [],
		activeTabId: null,
	} satisfies WorkspaceState<unknown>;
}

/**
 * Rewrites the flat top-level project lane. Workspace items are explicitly
 * ungrouped by setting sidebarState.projectId and clearing sidebarState.sectionId.
 */
function writeProjectTopLevelOrder(
	collections: ProjectTopLevelCollections,
	projectId: string,
	items: ProjectTopLevelItem[],
): void {
	items.forEach((item, index) => {
		const tabOrder = index + 1;
		if (item.type === "workspace") {
			if (!collections.v2WorkspaceLocalState.get(item.id)) return;
			collections.v2WorkspaceLocalState.update(item.id, (draft) => {
				draft.sidebarState.projectId = projectId;
				draft.sidebarState.sectionId = null;
				draft.sidebarState.tabOrder = tabOrder;
				draft.sidebarState.isHidden = false;
			});
			return;
		}

		if (!collections.v2SidebarSections.get(item.id)) return;
		collections.v2SidebarSections.update(item.id, (draft) => {
			draft.tabOrder = tabOrder;
		});
	});
}

function ensureSidebarProjectRecord(
	collections: Pick<AppCollections, "v2SidebarProjects">,
	projectId: string,
): void {
	if (collections.v2SidebarProjects.get(projectId)) {
		return;
	}

	collections.v2SidebarProjects.insert({
		projectId,
		createdAt: new Date(),
		tabOrder: getNextTabOrder([
			...collections.v2SidebarProjects.state.values(),
		]),
		isCollapsed: false,
	});
}

function ensureSidebarWorkspaceRecord(
	collections: Pick<
		AppCollections,
		"v2SidebarSections" | "v2WorkspaceLocalState" | "v2Workspaces"
	>,
	workspaceId: string,
	projectId: string,
): void {
	const existing = collections.v2WorkspaceLocalState.get(workspaceId);
	// Already placed — don't resurrect into active. An active row, a snoozed row,
	// or an archived row (archivedAt set, OR a removed non-main thread surfaced
	// under Archived) all stay put on re-open (view-in-place). Only a "hidden"
	// row (a removed MAIN workspace: isHidden, no archive) is pulled back into the
	// active lane when explicitly opened. Classified via the shared
	// getWorkspaceSidebarBucket so the rule matches exactly what the sidebar renders.
	if (existing) {
		const workspaceType =
			collections.v2Workspaces.get(workspaceId)?.type ?? null;
		if (
			getWorkspaceSidebarBucket(existing, Date.now(), workspaceType) !== "hidden"
		) {
			return;
		}
	}

	const topLevelItems = getProjectTopLevelItems(collections, projectId);

	if (existing) {
		collections.v2WorkspaceLocalState.update(workspaceId, (draft) => {
			draft.sidebarState.projectId = projectId;
			draft.sidebarState.tabOrder = getPrependTabOrder(topLevelItems);
			draft.sidebarState.sectionId = null;
			draft.sidebarState.isHidden = false;
		});
		return;
	}

	collections.v2WorkspaceLocalState.insert({
		workspaceId,
		createdAt: new Date(),
		sidebarState: {
			projectId,
			tabOrder: getPrependTabOrder(topLevelItems),
			sectionId: null,
			isHidden: false,
		},
		paneLayout: createEmptyPaneLayout(),
	});
}

function getTerminalRuntimeId(pane: Pane<unknown>): string | null {
	if (pane.kind !== "terminal") return null;
	if (!pane.data || typeof pane.data !== "object") return null;
	const data = pane.data as { terminalId?: unknown };
	return typeof data.terminalId === "string" ? data.terminalId : null;
}

function getBrowserRuntimeId(pane: Pane<unknown>): string | null {
	return pane.kind === "browser" ? pane.id : null;
}

function cleanupWorkspacePaneRuntimes(rows: PaneLifecycleRow[]): void {
	for (const terminalId of extractPaneIds(rows, getTerminalRuntimeId)) {
		terminalRuntimeRegistry.release(terminalId);
	}
	for (const browserId of extractPaneIds(rows, getBrowserRuntimeId)) {
		browserRuntimeRegistry.destroy(browserId);
	}
}

export function useDashboardSidebarState() {
	const collections = useCollections();

	const ensureProjectInSidebar = useCallback(
		(projectId: string) => {
			ensureSidebarProjectRecord(collections, projectId);
		},
		[collections],
	);

	const ensureWorkspaceInSidebar = useCallback(
		(workspaceId: string, projectId: string) => {
			ensureSidebarProjectRecord(collections, projectId);
			ensureSidebarWorkspaceRecord(collections, workspaceId, projectId);
		},
		[collections],
	);

	const toggleProjectCollapsed = useCallback(
		(projectId: string) => {
			const existing = collections.v2SidebarProjects.get(projectId);
			if (!existing) return;
			collections.v2SidebarProjects.update(projectId, (draft) => {
				draft.isCollapsed = !draft.isCollapsed;
			});
		},
		[collections],
	);

	const reorderProjects = useCallback(
		(projectIds: string[]) => {
			projectIds.forEach((projectId, index) => {
				if (!collections.v2SidebarProjects.get(projectId)) return;
				collections.v2SidebarProjects.update(projectId, (draft) => {
					draft.tabOrder = index + 1;
				});
			});
		},
		[collections],
	);

	const reorderWorkspaces = useCallback(
		(workspaceIds: string[]) => {
			workspaceIds.forEach((workspaceId, index) => {
				if (!collections.v2WorkspaceLocalState.get(workspaceId)) return;
				collections.v2WorkspaceLocalState.update(workspaceId, (draft) => {
					draft.sidebarState.tabOrder = index + 1;
					draft.sidebarState.isHidden = false;
				});
			});
		},
		[collections],
	);

	const reorderProjectChildren = useCallback(
		(
			projectId: string,
			orderedItems: Array<{ type: "workspace" | "section"; id: string }>,
		) => {
			orderedItems.forEach((item, index) => {
				const tabOrder = index + 1;
				if (item.type === "workspace") {
					if (!collections.v2WorkspaceLocalState.get(item.id)) return;
					collections.v2WorkspaceLocalState.update(item.id, (draft) => {
						draft.sidebarState.tabOrder = tabOrder;
						draft.sidebarState.sectionId = null;
						draft.sidebarState.projectId = projectId;
						draft.sidebarState.isHidden = false;
					});
				} else {
					if (!collections.v2SidebarSections.get(item.id)) return;
					collections.v2SidebarSections.update(item.id, (draft) => {
						draft.tabOrder = tabOrder;
					});
				}
			});
		},
		[collections],
	);

	const moveWorkspaceToSectionAtIndex = useCallback(
		(
			workspaceId: string,
			projectId: string,
			sectionId: string,
			index: number,
		) => {
			const existing = collections.v2WorkspaceLocalState.get(workspaceId);
			if (!existing) return;
			const siblings = Array.from(
				collections.v2WorkspaceLocalState.state.values(),
			)
				.filter(
					(item) =>
						item.sidebarState.projectId === projectId &&
						isSidebarWorkspaceVisible(item) &&
						item.workspaceId !== workspaceId &&
						item.sidebarState.sectionId === sectionId,
				)
				.sort((a, b) => a.sidebarState.tabOrder - b.sidebarState.tabOrder);
			const reordered = [...siblings];
			reordered.splice(index, 0, existing);
			reordered.forEach((item, i) => {
				collections.v2WorkspaceLocalState.update(item.workspaceId, (draft) => {
					draft.sidebarState.tabOrder = i + 1;
					draft.sidebarState.sectionId = sectionId;
					draft.sidebarState.projectId = projectId;
					draft.sidebarState.isHidden = false;
				});
			});
		},
		[collections],
	);

	const createSection = useCallback(
		(projectId: string, options: { name?: string } = {}) => {
			const { name = "New group" } = options;
			ensureSidebarProjectRecord(collections, projectId);

			const sectionId = crypto.randomUUID();
			const randomColor =
				PROJECT_CUSTOM_COLORS[
					Math.floor(Math.random() * PROJECT_CUSTOM_COLORS.length)
				].value;

			const tabOrder = getNextTabOrder(
				getProjectTopLevelItems(collections, projectId),
			);

			collections.v2SidebarSections.insert({
				sectionId,
				projectId,
				name,
				createdAt: new Date(),
				tabOrder,
				isCollapsed: false,
				color: randomColor,
			});

			return sectionId;
		},
		[collections],
	);

	const toggleSectionCollapsed = useCallback(
		(sectionId: string) => {
			if (!collections.v2SidebarSections.get(sectionId)) return;
			collections.v2SidebarSections.update(sectionId, (draft) => {
				draft.isCollapsed = !draft.isCollapsed;
			});
		},
		[collections],
	);

	const renameSection = useCallback(
		(sectionId: string, name: string) => {
			if (!collections.v2SidebarSections.get(sectionId)) return;
			collections.v2SidebarSections.update(sectionId, (draft) => {
				draft.name = name.trim();
			});
		},
		[collections],
	);

	const setSectionColor = useCallback(
		(sectionId: string, color: string | null) => {
			if (!collections.v2SidebarSections.get(sectionId)) return;
			collections.v2SidebarSections.update(sectionId, (draft) => {
				draft.color = color;
			});
		},
		[collections],
	);

	const moveWorkspaceToSection = useCallback(
		(workspaceId: string, projectId: string, sectionId: string | null) => {
			const existing = collections.v2WorkspaceLocalState.get(workspaceId);
			if (!existing) return;

			if (sectionId === null) {
				const topLevelItems = getProjectTopLevelItems(collections, projectId, {
					excludeWorkspaceId: workspaceId,
				});
				const insertIndex = getFirstSectionIndex(topLevelItems);
				topLevelItems.splice(insertIndex, 0, {
					type: "workspace",
					id: workspaceId,
					tabOrder: 0,
				});
				writeProjectTopLevelOrder(collections, projectId, topLevelItems);
				return;
			}

			const siblingRows = Array.from(
				collections.v2WorkspaceLocalState.state.values(),
			)
				.filter(
					(item) =>
						item.sidebarState.projectId === projectId &&
						isSidebarWorkspaceVisible(item) &&
						item.workspaceId !== workspaceId &&
						item.sidebarState.sectionId === sectionId,
				)
				.map((item) => ({ tabOrder: item.sidebarState.tabOrder }));

			collections.v2WorkspaceLocalState.update(workspaceId, (draft) => {
				draft.sidebarState.projectId = projectId;
				draft.sidebarState.sectionId = sectionId;
				draft.sidebarState.tabOrder = getNextTabOrder(siblingRows);
				draft.sidebarState.isHidden = false;
			});
		},
		[collections],
	);

	const deleteSection = useCallback(
		(sectionId: string) => {
			const section = collections.v2SidebarSections.get(sectionId);
			if (!section) return;

			const topLevelItems = getProjectTopLevelItems(
				collections,
				section.projectId,
				{ excludeSectionId: sectionId },
			);
			const sectionWorkspaces = Array.from(
				collections.v2WorkspaceLocalState.state.values(),
			)
				.filter(
					(item) =>
						item.sidebarState.projectId === section.projectId &&
						isSidebarWorkspaceVisible(item) &&
						item.sidebarState.sectionId === sectionId,
				)
				.sort(
					(left, right) =>
						left.sidebarState.tabOrder - right.sidebarState.tabOrder,
				);

			const insertIndex = getFirstSectionIndex(topLevelItems);
			topLevelItems.splice(
				insertIndex,
				0,
				...sectionWorkspaces.map((workspace) => ({
					type: "workspace" as const,
					id: workspace.workspaceId,
					tabOrder: 0,
				})),
			);
			writeProjectTopLevelOrder(collections, section.projectId, topLevelItems);

			collections.v2SidebarSections.delete(sectionId);
		},
		[collections],
	);

	const removeWorkspaceFromSidebar = useCallback(
		(workspaceId: string) => {
			const workspace = collections.v2WorkspaceLocalState.get(workspaceId);
			if (!workspace) return;
			cleanupWorkspacePaneRuntimes([workspace]);
			collections.v2WorkspaceLocalState.delete(workspaceId);
		},
		[collections],
	);

	const hideWorkspaceInSidebar = useCallback(
		(workspaceId: string, projectId: string) => {
			const workspace = collections.v2WorkspaceLocalState.get(workspaceId);
			if (!workspace) {
				collections.v2WorkspaceLocalState.insert({
					workspaceId,
					createdAt: new Date(),
					sidebarState: {
						projectId,
						tabOrder: 0,
						sectionId: null,
						isHidden: true,
					},
					paneLayout: createEmptyPaneLayout(),
				});
				return;
			}

			cleanupWorkspacePaneRuntimes([workspace]);
			collections.v2WorkspaceLocalState.update(workspaceId, (draft) => {
				draft.sidebarState.projectId = projectId;
				draft.sidebarState.sectionId = null;
				draft.sidebarState.isHidden = true;
				draft.paneLayout = createEmptyPaneLayout();
			});
		},
		[collections],
	);

	const removeProjectFromSidebar = useCallback(
		(projectId: string) => {
			const workspaceRows = Array.from(
				collections.v2WorkspaceLocalState.state.values(),
			).filter((item) => item.sidebarState.projectId === projectId);
			const workspaceIds = workspaceRows.map((item) => item.workspaceId);
			const sectionIds = Array.from(
				collections.v2SidebarSections.state.values(),
			)
				.filter((item) => item.projectId === projectId)
				.map((item) => item.sectionId);

			if (workspaceIds.length > 0) {
				cleanupWorkspacePaneRuntimes(workspaceRows);
				collections.v2WorkspaceLocalState.delete(workspaceIds);
			}
			if (sectionIds.length > 0) {
				collections.v2SidebarSections.delete(sectionIds);
			}
			if (collections.v2SidebarProjects.get(projectId)) {
				collections.v2SidebarProjects.delete(projectId);
			}
		},
		[collections],
	);

	// --- Snooze / Archive ---------------------------------------------------
	// All visual-only: they only flip local sidebar flags. Unlike
	// hideWorkspaceInSidebar (which tears down pane runtimes + clears the
	// layout), these intentionally leave the worktree and any running session
	// untouched so a restored thread comes back exactly as it was.

	const archiveWorkspace = useCallback(
		(workspaceId: string) => {
			if (!collections.v2WorkspaceLocalState.get(workspaceId)) return;
			collections.v2WorkspaceLocalState.update(workspaceId, (draft) => {
				draft.sidebarState.isHidden = true;
				draft.sidebarState.archivedAt = Date.now();
				draft.sidebarState.snoozeUntil = null;
				draft.sidebarState.snoozeLaunchId = null;
			});
		},
		[collections],
	);

	const snoozeWorkspace = useCallback(
		(workspaceId: string, until: number | "next-launch") => {
			if (!collections.v2WorkspaceLocalState.get(workspaceId)) return;
			collections.v2WorkspaceLocalState.update(workspaceId, (draft) => {
				if (until === "next-launch") {
					draft.sidebarState.snoozeUntil = null;
					draft.sidebarState.snoozeLaunchId = APP_LAUNCH_ID;
				} else {
					draft.sidebarState.snoozeUntil = until;
					draft.sidebarState.snoozeLaunchId = null;
				}
				draft.sidebarState.isHidden = false;
				draft.sidebarState.archivedAt = null;
			});
		},
		[collections],
	);

	const unsnoozeWorkspace = useCallback(
		(workspaceId: string) => {
			if (!collections.v2WorkspaceLocalState.get(workspaceId)) return;
			collections.v2WorkspaceLocalState.update(workspaceId, (draft) => {
				draft.sidebarState.snoozeUntil = null;
				draft.sidebarState.snoozeLaunchId = null;
			});
		},
		[collections],
	);

	const unsnoozeAllInProject = useCallback(
		(projectId: string) => {
			for (const workspace of collections.v2WorkspaceLocalState.state.values()) {
				if (workspace.sidebarState.projectId !== projectId) continue;
				if (
					workspace.sidebarState.snoozeUntil == null &&
					workspace.sidebarState.snoozeLaunchId == null
				) {
					continue;
				}
				unsnoozeWorkspace(workspace.workspaceId);
			}
		},
		[collections, unsnoozeWorkspace],
	);

	// Restore exactly the rows the caller passes (the ids rendered in the
	// project's Archived section). Id-based rather than re-deriving from isHidden
	// so a removed main/pinned workspace — which is hidden but NOT archived, and
	// therefore never shown in the section — is never accidentally un-hidden.
	const unarchiveWorkspaces = useCallback(
		(workspaceIds: readonly string[]) => {
			for (const workspaceId of workspaceIds) {
				if (!collections.v2WorkspaceLocalState.get(workspaceId)) continue;
				collections.v2WorkspaceLocalState.update(workspaceId, (draft) => {
					draft.sidebarState.isHidden = false;
					draft.sidebarState.archivedAt = null;
				});
			}
		},
		[collections],
	);

	// Single-id convenience wrapper around unarchiveWorkspaces.
	const unarchiveWorkspace = useCallback(
		(workspaceId: string) => unarchiveWorkspaces([workspaceId]),
		[unarchiveWorkspaces],
	);

	const setProjectSectionFlag = useCallback(
		(projectId: string, flag: ProjectSectionFlag, value: boolean) => {
			ensureSidebarProjectRecord(collections, projectId);
			collections.v2SidebarProjects.update(projectId, (draft) => {
				draft[flag] = value;
			});
		},
		[collections],
	);

	const toggleProjectSectionFlag = useCallback(
		(projectId: string, flag: ProjectSectionFlag) => {
			const current =
				collections.v2SidebarProjects.get(projectId)?.[flag] ?? false;
			setProjectSectionFlag(projectId, flag, !current);
		},
		[collections, setProjectSectionFlag],
	);

	return {
		archiveWorkspace,
		createSection,
		deleteSection,
		ensureProjectInSidebar,
		ensureWorkspaceInSidebar,
		hideWorkspaceInSidebar,
		moveWorkspaceToSection,
		moveWorkspaceToSectionAtIndex,
		removeProjectFromSidebar,
		reorderProjectChildren,
		removeWorkspaceFromSidebar,
		reorderProjects,
		reorderWorkspaces,
		renameSection,
		setProjectSectionFlag,
		setSectionColor,
		snoozeWorkspace,
		toggleProjectCollapsed,
		toggleProjectSectionFlag,
		toggleSectionCollapsed,
		unarchiveWorkspace,
		unarchiveWorkspaces,
		unsnoozeAllInProject,
		unsnoozeWorkspace,
	};
}
