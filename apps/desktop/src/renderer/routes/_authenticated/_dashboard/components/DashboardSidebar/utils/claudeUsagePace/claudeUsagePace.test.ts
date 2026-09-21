import { describe, expect, it } from "bun:test";
import {
	displayFablePct,
	FIVE_HOUR_WINDOW_MS,
	formatUsagePct,
	isWeeklyExhausted,
	usagePaceLevel,
	WEEKLY_WINDOW_MS,
} from "./claudeUsagePace";

const NOW = Date.parse("2026-08-16T12:00:00Z");

/** Reset timestamp `remainingMs` in the future, as the API returns it. */
function resetsIn(remainingMs: number): string {
	return new Date(NOW + remainingMs).toISOString();
}

/** Half the window left, so progress is 50% and time left is 50 points. */
const HALF_WINDOW = resetsIn(FIVE_HOUR_WINDOW_MS / 2);

function paceAtHalfWindow(usedPct: number) {
	return usagePaceLevel(usedPct, HALF_WINDOW, FIVE_HOUR_WINDOW_MS, NOW);
}

describe("usagePaceLevel", () => {
	it("is green while budget left keeps up with time left", () => {
		expect(paceAtHalfWindow(20)).toBe("green");
		expect(paceAtHalfWindow(50)).toBe("green");
	});

	it("bands yellow, orange and red as budget falls behind", () => {
		expect(paceAtHalfWindow(51)).toBe("yellow");
		expect(paceAtHalfWindow(65)).toBe("yellow");
		expect(paceAtHalfWindow(66)).toBe("orange");
		expect(paceAtHalfWindow(80)).toBe("orange");
		expect(paceAtHalfWindow(81)).toBe("red");
	});

	it("bands the rounded percent, matching what is displayed", () => {
		expect(formatUsagePct(79.6)).toBe("80%");
		expect(paceAtHalfWindow(79.6)).toBe("orange");
		expect(paceAtHalfWindow(80.4)).toBe("orange");
		expect(paceAtHalfWindow(80.6)).toBe("red");
	});

	it("is green once the window is spent, however high usage is", () => {
		expect(usagePaceLevel(100, resetsIn(0), FIVE_HOUR_WINDOW_MS, NOW)).toBe(
			"green",
		);
	});

	it("is green for a reset already in the past", () => {
		expect(
			usagePaceLevel(95, resetsIn(-60_000), FIVE_HOUR_WINDOW_MS, NOW),
		).toBe("green");
	});

	it("caps a skewed reset beyond the window at zero progress", () => {
		const skewed = resetsIn(FIVE_HOUR_WINDOW_MS * 3);
		expect(usagePaceLevel(0, skewed, FIVE_HOUR_WINDOW_MS, NOW)).toBe("green");
		expect(usagePaceLevel(40, skewed, FIVE_HOUR_WINDOW_MS, NOW)).toBe("orange");
	});

	it("falls back to an absolute ramp without a reset timestamp", () => {
		expect(usagePaceLevel(59.4, null, FIVE_HOUR_WINDOW_MS, NOW)).toBe("green");
		expect(usagePaceLevel(59.6, null, FIVE_HOUR_WINDOW_MS, NOW)).toBe("yellow");
		expect(usagePaceLevel(79.4, null, FIVE_HOUR_WINDOW_MS, NOW)).toBe("yellow");
		expect(usagePaceLevel(79.6, null, FIVE_HOUR_WINDOW_MS, NOW)).toBe("red");
	});

	it("uses the ramp for an unparseable reset timestamp", () => {
		expect(usagePaceLevel(85, "not-a-date", FIVE_HOUR_WINDOW_MS, NOW)).toBe(
			"red",
		);
	});

	it("handles percents above 100", () => {
		expect(paceAtHalfWindow(150)).toBe("red");
		expect(usagePaceLevel(1000, null, FIVE_HOUR_WINDOW_MS, NOW)).toBe("red");
	});

	it("paces the weekly window the same way", () => {
		const halfWeek = resetsIn(WEEKLY_WINDOW_MS / 2);
		expect(usagePaceLevel(50, halfWeek, WEEKLY_WINDOW_MS, NOW)).toBe("green");
		expect(usagePaceLevel(81, halfWeek, WEEKLY_WINDOW_MS, NOW)).toBe("red");
		expect(usagePaceLevel(100, halfWeek, WEEKLY_WINDOW_MS, NOW)).toBe("red");
	});
});

describe("isWeeklyExhausted", () => {
	it.each([
		null,
		0,
		99.5,
		99.99,
	])("does not exhaust raw usage %s", (percent) => {
		expect(isWeeklyExhausted(percent, resetsIn(WEEKLY_WINDOW_MS), NOW)).toBe(
			false,
		);
	});

	it.each([100, 125])("exhausts raw usage %s until reset", (percent) => {
		expect(isWeeklyExhausted(percent, resetsIn(WEEKLY_WINDOW_MS), NOW)).toBe(
			true,
		);
		expect(isWeeklyExhausted(percent, null, NOW)).toBe(true);
	});

	it("keeps exhaustion when the reset timestamp is invalid", () => {
		expect(isWeeklyExhausted(100, "not-a-date", NOW)).toBe(true);
	});

	it.each([
		0, -1, -60_000,
	])("clears exhaustion at or after reset %s", (remaining) => {
		expect(isWeeklyExhausted(100, resetsIn(remaining), NOW)).toBe(false);
	});
});

describe("displayFablePct", () => {
	it("caps present Fable usage when weekly usage is exhausted", () => {
		expect(displayFablePct(true, 40)).toBe(100);
		expect(displayFablePct(true, null)).toBeNull();
	});

	it("preserves Fable usage when weekly usage is not exhausted", () => {
		expect(displayFablePct(false, 40)).toBe(40);
		expect(displayFablePct(false, null)).toBeNull();
	});
});

describe("formatUsagePct", () => {
	it("rounds to whole percents", () => {
		expect(formatUsagePct(0)).toBe("0%");
		expect(formatUsagePct(12.4)).toBe("12%");
		expect(formatUsagePct(12.6)).toBe("13%");
	});

	it("caps at 999%", () => {
		expect(formatUsagePct(1000)).toBe("999%");
	});
});
