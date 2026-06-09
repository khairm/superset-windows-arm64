import { Button } from "@superset/ui/button";
import { Input } from "@superset/ui/input";
import { Label } from "@superset/ui/label";
import { Textarea } from "@superset/ui/textarea";
import { eq } from "@tanstack/db";
import { useLiveQuery } from "@tanstack/react-db";
import { useEffect, useRef, useState } from "react";
import { useCollections } from "renderer/routes/_authenticated/providers/CollectionsProvider";
import {
	deadlineToInputValue,
	inputValueToDeadline,
} from "../../utils/deadlineUrgency";
import { deriveCardTitle } from "../../utils/deriveCardTitle";

interface KanbanCardDetailsFormProps {
	cardId: string;
	/** Optionally render the repo/branch context line (bound cards). */
	subtitle?: string | null;
	autoFocusTitle?: boolean;
	/**
	 * Modal context: renders a Save button and lets Enter save + close.
	 * Every keystroke is already persisted — this is the explicit dismissal.
	 */
	onRequestClose?: () => void;
}

/**
 * Editor for a card's task details (title / description / deadline). Shared by
 * the Queued-card modal (unbound cards) and the right-panel Card tab (bound
 * cards). Writes through to the local Kanban cards collection on every
 * keystroke — closing the modal mid-edit can never lose input.
 */
export function KanbanCardDetailsForm({
	cardId,
	subtitle,
	autoFocusTitle,
	onRequestClose,
}: KanbanCardDetailsFormProps) {
	const collections = useCollections();
	const { data: [card] = [] } = useLiveQuery(
		(q) =>
			q
				.from({ c: collections.v2KanbanCards })
				.where(({ c }) => eq(c.id, cardId)),
		[collections, cardId],
	);

	// A BOUND card's title is the branch name (derived live, same source as the
	// sidebar — can't diverge), so it's read-only here. Only UNBOUND (Queued)
	// cards have an editable title stored on the card.
	const { data: [boundWorkspace] = [] } = useLiveQuery(
		(q) =>
			q
				.from({ w: collections.v2Workspaces })
				.where(({ w }) => eq(w.id, card?.workspaceId ?? "")),
		[collections, card?.workspaceId],
	);
	const isBound = card?.workspaceId != null;
	const boundTitle = boundWorkspace ? deriveCardTitle(boundWorkspace) : "";

	const [title, setTitle] = useState("");
	const [description, setDescription] = useState("");
	const titleFocused = useRef(false);
	const descFocused = useRef(false);
	// Resync from the row when switching cards, when it first loads, OR when an
	// external edit changes the value — but never while the field is focused, so
	// in-progress typing is never clobbered.
	useEffect(() => {
		if (!titleFocused.current) setTitle(card?.title ?? "");
	}, [cardId, card?.id, card?.title]);
	useEffect(() => {
		if (!descFocused.current) setDescription(card?.description ?? "");
	}, [cardId, card?.id, card?.description]);

	if (!card) {
		return (
			<div className="select-text p-4 text-sm text-muted-foreground">
				This branch isn't on the board yet.
			</div>
		);
	}

	const commit = (patch: {
		title?: string;
		description?: string | null;
		deadline?: number | null;
	}) => {
		if (!collections.v2KanbanCards.get(cardId)) return;
		collections.v2KanbanCards.update(cardId, (draft) => {
			if (patch.title !== undefined) draft.title = patch.title;
			if (patch.description !== undefined) draft.description = patch.description;
			if (patch.deadline !== undefined) draft.deadline = patch.deadline;
		});
	};

	return (
		<div className="flex flex-col gap-4 p-3">
			<div className="flex flex-col gap-1.5">
				<Label htmlFor="kanban-card-title" className="text-xs">
					Title
				</Label>
				{isBound ? (
					<>
						<Input
							id="kanban-card-title"
							value={boundTitle}
							readOnly
							disabled
							className="opacity-100"
						/>
						<span className="text-[11px] text-muted-foreground">
							Follows the branch name — rename the branch to change it.
						</span>
					</>
				) : (
					<Input
						id="kanban-card-title"
						value={title}
						// biome-ignore lint/a11y/noAutofocus: modal/tab opens for editing
						autoFocus={autoFocusTitle}
						onChange={(e) => {
							setTitle(e.target.value);
							commit({ title: e.target.value });
						}}
						onFocus={() => {
							titleFocused.current = true;
						}}
						onBlur={() => {
							titleFocused.current = false;
						}}
						onKeyDown={(e) => {
							if (e.key === "Enter") onRequestClose?.();
						}}
						placeholder="Task title"
					/>
				)}
				{subtitle ? (
					<span className="truncate font-mono text-[11px] text-muted-foreground">
						{subtitle}
					</span>
				) : null}
			</div>

			<div className="flex flex-col gap-1.5">
				<Label htmlFor="kanban-card-description" className="text-xs">
					Description
				</Label>
				<Textarea
					id="kanban-card-description"
					value={description}
					onChange={(e) => {
						setDescription(e.target.value);
						commit({
							description: e.target.value.trim() ? e.target.value : null,
						});
					}}
					onFocus={() => {
						descFocused.current = true;
					}}
					onBlur={() => {
						descFocused.current = false;
					}}
					onKeyDown={(e) => {
						// Plain Enter inserts a newline; Ctrl/Cmd+Enter saves + closes.
						if (e.key === "Enter" && (e.ctrlKey || e.metaKey))
							onRequestClose?.();
					}}
					placeholder="Optional description"
					rows={5}
				/>
			</div>

			<div className="flex flex-col gap-1.5">
				<Label htmlFor="kanban-card-deadline" className="text-xs">
					Deadline
				</Label>
				<Input
					id="kanban-card-deadline"
					type="date"
					value={deadlineToInputValue(card.deadline)}
					onChange={(e) =>
						commit({ deadline: inputValueToDeadline(e.target.value) })
					}
					onKeyDown={(e) => {
						if (e.key === "Enter") onRequestClose?.();
					}}
				/>
				<span className="text-[11px] text-muted-foreground">
					Turns yellow on the due day, red after it passes.
				</span>
			</div>

			{onRequestClose ? (
				<div className="flex justify-end">
					<Button type="button" onClick={onRequestClose}>
						Save
					</Button>
				</div>
			) : null}
		</div>
	);
}
