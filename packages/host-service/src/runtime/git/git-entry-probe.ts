import { lstat, realpath } from "node:fs/promises";
import * as path from "node:path";

export type GitEntryProbeResult = "present" | "absent" | "unknown";

export interface GitEntryProbeDeps {
	lstat(entryPath: string): Promise<unknown>;
	realpath(dirPath: string): Promise<string>;
	setTimeout(callback: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

export const defaultProbeDeps: GitEntryProbeDeps = {
	lstat: (entryPath) => lstat(entryPath),
	realpath: (dirPath) => realpath(dirPath),
	setTimeout: (callback, ms) => setTimeout(callback, ms),
	clearTimeout: (handle) =>
		clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const PROBE_CAP_MS = 2_000;
const MAX_ACTIVE_PROBES = 2;

interface ProbeControl {
	timedOut: boolean;
}

interface PendingProbe {
	control: ProbeControl;
	result: Promise<GitEntryProbeResult>;
}

const pending = new Map<string, PendingProbe>();
const activeProbes = new Set<ProbeControl>();

const isWin32 = process.platform === "win32";

function isUncPath(candidate: string): boolean {
	return /^[\\/]{2}/.test(candidate);
}

function samePath(a: string, b: string): boolean {
	return isWin32 ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function errorCode(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException | null)?.code;
}

async function entryAt(
	entryPath: string,
	deps: GitEntryProbeDeps,
): Promise<"hit" | "miss" | "error"> {
	try {
		await deps.lstat(entryPath);
		return "hit";
	} catch (error) {
		const code = errorCode(error);
		return code === "ENOENT" || code === "ENOTDIR" ? "miss" : "error";
	}
}

async function walkUp(
	start: string,
	deps: GitEntryProbeDeps,
	control: ProbeControl,
): Promise<GitEntryProbeResult> {
	let level = start;
	for (;;) {
		if (control.timedOut) return "unknown";
		const gitEntry = await entryAt(path.join(level, ".git"), deps);
		if (gitEntry === "hit") return "present";
		if (gitEntry === "error") return "unknown";
		if (control.timedOut) return "unknown";
		if ((await entryAt(path.join(level, "HEAD"), deps)) !== "miss") {
			return "unknown";
		}
		const parent = path.dirname(level);
		if (parent === level) return "absent";
		level = parent;
	}
}

async function walk(
	logical: string,
	deps: GitEntryProbeDeps,
	control: ProbeControl,
): Promise<GitEntryProbeResult> {
	const fromLogical = await walkUp(logical, deps, control);
	if (fromLogical !== "absent") return fromLogical;
	if (control.timedOut) return "unknown";
	let real: string;
	try {
		real = await deps.realpath(logical);
	} catch (error) {
		return errorCode(error) === "ENOENT" ? "absent" : "unknown";
	}
	if (isUncPath(real)) return "unknown";
	if (samePath(real, logical)) return "absent";
	return walkUp(real, deps, control);
}

// (HOST-LAUNCH-DISK-PROBE) Only "absent" is definite; anything git might
// decide differently is "unknown".
export function findGitEntryUpTree(
	dirPath: string,
	deps: GitEntryProbeDeps = defaultProbeDeps,
): Promise<GitEntryProbeResult> {
	if (
		process.env.GIT_DIR !== undefined ||
		process.env.GIT_WORK_TREE !== undefined
	) {
		return Promise.resolve("unknown");
	}
	if (isUncPath(dirPath)) return Promise.resolve("unknown");
	const logical = path.resolve(dirPath);
	if (isUncPath(logical)) return Promise.resolve("unknown");
	const key = isWin32 ? logical.toLowerCase() : logical;

	const existing = pending.get(key);
	if (existing) {
		return existing.control.timedOut
			? Promise.resolve("unknown")
			: existing.result;
	}
	if (activeProbes.size >= MAX_ACTIVE_PROBES) return Promise.resolve("unknown");

	const control: ProbeControl = { timedOut: false };
	activeProbes.add(control);
	const walking = walk(logical, deps, control).finally(() => {
		activeProbes.delete(control);
		if (pending.get(key)?.control === control) pending.delete(key);
	});
	const result = new Promise<GitEntryProbeResult>((resolve, reject) => {
		const timer = deps.setTimeout(() => {
			control.timedOut = true;
			resolve("unknown");
		}, PROBE_CAP_MS);
		walking.then(
			(found) => {
				deps.clearTimeout(timer);
				resolve(found);
			},
			(error) => {
				deps.clearTimeout(timer);
				reject(error);
			},
		);
	});
	pending.set(key, { control, result });
	return result;
}

export function resetGitEntryProbeForTests(): void {
	pending.clear();
	activeProbes.clear();
}
