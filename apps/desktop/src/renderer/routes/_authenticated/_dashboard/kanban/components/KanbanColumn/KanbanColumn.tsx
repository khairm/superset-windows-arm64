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
import { useState } from "react";
import {
	LuArrowDownWideNarrow,
	LuArrowLeft,
	LuArrowRight,
	LuEllipsis,
	LuListOrdered,
	LuPlus,
} from "react-icons/lu";
import type { KanbanCardView, KanbanColumnView } from "../../types";
import type { UseKanbanActionsResult } from "../../hooks/useKanbanActions";
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
	const { column, active, snoozed, archived } = view;
	const { setNodeRef, isOver } = useDroppable({
		id: `kanban-col-${column.id}`,
		data: { type: "column", columnId: column.id },
	});
	const [renaming, setRenaming] = useState(false);
	const [nameDraft, setNameDraft] = useState(column.name);

	const isQueue = column.isQueue;
	const index = customColumnIds.indexOf(column.id);
	const canMoveLeft = !isQueue && index > 0;
	const canMoveRight = !isQueue && index >= 0 && index < customColumnIds.length - 1;

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
						// biome-ignore lint/a11y/noAutofocus: inline rename
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
						{!isQueue ? (
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
				<SortableContext items={activeIds} strategy={verticalListSortingStrategy}>
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
						{isQueue ? "No queued tasks" : "Drop a card here"}
					</div>
				) : null}

				{/* Snoozed / Archived sections always render their (n) header so the
				    user can reveal/collapse them per the spec. */}
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
			</div>
		</div>
	);
}
