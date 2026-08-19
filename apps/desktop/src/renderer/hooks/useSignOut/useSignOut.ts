/**
 * (CLOUD-SEVERANCE-P2) Signing out is not a thing that can happen.
 *
 * There is no account, no session to revoke and no second identity to return
 * to — the app's identity is the local organization on this disk, and it is
 * frozen. Every surface that offered sign-out is being removed; this hook stays
 * only so those removals can land one at a time without breaking the build in
 * between, and it is deliberately a NO-OP rather than a throw: a stray caller
 * should do nothing, not raise an error toast on a button that has nothing to
 * undo.
 *
 * It must never regain a real body. Tearing down the token store is what used
 * to stop every host-service, which is to say: it would kill every running
 * terminal for a user who has no way to sign back in.
 */

export const ACTIVE_ORG_ID_KEY = "active_organization_id";

export function useSignOut() {
	return async () => {
		console.warn(
			"[auth] sign-out is unavailable in this fork — there is no account " +
				"to sign out of (see FEATURES.md, (CLOUD-SEVERANCE-P2))",
		);
	};
}
