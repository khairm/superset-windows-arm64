import { isSnoozeDue } from "renderer/routes/_authenticated/providers/CollectionsProvider/dashboardSidebarLocal";

type SnoozeRow = { snoozeUntil?: number | null };

export function hasTimedSnooze(rows: readonly SnoozeRow[]): boolean {
	return rows.some((row) => typeof row.snoozeUntil === "number");
}

export function hasDueSnooze(
	rows: readonly SnoozeRow[],
	nowMs: number,
): boolean {
	return rows.some((row) => isSnoozeDue(row, nowMs));
}
