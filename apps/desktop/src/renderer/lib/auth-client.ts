/**
 * (CLOUD-SEVERANCE-P2) The severed auth client.
 *
 * Upstream's better-auth client talked to `api.superset.sh` for sessions,
 * organizations, teams, billing and JWTs. There is no cloud any more, so this
 * module answers the handful of questions the kept surfaces actually ask —
 * "who am I", "which organization" — from local values, and refuses everything
 * else loudly.
 *
 * WHY A PROXY AND NOT AN OBJECT LITERAL. Sixteen distinct members of this
 * client are called across the renderer, and this fork ships with accepted type
 * debt: `(REFERR-GATE)` fails the build only on cannot-find-NAME diagnostics,
 * not on a property that is missing from an object. A literal that forgot one
 * member would therefore compile, ship, and fail in the user's hands as
 * "undefined is not a function". A Proxy cannot forget: anything not explicitly
 * answered throws a named CLOUD_SEVERED error the moment it is touched, which
 * is also what makes an upstream merge that adds a NEW cloud call visible
 * instead of silent.
 *
 * The token/JWT accessors below are kept as real state rather than deleted:
 * `host-service-auth.ts` reads them on every host-service request, and the
 * local path (a per-process PSK) legitimately has no token to offer. They
 * return null, which is the honest answer, and the PSK path is unaffected.
 */

import { useSyncExternalStore } from "react";
import {
	getLocalActiveOrganization,
	getLocalSession,
} from "renderer/lib/local-identity";
import { cloudSeveredError } from "shared/local-identity";

let authToken: string | null = null;
const authTokenListeners = new Set<() => void>();

function subscribeAuthToken(listener: () => void): () => void {
	authTokenListeners.add(listener);
	return () => authTokenListeners.delete(listener);
}

function getServerAuthToken(): null {
	return null;
}

export function setAuthToken(token: string | null) {
	if (authToken === token) return;
	authToken = token;
	for (const listener of authTokenListeners) listener();
}

export function getAuthToken(): string | null {
	return authToken;
}

export function useAuthToken(): string | null {
	return useSyncExternalStore(
		subscribeAuthToken,
		getAuthToken,
		getServerAuthToken,
	);
}

/**
 * The relay JWT. Always null: the relay is severed, and the only other
 * consumer — a LOCAL host-service request — authenticates with the
 * coordinator's PSK and never falls back to this.
 */
export function setJwt(_token: string | null): void {
	// Nothing mints a JWT any more. Kept as a no-op because upstream response
	// hooks and sign-out paths call it.
}

export function getJwt(): string | null {
	return null;
}

export async function ensureFreshJwt(): Promise<string | null> {
	return null;
}

/** What the shim answers locally. Everything else throws. */
const LOCAL_MEMBERS: Record<string, unknown> = {
	useSession: () => ({
		data: getLocalSession(),
		isPending: false,
		isRefetching: false,
		error: null,
		refetch: () => undefined,
	}),
	useActiveOrganization: () => ({
		data: getLocalActiveOrganization(),
		isPending: false,
		isRefetching: false,
		error: null,
		refetch: () => undefined,
	}),
	getSession: async () => ({ data: getLocalSession(), error: null }),
	/**
	 * Sign-out is reachable from nothing in this build, but a no-op that
	 * resolves is the safe shape for a stray caller: the alternative — a
	 * throw — would surface as an error toast on a button that, in a world
	 * with no account, has nothing to do anyway.
	 */
	signOut: async () => ({ data: null, error: null }),
};

/**
 * The shim's type. The two answered hooks are typed PRECISELY — kept surfaces
 * read `session.user.id` and find their own membership row in
 * `organization.members`, and an `any` there would silently turn those into
 * untyped code the moment the real client stopped providing the types. The
 * index signature covers everything else, so upstream call sites for surfaces
 * that no longer exist still compile until they are removed.
 */
type SeveredAuthClient = {
	useSession: () => {
		data: ReturnType<typeof getLocalSession>;
		isPending: false;
		isRefetching: false;
		error: null;
		refetch: (...args: unknown[]) => void;
	};
	useActiveOrganization: () => {
		data: ReturnType<typeof getLocalActiveOrganization>;
		isPending: false;
		isRefetching: false;
		error: null;
		refetch: (...args: unknown[]) => void;
	};
	getSession: () => Promise<{
		data: ReturnType<typeof getLocalSession>;
		error: null;
	}>;
	signOut: (...args: unknown[]) => Promise<{ data: null; error: null }>;
	// biome-ignore lint/suspicious/noExplicitAny: stands in for every cloud member that now throws
} & Record<string, any>;

/**
 * Behaviourally a wall with two doors. Anything not answered above throws when
 * called, naming the path it was reached through.
 */
export const authClient = new Proxy({} as Record<string, unknown>, {
	get(_target, property: string | symbol) {
		if (typeof property === "symbol") return undefined;
		// Own properties only: `in` walks the prototype chain, so `toString`,
		// `valueOf` and friends would resolve to Object.prototype instead of
		// the wall, which is precisely the "a Proxy cannot forget" guarantee
		// this shim exists to make.
		if (Object.hasOwn(LOCAL_MEMBERS, property)) return LOCAL_MEMBERS[property];
		// Nested namespaces (organization.setActive, subscription.upgrade,
		// apiKey.delete …) refuse when CALLED, not when merely reached:
		// destructuring or optional-chaining a namespace is not itself an
		// attempt to use the cloud.
		//
		// They REJECT rather than throw, matching the other three severed
		// clients. Every call site today awaits inside an async function, where
		// the two are equivalent — but an upstream merge that adds a
		// fire-and-forget `void authClient.x.y().catch(…)` would have its throw
		// escape before the catch was attached, and an unhandled rejection is a
		// far better failure than a crash on a surface that no longer exists.
		return new Proxy(() => undefined, {
			get(_inner, member: string | symbol) {
				if (typeof member === "symbol") return undefined;
				return () =>
					Promise.reject(
						cloudSeveredError(`authClient.${property}.${String(member)}`),
					);
			},
			apply() {
				return Promise.reject(cloudSeveredError(`authClient.${property}()`));
			},
		});
	},
}) as unknown as SeveredAuthClient;
