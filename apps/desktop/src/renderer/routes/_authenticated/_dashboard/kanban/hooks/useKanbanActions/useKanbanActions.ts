import { useCallback, useMemo } from "react";
import { useHostProjects } from "renderer/hooks/host-projects/useHostProjects";
import { useDashboardSidebarState } from "renderer/routes/_authenticated/hooks/useDashboardSidebarState";
import { useCollections } from "renderer/routes/_authenticated/providers/CollectionsProvider";
import {
	APP_LAUNCH_ID,
	getNextTabOrder,
	KANBAN_COMPLETED_COLUMN_ID,
	KANBAN_QUEUE_COLUMN_ID,
	type KanbanCardRow,
	kanbanBoundCardId,
} from "renderer/routes/_authenticated/providers/CollectionsProvider/dashboardSidebarLocal";
import { useHostWorkspaces } from "renderer/routes/_authenticated/providers/HostWorkspacesProvider";
import { applyKanbanCardPatch } from "../../utils/applyKanbanCardPatch";
import { buildCompletedContext } from "../../utils/completedFilter";
import { getColumnDeleteTarget } from "../../utils/computeColumnDeleteTargets";
import { deriveCardTitle } from "../../utils/deriveCardTitle";

export type CardDropKind = "ok" | "promote" | "reject";

export interface DeleteColumnResult {
	ok: boolean;
	reason?: string;
}

export interface UseKanbanActionsResult {
	createQueuedCard: (title?: string) => string;
	updateCard: (
		cardId: string,
		patch: {
			title?: string;
			description?: string | null;
			deadline?: number | null;
		},
	) => void;
	canDropCard: (
		card: KanbanCardRow,
		toColumnId: string,
		workspaceType?: string | null,
	) => CardDropKind;
	applyCardOrder: (columnId: string, orderedCardIds: string[]) => void;
	applyDeadlineTieOrder: (
		orderedCardIds: string[],
		resetCardIds?: string[],
	) => void;
	moveCardToColumn: (cardId: string, toColumnId: string) => void;
	completePromote: (
		queuedCardId: string,
		workspaceId: string,
		toColumnId: string,
	) => void;
	restoreQueuedCard: (
		snapshot: KanbanCardRow,
		optimisticWorkspaceId: string,
	) => void;
	rebindPromotedCard: (fromWorkspaceId: string, toWorkspaceId: string) => void;
	addColumn: (name?: string) => string;
	renameColumn: (columnId: string, name: string) => void;
	deleteColumn: (columnId: string) => DeleteColumnResult;
	reorderColumns: (orderedCustomIds: string[]) => void;
	setColumnSortMode: (columnId: string, mode: "manual" | "deadline") => void;
	setColumnSectionFlag: (
		columnId: string,
		field:
			| "showSnoozed"
			| "showArchived"
			| "snoozedCollapsed"
			| "archivedCollapsed"
			| "showRecycleBin"
			| "recycleBinCollapsed",
		value: boolean,
	) => void;
	snoozeCard: (card: KanbanCardRow, until: number | "next-launch") => void;
	unsnoozeCard: (card: KanbanCardRow) => void;
	archiveCard: (card: KanbanCardRow) => void;
	unarchiveCard: (card: KanbanCardRow) => void;
	/** (RECYCLE-BIN) The default card "Delete" — SOFT, silent (no dialog/toast).
	 * Bound cards delegate to deleteWorkspace (one source of truth on the branch's
	 * sidebarState); an unbound (Queued) card stamps its own deletedAt. The
	 * worktree/branch/sessions are untouched — exactly like Archive. */
	deleteCard: (card: KanbanCardRow) => void;
	/** (RECYCLE-BIN) Restore a soft-deleted card straight back to ACTIVE — bound
	 * via restoreWorkspace, unbound by clearing its deletedAt. */
	restoreCard: (card: KanbanCardRow) => void;
	/** (RECYCLE-BIN) The unbound permanent destroy from inside the bin: hard-remove
	 * the card row. A BOUND card's permanent destroy is the shared branch dialog
	 * (the reconcile then drops the card) — wired in KanbanCard, not here. */
	deletePermanentlyCard: (card: KanbanCardRow) => void;
	/** (KANBAN COMPLETED) Drop into the Completed column: stamps completedAt
	 * (the report datum + sidebar-hide flag) and snapshots title/context. */
	completeCard: (card: KanbanCardRow) => void;
	/** Drag out of the Completed column: clears the stamps and moves the card
	 * into `toColumnId` (the board's reorder pass then places it precisely). */
	uncompleteCard: (card: KanbanCardRow, toColumnId: string) => void;
	updateCompletedDate: (cardId: string, completedAt: number) => void;
	/** Delete a Completed-column record with no live branch (unbound task or a
	 * frozen record). Bound cards with a live branch delete via the branch
	 * dialog — the record then survives frozen, by design. */
	deleteCompletedCard: (cardId: string) => void;
	setColumnCompletedFilter: (
		columnId: string,
		filter:
			| { kind: "all" }
			| { kind: "last-month" }
			| { kind: "custom"; fromMs: number; toMs: number },
	) => void;
}

/**
 * All Kanban mutators. Bound-card snooze/archive delegate to the EXISTING
 * sidebar state (one source of truth keyed by workspaceId); unbound (Queued)
 * cards carry their own fields. Deleting a bound card's branch is handled by the
 * shared DeleteWorkspaceDialog (the board's reconcile then drops the card).
 */
export function useKanbanActions(): UseKanbanActionsResult {
	const collections = useCollections();
	const {
		archiveWorkspace,
		completeWorkspace,
		deleteWorkspace,
		restoreWorkspace,
		snoozeWorkspace,
		uncompleteWorkspace,
		unsnoozeWorkspace,
		unarchiveWorkspaces,
		ensureWorkspaceInSidebar,
	} = useDashboardSidebarState();

	// Projects are fully local now — sourced from the host fan-out
	// (useHostProjects), keyed by projectKey which equals a workspace's
	// projectId. Upstream retired the `v2Projects` Electric collection.
	const { projects: hostProjects } = useHostProjects();
	const projectNameById = useMemo(() => {
		const map = new Map<string, string>();
		for (const p of hostProjects) map.set(p.projectKey, p.name);
		return map;
	}, [hostProjects]);

	// (KANBAN HOST SOURCE) Workspace lookups go to the host-served lists, not
	// the dead Electric mirror (see useKanbanData).
	const { workspaces: hostWorkspaces } = useHostWorkspaces();
	const hostWorkspaceById = useMemo(() => {
		const map = new Map<string, (typeof hostWorkspaces)[number]>();
		for (const w of hostWorkspaces) map.set(w.id, w);
		return map;
	}, [hostWorkspaces]);

	const columnCards = useCallback(
		(columnId: string) =>
			Array.from(collections.v2KanbanCards.state.values()).filter(
				(c) => c.columnId === columnId,
			),
		[collections],
	);

	const customColumnsOrdered = useCallback(
		() =>
			Array.from(collections.v2KanbanColumns.state.values())
				.filter(
					(c) =>
						!c.isQueue &&
						c.id !== KANBAN_QUEUE_COLUMN_ID &&
						!c.isCompleted &&
						c.id !== KANBAN_COMPLETED_COLUMN_ID,
				)
				.sort((a, b) => a.tabOrder - b.tabOrder),
		[collections],
	);

	const ensureBoundRow = useCallback(
		(workspaceId: string) => {
			if (collections.v2WorkspaceLocalState.get(workspaceId)) return;
			const ws = hostWorkspaceById.get(workspaceId);
			if (ws) ensureWorkspaceInSidebar(workspaceId, ws.projectId);
		},
		[collections, hostWorkspaceById, ensureWorkspaceInSidebar],
	);

	const createQueuedCard = useCallback(
		(title?: string) => {
			const id = crypto.randomUUID();
			const tabOrder = getNextTabOrder(columnCards(KANBAN_QUEUE_COLUMN_ID));
			collections.v2KanbanCards.insert({
				id,
				columnId: KANBAN_QUEUE_COLUMN_ID,
				tabOrder,
				title: title ?? "",
				description: null,
				deadline: null,
				deadlineTabOrder: null,
				workspaceId: null,
				snoozeUntil: null,
				snoozeLaunchId: null,
				archivedAt: null,
				completedAt: null,
				completedContext: null,
				createdAt: Date.now(),
			});
			return id;
		},
		[collections, columnCards],
	);

	const updateCard = useCallback<UseKanbanActionsResult["updateCard"]>(
		(cardId, patch) => {
			if (!collections.v2KanbanCards.get(cardId)) return;
			collections.v2KanbanCards.update(cardId, (draft) =>
				applyKanbanCardPatch(draft, patch),
			);
		},
		[collections],
	);

	const canDropCard = useCallback<UseKanbanActionsResult["canDropCard"]>(
		(card, toColumnId, workspaceType) => {
			const toQueue = toColumnId === KANBAN_QUEUE_COLUMN_ID;
			// (KANBAN COMPLETED) ANY card can complete except a repo's main
			// workspace (completing hides the sidebar row — a hidden main has no
			// restore path since un-completion is dragging the card back out, and
			// main rows must always be reachable). Unbound cards complete directly
			// — completing a task is NOT a promote (no branch gets created).
			if (toColumnId === KANBAN_COMPLETED_COLUMN_ID) {
				return workspaceType === "main" ? "reject" : "ok";
			}
			if (card.workspaceId) {
				// A bound (branch) card can never enter the unbound-only Queue.
				return toQueue ? "reject" : "ok";
			}
			// An unbound (Queued) card leaving the Queue must bind to a branch.
			return toQueue ? "ok" : "promote";
		},
		[],
	);

	const applyCardOrder = useCallback(
		(columnId: string, orderedCardIds: string[]) => {
			// Batched update: one transaction = ONE localStorage flush for the whole
			// column (the driver re-serializes the entire per-org blob per
			// transaction, so per-card updates paid N flushes per drop).
			const ids = orderedCardIds.filter((id) =>
				collections.v2KanbanCards.get(id),
			);
			if (ids.length === 0) return;
			collections.v2KanbanCards.update(ids, (drafts) => {
				drafts.forEach((draft, index) => {
					// (DEADLINE-TIE-ORDER) a card entering a DIFFERENT column arrives
					// in that column's tie groups as a NEW item; same-column manual
					// reorders never touch the deadline-mode order.
					if (draft.columnId !== columnId) draft.deadlineTabOrder = null;
					draft.columnId = columnId;
					draft.tabOrder = index + 1;
				});
			});
		},
		[collections],
	);

	const applyDeadlineTieOrder = useCallback(
		(orderedCardIds: string[], resetCardIds: string[] = []) => {
			// (DEADLINE-TIE-ORDER) Persist a drag done in deadline sort mode:
			// numbers the dragged card's whole displayed tie group, and RESETS the
			// group's hidden (snoozed/archived) members to null — their placement
			// context changed while hidden, so they return as new arrivals at the
			// bottom instead of interleaving with a stale number. NEVER touches
			// tabOrder — the manual order survives mode round-trips. One batched
			// transaction = one localStorage flush.
			const orderIds = orderedCardIds.filter((id) =>
				collections.v2KanbanCards.get(id),
			);
			const resetIds = resetCardIds.filter(
				(id) => !orderIds.includes(id) && collections.v2KanbanCards.get(id),
			);
			const ids = [...orderIds, ...resetIds];
			if (ids.length === 0) return;
			collections.v2KanbanCards.update(ids, (drafts) => {
				drafts.forEach((draft, index) => {
					draft.deadlineTabOrder = index < orderIds.length ? index + 1 : null;
				});
			});
		},
		[collections],
	);

	const moveCardToColumn = useCallback(
		(cardId: string, toColumnId: string) => {
			if (!collections.v2KanbanCards.get(cardId)) return;
			const tabOrder = getNextTabOrder(columnCards(toColumnId));
			collections.v2KanbanCards.update(cardId, (draft) => {
				draft.columnId = toColumnId;
				draft.tabOrder = tabOrder;
				// (DEADLINE-TIE-ORDER) new column = new tie groups; arrive as a
				// NEW item (below the explicitly ordered cards of its group).
				draft.deadlineTabOrder = null;
			});
		},
		[collections, columnCards],
	);

	const completePromote = useCallback(
		(queuedCardId: string, workspaceId: string, toColumnId: string) => {
			const queued = collections.v2KanbanCards.get(queuedCardId);
			// Fail fast: only promote an existing UNBOUND card into a real non-Queue
			// column (guards against stale dialogs). NOTE: we do NOT require the
			// v2Workspaces row to exist yet — the caller awaited a confirmed create
			// outcome, but the optimistic/synced row may lag a tick; the bound card
			// is keyed by workspaceId and reconcile aligns it.
			if (!queued || queued.workspaceId) return;
			const targetColumn = collections.v2KanbanColumns.get(toColumnId);
			// Completed is no promote target either: a freshly-created branch must
			// never be born completed (drops on Completed return "ok", not
			// "promote", so this is unreachable via the board — belt and braces).
			if (!targetColumn || targetColumn.isQueue || targetColumn.isCompleted) {
				return;
			}
			const tabOrder = getNextTabOrder(columnCards(toColumnId));
			const boundId = kanbanBoundCardId(workspaceId);
			const existing = collections.v2KanbanCards.get(boundId);
			if (existing) {
				// Merge the Queued task metadata into the branch's existing card
				// (non-git main, or a git branch-name collision). One card per branch.
				collections.v2KanbanCards.update(boundId, (draft) => {
					// (DEADLINE-TIE-ORDER) merged into a different column or tie
					// group → arrives as a NEW item; an in-place merge keeps its order.
					const columnChanged = draft.columnId !== toColumnId;
					const deadlineChanged =
						queued?.deadline != null && queued.deadline !== draft.deadline;
					draft.columnId = toColumnId;
					draft.tabOrder = tabOrder;
					if (queued?.title) draft.title = queued.title;
					if (queued?.description != null)
						draft.description = queued.description;
					if (queued?.deadline != null) draft.deadline = queued.deadline;
					if (columnChanged || deadlineChanged) draft.deadlineTabOrder = null;
				});
			} else {
				collections.v2KanbanCards.insert({
					id: boundId,
					columnId: toColumnId,
					tabOrder,
					title: queued?.title || "",
					description: queued?.description ?? null,
					deadline: queued?.deadline ?? null,
					deadlineTabOrder: null,
					workspaceId,
					snoozeUntil: null,
					snoozeLaunchId: null,
					archivedAt: null,
					// Promoting a completed task REOPENS it — the new branch card
					// deliberately carries no completedAt (same on the merge path
					// above, which never copies completion fields).
					completedAt: null,
					completedContext: null,
					createdAt: Date.now(),
				});
			}
			if (queued) collections.v2KanbanCards.delete(queuedCardId);
		},
		[collections, columnCards],
	);

	// (PROMOTE-OPTIMISTIC) The promote dialog binds the card to the OPTIMISTIC
	// workspace id and closes as soon as the create is submitted (the sidebar
	// flow never blocks on persistence either — `completed` resolves only after
	// the sync round-trip). These two actions are its background continuations.

	const restoreQueuedCard = useCallback(
		(snapshot: KanbanCardRow, optimisticWorkspaceId: string) => {
			// The create FAILED: the optimistic workspace row rolled back (reconcile
			// drops the bound card) — put the task back in Queued so it's never lost.
			const boundId = kanbanBoundCardId(optimisticWorkspaceId);
			if (collections.v2KanbanCards.get(boundId)) {
				collections.v2KanbanCards.delete(boundId);
			}
			if (collections.v2KanbanCards.get(snapshot.id)) return;
			// (KANBAN COMPLETED) a completed task whose reopen-promote failed goes
			// back where it was — the Completed column, stamps intact (the spread
			// carries completedAt/completedContext) — not into Queued.
			const restoreColumnId =
				snapshot.completedAt != null
					? KANBAN_COMPLETED_COLUMN_ID
					: KANBAN_QUEUE_COLUMN_ID;
			collections.v2KanbanCards.insert({
				...snapshot,
				columnId: restoreColumnId,
				tabOrder: getNextTabOrder(columnCards(restoreColumnId)),
				deadlineTabOrder: null,
				workspaceId: null,
			});
		},
		[collections, columnCards],
	);

	const rebindPromotedCard = useCallback(
		(fromWorkspaceId: string, toWorkspaceId: string) => {
			// The host persisted the create under a DIFFERENT id than the optimistic
			// one — bound card ids derive from the workspace id, so move the card.
			if (fromWorkspaceId === toWorkspaceId) return;
			const fromId = kanbanBoundCardId(fromWorkspaceId);
			const from = collections.v2KanbanCards.get(fromId);
			if (!from) return;
			collections.v2KanbanCards.delete(fromId);
			const toId = kanbanBoundCardId(toWorkspaceId);
			const existing = collections.v2KanbanCards.get(toId);
			if (existing) {
				// The mirror already auto-created the real card — merge, one per branch.
				collections.v2KanbanCards.update(toId, (draft) => {
					draft.columnId = from.columnId;
					draft.tabOrder = from.tabOrder;
					// Placement copies are unconditional (the optimistic card is the
					// one the user arranged); null correctly means "never ordered".
					draft.deadlineTabOrder = from.deadlineTabOrder;
					if (from.title) draft.title = from.title;
					if (from.description != null) draft.description = from.description;
					if (from.deadline != null) draft.deadline = from.deadline;
				});
				return;
			}
			collections.v2KanbanCards.insert({
				...from,
				id: toId,
				workspaceId: toWorkspaceId,
			});
		},
		[collections],
	);

	const addColumn = useCallback(
		(name?: string) => {
			const id = crypto.randomUUID();
			const tabOrder = getNextTabOrder(customColumnsOrdered());
			collections.v2KanbanColumns.insert({
				id,
				name: name ?? "New column",
				tabOrder,
				isQueue: false,
				isCompleted: false,
				sortMode: "manual",
				completedFilter: "all",
				completedFilterFrom: null,
				completedFilterTo: null,
				showSnoozed: false,
				showArchived: false,
				snoozedCollapsed: false,
				archivedCollapsed: false,
				createdAt: Date.now(),
			});
			return id;
		},
		[collections, customColumnsOrdered],
	);

	const renameColumn = useCallback(
		(columnId: string, name: string) => {
			if (!collections.v2KanbanColumns.get(columnId)) return;
			collections.v2KanbanColumns.update(columnId, (draft) => {
				draft.name = name;
			});
		},
		[collections],
	);

	const deleteColumn = useCallback(
		(columnId: string): DeleteColumnResult => {
			const ordered = customColumnsOrdered().map((c) => c.id);
			const { allowed, targetColumnId } = getColumnDeleteTarget(
				ordered,
				columnId,
			);
			if (!allowed || !targetColumnId) {
				return {
					ok: false,
					reason: "Cannot delete the last custom column.",
				};
			}
			// Move this column's cards to the target column (append, renumber).
			const moving = columnCards(columnId).sort(
				(a, b) => a.tabOrder - b.tabOrder,
			);
			let order = getNextTabOrder(columnCards(targetColumnId));
			for (const card of moving) {
				collections.v2KanbanCards.update(card.id, (draft) => {
					draft.columnId = targetColumnId;
					draft.tabOrder = order;
				});
				order += 1;
			}
			collections.v2KanbanColumns.delete(columnId);
			return { ok: true };
		},
		[collections, columnCards, customColumnsOrdered],
	);

	const reorderColumns = useCallback(
		(orderedCustomIds: string[]) => {
			orderedCustomIds.forEach((columnId, index) => {
				if (!collections.v2KanbanColumns.get(columnId)) return;
				collections.v2KanbanColumns.update(columnId, (draft) => {
					draft.tabOrder = index + 1;
				});
			});
		},
		[collections],
	);

	const setColumnSortMode = useCallback(
		(columnId: string, mode: "manual" | "deadline") => {
			if (!collections.v2KanbanColumns.get(columnId)) return;
			collections.v2KanbanColumns.update(columnId, (draft) => {
				draft.sortMode = mode;
			});
		},
		[collections],
	);

	const setColumnSectionFlag = useCallback<
		UseKanbanActionsResult["setColumnSectionFlag"]
	>(
		(columnId, field, value) => {
			if (!collections.v2KanbanColumns.get(columnId)) return;
			collections.v2KanbanColumns.update(columnId, (draft) => {
				draft[field] = value;
			});
		},
		[collections],
	);

	const snoozeCard = useCallback(
		(card: KanbanCardRow, until: number | "next-launch") => {
			if (card.workspaceId) {
				ensureBoundRow(card.workspaceId);
				snoozeWorkspace(card.workspaceId, until);
				return;
			}
			if (!collections.v2KanbanCards.get(card.id)) return;
			collections.v2KanbanCards.update(card.id, (draft) => {
				if (until === "next-launch") {
					// Same "until next launch" sentinel as the sidebar: store this
					// launch's id; on the next launch APP_LAUNCH_ID differs and the
					// card is no longer snoozed (cleared by useKanbanData's ticker).
					draft.snoozeUntil = null;
					draft.snoozeLaunchId = APP_LAUNCH_ID;
				} else {
					draft.snoozeUntil = until;
					draft.snoozeLaunchId = null;
				}
				draft.archivedAt = null;
			});
		},
		[collections, snoozeWorkspace, ensureBoundRow],
	);

	const unsnoozeCard = useCallback(
		(card: KanbanCardRow) => {
			if (card.workspaceId) {
				unsnoozeWorkspace(card.workspaceId);
				return;
			}
			if (!collections.v2KanbanCards.get(card.id)) return;
			collections.v2KanbanCards.update(card.id, (draft) => {
				draft.snoozeUntil = null;
				draft.snoozeLaunchId = null;
			});
		},
		[collections, unsnoozeWorkspace],
	);

	const archiveCard = useCallback(
		(card: KanbanCardRow) => {
			if (card.workspaceId) {
				ensureBoundRow(card.workspaceId);
				archiveWorkspace(card.workspaceId);
				return;
			}
			if (!collections.v2KanbanCards.get(card.id)) return;
			collections.v2KanbanCards.update(card.id, (draft) => {
				draft.archivedAt = Date.now();
				draft.snoozeUntil = null;
				draft.snoozeLaunchId = null;
			});
		},
		[collections, archiveWorkspace, ensureBoundRow],
	);

	const unarchiveCard = useCallback(
		(card: KanbanCardRow) => {
			if (card.workspaceId) {
				unarchiveWorkspaces([card.workspaceId]);
				return;
			}
			if (!collections.v2KanbanCards.get(card.id)) return;
			collections.v2KanbanCards.update(card.id, (draft) => {
				draft.archivedAt = null;
			});
		},
		[collections, unarchiveWorkspaces],
	);

	// (RECYCLE-BIN) Soft delete is the DEFAULT card "Delete" now — silent,
	// reversible, visual-only (worktree/branch/sessions untouched). Bound cards
	// delegate to the branch's sidebarState (one source of truth via
	// deleteWorkspace); unbound (Queued) cards stamp their own deletedAt. The
	// permanent git-destroy is relocated to "Delete permanently" inside the bin.

	const deleteCard = useCallback(
		(card: KanbanCardRow) => {
			if (card.workspaceId) {
				ensureBoundRow(card.workspaceId);
				deleteWorkspace(card.workspaceId);
				return;
			}
			if (!collections.v2KanbanCards.get(card.id)) return;
			collections.v2KanbanCards.update(card.id, (draft) => {
				draft.deletedAt = Date.now();
				// Clear the other hide states so a re-delete after a restore lands
				// cleanly in the bin with a fresh timestamp (mirrors deleteWorkspace).
				draft.snoozeUntil = null;
				draft.snoozeLaunchId = null;
				draft.archivedAt = null;
			});
		},
		[collections, deleteWorkspace, ensureBoundRow],
	);

	const restoreCard = useCallback(
		(card: KanbanCardRow) => {
			if (card.workspaceId) {
				restoreWorkspace(card.workspaceId);
				return;
			}
			if (!collections.v2KanbanCards.get(card.id)) return;
			collections.v2KanbanCards.update(card.id, (draft) => {
				// Full restore-to-active (mirrors restoreWorkspace): clear every hide
				// state, not just deletedAt, so the card re-enters its column's active
				// list regardless of what it was before deletion.
				draft.deletedAt = null;
				draft.archivedAt = null;
				draft.snoozeUntil = null;
				draft.snoozeLaunchId = null;
				draft.completedAt = null;
				draft.completedContext = null;
			});
		},
		[collections, restoreWorkspace],
	);

	const deletePermanentlyCard = useCallback(
		(card: KanbanCardRow) => {
			// Unbound only — a BOUND card's permanent destroy is the shared branch
			// dialog (the reconcile drops the card once the workspace row is gone).
			if (card.workspaceId) return;
			const current = collections.v2KanbanCards.get(card.id);
			if (!current) return;
			// Guard the bin boundary: only the in-bin permanent destroy can hard-remove
			// a row. A non-deleted card reaching here (stale menu/race) must NOT be
			// silently nuked — its soft-delete is the only path to the bin.
			if (current.deletedAt == null) return;
			collections.v2KanbanCards.delete(card.id);
		},
		[collections],
	);

	// (KANBAN COMPLETED) Card transaction FIRST, sidebar second — each update is
	// its own localStorage flush, and the reconcile's heal rules converge toward
	// the CARD's column, so a crash between the two transactions self-repairs in
	// the direction the user dragged.

	const completeCard = useCallback(
		(card: KanbanCardRow) => {
			if (!collections.v2KanbanCards.get(card.id)) return;
			const completedAt = Date.now();
			if (card.workspaceId) {
				const ws = hostWorkspaceById.get(card.workspaceId);
				// Main workspaces are never completable (canDropCard rejects the
				// drop; this keeps any other caller honest).
				if (ws?.type === "main") return;
				const projectName = ws
					? (projectNameById.get(ws.projectId) ?? null)
					: null;
				collections.v2KanbanCards.update(card.id, (draft) => {
					draft.columnId = KANBAN_COMPLETED_COLUMN_ID;
					draft.tabOrder = 0; // unused there — Completed is date-sorted
					draft.deadlineTabOrder = null;
					draft.completedAt = completedAt;
					if (ws) {
						// Snapshot title + context NOW so the record stays meaningful
						// if the branch is later deleted (frozen record).
						draft.title = deriveCardTitle(ws);
						draft.completedContext = buildCompletedContext(
							projectName,
							ws.branch,
						);
					}
				});
				if (ws) {
					ensureBoundRow(card.workspaceId);
					completeWorkspace(card.workspaceId, completedAt);
				}
				return;
			}
			collections.v2KanbanCards.update(card.id, (draft) => {
				draft.columnId = KANBAN_COMPLETED_COLUMN_ID;
				draft.tabOrder = 0;
				draft.deadlineTabOrder = null;
				draft.completedAt = completedAt;
				// Completing is terminal for the hide states — a completed task is
				// neither snoozed nor archived.
				draft.snoozeUntil = null;
				draft.snoozeLaunchId = null;
				draft.archivedAt = null;
			});
		},
		[
			collections,
			completeWorkspace,
			ensureBoundRow,
			projectNameById,
			hostWorkspaceById,
		],
	);

	const uncompleteCard = useCallback(
		(card: KanbanCardRow, toColumnId: string) => {
			if (!collections.v2KanbanCards.get(card.id)) return;
			const tabOrder = getNextTabOrder(columnCards(toColumnId));
			collections.v2KanbanCards.update(card.id, (draft) => {
				draft.columnId = toColumnId;
				draft.tabOrder = tabOrder;
				draft.deadlineTabOrder = null;
				draft.completedAt = null;
				draft.completedContext = null;
			});
			if (card.workspaceId) uncompleteWorkspace(card.workspaceId);
		},
		[collections, columnCards, uncompleteWorkspace],
	);

	const updateCompletedDate = useCallback(
		(cardId: string, completedAt: number) => {
			if (!collections.v2KanbanCards.get(cardId)) return;
			collections.v2KanbanCards.update(cardId, (draft) => {
				draft.completedAt = completedAt;
			});
		},
		[collections],
	);

	const deleteCompletedCard = useCallback(
		(cardId: string) => {
			const card = collections.v2KanbanCards.get(cardId);
			if (!card || card.columnId !== KANBAN_COMPLETED_COLUMN_ID) return;
			// A bound card with a LIVE branch deletes via the branch dialog (and
			// then survives frozen) — this action is only for records with no
			// branch left: unbound tasks and frozen records.
			if (card.workspaceId && hostWorkspaceById.has(card.workspaceId)) {
				return;
			}
			collections.v2KanbanCards.delete(cardId);
		},
		[collections, hostWorkspaceById],
	);

	const setColumnCompletedFilter = useCallback<
		UseKanbanActionsResult["setColumnCompletedFilter"]
	>(
		(columnId, filter) => {
			const column = collections.v2KanbanColumns.get(columnId);
			if (!column || !column.isCompleted) return;
			collections.v2KanbanColumns.update(columnId, (draft) => {
				draft.completedFilter = filter.kind;
				if (filter.kind === "custom") {
					// The range calendar always yields from <= to; normalise anyway so
					// a stored range can never be inverted.
					draft.completedFilterFrom = Math.min(filter.fromMs, filter.toMs);
					draft.completedFilterTo = Math.max(filter.fromMs, filter.toMs);
				} else {
					draft.completedFilterFrom = null;
					draft.completedFilterTo = null;
				}
			});
		},
		[collections],
	);

	return useMemo(
		() => ({
			createQueuedCard,
			updateCard,
			canDropCard,
			applyCardOrder,
			applyDeadlineTieOrder,
			moveCardToColumn,
			completePromote,
			restoreQueuedCard,
			rebindPromotedCard,
			addColumn,
			renameColumn,
			deleteColumn,
			reorderColumns,
			setColumnSortMode,
			setColumnSectionFlag,
			snoozeCard,
			unsnoozeCard,
			archiveCard,
			unarchiveCard,
			deleteCard,
			restoreCard,
			deletePermanentlyCard,
			completeCard,
			uncompleteCard,
			updateCompletedDate,
			deleteCompletedCard,
			setColumnCompletedFilter,
		}),
		[
			createQueuedCard,
			updateCard,
			canDropCard,
			applyCardOrder,
			applyDeadlineTieOrder,
			moveCardToColumn,
			completePromote,
			restoreQueuedCard,
			rebindPromotedCard,
			addColumn,
			renameColumn,
			deleteColumn,
			reorderColumns,
			setColumnSortMode,
			setColumnSectionFlag,
			snoozeCard,
			unsnoozeCard,
			archiveCard,
			unarchiveCard,
			deleteCard,
			restoreCard,
			deletePermanentlyCard,
			completeCard,
			uncompleteCard,
			updateCompletedDate,
			deleteCompletedCard,
			setColumnCompletedFilter,
		],
	);
}
