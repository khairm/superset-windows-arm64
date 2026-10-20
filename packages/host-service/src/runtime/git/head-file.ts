// (FORK-PRS-OFF-BRANCH-FOLLOW) The checked-out branch, read from disk first.
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { GIT_PARSE_ENV } from "./git";

const execFileAsync = promisify(execFile);

export type DiskHead =
	| { kind: "branch"; name: string }
	| { kind: "detached" }
	| { kind: "unknown" };

const BRANCH_REF_PREFIX = "ref: refs/heads/";
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const BAD_REF_PATTERN =
	/[~^:?*[\\]|\.\.|@\{|\/\/|^\/|\/$|\.$|(?:^|\/)\.|\.lock(?:\/|$)/;

// git check-ref-format rules, so a name git would refuse is never followed.
function isValidBranchName(name: string): boolean {
	if (name === "") return false;
	for (const char of name) {
		const code = char.charCodeAt(0);
		if (code <= 0x20 || code === 0x7f) return false;
	}
	return !BAD_REF_PATTERN.test(name);
}

export function resolveGitDir(
	worktreePath: string,
	dotGitText: string,
): string | null {
	const pointer = dotGitText.match(/^gitdir: (.+)$/m)?.[1]?.trim();
	if (!pointer) return null;
	return isAbsolute(pointer) ? pointer : resolve(worktreePath, pointer);
}

export function parseHeadFile(text: string): DiskHead {
	const head = text.trim();
	if (head.startsWith(BRANCH_REF_PREFIX)) {
		const name = head.slice(BRANCH_REF_PREFIX.length);
		return isValidBranchName(name)
			? { kind: "branch", name }
			: { kind: "unknown" };
	}
	return OBJECT_ID.test(head) ? { kind: "detached" } : { kind: "unknown" };
}

/** Never launches git. "unknown" means only git can answer. */
export async function readHeadFromDisk(
	worktreePath: string,
): Promise<DiskHead> {
	try {
		const dotGit = join(worktreePath, ".git");
		const gitDir = (await stat(dotGit)).isDirectory()
			? dotGit
			: resolveGitDir(worktreePath, await readFile(dotGit, "utf8"));
		if (!gitDir) return { kind: "unknown" };
		return parseHeadFile(await readFile(join(gitDir, "HEAD"), "utf8"));
	} catch {
		return { kind: "unknown" };
	}
}

/**
 * One local `git symbolic-ref`: no credential env, no origin lookup.
 * A detached HEAD is `null`; any other failure rejects.
 */
export async function readBranchFromGit(
	worktreePath: string,
): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync(
			"git",
			["symbolic-ref", "--quiet", "--short", "HEAD"],
			{
				cwd: worktreePath,
				env: { ...process.env, ...GIT_PARSE_ENV },
				windowsHide: true,
			},
		);
		return stdout.trim() || null;
	} catch (error) {
		if ((error as { code?: unknown }).code === 1) return null;
		throw error;
	}
}
