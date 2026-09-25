import { describe, expect, mock, test } from "bun:test";
import { scheduleBaseRefFetch } from "./base-ref-freshness";

// Distinct remote/branch per test so the module-level TTL/in-flight maps
// (keyed by commonDir#remote/branch) don't leak state across tests.
function createGit(
	options: {
		fetch?: () => Promise<unknown>;
		commonDir?: string;
		sha?: () => string;
	} = {},
) {
	const fetchCalls: string[][] = [];
	const rawCalls: string[][] = [];
	const git = {
		raw: mock(async (args: string[]) => {
			rawCalls.push(args);
			if (args[0] === "rev-parse" && args[1] === "--git-common-dir") {
				return `${options.commonDir ?? ".git"}\n`;
			}
			// (DIFFSTATS-COLD-CACHE)
			if (args[0] === "for-each-ref") {
				return `${options.sha?.() ?? "unmoved-sha"}\n`;
			}
			throw new Error(`Unexpected raw args: ${args.join(" ")}`);
		}),
		fetch: mock(async (args: string[]) => {
			fetchCalls.push(args);
			return options.fetch ? options.fetch() : undefined;
		}),
	} as never as import("simple-git").SimpleGit;
	return { git, fetchCalls, rawCalls };
}

function forEachRefCalls(rawCalls: string[][]): string[][] {
	return rawCalls.filter((args) => args[0] === "for-each-ref");
}

describe("scheduleBaseRefFetch", () => {
	test("fetches the base branch with the expected args", async () => {
		const { git, fetchCalls } = createGit();
		const outcome = await scheduleBaseRefFetch(git, "/repo/wt-a", {
			remote: "origin",
			branch: "main",
		});
		expect(fetchCalls).toEqual([["origin", "main", "--quiet", "--no-tags"]]);
		// (DIFFSTATS-COLD-CACHE)
		expect(outcome).not.toBeNull();
	});

	test("dedupes repeat calls within the TTL window", async () => {
		const { git, fetchCalls } = createGit();
		const target = { remote: "origin", branch: "ttl-branch" };
		const outcomes = [
			await scheduleBaseRefFetch(git, "/repo/wt-ttl", target),
			await scheduleBaseRefFetch(git, "/repo/wt-ttl", target),
			await scheduleBaseRefFetch(git, "/repo/wt-ttl", target),
		];
		expect(fetchCalls).toHaveLength(1);
		// (DIFFSTATS-COLD-CACHE)
		expect(outcomes.map((outcome) => outcome !== null)).toEqual([
			true,
			false,
			false,
		]);
	});

	// (DIFFSTATS-COLD-CACHE) A sha read per call would put a git subprocess on
	// the coordinator event loop on every status walk, not once per fetch.
	test("reads the remote-tracking sha only when a fetch actually runs", async () => {
		const { git, rawCalls } = createGit();
		const target = { remote: "origin", branch: "sha-reads-branch" };
		const forEachRef = [
			"for-each-ref",
			"--format=%(objectname)",
			"refs/remotes/origin/sha-reads-branch",
		];
		await scheduleBaseRefFetch(git, "/repo/wt-sha-reads", target);
		await scheduleBaseRefFetch(git, "/repo/wt-sha-reads", target);
		await scheduleBaseRefFetch(git, "/repo/wt-sha-reads", target);
		expect(forEachRefCalls(rawCalls)).toEqual([forEachRef, forEachRef]);
	});

	// (DIFFSTATS-COLD-CACHE)
	test("reports whether the fetch moved the remote-tracking ref", async () => {
		let sha = "moved-before";
		const moving = createGit({
			sha: () => sha,
			fetch: async () => {
				sha = "moved-after";
			},
		});
		expect(
			await scheduleBaseRefFetch(moving.git, "/repo/wt-moved", {
				remote: "origin",
				branch: "moved-branch",
			}),
		).toMatchObject({ refMoved: true });

		const idle = createGit();
		expect(
			await scheduleBaseRefFetch(idle.git, "/repo/wt-idle", {
				remote: "origin",
				branch: "idle-branch",
			}),
		).toMatchObject({ refMoved: false });
	});

	// (DIFFSTATS-COLD-CACHE) An unverifiable ref must invalidate: keeping the
	// entries walked before the fetch would serve pre-fetch numbers for the
	// whole cold TTL.
	test("treats an unreadable post-fetch sha as a moved ref", async () => {
		let reads = 0;
		const { git } = createGit({
			sha: () => {
				reads++;
				if (reads > 1) throw new Error("ref unreadable");
				return "unreadable-before";
			},
		});
		const originalWarn = console.warn;
		console.warn = () => {};
		try {
			expect(
				await scheduleBaseRefFetch(git, "/repo/wt-unreadable", {
					remote: "origin",
					branch: "unreadable-branch",
				}),
			).toMatchObject({ refMoved: true });
		} finally {
			console.warn = originalWarn;
		}
	});

	test("resolves the common dir once within the TTL (path cache)", async () => {
		const { git, rawCalls } = createGit();
		const target = { remote: "origin", branch: "fresh-branch" };
		await scheduleBaseRefFetch(git, "/repo/wt-fresh", target);
		await scheduleBaseRefFetch(git, "/repo/wt-fresh", target);
		// One rev-parse across both calls — resolving per call spawns git on
		// the event loop before the fetch-TTL check, on every status poll. A
		// stale mapping only mis-keys the dedupe (extra/suppressed fetch,
		// TTL-bounded); the fetch itself always runs in worktreePath.
		const commonDirCalls = rawCalls.filter(
			(args) => args[1] === "--git-common-dir",
		);
		expect(commonDirCalls).toHaveLength(1);
	});

	test("coalesces concurrent calls into a single in-flight fetch", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { git, fetchCalls } = createGit({ fetch: () => gate });
		const target = { remote: "origin", branch: "inflight-branch" };
		const a = scheduleBaseRefFetch(git, "/repo/wt-inflight", target);
		const b = scheduleBaseRefFetch(git, "/repo/wt-inflight", target);
		release();
		// A joiner reads the starter's landing instead of re-reading the ref.
		// (DIFFSTATS-COLD-CACHE)
		expect(await a).not.toBeNull();
		expect(await a).toBe(await b);
		expect(fetchCalls).toHaveLength(1);
	});

	test("dedupes worktrees that resolve to the same common Git directory", async () => {
		const target = { remote: "origin", branch: "shared-worktrees-branch" };
		const a = createGit({ commonDir: "/repo/.git" });
		const b = createGit({ commonDir: "/repo/.git" });
		let fetches = 0;
		const fetchBaseRef = async () => {
			fetches++;
		};

		// Paths must be unique to this test: the commonDir cache is keyed by
		// worktree path, so reusing another test's path would resolve stale.
		await Promise.all([
			scheduleBaseRefFetch(a.git, "/repo/wt-shared-a", target, fetchBaseRef),
			scheduleBaseRefFetch(b.git, "/repo/wt-shared-b", target, fetchBaseRef),
		]);

		expect(fetches).toBe(1);
	});

	// (DIFFSTATS-COLD-CACHE)
	test("reports the landing to a walk that started before the last fetch landed", async () => {
		const { git } = createGit();
		const target = { remote: "origin", branch: "straddle-branch" };
		let fetches = 0;
		const fetchBaseRef = async () => {
			fetches++;
		};
		const walkStartedAt = Date.now();
		await scheduleBaseRefFetch(git, "/repo/wt-straddle", target, fetchBaseRef);
		expect(
			await scheduleBaseRefFetch(
				git,
				"/repo/wt-straddle",
				target,
				fetchBaseRef,
				walkStartedAt,
			),
		).not.toBeNull();
		expect(fetches).toBe(1);
	});

	// (DIFFSTATS-COLD-CACHE)
	test("reports no landing to a walk that started after the last fetch landed", async () => {
		const { git } = createGit();
		const target = { remote: "origin", branch: "after-landing-branch" };
		let fetches = 0;
		const fetchBaseRef = async () => {
			fetches++;
		};
		await scheduleBaseRefFetch(
			git,
			"/repo/wt-after-landing",
			target,
			fetchBaseRef,
		);
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(
			await scheduleBaseRefFetch(
				git,
				"/repo/wt-after-landing",
				target,
				fetchBaseRef,
				Date.now(),
			),
		).toBeNull();
		expect(fetches).toBe(1);
	});

	test("never rejects when the fetch fails", async () => {
		const { git, fetchCalls } = createGit({
			fetch: () => Promise.reject(new Error("offline")),
		});
		const originalWarn = console.warn;
		console.warn = () => {};
		try {
			// Resolves (does not throw) despite the underlying fetch rejecting.
			// (DIFFSTATS-COLD-CACHE)
			expect(
				await scheduleBaseRefFetch(git, "/repo/wt-fail", {
					remote: "origin",
					branch: "fail-branch",
				}),
			).toBeNull();
		} finally {
			console.warn = originalWarn;
		}
		expect(fetchCalls).toHaveLength(1);
	});
});
