import { existsSync } from "node:fs";
import { and, eq, ne } from "drizzle-orm";
import { projects, workspaces } from "../db/schema";
import {
	type EnsureMainWorkspaceContext,
	ensureMainWorkspace,
} from "../trpc/router/project/utils/ensure-main-workspace";
import { isGitRepoStrict, NON_GIT_BRANCH } from "./git/non-git";

/**
 * What the sweep should do with one project row, decided before anything is
 * written. A `skip` writes nothing; an `ensure` carries the git-ness the write
 * has to DECLARE.
 */
export type MainSweepDecision =
	| { action: "ensure"; repoPath: string; nonGit: boolean }
	| { action: "skip"; reason: "path-missing" }
	| { action: "skip"; reason: "gitness-unknown"; error: unknown };

/**
 * (MASTER-ALWAYS-ACTIVE) Decide one project row's fate. Holds no db handle and
 * takes `pathExists` / `probeIsGitRepo` as arguments — the `selectStranded`
 * shape from `archived-workspace-reconcile`, so the decision is testable
 * without a temp repo and the boot entry point keeps no test seam.
 *
 * Why git-ness must be DECLARED at all: without `nonGit`,
 * `ensureMainWorkspaceStrict` reads git HEAD before it ever looks for an
 * existing row, so a non-git project throws PRECONDITION_FAILED and the
 * log-and-continue wrapper swallows it — a genuinely-lost non-git main could
 * never be rebuilt by this sweep.
 *
 * THREE outcomes, not two. A probe that THROWS is not a "no": if a failure
 * were read as non-git, one broken git binary (or a transient spawn failure)
 * would hit every project on the machine at once and `ensureMainWorkspace`
 * would REWRITE each existing git master's branch/name to the non-git marker —
 * a durable corruption of rows the sweep is only supposed to backfill. An
 * unknown answer is skipped, loudly, and retried on the next boot.
 */
export async function classifyMainSweepRow(
	repoPath: string,
	hasExistingGitMain: boolean,
	pathExists: (path: string) => boolean,
	probeIsGitRepo: (dirPath: string) => Promise<boolean>,
): Promise<MainSweepDecision> {
	if (!repoPath || !pathExists(repoPath)) {
		return { action: "skip", reason: "path-missing" };
	}

	// A main row already carrying a real branch IS a git-ness answer, written
	// down by an earlier boot that probed successfully. Re-probing spawns git
	// only to re-learn what the row already says, so take the git path
	// straight away. If the folder has since stopped being a repo, the HEAD
	// read inside `ensureMainWorkspaceStrict` throws, the log-and-continue
	// wrapper swallows it and the row is left untouched — the same fail-closed
	// outcome a failed probe gets here.
	if (hasExistingGitMain) {
		return { action: "ensure", repoPath, nonGit: false };
	}

	try {
		return { action: "ensure", repoPath, nonGit: !(await probeIsGitRepo(repoPath)) };
	} catch (error) {
		return { action: "skip", reason: "gitness-unknown", error };
	}
}

/**
 * Recovery path for projects set up before `type='main'` shipped.
 *
 * Iterates local `projects` and ensures each has a main v2 workspace bound to
 * the current host. Idempotent via the `(projectId, hostId) WHERE type='main'`
 * unique index, so it's safe on every boot — only does real work the first
 * time after upgrade.
 */
export async function runMainWorkspaceSweep(
	ctx: EnsureMainWorkspaceContext,
): Promise<void> {
	const rows = ctx.db
		.select({ id: projects.id, repoPath: projects.repoPath })
		.from(projects)
		.all();

	// One read off `workspaces_one_main_per_project` replaces a git spawn per
	// already-classified project: every main row whose branch is a real branch
	// skips the probe below.
	const gitMainProjectIds = new Set(
		ctx.db
			.select({ projectId: workspaces.projectId })
			.from(workspaces)
			.where(
				and(eq(workspaces.type, "main"), ne(workspaces.branch, NON_GIT_BRANCH)),
			)
			.all()
			.map((row) => row.projectId),
	);

	for (const row of rows) {
		const decision = await classifyMainSweepRow(
			row.repoPath,
			gitMainProjectIds.has(row.id),
			existsSync,
			isGitRepoStrict,
		);
		if (decision.action === "skip") {
			if (decision.reason === "path-missing") {
				console.warn(
					`[main-workspace-sweep] skipping ${row.id}: repoPath ${row.repoPath} does not exist`,
				);
			} else {
				console.warn(
					`[main-workspace-sweep] skipping ${row.id}: git-ness probe FAILED for ${row.repoPath} — refusing to guess (an existing main would be rewritten as non-git)`,
					decision.error,
				);
			}
			continue;
		}
		await ensureMainWorkspace(ctx, row.id, decision.repoPath, {
			nonGit: decision.nonGit,
		});
	}
}
