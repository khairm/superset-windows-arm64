import { isV2OnlyUser } from "@superset/shared/v2-only-user";
import { authClient } from "renderer/lib/auth-client";
import {
	isV1ForcedFlipActive,
	isV1MigrationCompleteAtBoot,
} from "renderer/lib/v1-migration/completion";

/**
 * True for accounts created on/after V2_ONLY_USER_CUTOFF — these users
 * default to v2.
 */
export function useIsV2OnlyUser(): boolean {
	const { data: session } = authClient.useSession();
	return isV2OnlyUser(session?.user?.createdAt);
}

/**
 * True when v2 is locked on for this machine (org migration completed, or
 * the forced-flip backstop is active). The optInV2 override has no effect in
 * either state, so surfaces offering the v1/v2 switch must hide it instead
 * of rendering a control that silently snaps back.
 */
export function useIsV1FlipLocked(): boolean {
	const { data: session } = authClient.useSession();
	return (
		isV1MigrationCompleteAtBoot(session?.session?.activeOrganizationId) ||
		isV1ForcedFlipActive()
	);
}

/** Returns whether v2 is currently active for this user. */
export function useIsV2CloudEnabled(): boolean {
	// (V2-PIN) Fork is v2-only, forever -- always report v2 active
	// regardless of account age or the opt-in toggle.
	return true;
}
