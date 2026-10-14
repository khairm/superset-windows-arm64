import { isV2OnlyUser } from "@superset/shared/v2-only-user";
import { authClient } from "renderer/lib/auth-client";

export function useIsV2OnlyUser(): boolean {
	const { data: session } = authClient.useSession();
	return isV2OnlyUser(session?.user?.createdAt);
}

export function useIsV2CloudEnabled(): boolean {
	// (V2-PIN) Fork is v2-only, forever.
	return true;
}
