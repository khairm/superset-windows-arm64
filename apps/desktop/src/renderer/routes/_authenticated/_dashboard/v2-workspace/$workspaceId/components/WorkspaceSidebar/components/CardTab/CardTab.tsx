import { KanbanCardDetailsForm } from "renderer/routes/_authenticated/_dashboard/kanban/components/KanbanCardDetailsForm";
import { kanbanBoundCardId } from "renderer/routes/_authenticated/providers/CollectionsProvider/dashboardSidebarLocal";

interface CardTabProps {
	workspaceId: string;
}

/**
 * (KANBAN) Right-panel "Card" tab — edits the Kanban task details (title /
 * description / deadline) for THIS branch's card. Always available; the default
 * active tab stays "changes". Every branch mirrors to a card, so the row
 * normally exists; the form shows a gentle empty state until reconcile creates
 * it.
 */
export function CardTab({ workspaceId }: CardTabProps) {
	return (
		<div className="flex h-full min-h-0 flex-col overflow-y-auto">
			<KanbanCardDetailsForm cardId={kanbanBoundCardId(workspaceId)} />
		</div>
	);
}
