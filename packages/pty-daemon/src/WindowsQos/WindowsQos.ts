// (WIN-TERMINAL-HIGHQOS) Keeps the QoS helper (helper-script.ts) running for
// the life of ptyd. A helper fault costs terminal speed only, never a terminal.

import {
	type ChildProcessByStdio,
	type SpawnOptionsWithStdioTuple,
	type StdioNull,
	type StdioPipe,
	spawn,
} from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { windowsPowerShellPath } from "../process-tree.ts";
import {
	QOS_HELPER_COMMAND,
	QOS_HELPER_CS,
	QOS_HELPER_CS_ENV,
	QOS_HELPER_LINE_KEYS,
	QOS_HELPER_MAX_LINE_BYTES,
	QOS_HELPER_PTYD_ENV,
} from "./helper-script.ts";

const LOG_PREFIX = "[pty-daemon] (WIN-TERMINAL-HIGHQOS)";
const READY_DEADLINE_MS = 60_000;
const HEARTBEAT_MS = 180_000;
const RESTART_FIRST_MS = 2_000;
const RESTART_CAP_MS = 600_000;
const BACKOFF_RESET_MS = 600_000;
const MALFORMED_WINDOW_MS = 60_000;
const MALFORMED_SAMPLE_CHARS = 64;

export type WindowsQosState = "starting" | "ready" | "degraded" | "stopped";

export interface WindowsQosHandle {
	readonly state: WindowsQosState;
	stop(): void;
}

type HelperChild = ChildProcessByStdio<Writable, Readable, null>;

export interface WindowsQosDeps {
	platform: NodeJS.Platform;
	spawn: (
		command: string,
		args: string[],
		options: SpawnOptionsWithStdioTuple<StdioPipe, StdioPipe, StdioNull>,
	) => HelperChild;
	now: () => number;
	setTimeout: (fn: () => void, ms: number) => void;
	log: (line: string) => void;
	env: NodeJS.ProcessEnv;
}

const REAL_DEPS: WindowsQosDeps = {
	platform: process.platform,
	spawn,
	now: () => performance.now(),
	setTimeout: (fn, ms) => {
		setTimeout(fn, ms).unref();
	},
	log: (line) => {
		process.stderr.write(`${line}\n`);
	},
	env: process.env,
};

type HelperLineKind = keyof typeof QOS_HELPER_LINE_KEYS;

export interface HelperLine {
	kind: HelperLineKind;
	fields: Record<string, string>;
}

const isInteger = (value: string) => /^-?\d+$/.test(value);

const FIELD_CHECKS: Record<string, (value: string) => boolean> = {
	arch: (value) => /^[A-Za-z0-9_]{1,16}$/.test(value),
	ptydTagged: (value) => value === "0" || value === "1",
	tickMs: (value) => /^\d+\/\d+$/.test(value),
	op: (value) => /^[a-z-]{1,24}$/.test(value),
};

function isLineKind(token: string): token is HelperLineKind {
	return Object.hasOwn(QOS_HELPER_LINE_KEYS, token);
}

/** A frame is valid only with its token's exact keys, in order, each value checked. */
export function parseHelperLine(line: string): HelperLine | null {
	if (Buffer.byteLength(line) >= QOS_HELPER_MAX_LINE_BYTES) return null;
	const [kind, ...pairs] = line.split(" ");
	if (kind === undefined || !isLineKind(kind)) return null;
	const keys: readonly string[] = QOS_HELPER_LINE_KEYS[kind];
	if (pairs.length !== keys.length) return null;
	const fields: Record<string, string> = {};
	for (const [index, key] of keys.entries()) {
		const pair = pairs[index];
		if (pair === undefined || !pair.startsWith(`${key}=`)) return null;
		const value = pair.slice(key.length + 1);
		if (!(FIELD_CHECKS[key] ?? isInteger)(value)) return null;
		fields[key] = value;
	}
	return { kind, fields };
}

function errorCode(error: unknown): string {
	if (error instanceof Error) {
		return (error as NodeJS.ErrnoException).code ?? error.name;
	}
	return String(error);
}

interface Generation {
	child?: HelperChild;
	ended: boolean;
	pending: string;
	skipToNewline: boolean;
	readySeen: boolean;
	tagged: boolean;
	overdue: boolean;
	lastBeat: number | null;
}

export function createWindowsQos(
	overrides: Partial<WindowsQosDeps> = {},
): WindowsQosHandle {
	const deps: WindowsQosDeps = { ...REAL_DEPS, ...overrides };
	if (deps.platform !== "win32") return { state: "stopped", stop: () => {} };

	const log = (message: string) => deps.log(`${LOG_PREFIX} ${message}`);
	let state: WindowsQosState = "starting";
	let stopped = false;
	let current: Generation | undefined;
	let failures = 0;
	let readySince: number | null = null;
	let malformedCount = 0;
	let malformedSample = "";
	let malformedWindowOpen = false;

	function derive(): WindowsQosState {
		if (stopped) return "stopped";
		if (!current || current.ended) return "degraded";
		const heartbeat =
			current.lastBeat !== null && deps.now() - current.lastBeat < HEARTBEAT_MS;
		if (current.tagged && heartbeat) return "ready";
		return current.readySeen || current.overdue ? "degraded" : "starting";
	}

	function refresh(): void {
		const next = derive();
		if (next === state) return;
		if (readySince !== null && deps.now() - readySince >= BACKOFF_RESET_MS) {
			failures = 0;
		}
		readySince = next === "ready" ? deps.now() : null;
		log(`state ${state} -> ${next}`);
		state = next;
	}

	function reportMalformed(): void {
		if (malformedCount === 0) {
			malformedWindowOpen = false;
			return;
		}
		log(
			`error op=helper-frame count=${malformedCount} last=${JSON.stringify(malformedSample.slice(0, MALFORMED_SAMPLE_CHARS))}`,
		);
		malformedCount = 0;
		malformedWindowOpen = true;
		deps.setTimeout(reportMalformed, MALFORMED_WINDOW_MS);
	}

	function malformed(frame: string): void {
		malformedCount++;
		malformedSample = frame;
		if (!malformedWindowOpen) reportMalformed();
	}

	function onLine(generation: Generation, line: string): void {
		const parsed = parseHelperLine(line);
		if (!parsed) {
			malformed(line);
			return;
		}
		log(line);
		if (parsed.kind === "error") return;
		if (parsed.kind === "ready") {
			generation.readySeen = true;
			if (parsed.fields.ptydTagged === "1") generation.tagged = true;
		}
		generation.lastBeat = deps.now();
		deps.setTimeout(refresh, HEARTBEAT_MS);
		refresh();
	}

	function onOutput(generation: Generation, chunk: string): void {
		if (generation !== current || stopped) return;
		try {
			generation.pending += chunk;
			let newline = generation.pending.indexOf("\n");
			while (newline !== -1) {
				const line = generation.pending.slice(0, newline);
				generation.pending = generation.pending.slice(newline + 1);
				if (generation.skipToNewline) generation.skipToNewline = false;
				else onLine(generation, line);
				newline = generation.pending.indexOf("\n");
			}
			if (Buffer.byteLength(generation.pending) >= QOS_HELPER_MAX_LINE_BYTES) {
				if (!generation.skipToNewline) malformed(generation.pending);
				generation.skipToNewline = true;
				generation.pending = "";
			}
		} catch (error) {
			log(`error op=helper-parse code=${errorCode(error)}`);
		}
	}

	function endGeneration(
		generation: Generation,
		op: string,
		code: string,
	): void {
		if (generation.ended) return;
		generation.ended = true;
		if (stopped) {
			log(`helper ended after stop op=${op} code=${code}`);
			return;
		}
		refresh();
		failures++;
		const retryMs = Math.min(
			RESTART_FIRST_MS * 2 ** (failures - 1),
			RESTART_CAP_MS,
		);
		log(`error op=${op} code=${code} attempt=${failures} retryMs=${retryMs}`);
		deps.setTimeout(() => {
			if (!stopped) spawnHelper();
		}, retryMs);
	}

	function spawnHelper(): void {
		const generation: Generation = {
			ended: false,
			pending: "",
			skipToNewline: false,
			readySeen: false,
			tagged: false,
			overdue: false,
			lastBeat: null,
		};
		current = generation;
		let child: HelperChild;
		try {
			child = deps.spawn(
				windowsPowerShellPath(deps.env),
				["-NoProfile", "-NonInteractive", "-Command", QOS_HELPER_COMMAND],
				{
					windowsHide: true,
					stdio: ["pipe", "pipe", "inherit"],
					env: {
						...deps.env,
						[QOS_HELPER_CS_ENV]: QOS_HELPER_CS,
						[QOS_HELPER_PTYD_ENV]: String(process.pid),
					},
				},
			);
		} catch (error) {
			endGeneration(generation, "helper-spawn", errorCode(error));
			return;
		}
		generation.child = child;
		child.on("exit", (code, signal) =>
			endGeneration(generation, "helper-exit", String(code ?? signal)),
		);
		child.on("close", (code, signal) =>
			endGeneration(generation, "helper-close", String(code ?? signal)),
		);
		child.on("error", (error) => {
			if (child.pid === undefined) {
				endGeneration(generation, "helper-spawn", errorCode(error));
			} else {
				log(`error op=helper-child code=${errorCode(error)}`);
			}
		});
		child.stdin.on("error", (error) =>
			log(`error op=helper-stdin code=${errorCode(error)}`),
		);
		child.stdout.on("error", (error) =>
			log(`error op=helper-stdout code=${errorCode(error)}`),
		);
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => onOutput(generation, chunk));
		if (child.pid !== undefined) log(`helper started pid=${child.pid}`);
		refresh();
		deps.setTimeout(() => {
			if (stopped || generation !== current) return;
			if (generation.ended || generation.readySeen) return;
			generation.overdue = true;
			log(`error op=helper-ready code=timeout waitedMs=${READY_DEADLINE_MS}`);
			refresh();
		}, READY_DEADLINE_MS);
	}

	function stop(): void {
		if (stopped) return;
		stopped = true;
		refresh();
		if (current?.child && !current.ended) {
			current.child.stdin.end();
			current.child.unref();
		}
	}

	spawnHelper();
	return {
		get state() {
			return state;
		},
		stop,
	};
}

let started: WindowsQosHandle | undefined;

/** Once per process: a second call returns the first handle. */
export function startWindowsQos(
	deps: Partial<WindowsQosDeps> = {},
): WindowsQosHandle {
	started ??= createWindowsQos(deps);
	return started;
}
