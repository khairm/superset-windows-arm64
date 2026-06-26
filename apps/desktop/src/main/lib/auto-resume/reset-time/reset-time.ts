// (AUTO-RESUME) Timezone-aware reset-time -> absolute-epoch resolver.
//
// Claude rate-limit messages name the reset only as localized English text, e.g.
//   "resets 3:30am (Europe/London)"            (session: time + IANA tz, no date)
//   "resets Jun 17, 1am (Europe/London)"       (weekly:  month/day + time + tz)
// Codex usage-limit prose carries only a clock (no tz), and sometimes a dated form
//   "try again at 1:08 PM."
//   "try again at May 31st, 2026 12:58 AM."
//
// Conversion must be DST-correct (Europe/London has spring-gap / fall-overlap wall
// times), must resolve a no-date session time to the next occurrence >= the failure
// anchor, must roll a weekly date's year only when already past, and — critically for
// the away-overnight case — must FIRE NOW if the reset already elapsed (never roll a
// stale failure forward to tomorrow / next year). A target more than ~8 days out is
// treated as a stale/garbled parse.

const MONTHS: Record<string, number> = {
	jan: 0,
	feb: 1,
	mar: 2,
	apr: 3,
	may: 4,
	jun: 5,
	jul: 6,
	aug: 7,
	sep: 8,
	oct: 9,
	nov: 10,
	dec: 11,
};

const GRACE_MS = 60_000; // a reset within 60s of now counts as "now"
const MAX_AHEAD_MS = 8 * 24 * 60 * 60 * 1000; // > 8 days ahead => stale parse
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ParsedResetTime {
	month?: number; // 0-11, present for the weekly/dated form
	day?: number; // 1-31
	year?: number; // present only for the dated Codex form
	hour: number; // 0-23 (already am/pm-normalized)
	minute: number;
}

export type ResetResolution =
	| { kind: "fire-now" }
	| { kind: "at"; epochMs: number }
	| { kind: "stale"; epochMs: number }
	| { kind: "unparsed" };

/**
 * Parse the human time text into calendar/clock components. Accepts:
 *   "3:30am", "3pm", "12am", "12:00 PM",
 *   "Jun 17, 1am", "May 31st, 2026 12:58 AM"
 * Returns null if no clock time is found.
 */
export function parseResetText(text: string): ParsedResetTime | null {
	const trimmed = text.trim();
	let month: number | undefined;
	let day: number | undefined;
	let year: number | undefined;
	let rest = trimmed;

	// Optional leading date: "Mon D[st|nd|rd|th][, YYYY]"
	const dateRe =
		/^([A-Za-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?\s*,?\s*(?:(\d{4})\s+)?/;
	const dm = dateRe.exec(trimmed);
	if (dm) {
		const monthKey = dm[1].slice(0, 3).toLowerCase();
		if (monthKey in MONTHS) {
			month = MONTHS[monthKey];
			day = Number(dm[2]);
			year = dm[3] ? Number(dm[3]) : undefined;
			rest = trimmed.slice(dm[0].length);
		}
	}

	// Clock: "H[:MM] a.m./p.m." with flexible spacing/dots/case.
	const timeRe = /(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?/i;
	const tm = timeRe.exec(rest);
	if (!tm) return null;

	let hour = Number(tm[1]);
	const minute = tm[2] ? Number(tm[2]) : 0;
	const meridiem = tm[3].toLowerCase();
	if (hour < 1 || hour > 12 || minute > 59) return null;
	if (hour === 12) hour = 0; // 12am -> 0, 12pm -> 12 (after +12 below)
	if (meridiem === "p") hour += 12;

	return { month, day, year, hour, minute };
}

/** Offset (localTime - UTC) in ms for an IANA tz at a given UTC instant. */
function tzOffsetMs(utcMs: number, tz: string): number {
	const dtf = new Intl.DateTimeFormat("en-US", {
		timeZone: tz,
		hourCycle: "h23",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
	const parts = dtf.formatToParts(new Date(utcMs));
	const map: Record<string, number> = {};
	for (const p of parts) {
		if (p.type !== "literal") map[p.type] = Number(p.value);
	}
	const asUtc = Date.UTC(
		map.year,
		map.month - 1,
		map.day,
		map.hour,
		map.minute,
		map.second,
	);
	return asUtc - utcMs;
}

/**
 * Convert a wall-clock time in `tz` to an absolute epoch. DST-correct: the offset is
 * resolved AT the target instant (one refinement iteration). Spring-gap wall times
 * land on the next valid instant; fall-overlap picks the earlier instant.
 */
export function zonedWallTimeToEpoch(
	year: number,
	month: number, // 0-11
	day: number,
	hour: number,
	minute: number,
	tz: string,
): number {
	const naiveUtc = Date.UTC(year, month, day, hour, minute, 0);
	const offset1 = tzOffsetMs(naiveUtc, tz);
	let epoch = naiveUtc - offset1;
	const offset2 = tzOffsetMs(epoch, tz);
	if (offset2 !== offset1) {
		epoch = naiveUtc - offset2;
	}
	return epoch;
}

/** Calendar Y/M/D of an instant as seen in `tz`. */
function tzYmd(utcMs: number, tz: string): { y: number; m: number; d: number } {
	const dtf = new Intl.DateTimeFormat("en-US", {
		timeZone: tz,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	});
	const map: Record<string, number> = {};
	for (const p of dtf.formatToParts(new Date(utcMs))) {
		if (p.type !== "literal") map[p.type] = Number(p.value);
	}
	return { y: map.year, m: map.month - 1, d: map.day };
}

/**
 * Resolve a reset-time string to an absolute epoch decision.
 * @param tz IANA zone for the wall time (from the Claude message; machine-local for Codex).
 * @param anchorMs timestamp of the failure RECORD (resolves the no-date "next occurrence").
 * @param nowMs current time (decides fire-now / stale).
 */
export function resolveResetTime(
	text: string,
	tz: string,
	anchorMs: number,
	nowMs: number,
): ResetResolution {
	const parsed = parseResetText(text);
	if (!parsed) return { kind: "unparsed" };

	let epochMs: number;
	if (parsed.month !== undefined && parsed.day !== undefined) {
		// Weekly / dated form.
		const year = parsed.year ?? tzYmd(anchorMs, tz).y;
		epochMs = zonedWallTimeToEpoch(
			year,
			parsed.month,
			parsed.day,
			parsed.hour,
			parsed.minute,
			tz,
		);
		// No explicit year and already before the anchor => next year.
		if (parsed.year === undefined && epochMs < anchorMs) {
			epochMs = zonedWallTimeToEpoch(
				year + 1,
				parsed.month,
				parsed.day,
				parsed.hour,
				parsed.minute,
				tz,
			);
		}
	} else {
		// Session form: next occurrence of the wall time >= anchor.
		const at = tzYmd(anchorMs, tz);
		epochMs = zonedWallTimeToEpoch(
			at.y,
			at.m,
			at.d,
			parsed.hour,
			parsed.minute,
			tz,
		);
		if (epochMs < anchorMs) {
			const next = tzYmd(anchorMs + DAY_MS, tz);
			epochMs = zonedWallTimeToEpoch(
				next.y,
				next.m,
				next.d,
				parsed.hour,
				parsed.minute,
				tz,
			);
		}
	}

	if (epochMs <= nowMs + GRACE_MS) return { kind: "fire-now" };
	if (epochMs > nowMs + MAX_AHEAD_MS) return { kind: "stale", epochMs };
	return { kind: "at", epochMs };
}
