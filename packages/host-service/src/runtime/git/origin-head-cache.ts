import type { SimpleGit } from "simple-git";
import { normalizeRepoPathKey } from "./non-git";

const ORIGIN_HEAD_TTL_MS = 600_000;

const cache = new Map<string, { branch: string | null; expiresAt: number }>();
const inFlight = new Map<string, Promise<string | null>>();

/** `undefined` = nothing cached; `null` = origin/HEAD is proven unset. */
export function peekOriginHead(repoPath: string): string | null | undefined {
	const key = normalizeRepoPathKey(repoPath);
	const hit = cache.get(key);
	if (!hit) return undefined;
	if (hit.expiresAt > Date.now()) return hit.branch;
	cache.delete(key);
	return undefined;
}

/**
 * (GIT-LAUNCH-BUDGET-E) The branch `origin/HEAD` points at, or `null` when it
 * is unset. A failed read rejects and is never cached, so the next caller
 * retries.
 */
export function readOriginHead(
	repoPath: string,
	git: SimpleGit,
): Promise<string | null> {
	const cached = peekOriginHead(repoPath);
	if (cached !== undefined) return Promise.resolve(cached);
	const key = normalizeRepoPathKey(repoPath);
	const pending = inFlight.get(key);
	if (pending) return pending;
	const reading = readSymbolicOriginHead(git).then(
		(branch) => {
			if (inFlight.get(key) === reading) {
				inFlight.delete(key);
				cache.set(key, { branch, expiresAt: Date.now() + ORIGIN_HEAD_TTL_MS });
			}
			return branch;
		},
		(error: unknown) => {
			if (inFlight.get(key) === reading) inFlight.delete(key);
			throw error;
		},
	);
	inFlight.set(key, reading);
	return reading;
}

// `--quiet` makes an unset origin/HEAD exit 1 with empty stderr, which
// simple-git resolves as "" instead of throwing; every other failure rejects.
async function readSymbolicOriginHead(git: SimpleGit): Promise<string | null> {
	const ref = (
		await git.raw([
			"symbolic-ref",
			"--quiet",
			"--short",
			"refs/remotes/origin/HEAD",
		])
	).trim();
	return ref === "" ? null : ref.replace(/^origin\//, "");
}

export function resetOriginHeadCacheForTests(): void {
	cache.clear();
	inFlight.clear();
}
