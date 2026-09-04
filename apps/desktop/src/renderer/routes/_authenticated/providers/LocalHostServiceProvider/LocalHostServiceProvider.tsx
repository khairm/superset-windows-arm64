import { reconnectEventBusIfDown } from "@superset/workspace-client";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
} from "react";
import { useActiveOrganizationId } from "renderer/lib/local-identity";
import { authClient } from "renderer/lib/auth-client";
import { electronTrpc } from "renderer/lib/electron-trpc";
import {
	setClientMachineId,
	setClientUserId,
	setHostServiceSecret,
} from "renderer/lib/host-service-auth";
import type { HostServiceAvailabilityStatus } from "renderer/lib/host-service-unavailable";

interface LocalHostServiceContextValue {
	machineId: string;
	activeHostUrl: string | null;
	activeOrganizationId: string | null;
	activeOrganizationName: string | null;
	hostServiceStatus: HostServiceAvailabilityStatus;
	/**
	 * Resolve once the local host service is live, returning its loopback URL
	 * (or null on timeout). Use this at the point of a host-backed action so
	 * local-first UI can act immediately without gating on `activeHostUrl`.
	 */
	waitForHostReady: (timeoutMs?: number) => Promise<string | null>;
}

const LocalHostServiceContext =
	createContext<LocalHostServiceContextValue | null>(null);

export function LocalHostServiceProvider({
	children,
}: {
	children: ReactNode;
}) {
	const utils = electronTrpc.useUtils();
	const { data: activeOrganization } = authClient.useActiveOrganization();
	// Session still owns who is signed in; only the ACTIVE org is frozen locally.
	const { data: session } = authClient.useSession();

	// (CLOUD-SEVERANCE-P2) The frozen local organization. Upstream derived this
	// from the cloud session and then pushed the membership back down to main
	// through a compare-and-swap, because a session could change accounts
	// mid-run and the host-service had to be told. Neither half survives: the
	// organization is resolved from disk by main BEFORE this window exists, and
	// nothing can change it while the app runs, so the renderer has nothing to
	// teach the main process about who it is.
	const activeOrganizationId = useActiveOrganizationId();

	const { data: machineIdData } = electronTrpc.device.getMachineId.useQuery(
		undefined,
		{ staleTime: Number.POSITIVE_INFINITY },
	);

	useEffect(() => {
		if (machineIdData?.machineId) {
			setClientMachineId(machineIdData.machineId);
		}
	}, [machineIdData]);

	const sessionUserId = session?.user.id ?? null;
	useEffect(() => {
		setClientUserId(sessionUserId);
		return () => setClientUserId(null);
	}, [sessionUserId]);

	const { data: activeConnection } =
		electronTrpc.hostServiceCoordinator.getConnection.useQuery(
			{ organizationId: activeOrganizationId as string },
			{ enabled: !!activeOrganizationId, refetchInterval: 5_000 },
		);

	const { data: processStatus } =
		electronTrpc.hostServiceCoordinator.getProcessStatus.useQuery(
			{ organizationId: activeOrganizationId as string },
			{
				enabled: !!activeOrganizationId,
				refetchInterval: activeConnection?.port ? false : 1_000,
			},
		);

	// The coordinator only emits "running" after its health check passes, so
	// this closes the gap the 5s/1s polls above leave open: without it, a
	// dev-mode restart (or any respawn) can land the renderer on a dead port
	// for up to a full poll interval, and anything that queries host-service
	// in that window fails with a connection-refused.
	electronTrpc.hostServiceCoordinator.onStatusChange.useSubscription(
		undefined,
		{
			onData: (event) => {
				if (event.organizationId !== activeOrganizationId) return;
				utils.hostServiceCoordinator.getConnection.invalidate();
				utils.hostServiceCoordinator.getProcessStatus.invalidate();
			},
		},
	);

	// Fires on the null → connection edge after a restart (during downtime
	// getConnection reports null, and react-query's structural sharing keeps an
	// unchanged connection referentially stable). The event bus for this URL is
	// on its own backoff and its next scheduled dial is seconds out — without a
	// nudge the workspace sits under "Host unreachable" after the service is
	// back. The secret is already in place: the context memo below stores it
	// during the same render, before any effect runs.
	useEffect(() => {
		if (!activeConnection?.port) return;
		reconnectEventBusIfDown(`http://127.0.0.1:${activeConnection.port}`);
	}, [activeConnection]);

	const waitForHostReady = useCallback(
		async (timeoutMs = 20_000): Promise<string | null> => {
			const orgId = activeOrganizationId;
			if (!orgId) return null;
			// Resolve the live host URL if a port is up, else null. Swallows
			// transient IPC/tRPC fetch failures so a poll error never rejects the
			// nullable contract callers rely on.
			const tryGetHostUrl = async (): Promise<string | null> => {
				try {
					const connection =
						await utils.hostServiceCoordinator.getConnection.fetch({
							organizationId: orgId,
						});
					if (connection?.port) {
						const hostUrl = `http://127.0.0.1:${connection.port}`;
						if (connection.secret)
							setHostServiceSecret(hostUrl, connection.secret);
						return hostUrl;
					}
				} catch (error) {
					console.warn("[host-service] connection poll failed:", error);
				}
				return null;
			};
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				const hostUrl = await tryGetHostUrl();
				if (hostUrl) return hostUrl;
				await new Promise((resolve) => setTimeout(resolve, 1_000));
			}
			// Final check: the last start may have brought the host up during the
			// trailing sleep, after the deadline elapsed.
			return await tryGetHostUrl();
		},
		[activeOrganizationId, utils],
	);

	const activeOrganizationName = activeOrganization?.name ?? null;

	const value = useMemo<LocalHostServiceContextValue | null>(() => {
		if (!machineIdData) return null;
		const machineId = machineIdData.machineId;
		const hostServiceStatus: HostServiceAvailabilityStatus =
			activeConnection?.port != null
				? "running"
				: (processStatus?.status ?? "unknown");

		if (!activeConnection?.port) {
			return {
				machineId,
				activeHostUrl: null,
				activeOrganizationId: activeOrganizationId ?? null,
				activeOrganizationName,
				hostServiceStatus,
				waitForHostReady,
			};
		}

		const activeHostUrl = `http://127.0.0.1:${activeConnection.port}`;
		if (activeConnection.secret) {
			setHostServiceSecret(activeHostUrl, activeConnection.secret);
		}

		return {
			machineId,
			activeHostUrl,
			activeOrganizationId: activeOrganizationId ?? null,
			activeOrganizationName,
			hostServiceStatus,
			waitForHostReady,
		};
	}, [
		machineIdData,
		activeConnection,
		activeOrganizationId,
		activeOrganizationName,
		processStatus?.status,
		waitForHostReady,
	]);

	if (!value) return null;

	return (
		<LocalHostServiceContext.Provider value={value}>
			{children}
		</LocalHostServiceContext.Provider>
	);
}

export function useLocalHostService(): LocalHostServiceContextValue {
	const context = useContext(LocalHostServiceContext);
	if (!context) {
		throw new Error(
			"useLocalHostService must be used within LocalHostServiceProvider",
		);
	}
	return context;
}
