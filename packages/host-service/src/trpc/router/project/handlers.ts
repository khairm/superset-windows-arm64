import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { projects } from "../../../db/schema";
import { emitProjectChanged } from "../../../projects/local-project-store";
import {
	MULTI_REPO_ANCHORS_DIR,
	type MultiRepoConfig,
	multiRepoConfigPath,
} from "../../../runtime/git/multi-repo";
import type { HostServiceContext } from "../../../types";
import { ensureMainWorkspaceStrict } from "./utils/ensure-main-workspace";
import { persistLocalProject } from "./utils/persist-project";
import {
	cloneRepoInto,
	cloneTemplateInto,
	initEmptyRepo,
	initLocalRepoInPlace,
	type ResolvedRepo,
	resolveLocalRepo,
	tryRevParseGitRoot,
	resolveNonGitFolder,
} from "./utils/resolve-repo";

function dirNameForEmpty(name: string): string {
	const slug = name
		.trim()
		.replace(/[^a-zA-Z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	if (!slug) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Project name must produce a non-empty directory name",
		});
	}
	return slug;
}

export interface CreateResult {
	projectId: string;
	repoPath: string;
	/** null for multi-repo projects — they have NO main workspace by design;
	 *  the renderer's finalize step already branches on null (project-only). */
	mainWorkspaceId: string | null;
}

/**
 * Create-project saga — fully local, the cloud is never involved:
 *
 *   1. Local file ops (handled by the caller — clone / mkdir / etc.)
 *   2. Local DB project row (host-minted UUID)
 *   3. Local main workspace (ensureMainWorkspaceStrict)
 *
 * A failure in 2–3 unwinds locally.
 */
async function persistFromResolved(
	ctx: HostServiceContext,
	args: {
		name: string;
		resolved: ResolvedRepo;
		cleanupRepoPathOnFailure: boolean;
		/** (NON-GIT WORKSPACE) Create the main workspace without reading a git
		 *  branch (uses the inert NON_GIT_BRANCH marker). */
		nonGit?: boolean;
		/** (MULTI-REPO WORKSPACE) Caller pre-allocated the project id (the
		 *  anchor directory is named after it, so it must exist first). */
		projectId?: string;
		/** (MULTI-REPO WORKSPACE) Multi-repo projects have NO main workspace —
		 *  only branch workspaces minted by the "+" fan-out. */
		skipMainWorkspace?: boolean;
	},
): Promise<CreateResult> {
	const projectId = args.projectId ?? randomUUID();
	let localProjectInserted = false;

	try {
		persistLocalProject(ctx, projectId, args.resolved, { name: args.name });
		localProjectInserted = true;

		const mainWorkspace = args.skipMainWorkspace
			? null
			: await ensureMainWorkspaceStrict(ctx, projectId, args.resolved.repoPath, {
					nonGit: args.nonGit,
				});

		return {
			projectId,
			repoPath: args.resolved.repoPath,
			mainWorkspaceId: mainWorkspace?.id ?? null,
		};
	} catch (err) {
		if (localProjectInserted) {
			try {
				ctx.db.delete(projects).where(eq(projects.id, projectId)).run();
				emitProjectChanged(ctx.eventBus, "deleted", projectId);
			} catch (cleanupErr) {
				console.warn("[project.create] local rollback failed", {
					projectId,
					cleanupErr,
				});
			}
		}
		if (args.cleanupRepoPathOnFailure) {
			try {
				rmSync(args.resolved.repoPath, { recursive: true, force: true });
			} catch (cleanupErr) {
				console.warn("[project.create] repo dir cleanup failed", {
					repoPath: args.resolved.repoPath,
					cleanupErr,
				});
			}
		}
		throw err;
	}
}

export async function createFromClone(
	ctx: HostServiceContext,
	args: { name: string; parentDir: string; url: string },
): Promise<CreateResult> {
	const resolved = await cloneRepoInto(
		args.url,
		args.parentDir,
		ctx.credentials,
	);
	return persistFromResolved(ctx, {
		name: args.name,
		resolved,
		cleanupRepoPathOnFailure: true,
	});
}

/**
 * Resolve an existing repo, or — when `initIfNeeded` and the folder isn't a git
 * repo yet — `git init` it in place first. The init branch only runs after the
 * UI has confirmed intent with the user.
 */
async function resolveOrInitLocalRepo(
	repoPath: string,
	initIfNeeded: boolean,
): Promise<ResolvedRepo> {
	if (!initIfNeeded) return resolveLocalRepo(repoPath);
	const root = await tryRevParseGitRoot(repoPath);
	return root ? resolveLocalRepo(root) : initLocalRepoInPlace(repoPath);
}

export async function createFromImportLocal(
	ctx: HostServiceContext,
	args: { name: string; repoPath: string; initIfNeeded?: boolean },
): Promise<CreateResult> {
	const resolved = await resolveOrInitLocalRepo(
		args.repoPath,
		args.initIfNeeded ?? false,
	);
	return persistFromResolved(ctx, {
		name: args.name,
		resolved,
		// User pointed us at an existing folder; never rm it.
		cleanupRepoPathOnFailure: false,
	});
}

/**
 * (NON-GIT WORKSPACE) Import a plain folder that is NOT a git repository.
 * Skips the `git rev-parse` that `createFromImportLocal` performs, persists a
 * project + a single non-git main workspace (inert branch marker), and never
 * removes the user's folder on failure. The created project has no remote and
 * all git UI/operations stay disabled (see the server-side git guards).
 */
export async function createFromNonGitFolder(
	ctx: HostServiceContext,
	args: { name: string; repoPath: string },
): Promise<CreateResult> {
	const resolved = resolveNonGitFolder(args.repoPath);
	return persistFromResolved(ctx, {
		name: args.name,
		resolved,
		// User pointed us at an existing folder; never rm it.
		cleanupRepoPathOnFailure: false,
		nonGit: true,
	});
}

/**
 * (MULTI-REPO WORKSPACE) Create a project grouping N existing git repos.
 *
 * Every member path must resolve to a git work tree (fail loud otherwise);
 * duplicate roots and duplicate basenames are rejected up front — basenames
 * become the per-repo subfolder names inside every branch workspace's
 * container, so they must be unambiguous. The project's repoPath is a small
 * fork-owned ANCHOR directory holding the member-list config; it is not a git
 * repo, so all existing non-git guards apply. NO main workspace is created —
 * the project only ever has branch workspaces minted by the "+" fan-out.
 */
export async function createFromMultiRepo(
	ctx: HostServiceContext,
	args: { name: string; memberRepoPaths: string[] },
): Promise<CreateResult> {
	const roots: string[] = [];
	for (const memberPath of args.memberRepoPaths) {
		const root = await tryRevParseGitRoot(memberPath);
		if (!root) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: `Not a git repository: ${memberPath}. Every member of a multi-repo workspace must be a git repo.`,
			});
		}
		if (roots.includes(root)) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: `Repository selected twice: ${root}`,
			});
		}
		roots.push(root);
	}
	if (roots.length < 2) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "A multi-repo workspace needs at least two git repositories.",
		});
	}
	const seenBasenames = new Map<string, string>();
	for (const root of roots) {
		const base = basename(root);
		// Case-insensitive key: Windows paths are case-insensitive, so "Repo"
		// and "repo" would collide as container subfolders.
		const clash = seenBasenames.get(base.toLowerCase());
		if (clash) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: `Two repositories share the folder name "${base}" (${clash} and ${root}). Rename one — member folder names become the per-repo subfolders of each workspace.`,
			});
		}
		seenBasenames.set(base.toLowerCase(), root);
	}

	const projectId = randomUUID();
	const anchorPath = join(MULTI_REPO_ANCHORS_DIR, projectId);
	try {
		mkdirSync(anchorPath, { recursive: true });
		const config: MultiRepoConfig = {
			version: 1,
			name: args.name,
			memberRepoPaths: roots,
		};
		writeFileSync(
			multiRepoConfigPath(anchorPath),
			JSON.stringify(config, null, 2),
		);
	} catch (err) {
		try {
			rmSync(anchorPath, { recursive: true, force: true });
		} catch {
			// best-effort
		}
		throw new TRPCError({
			code: "INTERNAL_SERVER_ERROR",
			message: `Could not create multi-repo anchor at ${anchorPath}: ${
				err instanceof Error ? err.message : String(err)
			}`,
		});
	}

	const resolved = resolveNonGitFolder(anchorPath);
	return persistFromResolved(ctx, {
		name: args.name,
		resolved,
		// The anchor dir is ours — remove it if the saga unwinds.
		cleanupRepoPathOnFailure: true,
		projectId,
		skipMainWorkspace: true,
	});
}

/**
 * Empty mode: mkdir + git init + initial commit, then run the saga.
 * The project lives local-only — no GitHub remote until first push.
 */
export async function createFromEmpty(
	ctx: HostServiceContext,
	args: { name: string; parentDir: string },
): Promise<CreateResult> {
	const resolved = await initEmptyRepo(
		args.parentDir,
		dirNameForEmpty(args.name),
	);
	return persistFromResolved(ctx, {
		name: args.name,
		resolved,
		cleanupRepoPathOnFailure: true,
	});
}

/**
 * Template mode: clone the template repo, strip history, re-init, then
 * run the saga. Like empty, the project lives local-only — no GitHub
 * remote until first push.
 */
export async function createFromTemplate(
	ctx: HostServiceContext,
	args: { name: string; parentDir: string; url: string },
): Promise<CreateResult> {
	const resolved = await cloneTemplateInto(
		args.url,
		args.parentDir,
		dirNameForEmpty(args.name),
		ctx.credentials,
	);
	return persistFromResolved(ctx, {
		name: args.name,
		resolved,
		cleanupRepoPathOnFailure: true,
	});
}
