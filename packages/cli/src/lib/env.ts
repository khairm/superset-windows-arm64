/**
 * Build-time constants baked into the CLI binary via `Bun.build({ define })`
 * (see `cli.config.ts`). In dev mode, falls back to actual process.env so
 * local dev can override these.
 */

/**
 * (CLOUD-SEVERANCE-P2) The cloud defaults point at `.invalid`, which DNS
 * guarantees never resolves. Nothing should reach them — the API client is
 * severed — so this is the second line of defence, not the first.
 */
export const env = {
	RELAY_URL: process.env.RELAY_URL || "https://relay.cloud-severed.invalid",
	SUPERSET_API_URL:
		process.env.SUPERSET_API_URL || "https://api.cloud-severed.invalid",
	SUPERSET_WEB_URL: process.env.SUPERSET_WEB_URL || "https://app.superset.sh",
	VERSION: process.env.SUPERSET_VERSION || "0.0.0-dev",
};

/**
 * True for the CLI compiled into the desktop app bundle (baked at build time
 * by apps/desktop/scripts/build-bundled-cli.ts). The bundled CLI ships without
 * superset-host and lives inside the signed .app, so it can neither run the
 * host service standalone nor update itself in place.
 */
export function isDesktopBundled(): boolean {
	return process.env.SUPERSET_CLI_CHANNEL === "desktop-bundled";
}
