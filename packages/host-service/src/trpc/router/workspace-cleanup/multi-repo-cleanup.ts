import { existsSync, rmSync } from "node:fs";
import { basename } from "node:path";
import { TRPCError } from "@trpc/server";
import {
	memberWorktreePath,
	type MultiRepoConfig,
} from "../../../runtime/git/multi-repo";
import type { HostServiceContext } from "../../../types";
import { normalizeWorktreePath } from "../workspace-creation/shared/worktree-list";

/**
 * (MULTI-REPO WORKSPACE) Cleanup fan-out for multi-repo branch workspaces:
 * the workspace's worktreePath is a CONTAINER folder holding one worktree per
 * member repo, so inspect/destroy/project-remove walk the members. Fork-owned
 * module — upstream's workspace-cleanup.ts and project.ts keep only
 * `if (multiRepo)` dispatch shims, so nightly merges never see these bodies
 * inside a conflict region.
 */

type GitClient = Awaited<ReturnType<HostServiceContext["git"]>>;

/** Dirty/unpushed probe shared by inspect + preflight (one definition). */
async function probeGitState(
	git: GitClient,
): Promise<{ hasChanges: boolean; hasUnpushedCommits: boolean }> {
	const status = await git.status();
	let hasUnpushedCommits = false;
	try {
		const result = await git.raw([
			"rev-list",
			"--count",
			"HEAD",
			"--not",
			"--remotes",
		]);
		const count = Number.parseInt(result.trim(), 10);
		hasUnpushedCommits = Number.isFinite(count) && count > 0;
	} catch {
		// rev-list failure isn't a signal we can act on.
	}
	return { hasChanges: !status.isClean(), hasUnpushedCommits };
}

/**
 * Delete-dialog preview: aggregate dirty/unpushed across all member worktrees.
 * The container itself is non-git, so the single-path probe would report
 * "clean" for a workspace whose MEMBER worktrees are dirty — and the dialog's
 * silent force-retry would then drop those changes without ever warning.
 * Members are independent repos; probed in parallel (dialog-open latency).
 */
export async function inspectMultiRepoWorkspace(
	ctx: HostServiceContext,
	config: MultiRepoConfig,
	containerPath: string,
): Promise<{ hasChanges: boolean; hasUnpushedCommits: boolean }> {
	const states = await Promise.all(
		config.memberRepoPaths.map(async (memberRepoPath) => {
			const subPath = memberWorktreePath(containerPath, memberRepoPath);
			if (!existsSync(subPath)) return null;
			try {
				return await probeGitState(await ctx.git(subPath));
			} catch {
				// Unreadable member — destroy handles it; nothing to warn on.
				return null;
			}
		}),
	);
	return {
		hasChanges: states.some((s) => s?.hasChanges),
		hasUnpushedCommits: states.some((s) => s?.hasUnpushedCommits),
	};
}

/** Destroy preflight: throw CONFLICT on the first dirty member worktree. */
export async function preflightMultiRepoDirtyCheck(
	ctx: HostServiceContext,
	config: MultiRepoConfig,
	containerPath: string,
): Promise<void> {
	for (const memberRepoPath of config.memberRepoPaths) {
		const subPath = memberWorktreePath(containerPath, memberRepoPath);
		if (!existsSync(subPath)) continue;
		try {
			const { hasChanges } = await probeGitState(await ctx.git(subPath));
			if (hasChanges) {
				throw new TRPCError({
					code: "CONFLICT",
					message: `Worktree has uncommitted changes (${basename(memberRepoPath)})`,
				});
			}
		} catch (err) {
			if (err instanceof TRPCError) throw err;
			// Unreadable member — handled best-effort by the cleanup phase.
		}
	}
}

/**
 * Destroy step 2b for multi-repo: remove each member's worktree (verified
 * against git's registry, mirroring the single-repo path's semantics), then
 * the container. Mutates `warnings`; returns the opened member gits (for the
 * later branch-delete step) — a member that could not be opened is absent.
 *
 * Decoupling rules per member match single-repo: an unopenable repo whose
 * sub-worktree is already gone warns-and-skips; an unopenable repo whose
 * sub-worktree EXISTS fails loud (the container rmSync would otherwise tear
 * it down unverified); a locked worktree warns, is pruned from git's
 * registry, and forces the container to stay on disk.
 */
export async function destroyMultiRepoWorktrees(
	ctx: HostServiceContext,
	config: MultiRepoConfig,
	containerPath: string,
	warnings: string[],
): Promise<Array<{ repoPath: string; git: GitClient }>> {
	const memberGits: Array<{ repoPath: string; git: GitClient }> = [];
	let leaveContainerOnDisk = false;

	for (const memberRepoPath of config.memberRepoPaths) {
		const subPath = memberWorktreePath(containerPath, memberRepoPath);
		let memberGit: GitClient;
		try {
			memberGit = await ctx.git(memberRepoPath);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (existsSync(subPath)) {
				throw new TRPCError({
					code: "INTERNAL_SERVER_ERROR",
					message: `Cannot open member repo at ${memberRepoPath} while its worktree still exists: ${message}`,
				});
			}
			warnings.push(
				`Failed to open member repo at ${memberRepoPath}: ${message}`,
			);
			continue;
		}
		memberGits.push({ repoPath: memberRepoPath, git: memberGit });

		const canonicalPath = normalizeWorktreePath(subPath);
		await memberGit
			.raw(["worktree", "remove", "--force", "--force", canonicalPath])
			.catch(() => {});

		let stillRegistered = true;
		try {
			stillRegistered = await isMemberWorktreeRegistered(memberGit, subPath);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (!existsSync(subPath)) {
				stillRegistered = false;
			} else {
				warnings.push(
					`Failed to remove worktree at ${subPath}: ${message}. It may be locked by another process (editor/terminal); the workspace was deleted and the folder left on disk.`,
				);
				try {
					await memberGit.raw(["worktree", "prune"]);
				} catch {}
				stillRegistered = false;
				// We just promised this folder stays on disk — the container
				// rmSync below must not delete it out from under the lock.
				leaveContainerOnDisk = true;
			}
		}
		if (stillRegistered) {
			// This member's git still tracks a live worktree — removal genuinely
			// failed. Keep the cloud row so the workspace stays visible and
			// retryable.
			throw new TRPCError({
				code: "INTERNAL_SERVER_ERROR",
				message: `Failed to remove worktree at ${subPath}`,
			});
		}
	}

	// Container folder: leftovers (untracked files the user dropped at the
	// container root) go with the workspace, same as a single worktree dir —
	// unless a locked member worktree was left inside it.
	if (leaveContainerOnDisk) {
		warnings.push(
			`Container folder left on disk at ${containerPath} (a member worktree could not be removed).`,
		);
	} else {
		try {
			rmSync(containerPath, { recursive: true, force: true });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			warnings.push(
				`Failed to remove container folder at ${containerPath}: ${message}`,
			);
		}
	}
	return memberGits;
}

// Same registry check as workspace-cleanup's isRegisteredWorktree, local to
// this module so the upstream file needs no export churn: reads git's own
// worktree list (realpath-canonicalized) rather than parsing remove's output.
async function isMemberWorktreeRegistered(
	git: GitClient,
	worktreePath: string,
): Promise<boolean> {
	const target = normalizeWorktreePath(worktreePath);
	const raw = await git.raw(["worktree", "list", "--porcelain"]);
	return raw
		.split(/\r?\n/)
		.filter((line) => line.startsWith("worktree "))
		.map((line) => line.slice("worktree ".length).trim())
		.some((path) => normalizeWorktreePath(path) === target);
}

/**
 * Destroy step 4 for multi-repo: delete the shared branch in EVERY member.
 * Honest result: true ONLY when every configured member was reachable AND no
 * delete failed — an empty/partial member list must not report success.
 */
export async function deleteMultiRepoBranches(
	memberGits: Array<{ repoPath: string; git: GitClient }>,
	totalMemberCount: number,
	branch: string,
	warnings: string[],
): Promise<boolean> {
	let memberDeleteFailed = false;
	for (const member of memberGits) {
		try {
			// `branch --list` exits 0 whether or not the branch exists (empty
			// output when absent) — an absent ref already satisfies the goal.
			const out = await member.git.raw(["branch", "--list", branch]);
			if (out.trim().length > 0) {
				await member.git.raw(["branch", "-D", branch]);
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			memberDeleteFailed = true;
			warnings.push(
				`Failed to delete branch ${branch} in ${member.repoPath}: ${message}`,
			);
		}
	}
	return !memberDeleteFailed && memberGits.length === totalMemberCount;
}

/**
 * project.remove sweep for multi-repo: best-effort worktree removal per
 * member per workspace (mirroring the single-repo sweep's warn-and-continue
 * policy), then each container, then the fork-owned anchor dir itself.
 * Member git clients are resolved ONCE per member, not per workspace.
 */
export async function removeMultiRepoProjectArtifacts(
	ctx: HostServiceContext,
	config: MultiRepoConfig,
	anchorPath: string,
	workspaceWorktreePaths: string[],
): Promise<void> {
	const memberGits = new Map<string, GitClient>();
	for (const memberRepoPath of config.memberRepoPaths) {
		try {
			memberGits.set(memberRepoPath, await ctx.git(memberRepoPath));
		} catch (err) {
			console.warn("[project.remove] failed to open member repo", {
				memberRepoPath,
				err,
			});
		}
	}

	for (const containerPath of workspaceWorktreePaths) {
		for (const [memberRepoPath, git] of memberGits) {
			const subPath = memberWorktreePath(containerPath, memberRepoPath);
			try {
				await git.raw(["worktree", "remove", "--force", subPath]);
			} catch (err) {
				console.warn("[project.remove] failed to remove member worktree", {
					worktreePath: subPath,
					err,
				});
			}
		}
		try {
			rmSync(containerPath, { recursive: true, force: true });
		} catch (err) {
			console.warn("[project.remove] failed to remove container", {
				worktreePath: containerPath,
				err,
			});
		}
	}

	// The anchor dir is fork-owned config (NOT the user's code) — remove it
	// with the project so orphan anchors don't accumulate.
	try {
		rmSync(anchorPath, { recursive: true, force: true });
	} catch (err) {
		console.warn("[project.remove] failed to remove anchor dir", {
			repoPath: anchorPath,
			err,
		});
	}
}
