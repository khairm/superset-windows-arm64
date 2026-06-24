import type { SelectV2Workspace } from "@superset/db/schema";
import type {
	KanbanCardRow,
	KanbanColumnRow,
} from "renderer/routes/_authenticated/providers/CollectionsProvider/dashboardSidebarLocal";

/** Which section of a column a card renders in. */
export type KanbanCardBucket = "active" | "snoozed" | "archived" | "deleted";

/**
 * A card plus its resolved branch context. For a Queued (unbound) card,
 * `workspace`/`projectName` are null. The bucket is derived from the branch's
 * sidebar state for bound cards, or the card's own snooze/archive for unbound.
 *
 * (KANBAN COMPLETED) A FROZEN record — a completed card whose branch was later
 * deleted — is the one case where `card.workspaceId != null` while `workspace`
 * is null: it renders from the stored title/completedContext snapshot and must
 * NOT be presented as an editable queued card.
 */
export interface KanbanCardView {
	card: KanbanCardRow;
	workspace: SelectV2Workspace | null;
	projectName: string | null;
	bucket: KanbanCardBucket;
	/**
	 * Resolved DISPLAY title. For a BOUND card it is derived live from the branch
	 * (same source as the sidebar — impossible to diverge); the card's stored
	 * `title` is used ONLY for unbound (Queued) cards. Mirrors how bucket/snooze
	 * are resolved for bound vs unbound cards.
	 */
	title: string;
}

/** A column plus its cards split into the rendered buckets (each sorted). */
export interface KanbanColumnView {
	column: KanbanColumnRow;
	active: KanbanCardView[];
	snoozed: KanbanCardView[];
	archived: KanbanCardView[];
	/** (RECYCLE-BIN) Soft-deleted cards in this column, sorted deletedAt DESC.
	 * Only the items within the retention window are included here; older ones
	 * are reachable via the section's "Show all" toggle (see `recycleBinHidden`).
	 * The collapsible header count is `recycleBin.length + recycleBinHidden.length`. */
	recycleBin: KanbanCardView[];
	/** (RECYCLE-BIN) Soft-deleted cards older than the retention window, hidden
	 * from `recycleBin` by default — surfaced as an "N hidden by filter" footer
	 * + a "Show all" toggle (mirrors the sidebar bin + Completed column). */
	recycleBinHidden: KanbanCardView[];
	/** (KANBAN COMPLETED) Cards the Completed column's date filter hid from
	 * `active` — surfaced as a footer count so a freshly-dropped card "vanishing"
	 * under a last-month filter is explainable. Always 0 for other columns. */
	hiddenByFilter: number;
}
