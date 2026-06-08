import { resolve } from "node:path";
import { createUserSimpleGit } from "./simple-git";

/**
 * (NON-GIT WORKSPACE) Inert, explicit marker stored in the NOT NULL `branch`
 * column for a non-git workspace.
 *
 * The cloud `v2_workspaces.branch` column is NOT NULL (and the fork cannot
 * migrate the cloud schema), so a non-git workspace row still needs *some*
 * branch value. This is a DECLARED representation forced by an immutable
 * schema — NOT a "sensible default": it is explicit, named, and NEVER used as
 * a real git ref. Every git-executing path is guarded by `isGitRepo()` and
 * fails loud (or no-ops) before this value could reach a git command.
 */
export const NON_GIT_BRANCH = "__superset_non_git__";

interface CacheEntry {
	value: boolean;
	expiresAt: number;
}

/**
 * Short-TTL cache. `git rev-parse` is cheap but `isGitRepo` is consulted by
 * many procedures; the TTL (not a permanent cache) means a folder that gets
 * `git init`'d — or de-init'd — mid-session is re-detected within a few
 * seconds. The filesystem/git is the source of truth for git-ness; we never
 * persist a flag.
 */
const CACHE_TTL_MS = 5_000;
const cache = new Map<string, CacheEntry>();

/**
 * Normalize the cache key so the same directory is a single entry regardless
 * of how the path was spelled — trailing slash, relative vs resolved, or
 * drive-letter case on Windows (this fork's target). Without this, e.g.
 * `project.probePath` (raw renderer-supplied path) and `resolveNonGitFolder`
 * (already `resolve`d) would key the same folder twice and double the work.
 */
function normalizeKey(dirPath: string): string {
	const resolved = resolve(dirPath);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * True when `dirPath` is inside a git working tree.
 *
 * The authoritative, filesystem-derived signal for "is this a git repo" —
 * used by the non-git create path, the server-side git guards, and the
 * renderer-facing `git.isRepo` query. A non-repo, a missing directory, or git
 * not being on PATH all resolve to `false` (none is a usable git workspace).
 */
export async function isGitRepo(dirPath: string): Promise<boolean> {
	const key = normalizeKey(dirPath);
	const now = Date.now();
	const hit = cache.get(key);
	if (hit) {
		if (hit.expiresAt > now) return hit.value;
		// Evict expired on read so the Map can't grow unbounded in a
		// long-lived host-service process.
		cache.delete(key);
	}
	let value = false;
	try {
		value = await createUserSimpleGit(dirPath).checkIsRepo();
	} catch {
		value = false;
	}
	cache.set(key, { value, expiresAt: now + CACHE_TTL_MS });
	return value;
}
