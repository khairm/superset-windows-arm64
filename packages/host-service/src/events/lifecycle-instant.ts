/**
 * (ONE-BUZZ-UNTIL-READ) The instant a lifecycle event happened, forced to be
 * STRICTLY INCREASING per terminal.
 *
 * `Date.now()` is not monotonic: an NTP correction can step the wall clock
 * BACKWARDS, and every lifecycle fact this host records is stamped from it —
 * the binding's `lastEventAt`, the deterministic alert id, the `gx` generation
 * on `g` and `c`, and the boundary `markLifecycleSeen` compares a read
 * against. A backstep therefore does not merely mis-date a row, it INVERTS an
 * ordering three separate mechanisms trust:
 *
 *  - the phone shows the newer generation and drops the older, so a finish
 *    stamped behind its predecessor is rejected as stale and never buzzes;
 *  - a later `c` computed from the read cannot name the card that IS showing,
 *    so the notification cannot be retracted at all;
 *  - the renderer sees the report accepted and drops its outstanding record,
 *    which is the evidence the resync repair would have used.
 *
 * The anchor is the terminal's own last event, which is persisted with the
 * binding and reloaded on start, so the property survives a host restart
 * without a schema change — the same state the deterministic-id path already
 * depends on. Per terminal rather than global: two terminals' streams are
 * independent, and one busy agent must not push another's stamps into the
 * future.
 *
 * Forward jumps are honoured as-is. Only the backstep is corrected, by the
 * smallest amount that keeps the order intact.
 *
 * Lives in a leaf module so BOTH producers of lifecycle events — the
 * notifications hook route and the (STALE-WORKING-SWEEP) — share one copy of
 * the ordering rule.
 */
export function nextLifecycleInstantMs(
	nowMs: number,
	previousEventAtMs: number | null | undefined,
): number {
	if (previousEventAtMs === null || previousEventAtMs === undefined) {
		return nowMs;
	}
	return nowMs > previousEventAtMs ? nowMs : previousEventAtMs + 1;
}
