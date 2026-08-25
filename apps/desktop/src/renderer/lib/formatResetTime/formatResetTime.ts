/** Formats the time until a quota window resets, e.g. "2d 4h", "3h 12m", "14m". */
export function formatResetIn(resetsAt: Date, now: Date = new Date()): string {
	const diffMs = resetsAt.getTime() - now.getTime();
	if (diffMs <= 0) return "now";

	const totalMinutes = Math.ceil(diffMs / 60_000);
	const days = Math.floor(totalMinutes / (60 * 24));
	const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
	const minutes = totalMinutes % 60;

	if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
	if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
	return `${minutes}m`;
}

/**
 * Compact countdown for tight surfaces, e.g. "6d17h", "4h0m", "45m", "now".
 * Units are floored and both are always shown; a reset further out than the
 * window is capped to it, so a skewed timestamp cannot print past the window.
 * Returns "" for a null or unparseable timestamp.
 * Same output format as the statusline countdown in
 * mk-skills/statusline/statusline.py — keep the two in sync.
 */
export function formatResetCompact(
	resetsAt: string | null,
	windowMs: number,
	now: number,
): string {
	if (resetsAt === null) return "";
	const resetMs = Date.parse(resetsAt);
	if (Number.isNaN(resetMs)) return "";

	const remainingMs = Math.min(Math.max(resetMs - now, 0), windowMs);
	const totalSeconds = Math.floor(remainingMs / 1000);
	if (totalSeconds <= 0) return "now";

	const days = Math.floor(totalSeconds / 86_400);
	const hours = Math.floor((totalSeconds % 86_400) / 3_600);
	const minutes = Math.floor((totalSeconds % 3_600) / 60);

	if (days > 0) return `${days}d${hours}h`;
	if (hours > 0) return `${hours}h${minutes}m`;
	return `${minutes}m`;
}

/**
 * Full reset caption: countdown plus the absolute time — clock time when the
 * reset lands within 24h, date otherwise. e.g. "Resets in 2h 10m · 3:22 PM",
 * "Resets in 5d 13h · Aug 21".
 */
export function formatResetLabel(
	resetsAt: Date,
	now: Date = new Date(),
): string {
	const diffMs = resetsAt.getTime() - now.getTime();
	if (diffMs <= 0) return "Resets now";

	const within24h = diffMs < 24 * 60 * 60 * 1000;
	const absolute = within24h
		? resetsAt.toLocaleTimeString(undefined, {
				hour: "numeric",
				minute: "2-digit",
			})
		: resetsAt.toLocaleDateString(undefined, {
				month: "short",
				day: "numeric",
			});
	return `Resets in ${formatResetIn(resetsAt, now)} · ${absolute}`;
}
