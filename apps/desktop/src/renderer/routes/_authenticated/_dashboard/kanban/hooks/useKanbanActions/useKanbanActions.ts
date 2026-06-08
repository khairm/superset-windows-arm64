import { useCallback, useMemo } from "react";
import { useDashboardSidebarState } from "renderer/routes/_authenticated/hooks/useDashboardSidebarState";
import { useCollections } from "renderer/routes/_authenticated/providers/CollectionsProvider";
import {
	APP_LAUNCH_ID,
	getNextTabOrder,
	type KanbanCardRow,
	KANBAN_QUEUE_COLUMN_ID,
	kanbanBoundCardId,
} from "renderer/routes/_authenticated/providers/CollectionsProvider/dashboardSidebarLocal";
import { getColumnDeleteTarget } from "../../utils/computeColumnDeleteTargets";

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
	deleteQueuedCard: (cardId: string) => void;
	canDropCard: (card: KanbanCardRow, toColumnId: string) => CardDropKind;
	applyCardOrder: (columnId: string, orderedCardIds: string[]) => void;
	moveCardToColumn: (cardId: string, toColumnId: string) => void;
	completePromote: (
		queuedCardId: string,
		workspaceId: string,
		toColumnId: string,
	) => void;
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
			| "archivedCollapsed",
		value: boolean,
	) => void;
	snoozeCard: (card: KanbanCardRow, until: number | "next-launch") => void;
	unsnoozeCard: (card: KanbanCardRow) => void;
	archiveCard: (card: KanbanCardRow) => void;
	unarchiveCard: (card: KanbanCardRow) => void;
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
		snoozeWorkspace,
		unsnoozeWorkspace,
		unarchiveWorkspaces,
		ensureWorkspaceInSidebar,
	} = useDashboardSidebarState();

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
				.filter((c) => !c.isQueue && c.id !== KANBAN_QUEUE_COLUMN_ID)
				.sort((a, b) => a.tabOrder - b.tabOrder),
		[collections],
	);

	const ensureBoundRow = useCallback(
		(workspaceId: string) => {
			if (collections.v2WorkspaceLocalState.get(workspaceId)) return;
			const ws = collections.v2Workspaces.get(workspaceId);
			if (ws) ensureWorkspaceInSidebar(workspaceId, ws.projectId);
		},
		[collections, ensureWorkspaceInSidebar],
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
				workspaceId: null,
				snoozeUntil: null,
				snoozeLaunchId: null,
				archivedAt: null,
				createdAt: Date.now(),
			});
			return id;
		},
		[collections, columnCards],
	);

	const updateCard = useCallback<UseKanbanActionsResult["updateCard"]>(
		(cardId, patch) => {
			if (!collections.v2KanbanCards.get(cardId)) return;
			collections.v2KanbanCards.update(cardId, (draft) => {
				if (patch.title !== undefined) draft.title = patch.title;
				if (patch.description !== undefined)
					draft.description = patch.description;
				if (patch.deadline !== undefined) draft.deadline = patch.deadline;
			});
		},
		[collections],
	);

	const deleteQueuedCard = useCallback(
		(cardId: string) => {
			const card = collections.v2KanbanCards.get(cardId);
			if (!card || card.workspaceId) return; // unbound only
			collections.v2KanbanCards.delete(cardId);
		},
		[collections],
	);

	const canDropCard = useCallback<UseKanbanActionsResult["canDropCard"]>(
		(card, toColumnId) => {
			const toQueue = toColumnId === KANBAN_QUEUE_COLUMN_ID;
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
			orderedCardIds.forEach((cardId, index) => {
				if (!collections.v2KanbanCards.get(cardId)) return;
				collections.v2KanbanCards.update(cardId, (draft) => {
					draft.columnId = columnId;
					draft.tabOrder = index + 1;
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
			if (!targetColumn || targetColumn.isQueue) return;
			const tabOrder = getNextTabOrder(columnCards(toColumnId));
			const boundId = kanbanBoundCardId(workspaceId);
			const existing = collections.v2KanbanCards.get(boundId);
			if (existing) {
				// Merge the Queued task metadata into the branch's existing card
				// (non-git main, or a git branch-name collision). One card per branch.
				collections.v2KanbanCards.update(boundId, (draft) => {
					draft.columnId = toColumnId;
					draft.tabOrder = tabOrder;
					if (queued?.title) draft.title = queued.title;
					if (queued?.description != null)
						draft.description = queued.description;
					if (queued?.deadline != null) draft.deadline = queued.deadline;
				});
			} else {
				collections.v2KanbanCards.insert({
					id: boundId,
					columnId: toColumnId,
					tabOrder,
					title: queued?.title || "",
					description: queued?.description ?? null,
					deadline: queued?.deadline ?? null,
					workspaceId,
					snoozeUntil: null,
					snoozeLaunchId: null,
					archivedAt: null,
					createdAt: Date.now(),
				});
			}
			if (queued) collections.v2KanbanCards.delete(queuedCardId);
		},
		[collections, columnCards],
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
				sortMode: "manual",
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

	return useMemo(
		() => ({
			createQueuedCard,
			updateCard,
			deleteQueuedCard,
			canDropCard,
			applyCardOrder,
			moveCardToColumn,
			completePromote,
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
		}),
		[
			createQueuedCard,
			updateCard,
			deleteQueuedCard,
			canDropCard,
			applyCardOrder,
			moveCardToColumn,
			completePromote,
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
		],
	);
}
