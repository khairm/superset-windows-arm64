/**
 * Runtime env stripping for v2 terminals.
 *
 * Denylist approach: the host-service base env is a shell-derived snapshot
 * plus explicit runtime additions from desktop. We strip the known additions
 * rather than allowlisting, because the shell snapshot should pass through
 * untouched (version managers, proxy config, etc.).
 */

/**
 * Exact keys injected by desktop into host-service.
 *
 * DESKTOP_* are exact keys (not prefixes) because DESKTOP_SESSION,
 * DESKTOP_STARTUP_ID etc. are legitimate Linux vars.
 */
const HOST_SERVICE_RUNTIME_KEYS = new Set([
	"AUTH_TOKEN",
	"SUPERSET_AUTH_CONFIG_PATH",
	"SUPERSET_API_URL",
	"DESKTOP_VITE_PORT",
	"HOST_CLIENT_ID",
	"HOST_NAME",
	"KEEP_ALIVE_AFTER_PARENT",
	"ORGANIZATION_ID",
]);

const NODE_APP_KEYS = new Set(["NODE_ENV", "NODE_OPTIONS", "NODE_PATH"]);

const STRIP_PREFIXES = [
	"npm_",
	"npm_config_",
	"ELECTRON_",
	"VITE_",
	"NEXT_PUBLIC_",
	"TURBO_",
	"HOST_",
];

const SUPERSET_KEEP_KEYS = new Set([
	"SUPERSET_HOME_DIR",
	"SUPERSET_AGENT_HOOK_PORT",
	"SUPERSET_AGENT_HOOK_VERSION",
]);

/**
 * Auth secrets that must never leak from host-service into spawned PTYs.
 * Parent CLI/desktop may have these in process.env; they pass through to
 * host-service but stop here. SUPERSET_REFRESH_TOKEN would already be caught
 * by the SUPERSET_ prefix rule, but listing it explicitly keeps the
 * protection load-bearing if SUPERSET_KEEP_KEYS ever changes.
 */
const SENSITIVE_AUTH_KEYS = new Set([
	"OAUTH_REFRESH_TOKEN",
	"SUPERSET_REFRESH_TOKEN",
	/**
	 * The browser bridge's endpoint and shared secret, added by upstream
	 * v1.23.0 and stripped here from the moment they arrived.
	 *
	 * Whoever holds this secret can drive the app's browser panes over CDP:
	 * navigate them, evaluate script in them, and read the DOM of any site the
	 * user is signed into. The desktop puts both variables into the
	 * host-service's environment, and on Windows the login-shell probe that
	 * builds the terminal base environment falls back to a snapshot of exactly
	 * that environment — so without this they reach every PTY, which is to say
	 * every agent CLI and every command the user runs in a terminal.
	 *
	 * `HOST_SERVICE_SECRET` survives that same path only because it happens to
	 * match the `HOST_` prefix rule. These two match nothing, so they are
	 * named.
	 */
	"BROWSER_BRIDGE_URL",
	"BROWSER_BRIDGE_SECRET",
]);

export function stripTerminalRuntimeEnv(
	baseEnv: Record<string, string>,
): Record<string, string> {
	const result: Record<string, string> = {};

	for (const [key, value] of Object.entries(baseEnv)) {
		if (SENSITIVE_AUTH_KEYS.has(key)) continue;
		if (HOST_SERVICE_RUNTIME_KEYS.has(key)) continue;
		if (NODE_APP_KEYS.has(key)) continue;
		if (STRIP_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
		if (key.startsWith("SUPERSET_") && !SUPERSET_KEEP_KEYS.has(key)) continue;

		result[key] = value;
	}

	return result;
}
