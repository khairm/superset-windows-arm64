import { describe, expect, test } from "bun:test";
import { nextOccurrence } from "./nextOccurrence";

const NOW = new Date(2026, 9, 3, 14, 30, 15);

describe("nextOccurrence", () => {
	test("picks today when the time is strictly later than now", () => {
		expect(nextOccurrence({ hours: 14, minutes: 31 }, NOW)).toEqual({
			day: "today",
			at: new Date(2026, 9, 3, 14, 31),
		});
	});

	test.each([
		{ hours: 14, minutes: 30 },
		{ hours: 9, minutes: 0 },
	])("picks tomorrow for %j, which is not later than now", (time) => {
		expect(nextOccurrence(time, NOW)).toEqual({
			day: "tomorrow",
			at: new Date(2026, 9, 4, time.hours, time.minutes),
		});
	});

	test("rolls tomorrow over the end of the month", () => {
		const lastDay = new Date(2026, 9, 31, 23, 0);
		expect(nextOccurrence({ hours: 1, minutes: 5 }, lastDay)).toEqual({
			day: "tomorrow",
			at: new Date(2026, 10, 1, 1, 5),
		});
	});
});
