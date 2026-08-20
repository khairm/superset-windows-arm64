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
 * returns a handle whose `openPairing` / `openRemotePairing` open the single
 * 120 s window — QR over the LAN, or an 8-digit code over the tunnel
 * `(REMOTE-CODE-PAIRING)`, and those are the only two ways any device can ever
 * pair — and whose `disableWrites` / `revokeAllDevices` are the desktop panic
 * switch. The mount seam in `serve.ts`
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
import type {
	PairingKind,
	PairingWindowHandleBase,
} from "../../../companion/pairing";
import {
	type ProvenVersionStatus,
	resolveProvenVersionStatus,
} from "../../../companion/proven-version";
import {
	ALERT_CONTEXT_MAX_TAB_COUNT,
	ALERT_CONTEXT_MAX_TERMINALS_PER_WORKSPACE,
	ALERT_CONTEXT_MAX_TITLE_CHARS,
	type AlertContextSyncOutcome,
} from "../../../companion/push-context";
import {
	type CompanionBridgeStatus,
	getCompanionBridge,
	readCompanionBridgeStatus,
	recordCompanionAlertContexts,
	recordCompanionLifecycleSeen,
	recordCompanionPresenceBeacon,
	recordCompanionRelaunchBoundary,
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
 * (REMOTE-CODE-PAIRING) `pairingKind` says WHICH way in the window was opened,
 * so a dialog showing a typed code and a dialog showing a QR cannot read each
 * other's verdict. The dialog can switch modes while a window is open, and
 * without this a verdict about the window it just replaced would render as a
 * verdict about the one on screen.
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
	| { kind: "open"; pairingKind: PairingKind; expiresAtMs: number }
	/** Ended BEFORE its deadline: a device finished, or the code was burned. */
	| { kind: "closed-early"; pairingKind: PairingKind; expiresAtMs: number }
	/** Ran out the clock with nothing having consumed it. */
	| { kind: "expired"; pairingKind: PairingKind; expiresAtMs: number };

interface TrackedPairingWindow {
	/**
	 * The bridge that opened it. Identity-checked on every read so a record left
	 * behind by a stopped bridge can never be reported as a live window of the
	 * one that replaced it — the same reason `clearCompanionBridge` checks.
	 */
	readonly bridge: CompanionBridge;
	readonly handle: PairingWindowHandleBase;
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

/**
 * (ALERT-CONTEXT-NAMES) One workspace's tab context, validated at the boundary.
 *
 * Every bound is stated here rather than trusted from the renderer, and the
 * caps are the registry's own constants rather than second copies of them:
 * `limits.ts`'s lesson is that a literal duplicated at a boundary drifts from
 * the thing it is supposed to describe.
 *
 * `tabTitle` is OPTIONAL and nullable because "no title resolved" is an
 * ordinary answer — a terminal whose program has set none, a pane the renderer
 * cannot name — and turning it into a 400 would cost the whole snapshot, and
 * therefore every OTHER tab's title, over one unnameable pane.
 */
const alertContextsInput = z.object({
	workspaceId: z.string().min(1).max(128),
	tabCount: z.number().int().min(0).max(ALERT_CONTEXT_MAX_TAB_COUNT),
	terminals: z
		.array(
			z.object({
				terminalId: z.string().min(1).max(128),
				tabTitle: z.string().max(ALERT_CONTEXT_MAX_TITLE_CHARS).nullish(),
			}),
		)
		.max(ALERT_CONTEXT_MAX_TERMINALS_PER_WORKSPACE),
});

/**
 * (ALERT-CONTEXT-NAMES) "The user read this chat." `seenThroughAt` is the
 * binding's `lastEventAt` — the HOST's clock, never the renderer's — because it
 * is hashed into the alert id the retraction has to name. A renderer timestamp
 * would miss by whatever the two clocks disagree by, which across a relay is
 * routinely seconds, and a missed id retracts nothing.
 */
const lifecycleSeenInput = z.object({
	workspaceId: z.string().min(1).max(128),
	terminalId: z.string().min(1).max(128),
	seenThroughAt: z.number().int().positive(),
});

/**
 * (ALERT-RETIRE-ON-EXIT) The instant this desktop launch came up, on the HOST's
 * clock.
 *
 * `.int()` IS SAFE HERE ONLY BECAUSE THE RENDERER FLOORS. The raw value it
 * derives is fractional — `hostNow` minus a `performance.now()` delta — and an
 * unfloored one would be refused at this boundary and silently lose the whole
 * feature for that host. The floor lives at the call site, next to the
 * subtraction that makes it fractional; this line is what makes forgetting it
 * loud rather than quiet.
 */
const relaunchBoundaryInput = z.object({
	boundaryMs: z.number().int().positive(),
});

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
	 * (ALERT-CONTEXT-NAMES) One hydrated workspace's tab context, from the
	 * renderer — the only process that knows what a tab is called.
	 *
	 * DESKTOP-ONLY BY CONSTRUCTION, like everything else on this router: it sits
	 * behind `protectedProcedure`, and nothing on the phone's sealed path can
	 * reach it. That matters more here than for the reads beside it, because this
	 * is the one input that decides what TEXT a notification carries.
	 *
	 * Like `gate` and `presenceBeacon`, it NEVER throws for the off states. It is
	 * driven by ordinary UI events on every machine, and bridge-off is the normal
	 * state for most of them: `accepted: false` is the answer, not an error.
	 */
	syncAlertContexts: protectedProcedure.input(alertContextsInput).mutation(
		({
			input,
		}): {
			accepted: boolean;
			outcome: AlertContextSyncOutcome | null;
			terminals: number;
		} => {
			// APPLIED SYNCHRONOUSLY, and that is the whole ordering story: the
			// registry's replace does no I/O and never yields, so two snapshots for
			// one workspace cannot interleave and the one whose handler runs second
			// is the one that stands. An earlier revision queued these on a
			// per-workspace promise chain, which bought nothing over that and only
			// added a map to keep bounded.
			const applied = recordCompanionAlertContexts({
				hostWorkspaceId: input.workspaceId,
				tabCount: input.tabCount,
				terminals: input.terminals.map((terminal) => ({
					terminalId: terminal.terminalId,
					tabTitle: terminal.tabTitle ?? null,
				})),
			});
			return {
				accepted: applied !== null,
				outcome: applied?.outcome ?? null,
				terminals: applied?.terminals ?? 0,
			};
		},
	),

	/**
	 * (ALERT-CONTEXT-NAMES) The user opened the chat on the desktop, so the
	 * ready-for-review notification on their phone and watch is stale.
	 *
	 * Fired ONLY from the two user-intent sites in the renderer (focus-clear and
	 * the sidebar mark-read), never from the store's resync seeding — a cold
	 * start that seeded seen marks for every idle terminal would otherwise
	 * mass-retract on every desktop launch. The renderer owns that rule; this is
	 * the boundary that validates the shape.
	 *
	 * Also never throws for the off states, and for the same reason: the dot has
	 * already cleared locally by the time this runs, and a failed retraction must
	 * not present to the user as a failed mark-read.
	 */
	markLifecycleSeen: protectedProcedure
		.input(lifecycleSeenInput)
		.mutation(({ input }): { accepted: boolean } => {
			return {
				accepted: recordCompanionLifecycleSeen({
					hostTerminalId: input.terminalId,
					hostWorkspaceId: input.workspaceId,
					seenThroughAt: input.seenThroughAt,
				}),
			};
		}),

	/**
	 * (ALERT-RETIRE-ON-EXIT) The desktop relaunched: take down the ready cards
	 * for finishes that predate this launch.
	 *
	 * ONE REPORT PER HOST PER COLD START, latched in the renderer. It is not a
	 * heartbeat and must not become one: the boundary it carries is the instant
	 * THIS launch came up, so re-sending it after a reconnect would be a lie
	 * about a launch that already happened, and re-sending it after a genuine
	 * relaunch is exactly what a new latch does.
	 *
	 * Never throws for the off states, like `markLifecycleSeen` and for the same
	 * reason: bridge-off is the normal state on most machines and this fires
	 * unprompted on every launch. `accepted: false` is the answer, not an error.
	 */
	retireStaleReadyAlerts: protectedProcedure
		.input(relaunchBoundaryInput)
		.mutation(({ input }): { accepted: boolean } => {
			return {
				accepted: recordCompanionRelaunchBoundary({
					boundaryMs: input.boundaryMs,
				}),
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
		const pairingKind = handle.kind;
		if (!handle.closed) {
			return { kind: "open", pairingKind, expiresAtMs };
		}

		if (tracked.observedClosedAtMs === null) {
			tracked.observedClosedAtMs = Date.now();
		}
		return {
			kind:
				tracked.observedClosedAtMs < expiresAtMs ? "closed-early" : "expired",
			pairingKind,
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
	 * (REMOTE-CODE-PAIRING) Opens the same single 120 s window in CODE mode and
	 * returns the 8 digits for the user to read off the screen and type into the
	 * phone. Works from any network — nothing in this flow needs the phone to
	 * reach this machine's LAN address.
	 *
	 * The digits are returned over this AUTHENTICATED LOCAL channel and are not
	 * part of any response that leaves the machine. Errors are deliberately not
	 * remapped: "a window is already open" and "the pairing Access application is
	 * not configured" are different problems with different remedies, and the
	 * second one's message names the file to create.
	 */
	openRemotePairing: protectedProcedure.mutation(
		async (): Promise<{ code: string; expiresAtMs: number }> => {
			const bridge = requireBridge();
			const handle = await bridge.openRemotePairing();
			trackedPairingWindow = { bridge, handle, observedClosedAtMs: null };
			return { code: handle.code, expiresAtMs: handle.expiresAtMs };
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
