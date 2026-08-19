/**
 * (CLOUD-SEVERANCE-P2) The renderer's view of the local identity.
 *
 * The organization id is NOT a constant — it names the directory holding this
 * machine's host database, workspaces and paired companion devices, and main
 * resolves it from disk once and freezes it (`main/lib/local-identity/
 * local-org.ts`). It reaches the renderer through the preload bridge rather
 * than an async query on purpose: the sidebar, the kanban board and every
 * collection key are org-scoped from the FIRST render, and a value that
 * arrives a tick later would make them all mount against `null` and then
 * remount — the exact churn that has emptied this sidebar before.
 *
 * A missing value throws rather than falling back. There is no sane default:
 * guessing an organization here would silently point the app at an empty
 * database that looks like a factory reset.
 */

import { LOCAL_SESSION_EXPIRES_AT, LOCAL_USER } from "shared/local-identity";

let cached: string | null = null;

export function getLocalOrganizationId(): string {
	if (cached) return cached;
	const fromBridge = window.App?.localOrganizationId;
	if (!fromBridge) {
		throw new Error(
			"[local-identity] the preload bridge did not supply a local " +
				"organization id. The main process resolves it before any window " +
				"exists, so this means the boot order changed — refusing to guess " +
				"one, because the wrong id points the app at an empty database.",
		);
	}
	cached = fromBridge;
	return cached;
}

/**
 * The active organization id. A hook by shape only — the value never changes
 * for the life of the process, which is what lets every org-keyed store treat
 * it as stable.
 */
export function useActiveOrganizationId(): string {
	return getLocalOrganizationId();
}

/**
 * This machine's host id — the same `getHostId()` value the coordinator, the
 * host-service and the wire's `clientMachineId` all use. Never the raw
 * platform machine id, which upstream marks do-not-transmit.
 */
let cachedMachineId: string | null = null;

export function getLocalMachineId(): string {
	if (cachedMachineId) return cachedMachineId;
	const fromBridge = window.App?.localMachineId;
	if (!fromBridge) {
		throw new Error(
			"[local-identity] the preload bridge did not supply a machine id — " +
				"refusing to invent one, because every host-keyed row would then " +
				"belong to a host nothing can reach.",
		);
	}
	cachedMachineId = fromBridge;
	return cachedMachineId;
}

/** Display name for this machine. Cosmetic; a fallback is harmless here. */
export function getLocalHostName(): string {
	return window.App?.localHostName || "This device";
}

/**
 * The session shape upstream code reads, filled in from local values.
 *
 * Memoised, and that is not micro-optimisation: `authClient.useSession()`
 * returns this object on every render, so a fresh one each call gives every
 * consumer a new reference each render. Effects keyed on the session — there
 * is one in the root layout already — would then re-run forever. The values
 * cannot change within a process, so the identity should not either.
 */
let cachedSession: ReturnType<typeof buildLocalSession> | null = null;

export function getLocalSession() {
	if (!cachedSession) cachedSession = buildLocalSession();
	return cachedSession;
}

function buildLocalSession() {
	const organizationId = getLocalOrganizationId();
	return {
		user: LOCAL_USER,
		session: {
			id: "fork-local-session",
			token: "fork-local-session",
			userId: LOCAL_USER.id,
			activeOrganizationId: organizationId,
			/**
			 * Every gated feature is unlocked. There is no billing service to
			 * ask and no subscription to buy, and leaving this unset would leave
			 * the paywall permanently pessimistic about a product the user
			 * already owns a copy of.
			 */
			plan: "enterprise" as string | null,
			organizationIds: [organizationId],
			expiresAt: LOCAL_SESSION_EXPIRES_AT,
			createdAt: new Date(0),
			updatedAt: new Date(0),
		},
	};
}

/**
 * The active organization, including the single membership row. Kept surfaces
 * (project deletion, for one) decide what the user may do by looking for their
 * own row here and reading its role, so an organization with no members would
 * read as "not permitted" rather than as "no cloud".
 */
let cachedActiveOrganization: ReturnType<
	typeof buildLocalActiveOrganization
> | null = null;

export function getLocalActiveOrganization() {
	if (!cachedActiveOrganization) {
		cachedActiveOrganization = buildLocalActiveOrganization();
	}
	return cachedActiveOrganization;
}

function buildLocalActiveOrganization() {
	const organizationId = getLocalOrganizationId();
	return {
		id: organizationId,
		name: "Local",
		slug: "local",
		logo: null as string | null,
		createdAt: new Date(0),
		metadata: null,
		members: [
			{
				id: "fork-local-member",
				organizationId,
				userId: LOCAL_USER.id,
				role: "owner",
				createdAt: new Date(0),
				user: {
					id: LOCAL_USER.id,
					name: LOCAL_USER.name,
					email: LOCAL_USER.email,
					image: LOCAL_USER.image,
				},
			},
		],
		invitations: [] as unknown[],
		teams: [] as unknown[],
	};
}
