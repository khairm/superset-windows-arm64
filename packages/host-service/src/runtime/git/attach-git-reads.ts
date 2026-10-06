// (GIT-WATCH-ATTACH-TASK) Attach-time git reads for GitWatcher, off the main
// thread. A rejected gitDir run (timeout/abort) is infrastructure, not git.
import { getHostWorkerPool } from "../../workers/host-worker-pool.ts";
import { gitDirTask } from "../../workers/tasks/git-reads.ts";
import { probeGitEntryDiskOnly } from "./non-git.ts";

const GIT_DIR_TIMEOUT_MS = 5_000;

export async function resolveGitDirInWorker(
	worktreePath: string,
): Promise<string | null> {
	if ((await probeGitEntryDiskOnly(worktreePath)) === "absent") return null;
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
