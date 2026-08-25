import { describe, expect, it } from "bun:test";
import {
	formatResetCompact,
	formatResetIn,
	formatResetLabel,
} from "./formatResetTime";

const NOW = new Date("2026-08-16T12:00:00Z");
const FIVE_HOUR_WINDOW_MS = 5 * 60 * 60 * 1000;
const WEEKLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function at(offsetMinutes: number): Date {
	return new Date(NOW.getTime() + offsetMinutes * 60_000);
}

describe("formatResetIn", () => {
	it("formats minutes", () => {
		expect(formatResetIn(at(14), NOW)).toBe("14m");
	});

	it("formats hours and minutes", () => {
		expect(formatResetIn(at(3 * 60 + 12), NOW)).toBe("3h 12m");
	});

	it("formats whole hours without minutes", () => {
		expect(formatResetIn(at(2 * 60), NOW)).toBe("2h");
	});

	it("formats days and hours", () => {
		expect(formatResetIn(at(2 * 24 * 60 + 4 * 60), NOW)).toBe("2d 4h");
	});

	it("formats whole days without hours", () => {
		expect(formatResetIn(at(3 * 24 * 60), NOW)).toBe("3d");
	});

	it("returns now for past timestamps", () => {
		expect(formatResetIn(at(-5), NOW)).toBe("now");
		expect(formatResetIn(NOW, NOW)).toBe("now");
	});

	it("rounds partial minutes up", () => {
		expect(formatResetIn(new Date(NOW.getTime() + 30_000), NOW)).toBe("1m");
	});
});

describe("formatResetLabel", () => {
	it("uses clock time within 24h", () => {
		const label = formatResetLabel(at(3 * 60 + 12), NOW);
		expect(label).toStartWith("Resets in 3h 12m · ");
		expect(label).toMatch(/\d{1,2}:\d{2}/);
	});

	it("uses date beyond 24h", () => {
		const label = formatResetLabel(at(5 * 24 * 60 + 13 * 60), NOW);
		expect(label).toStartWith("Resets in 5d 13h · ");
		expect(label).toMatch(/Aug \d{1,2}/);
	});

	it("handles past timestamps", () => {
		expect(formatResetLabel(at(-1), NOW)).toBe("Resets now");
	});
});

describe("formatResetCompact", () => {
	const now = NOW.getTime();
	const iso = (offsetMinutes: number) => at(offsetMinutes).toISOString();

	it("returns now at or past the reset", () => {
		expect(formatResetCompact(iso(0), FIVE_HOUR_WINDOW_MS, now)).toBe("now");
		expect(formatResetCompact(iso(-5), FIVE_HOUR_WINDOW_MS, now)).toBe("now");
	});

	it("formats minutes alone", () => {
		expect(formatResetCompact(iso(45), FIVE_HOUR_WINDOW_MS, now)).toBe("45m");
	});

	it("always shows both units, including whole hours", () => {
		expect(formatResetCompact(iso(3 * 60), FIVE_HOUR_WINDOW_MS, now)).toBe(
			"3h0m",
		);
		expect(formatResetCompact(iso(3 * 60 + 12), FIVE_HOUR_WINDOW_MS, now)).toBe(
			"3h12m",
		);
	});

	it("formats days and hours, dropping minutes", () => {
		expect(
			formatResetCompact(
				iso(6 * 24 * 60 + 17 * 60 + 59),
				WEEKLY_WINDOW_MS,
				now,
			),
		).toBe("6d17h");
	});

	it("floors part units rather than rounding", () => {
		const halfMinuteOut = new Date(now + 30_000).toISOString();
		expect(formatResetCompact(halfMinuteOut, FIVE_HOUR_WINDOW_MS, now)).toBe(
			"0m",
		);
	});

	it("caps a reset beyond the window at the window", () => {
		expect(formatResetCompact(iso(3 * 5 * 60), FIVE_HOUR_WINDOW_MS, now)).toBe(
			"5h0m",
		);
	});

	it("returns an empty string for null or an unparseable timestamp", () => {
		expect(formatResetCompact(null, FIVE_HOUR_WINDOW_MS, now)).toBe("");
		expect(formatResetCompact("not-a-date", FIVE_HOUR_WINDOW_MS, now)).toBe("");
	});
});
