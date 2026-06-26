// (AUTO-RESUME) tests for the timezone/DST-aware reset-time resolver.
import { describe, expect, test } from "bun:test";
import {
	parseResetText,
	resolveResetTime,
	zonedWallTimeToEpoch,
} from "./reset-time";

const LONDON = "Europe/London";

describe("parseResetText", () => {
	test("session time, no minutes", () => {
		expect(parseResetText("3pm")).toEqual({
			month: undefined,
			day: undefined,
			year: undefined,
			hour: 15,
			minute: 0,
		});
	});
	test("session time with minutes", () => {
		expect(parseResetText("3:30am")).toMatchObject({ hour: 3, minute: 30 });
	});
	test("12am -> 00:00", () => {
		expect(parseResetText("12am")).toMatchObject({ hour: 0, minute: 0 });
	});
	test("12pm -> 12:00", () => {
		expect(parseResetText("12:30pm")).toMatchObject({ hour: 12, minute: 30 });
	});
	test("weekly dated form (Claude)", () => {
		expect(parseResetText("Jun 17, 1am")).toMatchObject({
			month: 5,
			day: 17,
			year: undefined,
			hour: 1,
			minute: 0,
		});
	});
	test("dated form with year + ordinal + caps (Codex)", () => {
		expect(parseResetText("May 31st, 2026 12:58 AM")).toMatchObject({
			month: 4,
			day: 31,
			year: 2026,
			hour: 0,
			minute: 58,
		});
	});
	test("rejects garbage", () => {
		expect(parseResetText("soon-ish")).toBeNull();
	});
});

describe("zonedWallTimeToEpoch", () => {
	test("London winter (GMT) 3:30 == 03:30Z", () => {
		// 2026-01-15 is GMT (UTC+0)
		const epoch = zonedWallTimeToEpoch(2026, 0, 15, 3, 30, LONDON);
		expect(new Date(epoch).toISOString()).toBe("2026-01-15T03:30:00.000Z");
	});
	test("London summer (BST) 3:30 == 02:30Z", () => {
		// 2026-06-17 is BST (UTC+1)
		const epoch = zonedWallTimeToEpoch(2026, 5, 17, 3, 30, LONDON);
		expect(new Date(epoch).toISOString()).toBe("2026-06-17T02:30:00.000Z");
	});
	test("London fall-overlap 01:30 picks the EARLIER instant (00:30Z)", () => {
		// 2026-10-25 02:00 BST -> 01:00 GMT; 01:30 occurs twice (00:30Z BST, 01:30Z GMT).
		const epoch = zonedWallTimeToEpoch(2026, 9, 25, 1, 30, LONDON);
		expect(new Date(epoch).toISOString()).toBe("2026-10-25T00:30:00.000Z");
	});
});

describe("resolveResetTime", () => {
	const anchor = Date.UTC(2026, 5, 17, 1, 0, 0); // 2026-06-17 01:00Z (BST 02:00)

	test("session time later today -> at", () => {
		// anchor BST 02:00; "3am" BST -> 02:00Z; that's after anchor? 03:00 BST = 02:00Z == anchor.
		const now = anchor;
		const r = resolveResetTime("4am", LONDON, anchor, now);
		expect(r.kind).toBe("at");
		if (r.kind === "at")
			expect(new Date(r.epochMs).toISOString()).toBe(
				"2026-06-17T03:00:00.000Z",
			);
	});

	test("session time already elapsed vs now -> fire-now", () => {
		// reset 3am, but now is much later same day
		const now = Date.UTC(2026, 5, 17, 20, 0, 0);
		const r = resolveResetTime("3am", LONDON, anchor, now);
		expect(r.kind).toBe("fire-now");
	});

	test("weekly with month/day in the future -> at", () => {
		const r = resolveResetTime("Jun 18, 1am", LONDON, anchor, anchor);
		expect(r.kind).toBe("at");
	});

	test("weekly far in the future (>8d) -> stale", () => {
		const r = resolveResetTime("Jul 30, 1am", LONDON, anchor, anchor);
		expect(r.kind).toBe("stale");
	});

	test("stale overnight reset re-armed after restart -> fire-now (not +24h)", () => {
		// failure anchored yesterday; reset 3am yesterday; now is today
		const oldAnchor = Date.UTC(2026, 5, 16, 1, 0, 0);
		const now = Date.UTC(2026, 5, 17, 9, 0, 0);
		const r = resolveResetTime("3am", LONDON, oldAnchor, now);
		expect(r.kind).toBe("fire-now");
	});

	test("unparseable -> unparsed", () => {
		const r = resolveResetTime("whenever", LONDON, anchor, anchor);
		expect(r.kind).toBe("unparsed");
	});

	test("NaN anchor (unparseable record timestamp) does not throw", () => {
		const now = Date.UTC(2026, 5, 17, 1, 0, 0);
		expect(() =>
			resolveResetTime("3am", LONDON, Number.NaN, now),
		).not.toThrow();
	});
});
