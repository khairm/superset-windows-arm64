import { getJwt } from "./auth-client";
import { electronTrpcClient } from "./trpc-client";

const secrets = new Map<string, string>();

let clientMachineId: string | null = null;

export function setClientMachineId(machineId: string): void {
	clientMachineId = machineId;
}

export function setHostServiceSecret(hostUrl: string, secret: string): void {
	secrets.set(hostUrl, secret);
}

export function removeHostServiceSecret(hostUrl: string): void {
	secrets.delete(hostUrl);
}

/**
 * A sandbox has one gate, the provider's edge, and this is its key. Brokered
 * by `cloudWorkspace.access` and short-lived, so it is held per URL rather
 * than baked into the client. host-service inside a sandbox does not check a
 * secret of its own — see `EdgeGuardedHostAuthProvider`.
 */
const previewTokens = new Map<string, string>();

export function setSandboxCredentials(
	hostUrl: string,
	{ previewToken }: { previewToken: string },
): void {
	previewTokens.set(hostUrl, previewToken);
}

export function getHostServiceHeaders(hostUrl: string): Record<string, string> {
	const headers: Record<string, string> = clientMachineId
		? { "x-superset-client-machine-id": clientMachineId }
		: {};
	const previewToken = previewTokens.get(hostUrl);
	if (previewToken) headers["X-Blaxel-Preview-Token"] = previewToken;
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

export function getHostServiceWsToken(hostUrl: string): string | null {
	// Local host-service: use PSK. Relay: fall back to user JWT.
	return secrets.get(hostUrl) ?? getJwt();
}

/**
 * The provider's edge reads its token from a header on HTTP requests, which a
 * WebSocket upgrade can't carry from a browser — there it reads this query
 * param instead.
 */
export function getHostServiceWsUrlParams(
	hostUrl: string,
): Record<string, string> | null {
	const previewToken = previewTokens.get(hostUrl);
	return previewToken ? { bl_preview_token: previewToken } : null;
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
