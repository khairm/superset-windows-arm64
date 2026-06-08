import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@superset/ui/dialog";
import { KanbanCardDetailsForm } from "../KanbanCardDetailsForm";

interface QueuedCardModalProps {
	cardId: string | null;
	onClose: () => void;
}

/**
 * Single-click editor for a Queued (unbound) card — title / description /
 * deadline. Opens when a Queued card is clicked or a new task is added.
 */
export function QueuedCardModal({ cardId, onClose }: QueuedCardModalProps) {
	return (
		<Dialog
			open={cardId != null}
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>Task</DialogTitle>
				</DialogHeader>
				{cardId != null ? (
					<KanbanCardDetailsForm cardId={cardId} autoFocusTitle />
				) : null}
			</DialogContent>
		</Dialog>
	);
}
