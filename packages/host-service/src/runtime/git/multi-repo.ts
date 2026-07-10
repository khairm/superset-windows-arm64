import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

/**
 * (MULTI-REPO WORKSPACE) A multi-repo project groups N independent git
 * repositories under one sidebar row. Creating a workspace on it fans out the
 * SAME branch name as a `git worktree add` in every member repo, gathered
 * under one container folder that opens as a plain (non-git) workspace.
 *
 * The member list CANNOT live in the cloud (the fork can't migrate the cloud
 * schema) or the host-service SQLite (avoids a local migration). It lives in a
 * declared config file inside the project's ANCHOR directory — a small
 * fork-owned folder under ~/.superset/multi-repo/<projectId> that serves as
 * the project's `repoPath`. The anchor is a plain directory (never a git
 * repo), so every existing non-git guard applies to the project untouched.
 */
export const MULTI_REPO_CONFIG_FILENAME = "superset-multi-repo.json";

export const MULTI_REPO_ANCHORS_DIR = join(
	homedir(),
	".superset",
	"multi-repo",
);

const multiRepoConfigSchema = z.object({
	version: z.literal(1),
	name: z.string().min(1),
	/** Canonical git roots of the member repositories (>=2, unique basenames). */
	memberRepoPaths: z.array(z.string().min(1)).min(2),
});

export type MultiRepoConfig = z.infer<typeof multiRepoConfigSchema>;

export function multiRepoConfigPath(anchorPath: string): string {
	return join(anchorPath, MULTI_REPO_CONFIG_FILENAME);
}

/**
 * THE container layout convention: member repo `<x>/foo` lives at
 * `<container>/foo` inside every branch workspace. Single source of truth —
 * create, inspect, destroy, and project-remove all derive member paths here
 * (basename uniqueness in the member list exists to serve this mapping).
 */
export function memberWorktreePath(
	containerPath: string,
	memberRepoPath: string,
): string {
	return join(containerPath, basename(memberRepoPath));
}

// Hoisted: readMultiRepoConfig runs on every workspaces.create/destroy/inspect
// and once per project in the boot sweep; the anchors root never changes.
const ANCHOR_ROOT_LOWER = resolve(MULTI_REPO_ANCHORS_DIR).toLowerCase();

/** True when `repoPath` sits inside the fork-owned multi-repo anchors dir. */
function isMultiRepoAnchorPath(repoPath: string): boolean {
	const resolved = resolve(repoPath).toLowerCase();
	return (
		resolved.startsWith(`${ANCHOR_ROOT_LOWER}\\`) ||
		resolved.startsWith(`${ANCHOR_ROOT_LOWER}/`)
	);
}

/**
 * Read + validate the multi-repo config for a project `repoPath`.
 *
 * Multi-repo identity is the fork-owned ANCHOR DIRECTORY, never the config
 * file's presence alone: an ordinary repo that happens to contain a file
 * named `superset-multi-repo.json` (committed by another user of this fork,
 * copied, etc.) must NOT flip into multi-repo semantics — that would skip
 * its real worktree-remove path and rmSync a live worktree on delete.
 *
 * - Not an anchor path -> `null`, unconditionally (ordinary project).
 * - Anchor path with a valid config -> the config.
 * - Anchor path with a missing/unreadable/invalid config -> throws loud:
 *   silently demoting the project to a plain folder would make its "+"
 *   mint workspaces with no worktrees.
 */
export function readMultiRepoConfig(repoPath: string): MultiRepoConfig | null {
	if (!isMultiRepoAnchorPath(repoPath)) return null;
	const configPath = multiRepoConfigPath(repoPath);
	if (!existsSync(configPath)) {
		throw new TRPCError({
			code: "INTERNAL_SERVER_ERROR",
			message: `Multi-repo member list missing at ${configPath}. Restore the file (version 1, name, memberRepoPaths) or delete the project.`,
		});
	}
	let raw: string;
	try {
		raw = readFileSync(configPath, "utf8");
	} catch (err) {
		throw new TRPCError({
			code: "INTERNAL_SERVER_ERROR",
			message: `Could not read multi-repo config at ${configPath}: ${
				err instanceof Error ? err.message : String(err)
			}`,
		});
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new TRPCError({
			code: "INTERNAL_SERVER_ERROR",
			message: `Multi-repo config at ${configPath} is not valid JSON. Fix or remove the file.`,
		});
	}
	const result = multiRepoConfigSchema.safeParse(parsed);
	if (!result.success) {
		throw new TRPCError({
			code: "INTERNAL_SERVER_ERROR",
			message: `Multi-repo config at ${configPath} is invalid: ${result.error.message}`,
		});
	}
	return result.data;
}

/**
 * (MULTI-REPO MEMBERS) Persist an updated member list. Guarded to anchor
 * paths only — writing a member-list config into an ordinary repo would flip
 * it into multi-repo semantics on the next read (see readMultiRepoConfig).
 * Schema-validated before the write so a code bug can never persist a config
 * the next read would throw on (which bricks the project until hand-repair).
 */
export function writeMultiRepoConfig(
	anchorPath: string,
	config: MultiRepoConfig,
): void {
	if (!isMultiRepoAnchorPath(anchorPath)) {
		throw new TRPCError({
			code: "INTERNAL_SERVER_ERROR",
			message: `Refusing to write a multi-repo config outside the anchors dir: ${anchorPath}`,
		});
	}
	const validated = multiRepoConfigSchema.parse(config);
	writeFileSync(
		multiRepoConfigPath(anchorPath),
		JSON.stringify(validated, null, 2),
	);
}
