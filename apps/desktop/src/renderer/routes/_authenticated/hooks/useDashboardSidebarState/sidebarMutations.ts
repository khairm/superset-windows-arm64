import type { SelectV2Workspace } from "@superset/db/schema";
import type { WorkspaceState } from "@superset/panes";
import type { PaneLifecycleRow } from "renderer/routes/_authenticated/components/utils/paneLifecycleRows";
import type { AppCollections } from "renderer/routes/_authenticated/providers/CollectionsProvider/collections";

export type SidebarWorkspaceRow = Pick<
	SelectV2Workspace,
	"id" | "projectId" | "type" | "hostId"
>;

/**
 * Pure sidebar local-state mutations, kept free of React/Electron imports so
 * they can be unit-tested against an in-memory collection. Pane-runtime cleanup
 * is injected so the registry side effects stay in the hook layer.
 */

export function createEmptyPaneLayout(): WorkspaceState<unknown> {
	return {
		version: 1,
		tabs: [],
		activeTabId: null,
	} satisfies WorkspaceState<unknown>;
}

type CleanupPaneRuntimes = (rows: PaneLifecycleRow[]) => void;

/**
 * Hides a single workspace while keeping its project in the sidebar, by leaving
 * a hidden "tombstone" row rather than deleting it. A local `main` workspace
 * with no local-state row is re-surfaced by the gated auto-include path, so
 * hiding one requires a row (`isHidden: true`) to suppress it; a hard-delete
 * would let it reappear.
 */
export function tombstoneSidebarWorkspaceRecord(
	collections: Pick<AppCollections, "v2WorkspaceLocalState">,
	workspaceId: string,
	projectId: string,
	cleanupPaneRuntimes: CleanupPaneRuntimes,
): void {
	const existing = collections.v2WorkspaceLocalState.get(workspaceId);
	if (!existing) {
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

	cleanupPaneRuntimes([existing]);
	collections.v2WorkspaceLocalState.update(workspaceId, (draft) => {
		draft.sidebarState.projectId = projectId;
		draft.sidebarState.sectionId = null;
		draft.sidebarState.isHidden = true;
		draft.paneLayout = createEmptyPaneLayout();
	});
}

/**
 * Removes a project from the sidebar. Deleting its `v2SidebarProjects` row is
 * what hides it: membership is explicit and display gates on it
 * (`buildDashboardSidebarProjects` drops any workspace whose project is absent).
 *
 * EVERY workspace of the project is tombstoned so "removed" stays removed
 * (REMOVE-STICKY). A worktree with no local-state row would be re-placed by
 * `usePlaceLocalWorktreesInSidebar` (recreating the project), and a
 * kept-but-visible row would flood back the moment anything recreates the
 * project row — e.g. a later automation-created worktree. Hiding each one
 * (existing rows, plus this device's row-less workspaces) means a resurrected
 * project shows only the genuinely-new worktree, not these dismissed ones.
 *
 * `main` workspaces used to be left alone (visible row kept, hidden only by
 * project-row absence) — but any passive `ensureWorkspaceInSidebar` (a route
 * mount from session restore, the kanban split, a background navigation)
 * re-inserted the project row and the whole project came back. Mains are now
 * tombstoned too (`isHidden`, no archivedAt — the legacy "hidden" bucket, not
 * Archived), passive mounts skip hidden rows, and an EXPLICIT open (Workspaces
 * page, project setup/import) still pulls a hidden main back to active.
 * Removing a project discards `defaultOpenInApp` (stored on the project row
 * and nowhere else); it resets to default on re-add.
 */
export function removeProjectFromSidebarState(
	collections: Pick<
		AppCollections,
		"v2WorkspaceLocalState" | "v2SidebarSections" | "v2SidebarProjects"
	>,
	workspaces: SidebarWorkspaceRow[],
	projectId: string,
	machineId: string,
	cleanupPaneRuntimes: CleanupPaneRuntimes,
): void {
	const tombstoneIds = new Set<string>();
	for (const row of collections.v2WorkspaceLocalState.state.values()) {
		if (row.sidebarState.projectId === projectId) {
			tombstoneIds.add(row.workspaceId);
		}
	}
	for (const ws of workspaces) {
		if (ws.projectId === projectId && ws.hostId === machineId) {
			tombstoneIds.add(ws.id);
		}
	}

	for (const workspaceId of tombstoneIds) {
		tombstoneSidebarWorkspaceRecord(
			collections,
			workspaceId,
			projectId,
			cleanupPaneRuntimes,
		);
	}

	const sectionIds = Array.from(collections.v2SidebarSections.state.values())
		.filter((item) => item.projectId === projectId)
		.map((item) => item.sectionId);
	if (sectionIds.length > 0) {
		collections.v2SidebarSections.delete(sectionIds);
	}

	if (collections.v2SidebarProjects.get(projectId)) {
		collections.v2SidebarProjects.delete(projectId);
	}
}
