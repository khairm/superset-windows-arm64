/**
 * (COMPANION-BRIDGE) — the process-wide handle to the running bridge.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * `startCompanionBridgeIfEnabled` is called from a single line inside
 * upstream's `serve()` listening callback, which is synchronous and must stay
 * that way — see the ASYNC ON PURPOSE note on the mount. The returned
 * `CompanionBridge` therefore has nowhere to live at the call site, and without
 * somewhere to put it the three DESKTOP-side operations on that handle
 * (`openPairing`, `disableWrites`, `revokeAllDevices`) are unreachable code:
 * no device can ever pair, and the panic switch DESIGN promises "from the
 * desktop" exists only as a route the lost phone would have to call.
 *
 * So the mount registers the live bridge here, and the `companion` tRPC router
 * (`trpc/router/companion`) reads it. This mirrors `setCompanionQuestionSink`
 * exactly: a module-level registration keeps the two sides independent — the
 * router has no idea how a bridge is built, and the bridge never reaches into
 * the router.
 *
 * NOTHING HERE STARTS OR STOPS ANYTHING. Registration follows a successful
 * `start()` and clearing follows `stop()`; this module only remembers.
 */

import { isCompanionBridgeEnabled, LOG_PREFIX } from "./config";
import type { CompanionBridge } from "./index";

let current: CompanionBridge | null = null;

/**
 * Publish the live bridge.
 *
 * Registering over a live bridge is a programming error, not a race to be
 * smoothed over: two bridges in one process would both bind 47610 (the second
 * cannot, and fails loud there) or, worse, both hold device stores that
 * disagree about who is paired. Fail rather than silently taking the newer one.
 */
export function setCompanionBridge(bridge: CompanionBridge): void {
	if (current !== null && current !== bridge) {
		throw new Error(
			`${LOG_PREFIX} a companion bridge is already registered; ` +
				"clear it (clearCompanionBridge) before registering another",
		);
	}
	current = bridge;
}

/**
 * Identity-checked so a late shutdown of an OLD bridge cannot unpublish a NEW
 * one. Clearing something that is not registered is a no-op, because a bridge
 * that failed before it registered still runs its stop path.
 */
export function clearCompanionBridge(bridge: CompanionBridge): void {
	if (current === bridge) current = null;
}

/** The live bridge, or `null` when the feature is off or failed to start. */
export function getCompanionBridge(): CompanionBridge | null {
	return current;
}

export interface CompanionBridgeStatus {
	/** `SUPERSET_COMPANION_BRIDGE=1`. Opt-in; never inferred from disk. */
	enabled: boolean;
	/**
	 * A started bridge is registered AND still running. `enabled && !running`
	 * means it was asked for and did not come up — the host-service log carries
	 * the reason, and the caller must show unavailable rather than pretend.
	 */
	running: boolean;
	/** `Date.now()` at the moment the sealed listener bound, or `null`. */
	startedAtMs: number | null;
}

export function readCompanionBridgeStatus(): CompanionBridgeStatus {
	const bridge = current;
	const running = bridge?.running ?? false;
	return {
		enabled: isCompanionBridgeEnabled(),
		running,
		startedAtMs: running && bridge !== null ? bridge.startedAtMs : null,
	};
}
