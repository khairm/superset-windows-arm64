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
import type { PresenceBeaconInput, PresenceStore } from "./presence";

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

// ---------------------------------------------------------------------------
// (PUSH-PRESENCE) the presence store
// ---------------------------------------------------------------------------

/**
 * The live presence store, published for the same reason the bridge is: the
 * `companion.presenceBeacon` tRPC mutation is the desktop's only way in, and it
 * has no other handle on the running bridge.
 *
 * It is registered SEPARATELY from the bridge rather than reached through it,
 * and that is deliberate. The bridge handle is the panic/pairing surface and
 * every one of its operations refuses when the bridge is not running. A beacon
 * is the opposite kind of thing — advisory telemetry that arrives every 15 s
 * whether anyone is listening or not — and routing it through `requireBridge()`
 * would turn the ordinary "no bridge on this machine" state into an error on a
 * repeating desktop timer.
 */
let presence: PresenceStore | null = null;

export function setCompanionPresenceStore(store: PresenceStore): void {
	if (presence !== null && presence !== store) {
		throw new Error(
			`${LOG_PREFIX} a companion presence store is already registered; ` +
				"clear it (clearCompanionPresenceStore) before registering another",
		);
	}
	presence = store;
}

/** Identity-checked, so a stopping bridge cannot unpublish its replacement. */
export function clearCompanionPresenceStore(store: PresenceStore): void {
	if (presence === store) presence = null;
}

/**
 * Record one desktop presence beacon.
 *
 * Returns whether anything consumed it. `false` means the bridge is off or not
 * yet up — which is the NORMAL state for every fork user, so it is an answer and
 * never an error. The sender logs it once and carries on; a beacon that cannot
 * be stored has no consequence beyond the push falling back to keystrokes.
 */
export function recordCompanionPresenceBeacon(
	beacon: PresenceBeaconInput,
): boolean {
	const store = presence;
	if (store === null) return false;
	store.record(beacon);
	return true;
}

// ---------------------------------------------------------------------------
// (MIRROR-CHANGE-GSEQ) the sidebar-mirror change notifier
// ---------------------------------------------------------------------------

/**
 * What a mirror write reports about itself. Content only — the sink turns it
 * into the protocol frame, because the tRPC router has no business knowing what
 * a frame looks like.
 */
export interface CompanionMirrorChange {
	syncedAtMs: number;
	workspaceCount: number;
	projectCount: number;
}

/**
 * (MIRROR-CHANGE-GSEQ) Published for the same reason the presence store is: the
 * `sidebarMirror.sync` tRPC mutation is a write the companion bridge has to
 * know about, and the router has no handle on a running bridge.
 *
 * WHY THE BRIDGE HAS TO KNOW. `/v1/tree` is filtered through the mirror, so
 * curation is an input to what the phone renders — but the mirror was written
 * entirely outside the bridge, so nothing minted an event and `gseq` never
 * moved. The heartbeat compares `gseq` alone, kept answering `treeStale: false`,
 * and the phone went on stamping "updated just now" over a list whose pins,
 * membership and placement had since changed. Indefinitely: no later event
 * could repair it, because the change that mattered had already happened.
 *
 * Registered SEPARATELY from the bridge, like the presence store: a sync
 * arriving with no bridge running is the normal state for every fork user, so
 * it is an answer and never an error.
 */
let mirrorChangeSink: ((change: CompanionMirrorChange) => void) | null = null;

export function setCompanionMirrorChangeSink(
	sink: (change: CompanionMirrorChange) => void,
): void {
	if (mirrorChangeSink !== null && mirrorChangeSink !== sink) {
		throw new Error(
			`${LOG_PREFIX} a companion mirror-change sink is already registered; ` +
				"clear it (clearCompanionMirrorChangeSink) before registering another",
		);
	}
	mirrorChangeSink = sink;
}

/** Identity-checked, so a stopping bridge cannot unpublish its replacement. */
export function clearCompanionMirrorChangeSink(
	sink: (change: CompanionMirrorChange) => void,
): void {
	if (mirrorChangeSink === sink) mirrorChangeSink = null;
}

/**
 * Report a sync that CHANGED the mirror. Returns whether anything consumed it.
 *
 * Never throws into the caller. The mirror write has already committed by the
 * time this runs, and a freshness signal must not be able to turn a successful
 * curation write into a failed tRPC mutation — the desktop sidebar would then
 * retry a write that already landed.
 */
export function publishCompanionMirrorChanged(
	change: CompanionMirrorChange,
): boolean {
	const sink = mirrorChangeSink;
	if (sink === null) return false;
	try {
		sink(change);
		return true;
	} catch (error) {
		console.error(
			`${LOG_PREFIX} the mirror-change sink threw; the phone will fall back to its counts comparison for freshness`,
			error,
		);
		return false;
	}
}
