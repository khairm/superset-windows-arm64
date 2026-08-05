/**
 * (PUSH-PRESENCE) Is the user in front of this desktop right now?
 *
 * WHAT THIS DECIDES
 * -----------------
 * Whether a blocked agent's question buzzes the phone. Away -> it buzzes
 * IMMEDIATELY, because the user cannot see it and latency is the whole product.
 * Present -> it is held indefinitely and never buzzes, because they CAN see it
 * and a notification for a question already on their screen is exactly the noise
 * that gets a watch muted. This replaced a blanket 3-minute delay, which was
 * wrong in both directions at once: three minutes of dead air when nobody was
 * there, and a buzz at 3:00 for a question being read at 2:59.
 *
 * TWO SIGNALS, NEITHER SUFFICIENT ALONE
 * -------------------------------------
 *  1. HUMAN KEYSTROKES (`human-input.ts`). Proof of presence, but only inside
 *     Superset: a user reading a long agent transcript, or working in another
 *     window with Superset visible on a second monitor, types nothing here for
 *     minutes at a time while being entirely available.
 *  2. THE ELECTRON BEACON (`apps/desktop/src/main/lib/keep-awake/
 *     presence-beacon.ts`). `powerMonitor.getSystemIdleTime()` sees the whole
 *     OS, so it covers case (1) — but it is a periodic POST from another
 *     process, so it can be stale, absent (bridge started before the desktop
 *     tick, an older desktop build) or wrong across a suspend.
 *
 * So: either signal can prove presence, and NEITHER proving it is what makes the
 * verdict "away". A stale or absent beacon degrades to keystrokes alone, which
 * under-reports presence — i.e. it errs towards pushing. That is the correct
 * direction: an unnecessary buzz is an annoyance, a suppressed question is a
 * blocked agent nobody knows about.
 *
 * THE ONE OVERRIDE — A LOCKED SCREEN
 * ----------------------------------
 * A `locked` beacon beats a fresh keystroke. The keystroke rule alone would keep
 * a question held for up to `PRESENCE_WINDOW_MS` after the user typed, locked
 * the machine and walked away — which is precisely the moment the push exists
 * for. Locking is an explicit, unambiguous statement of absence, so it decides.
 * Nothing else overrides: idleness is inferred, locking is declared.
 *
 * THERE IS NO CEILING ON A HOLD
 * -----------------------------
 * While the user is demonstrably present the push is held FOREVER, not for some
 * maximum. A ceiling would mean "you have been sitting here looking at this
 * question for N minutes, so let me also buzz your wrist", which is a
 * notification about something already in front of them. Questions still expire
 * (`PUSH_QUESTION_EXPIRY_MS`), and the moment presence lapses the held question
 * fires — the hold is released by absence, never by a timer.
 */

import { BEACON_FRESH_MS, PRESENCE_WINDOW_MS } from "./config";
import { msSinceHumanInput } from "./human-input";

/** The event vocabulary the desktop beacon may send. Validated at both boundaries. */
export const PRESENCE_BEACON_EVENTS = [
	"tick",
	"lock",
	"unlock",
	"resume",
] as const;

export type PresenceBeaconEvent = (typeof PRESENCE_BEACON_EVENTS)[number];

export interface PresenceBeaconInput {
	/** `powerMonitor.getSystemIdleTime()` — whole seconds since any OS input. */
	idleSeconds: number;
	/** Whether the session is locked. Declared, not inferred; see the header. */
	locked: boolean;
	event: PresenceBeaconEvent;
}

/**
 * (PUSH-PRESENCE) F7 — how long after a resume/unlock held questions are kept
 * held regardless of everything else.
 *
 * A machine that has just woken has a keystroke stamp from before the suspend
 * (stale, so it proves nothing) and no fresh beacon yet, which reads as "away"
 * and would fire EVERY held question at the instant the lid opens. That is the
 * batched-buzz failure the old awake-time accounting existed to prevent, and it
 * would be reintroduced by the presence rules alone.
 *
 * Ten seconds is enough for the desktop's own beacon tick to land and for a user
 * who is actually there to touch the keyboard. If neither happens, the normal
 * rules resume and everything held fires — the settling window delays a correct
 * push by ten seconds, it never cancels one.
 */
export const RESUME_SETTLE_MS = 10_000;

/**
 * A beacon stamped further ahead than this is a clock step, not a beacon. Same
 * reasoning and same direction of failure as `HUMAN_INPUT_FUTURE_TOLERANCE_MS`:
 * unusable reads as "no signal", which resolves towards away.
 */
export const BEACON_FUTURE_TOLERANCE_MS = 60_000;

/**
 * Which rule decided. Carried on every verdict because "the phone did not buzz"
 * and "the phone buzzed" are both things that get reported as bugs, and the
 * reason is the entire diagnosis.
 */
export type PresenceReason =
	/** Inside the post-resume settling window; held on purpose. */
	| "resume-settling"
	/** The screen is locked. Overrides keystrokes. */
	| "locked"
	/** A human typed into a terminal within `PRESENCE_WINDOW_MS`. */
	| "keystroke"
	/** The OS reports the user active within `PRESENCE_WINDOW_MS`. */
	| "beacon-active"
	/** A fresh beacon says the user has been idle past the window. */
	| "beacon-idle"
	/** Neither signal is usable. Away by default — see the header. */
	| "no-signal";

export interface PresenceVerdict {
	/** True = hold the push. False = fire it now. */
	present: boolean;
	reason: PresenceReason;
	/** Null when there is no usable keystroke stamp. */
	humanInputAgeMs: number | null;
	/** Null when no beacon has ever landed, or the stored one is unusable. */
	beaconAgeMs: number | null;
	idleSeconds: number | null;
	locked: boolean | null;
}

export interface PresenceSnapshot {
	beacon: (PresenceBeaconInput & { receivedAtMs: number }) | null;
	lastResumeAtMs: number | null;
	beaconCount: number;
}

export interface PresenceStore {
	/**
	 * Accept one beacon. Validated here as well as at the tRPC boundary: this is
	 * the in-process API, and a malformed beacon silently stored would make every
	 * later comparison `NaN`-false, i.e. "never present", with nothing said.
	 */
	record(input: PresenceBeaconInput, nowMs?: number): void;
	present(nowMs: number): PresenceVerdict;
	snapshot(): PresenceSnapshot;
}

export function createPresenceStore(
	deps: { now?: () => number } = {},
): PresenceStore {
	const now = deps.now ?? (() => Date.now());

	let beacon: (PresenceBeaconInput & { receivedAtMs: number }) | null = null;
	let lastResumeAtMs: number | null = null;
	let beaconCount = 0;

	/** Age of a stamp, or null when the clock makes it unusable. Never negative. */
	const ageOf = (stampMs: number | null, nowMs: number): number | null => {
		if (stampMs === null) return null;
		if (!Number.isFinite(nowMs)) return null;
		if (stampMs > nowMs + BEACON_FUTURE_TOLERANCE_MS) return null;
		return Math.max(0, nowMs - stampMs);
	};

	return {
		record(input, nowMs = now()) {
			if (
				typeof input !== "object" ||
				input === null ||
				!Number.isFinite(input.idleSeconds) ||
				input.idleSeconds < 0
			) {
				throw new TypeError(
					`(PUSH-PRESENCE) presence beacon needs a finite non-negative idleSeconds, got ${String((input as PresenceBeaconInput | null)?.idleSeconds)}`,
				);
			}
			if (typeof input.locked !== "boolean") {
				throw new TypeError(
					`(PUSH-PRESENCE) presence beacon needs a boolean \`locked\`, got ${typeof input.locked}`,
				);
			}
			if (
				!(PRESENCE_BEACON_EVENTS as readonly string[]).includes(input.event)
			) {
				throw new TypeError(
					`(PUSH-PRESENCE) presence beacon event must be one of ${PRESENCE_BEACON_EVENTS.join("|")}, got ${String(input.event)}`,
				);
			}
			if (!Number.isFinite(nowMs)) {
				throw new TypeError(
					`(PUSH-PRESENCE) presence beacon needs a finite receipt time, got ${String(nowMs)}`,
				);
			}

			beacon = {
				idleSeconds: input.idleSeconds,
				locked: input.locked,
				event: input.event,
				receivedAtMs: nowMs,
			};
			beaconCount += 1;
			// F7: only a wake counts as a resume. A `lock` beacon is the opposite
			// event and an ordinary `tick` says nothing about a transition, so
			// neither may open a settling window — one that opened on every tick
			// would hold every question forever.
			if (input.event === "resume" || input.event === "unlock") {
				lastResumeAtMs = nowMs;
			}
		},

		present(nowMs) {
			const humanInputAgeMs = msSinceHumanInput(nowMs);
			const beaconAgeMs = ageOf(beacon?.receivedAtMs ?? null, nowMs);
			const beaconFresh =
				beacon !== null &&
				beaconAgeMs !== null &&
				beaconAgeMs <= BEACON_FRESH_MS;
			const base = {
				humanInputAgeMs,
				beaconAgeMs,
				idleSeconds: beacon?.idleSeconds ?? null,
				locked: beacon?.locked ?? null,
			};

			const resumeAgeMs = ageOf(lastResumeAtMs, nowMs);
			if (resumeAgeMs !== null && resumeAgeMs < RESUME_SETTLE_MS) {
				return { present: true, reason: "resume-settling", ...base };
			}

			// The one override. See "A LOCKED SCREEN" in the header.
			if (beaconFresh && beacon !== null && beacon.locked) {
				return { present: false, reason: "locked", ...base };
			}

			if (humanInputAgeMs !== null && humanInputAgeMs < PRESENCE_WINDOW_MS) {
				return { present: true, reason: "keystroke", ...base };
			}

			if (beaconFresh && beacon !== null) {
				return beacon.idleSeconds * 1000 < PRESENCE_WINDOW_MS
					? { present: true, reason: "beacon-active", ...base }
					: { present: false, reason: "beacon-idle", ...base };
			}

			// Stale or absent beacon AND stale or absent keystrokes. Away.
			return { present: false, reason: "no-signal", ...base };
		},

		snapshot() {
			return { beacon, lastResumeAtMs, beaconCount };
		},
	};
}
