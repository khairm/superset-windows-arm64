import {
	copyFile,
	lstat,
	mkdtemp,
	open,
	readFile,
	realpath,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import {
	BINARY_SNIFF_BYTES,
	isBinaryMediaFile,
} from "@superset/shared/media-files";
import { TRPCError } from "@trpc/server";
import type { SimpleGit } from "simple-git";
import { mapConcurrent } from "../../../../lib/map-concurrent";
import { resolveUpstream } from "../../../../runtime/git/refs";
import { createUserSimpleGit } from "../../../../runtime/git/simple-git";
import type { Branch, ChangedFile, FileStatus } from "../types";
import type { StatsCompleteness } from "./stats-completeness";

// Skip line counting for files larger than this — anything over a MB
// of "source" is almost certainly a data file or accidental binary,
// and the LOC signal isn't useful for it.
const MAX_UNTRACKED_LINE_COUNT_SIZE = 1 * 1024 * 1024;

// Cap parallel file I/O so a workspace with thousands of untracked
// files (e.g. fresh checkout with un-gitignored build artifacts)
// doesn't exhaust the process file-descriptor limit.
const UNTRACKED_IO_CONCURRENCY = 64;

// Chunk size for streaming untracked files when counting lines. Bounds
// per-file memory to this × UNTRACKED_IO_CONCURRENCY instead of the full
// file size, and comfortably covers the 8KB binary sniff window.
const UNTRACKED_READ_CHUNK_SIZE = 64 * 1024;

// (DIFFSTATS-COLD-CACHE) A path git listed as untracked can be deleted before
// the walk reaches it, several git round-trips later. It contributes no lines
// and git's next status drops it, so it is not an incomplete stat; anything
// else (EBUSY, EACCES, EIO) is.
function isVanishedPath(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | null)?.code;
	return code === "ENOENT" || code === "ENOTDIR";
}

/** Runs `fn` over `items` with at most `limit` in flight at once, returning
 * results in input order. Shared by any caller that needs to bound
 * concurrent subprocess/file-descriptor usage across a batch. */
export async function mapWithConcurrency<T, R>(
	items: T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const workers = Array.from(
		{ length: Math.min(limit, items.length) },
		async () => {
			while (true) {
				const i = next++;
				if (i >= items.length) return;
				results[i] = await fn(items[i] as T, i);
			}
		},
	);
	await Promise.all(workers);
	return results;
}

/**
 * `:(literal)` stops git from reading `[`, `*` and `?` in a path as glob
 * syntax. Without it a pathspec for `app/[id]/page.tsx` also matches
 * `app/i/page.tsx` — worktree paths the caller never named.
 */
export function literalPathspecs(paths: string[]): string[] {
	return paths.map((path) => `:(literal)${path}`);
}

/** (DIFFSTATS-COLD-CACHE) Windows caps a command line at 32767 characters,
 * which one pathspec per path reaches at a few hundred entries. A caller that
 * cannot pass the pathspecs in a file splits them into runs of this size. */
const MAX_PATHSPEC_ARGV_CHARS = 8_000;

function chunkLiteralPathspecs(paths: string[]): string[][] {
	const chunks: string[][] = [];
	let chunk: string[] = [];
	let chars = 0;
	for (const pathspec of literalPathspecs(paths)) {
		if (chunk.length > 0 && chars + pathspec.length > MAX_PATHSPEC_ARGV_CHARS) {
			chunks.push(chunk);
			chunk = [];
			chars = 0;
		}
		chunk.push(pathspec);
		chars += pathspec.length + 1;
	}
	if (chunk.length > 0) chunks.push(chunk);
	return chunks;
}

/** Map git's single-letter status codes to GitHub-aligned FileStatus */
export function mapGitStatus(code: string): FileStatus {
	switch (code) {
		case "A":
			return "added";
		case "M":
			return "modified";
		case "D":
			return "deleted";
		case "R":
			return "renamed";
		case "C":
			return "copied";
		case "T":
			return "changed";
		case "?":
			return "untracked";
		default:
			return "modified";
	}
}

/**
 * Parse the NUL-delimited output of `git diff --numstat -z`. Renames
 * appear as `<add>\t<del>\t\0<old>\0<new>\0` — three NUL-separated
 * cells — and are indexed under both source and destination paths so
 * callers keyed by either get a hit.
 */
export function parseNumstat(
	raw: string,
): Map<string, { additions: number; deletions: number; isBinary: boolean }> {
	const result = new Map<
		string,
		{ additions: number; deletions: number; isBinary: boolean }
	>();
	const entries = raw.split("\0");
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (!entry) continue;
		const t1 = entry.indexOf("\t");
		const t2 = t1 >= 0 ? entry.indexOf("\t", t1 + 1) : -1;
		if (t1 < 0 || t2 < 0) continue;
		const add = entry.slice(0, t1);
		const del = entry.slice(t1 + 1, t2);
		const pathMaybe = entry.slice(t2 + 1);
		const stats = {
			additions: add === "-" ? 0 : Number.parseInt(add || "0", 10),
			deletions: del === "-" ? 0 : Number.parseInt(del || "0", 10),
			isBinary: add === "-" && del === "-",
		};
		if (pathMaybe === "") {
			const oldPath = entries[++i] ?? "";
			const newPath = entries[++i] ?? "";
			if (newPath) result.set(newPath, stats);
			if (oldPath) result.set(oldPath, stats);
		} else {
			result.set(pathMaybe, stats);
		}
	}
	return result;
}

/**
 * Parse `git diff --name-status -z`. Each record is the status letter
 * followed by one path (regular) or two paths (rename/copy), with NUL
 * separators. Using -z avoids path quoting mismatches with numstat -z
 * for non-ASCII filenames.
 */
export function parseNameStatus(
	raw: string,
): Array<{ status: string; path: string; oldPath?: string }> {
	const results: Array<{ status: string; path: string; oldPath?: string }> = [];
	const fields = raw.split("\0");
	for (let i = 0; i < fields.length; i++) {
		const head = fields[i];
		if (!head) continue;
		const statusCode = head[0] ?? "?";
		if (statusCode === "R" || statusCode === "C") {
			const oldPath = fields[++i] ?? "";
			const newPath = fields[++i] ?? "";
			results.push({ status: statusCode, path: newPath, oldPath });
		} else {
			const path = fields[++i] ?? "";
			results.push({ status: statusCode, path });
		}
	}
	return results;
}

/** (DIFFSTATS-COLD-CACHE) `--quiet` makes an unset `origin/HEAD` exit without
 * writing stderr, which simple-git reports as empty output; only a genuine
 * failure rejects, and then the base is unknown rather than absent. */
export async function getDefaultBranchName(
	git: SimpleGit,
	completeness?: StatsCompleteness,
): Promise<string | null> {
	let ref: string;
	try {
		ref = await git.raw([
			"symbolic-ref",
			"--quiet",
			"refs/remotes/origin/HEAD",
			"--short",
		]);
	} catch (error) {
		completeness?.degrade("origin/HEAD", error);
		return null;
	}
	const branchName = ref.trim().replace(/^origin\//, "");
	return branchName === "" ? null : branchName;
}

/**
 * Resolve the base comparison for "this branch vs its upstream default"
 * views. Honors the local default branch's configured upstream
 * (e.g. `upstream/main`) before falling back to `origin/<name>`. Returns
 * null when no default branch can be determined.
 */
export async function resolveBaseComparison(
	git: SimpleGit,
	explicitBranch?: string,
	completeness?: StatsCompleteness,
): Promise<{
	branchName: string;
	baseRef: string;
	// Remote branch to fetch to keep `baseRef` current; null when the base
	// tracks another local branch and there is nothing to fetch.
	fetchTarget: { remote: string; branch: string } | null;
} | null> {
	const branchName =
		explicitBranch ?? (await getDefaultBranchName(git, completeness));
	if (!branchName) return null;
	// (DIFFSTATS-COLD-CACHE) unset tracking config resolves empty, so only a
	// genuine config failure reaches here.
	const upstream = await resolveUpstream(git, branchName, (error) =>
		completeness?.degrade(`branch.${branchName} upstream`, error),
	);
	// Git encodes a branch tracking another local branch as
	// `branch.<name>.remote = .` — in that case the merge target is
	// already a bare branch name in this repo, not `./<name>`.
	if (upstream) {
		return upstream.remote === "."
			? { branchName, baseRef: upstream.remoteBranch, fetchTarget: null }
			: {
					branchName,
					baseRef: `${upstream.remote}/${upstream.remoteBranch}`,
					fetchTarget: {
						remote: upstream.remote,
						branch: upstream.remoteBranch,
					},
				};
	}
	return {
		branchName,
		baseRef: `origin/${branchName}`,
		fetchTarget: { remote: "origin", branch: branchName },
	};
}

export async function buildBranch(
	git: SimpleGit,
	name: string,
	isHead: boolean,
	compareRef?: string,
): Promise<Branch> {
	let upstream: string | null = null;
	let aheadCount = 0;
	let behindCount = 0;
	let lastCommitHash = "";
	let lastCommitDate = "";

	try {
		const remote = (
			await git.raw(["config", `branch.${name}.remote`]).catch(() => "")
		).trim();
		const merge = (
			await git.raw(["config", `branch.${name}.merge`]).catch(() => "")
		).trim();
		upstream =
			remote && merge ? `${remote}/${merge.replace("refs/heads/", "")}` : null;
	} catch {
		upstream = null;
	}

	if (compareRef) {
		try {
			const counts = (
				await git.raw([
					"rev-list",
					"--left-right",
					"--count",
					`${compareRef}...${name}`,
				])
			).trim();
			const [behind, ahead] = counts.split("\t").map(Number);
			aheadCount = ahead ?? 0;
			behindCount = behind ?? 0;
		} catch {}
	}

	try {
		const log = (await git.raw(["log", "-1", "--format=%H\t%aI", name])).trim();
		const [hash, date] = log.split("\t");
		lastCommitHash = hash ?? "";
		lastCommitDate = date ?? "";
	} catch {}

	return {
		name,
		isHead,
		upstream,
		aheadCount,
		behindCount,
		lastCommitHash,
		lastCommitDate,
	};
}

function isPathWithinWorktree(
	worktreePath: string,
	candidate: string,
): boolean {
	const relativePath = relative(worktreePath, candidate);
	if (relativePath === "") return true;
	return (
		relativePath !== ".." &&
		!relativePath.startsWith(`..${sep}`) &&
		!isAbsolute(relativePath)
	);
}

/**
 * Untracked files don't appear in `git diff --numstat` (they're not in
 * the index). The only batch-friendly way to get their line counts is
 * to read them directly — `git diff --no-index` requires a subprocess
 * per file, and `git add -N` would mutate the index inside a read.
 */
export async function countUntrackedFileLines(
	worktreePath: string,
	files: ChangedFile[],
	completeness?: StatsCompleteness,
): Promise<void> {
	if (files.length === 0) return;

	let worktreeReal: string;
	try {
		worktreeReal = await realpath(worktreePath);
	} catch (error) {
		completeness?.degrade("untracked line counts", error);
		return;
	}

	await mapConcurrent(files, UNTRACKED_IO_CONCURRENCY, async (file) => {
		try {
			const absolutePath = resolve(worktreePath, file.path);
			if (!isPathWithinWorktree(worktreePath, absolutePath)) return;

			const fileReal = await realpath(absolutePath);
			if (!isPathWithinWorktree(worktreeReal, fileReal)) return;

			const stats = await stat(fileReal);
			if (!stats.isFile()) {
				return;
			}

			if (isBinaryMediaFile(file.path)) {
				file.isBinary = true;
				file.additions = 0;
				file.deletions = 0;
				return;
			}

			// Stream the file in fixed-size chunks rather than slurping it:
			// readFile would pin the whole file in memory (×UNTRACKED_IO_CONCURRENCY)
			// and, read as utf-8, would turn binary into U+FFFDs and report a
			// bogus line count. We reuse one buffer, sniff the first 8KB for NULs
			// (git's binary heuristic), and tally newlines as we go.
			const handle = await open(fileReal, "r");
			try {
				const buf = Buffer.allocUnsafe(UNTRACKED_READ_CHUNK_SIZE);
				let { bytesRead } = await handle.read(buf, 0, buf.length, 0);

				const sniffEnd = Math.min(bytesRead, BINARY_SNIFF_BYTES);
				for (let i = 0; i < sniffEnd; i++) {
					if (buf[i] === 0) {
						file.isBinary = true;
						file.additions = 0;
						file.deletions = 0;
						return;
					}
				}

				// Over the budget: skip the LOC signal without reading the rest.
				if (stats.size > MAX_UNTRACKED_LINE_COUNT_SIZE) {
					return;
				}

				let newlines = 0;
				let lastByte = -1;
				let offset = 0;
				while (bytesRead > 0) {
					for (let i = 0; i < bytesRead; i++) {
						if (buf[i] === 0x0a) newlines++;
					}
					lastByte = buf[bytesRead - 1] ?? lastByte;
					offset += bytesRead;
					({ bytesRead } = await handle.read(buf, 0, buf.length, offset));
				}
				// Match `content.split(/\r?\n/)`: a trailing newline doesn't add a
				// line, but a final non-empty line without one does. (\r\n shares
				// the \n, so counting \n bytes is equivalent.)
				file.additions =
					lastByte === -1 ? 0 : lastByte === 0x0a ? newlines : newlines + 1;
				file.deletions = 0;
			} finally {
				await handle.close();
			}
		} catch (error) {
			if (!isVanishedPath(error)) completeness?.degrade(file.path, error);
		}
	});
}

// (DIFFSTATS-COLD-CACHE) One argv entry per untracked path overruns the
// 32767-character Windows command line at a few hundred files, so the
// pathspecs travel in a file. `--pathspec-file-nul` settles the separator
// only: glob magic still applies inside the file, so every entry carries the
// same `:(literal)` the argv form had.
async function runIntentToAdd(
	tempGit: SimpleGit,
	tempDir: string,
	paths: string[],
): Promise<void> {
	const pathspecFile = join(tempDir, "pathspecs");
	await writeFile(pathspecFile, `${literalPathspecs(paths).join("\0")}\0`);
	await tempGit.raw([
		"add",
		"--intent-to-add",
		`--pathspec-from-file=${pathspecFile}`,
		"--pathspec-file-nul",
	]);
}

// (DIFFSTATS-COLD-CACHE) `git add --intent-to-add` refuses the whole set when
// one pathspec matches nothing, so a path that vanished since `git status`
// listed it is recognised by re-checking the disk, never by git's wording.
// `lstat`, because a dangling symlink is an untracked path git still lists.
async function pathsStillOnDisk(
	worktreePath: string,
	paths: string[],
): Promise<string[]> {
	const present = await mapWithConcurrency(
		paths,
		UNTRACKED_IO_CONCURRENCY,
		async (path) => {
			try {
				await lstat(resolve(worktreePath, path));
				return true;
			} catch (error) {
				return !isVanishedPath(error);
			}
		},
	);
	return paths.filter((_, index) => present[index]);
}

// (DIFFSTATS-COLD-CACHE) A path git listed as untracked can be deleted
// before the add runs, and one unmatched pathspec refuses the whole set.
// Retrying with the survivors keeps every other rename in the walk.
async function markIntentToAdd(
	tempGit: SimpleGit,
	worktreePath: string,
	tempDir: string,
	paths: string[],
): Promise<void> {
	try {
		await runIntentToAdd(tempGit, tempDir, paths);
	} catch (error) {
		const surviving = await pathsStillOnDisk(worktreePath, paths);
		if (surviving.length === paths.length) throw error;
		if (surviving.length === 0) return;
		await runIntentToAdd(tempGit, tempDir, surviving);
	}
}

export interface DetectedRename {
	oldPath: string;
	newPath: string;
	status: "renamed";
	additions: number;
	deletions: number;
	isBinary: boolean;
}

/**
 * Run git's real rename detection across the working tree by copying the
 * index to a temp file, marking untracked files intent-to-add against that
 * copy, and diffing. Real index is never mutated. Falls back to an empty
 * result on any error — caller still has the unrelated deleted+untracked
 * entries to display — and reports the degradation to `completeness`.
 * (DIFFSTATS-COLD-CACHE)
 */
export async function detectUnstagedRenames(
	git: SimpleGit,
	worktreePath: string,
	untrackedPaths: string[],
	hasDeletions: boolean,
	completeness?: StatsCompleteness,
): Promise<DetectedRename[]> {
	if (untrackedPaths.length === 0) return [];
	if (!hasDeletions) return [];

	let indexPath: string;
	let tempDir: string;
	try {
		indexPath = (await git.raw(["rev-parse", "--git-path", "index"])).trim();
		if (!indexPath) throw new Error("git reported no index path");
		if (!isAbsolute(indexPath)) indexPath = resolve(worktreePath, indexPath);
		tempDir = await mkdtemp(join(tmpdir(), "superset-renames-"));
	} catch (error) {
		// (DIFFSTATS-COLD-CACHE)
		completeness?.degrade("rename detection", error);
		return [];
	}

	try {
		const tempIndex = join(tempDir, "index");
		await copyFile(indexPath, tempIndex);

		const tempGit = createUserSimpleGit(worktreePath).env({
			...process.env,
			GIT_INDEX_FILE: tempIndex,
		});

		await markIntentToAdd(tempGit, worktreePath, tempDir, untrackedPaths);

		const [nameStatusRaw, numstatRaw] = await Promise.all([
			tempGit.raw(["diff", "--name-status", "-z", "-M"]),
			tempGit.raw(["diff", "--numstat", "-z", "-M"]),
		]);

		const nameStatus = parseNameStatus(nameStatusRaw);
		const numstat = parseNumstat(numstatRaw);

		const result: DetectedRename[] = [];
		for (const entry of nameStatus) {
			if (!entry.oldPath) continue;
			const code = entry.status[0];
			if (code !== "R") continue;
			const stats = numstat.get(entry.path) ?? {
				additions: 0,
				deletions: 0,
				isBinary: false,
			};
			result.push({
				oldPath: entry.oldPath,
				newPath: entry.path,
				status: "renamed",
				additions: stats.additions,
				deletions: stats.deletions,
				isBinary: stats.isBinary,
			});
		}
		return result;
	} catch (error) {
		completeness?.degrade("rename detection", error);
		return [];
	} finally {
		await rm(tempDir, { recursive: true, force: true }).catch((error) => {
			console.warn("[git-helpers] failed to remove rename-detection tempdir", {
				tempDir,
				error,
			});
		});
	}
}

export async function getChangedFilesForDiff(
	git: SimpleGit,
	diffArgs: string[],
	completeness?: StatsCompleteness,
): Promise<ChangedFile[]> {
	try {
		const [nameStatusRaw, numstatRaw] = await Promise.all([
			git.raw(["diff", "--name-status", "-z", ...diffArgs]),
			git.raw(["diff", "--numstat", "-z", ...diffArgs]),
		]);
		const nameStatus = parseNameStatus(nameStatusRaw);
		const numstat = parseNumstat(numstatRaw);
		return nameStatus
			.filter((f) => f.path)
			.map((f) => ({
				path: f.path,
				oldPath: f.oldPath,
				status: mapGitStatus(f.status),
				additions: (numstat.get(f.path) ?? { additions: 0 }).additions,
				deletions: (numstat.get(f.path) ?? { deletions: 0 }).deletions,
				isBinary: (numstat.get(f.path) ?? { isBinary: false }).isBinary,
			}));
	} catch (error) {
		completeness?.degrade(`diff ${diffArgs.join(" ")}`, error);
		return [];
	}
}

/** Rejects a caller-supplied relative path that could escape the worktree
 * (absolute, `..` traversal, or the worktree root itself) — required before
 * any git/fs operation joins it onto a worktree path. */
export function assertSafeRelativePath(filePath: string): void {
	if (isAbsolute(filePath)) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Absolute paths are not allowed",
		});
	}
	const normalized = normalize(filePath);
	if (normalized.split(sep).includes("..")) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Path traversal is not allowed",
		});
	}
	if (normalized === "" || normalized === ".") {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Cannot target worktree root",
		});
	}
}

export type DiffCategory = "against-base" | "staged" | "unstaged" | "commit";

/** Refs shared by every file in a `getDiff`/`getDiffBulk` request for a given
 * category — resolved once per request rather than once per file. */
export interface DiffCategoryRefs {
	/** against-base: merge-base(baseRef, HEAD) */
	originRef?: string;
	/** commit: the "before" ref (fromHash, or commitHash^) */
	fromRef?: string;
	/** commit: the commit itself */
	toRef?: string;
}

export async function resolveDiffCategoryRefs(
	git: SimpleGit,
	category: DiffCategory,
	opts: { baseBranch?: string; commitHash?: string; fromHash?: string },
): Promise<DiffCategoryRefs> {
	if (category === "against-base") {
		const base = await resolveBaseComparison(git, opts.baseBranch);
		const baseRef = base?.baseRef ?? "HEAD";
		// Use the merge base so the diff excludes unrelated changes landed on
		// the base branch after we forked — matches what the file list
		// (3-dot diff) is already filtered by.
		const originRef = await git
			.raw(["merge-base", baseRef, "HEAD"])
			.then((s) => s.trim())
			.catch(() => baseRef);
		return { originRef };
	}
	if (category === "commit") {
		if (!opts.commitHash) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "commitHash is required for commit diffs",
			});
		}
		return {
			fromRef: opts.fromHash ?? `${opts.commitHash}^`,
			toRef: opts.commitHash,
		};
	}
	return {};
}

export async function loadFileDiffContent(
	git: SimpleGit,
	worktreePath: string,
	category: DiffCategory,
	path: string,
	refs: DiffCategoryRefs,
): Promise<{
	oldFile: { name: string; contents: string };
	newFile: { name: string; contents: string };
}> {
	let originalContent = "";
	let modifiedContent = "";

	if (category === "against-base") {
		try {
			originalContent = await git.show([`${refs.originRef}:${path}`]);
		} catch {}
		try {
			modifiedContent = await git.show([`HEAD:${path}`]);
		} catch {}
	} else if (category === "staged") {
		try {
			originalContent = await git.show([`HEAD:${path}`]);
		} catch {}
		try {
			modifiedContent = await git.show([`:0:${path}`]);
		} catch {}
	} else if (category === "commit") {
		try {
			originalContent = await git.show([`${refs.fromRef}:${path}`]);
		} catch {}
		try {
			modifiedContent = await git.show([`${refs.toRef}:${path}`]);
		} catch {}
	} else {
		// Unstaged: compare index (staged version) against working tree.
		// If the file isn't in the index (untracked), originalContent stays
		// empty = "new file".
		try {
			originalContent = await git.show([`:0:${path}`]);
		} catch {}
		try {
			modifiedContent = await readFile(`${worktreePath}/${path}`, "utf-8");
		} catch {}
	}

	const fileName = path.split("/").pop() ?? path;
	return {
		oldFile: { name: fileName, contents: originalContent },
		newFile: { name: fileName, contents: modifiedContent },
	};
}

/**
 * Expand the `dir/` entries `--untracked-files=normal` collapses back into the
 * individual files `-uall` would have listed, keyed by the collapsed entry.
 * The walk is scoped to the untracked directories themselves rather than the
 * whole worktree, so it costs a fraction of what `-uall` does — and nothing at
 * all in the common case where there are no untracked directories.
 */
export async function expandUntrackedDirectories(
	git: SimpleGit,
	untrackedPaths: string[],
	completeness?: StatsCompleteness,
): Promise<Map<string, string[]>> {
	const dirs = untrackedPaths.filter((path) => path.endsWith("/"));
	const expanded = new Map<string, string[]>();
	if (dirs.length === 0) return expanded;

	// `--exclude-standard` matches what status itself honours, including
	// .gitignore files nested inside the untracked directory.
	// (DIFFSTATS-COLD-CACHE) One run per argv-sized batch of pathspecs.
	const listed: string[] = [];
	for (const pathspecs of chunkLiteralPathspecs(dirs)) {
		const raw = await git
			.raw([
				"ls-files",
				"--others",
				"--exclude-standard",
				"-z",
				"--",
				...pathspecs,
			])
			.catch((error) => {
				completeness?.degrade("untracked directory expansion", error);
				return "";
			});
		listed.push(...raw.split("\0").filter(Boolean));
	}

	for (const path of listed) {
		const dir = dirs.find((candidate) => path.startsWith(candidate));
		if (!dir) continue;
		const files = expanded.get(dir);
		if (files) files.push(path);
		else expanded.set(dir, [path]);
	}
	return expanded;
}
