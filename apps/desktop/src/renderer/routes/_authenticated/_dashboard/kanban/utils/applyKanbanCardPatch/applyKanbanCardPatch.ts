export interface KanbanCardPatch {
	title?: string;
	description?: string | null;
	deadline?: number | null;
}

/**
 * The card-detail fields the patch writes — structural (all optional) so the
 * collection's mutable draft (typed from the zod INPUT shape, where defaulted
 * fields are optional) is assignable directly.
 */
interface KanbanCardDetailsDraft {
	title?: string;
	description?: string | null;
	deadline?: number | null;
	deadlineTabOrder?: number | null;
}

/**
 * Single write path for card detail edits (title / description / deadline),
 * shared by useKanbanActions.updateCard and the details form's direct commit —
 * so the "(DEADLINE-TIE-ORDER) a changed deadline resets the card's tie order"
 * rule can never diverge between the card face and the modal/Card tab.
 */
export function applyKanbanCardPatch(
	draft: KanbanCardDetailsDraft,
	patch: KanbanCardPatch,
): void {
	if (patch.title !== undefined) draft.title = patch.title;
	if (patch.description !== undefined) draft.description = patch.description;
	if (patch.deadline !== undefined && patch.deadline !== draft.deadline) {
		draft.deadline = patch.deadline;
		// A changed deadline moves the card to a different tie group — it
		// arrives there as a NEW item (bottom of the group).
		draft.deadlineTabOrder = null;
	}
}
