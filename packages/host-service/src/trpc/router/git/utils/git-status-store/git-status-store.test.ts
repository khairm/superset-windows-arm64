import { describe, expect, spyOn, test } from "bun:test";
import type { Branch, ChangedFile } from "../../types";
import {
	MAX_COLD_ENTRIES,
	MAX_COLD_RETAINED_FILES,
} from "../diff-stats-limits";
import type { GitStatusSnapshot } from "../git-status";
import type { GitStatusPartial } from "../git-status-partial";
import { GitStatusStore } from "./git-status-store";

const BRANCH: Branch = {
	name: "main",
	isHead: true,
	upstream: null,
	aheadCount: 0,
	behindCount: 0,
	lastCommitHash: "abc",
	lastCommitDate: "2026-01-01",
};

function file(path: string, status: ChangedFile["status"] = "modified") {
	return { path, status, additions: 1, deletions: 0 } satisfies ChangedFile;
}

function snapshot(unstaged: ChangedFile[] = []): GitStatusSnapshot {
	return {
		currentBranch: BRANCH,
		defaultBranch: BRANCH,
		againstBase: [],
		staged: [],
		unstaged,
		ignoredPaths: [],
	};
}

function repeatedFiles(count: number): GitStatusSnapshot {
	const shared = file("f");
	return snapshot(Array.from({ length: count }, () => shared));
}

function harness(options?: {
	full?: () => GitStatusSnapshot;
	partial?: (paths: string[]) => GitStatusPartial;
}) {
	const calls = { full: 0, partial: 0 };
	const seen: string[][] = [];
	return {
		calls,
		seen,
		computeFull: async () => {
			calls.full++;
			return options?.full?.() ?? snapshot();
		},
		computePartial: async (paths: string[]) => {
			calls.partial++;
			seen.push(paths);
			return options?.partial?.(paths) ?? { paths, unstaged: [] };
		},
	};
}

describe("GitStatusStore", () => {
	test("an unwatched workspace always walks in full and is never cached", async () => {
		const store = new GitStatusStore();
		const h = harness();

		await store.read({ workspaceId: "w", baseBranch: null, ...h });
		await store.read({ workspaceId: "w", baseBranch: null, ...h });

		expect(h.calls.full).toBe(2);
		expect(h.calls.partial).toBe(0);
	});

	test("the first read of a watched workspace walks in full", async () => {
		const store = new GitStatusStore();
		store.attach("w");
		const h = harness();

		await store.read({ workspaceId: "w", baseBranch: null, ...h });

		expect(h.calls.full).toBe(1);
	});

	test("a read with nothing pending reuses the cache without computing", async () => {
		const store = new GitStatusStore();
		store.attach("w");
		store.recordChange("w", []);
		const h = harness({ full: () => snapshot([file("a.ts")]) });

		await store.read({ workspaceId: "w", baseBranch: null, ...h });
		const second = await store.read({
			workspaceId: "w",
			baseBranch: null,
			...h,
		});

		expect(h.calls.full).toBe(1);
		expect(h.calls.partial).toBe(0);
		expect(second.unstaged.map((f) => f.path)).toEqual(["a.ts"]);
	});

	test("a scoped change re-reads only its paths", async () => {
		const store = new GitStatusStore();
		store.attach("w");
		store.recordChange("w", []);
		const h = harness({
			full: () => snapshot([file("a.ts")]),
			partial: (paths) => ({ paths, unstaged: [file("b.ts")] }),
		});

		await store.read({ workspaceId: "w", baseBranch: null, ...h });
		store.recordChange("w", ["b.ts"]);
		const patched = await store.read({
			workspaceId: "w",
			baseBranch: null,
			...h,
		});

		expect(h.calls.full).toBe(1);
		expect(h.seen).toEqual([["b.ts"]]);
		expect(patched.unstaged.map((f) => f.path).sort()).toEqual([
			"a.ts",
			"b.ts",
		]);
	});

	test("a broad change forces a full walk", async () => {
		const store = new GitStatusStore();
		store.attach("w");
		store.recordChange("w", []);
		const h = harness();

		await store.read({ workspaceId: "w", baseBranch: null, ...h });
		store.recordChange("w", undefined);
		await store.read({ workspaceId: "w", baseBranch: null, ...h });

		expect(h.calls.full).toBe(2);
		expect(h.calls.partial).toBe(0);
	});

	test("a scoped change after a broad one stays broad", async () => {
		const store = new GitStatusStore();
		store.attach("w");
		store.recordChange("w", []);
		const h = harness();

		await store.read({ workspaceId: "w", baseBranch: null, ...h });
		store.recordChange("w", undefined);
		store.recordChange("w", ["a.ts"]);
		await store.read({ workspaceId: "w", baseBranch: null, ...h });

		expect(h.calls.full).toBe(2);
		expect(h.calls.partial).toBe(0);
	});

	test("a different base branch cannot reuse the cache", async () => {
		const store = new GitStatusStore();
		store.attach("w");
		store.recordChange("w", []);
		const h = harness();

		await store.read({ workspaceId: "w", baseBranch: "main", ...h });
		store.recordChange("w", ["a.ts"]);
		await store.read({ workspaceId: "w", baseBranch: "develop", ...h });

		expect(h.calls.full).toBe(2);
		expect(h.calls.partial).toBe(0);
	});

	test("changes landing during a partial read are kept for the next one", async () => {
		const store = new GitStatusStore();
		store.attach("w");
		store.recordChange("w", []);
		const h = harness({
			partial: (paths) => ({ paths, unstaged: [] }),
		});

		await store.read({ workspaceId: "w", baseBranch: null, ...h });
		store.recordChange("w", ["a.ts"]);
		const inFlight = store.read({
			workspaceId: "w",
			baseBranch: null,
			computeFull: h.computeFull,
			computePartial: async (paths) => {
				store.recordChange("w", ["b.ts"]);
				return h.computePartial(paths);
			},
		});
		await inFlight;
		await store.read({ workspaceId: "w", baseBranch: null, ...h });

		expect(h.seen).toEqual([["a.ts"], ["b.ts"]]);
	});

	test("a failed partial read puts its paths back", async () => {
		const store = new GitStatusStore();
		store.attach("w");
		store.recordChange("w", []);
		const h = harness();

		await store.read({ workspaceId: "w", baseBranch: null, ...h });
		store.recordChange("w", ["a.ts"]);
		await expect(
			store.read({
				workspaceId: "w",
				baseBranch: null,
				computeFull: h.computeFull,
				computePartial: async () => {
					throw new Error("git blew up");
				},
			}),
		).rejects.toThrow("git blew up");

		await store.read({ workspaceId: "w", baseBranch: null, ...h });
		expect(h.seen).toEqual([["a.ts"]]);
	});

	test("a broad change during a full walk stops it being cached", async () => {
		const store = new GitStatusStore();
		store.attach("w");
		const h = harness();

		await store.read({
			workspaceId: "w",
			baseBranch: null,
			computeFull: async () => {
				store.recordChange("w", undefined);
				return h.computeFull();
			},
			computePartial: h.computePartial,
		});
		await store.read({ workspaceId: "w", baseBranch: null, ...h });

		expect(h.calls.full).toBe(2);
	});

	test("dropping a workspace discards its cache", async () => {
		const store = new GitStatusStore();
		store.attach("w");
		store.recordChange("w", []);
		const h = harness();

		await store.read({ workspaceId: "w", baseBranch: null, ...h });
		store.drop("w");
		await store.read({ workspaceId: "w", baseBranch: null, ...h });
		await store.read({ workspaceId: "w", baseBranch: null, ...h });

		expect(h.calls.full).toBe(3);
	});

	test("a deletion in the patch escalates to a full walk", async () => {
		const store = new GitStatusStore();
		store.attach("w");
		store.recordChange("w", []);
		const h = harness({
			partial: (paths) => ({ paths, unstaged: [file("a.ts", "deleted")] }),
		});

		await store.read({ workspaceId: "w", baseBranch: null, ...h });
		store.recordChange("w", ["a.ts"]);
		await store.read({ workspaceId: "w", baseBranch: null, ...h });

		expect(h.calls.partial).toBe(1);
		expect(h.calls.full).toBe(2);
	});

	test("recording against an unwatched workspace is ignored", async () => {
		const store = new GitStatusStore();
		const h = harness();

		store.recordChange("w", ["a.ts"]);
		await store.read({ workspaceId: "w", baseBranch: null, ...h });

		expect(h.calls.full).toBe(1);
		expect(h.calls.partial).toBe(0);
	});

	test("readers on different base branches each stay incremental", async () => {
		const store = new GitStatusStore();
		store.attach("w");
		store.recordChange("w", []);
		const h = harness({
			full: () => snapshot([file("a.ts")]),
			partial: (paths) => ({ paths, unstaged: [file("b.ts")] }),
		});

		await store.read({ workspaceId: "w", baseBranch: null, ...h });
		await store.read({ workspaceId: "w", baseBranch: "main", ...h });
		store.recordChange("w", ["b.ts"]);
		const sidebar = await store.read({
			workspaceId: "w",
			baseBranch: null,
			...h,
		});
		const changes = await store.read({
			workspaceId: "w",
			baseBranch: "main",
			...h,
		});

		expect(h.calls.full).toBe(2);
		expect(h.seen).toEqual([["b.ts"], ["b.ts"]]);
		for (const result of [sidebar, changes]) {
			expect(result.unstaged.map((f) => f.path).sort()).toEqual([
				"a.ts",
				"b.ts",
			]);
		}
	});

	test("a read landing during a partial waits for the patch", async () => {
		const store = new GitStatusStore();
		store.attach("w");
		store.recordChange("w", []);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const h = harness({
			partial: (paths) => ({ paths, unstaged: [file("b.ts")] }),
		});
		const computePartial = async (paths: string[]) => {
			await gate;
			return h.computePartial(paths);
		};

		await store.read({ workspaceId: "w", baseBranch: null, ...h });
		store.recordChange("w", ["b.ts"]);
		const first = store.read({
			workspaceId: "w",
			baseBranch: null,
			computeFull: h.computeFull,
			computePartial,
		});
		const second = store.read({
			workspaceId: "w",
			baseBranch: null,
			computeFull: h.computeFull,
			computePartial,
		});
		release();

		expect((await second).unstaged.map((f) => f.path)).toEqual(["b.ts"]);
		expect((await first).unstaged.map((f) => f.path)).toEqual(["b.ts"]);
		expect(h.calls.partial).toBe(1);
	});

	test("a full walk in flight cannot overwrite a later patch", async () => {
		const store = new GitStatusStore();
		store.attach("w");
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let started!: () => void;
		const walking = new Promise<void>((resolve) => {
			started = resolve;
		});
		const h = harness({
			full: () => snapshot([file("a.ts")]),
			partial: (paths) => ({ paths, unstaged: [file("b.ts")] }),
		});
		const computeFull = async () => {
			started();
			await gate;
			return h.computeFull();
		};

		const walk = store.read({
			workspaceId: "w",
			baseBranch: null,
			computeFull,
			computePartial: h.computePartial,
		});
		// The edit lands while git is already walking, so the walk's result
		// cannot include it.
		await walking;
		store.recordChange("w", ["b.ts"]);
		const after = store.read({
			workspaceId: "w",
			baseBranch: null,
			computeFull,
			computePartial: h.computePartial,
		});
		release();
		await walk;

		expect((await after).unstaged.map((f) => f.path).sort()).toEqual([
			"a.ts",
			"b.ts",
		]);
		const settled = await store.read({
			workspaceId: "w",
			baseBranch: null,
			computeFull,
			computePartial: h.computePartial,
		});
		expect(settled.unstaged.map((f) => f.path).sort()).toEqual([
			"a.ts",
			"b.ts",
		]);
		expect(h.calls.full).toBe(1);
		expect(h.calls.partial).toBe(1);
	});
});

// (DIFFSTATS-COLD-CACHE)
describe("GitStatusStore cold reads", () => {
	const coldCache = {
		worktreePath: "repo-a",
		directoryId: "identity-a",
	};

	test("coalesces misses, expires after 120 seconds, and awaits a fresh snapshot", async () => {
		const clock = spyOn(Date, "now");
		let now = 1_000;
		clock.mockImplementation(() => now);
		try {
			const store = new GitStatusStore();
			let complete: ((value: GitStatusSnapshot) => void) | undefined;
			let calls = 0;
			const input = {
				workspaceId: "w",
				baseBranch: null,
				coldCache,
				computeFull: () => {
					calls++;
					return new Promise<GitStatusSnapshot>((resolve) => {
						complete = resolve;
					});
				},
				computePartial: async () => {
					throw new Error("partial must not run");
				},
			};
			const first = store.read(input);
			const concurrent = store.read(input);
			await Promise.resolve();
			expect(calls).toBe(1);
			complete?.(snapshot([file("first")]));
			expect((await first).unstaged[0]?.path).toBe("first");
			expect((await concurrent).unstaged[0]?.path).toBe("first");
			now += 119_999;
			await store.read(input);
			expect(calls).toBe(1);
			now++;
			const expired = store.read(input);
			await Promise.resolve();
			expect(calls).toBe(2);
			complete?.(snapshot([file("fresh")]));
			expect((await expired).unstaged[0]?.path).toBe("fresh");
		} finally {
			clock.mockRestore();
		}
	});

	test("does not cache failures and invalidates on changes, attach, drop, and identity change", async () => {
		const store = new GitStatusStore();
		const h = harness();
		const input = { workspaceId: "w", baseBranch: null, coldCache, ...h };
		await store.read(input);
		await store.read(input);
		expect(h.calls.full).toBe(1);
		store.recordChange("w", []);
		await store.read(input);
		store.attach("w");
		await store.read(input);
		store.drop("w");
		await store.read(input);
		await store.read({
			...input,
			coldCache: { worktreePath: "repo-b", directoryId: "identity-b" },
		});
		await store.read({
			...input,
			coldCache: { worktreePath: "repo-b", directoryId: "identity-c" },
		});
		expect(h.calls.full).toBe(6);
		await expect(
			store.read({
				...input,
				computeFull: async () => {
					throw new Error("git failed");
				},
				coldCache: { worktreePath: "repo-c", directoryId: "identity-c" },
			}),
		).rejects.toThrow("git failed");
		await store.read({
			...input,
			coldCache: { worktreePath: "repo-c", directoryId: "identity-c" },
		});
		expect(h.calls.full).toBe(7);
	});

	test("a change in one workspace invalidates every workspace on its checkout", async () => {
		const store = new GitStatusStore();
		const h = harness();
		const first = {
			workspaceId: "first",
			baseBranch: null,
			coldCache: { worktreePath: "C:/checkout", directoryId: "same" },
			...h,
		};
		const second = {
			workspaceId: "second",
			baseBranch: null,
			coldCache: { worktreePath: "c:/checkout-alias", directoryId: "same" },
			...h,
		};
		await store.read(first);
		await store.read(second);
		store.recordChange("first", undefined);
		await store.read(second);
		expect(h.calls.full).toBe(3);
	});

	test("retries a cold compute that never settles once its deadline passes", async () => {
		const clock = spyOn(Date, "now");
		let now = 5_000;
		clock.mockImplementation(() => now);
		try {
			const store = new GitStatusStore();
			let calls = 0;
			const input = {
				workspaceId: "wedged",
				baseBranch: null,
				coldCache,
				computeFull: () => {
					calls++;
					return new Promise<GitStatusSnapshot>(() => {});
				},
				computePartial: async () => {
					throw new Error("partial must not run");
				},
			};
			void store.read(input);
			await Promise.resolve();
			now += 119_999;
			void store.read(input);
			await Promise.resolve();
			expect(calls).toBe(1);
			now++;
			void store.read(input);
			await Promise.resolve();
			expect(calls).toBe(2);
		} finally {
			clock.mockRestore();
		}
	});

	test("does not restore an in-flight entry invalidated by a mutation", async () => {
		const store = new GitStatusStore();
		let complete: ((value: GitStatusSnapshot) => void) | undefined;
		const h = harness();
		const input = { workspaceId: "w", baseBranch: null, coldCache, ...h };
		const pending = store.read({
			...input,
			computeFull: () =>
				new Promise<GitStatusSnapshot>((resolve) => {
					complete = resolve;
				}),
		});
		await Promise.resolve();
		store.recordChange("w", undefined);
		complete?.(snapshot([file("old")]));
		await pending;
		await store.read(input);
		expect(h.calls.full).toBe(1);
	});

	test("serves a walk that could not read every stat without caching it", async () => {
		const store = new GitStatusStore();
		const h = harness({ full: () => snapshot([file("a.ts")]) });
		let statsComplete = false;
		const input = {
			workspaceId: "w",
			baseBranch: null,
			coldCache,
			statsComplete: () => statsComplete,
			...h,
		};

		expect((await store.read(input)).unstaged.map((f) => f.path)).toEqual([
			"a.ts",
		]);
		await store.read(input);
		expect(h.calls.full).toBe(2);

		statsComplete = true;
		await store.read(input);
		await store.read(input);
		expect(h.calls.full).toBe(3);
	});

	test("bounds cold entries and evicts the least recently used", async () => {
		const store = new GitStatusStore();
		const h = harness();
		const input = { baseBranch: null, coldCache, ...h };
		for (let i = 0; i < MAX_COLD_ENTRIES; i++) {
			await store.read({ ...input, workspaceId: `w${i}` });
		}
		await store.read({ ...input, workspaceId: "w0" });
		await store.read({ ...input, workspaceId: "overflow" });
		await store.read({ ...input, workspaceId: "w1" });
		expect(h.calls.full).toBe(MAX_COLD_ENTRIES + 2);
	});

	test("keeps smaller cold entries when an oversized walk resolves", async () => {
		const walks = { small: 0, oversized: 0 };
		const base = {
			baseBranch: null,
			coldCache,
			computePartial: async () => {
				throw new Error("cold reads must not compute partial status");
			},
		};
		const small = {
			...base,
			workspaceId: "small",
			computeFull: async () => {
				walks.small++;
				return repeatedFiles(1);
			},
		};
		const oversized = {
			...base,
			workspaceId: "oversized",
			computeFull: async () => {
				walks.oversized++;
				return repeatedFiles(MAX_COLD_RETAINED_FILES + 1);
			},
		};
		const store = new GitStatusStore();

		await store.read(small);
		await store.read(oversized);
		await store.read(small);
		await store.read(oversized);

		expect(walks).toEqual({ small: 1, oversized: 2 });
	});

	test("evicts the least recently read cold entries over the file budget", async () => {
		const twoFifths = Math.ceil(MAX_COLD_RETAINED_FILES * 0.4);
		const walks = { a: 0, b: 0, c: 0 };
		const base = {
			baseBranch: null,
			coldCache,
			computePartial: async () => {
				throw new Error("cold reads must not compute partial status");
			},
		};
		const entry = (workspaceId: keyof typeof walks) => ({
			...base,
			workspaceId,
			computeFull: async () => {
				walks[workspaceId]++;
				return repeatedFiles(twoFifths);
			},
		});
		const a = entry("a");
		const b = entry("b");
		const c = entry("c");
		const store = new GitStatusStore();

		await store.read(a);
		await store.read(b);
		await store.read(a);
		await store.read(c);
		expect(walks).toEqual({ a: 1, b: 1, c: 1 });

		await store.read(a);
		await store.read(c);
		expect(walks).toEqual({ a: 1, b: 1, c: 1 });

		await store.read(b);
		expect(walks).toEqual({ a: 1, b: 2, c: 1 });
	});
});
