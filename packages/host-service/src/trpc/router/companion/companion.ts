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
 * WHAT IT STILL CANNOT SAY. `CompanionBridge` exposes no read of the device
 * store, so this router cannot report how many devices are paired or whether
 * their writes are currently enabled. It therefore reports NOTHING about that
 * rather than guessing, and the panic UI states only the counts these mutations
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
	type CompanionBridgeStatus,
	getCompanionBridge,
	readCompanionBridgeStatus,
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
