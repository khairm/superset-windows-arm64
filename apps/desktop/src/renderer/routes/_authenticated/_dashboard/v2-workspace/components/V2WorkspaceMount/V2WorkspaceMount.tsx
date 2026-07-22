import { eq } from "@tanstack/db";
import { useLiveQuery } from "@tanstack/react-db";
import { type ReactNode, useEffect, useMemo, useRef } from "react";
import { useDashboardSidebarState } from "renderer/routes/_authenticated/hooks/useDashboardSidebarState";
import { useCollections } from "renderer/routes/_authenticated/providers/CollectionsProvider";
import { useHostWorkspaces } from "renderer/routes/_authenticated/providers/HostWorkspacesProvider";
import { useWorkspaceTransactionsStore } from "renderer/stores/workspace-creates";
import { V2WorkspaceView } from "../../$workspaceId/components/V2WorkspaceView";
import { useRemoteHostStatus } from "../../hooks/useRemoteHostStatus";
import { WorkspaceProvider } from "../../providers/WorkspaceProvider";
import { WorkspaceCreateErrorState } from "../WorkspaceCreateErrorState";
import { WorkspaceCreatingState } from "../WorkspaceCreatingState";
import { WorkspaceHostIncompatibleState } from "../WorkspaceHostIncompatibleState";
import { WorkspaceNotFoundState } from "../WorkspaceNotFoundState";

interface V2WorkspaceMountProps {
	workspaceId: string;
	/** (KANBAN) Forwarded to the tab bar's trailing slot (e.g. Board button). */
	tabBarTrailingExtra?: ReactNode;
}

/**
 * Mounts the full workspace centre for an arbitrary workspaceId OUTSIDE the
 * /v2-workspace route — used by the Kanban collapse-split. Mirrors the route
 * layout's resolution + guards (not-found / create-pending / host-incompatible)
 * and provides the WorkspaceProvider, then renders the shared <V2WorkspaceView/>.
 *
 * Only one of these is mounted at a time (the split renders exactly one, keyed
 * by workspaceId), so the global #workspace-right-sidebar-slot portal that
 * V2WorkspaceView claims always has a single owner.
 */
export function V2WorkspaceMount({
	workspaceId,
	tabBarTrailingExtra,
}: V2WorkspaceMountProps) {
	const collections = useCollections();
	const { placeWorkspaceFromPassiveMount } = useDashboardSidebarState();
	// The create transaction clears ITSELF when the tracked `completed` promise
	// resolves (pane layout written) — see useWorkspaceCreates. Never clear it
	// from here: the row appears in the host query cache optimistically (and via
	// the mid-create workspace:changed broadcast) with source "host" long before
	// the worktree/panes exist.
	const pendingTransaction = useWorkspaceTransactionsStore(
		(state) => state.byWorkspaceId[workspaceId] ?? null,
	);
	const isCreatePending = pendingTransaction?.type === "insert";

	// (KANBAN HOST SOURCE) Mirrors the /v2-workspace route layout: the workspace
	// resolves from the host-served lists (with a hold through transient host
	// unreachability), not the dead Electric mirror.
	const {
		workspaces: hostWorkspaces,
		isReady,
		isAbsenceAuthoritative,
		cache,
	} = useHostWorkspaces();
	const workspace = useMemo(
		() =>
			hostWorkspaces.find((candidate) => candidate.id === workspaceId) ?? null,
		[hostWorkspaces, workspaceId],
	);
	const { data: failedEntries } = useLiveQuery(
		(q) =>
			q
				.from({ failed: collections.failedWorkspaceCreates })
				.where(({ failed }) => eq(failed.id, workspaceId)),
		[collections, workspaceId],
	);
	const failedEntry = failedEntries?.[0] ?? null;

	const lastEnsuredWorkspaceIdRef = useRef<string | null>(null);
	useEffect(() => {
		if (!workspace || lastEnsuredWorkspaceIdRef.current === workspace.id)
			return;
		lastEnsuredWorkspaceIdRef.current = workspace.id;
		// (REMOVE-STICKY) passive mount — must not resurrect a removed project.
		placeWorkspaceFromPassiveMount(workspace.id, workspace.projectId);
	}, [placeWorkspaceFromPassiveMount, workspace]);

	// Hold the last-resolved row through a transient miss (unready merge, or the
	// owning host momentarily unreachable) — same rule as the route layout.
	const lastResolvedWorkspaceRef = useRef<NonNullable<typeof workspace> | null>(
		null,
	);
	if (workspace) {
		lastResolvedWorkspaceRef.current = workspace;
	}
	const heldCandidate =
		lastResolvedWorkspaceRef.current?.id === workspaceId
			? lastResolvedWorkspaceRef.current
			: null;
	const isTransient =
		!isReady ||
		(heldCandidate !== null &&
			cache.resolveHostUrl(heldCandidate.hostId) === null);
	const heldWorkspace: typeof workspace =
		workspace ?? (isTransient ? heldCandidate : null);

	const hostStatus = useRemoteHostStatus(heldWorkspace);

	if (!heldWorkspace && !workspace && !isReady) {
		return <div className="flex h-full w-full" />;
	}

	if (!heldWorkspace) {
		if (failedEntry) {
			return <WorkspaceCreateErrorState entry={failedEntry} />;
		}
		// Not-found is a destructive verdict for an embedded mount (the split
		// exits on it) — only render it once absence is authoritative for the
		// row's OWNING host (known from the held candidate; global gate before
		// it's known). An errored/unreachable host merely means "unknown":
		// hold blank until authority returns.
		if (!isAbsenceAuthoritative(heldCandidate?.hostId ?? null)) {
			return <div className="flex h-full w-full" />;
		}
		return <WorkspaceNotFoundState workspaceId={workspaceId} />;
	}

	if (isCreatePending) {
		return (
			<WorkspaceCreatingState
				name={heldWorkspace.name}
				branch={heldWorkspace.branch}
				startedAt={new Date(heldWorkspace.createdAt).getTime()}
			/>
		);
	}

	if (hostStatus.status === "incompatible") {
		return (
			<WorkspaceHostIncompatibleState
				hostName={hostStatus.hostName}
				hostVersion={hostStatus.hostVersion}
				minVersion={hostStatus.minVersion}
			/>
		);
	}
	if (hostStatus.status === "loading") {
		return <div className="flex h-full w-full" />;
	}

	return (
		<WorkspaceProvider workspace={heldWorkspace}>
			<V2WorkspaceView tabBarTrailingExtra={tabBarTrailingExtra} />
		</WorkspaceProvider>
	);
}
