import { stat } from "node:fs/promises";

/**
 * (DIFFSTATS-COLD-CACHE) What a cold diff-stats walk is recorded against: the
 * worktree DIRECTORY's identity (device, inode, birth time), not HEAD and not
 * the base ref. Neither ref is read here — a cold row survives until its 120 s
 * TTL expires or something invalidates it (a git watcher event on a watched
 * row, a git mutation through the router, a base-ref fetch that moved the ref,
 * a delete or an archive).
 */
export interface CheckoutIdentity {
	worktreePath: string;
	directoryId: string;
}

export async function resolveCheckoutIdentity(
	worktreePath: string,
): Promise<CheckoutIdentity> {
	const directory = await stat(worktreePath, { bigint: true });
	return {
		worktreePath,
		directoryId: [directory.dev, directory.ino, directory.birthtimeNs].join(
			"\0",
		),
	};
}
