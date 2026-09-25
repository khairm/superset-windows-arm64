import { resolve } from "node:path";
import type { SimpleGit } from "simple-git";

// The Changes panel diffs `<remote>/<base>...HEAD` but never fetches the base,
// so after a rebase onto a newer upstream the stale merge-base counts every
// upstream commit as a workspace change. This refreshes the base ref in the
// background; GitWatcher picks up the ref change and re-triggers the query.
const BASE_REF_FETCH_TTL_MS = 5 * 60_000;

export interface BaseRefFetchTarget {
	remote: string;
	branch: string;
}

// (DIFFSTATS-COLD-CACHE)
export interface LandedBaseRefFetch {
	landedAt: number;
	refMoved: boolean;
}

// (DIFFSTATS-COLD-CACHE) Null when no fetch landed: the TTL suppressed it, or
// it failed.
export type BaseRefFetchOutcome = LandedBaseRefFetch | null;

// Keyed by common git dir so N worktrees of one repo share one TTL window.
// Bounded by (repo, base-ref) pairs, not workspace lifecycles.
const lastFetchStartedAt = new Map<string, number>();
const landedFetches = new Map<string, LandedBaseRefFetch>();
const inFlightFetches = new Map<string, Promise<LandedBaseRefFetch>>();

// TTL-cached per worktree path: resolving spawns a git subprocess on the
// event loop BEFORE the fetch-TTL check, i.e. every status poll pays it even
// when the fetch is suppressed. A worktree path re-pointed at a different
// repo within the TTL only mis-keys the dedupe entry (one extra or one
// suppressed fetch, bounded by the TTL) — the fetch itself always runs in
// `worktreePath`, so it can never hit the wrong repo.
const COMMON_DIR_TTL_MS = 5 * 60_000;
const commonDirCache = new Map<string, { dir: string; resolvedAt: number }>();

async function resolveCommonDir(
	git: SimpleGit,
	worktreePath: string,
): Promise<string> {
	const cached = commonDirCache.get(worktreePath);
	if (cached && Date.now() - cached.resolvedAt < COMMON_DIR_TTL_MS) {
		return cached.dir;
	}
	// `--git-common-dir` may print a path relative to the worktree root.
	const raw = (await git.raw(["rev-parse", "--git-common-dir"])).trim();
	const dir = resolve(worktreePath, raw);
	commonDirCache.set(worktreePath, { dir, resolvedAt: Date.now() });
	return dir;
}

export async function resolveBaseRefFetchKey(
	git: SimpleGit,
	worktreePath: string,
	target: BaseRefFetchTarget,
): Promise<string> {
	const commonDir = await resolveCommonDir(git, worktreePath);
	return `${commonDir}#${target.remote}/${target.branch}`;
}

// (DIFFSTATS-COLD-CACHE) Empty when the remote-tracking ref does not exist
// yet: `for-each-ref` reports an absent ref as no output, where `rev-parse`
// exits non-zero and would need a catch that also hides real failures.
async function readRemoteRefSha(
	git: SimpleGit,
	target: BaseRefFetchTarget,
): Promise<string> {
	const raw = await git.raw([
		"for-each-ref",
		"--format=%(objectname)",
		`refs/remotes/${target.remote}/${target.branch}`,
	]);
	return raw.trim();
}

async function refMovedOrUnreadable(
	git: SimpleGit,
	target: BaseRefFetchTarget,
	shaBeforeFetch: string,
): Promise<boolean> {
	try {
		return (await readRemoteRefSha(git, target)) !== shaBeforeFetch;
	} catch (error) {
		console.warn("[host-service:git] Base-ref sha unreadable after fetch", {
			remote: target.remote,
			branch: target.branch,
			error,
		});
		return true;
	}
}

// (DIFFSTATS-COLD-CACHE) Both sha reads live here, past the in-flight and TTL
// checks, so a suppressed fetch spawns no git on the coordinator event loop.
async function runBaseRefFetch(
	git: SimpleGit,
	target: BaseRefFetchTarget,
	fetchBaseRef: () => Promise<unknown>,
): Promise<LandedBaseRefFetch> {
	const shaBeforeFetch = await readRemoteRefSha(git, target);
	await fetchBaseRef();
	const landedAt = Date.now();
	return {
		landedAt,
		refMoved: await refMovedOrUnreadable(git, target, shaBeforeFetch),
	};
}

/**
 * Fetch the base branch's remote-tracking ref if the TTL has lapsed, and
 * report the landing — when it completed and whether it moved the ref.
 * Failures consume the TTL too, so an unreachable remote isn't retried every
 * poll. Fire-and-forget (the status path never awaits); the returned promise
 * never rejects and exists only so tests can await it. (DIFFSTATS-COLD-CACHE)
 */
export function scheduleBaseRefFetch(
	git: SimpleGit,
	worktreePath: string,
	target: BaseRefFetchTarget,
	fetchBaseRef: () => Promise<unknown> = () =>
		git.fetch([target.remote, target.branch, "--quiet", "--no-tags"]),
	walkStartedAt?: number,
): Promise<BaseRefFetchOutcome> {
	return (async (): Promise<BaseRefFetchOutcome> => {
		const key = await resolveBaseRefFetchKey(git, worktreePath, target);

		const inFlight = inFlightFetches.get(key);
		if (inFlight) return await inFlight;

		const landed = landedFetches.get(key);
		if (
			walkStartedAt !== undefined &&
			landed !== undefined &&
			landed.landedAt >= walkStartedAt
		) {
			return landed;
		}

		const last = lastFetchStartedAt.get(key);
		if (last !== undefined && Date.now() - last < BASE_REF_FETCH_TTL_MS) {
			return null;
		}

		lastFetchStartedAt.set(key, Date.now());
		const fetchPromise = runBaseRefFetch(git, target, fetchBaseRef)
			.then((result) => {
				landedFetches.set(key, result);
				return result;
			})
			.finally(() => {
				inFlightFetches.delete(key);
			});
		inFlightFetches.set(key, fetchPromise);
		return await fetchPromise;
	})().catch((error): BaseRefFetchOutcome => {
		console.warn("[host-service:git] Background base-ref fetch failed", {
			worktreePath,
			remote: target.remote,
			branch: target.branch,
			error,
		});
		return null;
	});
}
