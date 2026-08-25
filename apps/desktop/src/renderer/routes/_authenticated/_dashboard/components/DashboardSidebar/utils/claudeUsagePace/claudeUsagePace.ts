export type UsagePaceLevel = "green" | "yellow" | "orange" | "red";

export const FIVE_HOUR_WINDOW_MS = 5 * 60 * 60 * 1000;
export const WEEKLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export const USAGE_PACE_CLASS: Record<UsagePaceLevel, string> = {
	green: "text-green-500",
	yellow: "text-yellow-500",
	orange: "text-orange-500",
	red: "text-red-500",
};

/** The percent as displayed, so the colour always bands the number on screen. */
function displayPct(usedPct: number): number {
	return Math.min(999, Math.round(usedPct));
}

/**
 * Bands usage against how far through the window we are: green while the
 * remaining budget outpaces the remaining time, red once it falls far behind.
 * Without a usable reset timestamp it falls back to an absolute ramp.
 */
export function usagePaceLevel(
	usedPct: number,
	resetsAt: string | null,
	windowMs: number,
	now = Date.now(),
): UsagePaceLevel {
	const pct = displayPct(usedPct);
	const resetMs = resetsAt === null ? Number.NaN : Date.parse(resetsAt);
	if (Number.isNaN(resetMs)) {
		if (pct >= 80) return "red";
		if (pct >= 60) return "yellow";
		return "green";
	}

	const remainingMs = Math.min(Math.max(resetMs - now, 0), windowMs);
	const progress = Math.round(100 * (1 - remainingMs / windowMs));
	const budgetLeft = 100 - pct;
	const timeLeft = 100 - progress;

	if (timeLeft <= 0) return "green";
	if (budgetLeft >= timeLeft) return "green";
	if (budgetLeft >= 0.7 * timeLeft) return "yellow";
	if (budgetLeft >= 0.4 * timeLeft) return "orange";
	return "red";
}

export function formatUsagePct(usedPct: number): string {
	return `${displayPct(usedPct)}%`;
}
