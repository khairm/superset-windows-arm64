import { mkdirSync, rmSync } from "node:fs";
import { generateFriendlyBranchName } from "@superset/shared/workspace-launch";
import { TRPCError } from "@trpc/server";
import type { z } from "zod";
import {
	memberWorktreePath,
	type MultiRepoConfig,
} from "../../../runtime/git/multi-repo";
import type { HostServiceContext } from "../../../types";
import { tryRevParseGitRoot } from "../project/utils/resolve-repo";
import { getHostWorktreeBaseDir } from "../settings/worktree-location";
import {
	acquireWorkspaceCreateLock,
	addBranchWorktree,
	type AgentLaunchResult,
	type CloudWorkspace,
	type createInputSchema,
	dispatchSugarAgents,
	extractCreateTxid,
	findExistingWorkspaceByBranch,
	getLocalBranchHead,
	recordBaseBranchConfig,
	registerLocalWorkspace,
	resolveNewBranchStartPoint,
} from "../workspaces/workspaces";
import { startCommandTerminal } from "./shared/command-terminal";
import { enablePushAutoSetupRemote } from "./shared/git-config";
import type { requireLocalProject } from "./shared/local-project";
import { startSetupTerminalIfPresent } from "./shared/setup-terminal";
import type { GitClient } from "./shared/types";
import { normalizeWorktreePath } from "./shared/worktree-list";
import { safeResolveWorktreePath } from "./shared/worktree-paths";
import { generateWorkspaceNamesFromPrompt } from "./utils/ai-workspace-names";
import { listBranchNames } from "./utils/list-branch-names";
import { deduplicateBranchName } from "./utils/sanitize-branch";

/**
 * (MULTI-REPO WORKSPACE) Create one branch workspace across ALL member repos:
 * `git worktree add -b <branch>` (from each repo's default branch) into
 * `<container>/<repoBasename>` for every member, then register ONE cloud +
 * local workspace whose worktreePath is the container. The container is not a
 * git repo, so the workspace opens plain (terminals/agents/file tree; git UI
 * hidden) — the same surface as a non-git workspace.
 *
 * All-or-nothing by decision: any member collision or failure rolls back every
 * worktree (and the branches this call created) and removes the container.
 * Re-entry: a branch that exists in EVERY member is the resume case and is
 * adopted (checked out, never re-created); partial presence fails loud.
 *
 * Fork-owned module: only the dispatch call lives in upstream's workspaces.ts,
 * so nightly merges never see this flow inside a conflict region.
 */

type CreateInput = z.infer<typeof createInputSchema>;

interface CreateFlowResult {
	workspace: CloudWorkspace;
	terminals: Array<{ terminalId: string; label?: string }>;
	agents: AgentLaunchResult[];
	alreadyExists: boolean;
	txid: number | null;
}

export async function createMultiRepoWorkspaceFlow(args: {
	ctx: HostServiceContext;
	input: CreateInput;
	localProject: ReturnType<typeof requireLocalProject>;
	config: MultiRepoConfig;
}): Promise<CreateFlowResult> {
	const { ctx, input, localProject, config } = args;

	if (input.pr !== undefined || input.worktreePath) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message:
				"PR checkout and worktree adoption are not supported for multi-repo workspaces.",
		});
	}
	// Each member branches from its OWN default branch (locked decision) — a
	// single baseBranch is ambiguous across N repos, so reject it rather than
	// silently ignoring what the caller asked for.
	if (input.baseBranch) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message:
				"baseBranch is not supported for multi-repo workspaces — each member repo branches from its own default branch.",
		});
	}
	// Branch name is optional, like the single-repo path: AI-named from the
	// prompt when present, else a friendly random name — deduped against the
	// UNION of every member's existing branches so the all-or-nothing
	// collision pre-check can't trip on a generated name. The project
	// branch-prefix is intentionally not applied (it resolves through ONE
	// repo's git config — ambiguous across N member repos).
	let branch = input.branch?.trim() ?? "";
	let aiTitle: string | null = null;
	if (!branch) {
		const composerPrompt =
			input.agents?.[0]?.prompt?.trim() || input.namingPrompt?.trim() || "";
		const aiNames = composerPrompt
			? await generateWorkspaceNamesFromPrompt(composerPrompt).catch((err) => {
					console.warn("[workspaces.create:multi-repo] AI naming failed", err);
					return null;
				})
			: null;
		aiTitle = aiNames?.title ?? null;
		const candidate = aiNames?.branchName || generateFriendlyBranchName();
		const memberBranches = await Promise.all(
			config.memberRepoPaths.map((repoPath) =>
				listBranchNames(ctx, repoPath).catch(() => [] as string[]),
			),
		);
		branch = deduplicateBranchName(candidate, [
			...new Set(memberBranches.flat()),
		]);
	}

	// Serialize same-project/branch creates (UI "+", CLI, MCP): without this,
	// a second caller failing its collision pre-check would rollbackAll —
	// including rmSync of the SHARED container the first caller is mid-filling.
	const releaseCreateLock = await acquireWorkspaceCreateLock(
		`multi-repo:${input.projectId}:${branch}`,
	);
	try {
		return await runCreate({ ctx, input, localProject, config, branch, aiTitle });
	} finally {
		releaseCreateLock();
	}
}

/**
 * Shared create tail (the fast path and the fresh path previously each had a
 * drifting copy): setup terminal only for a freshly-created workspace, then
 * sugar agents + the optional command terminal in parallel.
 */
async function finishCreate(args: {
	ctx: HostServiceContext;
	input: CreateInput;
	workspaceRow: CloudWorkspace;
	alreadyExists: boolean;
}): Promise<CreateFlowResult> {
	const { ctx, input, workspaceRow, alreadyExists } = args;
	const terminalsResult: Array<{ terminalId: string; label?: string }> = [];

	if (!alreadyExists) {
		const { terminal, warning } = await startSetupTerminalIfPresent({
			ctx,
			workspaceId: workspaceRow.id,
		});
		if (warning) {
			console.warn(`[workspaces.create:multi-repo] setup warning: ${warning}`);
		}
		if (terminal) {
			terminalsResult.push({ terminalId: terminal.id, label: terminal.label });
		}
	}

	const [agentsResult, commandResult] = await Promise.all([
		dispatchSugarAgents(ctx, workspaceRow.id, input.agents ?? []),
		input.command
			? startCommandTerminal({
					ctx,
					workspaceId: workspaceRow.id,
					command: input.command,
				})
			: Promise.resolve(null),
	]);
	if (commandResult?.warning) {
		console.warn(
			`[workspaces.create:multi-repo] command warning: ${commandResult.warning}`,
		);
	}
	if (commandResult?.terminal) {
		terminalsResult.push({
			terminalId: commandResult.terminal.id,
			label: commandResult.terminal.label,
		});
	}

	return {
		workspace: workspaceRow,
		terminals: terminalsResult,
		agents: agentsResult,
		alreadyExists,
		txid: extractCreateTxid(workspaceRow),
	};
}

async function runCreate(args: {
	ctx: HostServiceContext;
	input: CreateInput;
	localProject: ReturnType<typeof requireLocalProject>;
	config: MultiRepoConfig;
	branch: string;
	aiTitle: string | null;
}): Promise<CreateFlowResult> {
	const { ctx, input, localProject, config, branch, aiTitle } = args;

	// Idempotency: a workspace already registered for this branch is returned
	// as-is (same contract as the single-repo path: no setup terminal, but
	// agents AND a requested command terminal still run).
	const existing = await findExistingWorkspaceByBranch(
		ctx,
		input.projectId,
		branch,
	);
	if (existing) {
		return finishCreate({ ctx, input, workspaceRow: existing, alreadyExists: true });
	}

	// Validate EVERY member before touching anything (all-or-nothing). The
	// canonical-root check matters: a hand-edited config pointing at a
	// subdirectory would silently run the worktree fan-out against the
	// ENCLOSING repo under the wrong name. Members are independent repos, so
	// validation + collision probing run in parallel (read-only).
	const memberStates = await Promise.all(
		config.memberRepoPaths.map(async (memberPath) => {
			const root = await tryRevParseGitRoot(memberPath);
			if (!root) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: `Multi-repo member is missing or no longer a git repository: ${memberPath}`,
				});
			}
			if (normalizeWorktreePath(root) !== normalizeWorktreePath(memberPath)) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: `Multi-repo member ${memberPath} is not a repository root (its repo root is ${root}). Fix the member list.`,
				});
			}
			const git = await ctx.git(memberPath);
			await git
				.raw(["worktree", "prune"])
				.catch((err) =>
					console.warn("[workspaces.create:multi-repo] prune failed:", err),
				);
			const branchExists = (await getLocalBranchHead(git, branch)) !== null;
			return { repoPath: memberPath, git, branchExists };
		}),
	);
	const members: Array<{ repoPath: string; git: GitClient }> = memberStates;
	const collisions = memberStates
		.filter((m) => m.branchExists)
		.map((m) => m.repoPath);

	// Re-entry: the branch existing in EVERY member is the resume case (a
	// prior workspace deleted with branches kept) — adopt the existing
	// branches instead of dead-ending the name forever. A PARTIAL collision
	// stays fail-loud (locked decision): adopting some and creating others
	// would silently mix unrelated history under one workspace.
	const adoptExisting = collisions.length === members.length;
	if (!adoptExisting && collisions.length > 0) {
		throw new TRPCError({
			code: "CONFLICT",
			message: `Branch "${branch}" already exists in: ${collisions.join(
				", ",
			)} (but not all member repos). Multi-repo creation is all-or-nothing — pick a different name, or delete the branch from those repos.`,
		});
	}

	const worktreeBaseDir =
		localProject.worktreeBaseDir ?? getHostWorktreeBaseDir(ctx);
	const containerPath = safeResolveWorktreePath(
		localProject.id,
		branch,
		worktreeBaseDir,
	);
	mkdirSync(containerPath, { recursive: true });

	const created: Array<{ git: GitClient; worktreePath: string }> = [];
	const rollbackAll = async () => {
		for (const item of [...created].reverse()) {
			await item.git
				.raw(["worktree", "remove", "--force", item.worktreePath])
				.catch((err) =>
					console.warn("[workspaces.create:multi-repo] rollback remove failed", {
						worktreePath: item.worktreePath,
						err,
					}),
				);
		}
		// Adoption rolls back ONLY worktrees — the branches pre-existed and are
		// the user's work; deleting them here would destroy what "resume" is
		// resuming. Fresh creates clean the branch ref in ALL members, not just
		// `created`: a member whose `worktree add -b` failed AFTER git minted
		// the branch ref never reaches `created`, and a stranded ref would
		// permanently CONFLICT this branch name. The pre-check proved the
		// branch absent everywhere, so any ref present now was created by this
		// call — safe to -D.
		if (!adoptExisting) {
			for (const member of members) {
				if ((await getLocalBranchHead(member.git, branch)) === null) continue;
				await member.git
					.raw(["branch", "-D", branch])
					.catch((err) =>
						console.warn(
							"[workspaces.create:multi-repo] rollback branch failed",
							{ repoPath: member.repoPath, branch, err },
						),
					);
			}
		}
		try {
			rmSync(containerPath, { recursive: true, force: true });
		} catch (err) {
			console.warn("[workspaces.create:multi-repo] container cleanup failed", {
				containerPath,
				err,
			});
		}
	};

	try {
		for (const member of members) {
			const workTreePath = memberWorktreePath(containerPath, member.repoPath);
			if (adoptExisting) {
				// Resume: check the pre-existing local branch out into a fresh
				// worktree. Fails loud (and rolls back) if the branch is already
				// checked out elsewhere — git refuses a second checkout.
				await member.git.raw(["worktree", "add", workTreePath, branch]);
				created.push({ git: member.git, worktreePath: workTreePath });
				await enablePushAutoSetupRemote(
					member.git,
					workTreePath,
					"[workspaces.create:multi-repo]",
				);
				continue;
			}
			// Locked decision: each repo branches from its OWN default branch.
			const startPoint = await resolveNewBranchStartPoint(member.git, undefined);
			await addBranchWorktree({
				git: member.git,
				plan: { branch, startPoint, usedExistingBranch: false },
				worktreePath: workTreePath,
			});
			created.push({ git: member.git, worktreePath: workTreePath });
			await enablePushAutoSetupRemote(
				member.git,
				workTreePath,
				"[workspaces.create:multi-repo]",
			);
			if (startPoint.kind !== "head") {
				await recordBaseBranchConfig({
					git: member.git,
					worktreePath: workTreePath,
					branch,
					baseBranch: startPoint.shortName,
				});
			}
		}
	} catch (err) {
		await rollbackAll();
		throw new TRPCError({
			code: "CONFLICT",
			message: `Multi-repo workspace creation failed and was rolled back: ${
				err instanceof Error ? err.message : String(err)
			}`,
		});
	}

	const workspaceRow = await registerLocalWorkspace({
		ctx,
		id: input.id,
		projectId: input.projectId,
		name: input.name ?? aiTitle ?? branch,
		branch,
		worktreePath: containerPath,
		taskId: input.taskId,
		rollbackWorktree: rollbackAll,
	});

	return finishCreate({ ctx, input, workspaceRow, alreadyExists: false });
}
