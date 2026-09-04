import type { AppRouter } from "@superset/host-service";
import { createHostServiceLinks } from "@superset/workspace-client";
import { createTRPCClient, TRPCClientError } from "@trpc/client";
import type { ElectronTrpcUtils } from "./electron-trpc";
import {
	getHostServiceHeaders,
	setHostServiceSecret,
} from "./host-service-auth";

const clientCache = new Map<
	string,
	ReturnType<typeof createTRPCClient<AppRouter>>
>();

export type HostServiceClient = ReturnType<typeof createTRPCClient<AppRouter>>;

export function getHostServiceClient(port: number): HostServiceClient {
	return getHostServiceClientByUrl(`http://127.0.0.1:${port}`);
}

export function getHostServiceClientByUrl(hostUrl: string): HostServiceClient {
	const cached = clientCache.get(hostUrl);
	if (cached) return cached;

	const client = createTRPCClient<AppRouter>({
		links: createHostServiceLinks({
			url: `${hostUrl}/trpc`,
			headers: () => getHostServiceHeaders(hostUrl),
		}),
	});

	clientCache.set(hostUrl, client);
	return client;
}

/**
 * The URL of every running local host-service (one per org), with each one's
 * pre-shared key registered so `getHostServiceClientByUrl` can authenticate to
 * it. Broadcast calls use this when they hold no resolved URL for the host that
 * owns a workspace; each host answers for the workspaces it owns and no-ops for
 * the rest, so asking all of them is safe.
 *
 * URLs rather than clients so a caller that ALSO has a specific host to reach
 * (a remote owner, via `resolveHostUrl`) can union the two sets and address
 * each host exactly once — the client cache is keyed by URL, so equal URLs are
 * the same host.
 *
 * Returns null (not []) when the coordinator lookup FAILS — every caller must
 * distinguish "no hosts running" (safe: nothing to do) from "couldn't ask" (a
 * real failure that would otherwise masquerade as success).
 */
export async function getLocalHostServiceUrls(
	utils: ElectronTrpcUtils,
): Promise<string[] | null> {
	let connections: { port: number; secret: string }[];
	try {
		connections = await utils.hostServiceCoordinator.getConnections.fetch(
			undefined,
			{ staleTime: 0 },
		);
	} catch {
		return null;
	}
	return (connections ?? []).map(({ port, secret }) => {
		const url = `http://127.0.0.1:${port}`;
		setHostServiceSecret(url, secret);
		return url;
	});
}

const HOST_SERVICE_MAX_RETRIES = 3;
const HOST_SERVICE_RETRY_DELAY_MS = 700;

/**
 * True for a failed host-service request that never got a real response —
 * connection-refused during a restart, a dropped stream, DNS failure. tRPC
 * only populates `data` from a parsed server error envelope, so its absence
 * means the failure was transport-level rather than the server rejecting the
 * request (404, validation, etc.), which should never be retried here.
 */
export function isHostServiceConnectionError(error: unknown): boolean {
	return error instanceof TRPCClientError && error.data == null;
}

/**
 * Query-level `retry` for host-service requests: bounded retries with
 * backoff for connection-level failures only, so a query in flight during a
 * host-service restart self-heals instead of settling into a permanent
 * "Failed to fetch" that only a manual "Try again" click clears. Real
 * application errors (404s, validation) still fail on the first attempt.
 */
export function hostServiceQueryRetry(
	failureCount: number,
	error: unknown,
): boolean {
	return (
		isHostServiceConnectionError(error) &&
		failureCount < HOST_SERVICE_MAX_RETRIES
	);
}

export function hostServiceQueryRetryDelay(attempt: number): number {
	return HOST_SERVICE_RETRY_DELAY_MS * (attempt + 1);
}
