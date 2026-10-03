import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	defaultProbeDeps,
	findGitEntryUpTree,
	type GitEntryProbeDeps,
	type GitEntryProbeResult,
	resetGitEntryProbeForTests,
} from "./git-entry-probe";

const ROOT = path.resolve(os.tmpdir(), "git-entry-probe-virtual");
const at = (...parts: string[]) => path.join(ROOT, ...parts);

function enoent(entryPath: string): NodeJS.ErrnoException {
	return Object.assign(new Error(`ENOENT: ${entryPath}`), { code: "ENOENT" });
}

function manualTimers() {
	const callbacks = new Map<number, () => void>();
	let next = 0;
	return {
		setTimeout: (callback: () => void) => {
			next += 1;
			callbacks.set(next, callback);
			return next;
		},
		clearTimeout: (handle: unknown) => {
			callbacks.delete(handle as number);
		},
		fireAll: () => {
			const pendingCallbacks = [...callbacks.values()];
			callbacks.clear();
			for (const callback of pendingCallbacks) callback();
		},
	};
}

function fakeDeps(
	entries: string[],
	overrides: Partial<GitEntryProbeDeps> = {},
): { deps: GitEntryProbeDeps; lstatCalls: string[] } {
	const present = new Set(entries);
	const lstatCalls: string[] = [];
	const timers = manualTimers();
	return {
		lstatCalls,
		deps: {
			lstat: async (entryPath) => {
				lstatCalls.push(entryPath);
				if (present.has(entryPath)) return {};
				throw enoent(entryPath);
			},
			realpath: async (dirPath) => dirPath,
			setTimeout: timers.setTimeout,
			clearTimeout: timers.clearTimeout,
			...overrides,
		},
	};
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const savedEnv = {
	GIT_DIR: process.env.GIT_DIR,
	GIT_WORK_TREE: process.env.GIT_WORK_TREE,
};
const fixtureDirs: string[] = [];

beforeEach(() => {
	delete process.env.GIT_DIR;
	delete process.env.GIT_WORK_TREE;
});

afterEach(() => {
	resetGitEntryProbeForTests();
	for (const [name, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	for (const dir of fixtureDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("(HOST-LAUNCH-DISK-PROBE) findGitEntryUpTree", () => {
	test.each<[string, string[], string, GitEntryProbeResult]>([
		["no .git anywhere", [], at("plain", "deep"), "absent"],
		["a .git file", [at("repo", ".git")], at("repo"), "present"],
		[
			"a .git in a parent",
			[at("repo", ".git")],
			at("repo", "src", "deep"),
			"present",
		],
		["a HEAD with no .git", [at("bare", "HEAD")], at("bare"), "unknown"],
	])("%s reads as %p", async (_label, entries, dir, expected) => {
		const { deps } = fakeDeps(entries);
		expect(await findGitEntryUpTree(dir, deps)).toBe(expected);
	});

	test("GIT_DIR in the environment is unknown without touching disk", async () => {
		process.env.GIT_DIR = at("repo", ".git");
		const { deps, lstatCalls } = fakeDeps([]);
		expect(await findGitEntryUpTree(at("plain"), deps)).toBe("unknown");
		expect(lstatCalls).toEqual([]);
	});

	test("a link into a repo subfolder is not absent", async () => {
		const base = fs.mkdtempSync(path.join(os.tmpdir(), "git-entry-probe-"));
		fixtureDirs.push(base);
		fs.mkdirSync(path.join(base, "repo", ".git"), { recursive: true });
		fs.mkdirSync(path.join(base, "repo", "sub"));
		const link = path.join(base, "link");
		fs.symlinkSync(
			path.join(base, "repo", "sub"),
			link,
			process.platform === "win32" ? "junction" : "dir",
		);
		expect(await findGitEntryUpTree(link, defaultProbeDeps)).not.toBe("absent");
	});

	test("a slow lstat is unknown at the cap and a later call waits on nothing new", async () => {
		const timers = manualTimers();
		const gate = Promise.withResolvers<unknown>();
		let calls = 0;
		const { deps } = fakeDeps([], {
			lstat: () => {
				calls += 1;
				return gate.promise;
			},
			setTimeout: timers.setTimeout,
			clearTimeout: timers.clearTimeout,
		});

		const first = findGitEntryUpTree(at("slow"), deps);
		expect(calls).toBe(1);
		timers.fireAll();
		expect(await first).toBe("unknown");
		expect(await findGitEntryUpTree(at("slow"), deps)).toBe("unknown");
		expect(calls).toBe(1);

		gate.reject(enoent(at("slow", ".git")));
		await tick();
		expect(calls).toBe(1);
	});

	test("four hung roots start only two fs calls; slots free only when those settle", async () => {
		const timers = manualTimers();
		const gates: Array<ReturnType<typeof Promise.withResolvers<unknown>>> = [];
		const { deps } = fakeDeps([], {
			lstat: () => {
				const gate = Promise.withResolvers<unknown>();
				gates.push(gate);
				return gate.promise;
			},
			setTimeout: timers.setTimeout,
			clearTimeout: timers.clearTimeout,
		});

		const results = ["a", "b", "c", "d"].map((name) =>
			findGitEntryUpTree(at(name), deps),
		);
		expect(gates.length).toBe(2);
		expect(await results[2]).toBe("unknown");
		expect(await results[3]).toBe("unknown");

		timers.fireAll();
		expect(await results[0]).toBe("unknown");
		expect(await results[1]).toBe("unknown");
		expect(await findGitEntryUpTree(at("e"), deps)).toBe("unknown");
		expect(gates.length).toBe(2);

		for (const gate of gates.splice(0)) gate.reject(enoent(ROOT));
		await tick();
		void findGitEntryUpTree(at("f"), deps);
		expect(gates.length).toBe(1);
		gates[0]?.reject(enoent(ROOT));
	});

	test("a throwing lstat releases its slot", async () => {
		let calls = 0;
		const { deps } = fakeDeps([], {
			lstat: () => {
				calls += 1;
				throw new Error("device not ready");
			},
		});
		for (const name of ["a", "b", "c"]) {
			expect(await findGitEntryUpTree(at(name), deps)).toBe("unknown");
		}
		expect(calls).toBe(3);
	});

	test("overlapping calls on one directory share one walk", async () => {
		const gate = Promise.withResolvers<void>();
		const repoGit = at("repo", ".git");
		const lstatCalls: string[] = [];
		const { deps } = fakeDeps([], {
			lstat: async (entryPath) => {
				lstatCalls.push(entryPath);
				await gate.promise;
				if (entryPath === repoGit) return {};
				throw enoent(entryPath);
			},
		});

		const first = findGitEntryUpTree(at("repo"), deps);
		const second = findGitEntryUpTree(at("repo"), deps);
		gate.resolve();
		expect(await Promise.all([first, second])).toEqual(["present", "present"]);
		expect(lstatCalls).toEqual([repoGit]);
	});
});
