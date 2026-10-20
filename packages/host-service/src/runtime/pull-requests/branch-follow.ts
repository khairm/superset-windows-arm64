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

export async function followBranch({
	db,
	workspace,
	readHead,
	readBranch,
	probeGitEntry,
}: BranchFollowReaders & {
	db: HostDb;
	workspace: Pick<
		typeof workspaces.$inferSelect,
		"id" | "worktreePath" | "branch"
	>;
}): Promise<void> {
	const { worktreePath } = workspace;
	const head = await readHead(worktreePath);
	if (head.kind === "detached") return;
	if (
		head.kind === "unknown" &&
		(await probeGitEntry(worktreePath)) === "absent"
	) {
		return;
	}
	const branch =
		head.kind === "branch" ? head.name : await readBranch(worktreePath);
	if (branch === null || branch === workspace.branch) return;
	db.update(workspaces)
		.set({ branch, updatedAt: Date.now() })
		.where(and(eq(workspaces.id, workspace.id), isNull(workspaces.archivedAt)))
		.run();
}
