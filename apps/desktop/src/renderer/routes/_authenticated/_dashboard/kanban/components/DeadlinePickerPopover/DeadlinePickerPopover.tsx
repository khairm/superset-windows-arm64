import { Button } from "@superset/ui/button";
import { Calendar } from "@superset/ui/calendar";
import { Popover, PopoverAnchor, PopoverContent } from "@superset/ui/popover";
import type * as React from "react";
import { dateToDeadline } from "../../utils/deadlineUrgency";

interface DeadlinePickerPopoverProps {
	/** Stored deadline (local-midnight epoch-ms) or null/undefined for none. */
	value: number | null | undefined;
	onChange: (deadline: number | null) => void;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	align?: "start" | "center" | "end";
	/** Hide the Clear footer action (default true = clearable). A card's
	 * completed date is edit-only — a Completed-column card with no date would
	 * be an invalid state, so that usage passes false. */
	clearable?: boolean;
	/** Anchor element the popover positions against (never gets a click handler). */
	children: React.ReactNode;
}

/**
 * Click-only calendar popover for a card deadline — replaces the native
 * `<input type="date">`, whose segmented year field made typing "2" jump to
 * 1902. There is no typing at all now: with no stored deadline the calendar
 * opens on TODAY (outlined by react-day-picker) so the default pick is one
 * click; Today / Clear are explicit footer shortcuts. Selection commits and
 * closes — an empty deadline is only ever written via Clear.
 *
 * Always CONTROLLED (open/onOpenChange) and anchored via PopoverAnchor, not
 * PopoverTrigger: the card face opens it on double-click only, and a Trigger
 * would add its own single-click toggle. The content stops every pointer
 * event because Radix portals still bubble through the REACT tree — without
 * the guards a click on a day cell would reach the kanban card underneath
 * (onClick → opens the workspace; pointerdown → starts a dnd-kit drag).
 */
export function DeadlinePickerPopover({
	value,
	onChange,
	open,
	onOpenChange,
	align = "start",
	clearable = true,
	children,
}: DeadlinePickerPopoverProps) {
	const selected = value != null ? new Date(value) : undefined;
	const stop = (e: React.SyntheticEvent) => e.stopPropagation();
	const commitAndClose = (deadline: number | null) => {
		onChange(deadline);
		onOpenChange(false);
	};
	return (
		<Popover open={open} onOpenChange={onOpenChange}>
			<PopoverAnchor asChild>{children}</PopoverAnchor>
			{open ? (
				<PopoverContent
					className="w-auto p-0"
					align={align}
					onClick={stop}
					onDoubleClick={stop}
					onPointerDown={stop}
					onContextMenu={stop}
				>
					<Calendar
						mode="single"
						required
						selected={selected}
						defaultMonth={selected ?? new Date()}
						onSelect={(date) => {
							if (!date) return;
							commitAndClose(dateToDeadline(date));
						}}
					/>
					<div className="flex items-center justify-between gap-2 border-t border-border/60 px-2 py-1.5">
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onClick={() => commitAndClose(dateToDeadline(new Date()))}
						>
							Today
						</Button>
						{clearable ? (
							<Button
								type="button"
								variant="ghost"
								size="sm"
								className="text-muted-foreground"
								onClick={() => commitAndClose(null)}
							>
								Clear
							</Button>
						) : null}
					</div>
				</PopoverContent>
			) : null}
		</Popover>
	);
}
