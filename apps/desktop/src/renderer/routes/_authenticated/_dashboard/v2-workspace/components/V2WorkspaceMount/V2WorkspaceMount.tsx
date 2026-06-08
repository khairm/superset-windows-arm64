import { eq } from "@tanstack/db";
import { useLiveQuery } from "@tanstack/react-db";
import { useEffect, useRef } from "react";
import { useDashboardSidebarState } from "renderer/routes/_authenticated/hooks/useDashboardSidebarState";
import { useCollections } from "renderer/routes/_authenticated/providers/CollectionsProvider";
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
export function V2WorkspaceMount({ workspaceId }: V2WorkspaceMountProps) {
	const collections = useCollections();
	const { ensureWorkspaceInSidebar } = useDashboardSidebarState();
	const pendingTransaction = useWorkspaceTransactionsStore(
		(state) => state.byWorkspaceId[workspaceId] ?? null,
	);
	const clearWorkspaceTransaction = useWorkspaceTransactionsStore(
		(state) => state.clear,
	);
	const isCreatePending = pendingTransaction?.type === "insert";

	const { data: workspaces, isReady } = useLiveQuery(
		(q) =>
			q
				.from({ v2Workspaces: collections.v2Workspaces })
				.where(({ v2Workspaces }) => eq(v2Workspaces.id, workspaceId)),
		[collections, workspaceId],
	);
	const { data: failedEntries } = useLiveQuery(
		(q) =>
			q
				.from({ failed: collections.failedWorkspaceCreates })
				.where(({ failed }) => eq(failed.id, workspaceId)),
		[collections, workspaceId],
	);
	const workspace = workspaces?.[0] ?? null;
	const failedEntry = failedEntries?.[0] ?? null;

	useEffect(() => {
		if (workspace?.$synced === true && pendingTransaction?.type === "insert") {
			clearWorkspaceTransaction(workspace.id);
		}
	}, [clearWorkspaceTransaction, pendingTransaction, workspace]);

	const lastEnsuredWorkspaceIdRef = useRef<string | null>(null);
	useEffect(() => {
		if (!workspace || lastEnsuredWorkspaceIdRef.current === workspace.id) return;
		lastEnsuredWorkspaceIdRef.current = workspace.id;
		ensureWorkspaceInSidebar(workspace.id, workspace.projectId);
	}, [ensureWorkspaceInSidebar, workspace]);

	const hostStatus = useRemoteHostStatus(workspace);

	if (!workspaces || (!workspace && !isReady)) {
		return <div className="flex h-full w-full" />;
	}

	if (!workspace) {
		if (failedEntry) {
			return <WorkspaceCreateErrorState entry={failedEntry} />;
		}
		return <WorkspaceNotFoundState workspaceId={workspaceId} />;
	}

	if (isCreatePending) {
		return (
			<WorkspaceCreatingState
				name={workspace.name}
				branch={workspace.branch}
				startedAt={new Date(workspace.createdAt).getTime()}
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
		<WorkspaceProvider workspace={workspace}>
			<V2WorkspaceView />
		</WorkspaceProvider>
	);
}
