import { afterEach, expect, spyOn, test } from "bun:test";
import * as fsPromises from "node:fs/promises";
import {
	mkdir,
	mkdtemp,
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import simpleGit, { type SimpleGit } from "simple-git";
import type { HostServiceContext } from "../../../types";
import { gitRouter } from "./git";
import { awaitBaseRefRepairs } from "./utils/base-ref-repair";
import { detectUnstagedRenames } from "./utils/git-helpers";
import {
	emptyGitStatusSnapshot,
	getGitStatusSnapshot,
} from "./utils/git-status";
import { gitStatusRefreshLimiter } from "./utils/git-status-refresh-limiter";
import { GitStatusStore, gitStatusStore } from "./utils/git-status-store";
import { createStatsCompleteness } from "./utils/stats-completeness";

const workspaceId = "diff-stats-test";
const otherWorkspaceId = "diff-stats-other";
const roots: string[] = [];
afterEach(async () => {
	gitStatusStore.drop(workspaceId);
	gitStatusStore.drop(otherWorkspaceId);
	// (DIFFSTATS-COLD-CACHE)
	await awaitBaseRefRepairs();
	await Promise.all(
		roots.splice(0).map((root) =>
			rm(root, {
				recursive: true,
				force: true,
				maxRetries: 50,
				retryDelay: 100,
			}),
		),
	);
});

// (DIFFSTATS-COLD-CACHE)
async function hasRef(git: SimpleGit, ref: string): Promise<boolean> {
	const refs = await git.raw(["for-each-ref", "--format=%(refname)"]);
	return refs.split("\n").includes(ref);
}

async function repoWithFile(name: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "diff-stats-"));
	roots.push(root);
	const git = simpleGit(root);
	await git.init();
	await git.raw(["config", "user.email", "test@example.com"]);
	await git.raw(["config", "user.name", "test"]);
	await git.raw(["config", "commit.gpgsign", "false"]);
	await git.raw(["symbolic-ref", "HEAD", "refs/heads/main"]);
	await writeFile(join(root, "seed.txt"), "seed\n");
	await git.add(".");
	await git.commit("initial");
	await writeFile(join(root, name), "new file\n");
	return root;
}

// (DIFFSTATS-COLD-CACHE) One workspace's cold reads against a real repo: the
// walk tracks what it could not read, and the store only caches a walk that
// read everything.
function coldStore(args: {
	workspaceId: string;
	git: SimpleGit;
	worktreePath: string;
	directoryId: string;
}) {
	const store = new GitStatusStore();
	const calls = { full: 0 };
	let incompleteStats: string[] = [];
	const input = {
		workspaceId: args.workspaceId,
		baseBranch: null,
		coldCache: {
			worktreePath: args.worktreePath,
			directoryId: args.directoryId,
		},
		computeFull: async () => {
			calls.full++;
			const walk = await getGitStatusSnapshot({
				git: args.git,
				worktreePath: args.worktreePath,
				trackStatsCompleteness: true,
			});
			incompleteStats = walk.incompleteStats;
			return walk.snapshot;
		},
		statsComplete: () => incompleteStats.length === 0,
		computePartial: async () => {
			throw new Error("cold reads must not compute partial status");
		},
	};
	return {
		calls,
		read: () => store.read(input),
		incompleteStats: () => incompleteStats,
	};
}

// (DIFFSTATS-COLD-CACHE)
function callerFor(getPath: () => string | null) {
	return gitRouter.createCaller({
		isAuthenticated: true,
		db: {
			query: {
				workspaces: {
					findFirst: () => ({
						sync: () => {
							const worktreePath = getPath();
							return worktreePath ? { worktreePath } : undefined;
						},
					}),
				},
			},
		},
		credentials: {
			getCredentials: async () => ({ env: {} }),
			getToken: async () => null,
		},
	} as unknown as HostServiceContext);
}

// (DIFFSTATS-COLD-CACHE)
test("diff stats cache only background reads, refreshes on mutation, and checks workspace identity", async () => {
	let currentPath: string | null = await repoWithFile("first.txt");
	const caller = callerFor(() => currentPath);
	const read = async () =>
		(await caller.getDiffStatsByWorkspaces({ workspaceIds: [workspaceId] }))
			.workspaces;

	expect((await read())[0]?.fileCount).toBe(1);
	await writeFile(join(currentPath, "second.txt"), "another file\n");
	expect((await read())[0]?.fileCount).toBe(1);
	expect((await caller.getStatus({ workspaceId })).unstaged).toHaveLength(2);
	expect((await read())[0]?.fileCount).toBe(1);

	await caller.stageFile({ workspaceId, filePath: "second.txt" });
	expect((await read())[0]?.fileCount).toBe(2);
	currentPath = await repoWithFile("third.txt");
	expect((await read())[0]?.fileCount).toBe(1);
	const replacement = await repoWithFile("fourth.txt");
	await writeFile(join(replacement, "fifth.txt"), "another file\n");
	const moved = `${currentPath}-old`;
	await rename(currentPath, moved);
	roots.push(moved);
	await rename(replacement, currentPath);
	expect((await read())[0]?.fileCount).toBe(2);
	currentPath = null;
	expect(await read()).toEqual([]);
}, 60_000);

// (DIFFSTATS-COLD-CACHE)
test("queued foreground status does not join a cold diff-stats read", async () => {
	const worktreePath = await repoWithFile("first.txt");
	const caller = callerFor(() => worktreePath);
	expect(
		(await caller.getDiffStatsByWorkspaces({ workspaceIds: [workspaceId] }))
			.workspaces[0]?.fileCount,
	).toBe(1);
	await writeFile(join(worktreePath, "second.txt"), "another file\n");

	let release!: () => void;
	const blocked = new Promise<void>((resolve) => {
		release = resolve;
	});
	const occupying = gitStatusRefreshLimiter.run({
		workspaceId,
		requestKey: "occupying-slot",
		run: async () => blocked,
	});
	const originalRun = gitStatusRefreshLimiter.run.bind(gitStatusRefreshLimiter);
	let backgroundQueued!: () => void;
	let foregroundQueued!: () => void;
	const queued = new Promise<void>((resolve) => {
		backgroundQueued = resolve;
	});
	const foregroundReady = new Promise<void>((resolve) => {
		foregroundQueued = resolve;
	});
	const runSpy = spyOn(gitStatusRefreshLimiter, "run").mockImplementation(
		(options) => {
			const result = originalRun(options);
			if (options.priority === "background") backgroundQueued();
			else foregroundQueued();
			return result;
		},
	);
	try {
		const cold = caller.getDiffStatsByWorkspaces({
			workspaceIds: [workspaceId],
		});
		await queued;
		const foreground = caller.getStatus({ workspaceId });
		await foregroundReady;
		release();
		await occupying;
		expect((await cold).workspaces[0]?.fileCount).toBe(1);
		expect((await foreground).unstaged).toHaveLength(2);
	} finally {
		release();
		runSpy.mockRestore();
	}
}, 60_000);

// (DIFFSTATS-COLD-CACHE)
test("staging through one workspace invalidates a second workspace on the same checkout", async () => {
	const worktreePath = await repoWithFile("first.txt");
	const caller = callerFor(() => worktreePath);
	const read = async () =>
		(
			await caller.getDiffStatsByWorkspaces({
				workspaceIds: [workspaceId, otherWorkspaceId],
			})
		).workspaces;

	expect((await read()).map((entry) => entry.fileCount)).toEqual([1, 1]);
	await writeFile(join(worktreePath, "second.txt"), "another file\n");
	await caller.stageFile({ workspaceId, filePath: "second.txt" });
	expect((await read()).map((entry) => entry.fileCount)).toEqual([2, 2]);
}, 60_000);

// (DIFFSTATS-COLD-CACHE)
test("a failed internal numstat command serves the walk but cannot cache it", async () => {
	const worktreePath = await repoWithFile("first.txt");
	await writeFile(join(worktreePath, "seed.txt"), "changed\nsecond\n");
	const git = simpleGit(worktreePath);
	const cold = coldStore({
		workspaceId: "failed-diff",
		git,
		worktreePath,
		directoryId: "same-directory",
	});
	const raw = git.raw.bind(git);
	const failedDiff = spyOn(git, "raw").mockImplementation(((
		args: string | string[],
	) =>
		Array.isArray(args) && args.join(" ") === "diff --numstat -z"
			? Promise.reject(new Error("numstat failed"))
			: raw(args)) as typeof git.raw);
	let degraded: Awaited<ReturnType<typeof cold.read>>;
	try {
		degraded = await cold.read();
	} finally {
		failedDiff.mockRestore();
	}
	expect(
		degraded.unstaged.find((entry) => entry.path === "seed.txt")?.additions,
	).toBe(0);
	expect(cold.incompleteStats()).toEqual(["diff --numstat -z: numstat failed"]);

	const fresh = await cold.read();
	expect(
		fresh.unstaged.find((entry) => entry.path === "seed.txt")?.additions,
	).toBe(2);
	await cold.read();
	expect(cold.calls.full).toBe(2);
}, 60_000);

// (DIFFSTATS-COLD-CACHE)
test("unborn HEAD still reports staged and untracked diff stats", async () => {
	const worktreePath = await mkdtemp(join(tmpdir(), "diff-stats-unborn-"));
	roots.push(worktreePath);
	const git = simpleGit(worktreePath);
	await git.init();
	await git.raw(["symbolic-ref", "HEAD", "refs/heads/main"]);
	await writeFile(join(worktreePath, "staged.txt"), "one\ntwo\n");
	await git.add("staged.txt");
	await writeFile(join(worktreePath, "untracked.txt"), "three\n");

	const caller = callerFor(() => worktreePath);
	const { workspaces } = await caller.getDiffStatsByWorkspaces({
		workspaceIds: [workspaceId],
	});
	expect(workspaces).toEqual([
		{
			workspaceId,
			additions: 3,
			deletions: 0,
			fileCount: 2,
		},
	]);
}, 60_000);

// (DIFFSTATS-COLD-CACHE)
test("an unreadable untracked file is served with no count and never cached", async () => {
	const worktreePath = await repoWithFile("locked.txt");
	await writeFile(join(worktreePath, "readable.txt"), "one\ntwo\n");
	const git = simpleGit(worktreePath);
	const cold = coldStore({
		workspaceId: "unreadable-file",
		git,
		worktreePath,
		directoryId: "same-directory",
	});
	const originalOpen = fsPromises.open;
	const lockedOpen = spyOn(fsPromises, "open").mockImplementation(
		(path, flags, mode) => {
			if (String(path) === join(worktreePath, "locked.txt")) {
				return Promise.reject(
					Object.assign(new Error("file is locked"), { code: "EBUSY" }),
				);
			}
			return originalOpen(path, flags, mode);
		},
	);
	let degraded: Awaited<ReturnType<typeof cold.read>>;
	try {
		degraded = await cold.read();
	} finally {
		lockedOpen.mockRestore();
	}
	const byPath = new Map(degraded.unstaged.map((entry) => [entry.path, entry]));
	expect(byPath.get("locked.txt")?.additions).toBeNull();
	expect(byPath.get("readable.txt")?.additions).toBe(2);
	expect(cold.incompleteStats()).toEqual(["locked.txt: file is locked"]);

	const repaired = await cold.read();
	expect(
		repaired.unstaged.find((entry) => entry.path === "locked.txt")?.additions,
	).toBe(1);
	expect(cold.calls.full).toBe(2);
}, 60_000);

// (DIFFSTATS-COLD-CACHE)
test("staging invalidates another workspace reached through a directory link", async () => {
	const worktreePath = await repoWithFile("first.txt");
	const alias = `${worktreePath}-link`;
	await symlink(
		worktreePath,
		alias,
		process.platform === "win32" ? "junction" : "dir",
	);
	roots.push(alias);
	let currentPath = worktreePath;
	const caller = callerFor(() => currentPath);
	const read = async (id: string) =>
		(await caller.getDiffStatsByWorkspaces({ workspaceIds: [id] }))
			.workspaces[0]?.fileCount;

	expect(await read(workspaceId)).toBe(1);
	currentPath = alias;
	expect(await read(otherWorkspaceId)).toBe(1);
	await writeFile(join(worktreePath, "second.txt"), "another file\n");
	currentPath = worktreePath;
	await caller.stageFile({ workspaceId, filePath: "second.txt" });
	currentPath = alias;
	expect(await read(otherWorkspaceId)).toBe(2);
}, 60_000);

// (DIFFSTATS-COLD-CACHE)
test("failed rename detection serves the unmerged walk and never caches it", async () => {
	const worktreePath = await repoWithFile("first.txt");
	const git = simpleGit(worktreePath);
	await git.add("first.txt");
	await git.commit("add file");
	await rename(
		join(worktreePath, "first.txt"),
		join(worktreePath, "moved.txt"),
	);
	const cold = coldStore({
		workspaceId: "rename-failure",
		git,
		worktreePath,
		directoryId: "rename-directory",
	});
	const failedCopy = spyOn(fsPromises, "copyFile").mockRejectedValue(
		new Error("index copy failed"),
	);
	let degraded: Awaited<ReturnType<typeof cold.read>>;
	try {
		degraded = await cold.read();
	} finally {
		failedCopy.mockRestore();
	}
	expect(
		degraded.unstaged
			.map((entry) => [entry.path, entry.status])
			.sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
	).toEqual([
		["first.txt", "deleted"],
		["moved.txt", "untracked"],
	]);
	expect(cold.incompleteStats()).toEqual([
		"rename detection: index copy failed",
	]);

	const repaired = await cold.read();
	expect(repaired.unstaged.map((entry) => [entry.path, entry.status])).toEqual([
		["moved.txt", "renamed"],
	]);
	expect(cold.calls.full).toBe(2);
}, 60_000);

// (DIFFSTATS-COLD-CACHE)
test("a tracked file git cannot hash is served as zero and never cached", async () => {
	const worktreePath = await repoWithFile("first.txt");
	await writeFile(join(worktreePath, "seed.txt"), "changed\nsecond\n");
	const git = simpleGit(worktreePath);
	const cold = coldStore({
		workspaceId: "locked-tracked-file",
		git,
		worktreePath,
		directoryId: "locked-directory",
	});
	const raw = git.raw.bind(git);
	const lockedFile = spyOn(git, "raw").mockImplementation(((
		args: string | string[],
	) =>
		Array.isArray(args) && args.join(" ") === "diff --numstat -z"
			? Promise.reject(
					new Error(
						'error: open("seed.txt"): Permission denied\nfatal: cannot hash seed.txt',
					),
				)
			: raw(args)) as typeof git.raw);
	let degraded: Awaited<ReturnType<typeof cold.read>>;
	try {
		degraded = await cold.read();
	} finally {
		lockedFile.mockRestore();
	}
	expect(
		degraded.unstaged.find((entry) => entry.path === "seed.txt")?.additions,
	).toBe(0);
	expect(cold.incompleteStats()).toHaveLength(1);
	expect(cold.incompleteStats()[0]).toContain("cannot hash seed.txt");

	const repaired = await cold.read();
	expect(
		repaired.unstaged.find((entry) => entry.path === "seed.txt")?.additions,
	).toBe(2);
	expect(cold.calls.full).toBe(2);
}, 60_000);

// (DIFFSTATS-COLD-CACHE)
test("a base branch with unrelated history reports the foreground stats", async () => {
	const worktreePath = await repoWithFile("first.txt");
	const git = simpleGit(worktreePath);
	await git.raw(["checkout", "--orphan", "pages"]);
	await git.raw(["read-tree", "--empty"]);
	await rm(join(worktreePath, "seed.txt"));
	await rm(join(worktreePath, "first.txt"));
	await writeFile(join(worktreePath, "page.txt"), "one\ntwo\n");
	await git.add("page.txt");
	await git.commit("orphan page");
	await git.raw(["config", "branch.main.remote", "."]);
	await git.raw(["config", "branch.main.merge", "refs/heads/main"]);
	await writeFile(join(worktreePath, "pending.txt"), "a\nb\nc\n");

	const read = async (trackStatsCompleteness: boolean) =>
		getGitStatusSnapshot({
			git,
			worktreePath,
			baseBranch: "main",
			trackStatsCompleteness,
		});
	const strict = await read(true);
	expect(strict.incompleteStats).toEqual([]);
	expect(strict.snapshot.againstBase).toEqual([]);
	expect(
		strict.snapshot.unstaged.map((entry) => [entry.path, entry.additions]),
	).toEqual([["pending.txt", 3]]);
	expect(strict.snapshot).toEqual((await read(false)).snapshot);
}, 60_000);

// (DIFFSTATS-COLD-CACHE)
test("a merge-base failure on a resolvable base ref is reported as incomplete", async () => {
	const worktreePath = await repoWithFile("first.txt");
	const git = simpleGit(worktreePath);
	await git.add("first.txt");
	await git.commit("add file");
	await git.raw(["config", "branch.main.remote", "."]);
	await git.raw(["config", "branch.main.merge", "refs/heads/main"]);

	const raw = git.raw.bind(git);
	const brokenMergeBase = spyOn(git, "raw").mockImplementation(((
		args: string | string[],
	) =>
		Array.isArray(args) && args[0] === "merge-base"
			? Promise.reject(new Error("fatal: bad object main"))
			: raw(args)) as typeof git.raw);
	try {
		const walk = await getGitStatusSnapshot({
			git,
			worktreePath,
			baseBranch: "main",
			trackStatsCompleteness: true,
		});
		expect(walk.snapshot.againstBase).toEqual([]);
		expect(walk.incompleteStats).toEqual([
			"merge-base main: fatal: bad object main",
		]);
		expect(
			(await getGitStatusSnapshot({ git, worktreePath, baseBranch: "main" }))
				.snapshot.againstBase,
		).toEqual([]);
	} finally {
		brokenMergeBase.mockRestore();
	}
}, 60_000);

// (DIFFSTATS-COLD-CACHE)
test("an unreadable origin/HEAD is reported as incomplete", async () => {
	const worktreePath = await repoWithFile("first.txt");
	const git = simpleGit(worktreePath);
	const raw = git.raw.bind(git);
	const brokenSymref = spyOn(git, "raw").mockImplementation(((
		args: string | string[],
	) =>
		Array.isArray(args) && args[0] === "symbolic-ref"
			? Promise.reject(new Error("fatal: not a git repository"))
			: raw(args)) as typeof git.raw);
	try {
		const walk = await getGitStatusSnapshot({
			git,
			worktreePath,
			trackStatsCompleteness: true,
		});
		expect(walk.incompleteStats).toEqual([
			"origin/HEAD: fatal: not a git repository",
		]);
	} finally {
		brokenSymref.mockRestore();
	}
	expect(
		(
			await getGitStatusSnapshot({
				git,
				worktreePath,
				trackStatsCompleteness: true,
			})
		).incompleteStats,
	).toEqual([]);
}, 60_000);

// (DIFFSTATS-COLD-CACHE)
test("a mutation invalidates a sibling checkout with no cold entry of its own", async () => {
	const store = new GitStatusStore();
	const coldCache = {
		worktreePath: "/shared/checkout",
		directoryId: "shared-directory",
	};
	const computePartial = async () => {
		throw new Error("cold reads must not compute partial status");
	};
	let siblingReads = 0;
	const sibling = {
		workspaceId: "sibling",
		baseBranch: null,
		coldCache,
		computeFull: async () => {
			siblingReads++;
			return emptyGitStatusSnapshot();
		},
		computePartial,
	};
	let mutatingFails = false;
	const mutating = {
		workspaceId: "mutating",
		baseBranch: null,
		coldCache,
		computeFull: async () => {
			if (mutatingFails) throw new Error("cold read failed");
			return emptyGitStatusSnapshot();
		},
		computePartial,
	};

	await store.read(mutating);
	await store.read(sibling);
	expect(siblingReads).toBe(1);

	store.recordChange("mutating", undefined);
	mutatingFails = true;
	await expect(store.read(mutating)).rejects.toThrow("cold read failed");
	await store.read(sibling);
	await store.read(sibling);
	expect(siblingReads).toBe(2);

	store.recordChange("mutating", undefined);
	await store.read(sibling);
	expect(siblingReads).toBe(3);
});

// (DIFFSTATS-COLD-CACHE)
test("a mutation invalidates a sibling checkout after the mutating workspace was unwatched", async () => {
	const store = new GitStatusStore();
	const coldCache = {
		worktreePath: "/shared/unwatched",
		directoryId: "unwatched-directory",
	};
	const computePartial = async () => {
		throw new Error("cold reads must not compute partial status");
	};
	let siblingReads = 0;
	const sibling = {
		workspaceId: "unwatched-sibling",
		baseBranch: null,
		coldCache,
		computeFull: async () => {
			siblingReads++;
			return emptyGitStatusSnapshot();
		},
		computePartial,
	};
	const mutating = {
		workspaceId: "unwatched-mutating",
		baseBranch: null,
		coldCache,
		computeFull: async () => emptyGitStatusSnapshot(),
		computePartial,
	};

	await store.read(mutating);
	store.drop("unwatched-mutating");
	await store.read(sibling);
	await store.read(sibling);
	expect(siblingReads).toBe(1);

	store.recordChange("unwatched-mutating", undefined);
	await store.read(sibling);
	expect(siblingReads).toBe(2);

	store.forgetDeletedWorkspace("unwatched-mutating");
	await store.read(sibling);
	expect(siblingReads).toBe(3);

	store.recordChange("unwatched-mutating", undefined);
	await store.read(sibling);
	expect(siblingReads).toBe(3);
});

// (DIFFSTATS-COLD-CACHE)
test("missing base ref reports diff stats and repairs the ref in the background", async () => {
	const worktreePath = await repoWithFile("first.txt");
	const remote = await mkdtemp(join(tmpdir(), "diff-stats-remote-"));
	roots.push(remote);
	const git = simpleGit(worktreePath);
	await simpleGit(remote).init(true);
	await git.add("first.txt");
	await git.commit("add file");
	await git.raw(["remote", "add", "upstream", remote]);
	await git.raw(["push", "upstream", "main:main"]);
	await git.raw(["update-ref", "-d", "refs/remotes/upstream/main"]);
	await git.raw(["config", "branch.main.remote", "upstream"]);
	await git.raw(["config", "branch.main.merge", "refs/heads/main"]);
	await git.raw([
		"symbolic-ref",
		"refs/remotes/origin/HEAD",
		"refs/remotes/origin/main",
	]);
	await writeFile(join(worktreePath, "pending.txt"), "one\ntwo\n");
	expect(await hasRef(git, "refs/remotes/upstream/main")).toBe(false);

	const caller = callerFor(() => worktreePath);
	const read = async () =>
		(await caller.getDiffStatsByWorkspaces({ workspaceIds: [workspaceId] }))
			.workspaces;
	expect(await read()).toEqual([
		{ workspaceId, additions: 2, deletions: 0, fileCount: 1 },
	]);

	await awaitBaseRefRepairs();
	expect(await hasRef(git, "refs/remotes/upstream/main")).toBe(true);

	await writeFile(join(worktreePath, "later.txt"), "three\n");
	expect(await read()).toEqual([
		{ workspaceId, additions: 3, deletions: 0, fileCount: 2 },
	]);
}, 60_000);

// (DIFFSTATS-COLD-CACHE)
test("an untracked file deleted mid-walk still reports the cold read", async () => {
	const worktreePath = await repoWithFile("vanishing.txt");
	await writeFile(join(worktreePath, "readable.txt"), "one\ntwo\n");
	const git = simpleGit(worktreePath);
	const cold = coldStore({
		workspaceId: "vanished-file",
		git,
		worktreePath,
		directoryId: "vanished-directory",
	});
	const originalRealpath = fsPromises.realpath;
	const vanished = spyOn(fsPromises, "realpath").mockImplementation((async (
		path: Parameters<typeof fsPromises.realpath>[0],
	) => {
		if (String(path) === join(worktreePath, "vanishing.txt")) {
			throw Object.assign(new Error("ENOENT: no such file or directory"), {
				code: "ENOENT",
			});
		}
		return originalRealpath(path);
	}) as typeof fsPromises.realpath);
	let snapshot: Awaited<ReturnType<typeof cold.read>>;
	try {
		snapshot = await cold.read();
	} finally {
		vanished.mockRestore();
	}
	const byPath = new Map(snapshot.unstaged.map((entry) => [entry.path, entry]));
	expect(byPath.get("vanishing.txt")?.additions).toBeNull();
	expect(byPath.get("readable.txt")?.additions).toBe(2);
	expect(cold.incompleteStats()).toEqual([]);
}, 60_000);

// (DIFFSTATS-COLD-CACHE)
test("rename detection reports no renames when a pathspec vanished", async () => {
	const worktreePath = await repoWithFile("first.txt");
	const git = simpleGit(worktreePath);
	await git.add("first.txt");
	await git.commit("add file");
	await rm(join(worktreePath, "first.txt"));
	const completeness = createStatsCompleteness();
	expect(
		await detectUnstagedRenames(
			git,
			worktreePath,
			["ghost.txt"],
			true,
			completeness,
		),
	).toEqual([]);
	expect(completeness.incomplete).toEqual([]);
}, 60_000);

// (DIFFSTATS-COLD-CACHE)
test("rename detection keeps the renames that survive a vanished pathspec", async () => {
	const worktreePath = await repoWithFile("first.txt");
	const git = simpleGit(worktreePath);
	await git.add("first.txt");
	await git.commit("add file");
	await rename(
		join(worktreePath, "first.txt"),
		join(worktreePath, "moved.txt"),
	);
	const completeness = createStatsCompleteness();
	const renames = await detectUnstagedRenames(
		git,
		worktreePath,
		["moved.txt", "ghost.txt"],
		true,
		completeness,
	);
	expect(renames).toHaveLength(1);
	expect(renames[0]).toMatchObject({
		oldPath: "first.txt",
		newPath: "moved.txt",
		status: "renamed",
	});
	expect(completeness.incomplete).toEqual([]);
}, 60_000);

// (DIFFSTATS-COLD-CACHE) A pathspec file settles the separator, not glob
// magic: without `:(literal)` the untracked `src[1].txt` also matches the
// deleted tracked `src1.txt`, whose deletion git then stages into the temp
// index, taking the rename source with it.
test("rename detection reads glob characters in an untracked name literally", async () => {
	const worktreePath = await repoWithFile("unused.txt");
	const git = simpleGit(worktreePath);
	await rm(join(worktreePath, "unused.txt"));
	await writeFile(join(worktreePath, "src1.txt"), "alpha\nbeta\ngamma\n");
	await git.add("src1.txt");
	await git.commit("add file");
	await rename(
		join(worktreePath, "src1.txt"),
		join(worktreePath, "src[1].txt"),
	);

	const completeness = createStatsCompleteness();
	const renames = await detectUnstagedRenames(
		git,
		worktreePath,
		["src[1].txt"],
		true,
		completeness,
	);
	expect(renames).toHaveLength(1);
	expect(renames[0]).toMatchObject({
		oldPath: "src1.txt",
		newPath: "src[1].txt",
		status: "renamed",
	});
	expect(completeness.incomplete).toEqual([]);
}, 60_000);

// (DIFFSTATS-COLD-CACHE) One `:(literal)` argv entry per untracked directory
// overruns the same Windows command line the intent-to-add pathspecs do.
test("hundreds of untracked directories expand without degrading the walk", async () => {
	const worktreePath = await repoWithFile("first.txt");
	const shards = Array.from(
		{ length: 700 },
		(_, index) =>
			`untracked-output-shard-${String(index).padStart(4, "0")}-${"x".repeat(30)}`,
	);
	await Promise.all(
		shards.map(async (shard) => {
			await mkdir(join(worktreePath, shard));
			await writeFile(join(worktreePath, shard, "bundle.js"), "content\n");
		}),
	);

	const cold = coldStore({
		workspaceId: "untracked-dirs",
		git: simpleGit(worktreePath),
		worktreePath,
		directoryId: "untracked-dirs-directory",
	});
	const snapshot = await cold.read();
	expect(cold.incompleteStats()).toEqual([]);
	const expanded = snapshot.unstaged.filter((entry) =>
		entry.path.endsWith("/bundle.js"),
	);
	expect(expanded).toHaveLength(shards.length);
	expect(expanded[0]?.additions).toBe(1);
}, 120_000);

// (DIFFSTATS-COLD-CACHE) The mutating workspace of a shared checkout is
// routinely the one only the Changes tab reads, so a foreground read is what
// tells the store which cold rows that mutation has to drop.
test("a foreground read is enough to invalidate a sibling checkout", async () => {
	const worktreePath = await repoWithFile("first.txt");
	const caller = callerFor(() => worktreePath);
	const siblingFileCount = async () =>
		(
			await caller.getDiffStatsByWorkspaces({
				workspaceIds: [otherWorkspaceId],
			})
		).workspaces[0]?.fileCount;

	expect((await caller.getStatus({ workspaceId })).unstaged).toHaveLength(1);
	expect(await siblingFileCount()).toBe(1);

	await writeFile(join(worktreePath, "second.txt"), "another file\n");
	await caller.stageFile({ workspaceId, filePath: "second.txt" });
	expect(await siblingFileCount()).toBe(2);
}, 60_000);

// (DIFFSTATS-COLD-CACHE) Every untracked path used to become one argv entry,
// which overruns the Windows command line well below the 5000-file cap that
// skips rename detection.
test("a large untracked set alongside a deletion still detects renames", async () => {
	const worktreePath = await repoWithFile("first.txt");
	const git = simpleGit(worktreePath);
	await git.add("first.txt");
	await git.commit("add file");
	await rename(
		join(worktreePath, "first.txt"),
		join(worktreePath, "moved.txt"),
	);
	const generated = join(worktreePath, "generated", "output", "assets");
	await mkdir(generated, { recursive: true });
	await Promise.all(
		Array.from({ length: 800 }, (_, index) =>
			writeFile(
				join(generated, `chunk-vendor-${index}.generated.js`),
				"content\n",
			),
		),
	);

	const cold = coldStore({
		workspaceId: "large-untracked",
		git,
		worktreePath,
		directoryId: "large-directory",
	});
	const snapshot = await cold.read();
	expect(cold.incompleteStats()).toEqual([]);
	expect(
		snapshot.unstaged.find((entry) => entry.path === "moved.txt"),
	).toMatchObject({ status: "renamed", oldPath: "first.txt" });
	expect(snapshot.unstaged).toHaveLength(801);
}, 120_000);
