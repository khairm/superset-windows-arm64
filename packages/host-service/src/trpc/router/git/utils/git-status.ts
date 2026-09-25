import type { SimpleGit } from "simple-git";
import type { Branch, ChangedFile } from "../types";
import type { BaseRefFetchTarget } from "./base-ref-freshness";
import {
	buildBranch,
	countUntrackedFileLines,
	detectUnstagedRenames,
	expandUntrackedDirectories,
	getChangedFilesForDiff,
	mapGitStatus,
	parseNumstat,
	resolveBaseComparison,
} from "./git-helpers";
import {
	createStatsCompleteness,
	type StatsCompleteness,
} from "./stats-completeness";

export const MAX_UNTRACKED_STAT_FILES = 5_000;

/**
 * Parse `ls-files -z --directory` output. `-z` keeps non-ASCII names raw
 * instead of C-quoted (`"caf\303\251/"`), so they compare equal to the
 * paths git status reports.
 */
export function parseIgnoredPaths(raw: string): string[] {
	return raw
		.split("\0")
		.map((entry) => entry.replace(/\/$/, ""))
		.filter(Boolean);
}

export interface GitStatusSnapshot {
	currentBranch: Branch;
	defaultBranch: Branch;
	againstBase: ChangedFile[];
	staged: ChangedFile[];
	unstaged: ChangedFile[];
	ignoredPaths: string[];
}

/**
 * (NON-GIT WORKSPACE) The empty snapshot for a non-git workspace. Single
 * source of truth for the "no git" shape so it can't drift from
 * GitStatusSnapshot / Branch when a field is added.
 */
export function emptyGitStatusSnapshot(): GitStatusSnapshot {
	const emptyBranch: Branch = {
		name: "",
		isHead: false,
		upstream: null,
		aheadCount: 0,
		behindCount: 0,
		lastCommitHash: "",
		lastCommitDate: "",
	};
	return {
		currentBranch: emptyBranch,
		defaultBranch: emptyBranch,
		againstBase: [],
		staged: [],
		unstaged: [],
		ignoredPaths: [],
	};
}

export interface GitStatusSnapshotComputation {
	snapshot: GitStatusSnapshot;
	/** Resolved in the worker, scheduled by the process-wide coordinator. */
	baseRefFetchTarget: BaseRefFetchTarget | null;
	/** (DIFFSTATS-COLD-CACHE) Every stat the walk could not read, empty when
	 * it read them all. Only a walk that tracks completeness fills it. */
	incompleteStats: string[];
}

async function resolvesToCommit(git: SimpleGit, ref: string): Promise<boolean> {
	const resolved = await git.raw([
		"rev-parse",
		"--verify",
		"--quiet",
		`${ref}^{commit}`,
	]);
	return resolved.trim().length > 0;
}

// (DIFFSTATS-COLD-CACHE) simple-git resolves a non-zero exit that printed no
// stderr, which is how `merge-base` reports two histories with no common commit.
async function hasComparableBase(
	git: SimpleGit,
	baseRef: string,
): Promise<boolean> {
	try {
		const mergeBase = await git.raw(["merge-base", baseRef, "HEAD"]);
		return mergeBase.trim().length > 0;
	} catch (error) {
		const [baseExists, headExists] = await Promise.all([
			resolvesToCommit(git, baseRef),
			resolvesToCommit(git, "HEAD"),
		]);
		if (baseExists && headExists) throw error;
		return false;
	}
}

// (DIFFSTATS-COLD-CACHE) A base with no common commit is an empty comparison,
// not a lost stat; a merge-base failing for any other reason is a lost stat.
async function readAgainstBase(
	git: SimpleGit,
	baseRef: string,
	completeness: StatsCompleteness | undefined,
): Promise<ChangedFile[]> {
	if (completeness) {
		try {
			if (!(await hasComparableBase(git, baseRef))) return [];
		} catch (error) {
			completeness.degrade(`merge-base ${baseRef}`, error);
			return [];
		}
	}
	return getChangedFilesForDiff(git, [`${baseRef}...HEAD`], completeness);
}

// (DIFFSTATS-COLD-CACHE) `trackStatsCompleteness` costs one extra merge-base
// probe; it never changes which files the snapshot lists.
export async function getGitStatusSnapshot({
	git,
	worktreePath,
	baseBranch,
	trackStatsCompleteness = false,
}: {
	git: SimpleGit;
	worktreePath: string;
	baseBranch?: string;
	trackStatsCompleteness?: boolean;
}): Promise<GitStatusSnapshotComputation> {
	const completeness = trackStatsCompleteness
		? createStatsCompleteness()
		: undefined;
	const currentBranchName = (
		await git.revparse(["--abbrev-ref", "HEAD"]).catch(() => "")
	).trim();
	const base = await resolveBaseComparison(git, baseBranch, completeness);
	const defaultBranchName = base?.branchName ?? null;
	const baseRef = base?.baseRef ?? "HEAD";

	const [currentBranch, defaultBranch, status, ignoredRaw] = await Promise.all([
		buildBranch(git, currentBranchName, true, baseRef),
		defaultBranchName
			? buildBranch(git, defaultBranchName, false)
			: buildBranch(git, currentBranchName, true),
		// Override simple-git's hardcoded bare `-u` (= `all`). Git only consults
		// `core.untrackedCache` in `normal` mode, so `-uall` silently re-walks the
		// entire worktree on every refresh — reported at ~1.9s vs ~0.03s on a 60k
		// file repo. statusTask appends custom args after its own `-u` and git
		// honours the last flag, so this wins. `normal` collapses a wholly-
		// untracked directory to one `dir/` entry, which the expansion below
		// undoes.
		git.status(["--untracked-files=normal"]),
		git
			.raw([
				"ls-files",
				"--others",
				"--ignored",
				"--exclude-standard",
				"--directory",
				"-z",
			])
			.catch(() => ""),
	]);

	// Top-level gitignored paths. `--directory` collapses entirely-ignored
	// folders to a single entry (e.g. `node_modules`) instead of enumerating
	// every file inside, so this stays cheap in large repos.
	const ignoredPaths = parseIgnoredPaths(ignoredRaw);

	const againstBase = await readAgainstBase(git, baseRef, completeness);

	const readNumstat = async (args: string[]) =>
		parseNumstat(
			await git.raw(args).catch((error) => {
				completeness?.degrade(args.join(" "), error);
				return "";
			}),
		);

	// Staged — use status.files index character for correct status. `-M` lets
	// numstat collapse renamed entries without the tree-wide copy-source scan
	// that `-C` performs.
	const stagedNumstat = await readNumstat([
		"diff",
		"--numstat",
		"-z",
		"-M",
		"--cached",
	]);
	const staged: ChangedFile[] = [];
	for (const file of status.files) {
		const idx = file.index;
		if (idx && idx !== " " && idx !== "?") {
			const stats = stagedNumstat.get(file.path) ?? {
				additions: 0,
				deletions: 0,
				isBinary: false,
			};
			staged.push({
				path: file.path,
				oldPath: file.from && file.from !== file.path ? file.from : undefined,
				status: mapGitStatus(idx),
				additions: stats.additions,
				deletions: stats.deletions,
				isBinary: stats.isBinary,
			});
		}
	}

	const unstagedNumstat = await readNumstat(["diff", "--numstat", "-z"]);
	const expandedUntracked = await expandUntrackedDirectories(
		git,
		status.files
			.filter((file) => file.index === "?" && file.working_dir === "?")
			.map((file) => file.path),
		completeness,
	);

	const unstaged: ChangedFile[] = [];
	const untrackedFiles: ChangedFile[] = [];
	for (const file of status.files) {
		const wd = file.working_dir;
		if (file.index === "?" && wd === "?") {
			// Fall back to the entry itself when a collapsed directory expanded to
			// nothing, so a path never silently disappears from the panel.
			for (const path of expandedUntracked.get(file.path) ?? [file.path]) {
				const entry: ChangedFile = {
					path,
					status: "untracked",
					additions: null,
					deletions: null,
				};
				untrackedFiles.push(entry);
				unstaged.push(entry);
			}
		} else if (wd && wd !== " ") {
			const stats = unstagedNumstat.get(file.path) ?? {
				additions: 0,
				deletions: 0,
				isBinary: false,
			};
			unstaged.push({
				path: file.path,
				// Git reports an intent-to-add file next to a similar deletion
				// as a worktree rename (` R old -> new`); keep the source so a
				// scoped re-read of either side knows to walk in full. A staged
				// rename edited afterwards (`RM`) is a plain modification here.
				oldPath:
					wd === "R" && file.from && file.from !== file.path
						? file.from
						: undefined,
				status: mapGitStatus(wd),
				additions: stats.additions,
				deletions: stats.deletions,
				isBinary: stats.isBinary,
			});
		}
	}
	const statsOmitted = untrackedFiles.length > MAX_UNTRACKED_STAT_FILES;
	if (!statsOmitted) {
		await countUntrackedFileLines(worktreePath, untrackedFiles, completeness);
	}

	const hasDeletions = unstaged.some((file) => file.status === "deleted");
	const renames = statsOmitted
		? []
		: await detectUnstagedRenames(
				git,
				worktreePath,
				untrackedFiles.map((file) => file.path),
				hasDeletions,
				completeness,
			);

	let mergedUnstaged = unstaged;
	if (renames.length > 0) {
		const consumedDeleted = new Set<string>();
		const consumedUntracked = new Set<string>();
		for (const rename of renames) {
			consumedDeleted.add(rename.oldPath);
			consumedUntracked.add(rename.newPath);
		}
		mergedUnstaged = unstaged.filter((file) => {
			if (file.status === "deleted" && consumedDeleted.has(file.path))
				return false;
			if (file.status === "untracked" && consumedUntracked.has(file.path))
				return false;
			return true;
		});
		for (const rename of renames) {
			mergedUnstaged.push({
				path: rename.newPath,
				oldPath: rename.oldPath,
				status: rename.status,
				additions: rename.additions,
				deletions: rename.deletions,
				isBinary: rename.isBinary,
			});
		}
	}

	return {
		snapshot: {
			currentBranch,
			defaultBranch,
			againstBase,
			staged,
			unstaged: mergedUnstaged,
			ignoredPaths,
		},
		baseRefFetchTarget: base?.fetchTarget ?? null,
		incompleteStats: completeness?.incomplete ?? [],
	};
}
