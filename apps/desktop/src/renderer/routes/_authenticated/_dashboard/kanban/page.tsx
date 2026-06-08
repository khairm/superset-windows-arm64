import { createFileRoute } from "@tanstack/react-router";
import { KanbanBoard } from "./components/KanbanBoard";
import { KanbanCollapseSplit } from "./components/KanbanCollapseSplit";

interface KanbanSearch {
	/** workspaceId of the bound card whose workspace is open in the split. */
	cardId?: string;
}

export const Route = createFileRoute("/_authenticated/_dashboard/kanban/")({
	component: KanbanPage,
	validateSearch: (raw: Record<string, unknown>): KanbanSearch => ({
		cardId:
			typeof raw.cardId === "string" && raw.cardId.length > 0
				? raw.cardId
				: undefined,
	}),
});

// (KANBAN) The fork's local-only board. A bound card click sets ?cardId=<wsId>,
// which collapses the board to a left rail and opens that branch's centre.
function KanbanPage() {
	const { cardId } = Route.useSearch();
	if (cardId) {
		return <KanbanCollapseSplit workspaceId={cardId} />;
	}
	return (
		<div className="flex h-full min-h-0 w-full min-w-0 flex-col">
			<KanbanBoard />
		</div>
	);
}
