import type { AppRouter } from "@superset/trpc";
import type { TRPCClient } from "@trpc/client";

export type ApiClient = TRPCClient<AppRouter>;

/**
 * A non-JSON error response from whatever sits in front of an HTTP API:
 * Vercel's 413 page, a gateway's HTML 502. tRPC would otherwise report these
 * as "Failed to parse JSON" and drop the status, leaving the user nothing to
 * act on. The body keeps its non-empty lines (Vercel's includes the request
 * id). Kept under (CLOUD-SEVERANCE-P2) because it is transport-shaped, not
 * cloud-shaped: it names no host, and the feedback command still classifies
 * its own HTTP failures with it.
 */
export class ApiHttpError extends Error {
	constructor(
		public readonly status: number,
		public readonly statusText: string,
		public readonly body: string,
	) {
		super(`HTTP ${status} ${statusText}: ${body}`.trimEnd());
		this.name = "ApiHttpError";
	}
}

const MAX_ERROR_BODY_CHARS = 300;

export async function fetchRejectingNonJsonErrors(
	input: string | URL | Request,
	init?: RequestInit,
): Promise<Response> {
	const response = await fetch(input, init);
	const contentType = response.headers.get("content-type") ?? "";
	if (response.ok || contentType.includes("json")) return response;
	const body = (await response.text())
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.join(" / ")
		.slice(0, MAX_ERROR_BODY_CHARS);
	throw new ApiHttpError(response.status, response.statusText, body);
}

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
