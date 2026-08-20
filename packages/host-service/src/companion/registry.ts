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
import type { LifecycleSeenInput } from "./lifecycle-alerts";
import type { PresenceBeaconInput, PresenceStore } from "./presence";
import type {
	AlertContextSnapshotInput,
	AlertContextSyncResult,
} from "./push-context";

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

// ---------------------------------------------------------------------------
// (ALERT-CONTEXT-NAMES) tab context, and the seen signal
// ---------------------------------------------------------------------------

/**
 * One published-sink slot: register, identity-checked clear, and a call that
 * cannot throw into its caller.
 *
 * The desktop-side writes this feature adds are published SEPARATELY from the
 * bridge for the same reason the presence store is. They arrive from a renderer
 * (or, for `terminal-gone`, from the host's own runtime) that has no idea
 * whether a companion bridge is running on this machine, on ordinary events —
 * a layout change, the user opening a chat, a pty exiting; routing them through
 * `requireBridge()` would turn the normal "no bridge here" state into a stream
 * of errors on paths the user triggers by clicking around.
 * So each answers "nobody consumed it" and the caller reports that plainly.
 *
 * They share this factory because the three rules are identical for all of them
 * and were previously written out per slot:
 *
 *  - REGISTERING OVER a live, different sink is a programming error, not a race
 *    to smooth over — two bridges in one process would disagree about who owns
 *    the renderer's state.
 *  - CLEARING is identity-checked, so a stopping bridge cannot unpublish the
 *    sink its replacement has already installed.
 *  - CALLING never throws into the caller. Every caller's real work has already
 *    happened by the time the sink runs — the dot cleared, the layout changed,
 *    the pty exited — so a sink that throws must not turn a successful action
 *    into a failed one.
 *
 * The presence and bridge slots above are deliberately NOT folded in: they have
 * their own semantics (a bridge slot that must not be replaced at all, a
 * presence store with a `record` method rather than a call) and collapsing
 * three different things into one shape would cost more than it saves.
 */
function createSinkSlot<Input, Result>(options: {
	/** Names the slot in the "already registered" error. */
	what: string;
	/** What a call answers when nothing is registered, or the sink threw. */
	whenAbsent: Result;
	/** Logged when the sink throws. Says what the user loses, not a stack. */
	onThrowMessage: string;
}) {
	let sink: ((input: Input) => Result) | null = null;
	return {
		set(next: (input: Input) => Result): void {
			if (sink !== null && sink !== next) {
				throw new Error(
					`${LOG_PREFIX} a companion ${options.what} sink is already registered; ` +
						"clear it before registering another",
				);
			}
			sink = next;
		},
		clear(previous: (input: Input) => Result): void {
			if (sink === previous) sink = null;
		},
		call(input: Input): Result {
			const current = sink;
			if (current === null) return options.whenAbsent;
			try {
				return current(input);
			} catch (error) {
				console.error(`${LOG_PREFIX} ${options.onThrowMessage}`, error);
				return options.whenAbsent;
			}
		},
	};
}

const alertContextSlot = createSinkSlot<
	AlertContextSnapshotInput,
	AlertContextSyncResult | null
>({
	what: "alert-context",
	whenAbsent: null,
	onThrowMessage:
		"the alert-context sink threw; companion alerts will name no tab until the next sync",
});

export const setCompanionAlertContextSink = alertContextSlot.set;
export const clearCompanionAlertContextSink = alertContextSlot.clear;

/**
 * Apply one workspace's tab-context snapshot. `null` means nothing consumed it,
 * which is the normal state on a machine with no companion bridge.
 */
export function recordCompanionAlertContexts(
	input: AlertContextSnapshotInput,
): AlertContextSyncResult | null {
	return alertContextSlot.call(input);
}

const lifecycleSeenSlot = createSinkSlot<LifecycleSeenInput, boolean>({
	what: "lifecycle-seen",
	whenAbsent: false,
	onThrowMessage:
		"the lifecycle-seen sink threw; a phone notification may outlive the chat the user just read",
});

export const setCompanionLifecycleSeenSink = lifecycleSeenSlot.set;
export const clearCompanionLifecycleSeenSink = lifecycleSeenSlot.clear;

/**
 * The user read a chat on the desktop. Returns whether anything consumed it.
 */
export function recordCompanionLifecycleSeen(
	input: LifecycleSeenInput,
): boolean {
	return lifecycleSeenSlot.call(input);
}

// ---------------------------------------------------------------------------
// (ALERT-RETIRE-ON-EXIT) the two retirement signals the desktop side owns
// ---------------------------------------------------------------------------

/**
 * (ALERT-RETIRE-ON-EXIT) A terminal process died.
 *
 * Published like the seen sink and for the same reason, with ONE difference in
 * where the caller sits: this one is the host runtime's own event bus, not a
 * renderer mutation. That makes it the more important of the two to keep
 * throw-proof — a companion sink that threw here would fail a PTY-exit
 * broadcast and leave every renderer's pane state stuck on a terminal that no
 * longer exists.
 */
const terminalGoneSlot = createSinkSlot<{ hostTerminalId: string }, boolean>({
	what: "terminal-gone",
	whenAbsent: false,
	onThrowMessage:
		"the terminal-gone sink threw; a phone notification may outlive the terminal it points at",
});

export const setCompanionTerminalGoneSink = terminalGoneSlot.set;
export const clearCompanionTerminalGoneSink = terminalGoneSlot.clear;

/**
 * A terminal's pty is confirmed dead. Returns whether anything consumed it.
 */
export function recordCompanionTerminalGone(input: {
	hostTerminalId: string;
}): boolean {
	return terminalGoneSlot.call(input);
}

/**
 * (ALERT-RETIRE-ON-EXIT) The desktop relaunched, and this is the host-clock
 * instant it came up at.
 *
 * Reported once per host per cold start by the renderer's resync, which is the
 * only thing that can put a desktop launch on a HOST's timeline (it derives the
 * boundary from the host's own `hostNow` minus the renderer's elapsed monotonic
 * time).
 */
const relaunchBoundarySlot = createSinkSlot<{ boundaryMs: number }, boolean>({
	what: "relaunch-boundary",
	whenAbsent: false,
	onThrowMessage:
		"the relaunch-boundary sink threw; ready notifications from before this launch may stay on the phone",
});

export const setCompanionRelaunchBoundarySink = relaunchBoundarySlot.set;
export const clearCompanionRelaunchBoundarySink = relaunchBoundarySlot.clear;

/**
 * The desktop relaunched at `boundaryMs` (host clock). Returns whether anything
 * consumed it.
 */
export function recordCompanionRelaunchBoundary(input: {
	boundaryMs: number;
}): boolean {
	return relaunchBoundarySlot.call(input);
}
