import { describe, expect, test } from "bun:test";
import {
	collectProcessSignalTargets,
	collectWindowsLatchedTargets,
	collectWindowsSignalTargets,
	IS_WINDOWS,
	type ProcessInfo,
	parseProcessTable,
	parseWindowsProcessTable,
	readProcessTableAsync,
} from "./process-tree.ts";

describe("parseProcessTable", () => {
	test("parses pid/ppid/pgid/tty columns", () => {
		const rows = parseProcessTable(
			[
				"  100   1  100 ttys012  Ss",
				"  200 100  100 ttys012  S",
				"  300   1  300 ??       S",
			].join("\n"),
		);
		expect(rows).toEqual([
			{ pid: 100, ppid: 1, pgid: 100, tty: "ttys012" },
			{ pid: 200, ppid: 100, pgid: 100, tty: "ttys012" },
			{ pid: 300, ppid: 1, pgid: 300, tty: null },
		]);
	});

	test("normalizes no-tty markers to null", () => {
		for (const marker of ["??", "?", "-"]) {
			const rows = parseProcessTable(`  100   1  100 ${marker}  S`);
			expect(rows[0]?.tty).toBeNull();
		}
	});

	test("drops zombie rows", () => {
		const rows = parseProcessTable(
			["  100   1  100 ttys000  Ss", "  200 100  100 ttys000  Z"].join("\n"),
		);
		expect(rows.map((r) => r.pid)).toEqual([100]);
	});

	test("drops malformed rows", () => {
		const rows = parseProcessTable(
			["garbage", "  0  1  1 ?? S", "  100  1  0 ?? S", ""].join("\n"),
		);
		expect(rows).toEqual([]);
	});
});

// (WIN-PROCESS-TREE) Pure functions over synthetic tables — they run on every
// platform, so the Windows tree logic is covered from a POSIX CI too.

describe("parseWindowsProcessTable", () => {
	test("parses pid/ppid/start-time columns", () => {
		const rows = parseWindowsProcessTable(
			["100 4 20260818134820", "200 100 20260818134821"].join("\n"),
		);
		expect(rows).toEqual([
			{
				pid: 100,
				ppid: 4,
				pgid: 0,
				tty: null,
				startedAt: 20260818134820,
			},
			{
				pid: 200,
				ppid: 100,
				pgid: 0,
				tty: null,
				startedAt: 20260818134821,
			},
		]);
	});

	test("a missing CreationDate becomes a null start time, not a zero", () => {
		const [row] = parseWindowsProcessTable("4 0 ");
		expect(row?.pid).toBe(4);
		expect(row?.startedAt).toBeNull();
	});

	test("drops malformed rows", () => {
		expect(
			parseWindowsProcessTable(
				["garbage", "0 4 20260818134820", "abc def ghi", ""].join("\n"),
			),
		).toEqual([]);
	});
});

const winRow = (
	pid: number,
	ppid: number,
	startedAt: number | null,
): ProcessInfo => ({ pid, ppid, pgid: 0, tty: null, startedAt });

describe("collectWindowsSignalTargets", () => {
	const table = [
		winRow(100, 4, 20260818134820),
		winRow(200, 100, 20260818134821),
		winRow(300, 200, 20260818134822),
		winRow(900, 4, 20260818134820),
	];

	test("walks the whole descendant tree", () => {
		const targets = collectWindowsSignalTargets(100, {
			table,
			rootStartedAt: 20260818134820,
			includeRoot: true,
		});
		expect(targets.map((t) => t.id)).toEqual([100, 200, 300]);
		expect(targets.every((t) => t.target === "pid")).toBe(true);
	});

	test("excludes the root when asked", () => {
		const targets = collectWindowsSignalTargets(100, {
			table,
			rootStartedAt: 20260818134820,
			includeRoot: false,
		});
		expect(targets.map((t) => t.id)).toEqual([200, 300]);
	});

	test("pid reuse: a root whose start time changed targets NOTHING", () => {
		expect(
			collectWindowsSignalTargets(100, {
				table,
				rootStartedAt: 20260818134700,
				includeRoot: true,
			}),
		).toEqual([]);
	});

	test("pid reuse: an anchored root with an unreadable start time targets NOTHING", () => {
		expect(
			collectWindowsSignalTargets(100, {
				table: [winRow(100, 4, null), winRow(200, 100, 20260818134821)],
				rootStartedAt: 20260818134820,
				includeRoot: true,
			}),
		).toEqual([]);
	});

	test("pid reuse: a child that predates its parent is not ours", () => {
		const targets = collectWindowsSignalTargets(100, {
			table: [
				winRow(100, 4, 20260818134820),
				// Started an hour before its "parent" — an orphan whose real
				// parent died and whose pid was recycled as 100.
				winRow(200, 100, 20260818124800),
				winRow(300, 200, 20260818134822),
			],
			rootStartedAt: 20260818134820,
			includeRoot: false,
		});
		expect(targets).toEqual([]);
	});

	test("a candidate with no readable start time is left alone", () => {
		const targets = collectWindowsSignalTargets(100, {
			table: [winRow(100, 4, 20260818134820), winRow(200, 100, null)],
			rootStartedAt: 20260818134820,
			includeRoot: false,
		});
		expect(targets).toEqual([]);
	});

	test("walks without an anchor when no capture ever succeeded", () => {
		const targets = collectWindowsSignalTargets(100, {
			table,
			includeRoot: false,
		});
		expect(targets.map((t) => t.id)).toEqual([200, 300]);
	});

	test("a missing root row targets nothing", () => {
		expect(
			collectWindowsSignalTargets(999, { table, includeRoot: true }),
		).toEqual([]);
	});

	test("never targets this process", () => {
		const targets = collectWindowsSignalTargets(100, {
			table: [
				winRow(100, 4, 20260818134820),
				winRow(process.pid, 100, 20260818134821),
			],
			rootStartedAt: 20260818134820,
			includeRoot: false,
		});
		expect(targets).toEqual([]);
	});
});

describe("collectWindowsLatchedTargets", () => {
	test("re-targets a descendant the root no longer reaches", () => {
		// The root row is gone; only the latch knows 200 is still ours.
		const targets = collectWindowsLatchedTargets(
			new Map([[200, 20260818134821]]),
			[winRow(200, 100, 20260818134821)],
		);
		expect(targets).toEqual([{ target: "pid", id: 200 }]);
	});

	test("drops a latched pid that has been recycled", () => {
		expect(
			collectWindowsLatchedTargets(new Map([[200, 20260818134821]]), [
				winRow(200, 1, 20260818140000),
			]),
		).toEqual([]);
	});

	test("drops a latched pid that is gone", () => {
		expect(
			collectWindowsLatchedTargets(new Map([[200, 20260818134821]]), []),
		).toEqual([]);
	});
});

// The regression this guards: readProcessTable() has no synchronous Windows
// implementation, so every synchronous caller sees an empty table. Before the
// Windows branch existed, that empty table still produced one target — the
// root pid — and process.kill terminates it perfectly well on Windows.
// Returning [] instead would silently no-op the daemon supervisor's terminate
// path and clean-shell-env's timeout kill. POSIX has a real sync `ps`, so this
// degenerate path only exists on Windows.
describe.if(IS_WINDOWS)("collectProcessSignalTargets on Windows", () => {
	test("an empty synchronous table still targets the root pid", () => {
		expect(collectProcessSignalTargets(4242)).toEqual([
			{ target: "pid", id: 4242 },
		]);
	});

	test("the fallback honours includeRoot: false", () => {
		expect(collectProcessSignalTargets(4242, { includeRoot: false })).toEqual(
			[],
		);
	});

	// The v1 terminal-host stack passes signalPids:false because node-pty's own
	// kill is meant to be the sole path to the root. At HEAD an empty table gave
	// that caller nothing; the fallback must not start hard-killing the root.
	test("the fallback honours signalPids: false", () => {
		expect(collectProcessSignalTargets(4242, { signalPids: false })).toEqual(
			[],
		);
	});

	test("a real table takes the reuse-guarded walk", () => {
		expect(
			collectProcessSignalTargets(100, {
				table: [
					winRow(100, 4, 20260818134820),
					winRow(200, 100, 20260818134821),
				],
			}).map((t) => t.id),
		).toEqual([100, 200]);
	});

	// Each enumeration spawns PowerShell (~590ms) and every session's kill chain
	// enumerates six times, so concurrent kills must share one read rather than
	// each starting their own. Identity of the returned promise IS the
	// invariant; awaiting a real enumeration here would make the test race
	// PowerShell startup under a loaded suite.
	test("concurrent reads join a single in-flight enumeration", () => {
		const a = readProcessTableAsync();
		const b = readProcessTableAsync();
		expect(a).toBe(b);
	});
});

describe("collectProcessSignalTargets — caller-ancestry protection", () => {
	const row = (
		pid: number,
		ppid: number,
		pgid: number,
		tty: string | null = null,
	) => ({ pid, ppid, pgid, tty });

	test("never signals a group the caller's ancestor chain belongs to", () => {
		// A target-tree member sharing a pgid with the caller's ancestor
		// (a process that never called setsid) must not drag the invoking
		// shell/terminal/test-runner into a killpg — this has SIGKILLed
		// developer sessions.
		const table = [
			row(process.pid, 4000, 5000),
			row(4000, 1, 4500), // caller's ancestor
			row(100, 1, 100), // kill root
			row(101, 100, 4500), // tree member colliding with ancestor's group
			row(102, 100, 102), // tree member in its own group
		];
		const targets = collectProcessSignalTargets(100, { table });
		const pgids = targets.filter((t) => t.target === "pgid").map((t) => t.id);
		const pids = targets.filter((t) => t.target === "pid").map((t) => t.id);
		expect(pgids).not.toContain(4500);
		expect(pgids).not.toContain(5000);
		expect(pgids).toEqual(expect.arrayContaining([100, 102]));
		// The colliding tree member itself is still signalled by pid.
		expect(pids).toEqual(expect.arrayContaining([100, 101, 102]));
		expect(pids).not.toContain(4000);
		expect(pids).not.toContain(process.pid);
	});

	test("tty straggler matching never adds the caller's ancestors", () => {
		const table = [
			row(process.pid, 4000, 5000, "ttys009"),
			row(4000, 1, 4500, "ttys009"), // ancestor on the same tty
			row(100, 1, 100, "ttys009"), // kill root on the session tty
			row(900, 1, 900, "ttys009"), // unrelated straggler on the tty
		];
		const targets = collectProcessSignalTargets(100, {
			table,
			ttyName: "ttys009",
		});
		const pids = targets.filter((t) => t.target === "pid").map((t) => t.id);
		expect(pids).toEqual(expect.arrayContaining([100, 900]));
		expect(pids).not.toContain(4000);
		expect(pids).not.toContain(process.pid);
	});
});
