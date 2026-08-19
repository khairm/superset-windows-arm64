/**
 * (CLOUD-SEVERANCE-P2) There is no relay, so there is no relay URL.
 *
 * This is the PRODUCER of the value, and killing it here is what makes the
 * child-side refusal unreachable in normal operation rather than a trap. The
 * coordinator deletes `RELAY_URL` from the child environment when this returns
 * nothing, so a user who once switched on "expose this device via relay" — a
 * setting still sitting as `1` in their local database, on a settings page
 * that is now severed and therefore cannot be switched back off — gets a
 * host-service that simply starts, instead of one that refuses.
 */
export function getRelayUrl(): string | undefined {
	return undefined;
}
