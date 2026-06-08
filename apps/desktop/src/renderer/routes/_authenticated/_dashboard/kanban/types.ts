import type { SelectV2Workspace } from "@superset/db/schema";
import type {
	KanbanCardRow,
	KanbanColumnRow,
} from "renderer/routes/_authenticated/providers/CollectionsProvider/dashboardSidebarLocal";

/** Which section of a column a card renders in. */
export type KanbanCardBucket = "active" | "snoozed" | "archived";

/**
 * A card plus its resolved branch context. For a Queued (unbound) card,
 * `workspace`/`projectName` are null. The bucket is derived from the branch's
 * sidebar state for bound cards, or the card's own snooze/archive for unbound.
 */
export interface KanbanCardView {
	card: KanbanCardRow;
	workspace: SelectV2Workspace | null;
	projectName: string | null;
	bucket: KanbanCardBucket;
}

/** A column plus its cards split into the three rendered buckets (each sorted). */
export interface KanbanColumnView {
	column: KanbanColumnRow;
	active: KanbanCardView[];
	snoozed: KanbanCardView[];
	archived: KanbanCardView[];
}
