import type { WorkspaceState } from "@superset/panes";
import type { HostShapedWorkspace } from "renderer/hooks/host-workspaces/useHostWorkspaces";
import type { PaneLifecycleRow } from "renderer/routes/_authenticated/components/utils/paneLifecycleRows";
import type { AppCollections } from "renderer/routes/_authenticated/providers/CollectionsProvider/collections";
import type { WorkspaceLocalStateDraft } from "renderer/routes/_authenticated/providers/CollectionsProvider/dashboardSidebarLocal";

export type SidebarWorkspaceRow = Pick<
	HostShapedWorkspace,
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
 * (WORKTREE-EXIT-CLEANUP) The sidebar half of exiting a card — Completed,
 * Archive, Snooze and Recycle Bin all mean "I am done with this thread for
 * now". `pinnedAt` goes so restoring the thread cannot resurrect a pin.
 *
 * `runtimeCleanupPendingAt` is a debt rather than a state: the owning host
 * still has to dispose the terminals and release the pinned Claude account,
 * and the reconciler clears the stamp only when THAT host confirms. Every exit
 * records it, whichever machine owns the workspace — an owner that is switched
 * off right now is precisely the case the durable stamp exists for, and the
 * reconciler reaches a remote owner over the relay the same way every other
 * cross-host call does.
 *
 * Spread into the `insert` branch of an exit action and written by
 * {@link applyWorkspaceExitCleanup} on the `update` branch, so the two cannot
 * drift.
 */
export function workspaceExitCleanupState(exitedAt: number) {
	return { pinnedAt: null, runtimeCleanupPendingAt: exitedAt };
}

type WorkspaceExitCleanupDraft = Pick<
	WorkspaceLocalStateDraft,
	"paneLayout" | "workspaceRunTerminals" | "pendingMigratedTerminals"
> & {
	sidebarState: Pick<
		WorkspaceLocalStateDraft["sidebarState"],
		"pinnedAt" | "runtimeCleanupPendingAt"
	>;
};

/**
 * (WORKTREE-EXIT-CLEANUP) The row half of exiting a card, for a row that
 * already exists. Leaving a thread's tabs, terminals and pinned Claude account
 * live behind a row the user can no longer see is what made the old
 * visual-only behaviour wrong: the agent kept burning the account, and
 * re-opening the thread weeks later restored a wall of stale panes.
 *
 * Wipes every piece of runtime state the row owns — the pane layout, the run
 * terminals map, the pending v1-migration terminals — on top of
 * {@link workspaceExitCleanupState}, so restoring the thread brings back an
 * empty workspace. That applies to EVERY workspace, whichever host owns it:
 * the tabs are the renderer's own. A freshly inserted row has no runtime to
 * wipe, which is why the insert branch only needs the sidebar half.
 *
 * Pure and synchronous: the four lifecycle functions keep their signatures, and
 * the renderer-side runtime disposal + host call are driven by their callers.
 */
export function applyWorkspaceExitCleanup(
	draft: WorkspaceExitCleanupDraft,
	exitedAt: number,
): void {
	draft.paneLayout = createEmptyPaneLayout();
	draft.workspaceRunTerminals = {};
	draft.pendingMigratedTerminals = [];
	Object.assign(draft.sidebarState, workspaceExitCleanupState(exitedAt));
}

/**
 * (WORKTREE-EXIT-CLEANUP) Un-exiting a card — Restore, Unarchive, Unsnooze,
 * Uncomplete — cancels the host cleanup it is still waiting on. The user has
 * said they are not done with the thread after all, so killing its terminals
 * and unpinning its Claude account is no longer what they asked for.
 *
 * Only the part that has not happened yet is cancelled. The panes and renderer
 * runtimes were disposed synchronously at exit and do not come back, and a host
 * teardown already in flight is allowed to finish; its late answer is discarded
 * because the stamp it quoted is gone (see `decideCleanupOutcome`).
 */
export function cancelWorkspaceExitCleanup(
	draft: Pick<
		WorkspaceLocalStateDraft["sidebarState"],
		"runtimeCleanupPendingAt"
	>,
): void {
	draft.runtimeCleanupPendingAt = null;
}

/**
 * Clears only the visibility timer for an automatic Snooze return. The host
 * cleanup debt deliberately survives: timed and next-launch returns are not a
 * user reversal, and Snooze permanently releases the account even though the
 * card becomes visible again.
 */
export function applyAutomaticSnoozeReturn(
	draft: Pick<
		WorkspaceLocalStateDraft["sidebarState"],
		"snoozeUntil" | "snoozeLaunchId"
	>,
): void {
	draft.snoozeUntil = null;
	draft.snoozeLaunchId = null;
}

/**
 * (RECYCLE-BIN-SESSIONS) The projectId a lifecycle mutation stamps on a
 * local-state row it has to insert (soft delete, snooze). An EXPLICIT null means
 * "this row is a project-less session" and MUST be honoured — the host record's
 * projectId is consulted only when the caller passed nothing at all. A `??` here
 * would collapse the two cases and refuse to act on a session (its explicit null
 * would look unresolved).
 */
export function resolveSidebarRowProjectId(
	explicitProjectId: string | null | undefined,
	hostProjectId: string | null,
): string | null {
	return explicitProjectId !== undefined ? explicitProjectId : hostProjectId;
}

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
	projectId: string | null,
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
		// A row must never be hidden and pinned at once — a resurrected
		// workspace would otherwise reappear pre-pinned.
		draft.sidebarState.pinnedAt = null;
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
 *
 * (MASTER-ALWAYS-ACTIVE) narrows how long a main stays tombstoned, and nothing
 * else. Mains are still tombstoned here exactly as described above, and
 * removing a project still removes them: the reconciler
 * (`useSurfaceHiddenMainWorkspaces`) gates on the project's `v2SidebarProjects`
 * row, which this function deletes, so its predicate is false the moment the
 * project is gone. But re-ADDING the project puts that row back, and the
 * reconciler then returns the project's master to the active lane on the next
 * render. Re-adding a removed project resurrects its master — by design, and a
 * deliberate exception to (REMOVE-STICKY), which still holds for every worktree
 * and session. A master has no other surface to be recovered from, so the
 * alternative is a row the user can never reach again.
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

	// Also clears each row's pinnedAt, so no separate pin sweep is needed.
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
