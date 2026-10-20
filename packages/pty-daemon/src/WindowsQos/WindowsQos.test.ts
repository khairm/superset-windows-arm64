import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
	QOS_HELPER_COMMAND,
	QOS_HELPER_CS,
	QOS_HELPER_CS_ENV,
	QOS_HELPER_PTYD_ENV,
} from "./helper-script.ts";
import {
	createWindowsQos,
	startWindowsQos,
	type WindowsQosDeps,
} from "./WindowsQos.ts";

const READY = "ready arch=ARM64 compileMs=900 ptydTagged=1";
const READY_UNTAGGED = "ready arch=ARM64 compileMs=900 ptydTagged=0";
const STATS =
	"stats tagged=3 raced=0 recycled=0 unreachable=0 unknown=0 errors=0 procs=740 tickMs=22/42 cpuMs=1200";

class FakeStdin extends EventEmitter {
	ended = false;
	end(): void {
		this.ended = true;
	}
}

class FakeStdout extends EventEmitter {
	setEncoding(): void {}
}

class FakeChild extends EventEmitter {
	stdin = new FakeStdin();
	stdout = new FakeStdout();
	unrefs = 0;
	kills = 0;
	readonly pid: number | undefined;
	constructor(pid: number | undefined) {
		super();
		this.pid = pid;
	}
	unref(): void {
		this.unrefs++;
	}
	kill(): boolean {
		this.kills++;
		return true;
	}
	say(line: string): void {
		this.stdout.emit("data", `${line}\n`);
	}
}

type SpawnCall = {
	command: string;
	args: string[];
	options: Parameters<WindowsQosDeps["spawn"]>[2];
};

function harness(spawnFailures: ("enoent" | "throw")[] = []) {
	let clock = 0;
	let timers: { at: number; fn: () => void }[] = [];
	const lines: string[] = [];
	const children: FakeChild[] = [];
	const spawns: SpawnCall[] = [];
	let nextPid = 100;
	const deps: WindowsQosDeps = {
		platform: "win32",
		spawn: (command, args, options) => {
			spawns.push({ command, args, options });
			const failure = spawnFailures.shift();
			if (failure === "throw") {
				throw Object.assign(new Error("spawn EINVAL"), { code: "EINVAL" });
			}
			const child = new FakeChild(failure === "enoent" ? undefined : nextPid++);
			children.push(child);
			return child as unknown as ReturnType<WindowsQosDeps["spawn"]>;
		},
		now: () => clock,
		setTimeout: (fn, ms) => {
			timers.push({ at: clock + ms, fn });
		},
		log: (line) => lines.push(line),
		env: { SystemRoot: "C:\\Windows" },
	};
	return {
		deps,
		lines,
		children,
		spawns,
		latest: () => children.at(-1) as FakeChild,
		errors: () => lines.filter((line) => line.includes(" error ")),
		advance: (ms: number) => {
			const end = clock + ms;
			for (;;) {
				const due = timers
					.filter((timer) => timer.at <= end)
					.sort((a, b) => a.at - b.at)[0];
				if (!due) break;
				timers = timers.filter((timer) => timer !== due);
				clock = due.at;
				due.fn();
			}
			clock = end;
		},
	};
}

describe("createWindowsQos", () => {
	test("does nothing off Windows", () => {
		const h = harness();
		const qos = createWindowsQos({ ...h.deps, platform: "linux" });
		expect(h.spawns).toEqual([]);
		expect(h.lines).toEqual([]);
		expect(qos.state).toBe("stopped");
	});

	test("spawns System32 Windows PowerShell hidden, attached, stderr inherited", () => {
		const h = harness();
		createWindowsQos(h.deps);
		expect(h.spawns).toEqual([
			{
				command:
					"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
				args: ["-NoProfile", "-NonInteractive", "-Command", QOS_HELPER_COMMAND],
				options: {
					windowsHide: true,
					stdio: ["pipe", "pipe", "inherit"],
					env: {
						SystemRoot: "C:\\Windows",
						[QOS_HELPER_CS_ENV]: QOS_HELPER_CS,
						[QOS_HELPER_PTYD_ENV]: String(process.pid),
					},
				},
			},
		]);
	});

	test("a tagged ready line makes it ready; every transition logs the marker", () => {
		const h = harness();
		const qos = createWindowsQos(h.deps);
		expect(qos.state).toBe("starting");
		h.latest().say(READY);
		expect(qos.state).toBe("ready");
		expect(h.lines).toContain(`[pty-daemon] (WIN-TERMINAL-HIGHQOS) ${READY}`);
		expect(h.lines).toContain(
			"[pty-daemon] (WIN-TERMINAL-HIGHQOS) state starting -> ready",
		);
	});

	test("an untagged ready is degraded and stats never tag it", () => {
		const h = harness();
		const qos = createWindowsQos(h.deps);
		h.latest().say(READY_UNTAGGED);
		expect(qos.state).toBe("degraded");
		h.latest().say(STATS);
		expect(qos.state).toBe("degraded");
	});

	test("lines from an older helper are ignored", () => {
		const h = harness();
		const qos = createWindowsQos(h.deps);
		const first = h.latest();
		first.emit("exit", 1, null);
		h.advance(2_000);
		expect(h.children).toHaveLength(2);
		first.say(READY);
		expect(qos.state).toBe("starting");
	});

	test("malformed frames are dropped and logged once per window with a count", () => {
		const h = harness();
		const qos = createWindowsQos(h.deps);
		const child = h.latest();
		child.say("ready arch=ARM64 compileMs=900");
		child.say("ready arch=ARM64 compileMs=nine ptydTagged=1");
		child.say("hello arch=ARM64 compileMs=900 ptydTagged=1");
		child.stdout.emit("data", "x".repeat(300));
		child.say("tail of the oversized frame");
		expect(qos.state).toBe("starting");
		const frameLines = () => h.lines.filter((l) => l.includes("helper-frame"));
		expect(frameLines()).toHaveLength(1);
		expect(frameLines()[0]).toContain("count=1");
		h.advance(60_000);
		expect(frameLines()).toHaveLength(2);
		expect(frameLines()[1]).toContain("count=3");
		h.advance(60_000);
		expect(frameLines()).toHaveLength(2);
	});

	test("no ready by 60 s logs one error and degrades without killing the helper", () => {
		const h = harness();
		const qos = createWindowsQos(h.deps);
		h.advance(60_000);
		expect(qos.state).toBe("degraded");
		expect(h.errors()).toHaveLength(1);
		expect(h.errors()[0]).toContain("op=helper-ready");
		expect(h.latest().kills).toBe(0);
		expect(h.latest().stdin.ended).toBe(false);
		h.latest().say(READY);
		expect(qos.state).toBe("ready");
	});

	test("180 s without a heartbeat degrades; a later stats line restores it", () => {
		const h = harness();
		const qos = createWindowsQos(h.deps);
		h.latest().say(READY);
		h.advance(179_999);
		expect(qos.state).toBe("ready");
		h.advance(1);
		expect(qos.state).toBe("degraded");
		h.latest().say(STATS);
		expect(qos.state).toBe("ready");
	});

	test("restarts with doubling backoff capped at 10 min, reset after 10 min ready", () => {
		const h = harness();
		const qos = createWindowsQos(h.deps);
		const delays = [
			2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000, 512_000,
			600_000, 600_000,
		];
		for (const [index, delay] of delays.entries()) {
			h.latest().emit("exit", 1, null);
			expect(qos.state).toBe("degraded");
			h.advance(delay - 1);
			expect(h.children).toHaveLength(index + 1);
			h.advance(1);
			expect(h.children).toHaveLength(index + 2);
			expect(qos.state).toBe("starting");
		}
		expect(h.errors()).toHaveLength(delays.length);
		expect(h.errors().at(-1)).toContain(
			`op=helper-exit code=1 attempt=${delays.length} retryMs=600000`,
		);

		h.latest().say(READY);
		for (let minute = 0; minute < 10; minute++) {
			h.advance(60_000);
			h.latest().say(STATS);
		}
		h.latest().emit("exit", 1, null);
		h.advance(2_000);
		expect(h.children).toHaveLength(delays.length + 2);
	});

	test.each([
		["'error' then 'close'", "enoent", "ENOENT"],
		["a throwing spawn", "throw", "EINVAL"],
	] as const)("spawn failure (%s) schedules one retry and recovers", (_label, failure, code) => {
		const h = harness([failure]);
		const qos = createWindowsQos(h.deps);
		if (failure === "enoent") {
			const failed = h.latest();
			failed.emit("error", Object.assign(new Error("spawn ENOENT"), { code }));
			failed.emit("close", -4058, null);
		}
		expect(qos.state).toBe("degraded");
		expect(h.errors()).toEqual([
			`[pty-daemon] (WIN-TERMINAL-HIGHQOS) error op=helper-spawn code=${code} attempt=1 retryMs=2000`,
		]);
		h.advance(2_000);
		expect(h.spawns).toHaveLength(2);
		h.advance(600_000);
		expect(h.spawns).toHaveLength(2);
		h.latest().say(READY);
		expect(qos.state).toBe("ready");
	});

	test("child, stdin and stdout errors are logged and never thrown", () => {
		const h = harness();
		const qos = createWindowsQos(h.deps);
		const child = h.latest();
		child.say(READY);
		child.emit("error", new Error("kill failed"));
		child.stdin.emit("error", Object.assign(new Error("x"), { code: "EPIPE" }));
		child.stdout.emit("error", new Error("read failed"));
		expect(h.errors()).toEqual([
			"[pty-daemon] (WIN-TERMINAL-HIGHQOS) error op=helper-child code=Error",
			"[pty-daemon] (WIN-TERMINAL-HIGHQOS) error op=helper-stdin code=EPIPE",
			"[pty-daemon] (WIN-TERMINAL-HIGHQOS) error op=helper-stdout code=Error",
		]);
		expect(qos.state).toBe("ready");
		expect(h.children).toHaveLength(1);
	});

	test("stop() ends stdin, never restarts and reports stopped", () => {
		const h = harness();
		const qos = createWindowsQos(h.deps);
		const child = h.latest();
		child.say(READY);
		qos.stop();
		expect(child.stdin.ended).toBe(true);
		expect(child.unrefs).toBe(1);
		expect(qos.state).toBe("stopped");
		child.emit("exit", 0, null);
		h.advance(600_000);
		expect(h.children).toHaveLength(1);
		expect(h.errors()).toEqual([]);
		expect(qos.state).toBe("stopped");
	});
});

test("startWindowsQos returns the first handle on a second call", () => {
	const h = harness();
	const first = startWindowsQos(h.deps);
	const second = startWindowsQos(h.deps);
	expect(second).toBe(first);
	expect(h.spawns).toHaveLength(1);
});
