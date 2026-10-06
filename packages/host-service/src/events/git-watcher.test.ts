import {
	afterEach,
	beforeEach,
	describe,
	expect,
	jest,
	setSystemTime,
	spyOn,
	test,
} from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import simpleGit from "simple-git";
import { resolveGitDirInWorker } from "../runtime/git/attach-git-reads";
import {
	findGitEntryUpTree,
	resetGitEntryProbeForTests,
} from "../runtime/git/git-entry-probe";
import {
	isGitRepo,
	probeIsGitRepo,
	resetIsGitRepoCacheForTests,
	setIsGitRepoProbeForTests,
} from "../runtime/git/non-git";
import {
	collectWorktreeBatchPaths,
	DEBOUNCE_MS,
	filterGitIgnoredEvents,
	GIT_DIR_DEBOUNCE_MS,
	type GitChangedEvent,
	GitWatcher,
	isStatusRelevantGitDirEvent,
	MAX_WORKTREE_PATHS_PER_BATCH,
	type ResolveGitDir,
} from "./git-watcher";

/**
 * The dispatch seams the `.git/` watcher callback and the worktree fs stream
 * feed into. Driving them directly lets us assert emit/debounce behavior
 * without spinning a real `fs.watch` over a scratch repo.
 */
interface GitWatcherInternals {
	handleGitDirEvent(workspaceId: string, filename: string | null): void;
	addWorktreePaths(workspaceId: string, paths: Iterable<string>): void;
	getOrCreateBatch(workspaceId: string): unknown;
	markWorktreeBroad(workspaceId: string): void;
	scheduleFlush(workspaceId: string): void;
	getOrCreateIgnoredDirsState(workspaceId: string): {
		dirs: ReadonlySet<string>;
		rulesChanged: boolean;
	};
	watched: Map<string, { gitDir: string | null }>;
	attaching: Set<string>;
	interest: Map<string, number>;
	pendingBatches: Map<string, { hasGitDir: boolean }>;
	rescan(): Promise<void>;
	flushBatch(workspaceId: string): void;
}

function createWatcher(): GitWatcher {
	// `start()` is never called, so the dispatch methods under test never touch
	// the db or filesystem — empty stand-ins are enough.
	return new GitWatcher(
		{} as unknown as ConstructorParameters<typeof GitWatcher>[0],
		{} as unknown as ConstructorParameters<typeof GitWatcher>[1],
	);
}

function internals(watcher: GitWatcher): GitWatcherInternals {
	return watcher as unknown as GitWatcherInternals;
}

describe("isStatusRelevantGitDirEvent", () => {
	test("ignores `.git/` paths whose churn can't change `git status`", () => {
		const ignored = [
			"objects",
			"objects/ab/cdef0123456789",
			"objects/pack/pack-abc.pack",
			"objects/pack/pack-abc.idx",
			"lfs",
			"lfs/objects/aa/bb/ccdd",
			"logs",
			"logs/HEAD",
			"logs/refs/heads/main",
			"FETCH_HEAD",
		];
		for (const path of ignored) {
			expect(isStatusRelevantGitDirEvent(path)).toBe(false);
		}
	});

	test("keeps status-relevant `.git/` paths", () => {
		const relevant = [
			"HEAD",
			"index",
			"refs/heads/main",
			"refs/remotes/origin/main",
			"packed-refs",
			"MERGE_HEAD",
			"ORIG_HEAD",
			"config",
		];
		for (const path of relevant) {
			expect(isStatusRelevantGitDirEvent(path)).toBe(true);
		}
	});

	test("fails open when the watcher can't say what changed", () => {
		expect(isStatusRelevantGitDirEvent(null)).toBe(true);
		expect(isStatusRelevantGitDirEvent(undefined)).toBe(true);
		expect(isStatusRelevantGitDirEvent("")).toBe(true);
	});

	test("does not confuse a top-level file that merely starts with an ignored name", () => {
		expect(isStatusRelevantGitDirEvent("objects-are-cool")).toBe(true);
		expect(isStatusRelevantGitDirEvent("logspam")).toBe(true);
	});
});

describe("collectWorktreeBatchPaths", () => {
	test("duplicate notifications do not hide a later distinct path", () => {
		const duplicateEvents = Array.from(
			{ length: MAX_WORKTREE_PATHS_PER_BATCH + 1 },
			() => ({
				kind: "update" as const,
				absolutePath: "/repo/src/duplicate.ts",
			}),
		);
		const paths = collectWorktreeBatchPaths(
			[
				...duplicateEvents,
				{ kind: "update", absolutePath: "/repo/src/later.ts" },
			],
			"/repo",
		);

		expect([...paths]).toEqual(["src/duplicate.ts", "src/later.ts"]);
	});
});

describe("filterGitIgnoredEvents", () => {
	const worktree = "/repo";
	const ignored = new Set(["dist", "apps/web/.next"]);

	test("drops events inside ignored dirs, keeps everything else", () => {
		const { events, sawGitignoreChange } = filterGitIgnoredEvents(
			[
				{ kind: "create", absolutePath: "/repo/dist/bundle.js" },
				{ kind: "update", absolutePath: "/repo/apps/web/.next/cache/x" },
				{ kind: "update", absolutePath: "/repo/apps/web/.next" },
				{ kind: "update", absolutePath: "/repo/src/app.ts" },
				{ kind: "create", absolutePath: "/repo/distant/file.ts" },
			],
			worktree,
			ignored,
		);
		expect(events.map((e) => e.absolutePath)).toEqual([
			"/repo/src/app.ts",
			"/repo/distant/file.ts",
		]);
		expect(sawGitignoreChange).toBe(false);
	});

	test("a .gitignore inside an ignored dir is dropped and does not flag", () => {
		const { events, sawGitignoreChange } = filterGitIgnoredEvents(
			[
				{ kind: "create", absolutePath: "/repo/dist/pkg/.gitignore" },
				{ kind: "update", absolutePath: "/repo/dist/pkg/index.js" },
			],
			worktree,
			ignored,
		);
		expect(events).toEqual([]);
		expect(sawGitignoreChange).toBe(false);
	});

	test("keeps a rename unless both endpoints are ignored", () => {
		const { events } = filterGitIgnoredEvents(
			[
				{
					kind: "rename",
					absolutePath: "/repo/src/kept.ts",
					oldAbsolutePath: "/repo/dist/old.js",
				},
				{
					kind: "rename",
					absolutePath: "/repo/dist/a.js",
					oldAbsolutePath: "/repo/dist/b.js",
				},
			],
			worktree,
			ignored,
		);
		expect(events.map((e) => e.absolutePath)).toEqual(["/repo/src/kept.ts"]);
	});

	test("flags .gitignore changes at any depth and never drops them", () => {
		const { events, sawGitignoreChange } = filterGitIgnoredEvents(
			[
				{ kind: "update", absolutePath: "/repo/apps/web/.gitignore" },
				{ kind: "update", absolutePath: "/repo/dist/junk.js" },
			],
			worktree,
			ignored,
		);
		expect(events.map((e) => e.absolutePath)).toEqual([
			"/repo/apps/web/.gitignore",
		]);
		expect(sawGitignoreChange).toBe(true);
	});

	test("fails open on an empty set and on paths outside the worktree", () => {
		const outside = { kind: "update" as const, absolutePath: "/other/x" };
		expect(filterGitIgnoredEvents([outside], worktree, ignored).events).toEqual(
			[outside],
		);
		const inside = {
			kind: "update" as const,
			absolutePath: "/repo/dist/x.js",
		};
		expect(
			filterGitIgnoredEvents([inside], worktree, new Set()).events,
		).toEqual([inside]);
	});
});

describe("GitWatcher ignore-rule staleness flag", () => {
	test(".git/info/exclude events flag the ignored set for a native-prune check", () => {
		const watcher = createWatcher();
		const state = internals(watcher).getOrCreateIgnoredDirsState("workspace-1");
		expect(state.rulesChanged).toBe(false);

		internals(watcher).handleGitDirEvent("workspace-1", "info/exclude");
		expect(state.rulesChanged).toBe(true);
	});

	test("unrelated .git events do not flag the ignored set", () => {
		const watcher = createWatcher();
		const state = internals(watcher).getOrCreateIgnoredDirsState("workspace-1");
		internals(watcher).handleGitDirEvent("workspace-1", "index");
		internals(watcher).handleGitDirEvent("workspace-1", "refs/heads/main");
		expect(state.rulesChanged).toBe(false);
	});

	test("a .gitignore change in the worktree stream clears the set and flags it", () => {
		const watcher = createWatcher();
		const state = internals(watcher).getOrCreateIgnoredDirsState("workspace-1");
		(state as { dirs: ReadonlySet<string> }).dirs = new Set(["buildout"]);

		const filtered = filterGitIgnoredEvents(
			[{ kind: "update", absolutePath: "/repo/.gitignore" }],
			"/repo",
			state.dirs,
		);
		expect(filtered.sawGitignoreChange).toBe(true);
	});
});

describe("GitWatcher .git event filtering", () => {
	beforeEach(() => {
		jest.useFakeTimers();
	});
	afterEach(() => {
		jest.useRealTimers();
	});

	test("ignored `.git/` events never emit, even past the widest window", () => {
		const watcher = createWatcher();
		const events: GitChangedEvent[] = [];
		watcher.onChanged((event) => events.push(event));

		for (const path of [
			"objects/ab/cdef",
			"objects/pack/pack-x.pack",
			"lfs/objects/aa/bb",
			"logs/HEAD",
			"FETCH_HEAD",
		]) {
			internals(watcher).handleGitDirEvent("workspace-1", path);
		}

		jest.advanceTimersByTime(GIT_DIR_DEBOUNCE_MS + DEBOUNCE_MS);
		expect(events).toEqual([]);
	});

	test("status-relevant `.git/` events emit a broad change signal", () => {
		const watcher = createWatcher();
		const events: GitChangedEvent[] = [];
		watcher.onChanged((event) => events.push(event));

		internals(watcher).handleGitDirEvent("workspace-1", "index");
		jest.advanceTimersByTime(GIT_DIR_DEBOUNCE_MS);

		expect(events).toEqual([{ workspaceId: "workspace-1" }]);
	});
});

describe("GitWatcher adaptive debounce", () => {
	beforeEach(() => {
		jest.useFakeTimers();
	});
	afterEach(() => {
		jest.useRealTimers();
	});

	test("a `.git/`-only batch waits the wide window", () => {
		const watcher = createWatcher();
		const events: GitChangedEvent[] = [];
		watcher.onChanged((event) => events.push(event));

		internals(watcher).handleGitDirEvent("workspace-1", "index");

		// Still pending after the short (worktree) window.
		jest.advanceTimersByTime(DEBOUNCE_MS);
		expect(events).toEqual([]);

		// Flushes once the wide window elapses.
		jest.advanceTimersByTime(GIT_DIR_DEBOUNCE_MS - DEBOUNCE_MS);
		expect(events).toEqual([{ workspaceId: "workspace-1" }]);
	});

	test("a worktree-path batch flushes on the short window", () => {
		const watcher = createWatcher();
		const events: GitChangedEvent[] = [];
		watcher.onChanged((event) => events.push(event));

		internals(watcher).addWorktreePaths("workspace-1", ["src/app.ts"]);

		jest.advanceTimersByTime(DEBOUNCE_MS);
		expect(events).toEqual([
			{ workspaceId: "workspace-1", paths: ["src/app.ts"] },
		]);
	});

	test("large worktree batches collapse to one broad invalidation", () => {
		const watcher = createWatcher();
		const events: GitChangedEvent[] = [];
		watcher.onChanged((event) => events.push(event));
		const paths = Array.from(
			{ length: MAX_WORKTREE_PATHS_PER_BATCH + 1 },
			(_, index) => `src/file-${index}.ts`,
		);

		internals(watcher).addWorktreePaths("workspace-1", paths);
		// Once broad, additional paths in the same window stay broad rather than
		// rebuilding an unbounded Set.
		internals(watcher).addWorktreePaths("workspace-1", ["src/later.ts"]);
		jest.advanceTimersByTime(DEBOUNCE_MS);

		expect(events).toEqual([{ workspaceId: "workspace-1" }]);
	});

	test("an ignore-rule change turns a scoped batch into a broad one", () => {
		const watcher = createWatcher();
		const events: GitChangedEvent[] = [];
		watcher.onChanged((event) => events.push(event));

		internals(watcher).addWorktreePaths("workspace-1", ["src/app.ts"]);
		internals(watcher).markWorktreeBroad("workspace-1");
		internals(watcher).addWorktreePaths("workspace-1", ["src/later.ts"]);
		jest.advanceTimersByTime(DEBOUNCE_MS);

		expect(events).toEqual([{ workspaceId: "workspace-1" }]);
	});

	test("a worktree edit joining a `.git/` batch restores the short window", () => {
		const watcher = createWatcher();
		const events: GitChangedEvent[] = [];
		watcher.onChanged((event) => events.push(event));

		// Starts as `.git/`-only (wide window)...
		internals(watcher).handleGitDirEvent("workspace-1", "index");
		// ...then a user edit joins, which should shorten the window.
		internals(watcher).addWorktreePaths("workspace-1", ["src/app.ts"]);

		jest.advanceTimersByTime(DEBOUNCE_MS);
		// Broad signal (no `paths`) because the batch saw `.git/` activity.
		expect(events).toEqual([{ workspaceId: "workspace-1" }]);
	});

	test("rapid `.git/`-only events ride the first wide window instead of resetting it", () => {
		const watcher = createWatcher();
		const events: GitChangedEvent[] = [];
		watcher.onChanged((event) => events.push(event));

		// First `.git/` event arms the wide window at t=0.
		internals(watcher).handleGitDirEvent("workspace-1", "index");
		jest.advanceTimersByTime(GIT_DIR_DEBOUNCE_MS - DEBOUNCE_MS);

		// A later `.git/`-only event must NOT push the flush out, or a rapid
		// metadata sequence (rebase, `git am`) would keep resetting the clock.
		internals(watcher).handleGitDirEvent("workspace-1", "HEAD");
		expect(events).toEqual([]);

		// The window armed by the first event still elapses on schedule.
		jest.advanceTimersByTime(DEBOUNCE_MS);
		expect(events).toEqual([{ workspaceId: "workspace-1" }]);
	});

	test("a batch with neither `.git/` activity nor worktree paths uses the short window", () => {
		const watcher = createWatcher();
		const events: GitChangedEvent[] = [];
		watcher.onChanged((event) => events.push(event));

		// Mirrors the worktree-fs branch that fires with no decodable paths:
		// the wide `.git/`-only window must not leak to it.
		internals(watcher).getOrCreateBatch("workspace-1");
		internals(watcher).scheduleFlush("workspace-1");

		jest.advanceTimersByTime(DEBOUNCE_MS);
		expect(events).toEqual([{ workspaceId: "workspace-1" }]);
	});
});

describe("(HOST-LAUNCH-IGNORED-FAIL) GitWatcher ignored-dir refresh", () => {
	const WORKSPACE = "workspace-1";
	const WORKTREE = "/repo";
	const T0 = new Date("2026-10-03T12:00:00Z").getTime();
	const PAST_THE_FLOOR_MS = 6_000;

	interface RefreshInternals {
		watched: Map<string, unknown>;
		refreshIgnoredDirs(workspaceId: string, worktreePath: string): void;
		getOrCreateIgnoredDirsState(workspaceId: string): {
			dirs: ReadonlySet<string>;
			rulesChanged: boolean;
			refreshing: boolean;
		};
	}

	let errors: ReturnType<typeof spyOn<Console, "error">>;
	beforeEach(() => {
		errors = spyOn(console, "error").mockImplementation(() => {});
	});
	afterEach(() => {
		errors.mockRestore();
		setSystemTime();
	});

	test.each<{
		name: string;
		gitDir: string | null;
		rulesChanged: boolean;
		listings: Array<"ok" | "fail">;
		refreshes: number;
		ruleRefreshes: number;
		logged: number;
		dirs: string[];
	}>([
		{
			name: "a non-git workspace with no rule change never lists",
			gitDir: null,
			rulesChanged: false,
			listings: [],
			refreshes: 1,
			ruleRefreshes: 0,
			logged: 0,
			dirs: ["dist"],
		},
		{
			name: "a non-git workspace with a rule change re-derives the prune without listing",
			gitDir: null,
			rulesChanged: true,
			listings: [],
			refreshes: 1,
			ruleRefreshes: 1,
			logged: 0,
			dirs: [],
		},
		{
			name: "failures with no rule change keep the set and log once per streak",
			gitDir: "/repo/.git",
			rulesChanged: false,
			listings: ["fail", "fail"],
			refreshes: 2,
			ruleRefreshes: 0,
			logged: 1,
			dirs: ["dist"],
		},
		{
			name: "a success ends the failure streak, so the next failure logs again",
			gitDir: "/repo/.git",
			rulesChanged: false,
			listings: ["fail", "ok", "fail"],
			refreshes: 3,
			ruleRefreshes: 0,
			logged: 2,
			dirs: ["out"],
		},
		{
			name: "a failure after a rule change clears the set and re-derives the prune once",
			gitDir: "/repo/.git",
			rulesChanged: true,
			listings: ["fail"],
			refreshes: 1,
			ruleRefreshes: 1,
			logged: 1,
			dirs: [],
		},
	])("$name", async (scenario) => {
		let listingCalls = 0;
		let ruleRefreshes = 0;
		const watcher = new GitWatcher(
			{} as unknown as ConstructorParameters<typeof GitWatcher>[0],
			{
				refreshWatcherIgnores: async () => {
					ruleRefreshes += 1;
					return false;
				},
			} as unknown as ConstructorParameters<typeof GitWatcher>[1],
			() => {},
			() => {
				const outcome = scenario.listings[listingCalls];
				listingCalls += 1;
				return outcome === "ok"
					? Promise.resolve(["out"])
					: Promise.reject(new Error("ls-files failed"));
			},
		);
		const inner = watcher as unknown as RefreshInternals;
		inner.watched.set(WORKSPACE, {
			workspaceId: WORKSPACE,
			worktreePath: WORKTREE,
			gitDir: scenario.gitDir,
			watcher: null,
			disposeWorktreeWatch: () => {},
		});
		const state = inner.getOrCreateIgnoredDirsState(WORKSPACE);
		state.dirs = new Set(["dist"]);
		state.rulesChanged = scenario.rulesChanged;

		for (let step = 0; step < scenario.refreshes; step += 1) {
			setSystemTime(new Date(T0 + step * PAST_THE_FLOOR_MS));
			inner.refreshIgnoredDirs(WORKSPACE, WORKTREE);
			while (state.refreshing) {
				await new Promise((resolve) => setTimeout(resolve, 0));
			}
		}

		const refreshFailures = errors.mock.calls.filter(
			([message]) => message === "[git-watcher] ignored-dir refresh failed",
		);
		expect(listingCalls).toBe(scenario.listings.length);
		expect(ruleRefreshes).toBe(scenario.ruleRefreshes);
		expect(refreshFailures.length).toBe(scenario.logged);
		expect([...state.dirs].sort()).toEqual(scenario.dirs);
	});
});

describe("(GIT-WATCH-PUBLISH) GitWatcher attach bookkeeping", () => {
	const WORKSPACE = "workspace-1";

	type GitDirOutcome = string | null | Error;

	let root: string;
	let calls: number;
	let pending: Array<(outcome: GitDirOutcome) => void>;
	let streamsOpened: number;
	let streamsClosed: number;
	let warn: ReturnType<typeof spyOn<Console, "warn">>;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "git-watch-attach-"));
		calls = 0;
		pending = [];
		streamsOpened = 0;
		streamsClosed = 0;
		warn = spyOn(console, "warn").mockImplementation(() => {});
	});
	afterEach(async () => {
		warn.mockRestore();
		await rm(root, { recursive: true, force: true });
	});

	const pendingGitDir: ResolveGitDir = () => {
		calls += 1;
		return new Promise<string | null>((resolve, reject) => {
			pending.push((outcome) =>
				outcome instanceof Error ? reject(outcome) : resolve(outcome),
			);
		});
	};

	function createAttachWatcher(
		resolveGitDir: ResolveGitDir = pendingGitDir,
	): GitWatcher {
		const row = { id: WORKSPACE, worktreePath: root };
		const db = {
			select: () => ({
				from: () => ({ where: () => ({ get: () => row, all: () => [row] }) }),
			}),
		};
		const filesystem = {
			isWatchAttachBackingOff: () => false,
			refreshWatcherIgnores: async () => false,
			getServiceForWorkspace: () => ({
				watchPath: () => {
					streamsOpened += 1;
					return {
						[Symbol.asyncIterator]: () => ({
							next: () => new Promise(() => {}),
							return: async () => {
								streamsClosed += 1;
								return { done: true, value: undefined };
							},
						}),
					};
				},
			}),
		};
		return new GitWatcher(
			db as unknown as ConstructorParameters<typeof GitWatcher>[0],
			filesystem as unknown as ConstructorParameters<typeof GitWatcher>[1],
			() => {},
			async () => [],
			resolveGitDir,
		);
	}

	async function settle(outcome: GitDirOutcome, watcher: GitWatcher) {
		const resolve = pending.shift();
		if (!resolve) throw new Error("no git-dir lookup in flight");
		resolve(outcome);
		const inner = internals(watcher);
		while (inner.attaching.size > 0) {
			await new Promise((r) => setTimeout(r, 0));
		}
	}

	test.each([
		["non-git", null],
		["fs.watch failure", join(tmpdir(), "missing-git-dir-for-test")],
	])("an abandoned %s attach publishes nothing", async (_name, gitDir) => {
		const watcher = createAttachWatcher();
		watcher.watchWorkspace(WORKSPACE);
		watcher.unwatchWorkspace(WORKSPACE);
		await settle(gitDir, watcher);

		expect(internals(watcher).watched.size).toBe(0);
		expect(streamsOpened).toBe(0);
		watcher.close();
	});

	test("an unwatch then rewatch during an attach reuses it and publishes once", async () => {
		const watcher = createAttachWatcher();
		watcher.watchWorkspace(WORKSPACE);
		watcher.unwatchWorkspace(WORKSPACE);
		watcher.watchWorkspace(WORKSPACE);
		await settle(null, watcher);

		expect(calls).toBe(1);
		expect(internals(watcher).watched.size).toBe(1);
		expect(streamsOpened).toBe(1);
		watcher.close();
	});

	test("rescan skips an in-flight attach and stops a watch nothing holds", async () => {
		const watcher = createAttachWatcher();
		const inner = internals(watcher);
		watcher.watchWorkspace(WORKSPACE);
		await inner.rescan();
		expect(calls).toBe(1);

		await settle(null, watcher);
		expect(inner.watched.size).toBe(1);

		inner.interest.clear();
		await inner.rescan();
		expect(inner.watched.size).toBe(0);
		expect(streamsClosed).toBe(1);
		watcher.close();
	});

	test("three tries total before a non-git fallback; a stop resets the count", async () => {
		const watcher = createAttachWatcher();
		const inner = internals(watcher);
		const failure = new Error("task timed out");
		const rescanFailing = async () => {
			const rescanning = inner.rescan();
			await settle(failure, watcher);
			await rescanning;
		};

		watcher.watchWorkspace(WORKSPACE);
		await settle(failure, watcher);
		await rescanFailing();
		expect(inner.watched.size).toBe(0);

		watcher.unwatchWorkspace(WORKSPACE);
		watcher.watchWorkspace(WORKSPACE);
		await settle(failure, watcher);
		await rescanFailing();
		expect(inner.watched.size).toBe(0);

		await rescanFailing();
		expect(inner.watched.get(WORKSPACE)?.gitDir).toBeNull();
		watcher.close();
	});

	test("a non-git publish emits one catch-up", async () => {
		const watcher = createAttachWatcher();
		const inner = internals(watcher);
		const events: GitChangedEvent[] = [];
		watcher.onChanged((event) => events.push(event));
		watcher.watchWorkspace(WORKSPACE);
		await settle(null, watcher);

		expect(inner.pendingBatches.get(WORKSPACE)?.hasGitDir).toBe(true);
		inner.flushBatch(WORKSPACE);
		expect(events).toEqual([{ workspaceId: WORKSPACE }]);
		watcher.close();
	});

	test("(GIT-WATCH-ATTACH-TASK) opening a folder de-inited off screen drops the cached yes without a git launch", async () => {
		await simpleGit(root).init();
		let gitChecks = 0;
		setIsGitRepoProbeForTests((dir) =>
			probeIsGitRepo(dir, {
				entryProbe: findGitEntryUpTree,
				gitCheck: async () => {
					gitChecks += 1;
					return true;
				},
			}),
		);
		const watcher = createAttachWatcher(resolveGitDirInWorker);
		const inner = internals(watcher);
		try {
			expect(await isGitRepo(root)).toBe(true);
			await rm(join(root, ".git"), { recursive: true, force: true });

			watcher.watchWorkspace(WORKSPACE);
			const deadline = Date.now() + 5_000;
			while (!inner.watched.has(WORKSPACE)) {
				if (Date.now() > deadline) throw new Error("attach did not publish");
				await new Promise((resolve) => setTimeout(resolve, 10));
			}

			expect(inner.watched.get(WORKSPACE)?.gitDir).toBeNull();
			expect(inner.pendingBatches.get(WORKSPACE)?.hasGitDir).toBe(true);
			expect(await isGitRepo(root)).toBe(false);
			expect(gitChecks).toBe(1);
		} finally {
			watcher.close();
			resetIsGitRepoCacheForTests();
			resetGitEntryProbeForTests();
		}
	});
});
