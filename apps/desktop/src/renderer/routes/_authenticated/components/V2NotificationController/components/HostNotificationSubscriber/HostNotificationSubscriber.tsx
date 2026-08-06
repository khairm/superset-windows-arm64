import type { WorkspaceState } from "@superset/panes";
import type {
	AgentLifecyclePayload,
	TerminalLifecyclePayload,
} from "@superset/workspace-client";
import { getEventBus } from "@superset/workspace-client";
import { useEffect, useEffectEvent, useMemo, useRef } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import {
	getHostServiceWsToken,
	refreshHostServiceSecrets,
} from "renderer/lib/host-service-auth";
import type { PaneViewerData } from "renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/types";
import {
	handleV2AgentLifecycleEvent,
	handleV2TerminalLifecycleEvent,
} from "../../lib/lifecycleEvents";
import { resyncAgentStatusFromHost } from "../../lib/resyncAgentStatus";

export interface HostNotificationWorkspaceState {
	workspaceId: string;
	workspaceName: string;
	paneLayout: WorkspaceState<PaneViewerData> | null;
}

/**
 * (BUS-RESYNC) One delayed retry per open. The realistic transient is a host
 * that accepted the WS upgrade a beat before its tRPC surface was reachable; a
 * host that dies again produces a fresh close/open pair, which re-arms the
 * resync on its own.
 */
const RESYNC_RETRY_MS = 10_000;

export function HostNotificationSubscriber({
	hostUrl,
	workspaces,
}: {
	hostUrl: string;
	workspaces: HostNotificationWorkspaceState[];
}): null {
	const { data: volume = 100 } =
		electronTrpc.settings.getNotificationVolume.useQuery();
	const { data: muted = false } =
		electronTrpc.settings.getNotificationSoundsMuted.useQuery();
	const workspacesById = useMemo(
		() =>
			new Map(
				workspaces.map((workspace) => [workspace.workspaceId, workspace]),
			),
		[workspaces],
	);
	// Which workspace set a resync covered. A reconnect that lands before the
	// workspace rows hydrate can only reconcile what it knows, so a later
	// hydration must be allowed to complete the job.
	const workspacesKey = useMemo(
		() => [...workspacesById.keys()].sort().join(","),
		[workspacesById],
	);
	const connectedRef = useRef(false);
	const openEpochRef = useRef(0);
	const syncedKeyRef = useRef<string | null>(null);
	const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const handleAgentLifecycle = useEffectEvent(
		(workspaceId: string, payload: AgentLifecyclePayload) => {
			const workspace = workspacesById.get(workspaceId);
			if (!workspace) return;
			handleV2AgentLifecycleEvent({
				workspaceId,
				workspaceName: workspace.workspaceName,
				payload,
				paneLayout: workspace.paneLayout,
				volume,
				muted,
			});
		},
	);

	const handleTerminalLifecycle = useEffectEvent(
		(workspaceId: string, payload: TerminalLifecyclePayload) => {
			const workspace = workspacesById.get(workspaceId);
			if (!workspace) return;
			handleV2TerminalLifecycleEvent({ payload });
		},
	);

	// (BUS-RESYNC) The seam. Every agent-lifecycle event the host broadcast
	// while this socket was down was destroyed — the bus keeps no queue — and a
	// blocked agent emits nothing further, so a lost red never returns on its
	// own. Reconcile against the host's durable truth whenever the socket opens,
	// and again if the workspace set grows while it is open.
	const runResync = useEffectEvent((workspaceSetKey: string) => {
		if (!connectedRef.current) return;
		const key = `${openEpochRef.current}:${workspaceSetKey}`;
		if (syncedKeyRef.current === key) return;
		syncedKeyRef.current = key;
		void resyncAgentStatusFromHost({
			hostUrl,
			workspaces: workspacesById,
		}).then((result) => {
			if (result !== null) return;
			// Fetch failed: nothing was reconciled and nothing was cleared.
			// Re-arm so the retry below (or a later reconnect) tries again.
			syncedKeyRef.current = null;
			if (retryTimerRef.current) return;
			retryTimerRef.current = setTimeout(() => {
				retryTimerRef.current = null;
				runResync(workspaceSetKey);
			}, RESYNC_RETRY_MS);
		});
	});

	const handleConnectionChange = useEffectEvent((connected: boolean) => {
		connectedRef.current = connected;
		if (!connected) {
			// A restarted host issues a new PSK; re-read it from the coordinator so
			// the next dial carries the current one instead of retrying a stale
			// secret until some unrelated render happens to refresh it.
			void refreshHostServiceSecrets();
			return;
		}
		openEpochRef.current++;
		runResync(workspacesKey);
	});

	useEffect(() => {
		const bus = getEventBus(hostUrl, () => getHostServiceWsToken(hostUrl));
		const removeAgentListener = bus.on(
			"agent:lifecycle",
			"*",
			handleAgentLifecycle,
		);
		const removeTerminalListener = bus.on(
			"terminal:lifecycle",
			"*",
			handleTerminalLifecycle,
		);
		const removeConnectionListener = bus.onConnectionChange(
			handleConnectionChange,
		);
		const release = bus.retain();
		// The socket is shared across all consumers of this host, so it may
		// already be open — in which case no "open" event is coming and this
		// mount would never reconcile.
		if (bus.isConnected()) handleConnectionChange(true);

		return () => {
			removeAgentListener();
			removeTerminalListener();
			removeConnectionListener();
			release();
			if (retryTimerRef.current) {
				clearTimeout(retryTimerRef.current);
				retryTimerRef.current = null;
			}
			connectedRef.current = false;
			syncedKeyRef.current = null;
		};
	}, [hostUrl]);

	// A workspace set that hydrated (or grew) after the socket opened.
	useEffect(() => {
		runResync(workspacesKey);
	}, [workspacesKey]);

	return null;
}
