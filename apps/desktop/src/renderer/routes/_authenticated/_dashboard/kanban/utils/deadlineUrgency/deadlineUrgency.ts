/**
 * Date-only deadline urgency. The deadline is stored as a local-midnight
 * epoch-ms; urgency compares calendar days (local), never time-of-day:
 *   - upcoming  : due day is in the future            → neutral
 *   - due-today : due day is today                    → yellow
 *   - overdue   : due day already passed              → red
 * No notifications — purely visual (per the feature spec).
 */
export type DeadlineUrgency = "none" | "upcoming" | "due-today" | "overdue";

function startOfLocalDay(ms: number): number {
	const d = new Date(ms);
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}

export function getDeadlineUrgency(
	deadline: number | null | undefined,
	now: number = Date.now(),
): DeadlineUrgency {
	if (deadline == null) return "none";
	const due = startOfLocalDay(deadline);
	const today = startOfLocalDay(now);
	if (due < today) return "overdue";
	if (due === today) return "due-today";
	return "upcoming";
}

/** Human label for the card face, e.g. "13 Jun". */
export function formatDeadline(deadline: number | null | undefined): string {
	if (deadline == null) return "";
	return new Date(deadline).toLocaleDateString(undefined, {
		day: "numeric",
		month: "short",
	});
}

/** Full label for the picker trigger, e.g. "Tue 13 Jun 2026". */
export function formatDeadlineLong(
	deadline: number | null | undefined,
): string {
	if (deadline == null) return "";
	return new Date(deadline).toLocaleDateString(undefined, {
		weekday: "short",
		day: "numeric",
		month: "short",
		year: "numeric",
	});
}

/** Local-midnight epoch-ms for a calendar-picked date (the stored shape). */
export function dateToDeadline(date: Date): number {
	const d = new Date(date);
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}

/**
 * (DEADLINE-TIE-ORDER) Tie-group identity for the deadline sort: cards group
 * by local due DAY (or the no-deadline tail, null). Single source for BOTH the
 * sort comparator and the board's drag handler — group membership must never
 * diverge between them. Day-keyed (not raw ms) so a non-midnight legacy value
 * still groups with the day it renders as.
 */
export function deadlineGroupKey(
	deadline: number | null | undefined,
): number | null {
	return deadline == null ? null : startOfLocalDay(deadline);
}
