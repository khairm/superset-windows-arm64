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

	// Seed synchronously — the row is already in the local collection when the
	// editor opens. An effect-only seed loses to autoFocus (focus fires before
	// the first effect), which is how the modal used to open blank and then
	// write that blank back over the card.
	const seedCard = collections.v2KanbanCards.get(cardId);
	const [title, setTitle] = useState(seedCard?.title ?? "");
	const [description, setDescription] = useState(seedCard?.description ?? "");
	// Dirty = typed since the last row sync — the only state a resync must not
	// clobber. Cleared on blur, on card switch, and by every accepted resync.
	const titleDirty = useRef(false);
	const descDirty = useRef(false);
	const titleCardId = useRef(cardId);
	const descCardId = useRef(cardId);
	useEffect(() => {
		const switched = titleCardId.current !== cardId;
		titleCardId.current = cardId;
		if (!switched && titleDirty.current) return;
		titleDirty.current = false;
		setTitle(card?.title ?? "");
	}, [cardId, card?.id, card?.title]);
	useEffect(() => {
		const switched = descCardId.current !== cardId;
		descCardId.current = cardId;
		if (!switched && descDirty.current) return;
		descDirty.current = false;
		setDescription(card?.description ?? "");
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
							titleDirty.current = true;
							setTitle(e.target.value);
							commit({ title: e.target.value });
						}}
						onBlur={() => {
							titleDirty.current = false;
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
						descDirty.current = true;
						setDescription(e.target.value);
						commit({
							description: e.target.value.trim() ? e.target.value : null,
						});
					}}
					onBlur={() => {
						descDirty.current = false;
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
