import type { SimpleGit } from "simple-git";
import { createUserSimpleGit } from "./simple-git";
import type { GitCredentialProvider, GitFactory } from "./types";
import { getRemoteUrl } from "./utils";

// `git remote get-url origin` was spawned on every single `ctx.git()` call —
// a hot path hit by every git-status poll and PR-runtime sync. The remote URL
// is effectively static for a session, so resolved values are cached briefly
// per repo and concurrent lookups share one spawn. A `null` result (no
// `origin`) is never cached, so a remote added later is still picked up.
const REMOTE_URL_TTL_MS = 60_000;
const remoteUrlCache = new Map<string, { url: string; expiresAt: number }>();
const remoteUrlInFlight = new Map<string, Promise<string | null>>();

function getRemoteUrlCached(
	repoPath: string,
	git: SimpleGit,
): Promise<string | null> {
	const cached = remoteUrlCache.get(repoPath);
	if (cached && cached.expiresAt > Date.now()) {
		return Promise.resolve(cached.url);
	}
	const inFlight = remoteUrlInFlight.get(repoPath);
	if (inFlight) return inFlight;

	const promise = getRemoteUrl(git)
		.then((url) => {
			if (url) {
				remoteUrlCache.set(repoPath, {
					url,
					expiresAt: Date.now() + REMOTE_URL_TTL_MS,
				});
			}
			return url;
		})
		.finally(() => {
			remoteUrlInFlight.delete(repoPath);
		});
	remoteUrlInFlight.set(repoPath, promise);
	return promise;
}

/**
 * Resolve the env a git invocation for `repoPath` needs (credentials for the
 * repo's remote + lock hygiene). Split out from the factory so worker tasks
 * can receive the env as plain data and build their own SimpleGit off-thread.
 */
export function createGitEnvResolver(provider: GitCredentialProvider) {
	return async (repoPath: string): Promise<Record<string, string>> => {
		const initialCredentials = await provider.getCredentials(null);
		const git = createUserSimpleGit(repoPath).env(initialCredentials.env);
		const remoteUrl = await getRemoteUrlCached(repoPath, git);
		const credentials = await provider.getCredentials(remoteUrl);

		return {
			...initialCredentials.env,
			...credentials.env,
			GIT_OPTIONAL_LOCKS: "0",
		};
	};
}

export function createGitFactory(provider: GitCredentialProvider): GitFactory {
	const resolveEnv = createGitEnvResolver(provider);
	return async (repoPath: string) =>
		createUserSimpleGit(repoPath).env(await resolveEnv(repoPath));
}
