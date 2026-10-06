// (HOST-LAUNCH-IGNORED-REFRESH)
import { getHostWorkerPool } from "../../workers/host-worker-pool.ts";
import { gitIgnoredDirsTask } from "../../workers/tasks/git-reads.ts";

const REFRESH_LISTING_BUDGET_MS = 10_000;

export async function listGitIgnoredDirsForRefresh(
	rootPath: string,
	budgetMs = REFRESH_LISTING_BUDGET_MS,
): Promise<string[]> {
	const signal = AbortSignal.timeout(budgetMs);
	try {
		return await getHostWorkerPool().run(
			gitIgnoredDirsTask,
			{ rootPath },
			{ strategy: "fifo", signal },
		);
	} catch (error) {
		if (signal.aborted) {
			throw new Error(
				`ignored-dir listing exceeded ${budgetMs / 1000} s (queue + run)`,
			);
		}
		throw error;
	}
}
