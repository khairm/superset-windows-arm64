/**
 * (CLOUD-SEVERANCE-P2) There is nothing to hydrate.
 *
 * Upstream held the whole app behind a splash while it read the stored session
 * token, refetched the session from `api.superset.sh`, minted a JWT and then
 * refreshed that JWT every fifty minutes. All four of those are gone: the
 * identity is local and known before the first render, and the only token this
 * app still uses — the host-service PSK — is issued by the coordinator, not by
 * an account.
 *
 * Kept as a component rather than deleted because it is mounted high in the
 * tree by upstream code that churns every release; a pass-through here is a
 * one-line merge, where removing the element would be a conflict in a file we
 * otherwise never touch.
 */

import type { ReactNode } from "react";

export function AuthProvider({ children }: { children: ReactNode }) {
	return <>{children}</>;
}
