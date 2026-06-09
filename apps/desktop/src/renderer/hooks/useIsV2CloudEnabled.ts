import { isV2OnlyUser } from "@superset/shared/v2-only-user";
import { authClient } from "renderer/lib/auth-client";

/**
 * True for accounts created on/after V2_ONLY_USER_CUTOFF — these users
 * default to v2.
 */
export function useIsV2OnlyUser(): boolean {
	const { data: session } = authClient.useSession();
	return isV2OnlyUser(session?.user?.createdAt);
}

/** Returns whether v2 is currently active for this user. */
export function useIsV2CloudEnabled(): boolean {
	// (V2-PIN) Fork is v2-only, forever -- always report v2 active
	// regardless of account age or the opt-in toggle.
	return true;
}
