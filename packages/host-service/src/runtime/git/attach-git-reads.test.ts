import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import simpleGit from "simple-git";
import { GitWatcher } from "../../events/git-watcher";
import { resolveGitDirInWorker } from "./attach-git-reads";
import {
	findGitEntryUpTree,
	resetGitEntryProbeForTests,
} from "./git-entry-probe";
import {
	isGitRepo,
	probeIsGitRepo,
	resetIsGitRepoCacheForTests,
	setIsGitRepoProbeForTests,
} from "./non-git";

let repo: string;
let gitChecks: number;

beforeEach(async () => {
	repo = await mkdtemp(join(tmpdir(), "git-watch-deinit-"));
	await simpleGit(repo).init();
	gitChecks = 0;
	setIsGitRepoProbeForTests((dir) =>
		probeIsGitRepo(dir, {
			entryProbe: findGitEntryUpTree,
			gitCheck: async () => {
				gitChecks += 1;
				return true;
			},
		}),
	);
});

afterEach(async () => {
	resetIsGitRepoCacheForTests();
	resetGitEntryProbeForTests();
	await rm(repo, { recursive: true, force: true });
});

test("(GIT-WATCH-ATTACH-TASK) opening a folder de-inited off screen drops the cached yes without a git launch", async () => {
	expect(await isGitRepo(repo)).toBe(true);
	expect(gitChecks).toBe(1);

	await rm(join(repo, ".git"), { recursive: true, force: true });

	const workspaceId = "deinit";
	const row = { id: workspaceId, worktreePath: repo };
	const db = {
		select: () => ({
			from: () => ({ where: () => ({ get: () => row, all: () => [row] }) }),
		}),
	};
	const filesystem = {
		isWatchAttachBackingOff: () => false,
		getServiceForWorkspace: () => ({
			watchPath: () => ({
				[Symbol.asyncIterator]: () => ({
					next: () => new Promise(() => {}),
					return: async () => ({ done: true, value: undefined }),
				}),
			}),
		}),
	};
	const watcher = new GitWatcher(
		db as unknown as ConstructorParameters<typeof GitWatcher>[0],
		filesystem as unknown as ConstructorParameters<typeof GitWatcher>[1],
		() => {},
		async () => [],
		resolveGitDirInWorker,
	);
	const inner = watcher as unknown as {
		watched: Map<string, { gitDir: string | null }>;
		pendingBatches: Map<string, { hasGitDir: boolean }>;
	};
	try {
		watcher.watchWorkspace(workspaceId);
		const deadline = Date.now() + 5_000;
		while (!inner.watched.has(workspaceId)) {
			if (Date.now() > deadline) throw new Error("attach did not publish");
			await new Promise((resolve) => setTimeout(resolve, 10));
		}

		expect(inner.watched.get(workspaceId)?.gitDir).toBeNull();
		expect(inner.pendingBatches.get(workspaceId)?.hasGitDir).toBe(true);
		expect(await isGitRepo(repo)).toBe(false);
		expect(gitChecks).toBe(1);
	} finally {
		watcher.close();
	}
});
