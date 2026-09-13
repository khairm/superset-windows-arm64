import { SUPERSET_USER_ID_HEADER } from "@superset/shared/host-routing";
import { getJwt } from "./auth-client";
import { electronTrpcClient } from "./trpc-client";

/**
 * The bearer a host accepts, by URL. A local host-service takes its
 * pre-shared secret; a cloud workspace's takes the short-lived token
 * `cloudWorkspace.access` signs for that one sandbox — brokered and expiring,
 * so it is held per URL rather than baked into the client, and re-set on
 * every re-mint. Anything else (a relay-reached host) authenticates with the
 * user's JWT.
 */
const secrets = new Map<string, string>();

let clientMachineId: string | null = null;
let clientUserId: string | null = null;

export function setClientMachineId(machineId: string): void {
	clientMachineId = machineId;
}

/**
 * The signed-in user, sent on every host-service call so the host can stamp
 * `createdByUserId` on what this client creates. A local host trusts it
 * because the caller holds its secret; the relay replaces it with the JWT
 * subject before a remote host ever sees it.
 */
export function setClientUserId(userId: string | null): void {
	clientUserId = userId;
}

export function setHostServiceSecret(hostUrl: string, secret: string): void {
	secrets.set(hostUrl, secret);
}

export function removeHostServiceSecret(hostUrl: string): void {
	secrets.delete(hostUrl);
}

export function getHostServiceHeaders(hostUrl: string): Record<string, string> {
	const headers: Record<string, string> = clientMachineId
		? { "x-superset-client-machine-id": clientMachineId }
		: {};
	if (clientUserId) headers[SUPERSET_USER_ID_HEADER] = clientUserId;
	const secret = secrets.get(hostUrl);
	if (secret) {
		headers.Authorization = `Bearer ${secret}`;
		return headers;
	}
	// Relay: use JWT
	const jwt = getJwt();
	if (jwt) headers.Authorization = `Bearer ${jwt}`;
	return headers;
}

/**
 * A browser can't set headers on a WebSocket upgrade, so the socket routes
 * read the same bearer from the `token` query param instead.
 */
export function getHostServiceWsToken(hostUrl: string): string | null {
	return secrets.get(hostUrl) ?? getJwt();
}

const REFRESH_MIN_INTERVAL_MS = 1_000;
let refreshInFlight: Promise<void> | null = null;
let lastRefreshAt = 0;

/**
 * (BUS-RESYNC) Re-read every local host-service PSK from the coordinator, which
 * owns the live value.
 *
 * A restarted host-service issues a NEW secret. The cached one is normally
 * refreshed as a side effect of `LocalHostServiceProvider`'s 5s connection
 * poll, but that is a render-loop side effect, not something the socket itself
 * controls — and a socket rejected for a stale PSK has no way to ask for a
 * better one. `createRelaySocket` evaluates `getToken` before EVERY dial, so
 * refreshing the map between attempts is enough to make the next dial carry the
 * current secret.
 *
 * A host the coordinator no longer lists keeps its cached entry: dropping it
 * would fall the next dial back to the user JWT, which a local host rejects
 * just the same, so blanking can only turn "possibly stale" into "certainly
 * wrong". Coalesced and rate-limited so a reconnect storm cannot flood IPC.
 */
export function refreshHostServiceSecrets(): Promise<void> {
	if (refreshInFlight) return refreshInFlight;
	if (Date.now() - lastRefreshAt < REFRESH_MIN_INTERVAL_MS) {
		return Promise.resolve();
	}
	refreshInFlight = (async () => {
		try {
			const connections =
				await electronTrpcClient.hostServiceCoordinator.getConnections.query();
			for (const { port, secret } of connections ?? []) {
				if (!secret) continue;
				secrets.set(`http://127.0.0.1:${port}`, secret);
			}
		} catch (error) {
			console.error(
				"[host-service] failed to refresh host-service secrets — a stale PSK may keep the event bus disconnected",
				error,
			);
		} finally {
			lastRefreshAt = Date.now();
			refreshInFlight = null;
		}
	})();
	return refreshInFlight;
}
