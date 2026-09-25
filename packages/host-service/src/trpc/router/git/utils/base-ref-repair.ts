// (DIFFSTATS-COLD-CACHE)
import type { SimpleGit } from "simple-git";
import {
	type BaseRefFetchTarget,
	resolveBaseRefFetchKey,
	scheduleBaseRefFetch,
} from "./base-ref-freshness";
import { gitStatusStore } from "./git-status-store";

interface BaseRefRepair {
	git: SimpleGit;
	worktreePath: string;
	workspaceId: string;
	baseBranch: string | null;
	target: BaseRefFetchTarget;
	walkStartedAt: number;
	fetchBaseRef: () => Promise<unknown>;
}

async function repairBaseRef(args: BaseRefRepair): Promise<void> {
	const fetchKey = await resolveBaseRefFetchKey(
		args.git,
		args.worktreePath,
		args.target,
	);
	gitStatusStore.noteColdBaseRefFetch({
		workspaceId: args.workspaceId,
		baseBranch: args.baseBranch,
		fetchKey,
	});

	const landed = await scheduleBaseRefFetch(
		args.git,
		args.worktreePath,
		args.target,
		args.fetchBaseRef,
		args.walkStartedAt,
	);
	if (!landed?.refMoved) return;
	gitStatusStore.invalidateColdBaseRef(fetchKey, landed.landedAt);
}

const pendingRepairs = new Set<Promise<void>>();

/** Never rejects; settles when the repair does. (DIFFSTATS-COLD-CACHE) */
export function scheduleBaseRefRepair(args: BaseRefRepair): Promise<void> {
	const repair = repairBaseRef(args).catch((error) => {
		console.warn("[host-service:git] Base-ref repair failed", {
			worktreePath: args.worktreePath,
			remote: args.target.remote,
			branch: args.target.branch,
			error,
		});
	});
	pendingRepairs.add(repair);
	void repair.then(() => pendingRepairs.delete(repair));
	return repair;
}

/** Test entry point: settles once every repair scheduled so far has.
 * (DIFFSTATS-COLD-CACHE) */
export function awaitBaseRefRepairs(): Promise<void> {
	return Promise.all([...pendingRepairs]).then(() => undefined);
}
