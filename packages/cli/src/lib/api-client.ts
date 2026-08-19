import type { AppRouter } from "@superset/trpc";
import type { TRPCClient } from "@trpc/client";

export type ApiClient = TRPCClient<AppRouter>;

/**
 * (CLOUD-SEVERANCE-P2) The CLI's cloud client, severed.
 *
 * Commands that only ever needed this machine — `ws`, `terminals`, `agents`,
 * `settings` — reach the local host-service directly and are unaffected.
 * Commands that genuinely lived in the cloud (auth, billing, org/team
 * management, cloud tasks) reject with the procedure named.
 *
 * Rejects, never throws synchronously: the same fire-and-forget call shape
 * exists here as in the host-service.
 */
function severedRejection(path: string): Promise<never> {
	return Promise.reject(
		Object.assign(
			new Error(
				`CLOUD_SEVERED: ${path} — this fork has no cloud ` +
					"(see FEATURES.md, (CLOUD-SEVERANCE-P2)).",
			),
			{ name: "CloudSeveredError" },
		),
	);
}

function severedNamespace(path: string): unknown {
	return new Proxy(() => undefined, {
		get(_target, property: string | symbol) {
			if (typeof property === "symbol") return undefined;
			return severedNamespace(`${path}.${String(property)}`);
		},
		apply() {
			return severedRejection(path);
		},
	});
}

export function createApiClient(_opts: {
	bearer: string;
	organizationId?: string;
}): ApiClient {
	return severedNamespace("api") as ApiClient;
}
