/**
 * (PUSH-PRESENCE) (HUMAN-INPUT-TAGGED) "A human just typed at this desktop" — the first of the two
 * presence signals the companion push is gated on.
 *
 * WHY IT LIVES IN ITS OWN MODULE WITH NO IMPORTS
 * ---------------------------------------------
 * The stamp is written on the terminal WebSocket's hot path
 * (`terminal/terminal.ts`) and read by the companion bridge
 * (`companion/presence.ts`). Those two sides must not import each other: the
 * bridge already imports the terminal module for its pty writers, so a terminal
 * -> companion edge through anything heavier than a leaf would close a cycle.
 * This file therefore imports NOTHING and holds one number.
 *
 * WHAT MAY STAMP IT, AND WHAT MAY NOT — this is the whole correctness argument
 * -------------------------------------------------------------------------
 * ONLY a validated `{type:"input", human:true}` message on the renderer's
 * terminal socket stamps.
 *
 * `human` IS THE WHOLE POINT, and the frame type is not enough on its own.
 * xterm fires `onData` — the source of every one of those frames — for two
 * unrelated things: a person typing, and the terminal ANSWERING A QUERY the
 * program on the other end sent (Device Attributes, cursor position,
 * XTGETTCAP). xterm tracks the difference internally as `wasUserInput` and does
 * not expose it on `onData`, so for as long as this stamped on frame type
 * alone, a TUI polling the cursor position registered as a person at the desk
 * several times a second with nobody in the room — and every companion push
 * stayed held for as long as that program ran. The renderer therefore witnesses
 * the real keyboard, paste and IME-composition events itself and tags only the
 * frames it can attribute to one; see `terminal-ws-transport.ts`.
 *
 * ABSENCE IS NOT HUMAN. An older renderer never sends the field and a renderer
 * that cannot prove a person omits it, and neither may stamp. That costs the
 * keystroke signal only — the desktop's 15 s beacon still reports presence, and
 * where it cannot, the decision errs toward AWAY, which buzzes. Reading absence
 * as human is the failure that silences a blocked agent.
 *
 * `writeInputToSession` / `writeFramedInputToSession` MUST NEVER stamp. They are
 * the pty writers the companion's own answer path uses (`companion/answer.ts`),
 * plus every programmatic sender in the app (auto-resume, `terminal.send`). If
 * they stamped, a phone answering a question would register as the user being at
 * their desk — the push would then be suppressed for the NEXT question because
 * the previous one was answered from the wrist. The signal would prove the exact
 * opposite of what it claims.
 *
 * MONOTONIC SAFETY
 * ----------------
 * `Date.now()` is a wall clock: NTP steps it in both directions and a resume
 * corrects it. Two rules keep a stepped clock from reading as "the user is
 * permanently here":
 *   - the age is clamped to >= 0, so a stamp slightly in the future reads as
 *     "just now" rather than as a negative age that beats every comparison;
 *   - a stamp more than `HUMAN_INPUT_FUTURE_TOLERANCE_MS` in the future is a
 *     clock step, not a keystroke, and is reported as NO SIGNAL AT ALL.
 * Both failure directions therefore resolve towards "away", which is the safe
 * direction: away means the phone buzzes, and a spurious buzz is recoverable
 * where a silently suppressed question is not.
 */

/**
 * A stamp further ahead of `now` than this cannot be a keystroke that already
 * happened. Sized to swallow ordinary scheduler lateness and small NTP slew
 * while still catching a real step.
 */
export const HUMAN_INPUT_FUTURE_TOLERANCE_MS = 60_000;

/** `Date.now()` at the last human keystroke, or null if there has never been one. */
let lastHumanInputMs: number | null = null;

/**
 * Record a human keystroke.
 *
 * Called from exactly one place — see the module header for why that matters.
 * The finite check is not defensive smoothing: a non-finite stamp would make
 * every later age `NaN`, and `NaN < PRESENCE_WINDOW_MS` is false, so the failure
 * would present as "the user is never present" with nothing said about it.
 */
export function stampHumanInput(nowMs: number = Date.now()): void {
	if (!Number.isFinite(nowMs)) {
		throw new TypeError(
			`(PUSH-PRESENCE) stampHumanInput requires a finite epoch, got ${String(nowMs)}`,
		);
	}
	lastHumanInputMs = nowMs;
}

/**
 * Milliseconds since the last human keystroke, or `null` when there is no
 * usable stamp — never a keystroke at all, or one whose timestamp the clock has
 * made meaningless.
 *
 * `null` is deliberately a distinct value rather than `Infinity`: the caller
 * logs which of the two presence signals decided, and "no keystroke signal" and
 * "a very old keystroke" are different diagnoses.
 */
export function msSinceHumanInput(nowMs: number = Date.now()): number | null {
	const stamp = lastHumanInputMs;
	if (stamp === null) return null;
	if (!Number.isFinite(nowMs)) return null;
	if (stamp > nowMs + HUMAN_INPUT_FUTURE_TOLERANCE_MS) return null;
	return Math.max(0, nowMs - stamp);
}

/**
 * Drops the stamp. For tests and for the bridge's own teardown, so a stopped
 * bridge cannot leave a stale "the user was here" behind for the next one.
 */
export function clearHumanInputStamp(): void {
	lastHumanInputMs = null;
}
