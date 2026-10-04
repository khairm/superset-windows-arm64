import { describe, expect, it } from "bun:test";
import { hasDueSnooze, hasTimedSnooze } from "./hasDueSnooze";

const NOW = 1_700_000_000_000;

describe("hasTimedSnooze", () => {
	it("ignores null, undefined and launch-only rows", () => {
		expect(hasTimedSnooze([])).toBe(false);
		expect(hasTimedSnooze([{ snoozeUntil: null }])).toBe(false);
		expect(hasTimedSnooze([{ snoozeUntil: undefined }, {}])).toBe(false);
	});

	it("is true for any numeric deadline, past or future", () => {
		expect(
			hasTimedSnooze([{ snoozeUntil: null }, { snoozeUntil: NOW + 1 }]),
		).toBe(true);
		expect(hasTimedSnooze([{ snoozeUntil: NOW - 1 }])).toBe(true);
	});
});

describe("hasDueSnooze", () => {
	it("ignores null, undefined and launch-only rows", () => {
		expect(hasDueSnooze([], NOW)).toBe(false);
		expect(hasDueSnooze([{ snoozeUntil: null }, {}], NOW)).toBe(false);
	});

	it("is false while every deadline is in the future", () => {
		expect(hasDueSnooze([{ snoozeUntil: NOW + 1 }], NOW)).toBe(false);
	});

	it("is true when a deadline is past or equal to now", () => {
		expect(
			hasDueSnooze(
				[{ snoozeUntil: NOW + 60_000 }, { snoozeUntil: NOW - 1 }],
				NOW,
			),
		).toBe(true);
		expect(hasDueSnooze([{ snoozeUntil: NOW }], NOW)).toBe(true);
	});
});
