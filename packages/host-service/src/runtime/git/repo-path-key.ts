import { resolve } from "node:path";

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
