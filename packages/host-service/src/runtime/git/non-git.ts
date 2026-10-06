import {
	findGitEntryUpTree,
	type GitEntryProbeResult,
} from "./git-entry-probe";
import { normalizeRepoPathKey } from "./repo-path-key";
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
 * TTL cache split by answer. A "yes" is held for 5 min because `isGitRepo`
 * guards many hot procedures and a repo rarely stops being one; a "no" (or a
 * failed probe) is held for 5 s so a folder that gets `git init`'d mid-session
 * is picked up quickly. A dying `.git` watcher drops a "yes" early through
 * `invalidateIsGitRepo`. The filesystem/git is the source of truth for
 * git-ness; we never persist a flag.
 */
const IS_REPO_TTL_MS = 5 * 60_000; // (GIT-LAUNCH-BUDGET-D-TTL)
const NOT_REPO_TTL_MS = 5_000; // (GIT-LAUNCH-BUDGET-D-TTL)
const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<boolean>>();

const checkIsRepo = (dirPath: string): Promise<boolean> =>
	createUserSimpleGit(dirPath).checkIsRepo();

export async function probeIsGitRepo(
	dir: string,
	deps: {
		entryProbe: (dir: string) => Promise<GitEntryProbeResult>;
		gitCheck: (dir: string) => Promise<boolean>;
	} = { entryProbe: findGitEntryUpTree, gitCheck: checkIsRepo },
): Promise<boolean> {
	let entry: GitEntryProbeResult;
	try {
		entry = await deps.entryProbe(dir);
	} catch (error) {
		console.error("[non-git] disk probe threw", { dir, error });
		return deps.gitCheck(dir);
	}
	if (entry === "absent") return false; // (HOST-LAUNCH-DISK-NO-ISREPO)
	return deps.gitCheck(dir);
}

let probe: (dirPath: string) => Promise<boolean> = probeIsGitRepo;

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

/**
 * (GIT-WATCH-ATTACH-TASK) Disk-only answer that never launches git. A definite
 * "absent" drops a cached "yes"; a cached "no" and an in-flight check stay.
 */
export async function probeGitEntryDiskOnly(
	dirPath: string,
): Promise<GitEntryProbeResult> {
	let entry: GitEntryProbeResult;
	try {
		entry = await findGitEntryUpTree(dirPath);
	} catch (error) {
		console.error("[non-git] disk probe threw", { dir: dirPath, error });
		return "unknown";
	}
	if (entry === "absent") {
		const key = normalizeRepoPathKey(dirPath);
		if (cache.get(key)?.value === true) cache.delete(key);
	}
	return entry;
}

export function setIsGitRepoProbeForTests(
	fn: (dirPath: string) => Promise<boolean>,
): void {
	probe = fn;
}

export function resetIsGitRepoCacheForTests(): void {
	cache.clear();
	inFlight.clear();
	probe = probeIsGitRepo;
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
