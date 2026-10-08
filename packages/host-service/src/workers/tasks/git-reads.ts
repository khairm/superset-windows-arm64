// (HOST-LAUNCH-IGNORED-TASK)
import { execFile } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { GIT_PARSE_ENV } from "../../runtime/git/git.ts";
import { listGitIgnoredDirsOrThrow } from "../../runtime/git/ignored-dirs.ts";
import { createUserSimpleGit } from "../../runtime/git/simple-git.ts";
import type { Commit } from "../../trpc/router/git/types.ts";
import { resolveBaseComparison } from "../../trpc/router/git/utils/git-helpers.ts";
import { defineWorkerTask } from "../define-worker-task.ts";
import type { GitTaskEnv } from "./git.ts";

const execFileAsync = promisify(execFile);

export const gitIgnoredDirsTask = defineWorkerTask<
	{ rootPath: string },
	string[]
>({
	type: "git/listIgnoredDirs",
	handler: ({ rootPath }) => listGitIgnoredDirsOrThrow(rootPath),
});

// (GIT-WATCH-ATTACH-TASK) Any git failure is a non-git attach, as inline.
export const gitDirTask = defineWorkerTask<
	{ worktreePath: string },
	{ gitDir: string | null }
>({
	type: "git/gitDir",
	handler: async ({ worktreePath }) => {
		try {
			const { stdout } = await execFileAsync(
				"git",
				["rev-parse", "--git-dir"],
				{
					cwd: worktreePath,
					env: { ...process.env, ...GIT_PARSE_ENV },
					windowsHide: true,
				},
			);
			const raw = stdout.trim();
			return { gitDir: isAbsolute(raw) ? raw : join(worktreePath, raw) };
		} catch {
			return { gitDir: null };
		}
	},
});

// (GIT-COMMITS-TASK)
export const gitListCommitsTask = defineWorkerTask<
	{
		worktreePath: string;
		baseBranch?: string;
		gitEnv: GitTaskEnv;
	},
	Commit[]
>({
	type: "git/listCommits",
	handler: async ({ worktreePath, baseBranch, gitEnv }) => {
		const git = createUserSimpleGit(worktreePath).env(gitEnv);
		const base = await resolveBaseComparison(git, baseBranch);
		const baseRef = base?.baseRef ?? "HEAD";
		const commits: Commit[] = [];
		try {
			const raw = await git.raw([
				"log",
				`${baseRef}..HEAD`,
				"--format=%H\t%h\t%s\t%an\t%ae\t%aI",
			]);
			for (const line of raw.trim().split("\n")) {
				if (!line) continue;
				const [hash, shortHash, message, author, authorEmail, date] =
					line.split("\t");
				commits.push({
					hash: hash ?? "",
					shortHash: shortHash ?? "",
					message: message ?? "",
					author: author ?? "",
					authorEmail: authorEmail ?? "",
					date: date ?? "",
				});
			}
		} catch {}
		return commits;
	},
});

export const gitReadTasks = [
	gitIgnoredDirsTask,
	gitDirTask,
	gitListCommitsTask,
];
