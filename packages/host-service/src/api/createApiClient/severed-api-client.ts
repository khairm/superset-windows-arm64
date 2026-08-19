/**
 * (CLOUD-SEVERANCE-P2) The cloud API client, severed.
 *
 * The host-service used to hold a real tRPC client against `api.superset.sh`
 * for a handful of things: registering itself so it appeared in the cloud host
 * list, resolving a relay endpoint, reporting analytics, and a few opportunistic
 * lookups (a task by id, a project by git remote, an organization by JWT). None
 * of them can happen now, and none of them need to: the only client of this
 * host-service is the app on the same machine, reaching it over loopback with
 * the coordinator's PSK.
 *
 * IT REJECTS, IT NEVER THROWS SYNCHRONOUSLY. Several call sites are written as
 * `void ctx.api.something.mutate(...).catch(...)` — fire-and-forget with the
 * handler attached one expression later. A synchronous throw escapes before
 * that `.catch` exists and takes down whatever was running; a rejected promise
 * lands in it exactly as a network failure would have. This distinction is the
 * whole reason this file is a Proxy factory rather than an object of stubs.
 */

import type { ApiClient } from "../../types";

/** Named so a stray rejection in a log says what reached for the cloud. */
function severedRejection(path: string): Promise<never> {
	return Promise.reject(
		Object.assign(
			new Error(
				`CLOUD_SEVERED: ${path} — this host-service has no cloud ` +
					"(see FEATURES.md, (CLOUD-SEVERANCE-P2)).",
			),
			{ name: "CloudSeveredError" },
		),
	);
}

/**
 * A recursive Proxy: every property access builds up a path, and calling
 * `.query()` / `.mutate()` (or anything else) at the end rejects with it.
 * Recursive rather than a fixed table because the router shape is upstream's
 * and changes with it — a table would go stale silently, and staleness here
 * means a real network call slipping back in.
 */
function severedNamespace(path: string): unknown {
	return new Proxy(() => undefined, {
		get(_target, property: string | symbol) {
			if (typeof property === "symbol") return undefined;
			return severedNamespace(`${path}.${property}`);
		},
		apply() {
			return severedRejection(path);
		},
	});
}

export function createSeveredApiClient(): ApiClient {
	return severedNamespace("api") as ApiClient;
}
