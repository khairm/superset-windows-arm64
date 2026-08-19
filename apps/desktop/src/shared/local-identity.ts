/**
 * (CLOUD-SEVERANCE-P2) The identity this app runs as now that there is no
 * cloud to issue one.
 *
 * Phase 1 cut telemetry, updates and notices. Phase 2 cuts the account itself:
 * no sign-in, no session, no organization service, no cloud data plane. What
 * replaces them is deliberately boring — a fixed user, and an organization id
 * resolved once from this machine's own disk (`main/lib/local-identity/
 * local-org.ts`) and frozen forever after.
 *
 * The split matters. The USER is a constant because nothing keys durable state
 * by user id; it exists only to satisfy the shapes upstream code reads. The
 * ORGANIZATION is emphatically NOT a constant — it names the directory holding
 * the host database, the workspaces, and the companion's paired devices, so it
 * must be discovered from disk rather than declared here. Anything in this file
 * is safe to hardcode precisely because nothing durable is keyed by it.
 */

/** Fork-owned kill switch. Never false in a shipped build; see FEATURES.md. */
export const FORK_LOCAL_MODE = true;

/**
 * Stands in for the cloud session token wherever a non-empty string is
 * structurally required — `packages/host-service/src/env.ts` validates
 * `AUTH_TOKEN` with `.min(1)`, and the coordinator passes one to every child.
 * It authenticates NOTHING: local host-service calls are authorised by the
 * per-process PSK the coordinator generates, and the cloud client that used
 * to consume this token now refuses to make a request at all.
 */
export const LOCAL_AUTH_TOKEN_PLACEHOLDER = "fork-local-mode-no-cloud-session";

/** The single local user. Shapes only — no permission derives from it. */
export const LOCAL_USER = {
	id: "fork-local-user",
	name: "Local",
	email: "local@localhost",
	image: null as string | null,
	emailVerified: true,
	/**
	 * Non-null on purpose: the authenticated layout redirects to onboarding
	 * when this is missing, and there is no onboarding to complete without a
	 * cloud account to complete it against.
	 */
	onboardedAt: new Date(0),
	deletionRequestedAt: null as Date | null,
	createdAt: new Date(0),
	updatedAt: new Date(0),
} as const;

/**
 * Far future rather than "never expires": the stored-auth parser requires a
 * parseable expiry and the renderer drops a session it reads as expired, so
 * the shape has to carry a date that always parses and never passes.
 */
export const LOCAL_SESSION_EXPIRES_AT = new Date("2999-12-31T00:00:00.000Z");

/**
 * Thrown by every severed client when something reaches for the cloud.
 *
 * It names the exact procedure rather than failing generically because this is
 * the fork's early-warning system: an upstream merge that adds a cloud call to
 * a surface we kept shows up as this message naming the new path, instead of
 * as a silent empty list that looks like ordinary "no data yet".
 */
export function cloudSeveredError(path: string): Error {
	const error = new Error(
		`CLOUD_SEVERED: ${path} — this fork has no cloud (see FEATURES.md, ` +
			"(CLOUD-SEVERANCE-P2)). Nothing should be calling it.",
	);
	error.name = "CloudSeveredError";
	return error;
}
