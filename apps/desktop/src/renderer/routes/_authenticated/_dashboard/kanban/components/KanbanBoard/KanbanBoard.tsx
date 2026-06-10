import {
	DndContext,
	type DragEndEvent,
	DragOverlay,
	type DragStartEvent,
	MouseSensor,
	TouchSensor,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import { arrayMove } from "@dnd-kit/sortable";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";
import { LuPlus } from "react-icons/lu";
import type { KanbanCardRow } from "renderer/routes/_authenticated/providers/CollectionsProvider/dashboardSidebarLocal";
import { useKanbanActions } from "../../hooks/useKanbanActions";
import { useKanbanData } from "../../hooks/useKanbanData";
import type { KanbanCardView } from "../../types";
import { KanbanCard } from "../KanbanCard";
import { KanbanColumn } from "../KanbanColumn";
import { PromoteCardDialog } from "../PromoteCardDialog";
import { QueuedCardModal } from "../QueuedCardModal";

interface PromoteState {
	queuedCardId: string;
	targetColumnId: string;
}

export function KanbanBoard() {
	const { isReady, columns, now } = useKanbanData();
	const actions = useKanbanActions();
	const navigate = useNavigate();

	const [activeCard, setActiveCard] = useState<KanbanCardView | null>(null);
	const [modalCardId, setModalCardId] = useState<string | null>(null);
	const [promoteState, setPromoteState] = useState<PromoteState | null>(null);

	// MouseSensor (distance 8) + TouchSensor only. No KeyboardSensor — the card's
	// Enter/Space activation handler would shadow dnd-kit's keyboard drag start,
	// so keyboard DnD is intentionally not wired (cards stay keyboard-activatable).
	const sensors = useSensors(
		useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
		useSensor(TouchSensor, {
			activationConstraint: { delay: 200, tolerance: 5 },
		}),
	);

	const customColumnIds = useMemo(
		() =>
			columns.filter((c) => !c.column.isQueue).map((c) => c.column.id),
		[columns],
	);

	const findCardView = useCallback(
		(cardId: string): KanbanCardView | null => {
			for (const col of columns) {
				const hit =
					col.active.find((v) => v.card.id === cardId) ??
					col.snoozed.find((v) => v.card.id === cardId) ??
					col.archived.find((v) => v.card.id === cardId);
				if (hit) return hit;
			}
			return null;
		},
		[columns],
	);

	const onActivate = useCallback(
		(view: KanbanCardView) => {
			if (view.workspace) {
				navigate({ to: "/kanban", search: { cardId: view.workspace.id } });
			} else {
				setModalCardId(view.card.id);
			}
		},
		[navigate],
	);

	const handleDragStart = useCallback(
		(event: DragStartEvent) => {
			setActiveCard(findCardView(event.active.id as string));
		},
		[findCardView],
	);

	const handleDragEnd = useCallback(
		(event: DragEndEvent) => {
			setActiveCard(null);
			const { active, over } = event;
			if (!over) return;
			const activeCardRow = active.data.current?.card as
				| KanbanCardRow
				| undefined;
			if (!activeCardRow) return;

			const overData = over.data.current;
			let targetColumnId: string | undefined;
			if (overData?.type === "column") {
				targetColumnId = overData.columnId as string;
			} else if (overData?.type === "card") {
				targetColumnId = (overData.card as KanbanCardRow).columnId;
			}
			if (!targetColumnId) return;

			const kind = actions.canDropCard(activeCardRow, targetColumnId);
			if (kind === "reject") return;
			if (kind === "promote") {
				setPromoteState({ queuedCardId: activeCardRow.id, targetColumnId });
				return;
			}

			const targetCol = columns.find((c) => c.column.id === targetColumnId);
			if (!targetCol) return;
			const activeId = activeCardRow.id;
			const overCardId =
				overData?.type === "card"
					? (overData.card as KanbanCardRow).id
					: undefined;

			// (DEADLINE-TIE-ORDER) A deadline-sorted column shows cards date-grouped.
			// Cross-column drops just move the card in (its deadline decides where it
			// lands; never ordered there → bottom of its group). An intra-column drop
			// reorders WITHIN the dragged card's tie group only (same due day, or the
			// no-deadline tail) and persists to deadlineTabOrder — the manual tabOrder
			// is never renumbered from deadline mode (it would clobber the preserved
			// manual order). Dropping onto a card in a DIFFERENT group is a no-op:
			// the date decides cross-group placement, not the drag.
			if (targetCol.column.sortMode === "deadline") {
				if (activeCardRow.columnId !== targetColumnId) {
					actions.moveCardToColumn(activeId, targetColumnId);
					return;
				}
				if (!overCardId || overCardId === activeId) return;
				const activeView = targetCol.active.find(
					(v) => v.card.id === activeId,
				);
				const overView = targetCol.active.find(
					(v) => v.card.id === overCardId,
				);
				if (!activeView || !overView) return;
				const groupDeadline = activeView.card.deadline ?? null;
				if ((overView.card.deadline ?? null) !== groupDeadline) return;
				const groupIds = targetCol.active
					.filter((v) => (v.card.deadline ?? null) === groupDeadline)
					.map((v) => v.card.id);
				const oldIndex = groupIds.indexOf(activeId);
				const newIndex = groupIds.indexOf(overCardId);
				if (oldIndex === -1 || newIndex === -1) return;
				actions.applyDeadlineTieOrder(
					arrayMove(groupIds, oldIndex, newIndex),
				);
				return;
			}

			const currentIds = targetCol.active.map((v) => v.card.id);
			if (activeCardRow.columnId === targetColumnId) {
				if (activeId === overCardId) return; // dropped on itself
				const oldIndex = currentIds.indexOf(activeId);
				if (oldIndex === -1) return;
				const newIndex = overCardId
					? currentIds.indexOf(overCardId)
					: currentIds.length - 1;
				if (newIndex === -1) return;
				actions.applyCardOrder(
					targetColumnId,
					arrayMove(currentIds, oldIndex, newIndex),
				);
			} else {
				const targetIds = currentIds.filter((id) => id !== activeId);
				let insertIndex = targetIds.length;
				if (overCardId) {
					const idx = targetIds.indexOf(overCardId);
					if (idx !== -1) insertIndex = idx;
				}
				targetIds.splice(insertIndex, 0, activeId);
				actions.applyCardOrder(targetColumnId, targetIds);
			}
		},
		[actions, columns],
	);

	const handleAddQueuedCard = useCallback(() => {
		const id = actions.createQueuedCard();
		setModalCardId(id);
	}, [actions]);

	if (!isReady && columns.length === 0) {
		return (
			<div className="flex h-full w-full items-center justify-center text-sm text-muted-foreground">
				Loading board…
			</div>
		);
	}

	return (
		<DndContext
			sensors={sensors}
			onDragStart={handleDragStart}
			onDragEnd={handleDragEnd}
			onDragCancel={() => setActiveCard(null)}
		>
			<div className="flex min-h-0 min-w-0 flex-1 gap-2 overflow-x-auto overflow-y-hidden px-4 py-3">
				{columns.map((col) => (
					<KanbanColumn
						key={col.column.id}
						view={col}
						actions={actions}
						now={now}
						onActivate={onActivate}
						onAddQueuedCard={handleAddQueuedCard}
						customColumnIds={customColumnIds}
					/>
				))}
				<button
					type="button"
					onClick={() => actions.addColumn()}
					className="flex h-9 w-[160px] shrink-0 items-center gap-1.5 rounded-md border border-dashed border-border px-3 text-sm text-muted-foreground transition-colors hover:bg-accent/30 hover:text-foreground"
				>
					<LuPlus className="size-4" /> Add column
				</button>
			</div>

			<DragOverlay dropAnimation={null}>
				{activeCard ? (
					<div className="w-[268px]">
						<KanbanCard
							view={activeCard}
							actions={actions}
							now={now}
							onActivate={() => {}}
							overlay
						/>
					</div>
				) : null}
			</DragOverlay>

			<QueuedCardModal
				cardId={modalCardId}
				onClose={() => setModalCardId(null)}
			/>
			<PromoteCardDialog
				state={promoteState}
				actions={actions}
				onClose={() => setPromoteState(null)}
			/>
		</DndContext>
	);
}
