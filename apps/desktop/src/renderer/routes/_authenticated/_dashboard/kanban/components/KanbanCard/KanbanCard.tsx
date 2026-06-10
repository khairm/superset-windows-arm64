import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuSub,
	ContextMenuSubContent,
	ContextMenuSubTrigger,
	ContextMenuTrigger,
} from "@superset/ui/context-menu";
import { Input } from "@superset/ui/input";
import { cn } from "@superset/ui/utils";
import { useRouterState } from "@tanstack/react-router";
import { useState } from "react";
import { DashboardSidebarDeleteDialog } from "renderer/routes/_authenticated/_dashboard/components/DashboardSidebar/components/DashboardSidebarDeleteDialog";
import {
	computeSnoozeUntil,
	SNOOZE_PRESET_OPTIONS,
} from "renderer/routes/_authenticated/providers/CollectionsProvider/dashboardSidebarLocal";
import {
	getStatusTooltip,
	StatusIndicator,
} from "renderer/screens/main/components/StatusIndicator";
import { useV2WorkspaceDisplayStatus } from "renderer/stores/v2-notifications";
import type { UseKanbanActionsResult } from "../../hooks/useKanbanActions";
import type { KanbanCardView } from "../../types";
import { DeadlinePickerPopover } from "../DeadlinePickerPopover";
import {
	formatDeadline,
	getDeadlineUrgency,
} from "../../utils/deadlineUrgency";

interface KanbanCardProps {
	view: KanbanCardView;
	actions: UseKanbanActionsResult;
	now: number;
	onActivate: (view: KanbanCardView) => void;
	/** Render-only ghost in the DragOverlay (no sortable wiring, no menus). */
	overlay?: boolean;
	/** Disable drag (Snoozed / Archived cards, which live outside the sortable). */
	disableDrag?: boolean;
}

export function KanbanCard({
	view,
	actions,
	now,
	onActivate,
	overlay,
	disableDrag,
}: KanbanCardProps) {
	const { card, workspace, projectName } = view;
	// A repo's main workspace can't be snoozed/archived (the sidebar gates those
	// off main; an archived main would bucket to "hidden" and vanish from the
	// board with no restore path).
	const isMain = workspace?.type === "main";
	const status = useV2WorkspaceDisplayStatus(workspace?.id ?? "");
	const [editing, setEditing] = useState<"title" | "deadline" | null>(null);
	// Seed from the resolved (live) title, not the stored card.title — inline edit
	// is only enabled for unbound cards (where they're equal), but this keeps the
	// draft on the live value if that gate ever changes.
	const [titleDraft, setTitleDraft] = useState(view.title);
	const [deleteOpen, setDeleteOpen] = useState(false);

	const {
		attributes,
		listeners,
		setNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({
		id: card.id,
		data: { type: "card", card },
		disabled: overlay || disableDrag,
	});

	const style = {
		transform: CSS.Transform.toString(transform),
		transition,
	};

	// The card whose workspace is OPEN in the collapse-split mirrors the
	// sidebar's active-row highlight, derived from the SAME route source
	// (?cardId — the open workspaceId) so the two surfaces can never disagree.
	const openWorkspaceId = useRouterState({
		select: (s) => (s.location.search as { cardId?: string }).cardId,
	});
	const isOpen = workspace != null && workspace.id === openWorkspaceId;

	const urgency = getDeadlineUrgency(card.deadline, now);
	const subtitle =
		workspace && projectName
			? `${projectName} / ${workspace.branch}`
			: workspace
				? workspace.branch
				: null;

	const commitTitle = () => {
		actions.updateCard(card.id, { title: titleDraft });
		setEditing(null);
	};

	const stop = (e: React.SyntheticEvent) => e.stopPropagation();

	return (
		<ContextMenu>
			<ContextMenuTrigger asChild>
				{/* biome-ignore lint/a11y/useSemanticElements: dnd-kit requires a div */}
				<div
					ref={setNodeRef}
					style={style}
					{...attributes}
					{...listeners}
					role="button"
					tabIndex={0}
					className={cn(
						"group relative rounded-md border border-border/60 bg-card px-3 py-2.5 transition-colors hover:bg-accent/30",
						!overlay && !disableDrag && "cursor-grab active:cursor-grabbing",
						isDragging && "opacity-40",
						overlay && "cursor-grabbing border-border shadow-xl",
						// Same visual language as the sidebar's active row (bg-muted +
						// foreground accent edge).
						isOpen && "border-l-2 border-l-foreground/70 bg-muted",
					)}
					onClick={() => {
						if (editing) return;
						// Click opens BOUND cards (collapse-split). A queued card's
						// editor opens via right-click → Edit card only — a click
						// anywhere on the card must not pop the modal.
						if (!workspace) return;
						onActivate(view);
					}}
					onContextMenu={(e) => {
						// No action menu mid-inline-edit (the menu's auto-focus would
						// blur-commit the draft) or mid-drag (touch long-press can
						// fire both sensors). preventDefault stops the Radix trigger
						// (it composes our handler first and checks defaultPrevented).
						if (editing || isDragging) e.preventDefault();
					}}
					onKeyDown={(e) => {
						if (editing) return;
						// Same contract as click: activation opens BOUND cards only —
						// a queued card's editor is right-click → Edit card.
						if (!workspace) return;
						if (e.key === "Enter" || e.key === " ") {
							e.preventDefault();
							onActivate(view);
						}
					}}
				>
					<div className="flex items-start gap-2">
						{status ? (
							<span
								title={getStatusTooltip(status)}
								className="mt-1 shrink-0"
								onPointerDown={stop}
							>
								<StatusIndicator status={status} />
							</span>
						) : null}
						<div className="min-w-0 flex-1">
							{editing === "title" ? (
								<Input
									autoFocus
									value={titleDraft}
									onChange={(e) => setTitleDraft(e.target.value)}
									onBlur={commitTitle}
									onKeyDown={(e) => {
										if (e.key === "Enter") commitTitle();
										if (e.key === "Escape") {
											setTitleDraft(view.title);
											setEditing(null);
										}
									}}
									onClick={stop}
									onPointerDown={stop}
									// Right-click inside the edit field gets the NATIVE input
									// menu (paste etc.), never the card actions menu.
									onContextMenu={stop}
									className="h-6 px-1 py-0 text-sm"
								/>
							) : (
								// biome-ignore lint/a11y/useKeyWithClickEvents: click-only stopPropagation guard; the element is not focusable (keyboard activation lands on the card root)
								<p
									className="line-clamp-2 text-sm leading-snug font-medium"
									onClick={stop}
									// Only UNBOUND (Queued) cards have an editable title. A bound
									// card's title IS the branch name (view.title, derived live) —
									// rename the branch to change it, so it can't diverge.
									onDoubleClick={
										workspace
											? undefined
											: (e) => {
													stop(e);
													setTitleDraft(view.title);
													setEditing("title");
												}
									}
								>
									{view.title || "Untitled"}
								</p>
							)}
							{subtitle ? (
								<span className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground">
									{subtitle}
								</span>
							) : null}
							{card.deadline != null ? (
								// Double-click opens the shared calendar popover (the old
								// inline <input type="date"> typed "2" into year 1902).
								<DeadlinePickerPopover
									value={card.deadline}
									onChange={(deadline) =>
										actions.updateCard(card.id, { deadline })
									}
									open={editing === "deadline"}
									onOpenChange={(open) =>
										setEditing(open ? "deadline" : null)
									}
								>
									{/* biome-ignore lint/a11y/useKeyWithClickEvents: click-only stopPropagation guard; the element is not focusable (keyboard activation lands on the card root) */}
									{/* biome-ignore lint/a11y/noStaticElementInteractions: double-click inline-edit affordance on a non-focusable label */}
									<span
										onClick={stop}
										onDoubleClick={(e) => {
											stop(e);
											setEditing("deadline");
										}}
										className={cn(
											"mt-1 block text-[11px]",
											urgency === "overdue" && "font-medium text-red-500",
											urgency === "due-today" && "font-medium text-yellow-500",
											urgency === "upcoming" && "text-muted-foreground",
										)}
									>
										{urgency === "overdue"
											? `Overdue · ${formatDeadline(card.deadline)}`
											: urgency === "due-today"
												? "Due today"
												: `Due ${formatDeadline(card.deadline)}`}
									</span>
								</DeadlinePickerPopover>
							) : null}
						</div>
					</div>
				</div>
			</ContextMenuTrigger>

			{/* All card actions live in the right-click menu (no 3-dots button):
			    Edit card (queued only), Snooze/Archive, Delete. Main workspaces
			    have no actions; the drag-overlay ghost gets no menu. */}
			{!overlay && (!isMain || !workspace) ? (
				<ContextMenuContent onCloseAutoFocus={(e) => e.preventDefault()}>
					{!workspace ? (
						<>
							<ContextMenuItem onSelect={() => onActivate(view)}>
								Edit card…
							</ContextMenuItem>
							<ContextMenuSeparator />
						</>
					) : null}
					{view.bucket === "snoozed" ? (
						<ContextMenuItem onSelect={() => actions.unsnoozeCard(card)}>
							Unsnooze
						</ContextMenuItem>
					) : (
						<ContextMenuSub>
							<ContextMenuSubTrigger>Snooze</ContextMenuSubTrigger>
							<ContextMenuSubContent>
								{SNOOZE_PRESET_OPTIONS.map((opt) => (
									<ContextMenuItem
										key={opt.id}
										onSelect={() =>
											actions.snoozeCard(
												card,
												opt.duration.kind === "next-launch"
													? "next-launch"
													: computeSnoozeUntil(opt.duration),
											)
										}
									>
										{opt.label}
									</ContextMenuItem>
								))}
							</ContextMenuSubContent>
						</ContextMenuSub>
					)}
					{view.bucket === "archived" ? (
						<ContextMenuItem onSelect={() => actions.unarchiveCard(card)}>
							Unarchive
						</ContextMenuItem>
					) : (
						<ContextMenuItem onSelect={() => actions.archiveCard(card)}>
							Archive
						</ContextMenuItem>
					)}
					<ContextMenuSeparator />
					{workspace ? (
						<ContextMenuItem
							variant="destructive"
							onSelect={() => setDeleteOpen(true)}
						>
							Delete branch…
						</ContextMenuItem>
					) : (
						<ContextMenuItem
							variant="destructive"
							onSelect={() => actions.deleteQueuedCard(card.id)}
						>
							Delete task
						</ContextMenuItem>
					)}
				</ContextMenuContent>
			) : null}

			{workspace && !isMain ? (
				<DashboardSidebarDeleteDialog
					workspaceId={workspace.id}
					workspaceName={workspace.name}
					open={deleteOpen}
					onOpenChange={setDeleteOpen}
				/>
			) : null}
		</ContextMenu>
	);
}
