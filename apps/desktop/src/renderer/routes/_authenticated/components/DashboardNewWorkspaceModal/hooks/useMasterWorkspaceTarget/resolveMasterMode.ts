import { CLOUD_HOST_ID } from "../../components/DashboardNewWorkspaceForm/components/DevicePicker/constants";

/**
 * (MASTER-PLUS-LAUNCH) What the new-workspace modal should do for the
 * currently selected project + host.
 *
 * - `branch`  — today's flow, unchanged (branch name, base branch, PR, naming).
 * - `loading` — the answer is not knowable yet; submit is blocked, not guessed.
 * - `blocked` — a known-bad precondition with a reason to show the user.
 * - `master`  — a resolved local NON-GIT single-repo project: there are no
 *   branches to create, so submit restores the project's master workspace and
 *   launches the agent inside it.
 */
export type MasterWorkspaceTarget =
	| { mode: "branch" }
	| { mode: "loading" }
	| { mode: "blocked"; reason: string }
	| {
			mode: "master";
			mainWorkspaceId: string;
			/**
			 * What to call the place the agent will run, already resolved: the
			 * master row's name, else the project's display name, else a generic
			 * stand-in. NON-NULL on purpose — every consumer renders it verbatim
			 * ("Runs in <label>", "Pick an agent to run in <label>"), so the
			 * fallback chain is decided ONCE here rather than per call site.
			 */
			masterLabel: string;
			hostUrl: string;
	  };

/** The generic stand-in when neither the master row nor the project is named. */
const UNNAMED_MASTER_LABEL = "this project";

/**
 * The one shared "nothing special here, use the branch flow" value. Call sites
 * that deliberately never enter master mode pass this rather than minting an
 * object per render.
 */
export const BRANCH_ONLY_TARGET: MasterWorkspaceTarget = { mode: "branch" };

/** (MASTER-PLUS-LAUNCH) Shown when the project folder is gone from disk. */
export const MASTER_FOLDER_MISSING_REASON = "Project folder is missing on disk";

export interface ResolveMasterModeInput {
	/** Selected project; null while "No project" (session) or nothing is picked. */
	projectId: string | null;
	/** `draft.hostId ?? machineId` — the host the workspace would be created on. */
	selectedHostId: string | null;
	/** This device's host id. */
	machineId: string | null;
	/** The project's `type === "main"` workspace on `selectedHostId`, if any. */
	mainWorkspaceId: string | null;
	/**
	 * The master row's `worktreeExists`. `undefined` means the owning host did
	 * NOT report on it (see useHostWorkspaces.utils.ts:37-38) — only an explicit
	 * `false` proves the folder is gone.
	 */
	masterWorktreeExists: boolean | undefined;
	/** `useHostWorkspaces().isAbsenceAuthoritative(selectedHostId)`. */
	isAbsenceAuthoritative: boolean;
	/** `useProjectGitState().isResolved` — the git-ness probe succeeded. */
	isResolved: boolean;
	/** (MASTER-PLUS-LAUNCH) `useProjectGitState().isError` — a probe FAILED. */
	isError: boolean;
	/** `useProjectGitState().isGitRepo` (defaults true until resolved). */
	isGitRepo: boolean;
	/** `useProjectGitState().isMultiRepo`. */
	isMultiRepo: boolean;
	/** `useWorkspaceHostUrl(mainWorkspaceId)` — where `agents.run` is dispatched. */
	hostUrl: string | null;
	/** The master workspace row's display name, if the row carries one. */
	masterName: string | null;
	/** The selected project's display name — the fallback for `masterLabel`. */
	projectName: string | null;
}

/**
 * (MASTER-PLUS-LAUNCH) The ONE authored rule for "this master submit has
 * nowhere to put what the user wrote". Returns the refusal to show, or null.
 *
 * Master mode creates no workspace, so without an agent there is nothing to
 * launch and nothing to name: the branch flow would keep the text as the new
 * workspace's `namingPrompt`, and here it (and any attachment) would simply
 * vanish behind a submit that looked successful.
 *
 * `hasAttachments` is the one thing the two call sites read differently, and
 * deliberately so. The submit-relevant notion is the UPLOADED attachment ids —
 * that is what would ride along on `agents.run` — but the inline blocker runs
 * on every render and cannot await an upload, so it passes the same notion as
 * the user sees it: the files pilled on the form for the current host
 * (`visibleFiles`). Same rule, evaluated against the best fact each caller has.
 */
export function getMasterMissingAgentRefusal({
	hasAgent,
	prompt,
	hasAttachments,
	masterLabel,
}: {
	hasAgent: boolean;
	prompt: string;
	hasAttachments: boolean;
	masterLabel: string;
}): string | null {
	if (hasAgent) return null;
	if (prompt.trim() === "" && !hasAttachments) return null;
	return `Pick an agent to run in ${masterLabel}`;
}

/**
 * (MASTER-PLUS-LAUNCH) Pure decision for master mode. The rung order below is
 * LOAD-BEARING — each comment says what breaks if the rung moves.
 */
export function resolveMasterMode(
	input: ResolveMasterModeInput,
): MasterWorkspaceTarget {
	const {
		projectId,
		selectedHostId,
		machineId,
		mainWorkspaceId,
		masterWorktreeExists,
		isAbsenceAuthoritative,
		isResolved,
		isError,
		isGitRepo,
		isMultiRepo,
		hostUrl,
		masterName,
		projectName,
	} = input;

	// 1. No project (or a project-less session): nothing to run a master in.
	if (projectId == null) return BRANCH_ONLY_TARGET;

	// 2. Master mode restores + launches through the LOCAL host's own workspace
	//    rows. A cloud sandbox is provisioned per workspace and a remote host's
	//    master is not ours to restore, so both keep the branch flow.
	//
	//    Identity must be PROVEN, not merely un-contradicted. `selectedHostId
	//    !== machineId` alone passes when both are null — the ordinary state
	//    during startup, before the local host has reported its machine id —
	//    and the ladder would then go on to resolve master mode from whatever
	//    rows happened to be cached, including a REMOTE host's master. Two
	//    unknowns are not a match: an absent id on either side fails closed to
	//    the branch flow and re-resolves on the next render.
	if (
		machineId == null ||
		selectedHostId == null ||
		selectedHostId === CLOUD_HOST_ID ||
		selectedHostId !== machineId
	) {
		return BRANCH_ONLY_TARGET;
	}

	// 3. A multi-repo project has NO main workspace by construction and its "+"
	//    deliberately fans a branch out across members — never master mode.
	//    Checked before the missing-main rungs, which would otherwise read a
	//    multi-repo project as an unresolved single-repo one.
	if (isMultiRepo) return BRANCH_ONLY_TARGET;

	// 4. No master row yet AND the owning host has not proven its absence: the
	//    host list is still hydrating. Answering "branch" here would flash the
	//    branch UI on every modal open for a non-git project.
	if (mainWorkspaceId == null && !isAbsenceAuthoritative) {
		return { mode: "loading" };
	}

	// 5. No master row and the host PROVED it: fall back to the branch flow.
	//    This cannot deadlock — absence is proven by the host's own workspace
	//    list, independently of the git-ness probe (which needs a master row to
	//    run at all). A non-git submit down this path gets the loud server
	//    BAD_REQUEST; that is the accepted first-launch sweep race, and it
	//    self-heals once the sweep has adopted the folder on the next boot.
	if (mainWorkspaceId == null) return BRANCH_ONLY_TARGET;

	// 6. Folder gone from disk — checked BEFORE git-ness on purpose: a missing
	//    folder reads as `isGitRepo: false`, which would send the user into
	//    master mode, navigate, and only then fail with WORKTREE_GONE. Tested
	//    against `=== false`, never falsiness: `undefined` means the host did
	//    not report on the row, which proves nothing.
	if (masterWorktreeExists === false) {
		return { mode: "blocked", reason: MASTER_FOLDER_MISSING_REASON };
	}

	// 7. A FAILED probe is not a pending one. Fall back to the branch flow
	//    rather than spinning on "Checking project…" forever.
	if (isError) return BRANCH_ONLY_TARGET;

	// 8. Probe still pending. Only reachable with a LIVE master row (rung 5
	//    already returned for a missing one), so this genuinely resolves.
	if (!isResolved) return { mode: "loading" };

	// 9. Resolved git repo → today's branch flow. Resolved NON-git → master.
	if (isGitRepo) return BRANCH_ONLY_TARGET;
	// `agents.run` needs an address. In practice `isResolved` already implies a
	// host URL (the probe could not have succeeded without one), so this only
	// covers a host that dropped between the probe and this render. Falsiness,
	// not `== null`: an empty string is no more launchable than a missing one,
	// and answering "loading" for it is what lets the submit path keep a
	// one-line defensive check instead of its own empty-string branch.
	if (!hostUrl) return { mode: "loading" };
	return {
		mode: "master",
		mainWorkspaceId,
		masterLabel: masterName ?? projectName ?? UNNAMED_MASTER_LABEL,
		hostUrl,
	};
}
