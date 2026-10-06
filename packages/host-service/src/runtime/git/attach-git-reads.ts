// (GIT-WATCH-ATTACH-TASK) Attach-time git reads for GitWatcher, off the main
// thread. A rejected gitDir run (timeout/abort) is infrastructure, not git.
import { getHostWorkerPool } from "../../workers/host-worker-pool.ts";
import {
	gitDirTask,
	gitIgnoredDirsTask,
} from "../../workers/tasks/git-reads.ts";
import { findGitEntryUpTree } from "./git-entry-probe.ts";
import { invalidateIsGitRepo } from "./non-git.ts";

const GIT_DIR_TIMEOUT_MS = 5_000;
const PRUNE_LISTING_BUDGET_MS = 3_000;

export async function resolveGitDirInWorker(
	worktreePath: string,
): Promise<string | null> {
	const entry = await findGitEntryUpTree(worktreePath).catch(
		() => "unknown" as const,
	);
	if (entry === "absent") {
		invalidateIsGitRepo(worktreePath);
		return null;
	}
	const { gitDir } = await getHostWorkerPool().run(
		gitDirTask,
		{ worktreePath },
		{
			strategy: "coalesce",
			dedupeKey: `${worktreePath}:git-dir`,
			timeoutMs: GIT_DIR_TIMEOUT_MS,
		},
	);
	return gitDir;
}

export async function listGitIgnoredDirsInWorker(
	rootPath: string,
): Promise<string[]> {
	try {
		return await getHostWorkerPool().run(
			gitIgnoredDirsTask,
			{ rootPath },
			{
				strategy: "fifo",
				signal: AbortSignal.timeout(PRUNE_LISTING_BUDGET_MS),
			},
		);
	} catch {
		return [];
	}
}
