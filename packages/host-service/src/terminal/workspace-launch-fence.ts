/**
 * (WORKTREE-EXIT-CLEANUP) The fence a terminal launch crosses when the user
 * exits the workspace it belongs to. Two parts, because a retirement is not
 * instantaneous:
 *
 * - An ACTIVE flag, held for the whole host operation (dispose every terminal,
 *   then release the pinned Claude account). A launch that begins or reaches
 *   its row insert while the flag is up is refused outright, so a launch can
 *   neither slip in behind the disposal sweep nor spawn against a profile whose
 *   credentials are being rewritten.
 * - An EPOCH counter per workspace, bumped once when the flag goes up. It is
 *   what catches a launch that STRADDLES the operation: one that read the
 *   counter before the retirement began and arrives at its row insert after the
 *   flag has already come down. The flag alone cannot see that launch.
 *
 * The epoch is read when a launch begins and again in the same synchronous step
 * that inserts its session row; retirement bumps it in the same synchronous
 * step that lists the rows it is about to dispose. Those two atoms cannot
 * interleave, so a launch either inserts before the retirement lists (and is
 * disposed with everything else) or reads a changed epoch and refuses. No lock
 * is held across the launch, and a launch that starts after a retirement has
 * finished reads one stable value twice with the flag down — so a restored card
 * starts terminals normally.
 *
 * It lives apart from both the terminal module and the Claude accounts service
 * because unmanaged hosts — no Claude profiles, no workspace lock around
 * terminal creation — need the same fence.
 *
 * The epoch map is never pruned, deliberately: an entry is one workspace id and
 * one integer, it only appears for a workspace the user has actually exited,
 * and dropping an entry would reset that workspace's epoch to 0 — which is
 * exactly the value a launch in flight could be holding. It dies with the
 * process.
 */

const launchEpochs = new Map<string, number>();
const retiringWorkspaces = new Set<string>();

export function readWorkspaceLaunchEpoch(workspaceId: string): number {
	return launchEpochs.get(workspaceId) ?? 0;
}

/** True while a retirement of this workspace is still running on this host. */
export function isWorkspaceRetirementActive(workspaceId: string): boolean {
	return retiringWorkspaces.has(workspaceId);
}

/**
 * Both halves of the fence in one question: is the launch that read `epoch`
 * still allowed to proceed for this workspace?
 *
 * Every fence check asks exactly this, so they ask it through here. A launch
 * that reads the epoch and checks in the same step is answered by the flag
 * alone; one that reads it earlier and checks at its row insert is also
 * answered by the counter having moved.
 */
export function isWorkspaceLaunchFenced(
	workspaceId: string,
	epoch: number,
): boolean {
	return (
		isWorkspaceRetirementActive(workspaceId) ||
		readWorkspaceLaunchEpoch(workspaceId) !== epoch
	);
}

/**
 * Opens the retirement window: fences every launch already in flight for this
 * workspace (epoch bump) and refuses every new one until the returned function
 * is called. Callers MUST call it from a `finally`, after disposal and the
 * account release have settled — a window left open would refuse this
 * workspace's terminals for the life of the process.
 */
export function beginWorkspaceRetirement(workspaceId: string): () => void {
	retiringWorkspaces.add(workspaceId);
	launchEpochs.set(workspaceId, readWorkspaceLaunchEpoch(workspaceId) + 1);
	return () => {
		retiringWorkspaces.delete(workspaceId);
	};
}
