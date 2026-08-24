import { describe, expect, test } from "bun:test";
import { mapConcurrent } from "../lib/map-concurrent";

describe("mapConcurrent", () => {
	test("does not exceed the requested concurrency", async () => {
		let active = 0;
		let peak = 0;
		await mapConcurrent([1, 2, 3, 4, 5, 6, 7], 3, async () => {
			active += 1;
			peak = Math.max(peak, active);
			await Bun.sleep(5);
			active -= 1;
		});
		expect(peak).toBe(3);
	});

	test("rejects invalid limits before starting work", async () => {
		let started = false;
		await expect(
			mapConcurrent([1], 0, async () => {
				started = true;
			}),
		).rejects.toThrow("positive integer");
		expect(started).toBe(false);
	});
});
