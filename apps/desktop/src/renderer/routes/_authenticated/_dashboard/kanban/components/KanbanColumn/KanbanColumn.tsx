import { useDroppable } from "@dnd-kit/core";
import {
	SortableContext,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@superset/ui/dropdown-menu";
import { Input } from "@superset/ui/input";
import { toast } from "@superset/ui/sonner";
import { cn } from "@superset/ui/utils";
import { useMemo, useState } from "react";
import {
	LuArrowDownWideNarrow,
	LuArrowLeft,
	LuArrowRight,
	LuEllipsis,
	LuListOrdered,
	LuPlus,
} from "react-icons/lu";
import type { UseKanbanActionsResult } from "../../hooks/useKanbanActions";
import type { KanbanCardView, KanbanColumnView } from "../../types";
import { CompletedFilterControl } from "../CompletedFilterControl";
import { KanbanCard } from "../KanbanCard";
import { KanbanStateSection } from "../KanbanStateSection";

interface KanbanColumnProps {
	view: KanbanColumnView;
	actions: UseKanbanActionsResult;
	now: number;
	onActivate: (view: KanbanCardView) => void;
	onAddQueuedCard: () => void;
	/** Ordered custom (non-Queue) column ids, for move-left/right + delete. */
	customColumnIds: string[];
}

export function KanbanColumn({
	view,
	actions,
	now,
	onActivate,
	onAddQueuedCard,
	customColumnIds,
}: KanbanColumnProps) {
	const {
		column,
		active,
		snoozed,
		archived,
		recycleBin,
		recycleBinHidden,
		hiddenByFilter,
	} = view;
	const { setNodeRef, isOver } = useDroppable({
		id: `kanban-col-${column.id}`,
		data: { type: "column", columnId: column.id },
	});
	const [renaming, setRenaming] = useState(false);
	const [nameDraft, setNameDraft] = useState(column.name);
	// (RECYCLE-BIN) Local "Show all" override for this column's bin — reveals
	// older-than-retention cards without touching the device-wide setting (mirrors
	// the sidebar bin + Completed-column filter footers).
	const [showAllBin, setShowAllBin] = useState(false);
	// (RECYCLE-BIN) The full bin (recent + older-than-retention), used only when
	// the per-bin "Show all" toggle is active; hoisted so the spread isn't redone
	// every render.
	const allBinCards = useMemo(
		() => [...recycleBin, ...recycleBinHidden],
		[recycleBin, recycleBinHidden],
	);

	const isQueue = column.isQueue;
	// (KANBAN COMPLETED) the fixed final column: no sort toggle (always newest-
	// completed first), no move/delete, a completed-date filter instead, and no
	// Snoozed/Archived sections (completing clears those states).
	const isCompleted = column.isCompleted;
	const index = customColumnIds.indexOf(column.id);
	const canMoveLeft = !isQueue && index > 0;
	const canMoveRight =
		!isQueue && index >= 0 && index < customColumnIds.length - 1;

	const move = (dir: -1 | 1) => {
		const next = [...customColumnIds];
		const j = index + dir;
		if (j < 0 || j >= next.length) return;
		[next[index], next[j]] = [next[j], next[index]];
		actions.reorderColumns(next);
	};

	const commitRename = () => {
		const name = nameDraft.trim();
		if (name) actions.renameColumn(column.id, name);
		setRenaming(false);
	};

	const handleDelete = () => {
		const result = actions.deleteColumn(column.id);
		if (!result.ok) toast.error(result.reason ?? "Cannot delete this column.");
	};

	const activeIds = active.map((v) => v.card.id);

	return (
		<div className="flex w-[280px] min-w-[280px] shrink-0 flex-col">
			<div className="mb-1 flex items-center gap-1.5 px-1 py-1">
				{renaming ? (
					<Input
						autoFocus
						value={nameDraft}
						onChange={(e) => setNameDraft(e.target.value)}
						onBlur={commitRename}
						onKeyDown={(e) => {
							if (e.key === "Enter") commitRename();
							if (e.key === "Escape") {
								setNameDraft(column.name);
								setRenaming(false);
							}
						}}
						className="h-6 flex-1 px-1 py-0 text-sm"
					/>
				) : (
					// biome-ignore lint/a11y/noStaticElementInteractions: inline rename affordance
					<span
						className="flex-1 truncate text-sm font-medium"
						onDoubleClick={() => {
							setNameDraft(column.name);
							setRenaming(true);
						}}
					>
						{column.name || (isQueue ? "Queued" : "Column")}
					</span>
				)}
				<span className="text-xs tabular-nums text-muted-foreground">
					{active.length}
				</span>
				{isQueue ? (
					<button
						type="button"
						aria-label="Add task"
						onClick={onAddQueuedCard}
						className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
					>
						<LuPlus className="size-4" />
					</button>
				) : null}
				{isCompleted ? (
					<CompletedFilterControl column={column} actions={actions} />
				) : (
					<button
						type="button"
						aria-label="Toggle sort"
						title={
							column.sortMode === "deadline"
								? "Sorted by deadline (click for manual)"
								: "Manual order (click to sort by deadline)"
						}
						onClick={() =>
							actions.setColumnSortMode(
								column.id,
								column.sortMode === "deadline" ? "manual" : "deadline",
							)
						}
						className={cn(
							"rounded p-0.5 hover:bg-accent",
							column.sortMode === "deadline"
								? "text-foreground"
								: "text-muted-foreground",
						)}
					>
						{column.sortMode === "deadline" ? (
							<LuArrowDownWideNarrow className="size-4" />
						) : (
							<LuListOrdered className="size-4" />
						)}
					</button>
				)}
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<button
							type="button"
							aria-label="Column actions"
							className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
						>
							<LuEllipsis className="size-4" />
						</button>
					</DropdownMenuTrigger>
					<DropdownMenuContent
						align="end"
						onCloseAutoFocus={(e) => e.preventDefault()}
					>
						<DropdownMenuItem
							onSelect={() => {
								setNameDraft(column.name);
								setRenaming(true);
							}}
						>
							Rename
						</DropdownMenuItem>
						{/* (RECYCLE-BIN) Reveal/hide this column's soft-delete section,
						    mirroring the sidebar project's "Show Recycle Bin" toggle. The
						    Completed column gets this too — useKanbanData can bucket a
						    completed card as "deleted", and without the toggle + section it
						    would be invisible and unrecoverable. */}
						<DropdownMenuItem
							onSelect={() =>
								actions.setColumnSectionFlag(
									column.id,
									"showRecycleBin",
									!column.showRecycleBin,
								)
							}
						>
							{column.showRecycleBin ? "Hide Recycle Bin" : "Show Recycle Bin"}
						</DropdownMenuItem>
						{!isQueue && !isCompleted ? (
							<>
								<DropdownMenuItem
									disabled={!canMoveLeft}
									onSelect={() => move(-1)}
								>
									<LuArrowLeft className="size-4" /> Move left
								</DropdownMenuItem>
								<DropdownMenuItem
									disabled={!canMoveRight}
									onSelect={() => move(1)}
								>
									<LuArrowRight className="size-4" /> Move right
								</DropdownMenuItem>
								<DropdownMenuSeparator />
								<DropdownMenuItem variant="destructive" onSelect={handleDelete}>
									Delete column
								</DropdownMenuItem>
							</>
						) : null}
					</DropdownMenuContent>
				</DropdownMenu>
			</div>

			<div
				ref={setNodeRef}
				className={cn(
					"flex min-h-[60px] flex-1 flex-col gap-1 overflow-y-auto rounded-md p-0.5 transition-colors",
					isOver && "bg-accent/20 ring-1 ring-accent/40",
				)}
			>
				<SortableContext
					items={activeIds}
					strategy={verticalListSortingStrategy}
				>
					{active.map((cardView) => (
						<KanbanCard
							key={cardView.card.id}
							view={cardView}
							actions={actions}
							now={now}
							onActivate={onActivate}
						/>
					))}
				</SortableContext>

				{active.length === 0 ? (
					<div className="px-1 py-2 text-[11px] text-muted-foreground">
						{isQueue
							? "No queued tasks"
							: isCompleted
								? "Drop a card to complete it"
								: "Drop a card here"}
					</div>
				) : null}

				{/* (KANBAN COMPLETED) the date filter can hide cards (incl. a card
				    just dropped, whose fresh stamp falls outside a narrow range) —
				    say so instead of letting it look like the card vanished. */}
				{isCompleted && hiddenByFilter > 0 ? (
					<div className="px-1 py-2 text-[11px] text-muted-foreground">
						{hiddenByFilter} hidden by filter
					</div>
				) : null}

				{/* Snoozed / Archived sections always render their (n) header so the
				    user can reveal/collapse them per the spec. The Completed column
				    has neither state (completing clears both) — but it CAN still have
				    soft-deleted cards, so the Recycle Bin below renders for it too. */}
				{!isCompleted ? (
					<>
						<KanbanStateSection
							title="Snoozed"
							count={snoozed.length}
							collapsed={column.snoozedCollapsed}
							onCollapsedChange={(c) =>
								actions.setColumnSectionFlag(column.id, "snoozedCollapsed", c)
							}
						>
							{snoozed.map((cardView) => (
								<KanbanCard
									key={cardView.card.id}
									view={cardView}
									actions={actions}
									now={now}
									onActivate={onActivate}
									disableDrag
								/>
							))}
						</KanbanStateSection>

						<KanbanStateSection
							title="Archived"
							count={archived.length}
							collapsed={column.archivedCollapsed}
							onCollapsedChange={(c) =>
								actions.setColumnSectionFlag(column.id, "archivedCollapsed", c)
							}
						>
							{archived.map((cardView) => (
								<KanbanCard
									key={cardView.card.id}
									view={cardView}
									actions={actions}
									now={now}
									onActivate={onActivate}
									disableDrag
								/>
							))}
						</KanbanStateSection>
					</>
				) : null}

				{/* (RECYCLE-BIN) Soft-deleted cards — revealed via the column menu
				    ("Show Recycle Bin"), like the sidebar's per-project bin. Rendered
				    for EVERY column, including Completed (useKanbanData can bucket a
				    completed card as "deleted"; without this section it would be
				    invisible/unrecoverable). The retention window hides older-than-N-days
				    cards behind a per-bin "Show all" footer (the same window the sidebar
				    bin applies). */}
				{column.showRecycleBin ? (
					<KanbanStateSection
						title="Recycle Bin"
						count={recycleBin.length + recycleBinHidden.length}
						collapsed={column.recycleBinCollapsed}
						onCollapsedChange={(c) =>
							actions.setColumnSectionFlag(column.id, "recycleBinCollapsed", c)
						}
					>
						{(showAllBin ? allBinCards : recycleBin).map((cardView) => (
							<KanbanCard
								key={cardView.card.id}
								view={cardView}
								actions={actions}
								now={now}
								onActivate={onActivate}
								disableDrag
							/>
						))}
						{recycleBinHidden.length > 0 ? (
							<button
								type="button"
								onClick={() => setShowAllBin((previous) => !previous)}
								className="flex w-full items-center rounded px-1 py-1 text-left text-[10px] text-muted-foreground hover:bg-accent/30"
							>
								{showAllBin
									? "Show recent only"
									: `${recycleBinHidden.length} hidden by filter — Show all`}
							</button>
						) : null}
					</KanbanStateSection>
				) : null}
			</div>
		</div>
	);
}
