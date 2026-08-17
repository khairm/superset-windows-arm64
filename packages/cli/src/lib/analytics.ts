import type { ApiClient } from "./api-client";

/**
 * (CLOUD-SEVERANCE-P1) No-op on this fork.
 *
 * Upstream posted `api.analytics.captureEvent` to SUPERSET_API_URL (default
 * https://api.superset.sh) on EVERY command invocation from
 * `src/commands/middleware.ts`. That was the one genuinely live per-command
 * phone-home in the bundled CLI, so the body is gone.
 *
 * The signature, the export and the call site are deliberately UNCHANGED: the
 * middleware's auth/resolveAuth chain is what the bundled superset-cli preset
 * and the desktop startup shim depend on, and it stays intact. The `api`
 * parameter is still typed so a merge that changes the client's shape still
 * type-checks here rather than silently drifting.
 */
export function trackCommandInvoked(_input: {
	api: ApiClient;
	commandPath: string[];
	flags: string[];
}): void {
	// Intentionally empty: no network call, no local record, nothing to flush.
}
