import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DiskHead, readHeadFromDisk } from "./head-file";

const root = mkdtempSync(join(tmpdir(), "head-file-"));
afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

const SHA = "0123456789abcdef0123456789abcdef01234567";

function writeGitDir(gitDir: string, head: string): void {
	mkdirSync(gitDir, { recursive: true });
	writeFileSync(join(gitDir, "HEAD"), head);
}

const cases: Array<[string, (worktree: string) => void, DiskHead]> = [
	[
		".git directory",
		(worktree) => writeGitDir(join(worktree, ".git"), "ref: refs/heads/main\n"),
		{ kind: "branch", name: "main" },
	],
	[
		".git file with a relative gitdir",
		(worktree) => {
			writeGitDir(
				join(worktree, "../repo/worktrees/a"),
				"ref: refs/heads/feat/a\n",
			);
			writeFileSync(join(worktree, ".git"), "gitdir: ../repo/worktrees/a\n");
		},
		{ kind: "branch", name: "feat/a" },
	],
	[
		".git file with an absolute gitdir",
		(worktree) => {
			const gitDir = join(worktree, "..", "absolute-gitdir");
			writeGitDir(gitDir, "ref: refs/heads/feat/b\n");
			writeFileSync(join(worktree, ".git"), `gitdir: ${gitDir}\n`);
		},
		{ kind: "branch", name: "feat/b" },
	],
	[
		"CRLF line endings",
		(worktree) => {
			writeGitDir(join(worktree, "../crlf-gitdir"), "ref: refs/heads/crlf\r\n");
			writeFileSync(join(worktree, ".git"), "gitdir: ../crlf-gitdir\r\n");
		},
		{ kind: "branch", name: "crlf" },
	],
	[
		"branch only in packed-refs",
		(worktree) => {
			writeGitDir(join(worktree, ".git"), "ref: refs/heads/packed\n");
			writeFileSync(
				join(worktree, ".git", "packed-refs"),
				`${SHA} refs/heads/packed\n`,
			);
		},
		{ kind: "branch", name: "packed" },
	],
	[
		"detached sha",
		(worktree) => writeGitDir(join(worktree, ".git"), `${SHA}\n`),
		{ kind: "detached" },
	],
	[
		"reftable .invalid stub",
		(worktree) =>
			writeGitDir(join(worktree, ".git"), "ref: refs/heads/.invalid\n"),
		{ kind: "unknown" },
	],
	[
		"malformed .git pointer",
		(worktree) => writeFileSync(join(worktree, ".git"), "not a pointer\n"),
		{ kind: "unknown" },
	],
	["missing .git", () => {}, { kind: "unknown" }],
];

describe("readHeadFromDisk", () => {
	test.each(cases)("%s", async (_name, layout, expected) => {
		const worktree = join(mkdtempSync(join(root, "case-")), "worktree");
		mkdirSync(worktree);
		layout(worktree);
		expect(await readHeadFromDisk(worktree)).toEqual(expected);
	});
});
