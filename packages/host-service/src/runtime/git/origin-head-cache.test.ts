import {
	afterEach,
	beforeEach,
	describe,
	expect,
	setSystemTime,
	test,
} from "bun:test";
import type { SimpleGit } from "simple-git";
import {
	peekOriginHead,
	readOriginHead,
	resetOriginHeadCacheForTests,
} from "./origin-head-cache";

const REPO = "/origin-head-cache-repo";
const T0 = new Date("2026-10-01T12:00:00Z").getTime();

function fakeGit(answer: () => Promise<string>) {
	const calls: string[][] = [];
	const git = {
		raw: (args: string[]) => {
			calls.push(args);
			return answer();
		},
	} as unknown as SimpleGit;
	return { git, calls };
}

describe("(GIT-LAUNCH-BUDGET-E) origin/HEAD cache", () => {
	beforeEach(() => {
		resetOriginHeadCacheForTests();
		setSystemTime(new Date(T0));
	});
	afterEach(() => {
		resetOriginHeadCacheForTests();
		setSystemTime();
	});

	test("strips origin/ and the trailing newline", async () => {
		const { git } = fakeGit(async () => "origin/develop\n");
		expect(await readOriginHead(REPO, git)).toBe("develop");
		expect(peekOriginHead(REPO)).toBe("develop");
	});

	test("an unset origin/HEAD is cached as null for 10 minutes", async () => {
		const { git, calls } = fakeGit(async () => "");
		expect(await readOriginHead(REPO, git)).toBeNull();
		expect(calls[0]).toEqual([
			"symbolic-ref",
			"--quiet",
			"--short",
			"refs/remotes/origin/HEAD",
		]);
		setSystemTime(new Date(T0 + 599_999));
		expect(await readOriginHead(REPO, git)).toBeNull();
		expect(peekOriginHead(REPO)).toBeNull();
		expect(calls).toHaveLength(1);
		setSystemTime(new Date(T0 + 600_000));
		expect(peekOriginHead(REPO)).toBeUndefined();
		await readOriginHead(REPO, git);
		expect(calls).toHaveLength(2);
	});

	test("a failed read propagates, is not cached, and the next call retries", async () => {
		let fail = true;
		const { git, calls } = fakeGit(async () => {
			if (fail) throw new Error("git timed out");
			return "origin/main\n";
		});
		await expect(readOriginHead(REPO, git)).rejects.toThrow("git timed out");
		expect(peekOriginHead(REPO)).toBeUndefined();
		fail = false;
		expect(await readOriginHead(REPO, git)).toBe("main");
		expect(calls).toHaveLength(2);
	});

	test("concurrent reads share one git call", async () => {
		const gate = Promise.withResolvers<string>();
		const { git, calls } = fakeGit(() => gate.promise);
		const first = readOriginHead(REPO, git);
		const second = readOriginHead(REPO, git);
		gate.resolve("origin/main\n");
		expect(await Promise.all([first, second])).toEqual(["main", "main"]);
		expect(calls).toHaveLength(1);
	});

	test("a read in flight across a reset does not repopulate the cache", async () => {
		const gate = Promise.withResolvers<string>();
		const { git } = fakeGit(() => gate.promise);
		const stale = readOriginHead(REPO, git);
		resetOriginHeadCacheForTests();
		gate.resolve("origin/main\n");
		expect(await stale).toBe("main");
		expect(peekOriginHead(REPO)).toBeUndefined();
	});
});
