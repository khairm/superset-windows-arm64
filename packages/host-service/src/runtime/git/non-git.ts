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
 * TTL cache split by answer. A "yes" is held for 60 s because `isGitRepo`
 * guards many hot procedures and a repo rarely stops being one; a "no" (or a
 * failed probe) is held for 5 s so a folder that gets `git init`'d mid-session
 * is picked up quickly. A dying `.git` watcher drops a "yes" early through
 * `invalidateIsGitRepo`. The filesystem/git is the source of truth for
 * git-ness; we never persist a flag.
 */
const IS_REPO_TTL_MS = 60_000; // (GIT-LAUNCH-BUDGET-D-TTL)
const NOT_REPO_TTL_MS = 5_000; // (GIT-LAUNCH-BUDGET-D-TTL)
const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<boolean>>();

const checkIsRepo = (dirPath: string): Promise<boolean> =>
	createUserSimpleGit(dirPath).checkIsRepo();
let probe = checkIsRepo;

/**
 * Normalize the cache key so the same directory is a single entry regardless
 * of how the path was spelled — trailing slash, relative vs resolved, or
 * drive-letter case on Windows (this fork's target). Without this, e.g.
 * `project.probePath` (raw renderer-supplied path) and `resolveNonGitFolder`
 * (already `resolve`d) would key the same folder twice and double the work.
 */
export function normalizeRepoPathKey(dirPath: string): string {
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
 *
 * Callers that WRITE a durable decision off this answer must use
 * `isGitRepoStrict` instead — see its comment.
 */
export async function isGitRepo(dirPath: string): Promise<boolean> {
	const key = normalizeRepoPathKey(dirPath);
	const hit = cache.get(key);
	if (hit) {
		if (hit.expiresAt > Date.now()) return hit.value;
		// Evict expired on read so the Map can't grow unbounded in a
		// long-lived host-service process.
		cache.delete(key);
	}
	const pending = inFlight.get(key);
	if (pending) return pending;
	const probing = probeOrFalse(dirPath).then((value) => {
		if (inFlight.get(key) !== probing) return value;
		inFlight.delete(key);
		cache.set(key, {
			value,
			expiresAt: Date.now() + (value ? IS_REPO_TTL_MS : NOT_REPO_TTL_MS),
		});
		return value;
	});
	inFlight.set(key, probing); // (GIT-LAUNCH-BUDGET-D-DEDUPE)
	return probing;
}

async function probeOrFalse(dirPath: string): Promise<boolean> {
	try {
		return await probe(dirPath);
	} catch {
		return false;
	}
}

// (GIT-LAUNCH-BUDGET-D)
export function invalidateIsGitRepo(dirPath: string): void {
	const key = normalizeRepoPathKey(dirPath);
	cache.delete(key);
	inFlight.delete(key);
}

export function setIsGitRepoProbeForTests(
	fn: (dirPath: string) => Promise<boolean>,
): void {
	probe = fn;
}

export function resetIsGitRepoCacheForTests(): void {
	cache.clear();
	inFlight.clear();
	probe = checkIsRepo;
}

/**
 * (MASTER-ALWAYS-ACTIVE) Tri-state git-ness: `true` = repo, `false` = PROVABLY
 * not a repo, THROWS = the probe itself failed and the answer is unknown.
 *
 * `isGitRepo` collapses "provably not a repo" and "git blew up" into the same
 * `false`, which is right for a read-only guard (neither is a usable git
 * workspace) and WRONG for anything that writes the answer down. The boot
 * sweep did exactly that: one broken git binary made every project on the
 * machine read as non-git, and each existing git master had its stored branch
 * rewritten to `NON_GIT_BRANCH`. A caller that mutates state needs to be able
 * to tell "no" from "I could not find out" and skip the latter.
 *
 * Deliberately does NOT touch the shared TTL cache — reading it could hand
 * back a `false` that a concurrent `isGitRepo` wrote after a FAILED probe,
 * smuggling the exact ambiguity this function exists to remove back in.
 */
export async function isGitRepoStrict(dirPath: string): Promise<boolean> {
	return createUserSimpleGit(dirPath).checkIsRepo();
}
