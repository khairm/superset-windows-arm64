import {
	getHostServiceClientByUrl,
	isHostServiceConnectionError,
} from "renderer/lib/host-service-client";
import {
	classifyRetirement,
	type HostRetirementReply,
	type RetirementVerdict,
} from "./cleanupDecisions";

/**
 * (WORKTREE-EXIT-CLEANUP) Ask the hosts that could own this workspace to retire
 * its runtime: dispose its terminals and release any pinned Claude account.
 *
 * Two target sets, unioned by URL so no host is asked twice for the same
 * workspace. `ownerHostUrl` is the workspace's own host resolved through the
 * normal host-target pattern (`useHostWorkspaces`'s `cache.resolveHostUrl`), so
 * an owner on ANOTHER machine is reached over the relay exactly like every
 * other cross-host call; it is null while that owner is offline, unknown, or a
 * sandbox nobody is holding awake (see `resolveRetirementCallUrl`).
 * `localUrls` are the local host-services, enumerated once per sweep by the
 * caller. They are NOT there to reach another org: the rows driving this are
 * per-org (the collection is keyed `v2-workspace-local-state-${organizationId}`),
 * so a pending workspace always belongs to the org this window is in. They are
 * the fallback for a workspace whose owner did not resolve to a URL — a host
 * row that has not hydrated, or a local host-service the known-hosts list has
 * not caught up with — and each host that does not own the workspace simply
 * answers `foundWorkspace: false`.
 *
 * `absenceAuthoritative` is the caller's verdict on whether the workspace's
 * absence from the host lists PROVES it is gone. It only counts here when every
 * host we asked also answered — one silent host is one machine that could still
 * be holding the row.
 *
 * Never throws: the caller decides what to do with each verdict.
 */
export async function retireWorkspaceRuntime(
	workspaceId: string,
	targets: {
		localUrls: readonly string[];
		ownerHostUrl: string | null;
		absenceAuthoritative: boolean;
	},
): Promise<RetirementVerdict> {
	const others = new Set(targets.localUrls);
	if (targets.ownerHostUrl !== null) others.delete(targets.ownerHostUrl);
	const urls = [
		...(targets.ownerHostUrl === null ? [] : [targets.ownerHostUrl]),
		...others,
	];
	if (urls.length === 0) return "unreachable";

	const replies = await Promise.all(
		urls.map(async (url): Promise<HostRetirementReply> => {
			try {
				return {
					kind: "answered",
					outcome: await getHostServiceClientByUrl(
						url,
					).claudeAccounts.retireWorkspaceRuntime.mutate({ workspaceId }),
				};
			} catch (error) {
				console.warn("[workspace-exit-cleanup] host retirement failed", {
					workspaceId,
					url,
					error,
				});
				// A host that RESPONDED with an error is reachable and broken, which
				// is a fault the user can retry. Only a request that never got a
				// response at all is the quiet "that machine is off" case.
				return isHostServiceConnectionError(error)
					? { kind: "unreachable" }
					: { kind: "failed" };
			}
		}),
	);
	const hasOwnerTarget = targets.ownerHostUrl !== null;
	return classifyRetirement({
		owner: hasOwnerTarget ? (replies[0] ?? null) : null,
		others: hasOwnerTarget ? replies.slice(1) : replies,
		absenceProven:
			targets.absenceAuthoritative &&
			replies.every((reply) => reply.kind === "answered"),
	});
}
