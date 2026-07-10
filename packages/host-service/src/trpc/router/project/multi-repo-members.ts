import { existsSync, rmSync } from "node:fs";
import { basename, resolve } from "node:path";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { projects, workspaces } from "../../../db/schema";
import {
	type MultiRepoConfig,
	memberWorktreePath,
	readMultiRepoConfig,
	writeMultiRepoConfig,
} from "../../../runtime/git/multi-repo";
import type { HostServiceContext } from "../../../types";
import { normalizeWorktreePath } from "../workspace-creation/shared/worktree-list";
import { tryRevParseGitRoot } from "./utils/resolve-repo";

/**
 * (MULTI-REPO MEMBERS) Add/remove member repos of an existing multi-repo
 * project from Project Settings. Fork-owned module — project.ts keeps only
 * thin dispatch shims, so nightly merges never see these bodies inside a
 * conflict region.
 *
 * Membership semantics (deliberate):
 * - ADD is lazy: the new member is included in branch workspaces created from
 *   now on. Existing containers are untouched — every cleanup/inspect path
 *   already tolerates a missing member worktree, and branch delete treats an
 *   absent ref as success.
 * - REMOVE is forceful: the member's worktree is force-removed from every
 *   existing branch container (uncommitted work inside THOSE WORKTREES is
 *   lost — the settings UI warns before calling). The member repo itself and
 *   its branches are never touched, so committed work stays reachable there.
 */

type GitClient = Awaited<ReturnType<HostServiceContext["git"]>>;

/** Case-insensitive canonical compare — Windows paths collide regardless of case. */
function samePath(a: string, b: string): boolean {
	return resolve(a).toLowerCase() === resolve(b).toLowerCase();
}

function requireMultiRepoProject(
	ctx: HostServiceContext,
	projectId: string,
): { anchorPath: string; config: MultiRepoConfig } {
	const project = ctx.db.query.projects
		.findFirst({ where: eq(projects.id, projectId) })
		.sync();
	if (!project) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Project is not set up on this host.",
		});
	}
	const config = readMultiRepoConfig(project.repoPath);
	if (!config) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Not a multi-repo project.",
		});
	}
	return { anchorPath: project.repoPath, config };
}

export async function addMultiRepoMember(
	ctx: HostServiceContext,
	input: { projectId: string; repoPath: string },
): Promise<{ memberRepoPaths: string[] }> {
	const { anchorPath, config } = requireMultiRepoProject(ctx, input.projectId);

	// Same gauntlet as createFromMultiRepo: canonical git root, no duplicate
	// membership, unique basename (basenames are the per-repo subfolders of
	// every branch container — see memberWorktreePath).
	const root = await tryRevParseGitRoot(input.repoPath);
	if (!root) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `Not a git repository: ${input.repoPath}. Every member of a multi-repo workspace must be a git repo.`,
		});
	}
	if (config.memberRepoPaths.some((member) => samePath(member, root))) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `Already a member of this project: ${root}`,
		});
	}
	const base = basename(root);
	const clash = config.memberRepoPaths.find(
		(member) => basename(member).toLowerCase() === base.toLowerCase(),
	);
	if (clash) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `Two repositories share the folder name "${base}" (${clash} and ${root}). Rename one — member folder names become the per-repo subfolders of each workspace.`,
		});
	}

	const memberRepoPaths = [...config.memberRepoPaths, root];
	writeMultiRepoConfig(anchorPath, { ...config, memberRepoPaths });
	return { memberRepoPaths };
}

export async function removeMultiRepoMember(
	ctx: HostServiceContext,
	input: { projectId: string; repoPath: string },
): Promise<{ memberRepoPaths: string[]; warnings: string[] }> {
	const { anchorPath, config } = requireMultiRepoProject(ctx, input.projectId);

	const member = config.memberRepoPaths.find((m) =>
		samePath(m, input.repoPath),
	);
	if (!member) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: `Not a member of this project: ${input.repoPath}`,
		});
	}
	const remaining = config.memberRepoPaths.filter((m) => m !== member);
	if (remaining.length < 2) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message:
				"A multi-repo workspace needs at least two git repositories. Delete the project instead.",
		});
	}

	const warnings: string[] = [];
	const containerPaths = ctx.db
		.select({ worktreePath: workspaces.worktreePath })
		.from(workspaces)
		.where(eq(workspaces.projectId, input.projectId))
		.all()
		.map((ws) => ws.worktreePath);

	// Force-sweep the member's worktree out of every existing branch container
	// BEFORE the config rewrite: after the rewrite no cleanup path ever visits
	// this member again (destroy/remove iterate the CURRENT list), which would
	// strand live worktree dirs inside containers + stale registrations in the
	// removed repo — and a later container delete would rmSync them with no
	// dirty check anyway. The sweep is idempotent, so a failed rewrite can
	// simply be retried.
	let memberGit: GitClient | null = null;
	try {
		memberGit = await ctx.git(member);
	} catch (err) {
		warnings.push(
			`Could not open ${member}: ${
				err instanceof Error ? err.message : String(err)
			}. Its worktree folders were deleted without updating git's registry — run \`git worktree prune\` there if the repo comes back.`,
		);
	}
	for (const containerPath of containerPaths) {
		const subPath = memberWorktreePath(containerPath, member);
		if (memberGit) {
			await memberGit
				.raw([
					"worktree",
					"remove",
					"--force",
					"--force",
					normalizeWorktreePath(subPath),
				])
				.catch(() => {});
		}
		if (existsSync(subPath)) {
			try {
				rmSync(subPath, { recursive: true, force: true });
			} catch (err) {
				warnings.push(
					`Failed to remove worktree folder at ${subPath}: ${
						err instanceof Error ? err.message : String(err)
					}. Remove it manually.`,
				);
			}
		}
	}
	if (memberGit) {
		// Drop any registrations the rmSync fallback orphaned.
		await memberGit.raw(["worktree", "prune"]).catch(() => {});
	}

	writeMultiRepoConfig(anchorPath, { ...config, memberRepoPaths: remaining });
	return { memberRepoPaths: remaining, warnings };
}
