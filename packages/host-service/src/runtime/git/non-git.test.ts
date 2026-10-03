import {
	afterEach,
	beforeEach,
	describe,
	expect,
	setSystemTime,
	spyOn,
	test,
} from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	invalidateIsGitRepo,
	isGitRepo,
	probeIsGitRepo,
	resetIsGitRepoCacheForTests,
	setIsGitRepoProbeForTests,
} from "./non-git";

const DIR = join(tmpdir(), "non-git-cache-probe");
const T0 = new Date("2026-10-01T12:00:00Z").getTime();

function countingProbe(answer: () => Promise<boolean>) {
	let calls = 0;
	setIsGitRepoProbeForTests(() => {
		calls += 1;
		return answer();
	});
	return () => calls;
}

describe("(GIT-LAUNCH-BUDGET-D) isGitRepo cache", () => {
	beforeEach(() => {
		resetIsGitRepoCacheForTests();
		setSystemTime(new Date(T0));
	});
	afterEach(() => {
		resetIsGitRepoCacheForTests();
		setSystemTime();
	});

	test("concurrent calls share one probe", async () => {
		const gate = Promise.withResolvers<boolean>();
		const calls = countingProbe(() => gate.promise);
		const first = isGitRepo(DIR);
		const second = isGitRepo(`${DIR}/`);
		gate.resolve(true);
		expect(await Promise.all([first, second])).toEqual([true, true]);
		expect(calls()).toBe(1);
	});

	test.each<[string, () => Promise<boolean>, boolean, number]>([
		["a yes", async () => true, true, 5 * 60_000],
		["a no", async () => false, false, 5_000],
		[
			"a failed probe",
			async () => {
				throw new Error("git timed out");
			},
			false,
			5_000,
		],
	])("%s reads as %p and is re-probed only after %p ms", async (_label, answer, expected, ttlMs) => {
		const calls = countingProbe(answer);
		expect(await isGitRepo(DIR)).toBe(expected);
		setSystemTime(new Date(T0 + ttlMs - 1));
		expect(await isGitRepo(DIR)).toBe(expected);
		expect(calls()).toBe(1);
		setSystemTime(new Date(T0 + ttlMs));
		expect(await isGitRepo(DIR)).toBe(expected);
		expect(calls()).toBe(2);
	});

	test("the real probe on a missing directory reads as no instead of rejecting", async () => {
		expect(await isGitRepo(join(DIR, "does-not-exist"))).toBe(false);
	});

	test("invalidateIsGitRepo forces a re-probe of a cached yes", async () => {
		const calls = countingProbe(async () => true);
		await isGitRepo(DIR);
		invalidateIsGitRepo(DIR);
		await isGitRepo(DIR);
		expect(calls()).toBe(2);
	});

	test("a probe pending across invalidateIsGitRepo is not cached", async () => {
		const gate = Promise.withResolvers<boolean>();
		let answer: Promise<boolean> = gate.promise;
		const calls = countingProbe(() => answer);
		const stale = isGitRepo(DIR);
		invalidateIsGitRepo(DIR);
		answer = Promise.resolve(false);
		gate.resolve(true);
		expect(await stale).toBe(true);
		expect(await isGitRepo(DIR)).toBe(false);
		expect(calls()).toBe(2);
	});
});

describe("(HOST-LAUNCH-DISK-NO-ISREPO) probeIsGitRepo", () => {
	test("a disk answer of absent is a no without launching git", async () => {
		let gitChecks = 0;
		const isRepo = await probeIsGitRepo(DIR, {
			entryProbe: async () => "absent",
			gitCheck: async () => {
				gitChecks += 1;
				return true;
			},
		});
		expect(isRepo).toBe(false);
		expect(gitChecks).toBe(0);
	});

	test("a throwing disk probe is logged and git decides", async () => {
		const logged = spyOn(console, "error").mockImplementation(() => {});
		try {
			const isRepo = await probeIsGitRepo(DIR, {
				entryProbe: async () => {
					throw new Error("probe bug");
				},
				gitCheck: async () => true,
			});
			expect(isRepo).toBe(true);
			expect(logged).toHaveBeenCalledTimes(1);
			expect(logged.mock.calls[0]?.[0]).toBe("[non-git] disk probe threw");
		} finally {
			logged.mockRestore();
		}
	});
});
