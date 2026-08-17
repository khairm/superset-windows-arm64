// (CLOUD-SEVERANCE-P1) This fork does not phone home. The four variables below
// are the only inputs that can arm upstream's telemetry sinks at build time:
// a PostHog project key, either Sentry DSN, and the Sentry auth token (which
// additionally drives the build-time sourcemap UPLOAD plugins in
// electron.vite.config.ts — itself a phone-home, to upstream's Sentry org).
//
// The ban is a THROW, not a silent force-empty. Quietly rewriting a value the
// maintainer deliberately put in .env hides the disagreement until someone
// wonders why telemetry is dead; failing the build names the variable and stops.
// A .env carrying anything else (ports, API URLs, workspace name) keeps working.
const BANNED_TELEMETRY_KEYS = [
	"NEXT_PUBLIC_POSTHOG_KEY",
	"SENTRY_DSN_DESKTOP",
	"SENTRY_DSN_HOST_SERVICE",
	"SENTRY_AUTH_TOKEN",
] as const;

const WHY: Record<(typeof BANNED_TELEMETRY_KEYS)[number], string> = {
	NEXT_PUBLIC_POSTHOG_KEY:
		"arms PostHog analytics capture in the renderer and main process",
	SENTRY_DSN_DESKTOP:
		"arms Sentry error reporting in the desktop main + renderer processes",
	SENTRY_DSN_HOST_SERVICE: "arms Sentry error reporting in the host-service",
	SENTRY_AUTH_TOKEN:
		"uploads sourcemaps to upstream's Sentry org during the build",
};

/**
 * Throws if any banned telemetry variable is present and non-empty.
 *
 * Takes the environment explicitly so it can be unit-tested without mutating
 * `process.env`.
 */
export function assertNoTelemetryKeys(
	environment: Record<string, string | undefined>,
): void {
	const offenders = BANNED_TELEMETRY_KEYS.filter((key) => {
		const value = environment[key];
		return typeof value === "string" && value.trim().length > 0;
	});
	if (offenders.length === 0) return;

	const detail = offenders.map((key) => `  - ${key}: ${WHY[key]}`).join("\n");
	throw new Error(
		`(CLOUD-SEVERANCE-P1) refusing to build: this fork severs upstream telemetry, but ${offenders.length} telemetry variable(s) are set:\n${detail}\n\nUnset them (or blank them) in the environment and in the repo-root .env, then rebuild. They are never masked silently — a build that could phone home must fail loudly instead.`,
	);
}

export { BANNED_TELEMETRY_KEYS };
