// (HOST-LAUNCH-IGNORED-REFRESH)
import {
	getHostWorkerPool,
	type HostWorkerPool,
} from "../../workers/host-worker-pool.ts";
import { gitIgnoredDirsTask } from "../../workers/tasks/git-reads.ts";

const REFRESH_LISTING_BUDGET_MS = 10_000;

export async function listGitIgnoredDirsForRefresh(
	rootPath: string,
	deps: { pool: () => Pick<HostWorkerPool, "run"> } = {
		pool: getHostWorkerPool,
	},
): Promise<string[]> {
	const signal = AbortSignal.timeout(REFRESH_LISTING_BUDGET_MS);
	try {
		return await deps
			.pool()
			.run(gitIgnoredDirsTask, { rootPath }, { strategy: "fifo", signal });
	} catch (error) {
		if (signal.aborted) {
			throw new Error("ignored-dir listing exceeded 10 s (queue + run)");
		}
		throw error;
	}
}
