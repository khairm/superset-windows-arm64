// (DAEMON-UNCAUGHT-GUARD) The guard's whole value is a judgement call —
// survive a per-session fault, exit on a burst — so both halves are pinned
// here. The recorder takes its clock and its exit hook, so the burst window is
// exercised without waiting a minute and without killing the test runner.

import { describe, expect, test } from "bun:test";
import {
	CRASH_BURST_LIMIT,
	CRASH_BURST_WINDOW_MS,
	createCrashRecorder,
} from "./crash-guard.ts";

interface Harness {
	lines: string[];
	exits: number[];
	record: (kind: string, error: unknown) => void;
	advance: (ms: number) => void;
}

function harness(): Harness {
	const lines: string[] = [];
	const exits: number[] = [];
	let clock = 1_000_000;
	const record = createCrashRecorder({
		write: (line) => lines.push(line),
		exit: (code) => exits.push(code),
		now: () => clock,
	});
	return {
		lines,
		exits,
		record,
		advance: (ms) => {
			clock += ms;
		},
	};
}

describe("createCrashRecorder", () => {
	test("logs the full stack and keeps the process alive", () => {
		const h = harness();
		const error = new Error("Signals not supported on windows.");
		h.record("exception", error);

		expect(h.exits).toEqual([]);
		expect(h.lines).toHaveLength(1);
		expect(h.lines[0]).toContain("UNCAUGHT exception");
		expect(h.lines[0]).toContain("sessions kept alive");
		expect(h.lines[0]).toContain("Signals not supported on windows.");
	});

	test("a non-Error rejection reason is still reported", () => {
		const h = harness();
		h.record("rejection", { code: "ENOENT" });
		expect(h.lines[0]).toContain("UNCAUGHT rejection");
		expect(h.exits).toEqual([]);
	});

	test(`survives ${CRASH_BURST_LIMIT} faults, exits on the next one`, () => {
		const h = harness();
		for (let i = 0; i < CRASH_BURST_LIMIT; i++) {
			h.record("exception", new Error(`fault ${i}`));
		}
		expect(h.exits).toEqual([]);

		h.record("exception", new Error("one too many"));
		expect(h.exits).toEqual([1]);
		expect(h.lines.at(-1)).toContain("burst exceeded");
	});

	test("faults older than the window do not count toward the burst", () => {
		const h = harness();
		for (let i = 0; i < CRASH_BURST_LIMIT; i++) {
			h.record("exception", new Error(`old fault ${i}`));
		}
		h.advance(CRASH_BURST_WINDOW_MS + 1);
		h.record("exception", new Error("a lone fault a minute later"));

		expect(h.exits).toEqual([]);
		expect(h.lines.at(-1)).toContain("(1 in the last");
	});

	test("recorders do not share a counter", () => {
		const a = harness();
		const b = harness();
		for (let i = 0; i <= CRASH_BURST_LIMIT; i++) {
			a.record("exception", new Error("noisy session"));
		}
		b.record("exception", new Error("first fault here"));

		expect(a.exits).toEqual([1]);
		expect(b.exits).toEqual([]);
	});
});
