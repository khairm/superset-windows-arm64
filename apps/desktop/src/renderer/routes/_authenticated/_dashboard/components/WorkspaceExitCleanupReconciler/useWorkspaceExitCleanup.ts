import { toast } from "@superset/ui/sonner";
import { peekConnectionStatus } from "@superset/workspace-client";
import { isNull, not } from "@tanstack/db";
import { useLiveQuery } from "@tanstack/react-db";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { getLocalHostServiceUrls } from "renderer/lib/host-service-client";
import {
	decideCleanupOutcome,
	describeCleanupToast,
	isCleanupStampCurrent,
	type RetirementVerdict,
	resolveRetirementCallUrl,
	retireWorkspaceRuntime,
} from "renderer/lib/workspace-exit-cleanup";
import { useCollections } from "renderer/routes/_authenticated/providers/CollectionsProvider";
import { waitForWorkspaceExitPersistence } from "renderer/routes/_authenticated/providers/CollectionsProvider/workspaceExitPersistence";
import { useHostWorkspaces } from "renderer/routes/_authenticated/providers/HostWorkspacesProvider";
import {
	cleanupRoutingKey,
	createSweepQueue,
	localHostFingerprint,
} from "./cleanupTriggers";
import { useHostReopenGeneration } from "./useHostReopenGeneration";

/** One standing toast for the whole feature, so a sweep can't stack five. */
const CLEANUP_TOAST_ID = "workspace-exit-cleanup";

/** Where a pending workspace's retirement call has to be sent. */
interface CleanupTarget {
	/** The owning host's URL, or null while that owner is unreachable. */
	ownerHostUrl: string | null;
	/** The owner is a cloud sandbox: reachable, but never worth waking. */
	isSandbox: boolean;
	/** The workspace's absence from the host lists proves it is gone. */
	absenceAuthoritative: boolean;
}

/**
 * (WORKTREE-EXIT-CLEANUP) Drives the HOST half of exiting a card. Completed,
 * Archive, Snooze and Recycle Bin clear the renderer's tabs and terminals
 * synchronously and stamp `runtimeCleanupPendingAt`; this hook is what turns
 * that stamp into the host call that kills the terminal sessions and releases
 * the workspace's pinned Claude account.
 *
 * Keeping the stamp in persisted local state rather than firing and forgetting
 * is the whole point: the owning machine may be off at the moment the user
 * archives a thread, and the debt has to outlive both that outage and the app.
 * The sweep therefore re-runs on mount (app restart), when a local host-service
 * appears or is replaced, and when an owning host's socket comes back up. The
 * stamp is cleared ONLY when a host that OWNS the workspace reports a clean
 * teardown, or when the workspace is authoritatively gone.
 *
 * One sweep runs at a time. A trigger that lands mid-sweep queues exactly one
 * rerun for after it settles, rather than being dropped as a duplicate — a
 * reconnect arriving while an attempt is still failing against the old socket
 * is precisely the trigger that must not be lost.
 */
export function useWorkspaceExitCleanup(): void {
	const collections = useCollections();
	const utils = electronTrpc.useUtils();
	const { workspaces, cache, isAbsenceAuthoritative } = useHostWorkspaces();
	const { data: connections } =
		electronTrpc.hostServiceCoordinator.getConnections.useQuery();

	const { data: pendingRows = [], isReady } = useLiveQuery(
		(query) =>
			query
				.from({ state: collections.v2WorkspaceLocalState })
				.where(({ state }) =>
					not(isNull(state.sidebarState.runtimeCleanupPendingAt)),
				)
				.select(({ state }) => ({ workspaceId: state.workspaceId })),
		[collections],
	);

	// useLiveQuery hands back a new array every tick; collapse it to a value the
	// effect can compare, or the sweep would re-fire on every unrelated render.
	const pendingKey = pendingRows
		.map((row) => row.workspaceId)
		.sort()
		.join(",");
	const pendingWorkspaceIds = useMemo(
		() => (pendingKey === "" ? [] : pendingKey.split(",")),
		[pendingKey],
	);

	// Where each pending workspace has to be reached, resolved the same way
	// every other cross-host call resolves a host, plus the two things the
	// triggers below read off the same pass. A null URL means the owning host
	// has not resolved — it is offline, or its row has not hydrated — and only
	// the local broadcast can find it.
	const { targets, hasOwnerTarget, routingKey, reopenUrls } = useMemo(() => {
		const resolved = new Map<string, CleanupTarget>();
		const reachable: string[] = [];
		// No debt, no routing to work out — and no reason to walk every workspace
		// the window knows about to find that out.
		if (pendingWorkspaceIds.length === 0) {
			return {
				targets: resolved,
				hasOwnerTarget: false,
				routingKey: "",
				reopenUrls: reachable,
			};
		}
		const hostIds = new Map(
			workspaces.map((workspace) => [workspace.id, workspace.hostId] as const),
		);
		let owned = false;
		for (const workspaceId of pendingWorkspaceIds) {
			const hostId = hostIds.get(workspaceId) ?? null;
			const ownerHostUrl =
				hostId === null ? null : cache.resolveHostUrl(hostId);
			const isSandbox = hostId !== null && cache.isSandboxHost(hostId);
			resolved.set(workspaceId, {
				ownerHostUrl,
				isSandbox,
				// Only asked when no host claims the workspace at all: a row that
				// is absent from every host that answered, with no unanswered host
				// left to be hiding it, is a workspace that no longer exists. The
				// active org is the right scope for that judgement because the
				// collection holding these rows is itself per-org (storage key
				// `v2-workspace-local-state-${organizationId}`), so a pending row
				// can only ever belong to the org this window is in.
				absenceAuthoritative:
					!hostIds.has(workspaceId) && isAbsenceAuthoritative(null),
			});
			if (ownerHostUrl === null) continue;
			owned = true;
			// Sandboxes are deliberately excluded: subscribing holds their VM awake.
			if (!isSandbox) reachable.push(ownerHostUrl);
		}
		return {
			targets: resolved,
			hasOwnerTarget: owned,
			routingKey: cleanupRoutingKey(resolved),
			reopenUrls: reachable,
		};
	}, [pendingWorkspaceIds, workspaces, cache, isAbsenceAuthoritative]);

	// The sweep reads targets through a ref so a Retry click (and a sweep already
	// running) always uses the CURRENT routing rather than whatever was resolved
	// when the toast was raised.
	const targetsRef = useRef(targets);
	targetsRef.current = targets;
	const pendingIdsRef = useRef(pendingWorkspaceIds);
	pendingIdsRef.current = pendingWorkspaceIds;

	// The secret, not just the port: a host-service restart reuses its preferred
	// port and mints a fresh secret, so a ports-only key would miss the one
	// event most likely to make a stuck cleanup work — the local host coming
	// back. The URL is stable across that restart by design.
	const localHostKey = localHostFingerprint(connections);
	const reopenGeneration = useHostReopenGeneration(reopenUrls);

	const sweepRef = useRef<(ids: readonly string[]) => Promise<void>>(
		async () => {},
	);

	const runSweep = useCallback(
		async (workspaceIds: readonly string[]) => {
			// Enumerated once for the whole sweep: the same set of local hosts
			// answers for every workspace in it.
			const localUrlsPromise = getLocalHostServiceUrls(utils);
			const persistedRows = await Promise.all(
				workspaceIds.map(async (workspaceId) => {
					const stampBefore = readCleanupStamp(collections, workspaceId);
					if (stampBefore === null) return null;
					const isPersisted = await waitForWorkspaceExitPersistence(
						collections.activeOrganizationId,
						workspaceId,
						stampBefore,
					);
					return isPersisted ? { workspaceId, stampBefore } : null;
				}),
			);
			const localUrls = await localUrlsPromise;
			if (localUrls === null) {
				console.warn(
					"[workspace-exit-cleanup] could not enumerate local hosts to retire runtime",
					{ workspaceIds },
				);
			}
			const verdicts = new Map<string, RetirementVerdict>();
			await Promise.all(
				persistedRows.map(async (persistedRow) => {
					if (persistedRow === null) return;
					const { workspaceId, stampBefore } = persistedRow;
					if (
						!isCleanupStampCurrent(
							stampBefore,
							readCleanupStamp(collections, workspaceId),
						)
					) {
						return;
					}
					const target = targetsRef.current.get(workspaceId);
					const verdict = await retireWorkspaceRuntime(workspaceId, {
						localUrls: localUrls ?? [],
						// Resolved HERE rather than in the memo above, because whether a
						// sandbox is awake is a live fact: the user may have opened that
						// cloud workspace since the routing was worked out.
						ownerHostUrl:
							target === undefined
								? null
								: resolveRetirementCallUrl({
										ownerHostUrl: target.ownerHostUrl,
										isSandbox: target.isSandbox,
										isAwake: isHostSocketOpen(target.ownerHostUrl),
									}),
						// Only a complete local enumeration can prove absence: a host
						// we never listed is a host that could still own the row.
						absenceAuthoritative:
							localUrls !== null && target?.absenceAuthoritative === true,
					});
					verdicts.set(workspaceId, verdict);
					const outcome = decideCleanupOutcome({
						stampBefore,
						stampAfter: readCleanupStamp(collections, workspaceId),
						verdict,
					});
					if (outcome !== "clear") return;
					collections.v2WorkspaceLocalState.update(workspaceId, (draft) => {
						draft.sidebarState.runtimeCleanupPendingAt = null;
					});
				}),
			);
			showCleanupToast(collections, pendingIdsRef.current, verdicts, () => {
				void sweepRef.current(pendingIdsRef.current);
			});
		},
		[collections, utils],
	);

	// One sweep at a time, with at most one rerun queued behind it. Skipping a
	// trigger outright (the old per-workspace in-flight dedupe) loses exactly the
	// reconnect that arrives while the pre-reconnect attempt is still failing.
	const sweep = useMemo(
		() => createSweepQueue(runSweep, () => pendingIdsRef.current),
		[runSweep],
	);
	sweepRef.current = sweep;

	// No debt, no toast. This is the rule that stops a toast outliving the thing
	// it describes: un-exiting the last failing workspace empties the pending set
	// without any sweep having to complete.
	useEffect(() => {
		if (isReady && pendingWorkspaceIds.length === 0) {
			toast.dismiss(CLEANUP_TOAST_ID);
		}
	}, [isReady, pendingWorkspaceIds]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: reopenGeneration and routingKey are triggers — the sweep reads nothing from either, so an owner's socket coming back (the counter) or a LATER owner resolving to a URL (the key) reaches this effect only through the dependency list
	useEffect(() => {
		if (!isReady || pendingWorkspaceIds.length === 0) return;
		// Nothing is reachable: no local host-service is running and no pending
		// workspace's owner resolved to a URL. Sweeping would only raise a toast
		// about an outage the user can already see; a host arriving changes one of
		// these triggers, which is exactly when the retry should fire.
		if (localHostKey === "" && !hasOwnerTarget) return;
		void sweep(pendingWorkspaceIds);
	}, [
		isReady,
		pendingWorkspaceIds,
		localHostKey,
		reopenGeneration,
		hasOwnerTarget,
		routingKey,
		sweep,
	]);
}

/**
 * (WORKTREE-EXIT-CLEANUP) Raise, replace or dismiss the standing toast from
 * what is STILL owed, read back off the rows rather than from the sweep's own
 * bookkeeping. A sweep may cover a subset (the Retry button re-runs only what
 * failed) and rows can be exited or restored while it runs, so its result set
 * is not the debt — the rows are.
 */
function showCleanupToast(
	collections: ReturnType<typeof useCollections>,
	pendingWorkspaceIds: readonly string[],
	verdicts: ReadonlyMap<string, RetirementVerdict>,
	onRetry: () => void,
): void {
	let blocked = 0;
	let waiting = 0;
	for (const workspaceId of pendingWorkspaceIds) {
		if (readCleanupStamp(collections, workspaceId) === null) continue;
		// A row this sweep never reached is a wait, not a fault.
		if (verdicts.get(workspaceId) === "owner-failed") blocked++;
		else waiting++;
	}
	const content = describeCleanupToast({ blocked, waiting });
	if (content === null) {
		toast.dismiss(CLEANUP_TOAST_ID);
		return;
	}
	toast.error(content.title, {
		id: CLEANUP_TOAST_ID,
		description: content.description,
		duration: Number.POSITIVE_INFINITY,
		action: { label: "Retry", onClick: onRetry },
	});
}

/**
 * Is somebody ALREADY holding this host's socket open? Asked with
 * `peekConnectionStatus`, which never dials — the sweep must not be the thing
 * that wakes a sleeping cloud sandbox.
 */
function isHostSocketOpen(hostUrl: string | null): boolean {
	if (hostUrl === null) return false;
	return peekConnectionStatus(hostUrl)?.state === "open";
}

function readCleanupStamp(
	collections: ReturnType<typeof useCollections>,
	workspaceId: string,
): number | null {
	return (
		collections.v2WorkspaceLocalState.get(workspaceId)?.sidebarState
			.runtimeCleanupPendingAt ?? null
	);
}
