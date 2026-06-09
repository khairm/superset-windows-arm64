import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { projects } from "../../../db/schema";
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

function slugifyProjectName(name: string): string {
	const slug = name
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	if (!slug) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Project name must contain at least one alphanumeric character",
		});
	}
	return slug;
}

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

interface CreateResult {
	projectId: string;
	repoPath: string;
	/** null for multi-repo projects — they have NO main workspace by design;
	 *  the renderer's finalize step already branches on null (project-only). */
	mainWorkspaceId: string | null;
}

// Cloud v2Project.create catches v2_projects_org_slug_unique and re-throws
// as TRPCError CONFLICT with this exact message — kept stable so the slug
// retry below can detect it. If you change the cloud message, change this
// too.
const SLUG_CONFLICT_MESSAGE = "Project slug already exists";

function isSlugConflict(err: unknown): boolean {
	const message = err instanceof Error ? err.message : String(err);
	return message === SLUG_CONFLICT_MESSAGE;
}

async function createCloudProjectWithSlugRetry(
	ctx: HostServiceContext,
	args: { id: string; name: string; repoCloneUrl?: string },
) {
	const baseSlug = slugifyProjectName(args.name);
	let lastError: unknown;
	const maxAttempts = 100;
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		const slug = attempt === 0 ? baseSlug : `${baseSlug}-${attempt + 1}`;
		try {
			return await ctx.api.v2Project.create.mutate({
				organizationId: ctx.organizationId,
				id: args.id,
				name: args.name,
				slug,
				repoCloneUrl: args.repoCloneUrl,
			});
		} catch (err) {
			if (!isSlugConflict(err)) throw err;
			lastError = err;
			console.warn("[project.create] slug conflict, retrying", {
				organizationId: ctx.organizationId,
				name: args.name,
				slug,
				attempt,
			});
		}
	}
	throw new TRPCError({
		code: "CONFLICT",
		message: `Could not allocate a unique slug for "${args.name}" after ${maxAttempts} attempts. Try a different project name.`,
		cause: lastError,
	});
}

/**
 * Create-project saga. The saga as a whole is the commit unit:
 *
 *   1. Local file ops (handled by the caller — clone / mkdir / etc.)
 *   2. Local DB project row (with client-supplied UUID)
 *   3. Cloud v2Project.create   (FK-required before workspace)
 *   4. Cloud v2Workspace.create + local workspace (ensureMainWorkspaceStrict)
 *
 * Any failure unwinds the prior steps in reverse, including a cloud
 * v2Project.delete to roll back step 3 if step 4 throws.
 */
async function persistFromResolved(
	ctx: HostServiceContext,
	args: {
		name: string;
		resolved: ResolvedRepo;
		cleanupRepoPathOnFailure: boolean;
		repoCloneUrlForCloud?: string;
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
	let cloudProjectCreated = false;

	try {
		persistLocalProject(ctx, projectId, args.resolved);
		localProjectInserted = true;

		await createCloudProjectWithSlugRetry(ctx, {
			id: projectId,
			name: args.name,
			repoCloneUrl: args.repoCloneUrlForCloud,
		});
		cloudProjectCreated = true;

		const mainWorkspace = args.skipMainWorkspace
			? null
			: await ensureMainWorkspaceStrict(
					ctx,
					projectId,
					args.resolved.repoPath,
					{ nonGit: args.nonGit },
				);

		return {
			projectId,
			repoPath: args.resolved.repoPath,
			mainWorkspaceId: mainWorkspace?.id ?? null,
		};
	} catch (err) {
		if (cloudProjectCreated) {
			try {
				await ctx.api.v2Project.delete.mutate({
					organizationId: ctx.organizationId,
					id: projectId,
				});
			} catch (cleanupErr) {
				console.warn(
					"[project.create] cloud rollback failed; orphan cloud row may remain",
					{ projectId, cleanupErr },
				);
			}
		}
		if (localProjectInserted) {
			try {
				ctx.db.delete(projects).where(eq(projects.id, projectId)).run();
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
	const resolved = await cloneRepoInto(args.url, args.parentDir);
	return persistFromResolved(ctx, {
		name: args.name,
		resolved,
		cleanupRepoPathOnFailure: true,
		// Only forward to cloud if the cloned repo actually has a parseable
		// GitHub remote — non-GitHub URLs and local paths become local-only
		// projects with no cloud repoCloneUrl.
		repoCloneUrlForCloud: resolved.parsed?.url,
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
		repoCloneUrlForCloud: resolved.parsed?.url,
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
	);
	return persistFromResolved(ctx, {
		name: args.name,
		resolved,
		cleanupRepoPathOnFailure: true,
	});
}
