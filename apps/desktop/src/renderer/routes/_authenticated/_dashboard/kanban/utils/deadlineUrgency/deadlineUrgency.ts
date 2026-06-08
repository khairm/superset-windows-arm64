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

/** `<input type="date">` value (YYYY-MM-DD, local) for a stored deadline. */
export function deadlineToInputValue(
	deadline: number | null | undefined,
): string {
	if (deadline == null) return "";
	const d = new Date(deadline);
	const yyyy = d.getFullYear();
	const mm = String(d.getMonth() + 1).padStart(2, "0");
	const dd = String(d.getDate()).padStart(2, "0");
	return `${yyyy}-${mm}-${dd}`;
}

/** Parse a date-input value (YYYY-MM-DD) to a local-midnight epoch-ms (or null). */
export function inputValueToDeadline(value: string): number | null {
	if (!value) return null;
	const [yyyy, mm, dd] = value.split("-").map((p) => Number.parseInt(p, 10));
	if (!yyyy || !mm || !dd) return null;
	const d = new Date(yyyy, mm - 1, dd);
	d.setHours(0, 0, 0, 0);
	const ms = d.getTime();
	return Number.isNaN(ms) ? null : ms;
}
