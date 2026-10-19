// (FORK-PRS-OFF-BRANCH-FOLLOW) With pull requests off, this is all the PR sync
// still does: keep `workspaces.branch` on the branch checked out on disk.
import { and, eq, isNull } from "drizzle-orm";
import type { HostDb } from "../../db";
import { workspaces } from "../../db/schema";
import type { GitEntryProbeResult } from "../git/git-entry-probe";
import type { DiskHead } from "../git/head-file";

export interface BranchFollowReaders {
	readHead: (worktreePath: string) => Promise<DiskHead>;
	readBranch: (worktreePath: string) => Promise<string | null>;
	probeGitEntry: (worktreePath: string) => Promise<GitEntryProbeResult>;
}

async function readCheckedOutBranch(
	worktreePath: string,
	{ readHead, readBranch, probeGitEntry }: BranchFollowReaders,
): Promise<string | null> {
	const head = await readHead(worktreePath);
	if (head.kind === "branch") return head.name;
	if (head.kind === "detached") return null;
	if ((await probeGitEntry(worktreePath)) === "absent") return null;
	return readBranch(worktreePath);
}

export async function followBranch({
	db,
	workspace,
	...readers
}: BranchFollowReaders & {
	db: HostDb;
	workspace: Pick<
		typeof workspaces.$inferSelect,
		"id" | "worktreePath" | "branch"
	>;
}): Promise<null> {
	const branch = await readCheckedOutBranch(workspace.worktreePath, readers);
	if (branch === null || branch === workspace.branch) return null;
	db.update(workspaces)
		.set({ branch, updatedAt: Date.now() })
		.where(and(eq(workspaces.id, workspace.id), isNull(workspaces.archivedAt)))
		.run();
	return null;
}
