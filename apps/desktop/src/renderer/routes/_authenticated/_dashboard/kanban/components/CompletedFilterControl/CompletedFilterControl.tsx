import { Button } from "@superset/ui/button";
import { Calendar } from "@superset/ui/calendar";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@superset/ui/dropdown-menu";
import { Popover, PopoverAnchor, PopoverContent } from "@superset/ui/popover";
import { cn } from "@superset/ui/utils";
import type * as React from "react";
import { useState } from "react";
import { LuCheck, LuListFilter } from "react-icons/lu";
import type { KanbanColumnRow } from "renderer/routes/_authenticated/providers/CollectionsProvider/dashboardSidebarLocal";
import type { UseKanbanActionsResult } from "../../hooks/useKanbanActions";
import { dateToDeadline, formatDeadline } from "../../utils/deadlineUrgency";

interface CompletedFilterControlProps {
	column: KanbanColumnRow;
	actions: UseKanbanActionsResult;
}

/**
 * (KANBAN COMPLETED) The Completed column's date filter: All / Last month
 * (previous calendar month) / Custom range. The choice persists on the column
 * row (device-local, like every board preference) so a report range survives
 * restarts. Custom opens a range calendar; the filter applies live as the
 * range is picked (first click = single day, second click extends).
 */
export function CompletedFilterControl({
	column,
	actions,
}: CompletedFilterControlProps) {
	const [rangeOpen, setRangeOpen] = useState(false);
	const stop = (e: React.SyntheticEvent) => e.stopPropagation();

	const isCustom = column.completedFilter === "custom";
	const selectedRange =
		isCustom && column.completedFilterFrom != null
			? {
					from: new Date(column.completedFilterFrom),
					to:
						column.completedFilterTo != null
							? new Date(column.completedFilterTo)
							: undefined,
				}
			: undefined;

	const label =
		column.completedFilter === "last-month"
			? "Last month"
			: isCustom
				? `${formatDeadline(column.completedFilterFrom)} – ${formatDeadline(
						column.completedFilterTo,
					)}`
				: null;

	return (
		<Popover open={rangeOpen} onOpenChange={setRangeOpen}>
			<PopoverAnchor asChild>
				<span className="flex min-w-0 items-center">
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<button
								type="button"
								aria-label="Filter by completed date"
								title="Filter by completed date"
								className={cn(
									"flex min-w-0 items-center gap-1 rounded p-0.5 hover:bg-accent",
									column.completedFilter === "all"
										? "text-muted-foreground"
										: "text-foreground",
								)}
							>
								<LuListFilter className="size-4 shrink-0" />
								{label ? (
									<span className="max-w-[110px] truncate text-[11px]">
										{label}
									</span>
								) : null}
							</button>
						</DropdownMenuTrigger>
						<DropdownMenuContent
							align="end"
							onCloseAutoFocus={(e) => e.preventDefault()}
						>
							<DropdownMenuItem
								onSelect={() =>
									actions.setColumnCompletedFilter(column.id, { kind: "all" })
								}
							>
								All
								{column.completedFilter === "all" ? (
									<LuCheck className="ml-auto size-4" />
								) : null}
							</DropdownMenuItem>
							<DropdownMenuItem
								onSelect={() =>
									actions.setColumnCompletedFilter(column.id, {
										kind: "last-month",
									})
								}
							>
								Last month
								{column.completedFilter === "last-month" ? (
									<LuCheck className="ml-auto size-4" />
								) : null}
							</DropdownMenuItem>
							<DropdownMenuItem onSelect={() => setRangeOpen(true)}>
								Custom range…
								{isCustom ? <LuCheck className="ml-auto size-4" /> : null}
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				</span>
			</PopoverAnchor>
			{rangeOpen ? (
				<PopoverContent
					className="w-auto p-0"
					align="end"
					onClick={stop}
					onDoubleClick={stop}
					onPointerDown={stop}
					onContextMenu={stop}
				>
					<Calendar
						mode="range"
						selected={selectedRange}
						defaultMonth={selectedRange?.from ?? new Date()}
						onSelect={(range) => {
							if (!range?.from) return;
							actions.setColumnCompletedFilter(column.id, {
								kind: "custom",
								fromMs: dateToDeadline(range.from),
								toMs: dateToDeadline(range.to ?? range.from),
							});
						}}
					/>
					<div className="flex items-center justify-end gap-2 border-t border-border/60 px-2 py-1.5">
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onClick={() => setRangeOpen(false)}
						>
							Done
						</Button>
					</div>
				</PopoverContent>
			) : null}
		</Popover>
	);
}
