/**
 * (KEEP-AWAKE) Wiring: evaluate the companion gate, poll the authoritative
 * agent-activity signal, and drive the power request.
 *
 * Start from the main window bootstrap; stop on window close. Everything the
 * feature does is here, in `keep-awake.ts` (the blocker), `companion-gate.ts`
 * (is the companion actually in use) and `agent-activity.ts` (the read) —
 * nothing else in the app is touched.
 *
 * TWO INDEPENDENT CONDITIONS, BOTH REQUIRED
 * -----------------------------------------
 * The machine is held awake only while the companion gate is OPEN (bridge
 * enabled AND at least one device paired) and an agent is working or a question
 * is pending. The gate is re-read every tick rather than once at startup, so
 * pairing arms the feature and `unpair_all` disarms it without an app restart.
 *
 * Deliberately NOT a disk publisher: nothing outside this process consumes the
 * blocker's state. PROTOCOL.md §7.7 defines `HeartbeatResponse` and has no
 * keep-awake field, so the phone learns about a refused power request the same
 * way every other desktop-side fault surfaces — the desktop log, and the phone's
 * own liveness watchdog when contact is actually lost. An earlier revision
 * mirrored the state to `~/.superset/companion/keep-awake.json` for a bridge
 * reader that the protocol never specified and that was never written.
 *
 * `startKeepAwake` / `stopKeepAwake` are the whole public surface — `main.ts`
 * imports exactly those two, and the unit tests import the leaf modules
 * directly. Re-exporting those modules' types and constants from here only made
 * a wider API than the feature has.
 */

import { powerMonitor, powerSaveBlocker } from "electron";
import log from "electron-log/main";
import { POLL_INTERVAL_MS, pollAgentActivity } from "./agent-activity";
import { type CompanionGatePoll, pollCompanionGate } from "./companion-gate";
import { KeepAwakeManager } from "./keep-awake";
import {
	initialisePresenceLockState,
	type PresenceBeaconEvent,
	resetPresenceBeaconState,
	sendPresenceBeacon,
} from "./presence-beacon";

/** Shout after this many consecutive failed reads rather than warning forever. */
const READ_FAILURE_ALARM_AFTER = 4;

let manager: KeepAwakeManager | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;
let consecutivePollFailures = 0;
let consecutiveGateFailures = 0;
/** null until the gate has been evaluated once; only transitions are logged. */
let lastGateOpen: boolean | null = null;
/**
 * (PUSH-PRESENCE) One un-subscriber per powerMonitor listener `startKeepAwake`
 * added, so `stopKeepAwake` removes exactly those.
 *
 * Closures rather than `{signal, handler}` pairs on purpose: Electron types
 * `powerMonitor.on` as an overload per signal name, so a variable holding the
 * union of signal names matches none of them. Keeping each name a literal at its
 * call site is what makes both the add and the remove type-check.
 *
 * Anonymous inline handlers would be unremovable, and start/stop is idempotent
 * by contract — a second start would then double every beacon forever.
 */
let powerListeners: Array<() => void> = [];

/**
 * (PUSH-PRESENCE) A step change in presence, reported at once instead of waiting
 * up to one poll interval.
 *
 * `sendPresenceBeacon` never rejects, so this can be fire-and-forget without a
 * catch that would only ever be dead code.
 */
function beacon(event: PresenceBeaconEvent): void {
	void sendPresenceBeacon(event, { powerMonitor });
}

/** One line whenever the feature arms or disarms, never once per tick. */
function logGateTransition(
	gate: Extract<CompanionGatePoll, { ok: true }>,
): void {
	if (lastGateOpen === gate.open) return;
	lastGateOpen = gate.open;
	log.info(
		gate.open
			? "[keep-awake] companion gate open — the machine will be held awake while agents work"
			: "[keep-awake] companion gate closed — the machine will never be held awake",
		{
			bridgeEnabled: gate.bridgeEnabled,
			bridgeRunning: gate.bridgeRunning,
			// 0 with bridgeRunning false means "unknowable", not "none paired" —
			// a down bridge has no device store to count from.
			pairedDeviceCount: gate.pairedDeviceCount,
		},
	);
}

async function tick(): Promise<void> {
	// Ticks never overlap: a slow host-service must not stack requests.
	if (inFlight || !manager) return;
	inFlight = true;
	try {
		// (PUSH-PRESENCE) Piggybacked on this tick rather than given its own timer.
		// It cannot break the tick: `sendPresenceBeacon` resolves to an outcome on
		// every path, including a host-service that refuses the POST, and
		// short-circuits to `skipped` before any I/O when the bridge is off.
		await sendPresenceBeacon("tick", { powerMonitor });

		const gate = await pollCompanionGate();
		if (!gate.ok) {
			consecutiveGateFailures += 1;
			const held = manager.getState().held;
			const detail = {
				error: gate.error,
				consecutiveFailures: consecutiveGateFailures,
				holdUnchanged: held,
			};
			if (consecutiveGateFailures >= READ_FAILURE_ALARM_AFTER) {
				log.error("[keep-awake] cannot read the companion gate", detail);
			} else {
				log.warn("[keep-awake] companion gate read failed", detail);
			}
			// An unreadable gate is not proof that the companion is in use, so it
			// can never ACQUIRE. It is not proof of the opposite either: a hold
			// that is already live was proven open by an earlier read, and
			// dropping it on a transient fs error would put the machine to sleep
			// mid-question. Keep it, and fall through so the normal
			// agents-went-idle release still runs.
			if (!held) return;
		} else {
			if (consecutiveGateFailures > 0) {
				log.info("[keep-awake] companion gate read recovered", {
					afterFailures: consecutiveGateFailures,
				});
			}
			consecutiveGateFailures = 0;
			logGateTransition(gate);
			if (!gate.open) {
				// Release immediately, and never ask the host-service anything:
				// with no companion there is nothing to keep the machine awake
				// for. Idempotent — a closed gate on an idle desktop is silent.
				manager.update([]);
				return;
			}
		}

		const poll = await pollAgentActivity();
		if (!poll.ok) {
			consecutivePollFailures += 1;
			// DO NOT call manager.update([]) here. A failed read is not proof of
			// idleness; treating it as one would release the machine to sleep
			// mid-turn on a transient loopback error.
			const detail = {
				error: poll.error,
				consecutiveFailures: consecutivePollFailures,
				holdUnchanged: manager.getState().held,
			};
			if (consecutivePollFailures >= READ_FAILURE_ALARM_AFTER) {
				log.error("[keep-awake] cannot read agent activity", detail);
			} else {
				log.warn("[keep-awake] agent-activity read failed", detail);
			}
			return;
		}

		if (consecutivePollFailures > 0) {
			log.info("[keep-awake] agent-activity read recovered", {
				afterFailures: consecutivePollFailures,
			});
		}
		consecutivePollFailures = 0;
		manager.update(poll.active);
	} finally {
		inFlight = false;
	}
}

/**
 * Begin holding the machine awake while agents work AND the companion is in
 * use. Idempotent.
 *
 * Started unconditionally on purpose: the gate is a per-tick predicate, not a
 * boot-time one. Deciding at startup would mean pairing a phone had no effect
 * until the app was restarted, and the cost of a closed gate is one string
 * comparison every 15 s with no disk and no network I/O at all.
 *
 * The first read happens on the next tick, not synchronously, so startup is not
 * delayed by a host-service that is still binding its port.
 */
export function startKeepAwake(): void {
	if (manager) return;
	manager = new KeepAwakeManager({
		powerSaveBlocker,
		logger: {
			info: (message, meta) => log.info(message, meta),
			warn: (message, meta) => log.warn(message, meta),
			error: (message, meta) => log.error(message, meta),
		},
	});
	timer = setInterval(() => {
		void tick();
	}, POLL_INTERVAL_MS);
	// Do not keep the event loop alive purely for this.
	timer.unref();

	// (PUSH-PRESENCE) Seed the lock state from the OS before any beacon goes out:
	// an app launched into an already-locked session must not spend its first
	// beacons claiming the user is present.
	initialisePresenceLockState({ powerMonitor });
	const onLock = () => beacon("lock");
	const onUnlock = () => beacon("unlock");
	const onResume = () => beacon("resume");
	powerMonitor.on("lock-screen", onLock);
	powerMonitor.on("unlock-screen", onUnlock);
	powerMonitor.on("resume", onResume);
	powerListeners = [
		() => powerMonitor.removeListener("lock-screen", onLock),
		() => powerMonitor.removeListener("unlock-screen", onUnlock),
		() => powerMonitor.removeListener("resume", onResume),
	];

	log.info("[keep-awake] started", { pollIntervalMs: POLL_INTERVAL_MS });
}

/** Release the power request and stop polling. Idempotent. */
export function stopKeepAwake(): void {
	if (timer) {
		clearInterval(timer);
		timer = null;
	}
	for (const off of powerListeners) off();
	powerListeners = [];
	resetPresenceBeaconState();
	if (!manager) return;
	manager.dispose();
	manager = null;
	consecutivePollFailures = 0;
	consecutiveGateFailures = 0;
	lastGateOpen = null;
	log.info("[keep-awake] stopped");
}
