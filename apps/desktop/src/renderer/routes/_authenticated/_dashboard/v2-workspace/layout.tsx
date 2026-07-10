import { eq } from "@tanstack/db";
import { useLiveQuery } from "@tanstack/react-db";
import { createFileRoute, Outlet, useMatchRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef } from "react";
import { useDashboardSidebarState } from "renderer/routes/_authenticated/hooks/useDashboardSidebarState";
import { useCollections } from "renderer/routes/_authenticated/providers/CollectionsProvider";
import { useHostWorkspaces } from "renderer/routes/_authenticated/providers/HostWorkspacesProvider";
import { useWorkspaceTransactionsStore } from "renderer/stores/workspace-creates";
import { WorkspaceCreateErrorState } from "./components/WorkspaceCreateErrorState";
import { WorkspaceCreatingState } from "./components/WorkspaceCreatingState";
import { WorkspaceHostIncompatibleState } from "./components/WorkspaceHostIncompatibleState";
import { WorkspaceNotFoundState } from "./components/WorkspaceNotFoundState";
import { useRemoteHostStatus } from "./hooks/useRemoteHostStatus";
import { WorkspaceProvider } from "./providers/WorkspaceProvider";

// Diagnostic logging for the intermittent v2-workspace blank-pane bug.
// Emitted as "[agent-dots] ..." so the main-process console-message
// forwarder persists it to electron-log (main.log) in a shipped build.
// Logging-only — never alters behaviour. See patches/v2-workspace-blank-fix.patch.
function blankDbg(record: Record<string, unknown>): void {
	try {
		console.info(
			`[agent-dots] ${JSON.stringify({ ts: new Date().toISOString(), event: "v2_workspace_layout", ...record })}`,
		);
	} catch {
		// never let logging crash the renderer
	}
}

export const Route = createFileRoute("/_authenticated/_dashboard/v2-workspace")(
	{
		component: V2WorkspaceLayout,
	},
);

function V2WorkspaceLayout() {
	const matchRoute = useMatchRoute();
	const workspaceMatch = matchRoute({
		to: "/v2-workspace/$workspaceId",
	});
	const workspaceId =
		workspaceMatch !== false ? workspaceMatch.workspaceId : null;
	const collections = useCollections();
	const { ensureWorkspaceInSidebar } = useDashboardSidebarState();
	const pendingTransaction = useWorkspaceTransactionsStore((state) =>
		workspaceId ? (state.byWorkspaceId[workspaceId] ?? null) : null,
	);
	// The create transaction clears when the workspaces.create mutation
	// settles — not when the host-served row first arrives, which happens
	// mid-create before agent/terminal panes are seeded.
	const isCreatePending = pendingTransaction?.type === "insert";

	const { workspaces: hostWorkspaces, isReady } = useHostWorkspaces();
	const workspace = useMemo(
		() =>
			workspaceId != null
				? (hostWorkspaces.find((candidate) => candidate.id === workspaceId) ??
					null)
				: null,
		[hostWorkspaces, workspaceId],
	);
	const { data: failedEntries } = useLiveQuery(
		(q) =>
			q
				.from({ failed: collections.failedWorkspaceCreates })
				.where(({ failed }) => eq(failed.id, workspaceId ?? "")),
		[collections, workspaceId],
	);
	const failedEntry = failedEntries?.[0] ?? null;

	const lastEnsuredWorkspaceIdRef = useRef<string | null>(null);
	useEffect(() => {
		if (!workspace || lastEnsuredWorkspaceIdRef.current === workspace.id)
			return;
		lastEnsuredWorkspaceIdRef.current = workspace.id;
		ensureWorkspaceInSidebar(workspace.id, workspace.projectId);
	}, [ensureWorkspaceInSidebar, workspace]);

	// Cache-first hold (apps/desktop AGENTS.md rule 9): a transient Electric
	// re-sync can momentarily make the live query return undefined/empty with
	// isReady=false, which previously blanked an already-rendered workspace
	// (empty <div/>) until a manual reload. Keep the last resolved workspace
	// for the current id and reuse it through the transient so panes don't
	// blank. Ref write during render is a pure idempotent cache update.
	const lastResolvedWorkspaceRef = useRef<NonNullable<typeof workspace> | null>(
		null,
	);
	if (workspace && workspaceId) {
		lastResolvedWorkspaceRef.current = workspace;
	}
	const isTransient = !workspaces || !isReady;
	const heldWorkspace: typeof workspace =
		workspace ??
		(isTransient &&
		workspaceId &&
		lastResolvedWorkspaceRef.current?.id === workspaceId
			? lastResolvedWorkspaceRef.current
			: null);

	const hostStatus = useRemoteHostStatus(heldWorkspace);

	// Diagnostic: log the blank-relevant render decision once per transition
	// (not per render). Confirms which branch fires and whether the
	// cache-first hold engaged.
	const renderBranch = !workspaceId
		? "no-workspace-id"
		: !heldWorkspace && (!workspaces || (!workspace && !isReady))
			? "blank-data-not-ready"
			: !heldWorkspace
				? "not-found"
				: !workspace
					? "held-through-transient"
					: "ready";
	const lastLoggedBranchRef = useRef<string | null>(null);
	useEffect(() => {
		if (lastLoggedBranchRef.current === renderBranch) return;
		lastLoggedBranchRef.current = renderBranch;
		blankDbg({
			branch: renderBranch,
			workspaceId,
			hasWorkspacesData: !!workspaces,
			workspacesLength: workspaces?.length ?? null,
			hasWorkspace: !!workspace,
			hasHeld: !!heldWorkspace,
			isReady,
		});
	}, [renderBranch, workspaceId, workspaces, workspace, heldWorkspace, isReady]);

	if (
		!workspaceId ||
		(!heldWorkspace && (!workspaces || (!workspace && !isReady)))
	) {
		return <div className="flex h-full w-full" />;
	}

	if (!heldWorkspace) {
		if (failedEntry) {
			return <WorkspaceCreateErrorState entry={failedEntry} />;
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
			<Outlet />
		</WorkspaceProvider>
	);
}
