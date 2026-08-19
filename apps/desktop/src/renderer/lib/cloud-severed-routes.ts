/**
 * (CLOUD-SEVERANCE-P2) The routes that have nothing behind them.
 *
 * Every path listed here renders a screen whose only data source was
 * the cloud API, so under the severed tRPC link it can do exactly one
 * thing: show a spinner and then an error. The entry points that led to them —
 * sidebar rows, palette commands, settings nav, menu items — are gone, but a
 * saved location, a stale window, a deep link or a typed URL can still aim at
 * one, so the guard has to live on the route as well as on the buttons.
 *
 * The page files stay on disk deliberately. This fork merges upstream nightly
 * and deleting ninety files under these trees would put us in conflict on all
 * of them forever; leaving them unreachable costs a redirect and nothing else.
 *
 * Prefix matching, not exact: `/tasks/$taskId` and `/settings/billing/plans`
 * are as dead as their parents, and an upstream merge that adds a child route
 * under one of these trees should be caught by this list on the night it
 * lands rather than the night someone notices.
 */

/** Where a severed route sends the user. Always reachable, never severed. */
export const CLOUD_SEVERED_FALLBACK_ROUTE = "/workspace";

/** Settings section to open when something asks for "settings" with no target. */
export const DEFAULT_SETTINGS_ROUTE = "/settings/appearance";

const CLOUD_SEVERED_ROUTE_PREFIXES = [
	// Cloud-only dashboard views.
	"/tasks",
	"/automations",
	// Account/org lifecycle: there is one local identity and it cannot be
	// created, switched, deleted or signed out of.
	"/create-organization",
	"/onboarding",
	// Settings sections that are pure cloud: seats, invoices, API tokens,
	// third-party integrations, the account profile, and remote host
	// management (this machine is the only host, and it needs no managing).
	"/settings/account",
	"/settings/api-keys",
	"/settings/billing",
	"/settings/hosts",
	"/settings/integrations",
	"/settings/organization",
	"/settings/teams",
	// The security section is a single switch — "allow remote workspaces to
	// reach this device via relay". With the relay severed it would save a
	// preference and restart the host services to no effect, which is worse
	// than absent: a control that looks like it governs network exposure and
	// governs nothing teaches the user to distrust the ones that do.
	"/settings/security",
] as const;

export function isCloudSeveredRoute(pathname: string): boolean {
	return CLOUD_SEVERED_ROUTE_PREFIXES.some(
		(prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
	);
}
