type SnoozeRow = { snoozeUntil?: number | null };

export function hasTimedSnooze(rows: readonly SnoozeRow[]): boolean {
	return rows.some((row) => typeof row.snoozeUntil === "number");
}

export function hasDueSnooze(
	rows: readonly SnoozeRow[],
	nowMs: number,
): boolean {
	return rows.some(
		(row) => typeof row.snoozeUntil === "number" && row.snoozeUntil <= nowMs,
	);
}
