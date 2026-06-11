import type { KanbanColumnRow } from "renderer/routes/_authenticated/providers/CollectionsProvider/dashboardSidebarLocal";

/** Inclusive epoch-ms bounds a card's completedAt must fall within. */
export interface CompletedFilterRange {
	fromMs: number;
	toMs: number;
}

type CompletedFilterSource = Pick<
	KanbanColumnRow,
	"completedFilter" | "completedFilterFrom" | "completedFilterTo"
>;

/**
 * (KANBAN COMPLETED) Resolve the Completed column's persisted filter to
 * inclusive bounds, or null for "show everything". Same local-Date day math as
 * deadlineUrgency: "last-month" is the previous CALENDAR month (in June: May
 * 1 00:00 – May 31 23:59:59.999 local); "custom" stores local-midnight from/to
 * picked on a range calendar, widened here to whole days. An open end is
 * treated as unbounded — that's filter semantics, not a defaulted value.
 */
export function getCompletedFilterRange(
	column: CompletedFilterSource,
	now: number,
): CompletedFilterRange | null {
	if (column.completedFilter === "last-month") {
		const d = new Date(now);
		const from = new Date(d.getFullYear(), d.getMonth() - 1, 1);
		const to = new Date(d.getFullYear(), d.getMonth(), 1);
		return { fromMs: from.getTime(), toMs: to.getTime() - 1 };
	}
	if (column.completedFilter === "custom") {
		const from = column.completedFilterFrom;
		const to = column.completedFilterTo;
		if (from == null && to == null) return null;
		let toMs = Number.MAX_SAFE_INTEGER;
		if (to != null) {
			const end = new Date(to);
			end.setHours(23, 59, 59, 999);
			toMs = end.getTime();
		}
		return { fromMs: from ?? 0, toMs };
	}
	return null;
}

export function isWithinCompletedRange(
	completedAt: number | null | undefined,
	range: CompletedFilterRange,
): boolean {
	if (completedAt == null) return false;
	return completedAt >= range.fromMs && completedAt <= range.toMs;
}

/** "project / branch" snapshot stored on a card at completion — what a frozen
 * record (completed card whose branch was later deleted) renders. Mirrors the
 * live card subtitle format. */
export function buildCompletedContext(
	projectName: string | null,
	branch: string | null | undefined,
): string | null {
	if (projectName && branch) return `${projectName} / ${branch}`;
	return branch ?? null;
}
