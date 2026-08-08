/**
 * (COMPANION-BRIDGE) — the DESKTOP side of the companion bridge.
 *
 * The bridge's own listener is sealed, device-authenticated and reachable from
 * the internet. These three operations are the opposite: they are the things
 * only the person AT THE MACHINE may do, and giving them a wire route would
 * defeat their purpose — a stolen phone must not be able to pair a second
 * device or re-enable the writes the panic switch just took away (§7.8:
 * "re-enable is desktop-only").
 *
 * So they live here, on the host-service's own authenticated tRPC surface,
 * behind `protectedProcedure`. The desktop app already speaks it; nothing on
 * the phone's path can reach it.
 *
 * WITHOUT THIS ROUTER THE FEATURE IS UNREACHABLE. `createCompanionBridge`
 * returns a handle whose `openPairing` opens the single 120 s LAN window — the
 * only way any device can ever pair — and whose `disableWrites` /
 * `revokeAllDevices` are the desktop panic switch. The mount seam in `serve.ts`
 * has nowhere to keep that handle (upstream's `serve()` callback is
 * synchronous), so it publishes it to `companion/registry` and this router is
 * what reads it back.
 *
 * Both halves now have a surface a human can reach: `PairDeviceDialog`
 * `(COMPANION-PAIRING-UI)` and `CompanionPanicSetting` `(COMPANION-PANIC-UI)`,
 * both in Experimental settings. Before those existed the panic switch was a
 * route only a hand-crafted PSK request could call, which is the same as not
 * having one.
 *
 * WHAT IT CAN SAY ABOUT THE DEVICE STORE — exactly one number. The keep-awake
 * gate in Electron main (`apps/desktop/src/main/lib/keep-awake/
 * companion-gate.ts`) used to count pairings by reading `devices.json` off
 * disk; (DEVICE-INDEX-DB) retired that file — the index is rows in host.db
 * that only the bridge's device store can read — so `CompanionBridge` exposes
 * `pairedDeviceCount()` and the `gate` query below is how main reaches it.
 * That is the whole read surface: whether writes are currently enabled is
 * still unreported, and the panic UI states only the counts these mutations
 * themselves return. See the note on `disableWrites`.
 *
 * IT NEVER CONSTRUCTS A BRIDGE. If none is registered the answer is a typed
 * refusal naming the remedy — never an implicit start, because an
 * internet-exposed listener that can type into terminals comes up on an
 * explicit opt-in or not at all.
 *
 * It is also where the pairing window's OUTCOME is remembered
 * (`(COMPANION-PAIRING-STATE)` below): the bridge hands `openPairing` a handle
 * and keeps no way to ask about it later, so the only caller of `openPairing`
 * is the only place a `pairingState` read can come from.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import type { CompanionBridge } from "../../../companion";
import { PANIC_REASON_MAX_CHARS } from "../../../companion/limits";
import type { PairingWindowHandle } from "../../../companion/pairing";
import {
	type ProvenVersionStatus,
	resolveProvenVersionStatus,
} from "../../../companion/proven-version";
import {
	type CompanionBridgeStatus,
	getCompanionBridge,
	readCompanionBridgeStatus,
	recordCompanionPresenceBeacon,
} from "../../../companion/registry";
import { protectedProcedure, router } from "../../index";

/**
 * §7.8 bounds the wire panic reason at `PANIC_REASON_MAX_CHARS`; the desktop
 * switch writes to the same audit log, so it is held to the same shape — the one
 * constant, imported, not a second copy of 200. Non-empty is enforced by
 * `applyDesktopPanic` too — this just refuses it at the boundary, where the
 * caller can still be told which field was wrong.
 */
const panicInput = z.object({
	reason: z.string().min(1).max(PANIC_REASON_MAX_CHARS),
});

/**
 * (PUSH-PRESENCE) The desktop presence beacon, validated at the boundary.
 *
 * Every field is required and every field is constrained, because this decides
 * whether a blocked agent's question buzzes a phone. `idleSeconds` is a
 * non-negative integer (`powerMonitor.getSystemIdleTime()` is whole seconds);
 * `locked` is a real boolean, never a truthy string; `event` is a closed enum,
 * so a sender that invents a fifth kind is a 400 here rather than a value the
 * store silently files under "not a resume".
 *
 * No upper bound on `idleSeconds` on purpose: a machine idle for a week is a
 * legitimate reading, and the presence rules only ever compare it against a
 * 60 s window.
 */
const presenceBeaconInput = z.object({
	idleSeconds: z.number().int().min(0),
	locked: z.boolean(),
	event: z.enum(["tick", "lock", "unlock", "resume"]),
});

/**
 * The live bridge, or a typed refusal that says exactly what to do about it.
 * The two "off" cases are NOT collapsed: "you never turned it on" and "you
 * turned it on and it did not come up" need different actions from the user,
 * and reporting the second as the first would send them to set an env var that
 * is already set.
 */
function requireBridge(): CompanionBridge {
	const bridge = getCompanionBridge();
	if (bridge?.running) return bridge;

	const status = readCompanionBridgeStatus();
	throw new TRPCError({
		code: "PRECONDITION_FAILED",
		message: status.enabled
			? "The companion bridge is enabled but not running — it failed to start. " +
				"The host-service log carries the reason (search for [companion-bridge])."
			: "The companion bridge is off. Set SUPERSET_COMPANION_BRIDGE=1 and restart " +
				"the host-service to enable it.",
	});
}

/**
 * (COMPANION-PAIRING-STATE) What the desktop is allowed to say about a window
 * that is no longer open.
 *
 * A pairing window ends for opposite reasons — a phone completed §4.4 step 5,
 * or the 120 s simply ran out — and a dialog that renders both as "expired"
 * tells the user their successful pairing failed. `PairingWindowHandle.closed`
 * is the fact that makes them separable, and its own comment says holders must
 * not have to provoke the `qrUri` getter's 410 to read it; this query is what
 * finally surfaces it.
 *
 * HONEST LIMIT — `closed` is a bare boolean. The bridge closes a window early
 * on a successful pairing, on three bad MACs burning the code (§4.7), and on an
 * unexpected 500 inside the exchange, and the handle does not say which. So
 * `closed-early` is reported as exactly that and NOT as "paired": claiming a
 * pairing an attacker's burn produced would be worse than the bug being fixed.
 *
 * FOLLOW-UP to make it exact: `PairingWindowHandle` (`companion/pairing.ts`)
 * needs a `readonly closedReason: "paired" | "burned" | "closed" | "error" |
 * null` set at the point each close path already runs, surfaced through the
 * handle's `toJSON()` alongside `closed`. This query would then map it to a
 * `{ kind: "paired" }` member and `PairDeviceDialog` could finally confirm a
 * pairing instead of pointing the user at their phone.
 */
export type CompanionPairingState =
	/** No window opened through this router is live. Never a failure by itself. */
	| { kind: "none" }
	| { kind: "open"; expiresAtMs: number }
	/** Ended BEFORE its deadline: a device finished, or the code was burned. */
	| { kind: "closed-early"; expiresAtMs: number }
	/** Ran out the clock with nothing having consumed it. */
	| { kind: "expired"; expiresAtMs: number };

interface TrackedPairingWindow {
	/**
	 * The bridge that opened it. Identity-checked on every read so a record left
	 * behind by a stopped bridge can never be reported as a live window of the
	 * one that replaced it — the same reason `clearCompanionBridge` checks.
	 */
	readonly bridge: CompanionBridge;
	readonly handle: PairingWindowHandle;
	/**
	 * `Date.now()` at the FIRST read that saw `handle.closed`, latched.
	 *
	 * The only exact verdict available is "it was already closed while the clock
	 * still had time left" — nothing else could have closed it, because the
	 * bridge's expiry timer fires at `expiresAtMs` and not a millisecond sooner.
	 * That fact stops being observable once the deadline passes, so it is kept.
	 * Without the latch a dialog left open past the deadline would watch a window
	 * that ended at t=30 s be re-reported as one that ran out at t=120 s.
	 */
	observedClosedAtMs: number | null;
}

/**
 * The window this router last opened. Module-level for the same reason
 * `companion/registry` is: the bridge hands `openPairing` a handle and has
 * nowhere to keep it, and this router is the only caller of `openPairing` in
 * the product, so it is the only place that can remember one.
 */
let trackedPairingWindow: TrackedPairingWindow | null = null;

/**
 * (COMPANION-PANIC-UI) `CompanionBridgeStatus` plus the one boundary constant
 * the desktop panic UI needs.
 *
 * The cap is DELIVERED rather than duplicated: `packages/host-service` publishes
 * no `./companion` subpath, so the renderer cannot import
 * `companion/limits.ts`, and a second literal `200` in a React component is
 * exactly the drift `limits.ts` was created to end. Publishing it from the
 * boundary that ENFORCES it makes them incapable of disagreeing.
 */
export interface CompanionStatus extends CompanionBridgeStatus {
	/** §7.8 panic-reason cap. The UI's `maxLength` must be this and nothing else. */
	panicReasonMaxChars: number;
}

/**
 * (KEEP-AWAKE) What the `gate` query answers with. Booleans and a count, all
 * three always present — the gate validates this shape at its own boundary,
 * so a field that becomes optional here is a hard error there, not a silently
 * sleeping machine.
 */
export interface CompanionGateStatus {
	/** `SUPERSET_COMPANION_BRIDGE=1` as THIS process sees it. */
	bridgeEnabled: boolean;
	/** Enabled AND the sealed listener actually came up. */
	bridgeRunning: boolean;
	/** Live pairings (revoked-but-retained records excluded). 0 unless running. */
	pairedDeviceCount: number;
	/**
	 * (PROVEN-VERSION-DRIFT) Whether the installed Claude Code is the build the
	 * AskUserQuestion picker contract was proven against.
	 *
	 * Always present, like everything else here, so a consumer cannot silently
	 * read `undefined` as "fine". `installed: null` means the CLI could not be
	 * located, and `mismatch` is then FALSE — unknown is not drift. Nothing about
	 * this field refuses an answer; it exists so the drift is VISIBLE rather than
	 * discovered by a user being refused.
	 */
	pickerContract: ProvenVersionStatus;
}

export const companionRouter = router({
	/**
	 * Whether the feature is on, and whether it actually came up. A UI must be
	 * able to tell those apart before it offers a Pair button that can only fail.
	 */
	status: protectedProcedure.query((): CompanionStatus => {
		return {
			...readCompanionBridgeStatus(),
			panicReasonMaxChars: PANIC_REASON_MAX_CHARS,
		};
	}),

	/**
	 * (KEEP-AWAKE) The authoritative paired-count read for the main-process
	 * keep-awake gate, polled every tick while agents work.
	 *
	 * Unlike everything below it NEVER throws for the off states: bridge-off is
	 * the normal state for every fork user, and a poll that 500s on the normal
	 * state trains its caller to treat errors as routine. The off states are
	 * answers here — `bridgeRunning: false` with a zero count — and an error is
	 * reserved for what IS exceptional (the bridge stopping between the
	 * `running` check and the store read, which tRPC surfaces as a 500 and the
	 * gate treats as "keep the hold you have, acquire nothing").
	 */
	gate: protectedProcedure.query(async (): Promise<CompanionGateStatus> => {
		const status = readCompanionBridgeStatus();
		const bridge = getCompanionBridge();
		const running = bridge?.running === true;
		return {
			bridgeEnabled: status.enabled,
			bridgeRunning: running,
			pairedDeviceCount:
				running && bridge ? await bridge.pairedDeviceCount() : 0,
			pickerContract: await resolveProvenVersionStatus(),
		};
	}),

	/**
	 * (PUSH-PRESENCE) One desktop presence beacon: OS idle time and lock state,
	 * from Electron main's `powerMonitor`.
	 *
	 * A MUTATION, not a query — it changes server state (the presence store) and
	 * must never be cached, batched or replayed by a client the way a query may
	 * be.
	 *
	 * Like `gate` and unlike everything below it, this NEVER throws for the off
	 * states. Bridge off is the normal state for every fork user, and the beacon
	 * arrives on a 15 s desktop timer whether or not anything is listening: a
	 * mutation that 500s on the normal state would fill the log with a failure
	 * that is not one, and would train its caller to ignore real ones. The data is
	 * advisory — with nothing to receive it the push simply falls back to
	 * keystroke evidence alone — so an unconsumed beacon is `accepted: false`,
	 * stated plainly, and dropped.
	 */
	presenceBeacon: protectedProcedure
		.input(presenceBeaconInput)
		.mutation(({ input }): { accepted: boolean } => {
			return { accepted: recordCompanionPresenceBeacon(input) };
		}),

	/**
	 * READ-ONLY. Reports the window this router last opened; it never opens one,
	 * never closes one, and never touches the code or the URI — polling it must
	 * be safe, and a `pairingState` that closed the window would destroy the very
	 * thing it was asked about.
	 *
	 * The one write it performs is `observedClosedAtMs`: memoising the instant an
	 * already-decided fact was first seen, so a later poll cannot un-see it. No
	 * bridge state changes.
	 */
	pairingState: protectedProcedure.query((): CompanionPairingState => {
		const bridge = requireBridge();
		const tracked = trackedPairingWindow;
		if (tracked === null || tracked.bridge !== bridge) {
			return { kind: "none" };
		}

		const { handle } = tracked;
		const expiresAtMs = handle.expiresAtMs;
		if (!handle.closed) {
			return { kind: "open", expiresAtMs };
		}

		if (tracked.observedClosedAtMs === null) {
			tracked.observedClosedAtMs = Date.now();
		}
		return {
			kind:
				tracked.observedClosedAtMs < expiresAtMs ? "closed-early" : "expired",
			expiresAtMs,
		};
	}),

	/**
	 * Opens the single 120 s LAN pairing window and returns the QR URI to render.
	 *
	 * The URI's fragment holds a single-use pairing code. It is returned over
	 * this authenticated local channel and is NOT part of any response that
	 * leaves the machine. Errors are deliberately not remapped: "a window is
	 * already open" and "47611 is taken" are different problems and neither is
	 * improved by being flattened into one code.
	 */
	openPairing: protectedProcedure.mutation(
		async (): Promise<{ qrUri: string; expiresAtMs: number }> => {
			const bridge = requireBridge();
			const handle = await bridge.openPairing();
			// Remembered so `pairingState` has something to report. Set only after a
			// successful open: a failed one leaves no window, and a record of a
			// window that never existed would be read as a window that ended.
			trackedPairingWindow = { bridge, handle, observedClosedAtMs: null };
			return { qrUri: handle.qrUri, expiresAtMs: handle.expiresAtMs };
		},
	),

	/**
	 * Takes the LAN pairing listener down before its 120 s are up — the user
	 * dismissed the QR, so the window should not outlive the dialog. `false`
	 * means there was nothing open.
	 */
	closePairing: protectedProcedure.mutation(
		async (): Promise<{ closed: boolean }> => {
			const closed = await requireBridge().closePairing();
			// The desktop asked for this one, so there is no outcome left to report:
			// dropping the record is what stops a deliberate dismissal from being
			// read back as "a device paired" by the next `pairingState`.
			trackedPairingWindow = null;
			return { closed };
		},
	),

	/**
	 * THE PANIC SWITCH. Strips write access from every paired device without
	 * unpairing: the phone keeps reading and keeps showing the user why it
	 * stopped writing. There is no re-enable here or anywhere on the wire — §7.8
	 * makes restoring privilege a desktop-only, deliberate act.
	 *
	 * Driven by `CompanionPanicSetting` in Experimental settings
	 * `(COMPANION-PANIC-UI)`. Do not delete this without deleting that.
	 *
	 * HONEST GAP — the desktop-only re-enable §7.8 promises does not exist yet.
	 * `DeviceStore.setWriteEnabled(id, true)` is implemented and has zero
	 * callers; `CompanionBridge` exposes no `enableWrites`, so this router cannot
	 * offer one and the UI says so plainly instead of implying a reversal it
	 * cannot perform. Closing it needs `enableWrites(reason)` on `CompanionBridge`
	 * (`companion/index.ts`), routed through `applyDesktopPanic`'s audit pattern.
	 */
	disableWrites: protectedProcedure
		.input(panicInput)
		.mutation(async ({ input }): Promise<{ devicesAffected: number }> => {
			return {
				devicesAffected: await requireBridge().disableWrites(input.reason),
			};
		}),

	/** Revokes every paired device. Each one must pair again from scratch. */
	revokeAllDevices: protectedProcedure
		.input(panicInput)
		.mutation(async ({ input }): Promise<{ devicesAffected: number }> => {
			return {
				devicesAffected: await requireBridge().revokeAllDevices(input.reason),
			};
		}),
});
