import type { WorkspaceState } from "@superset/panes";
import type { HostShapedWorkspace } from "renderer/hooks/host-workspaces/useHostWorkspaces";
import type { PaneLifecycleRow } from "renderer/routes/_authenticated/components/utils/paneLifecycleRows";
import type { AppCollections } from "renderer/routes/_authenticated/providers/CollectionsProvider/collections";
import {
	getPrependTabOrder,
	type WorkspaceLocalStateDraft,
} from "renderer/routes/_authenticated/providers/CollectionsProvider/dashboardSidebarLocal";

export type SidebarWorkspaceRow = Pick<
	HostShapedWorkspace,
	"id" | "projectId" | "type" | "hostId" | "createdByUserId"
>;

/**
 * Who the sidebar reconciler places for: the local host unconditionally, a
 * remote host only for workspaces this user created. Mirrors
 * `selectWorktreesToPlace` so hiding a project tombstones exactly what
 * placement could bring back.
 */
export type SidebarPlacementScope = {
	machineId: string | null;
	currentUserId: string | null;
};

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
 * Puts a project in the sidebar. A hidden row counts as absent: every path
 * that would add the project (setting it up on this device, opening one of
 * its workspaces, an agent creating a worktree in it) reveals it again, the
 * same way re-adding a removed project used to.
 */
export function ensureSidebarProjectRecord(
	collections: Pick<AppCollections, "v2SidebarProjects">,
	projectId: string,
): void {
	const existing = collections.v2SidebarProjects.get(projectId);
	if (existing) {
		if (existing.isHidden) {
			collections.v2SidebarProjects.update(projectId, (draft) => {
				draft.isHidden = false;
			});
		}
		return;
	}

	collections.v2SidebarProjects.insert({
		projectId,
		createdAt: new Date(),
		// Prepend, matching new workspaces: the project you just added is
		// the one you're about to work in.
		tabOrder: getPrependTabOrder([
			...collections.v2SidebarProjects.state.values(),
		]),
		isCollapsed: false,
		isHidden: false,
	});
}

/**
 * Hides or shows a project without touching its workspaces, sections, pins or
 * order, so a hidden project comes back exactly as it was left. Hiding is the
 * reversible alternative to deleting the project: nothing on any host changes.
 */
export function setSidebarProjectHidden(
	collections: Pick<AppCollections, "v2SidebarProjects">,
	projectId: string,
	hidden: boolean,
): void {
	if (!collections.v2SidebarProjects.get(projectId)) return;
	collections.v2SidebarProjects.update(projectId, (draft) => {
		draft.isHidden = hidden;
	});
}

/**
 * (REMOVE-STICKY) Hiding a project from the sidebar — the fork's version of the
 * action the context menu offers. Upstream's hide flag alone is display-only:
 * the project row survives untouched, so the moment ANYTHING reveals it again
 * — an explicit open, or `usePlaceWorktreesInSidebar` ->
 * `ensureWorkspaceInSidebar` -> {@link ensureSidebarProjectRecord} when the CLI
 * or an automation creates ONE new worktree in it — every thread the user
 * dismissed with the project floods back. Dismissed stays dismissed here: the
 * project comes back showing the genuinely-new worktree, not a wall of threads
 * the user closed the project to be rid of.
 *
 * EVERY workspace of the project is tombstoned. A workspace with no local-state
 * row would be re-placed by the reconciler (revealing the project), and a
 * kept-but-visible row reappears with it, so both existing rows and the
 * row-less workspaces the reconciler could re-pin are hidden. Row-less ones are
 * tombstoned on every host the reconciler could place from — the local host,
 * plus any remote host for workspaces this user created — not just online
 * ones: a host that is offline now would re-place the project the moment it
 * comes back. Teammates' workspaces on a shared host never qualify for
 * placement, so they get no tombstone; on a busy host that would be hundreds of
 * localStorage rows per hide for nothing.
 *
 * `main` workspaces are tombstoned too (`isHidden`, no archivedAt — the legacy
 * "hidden" bucket, not Archived). Leaving them visible is what used to let a
 * passive `ensureWorkspaceInSidebar` (a route mount from session restore, the
 * kanban split, a background navigation) reveal the project and bring the whole
 * thing back; passive mounts skip hidden rows
 * (`placeWorkspaceFromPassiveMount`), and an EXPLICIT open (Workspaces page,
 * project setup/import) still pulls a hidden main back to active.
 *
 * (MASTER-ALWAYS-ACTIVE) narrows how long a main stays tombstoned, and nothing
 * else: `selectHiddenMainsToSurface` treats a HIDDEN project row as out of the
 * sidebar (a hidden project is absent, the same way the display path reads it),
 * so its predicate is false while the project is hidden and true again the
 * moment the project is shown — showing a hidden project resurrects its master,
 * a deliberate exception to (REMOVE-STICKY) that still holds for every worktree
 * and session. A master has no other surface to be recovered from.
 *
 * The project row itself is only flagged, never deleted, so upstream's promise
 * that a hidden project keeps its order, collapse state and `defaultOpenInApp`
 * survives. Its sections do not: their rows are emptied by the tombstones above
 * (every tombstone clears `sectionId`), and an empty group the user never made
 * is not what "as it was left" means. Undo on the hide toast reveals the
 * project again exactly as re-adding a removed project used to — the
 * dismissals are sticky, which is the whole point of this function.
 */
export function hideProjectFromSidebarState(
	collections: Pick<
		AppCollections,
		"v2WorkspaceLocalState" | "v2SidebarSections" | "v2SidebarProjects"
	>,
	workspaces: SidebarWorkspaceRow[],
	projectId: string,
	placement: SidebarPlacementScope,
	cleanupPaneRuntimes: CleanupPaneRuntimes,
): void {
	const tombstoneIds = new Set<string>();
	for (const row of collections.v2WorkspaceLocalState.state.values()) {
		if (row.sidebarState.projectId === projectId) {
			tombstoneIds.add(row.workspaceId);
		}
	}
	for (const ws of workspaces) {
		// (REMOVE-STICKY) Every type, not just worktrees — see the mains note
		// above; the host/creator gate below is upstream's placement scope.
		if (ws.projectId !== projectId) continue;
		const isLocal =
			placement.machineId !== null && ws.hostId === placement.machineId;
		const isMine =
			placement.currentUserId !== null &&
			ws.createdByUserId === placement.currentUserId;
		if (isLocal || isMine) tombstoneIds.add(ws.id);
	}

	// Also clears each row's pinnedAt, so no separate pin sweep is needed: a
	// pinned row is excluded from the project tree and, with the project
	// hidden, the pinned section drops it too — leaving it fully invisible with
	// no context menu to unpin it from.
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

	setSidebarProjectHidden(collections, projectId, true);
}
