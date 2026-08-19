import type { ApiAuthProvider } from "../types";

/**
 * (CLOUD-SEVERANCE-P2) The auth provider for a host-service with no cloud.
 *
 * `JwtApiAuthProvider` existed to trade the desktop session token for a JWT at
 * `api.superset.sh` and cache it; `ConfigFileSessionTokenSource` did the same
 * from a config file. Both are network calls, and both are now unreachable —
 * the only thing that ever consumed their headers was the cloud tRPC client,
 * which no longer exists, and the relay tunnel, which is gone.
 *
 * This provider is constructed in their place rather than leaving the real one
 * inert. An unused object that knows how to phone home is one call site away
 * from doing it again; one that cannot is not.
 */
export class SeveredApiAuthProvider implements ApiAuthProvider {
	async getHeaders(): Promise<Record<string, string>> {
		return {};
	}

	invalidateCache(): void {
		// Nothing is cached because nothing is fetched.
	}
}
