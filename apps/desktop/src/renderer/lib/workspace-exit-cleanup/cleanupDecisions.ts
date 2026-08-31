import type { AppRouter } from "@superset/host-service";
import type { inferRouterOutputs } from "@trpc/server";

/**
 * (WORKTREE-EXIT-CLEANUP) One host's answer, taken from the host-service router
 * so it cannot drift from what the host actually returns.
 */
export type HostRetirementOutcome =
	inferRouterOutputs<AppRouter>["claudeAccounts"]["retireWorkspaceRuntime"];

/**
 * (WORKTREE-EXIT-CLEANUP) What came back from one host, in the three shapes the
 * verdict turns on.
 *
 * A THROW IS NOT ONE THING, and collapsing it into "no answer" is what made a
 * broken owner look like an owner that was merely off. A host that RESPONDED
 * with an error is a machine that is right there and failed — the user should
 * be told and offered a retry. A request that never got a response at all is a
 * machine that is off, which is not a fault and gets the quiet wait.
 */
export type HostRetirementReply =
	| { kind: "answered"; outcome: HostRetirementOutcome }
	/** The host answered, with an error. It is reachable and it failed. */
	| { kind: "failed" }
	/** Nothing came back: connection refused, dropped stream, DNS. */
	| { kind: "unreachable" };

/**
 * (WORKTREE-EXIT-CLEANUP) What the hosts said, in the three shapes the
 * reconciler acts on differently:
 *
 * - `confirmed` — the teardown is finished, or provably has nothing left to do.
 *   Clear the stamp.
 * - `owner-failed` — a host that OWNS the workspace answered and could not
 *   dispose every terminal. The machine is right there; a retry may well work,
 *   and the user should be told the terminals are still up.
 * - `unreachable` — nobody who could own it answered. Nothing is wrong with the
 *   workspace, the owning machine is just off. Keep the debt quietly.
 */
export type RetirementVerdict = "confirmed" | "owner-failed" | "unreachable";

/**
 * (WORKTREE-EXIT-CLEANUP) Decide, from what the hosts said, whether the
 * workspace's exit cleanup is finished — the one question the reconciler asks,
 * because only a confirmed teardown may clear the pending stamp.
 *
 * A workspace has exactly one owning host, so one owner reporting a clean
 * teardown settles it — an unrelated host being unreachable at the same moment
 * cannot un-finish work its owner already confirmed. `every` rather than `some`
 * over the claimants so the pathological two-owner answer (a stale host row, an
 * id collision) keeps the stamp instead of clearing on the happier of two
 * contradictory replies.
 *
 * Absence is the other way to finish, and the reason this feature cannot
 * accumulate permanent debt. Two forms count, and both are authoritative rather
 * than merely quiet:
 *
 * - The host we RESOLVED as the workspace's owner answered `foundWorkspace:
 *   false`. It is the machine the workspace is filed under and it says the row
 *   is gone (destroyed, or the sandbox it lived in was torn down), so there is
 *   no runtime left to retire. A NON-owner saying the same proves nothing.
 * - `absenceProven`: every host we could ask answered, none of them has it, and
 *   the caller's own absence check agrees the workspace is not merely hiding
 *   behind an offline machine (see `isAbsenceAuthoritative`). This is what
 *   settles a workspace whose owning host was decommissioned entirely.
 *
 * AN OWNER THAT ANSWERED WITH AN ERROR IS A FAULT, not a wait. Nothing was
 * retired and the machine is right there, so it reads exactly like an owner
 * that answered and could not dispose a terminal: the user is told and the
 * Retry button means something. `unreachable` is reserved for the case it was
 * named for — nobody who could own this workspace responded at all.
 */
export function classifyRetirement(args: {
	/** The resolved owner's reply; null when there was no owner to ask. */
	owner: HostRetirementReply | null;
	/** Every other host asked. */
	others: readonly HostRetirementReply[];
	/** No host anywhere can still be hiding this workspace. */
	absenceProven: boolean;
}): RetirementVerdict {
	const replies =
		args.owner === null ? args.others : [args.owner, ...args.others];
	const claimants = replies
		.flatMap((reply) => (reply.kind === "answered" ? [reply.outcome] : []))
		.filter((outcome) => outcome.foundWorkspace === true);
	if (claimants.length > 0) {
		return claimants.every((claimant) => claimant.failed.length === 0)
			? "confirmed"
			: "owner-failed";
	}
	if (args.owner?.kind === "failed") return "owner-failed";
	if (args.owner?.kind === "answered" || args.absenceProven) return "confirmed";
	return "unreachable";
}

/**
 * (WORKTREE-EXIT-CLEANUP) Which URL a workspace's retirement call may actually
 * be sent to, once the owner's kind is taken into account.
 *
 * A CLOUD SANDBOX SLEEPS WHEN NOBODY IS LOOKING AT IT, and any request to its
 * URL wakes the VM — a background sweep would spin up a machine, bill for it
 * and keep it warm to retire terminals that died with the sandbox's last
 * suspend. So the call goes out only while something else is ALREADY holding
 * that sandbox open (its socket is up because the user has the workspace on
 * screen). Otherwise there is no target, the debt is retained untouched, and
 * the next time the user opens that workspace the sweep finds it awake.
 *
 * A normal host is never gated: it is either reachable or it is not, and
 * reaching it costs nothing it was not already paying.
 */
export function resolveRetirementCallUrl(target: {
	ownerHostUrl: string | null;
	isSandbox: boolean;
	/** Only meaningful for a sandbox: is its socket up right now? */
	isAwake: boolean;
}): string | null {
	if (target.ownerHostUrl === null) return null;
	if (target.isSandbox && !target.isAwake) return null;
	return target.ownerHostUrl;
}

export function isCleanupStampCurrent(
	expected: number,
	current: number | null,
): boolean {
	return current === expected;
}

/** What the reconciler should do with one workspace's retirement result. */
export type CleanupVerdict = "clear" | "retry" | "abandon";
/**
 * (WORKTREE-EXIT-CLEANUP) The stale-response guard. A retirement call outlives
 * the user, who is free to restore/unarchive/unsnooze/uncomplete the thread
 * while it is in flight — which CANCELS the pending cleanup. Comparing the
 * stamp read before the call with the stamp now is what stops that late reply
 * from writing to a row it no longer speaks for: `null` means the user un-exited
 * (the host call it already started may finish; its answer is simply ignored),
 * and a DIFFERENT number means they exited again after this attempt began, so
 * this attempt cannot vouch for the newer debt either. Both abandon.
 */
export function decideCleanupOutcome(args: {
	stampBefore: number;
	stampAfter: number | null;
	verdict: RetirementVerdict;
}): CleanupVerdict {
	if (!isCleanupStampCurrent(args.stampBefore, args.stampAfter))
		return "abandon";
	return args.verdict === "confirmed" ? "clear" : "retry";
}

/**
 * (WORKTREE-EXIT-CLEANUP) The standing toast's text, or null for no toast at
 * all. Two states the user would act on differently, and one they would not act
 * on at all:
 *
 * - Terminals that would not close on a machine that is RIGHT THERE is a real
 *   fault worth a retry, and it wins when both kinds are outstanding.
 * - An owner that is simply off is not a fault. It is named so the standing
 *   toast reads as a wait rather than a failure.
 * - Nothing outstanding means no toast, which is the rule that stops a toast
 *   from outliving its debt: un-exiting a workspace empties the pending set,
 *   and an empty set dismisses.
 */
export function describeCleanupToast(counts: {
	blocked: number;
	waiting: number;
}): { title: string; description: string } | null {
	if (counts.blocked > 0) {
		return {
			title: `Couldn't finish closing ${plural(counts.blocked)}`,
			description:
				"Some terminals wouldn't close. Retry, or check the machine that owns them.",
		};
	}
	if (counts.waiting > 0) {
		return {
			title: `Still closing ${plural(counts.waiting)}`,
			description:
				"Their terminals may still be running. This finishes on its own when the machine that owns them comes back.",
		};
	}
	return null;
}

function plural(count: number): string {
	return `${count} workspace${count === 1 ? "" : "s"}`;
}
