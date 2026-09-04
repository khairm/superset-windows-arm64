import { eq } from "@tanstack/db";
import { useLiveQuery } from "@tanstack/react-db";
import { createFileRoute, Outlet } from "@tanstack/react-router";
import { useEffect, useMemo, useRef } from "react";
import { useCloudWorkspaces } from "renderer/hooks/useCloudWorkspaces";
import { useV2UserPreferences } from "renderer/hooks/useV2UserPreferences";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useDashboardSidebarState } from "renderer/routes/_authenticated/hooks/useDashboardSidebarState";
import { useCollections } from "renderer/routes/_authenticated/providers/CollectionsProvider";
import { useHostWorkspaces } from "renderer/routes/_authenticated/providers/HostWorkspacesProvider";
import { useSandboxAccess } from "renderer/routes/_authenticated/providers/SandboxAccessProvider";
import { useWorkspaceTransactionsStore } from "renderer/stores/workspace-creates";
import { CloudWorkspaceProvisioningState } from "../components/CloudWorkspaceProvisioningState";
import { StateScreenShell } from "../components/StateScreenShell";
import { WorkspaceCreateErrorState } from "../components/WorkspaceCreateErrorState";
import { WorkspaceCreatingState } from "../components/WorkspaceCreatingState";
import { WorkspaceHostIncompatibleState } from "../components/WorkspaceHostIncompatibleState";
import { WorkspaceNotFoundState } from "../components/WorkspaceNotFoundState";
import { useRemoteHostStatus } from "../hooks/useRemoteHostStatus";
import { useWorkspaceMissVerdict } from "../hooks/useWorkspaceMissVerdict";
import { WorkspaceProvider } from "../providers/WorkspaceProvider";

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

export const Route = createFileRoute(
	"/_authenticated/_dashboard/v2-workspace/$workspaceId",
)({
	component: V2WorkspaceLayout,
});

function V2WorkspaceLayout() {
	// Owned by this segment, so the param is available by definition. This used
	// to live on the parent route, which had to match its own child to recover
	// the id and then render an empty shell for the "no id" case that route
	// could always reach and this one cannot.
	const { workspaceId } = Route.useParams();
	const collections = useCollections();
	const { placeWorkspaceFromPassiveMount } = useDashboardSidebarState();
	const pendingTransaction = useWorkspaceTransactionsStore((state) =>
		workspaceId ? (state.byWorkspaceId[workspaceId] ?? null) : null,
	);
	// The create transaction clears when the workspaces.create mutation
	// settles — not when the host-served row first arrives, which happens
	// mid-create before agent/terminal panes are seeded.
	const isCreatePending = pendingTransaction?.type === "insert";

	const { toggleShowPresetsBar } = useV2UserPreferences();
	electronTrpc.menu.subscribe.useSubscription(undefined, {
		onData: (event) => {
			if (event.type === "toggle-presets-bar") {
				toggleShowPresetsBar();
			}
		},
	});

	const {
		workspaces: hostWorkspaces,
		isReady,
		hostsSettled,
		cache,
	} = useHostWorkspaces();
	const workspace = useMemo(
		() =>
			workspaceId != null
				? (hostWorkspaces.find((candidate) => candidate.id === workspaceId) ??
					null)
				: null,
		[hostWorkspaces, workspaceId],
	);
	// The open workspace's sandbox joins the fan-out as its own host, so a
	// cloud workspace is found the same way as any other — but it has no
	// v2_hosts row for the remote version gate to check.
	const { targets: sandboxes } = useSandboxAccess();
	const isCloud = sandboxes.some(
		(sandbox) => sandbox.workspaceId === workspaceId,
	);
	// The cloud row exists from the moment the workspace is created, which is
	// well before there is a sandbox to serve it.
	const { workspaces: cloudWorkspaces } = useCloudWorkspaces();
	const cloudWorkspace =
		cloudWorkspaces.find((row) => row.id === workspaceId) ?? null;
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
		// (REMOVE-STICKY) passive mount — must not resurrect a removed project.
		placeWorkspaceFromPassiveMount(workspace.id, workspace.projectId);
	}, [placeWorkspaceFromPassiveMount, workspace]);

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
	// Host-served list is always an array (loading is signalled via isReady),
	// so "data absent" from the old live-query shape maps onto !isReady — PLUS
	// one gap isReady cannot see: v2Hosts transiently dropping a host's row
	// (Electric resync) removes that host's query target entirely, leaving
	// isReady's every() vacuously true while the host's rows are missing from
	// the merged list. resolveHostUrl(hostId) === null is precisely "no
	// reachable target for this host right now", so hold through that too
	// instead of flashing not-found on an open workspace.
	const heldCandidate =
		workspaceId && lastResolvedWorkspaceRef.current?.id === workspaceId
			? lastResolvedWorkspaceRef.current
			: null;
	const isTransient =
		!isReady ||
		(heldCandidate !== null &&
			cache.resolveHostUrl(heldCandidate.hostId) === null);
	const heldWorkspace: typeof workspace =
		workspace ?? (isTransient ? heldCandidate : null);

	// Sandboxes ship with the app's own host-service build, so the remote
	// version gate has nothing to check and no host row to check it against.
	const hostStatus = useRemoteHostStatus(isCloud ? null : heldWorkspace);

	// "Not found" is a verdict, not a cache read: a CLI-created workspace can
	// trail its own deep link (missed broadcast, second host-service instance,
	// stale boot snapshot), so the route forces a refetch and waits for it —
	// bounded — before declaring the id missing.
	const missConfirmed = useWorkspaceMissVerdict(
		{
			workspaceId,
			workspaceFound: heldWorkspace !== null,
			suspended: pendingTransaction !== null || failedEntry !== null,
			hostsEnumerated: hostsSettled,
			hasLiveTargets: cache.hasLiveTargets,
			mirrorSettled: isReady,
		},
		cache.refetchAll,
	);

	// Diagnostic: log the blank-relevant render decision once per transition
	// (not per render). Confirms which branch fires and whether the
	// cache-first hold engaged.
	const renderBranch = !workspaceId
		? "no-workspace-id"
		: heldWorkspace
			? workspace
				? "ready"
				: "held-through-transient"
			: cloudWorkspace
				? "cloud-provisioning"
				: failedEntry
					? "create-error"
					: missConfirmed
						? "not-found"
						: "blank-data-not-ready";
	const lastLoggedBranchRef = useRef<string | null>(null);
	useEffect(() => {
		if (lastLoggedBranchRef.current === renderBranch) return;
		lastLoggedBranchRef.current = renderBranch;
		blankDbg({
			branch: renderBranch,
			workspaceId,
			hasWorkspacesData: hostWorkspaces.length > 0,
			workspacesLength: hostWorkspaces.length,
			hasWorkspace: !!workspace,
			hasHeld: !!heldWorkspace,
			isReady,
		});
	}, [
		renderBranch,
		workspaceId,
		hostWorkspaces,
		workspace,
		heldWorkspace,
		isReady,
	]);

	// Before "not found": a cloud workspace is navigated to as soon as its row
	// exists, so for the first seconds of its life there is nothing in the
	// fan-out to find. The same screen covers a ready sandbox that hasn't been
	// addressed yet (access minting, host-service booting) — that gap used to
	// be a blank frame, and letting it reach the host-unreachable takeover
	// would tell the user their machine is down while it is simply starting.
	if (!heldWorkspace && cloudWorkspace) {
		return (
			<StateScreenShell>
				<CloudWorkspaceProvisioningState
					workspaceId={cloudWorkspace.id}
					name={cloudWorkspace.name}
					branch={cloudWorkspace.branch}
					status={cloudWorkspace.status}
				/>
			</StateScreenShell>
		);
	}

	if (!heldWorkspace) {
		if (failedEntry) {
			return (
				<StateScreenShell>
					<WorkspaceCreateErrorState entry={failedEntry} />
				</StateScreenShell>
			);
		}
		if (!missConfirmed) {
			return <StateScreenShell>{null}</StateScreenShell>;
		}
		return (
			<StateScreenShell>
				<WorkspaceNotFoundState workspaceId={workspaceId} />
			</StateScreenShell>
		);
	}

	if (isCreatePending) {
		return (
			<StateScreenShell>
				<WorkspaceCreatingState
					name={heldWorkspace.name}
					branch={heldWorkspace.branch}
					startedAt={new Date(heldWorkspace.createdAt).getTime()}
					isSession={heldWorkspace.type === "session"}
				/>
			</StateScreenShell>
		);
	}

	if (!isCloud) {
		if (hostStatus.status === "incompatible") {
			return (
				<StateScreenShell>
					<WorkspaceHostIncompatibleState
						hostName={hostStatus.hostName}
						hostVersion={hostStatus.hostVersion}
						minVersion={hostStatus.minVersion}
					/>
				</StateScreenShell>
			);
		}
		if (hostStatus.status === "loading") {
			return <StateScreenShell>{null}</StateScreenShell>;
		}
	}

	return (
		<WorkspaceProvider workspace={heldWorkspace}>
			<Outlet />
		</WorkspaceProvider>
	);
}
