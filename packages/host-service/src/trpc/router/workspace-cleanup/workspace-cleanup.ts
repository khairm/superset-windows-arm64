import { existsSync } from "node:fs";
import { sanitizePromptForPty } from "@superset/shared/agent-prompt-launch";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { invalidateLabelCache } from "../../../ports/static-ports";
import { readMultiRepoConfig } from "../../../runtime/git/multi-repo";
import { runTeardown, type TeardownResult } from "../../../runtime/teardown";
import { disposeSessionsByWorkspaceId } from "../../../terminal/terminal";
import type { HostServiceContext } from "../../../types";
import type { GitTaskEnv } from "../../../workers/tasks/git";
import { deleteLocalWorkspace } from "../../../workspaces/local-workspace-store";
import type {
	DeleteInProgressCause,
	TeardownFailureCause,
} from "../../error-types";
import { protectedProcedure, router } from "../../index";
import { cleanupGitOps, isIndeterminateGitTaskFailure } from "./git-ops";
import { isMainWorkspace } from "./is-main-workspace";
import {
	deleteMultiRepoBranches,
	destroyMultiRepoWorktrees,
	inspectMultiRepoWorkspace,
	preflightMultiRepoDirtyCheck,
} from "./multi-repo-cleanup";

/**
 * Process-local guard against concurrent destroys of the same workspace.
 * A second caller observes the live entry and gets a typed CONFLICT (with
 * `DELETE_IN_PROGRESS` cause) so the renderer can render a toast instead
 * of mistaking it for a dirty-worktree race and silently force-retrying.
 *
 * Doesn't survive a host-service crash mid-delete — but neither does the
 * destroy itself, and the saga is idempotent enough that a second attempt
 * after restart is safe.
 */
const destroysInFlight = new Set<string>();

/** @internal — exposed for tests to introspect / clear the guard. */
export const __testDestroysInFlight = destroysInFlight;

export interface DestroyWorkspaceInput {
	workspaceId: string;
	deleteBranch: boolean;
	force: boolean;
	/**
	 * Teardown (step 1) behavior — deliberately separate from `force`, which
	 * only carries the destructive git semantics (skip preflight, double-force
	 * worktree removal):
	 *   - "blocking":    a failed script throws PRECONDITION_FAILED so an
	 *                    interactive caller can prompt a force-retry.
	 *   - "best-effort": always runs; a failure degrades to a warning. For
	 *                    non-interactive callers (CLI/SDK/MCP) with nobody to
	 *                    prompt — skipping instead would leak the resources the
	 *                    script provisions (#6174).
	 *   - "skip":        don't run — the interactive force-retry contract.
	 */
	teardownMode: "blocking" | "best-effort" | "skip";
}

/**
 * Discriminated so the renderer can't accidentally treat
 * `{ canDelete: false, reason: null }` as a no-op — it's an unrepresentable
 * combination at the type level.
 */
type InspectResult =
	| {
			canDelete: true;
			reason: null;
			hasChanges: boolean;
			hasUnpushedCommits: boolean;
	  }
	| {
			canDelete: false;
			reason: string;
			hasChanges: false;
			hasUnpushedCommits: false;
	  };

export const workspaceCleanupRouter = router({
	/**
	 * Status preview for the v2 delete dialog. Co-located with `destroy` so
	 * the two can never disagree about what's blocked vs warned.
	 *
	 * Contract:
	 *   - canDelete: false      → render `reason` as a blocking banner.
	 *   - hasChanges/Unpushed   → render as warnings; user can still confirm.
	 *   - git failures (missing worktree, broken repo) → return as canDelete
	 *     with no warnings; the destroy saga handles those states best-effort.
	 *
	 * The git reads run in the host worker pool (gitWorktreeStateTask) so a
	 * slow status on a large worktree can't block the event loop.
	 */
	inspect: protectedProcedure
		.input(z.object({ workspaceId: z.string() }))
		.query(async ({ ctx, input, signal }): Promise<InspectResult> => {
			const main = await isMainWorkspace(ctx, input.workspaceId);
			if (main.isMain) {
				return {
					canDelete: false,
					reason: main.reason,
					hasChanges: false,
					hasUnpushedCommits: false,
				};
			}

			const { local, project } = main;
			if (!local) {
				return {
					canDelete: true,
					reason: null,
					hasChanges: false,
					hasUnpushedCommits: false,
				};
			}

			// (MULTI-REPO WORKSPACE) The container is non-git, so the single-path
			// probe below would report "clean" for a workspace whose MEMBER
			// worktrees are dirty — and the delete dialog's silent force-retry
			// would then drop those changes without ever warning. Aggregate the
			// members' state instead (fork module).
			const multiRepo = project ? readMultiRepoConfig(project.repoPath) : null;
			if (multiRepo) {
				const aggregated = await inspectMultiRepoWorkspace(
					ctx,
					multiRepo,
					local.worktreePath,
				);
				return { canDelete: true, reason: null, ...aggregated };
			}

			try {
				const gitEnv = await cleanupGitOps.resolveGitEnv(
					ctx,
					local.worktreePath,
				);
				const state = await cleanupGitOps.readWorktreeState(
					{ worktreePath: local.worktreePath, gitEnv },
					signal,
				);
				return {
					canDelete: true,
					reason: null,
					hasChanges: state.hasChanges,
					hasUnpushedCommits: state.hasUnpushedCommits,
				};
			} catch {
				return {
					canDelete: true,
					reason: null,
					hasChanges: false,
					hasUnpushedCommits: false,
				};
			}
		}),

	/**
	 * Destroy a workspace in five phases:
	 *
	 *   0. Preflight     — dirty-worktree check (skip if force)
	 *   1. Teardown      — run .superset/teardown.sh (per teardownMode)
	 *   2. Local cleanup — PTYs, worktree
	 *   3. Cloud delete  ← authoritative UI state
	 *   4. Branch delete — optional local branch cleanup
	 *   5. Host sqlite   — local index cleanup
	 *
	 * Worktree removal is intentionally before cloud delete. If it fails
	 * while the path still exists, the cloud row remains so the workspace is
	 * still visible and delete can be retried instead of orphaning disk state.
	 *
	 * Force semantics (git only; teardown is governed by teardownMode):
	 *   - skips preflight (step 0)
	 *   - step 2b always uses `--force --force`
	 *   - step 4 always uses `-D` regardless: the `deleteBranch`
	 *     checkbox is the user's consent, so refusing unmerged branches
	 *     would just silently drop the opt-in.
	 *
	 * Typed errors for the renderer:
	 *   - CONFLICT             → dirty worktree; prompt force-retry.
	 *                            CONFLICT with `data.deleteInProgress` is a
	 *                            different beast — another destroy is in
	 *                            flight for the same workspace; surface as
	 *                            a toast and do NOT force-retry.
	 *   - PRECONDITION_FAILED with `data.teardownFailure` → teardown
	 *                            script failed; prompt force-retry
	 *   - BAD_REQUEST          → main workspace; cannot be deleted
	 *   - PRECONDITION_FAILED  → no cloud API configured
	 *   - pass-through         → cloud auth / network failure
	 */
	destroy: protectedProcedure
		.input(
			z.object({
				workspaceId: z.string(),
				deleteBranch: z.boolean().default(false),
				force: z.boolean().default(false),
			}),
		)
		.mutation(async ({ ctx, input }) =>
			destroyWorkspace(ctx, {
				...input,
				// Interactive contract: force-retry is the user's explicit consent
				// to abandon a failed teardown.
				teardownMode: input.force ? "skip" : "blocking",
			}),
		),
});

export async function destroyWorkspace(
	ctx: HostServiceContext,
	input: DestroyWorkspaceInput,
) {
	if (destroysInFlight.has(input.workspaceId)) {
		throw new TRPCError({
			code: "CONFLICT",
			message: "Deletion already in progress for this workspace",
			cause: { kind: "DELETE_IN_PROGRESS" } satisfies DeleteInProgressCause,
		});
	}
	destroysInFlight.add(input.workspaceId);
	try {
		return await runDestroy(ctx, input);
	} finally {
		destroysInFlight.delete(input.workspaceId);
	}
}

async function runDestroy(
	ctx: HostServiceContext,
	input: DestroyWorkspaceInput,
) {
	const warnings: string[] = [];

	// `isMainWorkspace` already loads workspace + project rows from sqlite;
	// thread them through to avoid duplicate sync queries downstream.
	const main = await isMainWorkspace(ctx, input.workspaceId);
	if (main.isMain) {
		throw new TRPCError({ code: "BAD_REQUEST", message: main.reason });
	}
	const { local, project } = main;

	// (MULTI-REPO WORKSPACE) A multi-repo branch workspace's worktreePath is a
	// CONTAINER folder holding one worktree per member repo; the project's
	// anchor repoPath is not a git repo. Every git-touching phase below fans
	// out across the members via the fork module — "what delete does now,
	// applied to all".
	const multiRepo = project ? readMultiRepoConfig(project.repoPath) : null;

	// ─── Step 0: Preflight ─────────────────────────────────────────
	// Block only on dirty worktree (the common "I forgot to commit"
	// case). Missing/broken local state is handled by the cleanup phase.
	if (!input.force && local && project) {
		if (multiRepo) {
			await preflightMultiRepoDirtyCheck(ctx, multiRepo, local.worktreePath);
		} else {
			try {
				const gitEnv = await cleanupGitOps.resolveGitEnv(
					ctx,
					local.worktreePath,
				);
				const state = await cleanupGitOps.readWorktreeState({
					worktreePath: local.worktreePath,
					gitEnv,
				});
				if (state.hasChanges) {
					throw new TRPCError({
						code: "CONFLICT",
						message: "Worktree has uncommitted changes",
					});
				}
			} catch (err) {
				if (err instanceof TRPCError) throw err;
				if (isIndeterminateGitTaskFailure(err)) {
					// Timeout/pool failure: dirty-state is UNKNOWN. Fail closed on
					// this destructive path rather than silently skipping the
					// dirty-worktree block — a retry usually succeeds (the first
					// attempt warmed the FS cache), and force skips preflight
					// entirely as the explicit escape hatch.
					const message = err instanceof Error ? err.message : String(err);
					throw new TRPCError({
						code: "INTERNAL_SERVER_ERROR",
						message: `Couldn't verify worktree state at ${local.worktreePath}: ${message}`,
					});
				}
				// Can't read status (missing worktree dir, etc.) — not a
				// conflict. Continue; step 3b will skip idempotently.
			}
		}
	}

	// ─── Step 1: Teardown ──────────────────────────────────────────
	// Script is the user's last chance to stop services / flush state
	// before the workspace goes away.
	if (input.teardownMode !== "skip" && local && project) {
		const teardown: TeardownResult = await runTeardown({
			db: ctx.db,
			workspaceId: input.workspaceId,
			worktreePath: local.worktreePath,
			repoPath: project.repoPath,
			projectId: local.projectId,
			eventBus: ctx.eventBus,
		});
		if (teardown.status === "failed") {
			if (input.teardownMode === "blocking") {
				const cause: TeardownFailureCause = {
					kind: "TEARDOWN_FAILED",
					exitCode: teardown.exitCode,
					signal: teardown.signal,
					timedOut: teardown.timedOut,
					outputTail: teardown.outputTail,
				};
				// Recoverable via force-retry — an expected user-script failure, not a
				// service bug; must not be reported as a 500.
				throw new TRPCError({
					code: "PRECONDITION_FAILED",
					message: "Teardown script failed",
					cause,
				});
			}
			warnings.push(formatTeardownWarning(teardown));
		}
	}

	// ─── Step 2: Local cleanup ─────────────────────────────────────
	// 2a. PTYs
	try {
		const killed = await disposeSessionsByWorkspaceId(
			input.workspaceId,
			ctx.db,
			ctx.eventBus,
		);
		if (killed.failed > 0) {
			warnings.push(`${killed.failed} terminal(s) may still be running`);
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		warnings.push(`Failed to dispose terminal sessions: ${message}`);
	}

	// 2b. Worktree. Double-force unlocks the rare locked-worktree case and
	//     clears stale metadata when the directory was manually removed.
	//     Runs in the worker pool: the removal is a recursive delete of the
	//     whole worktree directory, which would otherwise stall the loop.
	let worktreeRemoved = false;
	let branchDeleted = false;
	let repoGitEnv: GitTaskEnv | null = null;
	// (MULTI-REPO WORKSPACE) the fork fan-out still works through SimpleGit
	// clients per member repo, so it keeps its own handles.
	let multiRepoMemberGits: Array<{
		repoPath: string;
		git: Awaited<ReturnType<typeof ctx.git>>;
	}> = [];
	if (local && !project) {
		worktreeRemoved = !existsSync(local.worktreePath);
		if (!worktreeRemoved) {
			warnings.push(
				`Skipped worktree removal at ${local.worktreePath}: project metadata is missing`,
			);
		}
	}
	if (local && project && multiRepo) {
		// Fork module: member worktree fan-out + container removal (verified
		// against each member git's registry; locked members leave the
		// container on disk).
		multiRepoMemberGits = await destroyMultiRepoWorktrees(
			ctx,
			multiRepo,
			local.worktreePath,
			warnings,
		);
		worktreeRemoved = true;
	}
	if (local && project && !multiRepo) {
		worktreeRemoved = !existsSync(local.worktreePath);
		try {
			repoGitEnv = await cleanupGitOps.resolveGitEnv(ctx, project.repoPath);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			// (AH) Decouple: never abort the delete because the repo couldn't
			// be opened. Warn and continue so the cloud + local-row delete
			// below run on the FIRST attempt; the worktree dir is left on disk.
			warnings.push(
				`Failed to open project repo at ${project.repoPath}: ${message}`,
			);
		}

		if (repoGitEnv) {
			// A task failure here means the post-remove state is unknown —
			// treat that like "still registered" and block rather than risk
			// orphaning disk past the cloud commit point.
			let stillRegistered = true;
			try {
				({ stillRegistered } = await cleanupGitOps.removeWorktree({
					repoPath: project.repoPath,
					worktreePath: local.worktreePath,
					gitEnv: repoGitEnv,
				}));
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				if (!existsSync(local.worktreePath)) {
					worktreeRemoved = true;
				} else {
					// (AH) Decouple: a locked worktree (held by an editor/terminal)
					// must NOT abort the delete. Warn, prune git's stale worktree
					// metadata, and continue — the cloud + local-row delete below
					// run first-try; the folder is left on disk for the user to
					// remove once the lock is released.
					warnings.push(
						`Failed to remove worktree at ${local.worktreePath}: ${message}. It may be locked by another process (editor/terminal); the workspace was deleted and the folder left on disk.`,
					);
					try {
						const repoGit = await ctx.git(project.repoPath);
						await repoGit.raw(["worktree", "prune"]);
					} catch {}
				}
			}
			if (stillRegistered) {
				// git still tracks a live worktree here — removal genuinely
				// failed. Keep the cloud row so the workspace stays visible and
				// retryable instead of orphaning disk past the cloud commit point.
				throw new TRPCError({
					code: "INTERNAL_SERVER_ERROR",
					message: `Failed to remove worktree at ${local.worktreePath}`,
				});
			}
			worktreeRemoved = true;
		}
	}

	// ─── Step 3: Local delete (authoritative) ─────────────────────
	// The local row is the commit point and the only record. The cloud
	// delete is best-effort legacy cleanup for rows mirrored before
	// workspaces went fully local.
	deleteLocalWorkspace(ctx, input.workspaceId);
	let cloudDeleted = false;
	try {
		await ctx.api.v2Workspace.delete.mutate({ id: input.workspaceId });
		cloudDeleted = true;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		warnings.push(
			`Legacy cloud cleanup failed (stale mirror row may remain): ${message}`,
		);
	}

	// ─── Step 4: Optional branch delete ────────────────────────────
	// After the local commit point so a failure here can't block the delete.
	// (MULTI-REPO WORKSPACE) the shared branch name is deleted in EVERY member
	// (fork module; honest result — partial member coverage never reports true).
	if (multiRepo && local?.branch && input.deleteBranch) {
		branchDeleted = await deleteMultiRepoBranches(
			multiRepoMemberGits,
			multiRepo.memberRepoPaths.length,
			local.branch,
			warnings,
		);
	}
	// An absent ref (renamed, pruned, or never materialized) already
	// satisfies the goal, so the task skips the delete without a scary
	// warning; a thrown git failure lands in the warning below rather than
	// being mistaken for "already gone".
	if (repoGitEnv && project && local?.branch && input.deleteBranch) {
		try {
			await cleanupGitOps.deleteLocalBranch({
				repoPath: project.repoPath,
				branch: local.branch,
				gitEnv: repoGitEnv,
			});
			branchDeleted = true;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			warnings.push(`Failed to delete branch ${local.branch}: ${message}`);
		}
	}

	// ─── Step 5: Caches ────────────────────────────────────────────
	if (local) {
		try {
			invalidateLabelCache(input.workspaceId);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			warnings.push(`Failed to invalidate label cache: ${message}`);
		}
	}

	return {
		success: true,
		cloudDeleted,
		worktreeRemoved,
		branchDeleted,
		warnings,
	};
}

function formatTeardownWarning(
	teardown: Extract<TeardownResult, { status: "failed" }>,
): string {
	const detail = teardown.timedOut
		? "timed out"
		: teardown.exitCode !== null
			? `exit code ${teardown.exitCode}`
			: teardown.signal !== null
				? `signal ${teardown.signal}`
				: "unknown failure";
	// Tail is raw PTY bytes; strip control sequences for the plain-text
	// warnings channel (CLI/SDK/MCP).
	const tail = sanitizePromptForPty(teardown.outputTail).trim();
	return tail
		? `Teardown script failed (${detail}): ${tail}`
		: `Teardown script failed (${detail})`;
}
