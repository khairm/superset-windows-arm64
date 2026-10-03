// (HOST-LAUNCH-IGNORED-REFRESH)
import { getHostWorkerPool } from "../../workers/host-worker-pool.ts";
import { gitIgnoredDirsTask } from "../../workers/tasks/git-reads.ts";

const REFRESH_LISTING_BUDGET_MS = 10_000;

export async function listGitIgnoredDirsForRefresh(
	rootPath: string,
): Promise<string[]> {
	const signal = AbortSignal.timeout(REFRESH_LISTING_BUDGET_MS);
	try {
		return await getHostWorkerPool().run(
			gitIgnoredDirsTask,
			{ rootPath },
			{ strategy: "fifo", signal },
		);
	} catch (error) {
		if (signal.aborted) {
			throw new Error("ignored-dir listing exceeded 10 s (queue + run)");
		}
		throw error;
	}
}
