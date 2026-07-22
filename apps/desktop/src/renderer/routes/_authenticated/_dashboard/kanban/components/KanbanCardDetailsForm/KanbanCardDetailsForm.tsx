import { Button } from "@superset/ui/button";
import { Input } from "@superset/ui/input";
import { Label } from "@superset/ui/label";
import { Textarea } from "@superset/ui/textarea";
import { eq } from "@tanstack/db";
import { useLiveQuery } from "@tanstack/react-db";
import { CalendarIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useCollections } from "renderer/routes/_authenticated/providers/CollectionsProvider";
import { useHostWorkspaces } from "renderer/routes/_authenticated/providers/HostWorkspacesProvider";
import { applyKanbanCardPatch } from "../../utils/applyKanbanCardPatch";
import { formatDeadlineLong } from "../../utils/deadlineUrgency";
import { deriveCardTitle } from "../../utils/deriveCardTitle";
import { DeadlinePickerPopover } from "../DeadlinePickerPopover";

const COMMIT_DEBOUNCE_MS = 250;

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
	// (KANBAN HOST SOURCE) Bound-card context comes from the host-served
	// workspace lists (see useKanbanData) — the Electric mirror lacks
	// post-migration branches.
	const { workspaces: hostWorkspaces } = useHostWorkspaces();
	const boundWorkspace = card?.workspaceId
		? (hostWorkspaces.find((w) => w.id === card.workspaceId) ?? null)
		: null;
	const isBound = card?.workspaceId != null;
	const boundTitle = boundWorkspace ? deriveCardTitle(boundWorkspace) : "";

	// Seed synchronously — the row is already in the local collection when the
	// editor opens. An effect-only seed loses to autoFocus (focus fires before
	// the first effect), which is how the modal used to open blank and then
	// write that blank back over the card.
	const seedCard = collections.v2KanbanCards.get(cardId);
	const [title, setTitle] = useState(seedCard?.title ?? "");
	const [description, setDescription] = useState(seedCard?.description ?? "");
	const [deadlineOpen, setDeadlineOpen] = useState(false);
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
	}, [cardId, card?.title]);
	useEffect(() => {
		const switched = descCardId.current !== cardId;
		descCardId.current = cardId;
		if (!switched && descDirty.current) return;
		descDirty.current = false;
		setDescription(card?.description ?? "");
	}, [cardId, card?.description]);

	const commit = (patch: {
		title?: string;
		description?: string | null;
		deadline?: number | null;
	}) => {
		if (!collections.v2KanbanCards.get(cardId)) return;
		collections.v2KanbanCards.update(cardId, (draft) =>
			applyKanbanCardPatch(draft, patch),
		);
	};

	// (DEBOUNCED WRITE-THROUGH) A raw per-keystroke commit re-serializes the
	// WHOLE per-org cards collection to localStorage (the @tanstack/db driver
	// writes the full blob per update), so typing on a large board pays
	// multi-ms per key. Text edits queue for ~250ms and flush on blur, Enter,
	// Save, card switch, and unmount — closing mid-edit still can never lose
	// input. The flush targets the cardId CAPTURED at queue time, so a card
	// switch can never commit one card's text into another.
	const commitTimerRef = useRef<number | null>(null);
	const pendingRef = useRef<{
		cardId: string;
		patch: { title?: string; description?: string | null };
	} | null>(null);
	const flushPendingCommit = useCallback(() => {
		if (commitTimerRef.current != null) {
			window.clearTimeout(commitTimerRef.current);
			commitTimerRef.current = null;
		}
		const pending = pendingRef.current;
		pendingRef.current = null;
		if (!pending || !collections.v2KanbanCards.get(pending.cardId)) return;
		collections.v2KanbanCards.update(pending.cardId, (draft) => {
			if (pending.patch.title !== undefined) draft.title = pending.patch.title;
			if (pending.patch.description !== undefined) {
				draft.description = pending.patch.description;
			}
		});
	}, [collections]);
	const queueCommit = useCallback(
		(patch: { title?: string; description?: string | null }) => {
			if (pendingRef.current && pendingRef.current.cardId !== cardId) {
				// Pending edits belong to a different card — flush them first.
				flushPendingCommit();
			}
			pendingRef.current = {
				cardId,
				patch: { ...pendingRef.current?.patch, ...patch },
			};
			if (commitTimerRef.current != null) {
				window.clearTimeout(commitTimerRef.current);
			}
			commitTimerRef.current = window.setTimeout(
				flushPendingCommit,
				COMMIT_DEBOUNCE_MS,
			);
		},
		[cardId, flushPendingCommit],
	);
	// Card switch flushes the previous card's pending edits; unmount (every
	// modal close path: X, Escape, overlay click) flushes too.
	const prevCardIdRef = useRef(cardId);
	useEffect(() => {
		if (prevCardIdRef.current === cardId) return;
		prevCardIdRef.current = cardId;
		flushPendingCommit();
	}, [cardId, flushPendingCommit]);
	useEffect(() => () => flushPendingCommit(), [flushPendingCommit]);

	const requestClose = useCallback(() => {
		flushPendingCommit();
		onRequestClose?.();
	}, [flushPendingCommit, onRequestClose]);
	const closeOnEnter = (e: React.KeyboardEvent<HTMLInputElement>) => {
		if (e.key !== "Enter") return;
		// An IME composition commit also dispatches Enter (keyCode 229) —
		// typing CJK must never dismiss the editor mid-word.
		if (e.nativeEvent.isComposing || e.keyCode === 229) return;
		requestClose();
	};

	if (!card) {
		return (
			<div className="select-text p-4 text-sm text-muted-foreground">
				This branch isn't on the board yet.
			</div>
		);
	}

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
						autoFocus={autoFocusTitle}
						onChange={(e) => {
							titleDirty.current = true;
							setTitle(e.target.value);
							queueCommit({ title: e.target.value });
						}}
						onBlur={() => {
							flushPendingCommit();
							titleDirty.current = false;
						}}
						onKeyDown={closeOnEnter}
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
						queueCommit({
							description: e.target.value.trim() ? e.target.value : null,
						});
					}}
					onBlur={() => {
						flushPendingCommit();
						descDirty.current = false;
					}}
					onKeyDown={(e) => {
						// Plain Enter inserts a newline; Ctrl/Cmd+Enter saves + closes
						// (never during an IME composition).
						if (
							e.key === "Enter" &&
							(e.ctrlKey || e.metaKey) &&
							!e.nativeEvent.isComposing
						) {
							requestClose();
						}
					}}
					placeholder="Optional description"
					rows={5}
				/>
			</div>

			<div className="flex flex-col gap-1.5">
				<Label htmlFor="kanban-card-deadline" className="text-xs">
					Deadline
				</Label>
				<DeadlinePickerPopover
					value={card.deadline}
					onChange={(deadline) => commit({ deadline })}
					open={deadlineOpen}
					onOpenChange={setDeadlineOpen}
				>
					<Button
						id="kanban-card-deadline"
						type="button"
						variant="outline"
						className="justify-start gap-2 font-normal"
						onClick={() => setDeadlineOpen((o) => !o)}
					>
						<CalendarIcon className="size-4 text-muted-foreground" />
						{card.deadline != null ? (
							formatDeadlineLong(card.deadline)
						) : (
							<span className="text-muted-foreground">Pick a date</span>
						)}
					</Button>
				</DeadlinePickerPopover>
				<span className="text-[11px] text-muted-foreground">
					Turns yellow on the due day, red after it passes.
				</span>
			</div>

			{onRequestClose ? (
				<div className="flex justify-end">
					<Button type="button" onClick={requestClose}>
						Save
					</Button>
				</div>
			) : null}
		</div>
	);
}
