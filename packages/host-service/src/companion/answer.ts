/**
 * (COMPANION-BRIDGE) — the answer path: guard stack, injection, idempotency (§11).
 *
 * This is the sharpest code in the companion. A mistake here types bytes into a
 * live agent terminal, and there is no undo: with the picker gone a digit lands
 * in the composer and a following Enter submits it as a real prompt; mid-turn it
 * queues and steers the running agent; against a DIFFERENT picker it commits
 * instantly and irreversibly.
 *
 * The byte encoding is NOT here — it lives in `./keystrokes`, which is pure and
 * has no access to a terminal. This file owns only WHETHER and WHEN a
 * pre-encoded keystroke is allowed to land.
 *
 * ---------------------------------------------------------------------------
 * THE GUARD STACK IS A TRANSACTION, NOT A CHECKLIST
 * ---------------------------------------------------------------------------
 * Checking six conditions and then writing is TWO ACTS: everything can pass and
 * the screen can still change before the byte lands. So read-screen, evaluate
 * guards and write all happen inside ONE critical section holding the
 * per-terminal lock, in the same process as the pty writer. That single fact is
 * the entire reason the bridge lives in host-service rather than in the Electron
 * main process — a lock held across an IPC hop proves nothing about the moment
 * the byte reaches the pty.
 *
 * Multi-keystroke sequences re-run the WHOLE stack before EVERY keystroke, and
 * additionally wait for the emulator mirror to demonstrably advance, because
 * each keystroke lands on a screen the previous one changed and a stale mirror
 * showing a picker that has already closed is the dangerous direction.
 *
 * ---------------------------------------------------------------------------
 * WHICH GUARDS ARE ALLOWED TO CARRY WEIGHT
 * ---------------------------------------------------------------------------
 * Guards 2 (`binding`) and 4 (`permission_axis`) read a store fed by the
 * localhost `notifications.hook`, which is unauthenticated and whose URL sits in
 * every agent shell's environment. An agent that reads untrusted content and
 * follows instructions in it can forge a "question is pending" state there. They
 * are therefore classified `forgeable` and the classification is ENFORCED, not
 * merely commented:
 *
 *   - the load-bearing guards (1 `transcript`, 5 `screen`) are evaluated FIRST
 *     and short-circuit the stack, so a forged `true` is never even consulted on
 *     a path that would permit a write;
 *   - a forgeable guard may cause a REFUSAL but can never contribute to a
 *     permission (`assertGuardClassification` keeps that invariant honest as
 *     guards are added);
 *   - every guard that cannot be evaluated — the source threw, the file was
 *     unreadable — counts as FALSE. "Could not check" is never "probably fine".
 *     The ONE exception is the `veto_only` class below, where "could not check"
 *     is not "absent" and therefore is not a veto; it has its own reader
 *     (`readVetoGuardSource`) precisely so the two never get confused.
 *
 * WHAT MAKES "LOAD-BEARING" TRUE RATHER THAN ASPIRATIONAL. Both properties are
 * mechanical and both were once absent:
 *   - guard 1 reads a transcript path DERIVED FROM host.db
 *     (`QuestionSourceResolver.resolveTranscriptPath`), not the one the hook
 *     supplied, and it requires the matching `tool_use` block to be positively
 *     observed before it will report "still unanswered". Reading a hook-named
 *     file made "point it at an empty file" a way to pass guard 1 on demand;
 *   - guard 5's anchors have a MINIMUM LENGTH and its rows must be a contiguous
 *     ascending band (`SCREEN_MIN_ANCHOR_CHARS`, `rowsFormAscendingBand`).
 *     Without those, a capture with one-character labels reduced the check to a
 *     two-character substring search that an idle composer satisfied.
 * Do not weaken either without replacing it with something equally mechanical.
 *
 * Guard 6 (`askq_marker`) is a VETO, never proof: markers leak (17 stale, oldest
 * 21 days). Its ABSENCE is sound; its PRESENCE proves nothing and is never
 * treated as evidence — and an UNREADABLE marker source is not absence, so it
 * cannot veto either. Running it through the ordinary reader turned it into a
 * mandatory positive that failed 100% of answers with a refusal the client
 * could not distinguish from a stale question.
 *
 * ---------------------------------------------------------------------------
 * ACCEPTED RESIDUAL (§11.7) — do not try to fix, do not worsen
 * ---------------------------------------------------------------------------
 * A desktop keypress already queued inside the detached pty daemon beats any
 * lock taken here, because the emulator mirror the guards read is downstream of
 * the very queue being raced. Every write therefore carries its leaseId,
 * requestId and full guard state into the audit log BEFORE it executes, so an
 * incident is reconstructable rather than mysterious. Logging is the mitigation.
 */

import { readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { type AuditLog, hashJsonPayload } from "./audit";
import { ANSWER_ATTEMPT_RETENTION_MS } from "./config";
import { isCanonicalWireId, sleep, writeFileDurable } from "./crypto";
import {
	createRawPtyWriter,
	encodeAnswer,
	findForbiddenControlChar,
	findUnpairedSurrogate,
	type Keystroke,
	KeystrokeEncodingError,
	MESSAGE_ALLOWED_C0,
	type RawPtyWriter,
	type RawWriteFn,
	type ScreenExpectation,
} from "./keystrokes";
import {
	type LeaseRegistry,
	type TerminalLockRegistry,
	TerminalLockTimeoutError,
} from "./lease";
import type { PendingQuestion, QuestionStore } from "./question-store";
import {
	type AgentKind,
	type AnswerAttemptRecord,
	type AnswerGuardName,
	type AnswerRequest,
	type AnswerResponse,
	type AnswerStatusRequest,
	type AnswerStatusResponse,
	type AttemptFailureCode,
	type DurationMs,
	type EpochMs,
	type GuardEvaluation,
	type MessageRequest,
	type MessageResponse,
	type QuestionItem,
	type RequestId,
	SealedError,
	type SealedRequestContext,
	type TerminalId,
} from "./types";

// ---------------------------------------------------------------------------
// tunables (bridge-internal; none of these are on the wire)
// ---------------------------------------------------------------------------

/**
 * How long a request will wait for the per-terminal lock. On expiry NOTHING has
 * been written — the critical section never ran — and the client is told so.
 */
export const LOCK_WAIT_TIMEOUT_MS = 5_000;

/** Poll interval while waiting for the emulator mirror to reflect our last byte. */
export const SCREEN_ADVANCE_POLL_MS = 25;

/** How long to wait for that advance before abandoning the sequence. */
export const SCREEN_ADVANCE_TIMEOUT_MS = 1_000;

/**
 * Hard ceiling on one keystroke sequence. Bounds how long the terminal lock can
 * be held, and keeps the sequence inside the answer lease's TTL.
 */
export const SEQUENCE_DEADLINE_MS = 10_000;

/** PROTOCOL §7.5 — a message body is 1..8 192 chars. */
export const MESSAGE_MAX_CHARS = 8_192;

/**
 * (MESSAGE-ECHO) How long `/v1/message` waits for the composer to render the
 * text it just pasted, before it will write the trailing submit.
 *
 * Longer than `SCREEN_ADVANCE_TIMEOUT_MS` because a paste of up to 8 192 chars is
 * a bigger repaint than a picker moving its highlight. Bounded, because the
 * terminal lock is held throughout.
 */
export const MESSAGE_ECHO_TIMEOUT_MS = 2_000;

/**
 * (MESSAGE-ECHO) Squashed characters of the message used as the on-screen
 * anchor. Long enough that matching it by chance is implausible, short enough to
 * survive the composer hard-wrapping.
 */
export const MESSAGE_ECHO_ANCHOR_CHARS = 24;

/**
 * (MESSAGE-ECHO) The FLOOR on that anchor. Below it the echo proves nothing and
 * the submit is withheld.
 *
 * `MESSAGE_ECHO_ANCHOR_CHARS` is a ceiling — `slice(0, 24)` of a three-character
 * message is the whole three characters. With no floor the check collapsed to
 * "does this short string occur anywhere in a band on screen", and the needle is
 * the CLIENT's own text, so it is attacker-parameterisable in exactly the way
 * guard 5's capture-derived anchors were. Measured against the real
 * `handleMessage` path with an inert paste (the picker case): the text "yes"
 * matched a picker's own option label "Yes, proceed…" and the text "1" matched
 * the picker's own row number — both returned `sent` and wrote the trailing
 * `\r` into an open picker.
 *
 * Same value and same reasoning as `SCREEN_MIN_ANCHOR_CHARS` (guard 5's remedy
 * for the identical class), kept as its own name because the two paths are free
 * to diverge.
 */
export const MESSAGE_ECHO_MIN_ANCHOR_CHARS = 8;

/**
 * (MESSAGE-ECHO) Ceiling on how tall the echo search band may grow.
 *
 * The band tracks the message's own line count so a multi-line message can be
 * found where it is rendered, but it is capped: without a cap a message made of
 * many one-character lines would widen the search to "anywhere in the viewport",
 * which is the property the banding exists to deny.
 */
export const MESSAGE_ECHO_MAX_WINDOW_LINES = 16;

// ---------------------------------------------------------------------------
// guard classification — enforced, not documentation
// ---------------------------------------------------------------------------

export type GuardClass =
	/** Outside the unauthenticated hook's reach. Only these may permit a write. */
	| "load_bearing"
	/** Fed by `notifications.hook`. May refuse; may never permit. */
	| "forgeable"
	/** Absence is a sound veto; presence is never evidence. */
	| "veto_only"
	/** Neither forgeable nor sufficient — a sanity condition. */
	| "supporting";

export const GUARD_CLASSES: Readonly<Record<AnswerGuardName, GuardClass>> = {
	transcript: "load_bearing",
	screen: "load_bearing",
	binding: "forgeable",
	permission_axis: "forgeable",
	session: "supporting",
	askq_marker: "veto_only",
};

export const LOAD_BEARING_GUARDS: readonly AnswerGuardName[] = (
	Object.keys(GUARD_CLASSES) as AnswerGuardName[]
).filter((name) => GUARD_CLASSES[name] === "load_bearing");

/**
 * The order `evaluateGuards` MUST run the stack in, as data rather than as a
 * hand-written sequence of statements.
 *
 * The classification above is only worth anything if the ordering it implies is
 * mechanical. It was not: `assertGuardClassification` used to check nothing but
 * "at least one load-bearing guard exists", while the header claimed a forgeable
 * guard "can never contribute to a permission" and named that function as what
 * kept it honest. The ordering happened to be correct; nothing made it stay
 * correct, and a future guard classified `forgeable` and inserted early — the
 * natural thing to do if it is cheap — would have been consulted on a path that
 * permits, which is precisely what the classification exists to deny.
 *
 * Now: this array is asserted at module load to place every `load_bearing` guard
 * ahead of every other class, and `evaluateGuards` asserts that it walks the
 * stack in exactly this order, so drift is a crash rather than a silent
 * weakening.
 */
export const GUARD_EVALUATION_ORDER: readonly AnswerGuardName[] = [
	"transcript",
	"screen",
	"session",
	"binding",
	"permission_axis",
	"askq_marker",
];

/**
 * Run at module load. A guard added to `AnswerGuardName` without a class here is
 * a compile error; a stack with no load-bearing guard at all, one that
 * `GUARD_EVALUATION_ORDER` does not cover exactly, or an order that consults a
 * forgeable guard before a load-bearing one is a startup crash. All of them beat
 * discovering it after an answer landed on the wrong screen.
 */
function assertGuardClassification(): void {
	if (LOAD_BEARING_GUARDS.length === 0) {
		throw new Error(
			"(COMPANION-BRIDGE) the answer guard stack has no load-bearing guard; refusing to load",
		);
	}
	const classified = Object.keys(GUARD_CLASSES) as AnswerGuardName[];
	const ordered = new Set(GUARD_EVALUATION_ORDER);
	if (ordered.size !== GUARD_EVALUATION_ORDER.length) {
		throw new Error(
			"(COMPANION-BRIDGE) GUARD_EVALUATION_ORDER lists a guard twice; refusing to load",
		);
	}
	for (const name of classified) {
		if (!ordered.has(name)) {
			throw new Error(
				`(COMPANION-BRIDGE) guard ${name} is classified but never evaluated; refusing to load`,
			);
		}
	}
	for (const name of GUARD_EVALUATION_ORDER) {
		if (!classified.includes(name)) {
			throw new Error(
				`(COMPANION-BRIDGE) guard ${name} is evaluated but not classified; refusing to load`,
			);
		}
	}
	let seenNonLoadBearing: AnswerGuardName | null = null;
	for (const name of GUARD_EVALUATION_ORDER) {
		if (GUARD_CLASSES[name] === "load_bearing") {
			if (seenNonLoadBearing !== null) {
				throw new Error(
					`(COMPANION-BRIDGE) load-bearing guard ${name} is evaluated after ${seenNonLoadBearing} (${GUARD_CLASSES[seenNonLoadBearing]}); a guard that may never permit must not be consulted before one that does. Refusing to load`,
				);
			}
			continue;
		}
		seenNonLoadBearing = name;
	}
}
assertGuardClassification();

// ---------------------------------------------------------------------------
// dependencies
// ---------------------------------------------------------------------------

/** What a guard source reports. `null` means "could not determine" and fails closed. */
export type GuardSourceResult = boolean | null;

export interface TerminalAgentInfo {
	kind: AgentKind;
	/** false => a plain shell. NEVER writable. */
	bound: boolean;
	/** The agent session this terminal is currently bound to, if known. */
	agentSessionId: string | null;
}

/**
 * The host.db ids behind an opaque wire handle. These — and ONLY these — are
 * what the pty writer accepts; the wire handle is a truncated SHA-256 and is
 * never a key in the live session map.
 */
export interface HostTerminalRef {
	/** host.db `terminal_sessions.id`. */
	hostTerminalId: string;
	/** host.db `workspaces.id`. */
	hostWorkspaceId: string;
}

/**
 * Everything the answer path needs from the rest of host-service.
 *
 * Note the two writers are deliberately DIFFERENT SHAPES so neither can be
 * passed where the other belongs:
 *  - `writer` is a `RawPtyWriter`, mintable only by `createRawPtyWriter`, which
 *    probes the function at startup and refuses anything that returns a Promise
 *    (i.e. the paste-framing writer). Bracketed paste is INERT against the
 *    picker, so wiring the framed writer here would make answers silently never
 *    arrive;
 *  - `writeFramed` is async and takes `{text, submit}`, and is used ONLY by
 *    `handleMessage`, which never touches a picker.
 */
export interface AnswerDeps {
	/**
	 * Raw, unframed, SYNCHRONOUS pty write. MUST be `writeInputToSession` from
	 * `../terminal/terminal`, in THIS process.
	 *
	 * It is never called directly: `rawWriterFor` runs it through
	 * `createRawPtyWriter`, which probes it with an impossible terminal id and
	 * refuses anything that returns a Promise — i.e. the paste-framing writer.
	 * Bracketed paste is INERT against the picker, so wiring the framed writer
	 * here would make answers silently never arrive rather than fail.
	 */
	writeInput: RawWriteFn;
	/**
	 * Paste-framed write, for `/v1/message` ONLY. Deliberately a different shape
	 * (async, `{text, submit}`) so it cannot be swapped with `writeInput`. Never
	 * reachable from the injector.
	 *
	 * `terminalId` / `workspaceId` are HOST.DB ids from `resolveHostTerminal`, not
	 * wire handles — the field names are the pty writer's, and the writer looks
	 * them up in its live session map.
	 *
	 * NOTE, because the header comment on `handleMessage` used to get this wrong:
	 * `submit: true` appends `\r` OUTSIDE the bracketed-paste frame. The body is
	 * inert against a picker; that `\r` is not. (MESSAGE-ECHO) is why the message
	 * path calls this TWICE — once with `submit: false` for the body, and once
	 * with an empty body and `submit: true` for the commit, with a positive screen
	 * check in between.
	 */
	writeFramed(input: {
		terminalId: string;
		workspaceId: string;
		text: string;
		submit: boolean;
	}): Promise<{ success: true } | { error: string }>;
	/**
	 * The terminal's VISIBLE VIEWPORT as plain text. Guard 5's source.
	 *
	 * Viewport, not buffer: Claude Code renders inline in the normal buffer, so a
	 * whole-buffer snapshot carries up to 1 000 lines of scrollback containing
	 * every earlier picker render, and guard 5 would confirm against one of those.
	 */
	snapshotScreen(terminalId: TerminalId): Promise<string>;

	locks: TerminalLockRegistry;
	leases: LeaseRegistry;
	attempts: AttemptStore;
	messageAttempts: MessageAttemptStore;
	questions: QuestionStore;
	audit: AuditLog;
	now(): EpochMs;
	/**
	 * When THIS bridge lifetime began — the same value `HeartbeatResponse`
	 * carries (§6.3). `/v1/answer/status` reports it so a client can tell "no
	 * record because it never arrived" from "no record because this bridge is
	 * younger than the write". It is a constant per mount, not a clock.
	 */
	bridgeStartedMs: EpochMs;

	/**
	 * Maps an OPAQUE wire terminal handle (§0.1) back to the host.db ids the pty
	 * writer actually understands. `null` => refuse; never guessed.
	 *
	 * Both ids come back together on purpose. They were previously resolved
	 * separately, and the answer path ended up calling the pty writer with the
	 * WIRE HANDLE as `terminalId` and the real host id as `workspaceId` — a pair
	 * that can never match a live session, so every answer failed
	 * `Terminal session not found` while looking like a guard problem. `TerminalId`
	 * is a `string` alias, so nothing in the type system catches that; resolving
	 * the pair in one call is what makes it unrepresentable.
	 */
	resolveHostTerminal(terminalId: TerminalId): Promise<HostTerminalRef | null>;

	/**
	 * GUARD 1, LOAD-BEARING. true => the tool call has already been answered.
	 * Read from the transcript, which the unauthenticated hook cannot write.
	 */
	toolResultExists(input: {
		terminalId: TerminalId;
		sessionId: string;
		toolUseId: string;
	}): Promise<GuardSourceResult>;

	/** GUARD 2, FORGEABLE. The agent binding currently on the terminal. */
	agentBinding(terminalId: TerminalId): Promise<TerminalAgentInfo | null>;

	/** GUARD 3, supporting. The pty session is alive. */
	sessionActive(terminalId: TerminalId): Promise<GuardSourceResult>;

	/** GUARD 4, FORGEABLE. The permission (red) axis is still latched. */
	permissionAxisLatched(terminalId: TerminalId): Promise<GuardSourceResult>;

	/**
	 * GUARD 6, VETO ONLY. Presence proves nothing; absence is a sound veto.
	 *
	 * The marker is keyed by HOST TERMINAL ID and by the RAISING AGENT (the
	 * sanitized subagent `agent_id`, or `_main` on the main loop) — so both are
	 * passed. `agentType` is not a key and never was; it is carried only for
	 * diagnostics. An implementation that cannot compute the owner key must
	 * return `null` (unreadable) rather than answering about the wrong owner.
	 */
	askqMarkerExists(input: {
		terminalId: TerminalId;
		agentId: string | null;
		agentType: string | null;
	}): Promise<GuardSourceResult>;

	/** Structured diagnostics. Never carries question or answer text. */
	log(event: Record<string, unknown>): void;
}

/**
 * One probe per distinct writer function, not one per request.
 *
 * The probe is side-effect-free (`createRawPtyWriter` calls it with a terminal
 * id that cannot exist and empty data), so running it lazily is safe — but the
 * composition root SHOULD call `assertAnswerDeps` at bridge start so a
 * mis-wired writer fails loud there rather than on the first answer of the day.
 */
const rawWriters = new WeakMap<RawWriteFn, RawPtyWriter>();

function rawWriterFor(deps: AnswerDeps): RawPtyWriter {
	const existing = rawWriters.get(deps.writeInput);
	if (existing !== undefined) return existing;
	const writer = createRawPtyWriter(deps.writeInput);
	rawWriters.set(deps.writeInput, writer);
	return writer;
}

/**
 * Startup check for the composition root. Proves the raw writer is the raw
 * writer before any question can be answered, and fails loud if it is not.
 */
export function assertAnswerDeps(deps: AnswerDeps): void {
	rawWriterFor(deps);
	if (typeof deps.writeFramed !== "function") {
		throw new Error(
			"(COMPANION-BRIDGE) answer deps: writeFramed must be writeFramedInputToSession — /v1/message needs paste framing",
		);
	}
	if (typeof deps.snapshotScreen !== "function") {
		throw new Error(
			"(COMPANION-BRIDGE) answer deps: snapshotScreen is required — guard 5 cannot run without a screen",
		);
	}
}

// ---------------------------------------------------------------------------
// guard 5 — the screen matcher
// ---------------------------------------------------------------------------

/**
 * Whitespace-free chars of an option label used as the on-screen anchor. Short
 * enough to survive the emulator hard-wrapping a long label across columns,
 * long enough that a false positive is implausible.
 */
export const SCREEN_OPTION_ANCHOR_CHARS = 16;

/** Same idea for the item's header. */
export const SCREEN_HEADER_ANCHOR_CHARS = 12;

/** Fallback anchor when an item has no header worth matching. */
export const SCREEN_QUESTION_ANCHOR_CHARS = 24;

/**
 * Decoration permitted between a row's digit and its label — ".", ")", "❯",
 * "[x]" and similar. Bounded, so the digit stays tied to the label it addresses.
 */
export const SCREEN_ROW_DECORATION_MAX_CHARS = 6;

/**
 * (GUARD5-ANCHOR) Minimum squashed anchor length before an anchor may be used
 * as SCREEN EVIDENCE.
 *
 * Every needle this matcher searches for is capture-derived, and the capture
 * arrives on the unauthenticated localhost hook. With no floor, a forged item
 * of `{header: "c", options: [{index: 0, label: "2"}]}` collapsed the whole
 * check to "does the two-character substring `12` occur anywhere in a two-line
 * window" — which an ordinary idle Claude composer satisfies. Guard 5 then
 * confirmed a picker that was not there, and the answer path typed a bare digit
 * into a composer.
 *
 * A floor does not make the anchors unforgeable — nothing here can — but it
 * forces a forgery to reproduce a long, specific string that is ALREADY on the
 * victim's screen at the right digit row, which is no longer a free choice. Real
 * Claude Code headers and option labels are comfortably longer than this; a
 * prompt that is not is REFUSED rather than answered on weak evidence, and the
 * user answers it at the desk.
 */
export const SCREEN_MIN_ANCHOR_CHARS = 8;

/**
 * (GUARD5-ANCHOR) How far apart the first and last matched option rows may be,
 * measured in screen-line windows, beyond the number of rows themselves.
 *
 * A picker renders its options as CONSECUTIVE lines. Without this, the matcher
 * accepted rows scattered anywhere in the viewport in any order, so unrelated
 * text that happened to contain each needle somewhere satisfied it. Rows must
 * now appear in ascending digit order inside one contiguous band.
 */
export const SCREEN_ROW_BAND_SLACK = 3;

export type PickerMatchReason =
	| "match"
	| "empty_screen"
	| "anchor_absent"
	| "anchor_too_weak"
	| "row_absent"
	| "rows_out_of_order";

export interface PickerScreenMatch {
	ok: boolean;
	reason: PickerMatchReason;
	/** Which anchors were not found. Diagnostics; never contains a full label. */
	missing: string[];
	/** false => this was the WEAK `same_prompt` form, not the digit-mapped one. */
	digitMapped: boolean;
}

/** Lowercase and strip ALL whitespace: immune to indentation and hard wraps. */
function squash(text: string): string {
	return text.toLowerCase().replace(/\s+/g, "");
}

/**
 * How many adjacent screen lines a single logical row may be assembled from.
 *
 * Squashing strips newlines too, so squashing the WHOLE screen lets an anchor be
 * assembled from fragments on lines that are nowhere near each other — the digit
 * from one place, the label from another. Two is the smallest window that still
 * tolerates the emulator hard-wrapping one long row across a column boundary,
 * which is the reason whitespace is stripped in the first place.
 */
const SCREEN_LINE_WINDOW = 2;

/**
 * The screen as a set of squashed, overlapping line windows.
 *
 * A match must lie WITHIN one window, so a row cannot be built out of text from
 * opposite ends of the buffer. Any match contained in a single line is also
 * contained in the window that starts at that line, so nothing that used to
 * match legitimately stops matching.
 *
 * `windowLines` is a parameter because the needle's own height varies: a picker
 * row is one line (plus wrap slack), while (MESSAGE-ECHO) searches for a message
 * the user may have written across several. Callers that omit it get the picker
 * default and are unaffected.
 */
function squashedWindows(
	screen: string,
	windowLines: number = SCREEN_LINE_WINDOW,
): string[] {
	const lines = screen.split("\n");
	if (lines.length <= windowLines) return [squash(screen)];
	const windows: string[] = [];
	for (let i = 0; i + 1 < lines.length; i += 1) {
		windows.push(squash(lines.slice(i, i + windowLines).join("")));
	}
	return windows;
}

function anyWindowIncludes(
	windows: readonly string[],
	needle: string,
): boolean {
	return windows.some((window) => window.includes(needle));
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function anchorOf(text: string, maxChars: number): string {
	return squash(text).slice(0, maxChars);
}

/**
 * The anchor that proves this PROMPT is on screen. Prefers the header (short,
 * always rendered beside the options); falls back to the question's opening,
 * which a long question may have scrolled away — so a fallback miss is a refusal
 * rather than a guess.
 *
 * (GUARD5-ANCHOR) An anchor shorter than `SCREEN_MIN_ANCHOR_CHARS` is not
 * evidence, so a short header falls through to the question rather than being
 * used; if neither clears the floor the caller gets `""` and refuses.
 */
function promptAnchor(item: QuestionItem): string {
	const header = anchorOf(item.header, SCREEN_HEADER_ANCHOR_CHARS);
	if (header.length >= SCREEN_MIN_ANCHOR_CHARS) return header;
	const question = anchorOf(item.question, SCREEN_QUESTION_ANCHOR_CHARS);
	if (question.length >= SCREEN_MIN_ANCHOR_CHARS) return question;
	return "";
}

/**
 * The prologue BOTH screen matchers run, and the only thing they share: squash
 * the viewport into overlapping line windows, refuse an empty screen, and
 * require the prompt's own anchor to be long enough to be evidence and to
 * actually be present.
 *
 * `digitMapped` is threaded through rather than derived, because it is the
 * caller's identity and not a property of the prologue: the same missing anchor
 * is reported as `digitMapped: true` by the strong matcher and `false` by the
 * weak one, and nothing downstream may confuse the two.
 *
 * DO NOT go on to unify the matchers themselves. `matchPickerScreen` is used to
 * PERMIT a write and so errs toward refusing; `matchPromptStillOnScreen` is used
 * to REFUSE one and asserts nothing beyond "this prompt is still up". The biases
 * are opposite on purpose — sharing the prologue removes copy-paste, sharing the
 * bodies would remove the distinction.
 */
type PromptPrologue =
	| { ok: true; windows: string[] }
	| { ok: false; failure: PickerScreenMatch };

function matchPromptOnScreen(input: {
	screen: string;
	item: QuestionItem;
	digitMapped: boolean;
}): PromptPrologue {
	const { digitMapped } = input;
	const windows = squashedWindows(input.screen);
	if (windows.every((window) => window.length === 0)) {
		return {
			ok: false,
			failure: {
				ok: false,
				reason: "empty_screen",
				missing: ["screen"],
				digitMapped,
			},
		};
	}

	const anchor = promptAnchor(input.item);
	if (anchor.length === 0) {
		// Neither the header nor the question opening is long enough to be
		// evidence. Refuse; do not fall back to a weaker check.
		return {
			ok: false,
			failure: {
				ok: false,
				reason: "anchor_too_weak",
				missing: ["prompt"],
				digitMapped,
			},
		};
	}
	if (!anyWindowIncludes(windows, anchor)) {
		return {
			ok: false,
			failure: {
				ok: false,
				reason: "anchor_absent",
				missing: ["prompt"],
				digitMapped,
			},
		};
	}
	return { ok: true, windows };
}

/**
 * GUARD 5, the load-bearing one.
 *
 * It does not merely assert "some picker is up". It asserts that the DIGIT this
 * keystroke is about to press maps, on the screen as rendered right now, to the
 * option we believe it selects. That is the only property that makes injecting a
 * bare digit defensible.
 *
 * `screen` MUST be the VISIBLE VIEWPORT and nothing else. Claude Code renders
 * its conversation inline in the normal buffer, so a snapshot that includes
 * scrollback contains every earlier render of every earlier picker — and this
 * matcher would then happily confirm "the picker is on screen" against a picker
 * the user closed at the desk minutes ago, while the viewport shows a composer.
 * `index.ts`'s snapshot adapter is what bounds it; do not widen that.
 *
 * The matcher is deliberately strict and fails closed: a refusal costs the user
 * one walk to the desk, a false positive costs them a wrong irreversible answer.
 *
 * (GUARD5-ANCHOR) Every needle here comes from the CAPTURE, and the capture
 * arrives on the unauthenticated localhost hook. Three properties keep that from
 * making the guard attacker-parameterised:
 *   - an anchor below `SCREEN_MIN_ANCHOR_CHARS` is not evidence at all
 *     (`anchor_too_weak`), so a one-character label can no longer collapse the
 *     row test into "does `<digit><char>` occur anywhere";
 *   - EVERY option row must be present — already true — AND they must appear in
 *     ascending digit order inside one contiguous band of screen lines
 *     (`rows_out_of_order`), which is how a picker actually renders and is not
 *     something scattered unrelated text satisfies;
 *   - the free-text label is bridge-owned (`validateCapture` derives it), so the
 *     one row whose anchor is legitimately short is not caller-chosen.
 *
 * NOT YET CANARIED against real Claude Code picker output — the row-decoration
 * allowance, the anchor lengths and the band slack above are the knobs a canary
 * test would tune. Until that test exists this matcher is expected to be
 * over-strict, which is the safe direction.
 */
export function matchPickerScreen(input: {
	screen: string;
	item: QuestionItem;
	/** The row this keystroke is about to press, when it presses one. */
	requireOptionIndex: number | null;
}): PickerScreenMatch {
	const prologue = matchPromptOnScreen({
		screen: input.screen,
		item: input.item,
		digitMapped: true,
	});
	if (!prologue.ok) return prologue.failure;
	const windows = prologue.windows;

	// (GUARD5-ANCHOR) Weak option anchors are refused BEFORE any screen search,
	// so a short label can never be the thing that made the guard pass.
	const weak = input.item.options.filter(
		(option) =>
			anchorOf(option.label, SCREEN_OPTION_ANCHOR_CHARS).length <
			SCREEN_MIN_ANCHOR_CHARS,
	);
	if (weak.length > 0) {
		return {
			ok: false,
			reason: "anchor_too_weak",
			missing: weak.map((option) => `option:${option.index}`),
			digitMapped: true,
		};
	}

	const missing: string[] = [];
	/** Per option, the screen-line windows its digit-mapped row appears in. */
	const rowWindows: number[][] = [];
	for (const option of input.item.options) {
		const hits = screenRowWindows(windows, option.index, option.label);
		if (hits.length === 0) missing.push(`option:${option.index}`);
		rowWindows.push(hits);
	}

	const freeText = input.item.freeTextOption;
	if (
		freeText !== null &&
		input.requireOptionIndex === freeText.index &&
		// The free-text label is bridge-derived, not caller-chosen, so it is
		// exempt from the anchor floor — but it must still be on screen at its
		// own digit before that digit is pressed.
		screenRowWindows(windows, freeText.index, freeText.label).length === 0
	) {
		missing.push(`freetext:${freeText.index}`);
	}

	if (missing.length > 0) {
		return { ok: false, reason: "row_absent", missing, digitMapped: true };
	}

	if (!rowsFormAscendingBand(rowWindows)) {
		return {
			ok: false,
			reason: "rows_out_of_order",
			missing: ["row_order"],
			digitMapped: true,
		};
	}
	return { ok: true, reason: "match", missing: [], digitMapped: true };
}

/**
 * (GUARD5-ANCHOR) Can the matched rows be assigned window indices that are
 * non-decreasing in digit order and span at most `rows + SCREEN_ROW_BAND_SLACK`
 * windows?
 *
 * Windows overlap by design (`SCREEN_LINE_WINDOW`), so two adjacent rows can
 * legitimately match the SAME window — hence non-decreasing rather than strictly
 * increasing. Greedy from each possible start, because taking the earliest hit
 * for row 0 can strand a later row that only appears further down.
 */
function rowsFormAscendingBand(rowWindows: readonly number[][]): boolean {
	const first = rowWindows[0];
	if (first === undefined) return false;
	const span = rowWindows.length + SCREEN_ROW_BAND_SLACK;
	for (const start of first) {
		let cursor = start;
		let ok = true;
		for (let i = 1; i < rowWindows.length; i += 1) {
			const hits = rowWindows[i];
			if (hits === undefined) return false;
			const next = hits.find((w) => w >= cursor && w - start <= span);
			if (next === undefined) {
				ok = false;
				break;
			}
			cursor = next;
		}
		if (ok) return true;
	}
	return false;
}

/**
 * Which screen-line windows contain `<digit><=6 decoration chars><label anchor>`.
 *
 * Returns the indices rather than a boolean so the caller can also check that
 * the rows are in ascending digit order inside one band — a picker renders its
 * options as consecutive lines, and "each needle is somewhere on screen" is a
 * much weaker claim than "these rows are rendered as a list".
 */
function screenRowWindows(
	windows: readonly string[],
	optionIndex: number,
	label: string,
): number[] {
	const anchor = anchorOf(label, SCREEN_OPTION_ANCHOR_CHARS);
	if (anchor.length === 0) return [];
	const digit = optionIndex + 1;
	const pattern = new RegExp(
		`${digit}[^a-z0-9]{0,${SCREEN_ROW_DECORATION_MAX_CHARS}}${escapeRegExp(anchor)}`,
	);
	const hits: number[] = [];
	for (let i = 0; i < windows.length; i += 1) {
		const window = windows[i];
		if (window !== undefined && pattern.test(window)) hits.push(i);
	}
	return hits;
}

/**
 * (GUARD5-ANCHOR / PICKER-CHROME) Does the viewport show the STRUCTURE of a
 * picker — a run of numbered rows in ascending digit order starting at 1?
 *
 * Nothing in this function comes from a capture: it is the only screen evidence
 * the bridge has that no caller can parameterise. It is deliberately used ONLY
 * where a false positive is a refusal:
 *   - `/v1/message`, where a picker on screen must block the trailing `\r`.
 * It is NOT used to permit anything.
 *
 * IT ERRS TOWARD MATCHING, deliberately and asymmetrically. A false positive
 * costs one refused message, which the user retries or types at the desk. A
 * false NEGATIVE writes a bare `\r` into an open picker, which toggles a
 * multi-select row or submits an N-question review screen irreversibly. So the
 * two bounds that used to make this miss ordinary renders are gone:
 *
 *  - there is NO cap on the distance between consecutive rows. A cap of two
 *    lines was measured to miss a picker whose first option label WRAPPED across
 *    three lines, and a picker with two blank lines between rows. Ascending
 *    digit order across the whole viewport is the structure being looked for;
 *    the gap was never part of it.
 *  - leading decoration is unbounded (`[^0-9A-Za-z]*`) rather than capped at
 *    eight characters, so box drawing plus a selection caret plus deep
 *    indentation cannot push the digit out of reach. The character class still
 *    cannot cross a letter or another digit, so this does not match mid-line
 *    numbers.
 *
 * An agent that printed an ordinary numbered list still matches, and that is
 * still the correct trade.
 */
export const PICKER_CHROME_MIN_ROWS = 2;
const PICKER_CHROME_ROW = /^[^0-9A-Za-z]*([1-9])[.)\]:]?\s+\S/;

export function screenShowsPickerChrome(screen: string): boolean {
	const lines = screen.split("\n");
	/** Which digit the run expects next. */
	let expected = 1;
	let run = 0;
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i];
		if (line === undefined) continue;
		const match = PICKER_CHROME_ROW.exec(line);
		if (match === null) continue;
		const digit = Number(match[1]);
		if (run > 0 && digit === expected) {
			run += 1;
			expected += 1;
			if (run >= PICKER_CHROME_MIN_ROWS) return true;
			continue;
		}
		if (digit === 1) {
			run = 1;
			expected = 2;
			if (run >= PICKER_CHROME_MIN_ROWS) return true;
		}
		// A numbered line that neither continues the run nor starts one is IGNORED,
		// not treated as the end of the run. Resetting here was a third way to miss
		// a wrapped label, on top of the gap cap and the decoration cap: a
		// continuation line reading "   3 tables and rebuilding every index" matches
		// this row pattern with digit 3, and between rows 1 and 2 that reset dropped
		// the run and the picker went undetected. Skipping instead can only ever
		// ADD matches, which on this detector is the refusing direction.
	}
	return false;
}

/**
 * The WEAK form, for the screens whose layout was never proven: the N-question
 * review screen, the multi-select Submit tab, the open free-text editor. It can
 * only assert that this prompt is still what is on screen. It is used ONLY for
 * `same_prompt` expectations and is reported as `digitMapped: false` so nothing
 * downstream can mistake it for the strong check.
 *
 * (GUARD5-ANCHOR) `anchor_too_weak` is reported separately from `anchor_absent`
 * because the two mean opposite things to a REFUSING caller: "this prompt is
 * demonstrably not on screen" versus "this prompt has no anchor worth
 * searching for, so nothing was demonstrated". A caller using this to rule a
 * picker OUT must treat `anchor_too_weak` as inconclusive.
 */
export function matchPromptStillOnScreen(input: {
	screen: string;
	item: QuestionItem;
}): PickerScreenMatch {
	const prologue = matchPromptOnScreen({
		screen: input.screen,
		item: input.item,
		digitMapped: false,
	});
	if (!prologue.ok) return prologue.failure;
	// Deliberately nothing else. The prompt being on screen is the WHOLE claim
	// this form makes; the option rows are not consulted at all.
	return { ok: true, reason: "match", missing: [], digitMapped: false };
}

function evaluateScreenGuard(input: {
	screen: string;
	question: PendingQuestion;
	expectation: ScreenExpectation;
	requireOptionIndex: number | null;
}): PickerScreenMatch {
	const item = input.question.questions[input.expectation.itemIndex];
	if (item === undefined) {
		return {
			ok: false,
			reason: "anchor_absent",
			missing: [`item:${input.expectation.itemIndex}`],
			digitMapped: input.expectation.kind === "item_picker",
		};
	}
	if (input.expectation.kind === "item_picker") {
		return matchPickerScreen({
			screen: input.screen,
			item,
			requireOptionIndex: input.requireOptionIndex,
		});
	}
	return matchPromptStillOnScreen({ screen: input.screen, item });
}

// ---------------------------------------------------------------------------
// the guard stack
// ---------------------------------------------------------------------------

export interface GuardOutcome {
	evaluation: GuardEvaluation;
	passed: AnswerGuardName[];
	/** The FIRST guard that failed, in evaluation order. */
	failed: AnswerGuardName | null;
	screenMatch: PickerScreenMatch | null;
}

/** A source that throws or answers `null` counts as FALSE. Never "probably fine". */
async function readGuardSource(
	name: AnswerGuardName,
	deps: AnswerDeps,
	read: () => Promise<GuardSourceResult>,
): Promise<boolean> {
	try {
		const value = await read();
		if (value === null) {
			deps.log({
				event: "companion.guard.indeterminate",
				guard: name,
				result: false,
			});
			return false;
		}
		return value;
	} catch (error) {
		deps.log({
			event: "companion.guard.error",
			guard: name,
			result: false,
			error: error instanceof Error ? error.message : String(error),
		});
		return false;
	}
}

/**
 * The reader for a `veto_only` guard, which has DIFFERENT null semantics from
 * every other class and therefore cannot share `readGuardSource`.
 *
 * `GUARD_CLASSES` defines veto_only as "Absence is a sound veto; presence is
 * never evidence". Only an AFFIRMATIVE `false` — the source was read and the
 * thing is genuinely absent — may veto. `null` means the source could not be
 * read at all, which is not absence and therefore not a veto.
 *
 * Running a veto_only guard through `readGuardSource` collapses `null` to
 * `false` and turns it into a MANDATORY POSITIVE: with no marker reader wired,
 * guard 6 would fail 100% of answers with `guard_failed{askq_marker}` — a
 * refusal indistinguishable, to the client, from a question that went stale.
 * That is the fail-fast rule inverted: silent, and wrong in a way that looks
 * routine.
 */
async function readVetoGuardSource(
	name: AnswerGuardName,
	deps: AnswerDeps,
	read: () => Promise<GuardSourceResult>,
): Promise<boolean> {
	try {
		const value = await read();
		if (value === null) {
			deps.log({
				event: "companion.guard.unreadable_no_veto",
				guard: name,
				result: true,
			});
			return true;
		}
		return value;
	} catch (error) {
		// A source that THREW is also "could not read", not "absent".
		deps.log({
			event: "companion.guard.error",
			guard: name,
			result: true,
			error: error instanceof Error ? error.message : String(error),
		});
		return true;
	}
}

/**
 * §11.3 — all six guards, evaluated inside the caller's critical section.
 *
 * Order is load-bearing FIRST and short-circuiting. That is the mechanism by
 * which a forgeable source can never appear on a permitting path: if guard 1 or
 * guard 5 fails, the forgeable sources are not even read.
 *
 * `screen` is passed in rather than fetched, so the caller can prove the same
 * snapshot backed the decision and the write.
 */
export async function evaluateGuards(
	deps: AnswerDeps,
	input: {
		question: PendingQuestion;
		screen: string;
		expectation: ScreenExpectation;
		requireOptionIndex: number | null;
	},
): Promise<GuardOutcome> {
	const evaluation: GuardEvaluation = {
		transcript: false,
		screen: false,
		binding: false,
		permission_axis: false,
		session: false,
		askq_marker: false,
	};
	const passed: AnswerGuardName[] = [];
	/**
	 * Every step through the stack is checked against `GUARD_EVALUATION_ORDER`, so
	 * the classification's ordering rule is enforced against what this function
	 * ACTUALLY does rather than against the shape of the source below.
	 */
	const at = (guard: AnswerGuardName): void => {
		if (GUARD_EVALUATION_ORDER[passed.length] !== guard) {
			throw new Error(
				`(COMPANION-BRIDGE) guard stack self-check: reached ${guard} at position ${passed.length}, where GUARD_EVALUATION_ORDER requires ${String(GUARD_EVALUATION_ORDER[passed.length])}`,
			);
		}
	};
	const advance = (guard: AnswerGuardName): void => {
		at(guard);
		passed.push(guard);
	};
	const fail = (
		guard: AnswerGuardName,
		screenMatch: PickerScreenMatch | null,
	) => {
		at(guard);
		return {
			evaluation,
			passed,
			failed: guard,
			screenMatch,
		} satisfies GuardOutcome;
	};

	// --- guard 1: the tool call has not already been answered (LOAD-BEARING) ---
	const alreadyAnswered = await readGuardSource(
		"transcript",
		deps,
		async () => {
			const exists = await deps.toolResultExists({
				terminalId: input.question.terminalId,
				sessionId: input.question.sessionId,
				toolUseId: input.question.toolUseId,
			});
			// An unreadable transcript is `null` -> false -> guard fails. Inverting
			// here would turn "cannot check" into "no result yet", which is the
			// exact mistake this stack exists to avoid.
			return exists === null ? null : !exists;
		},
	);
	evaluation.transcript = alreadyAnswered;
	if (!alreadyAnswered) return fail("transcript", null);
	advance("transcript");

	// --- guard 5: the picker is on screen showing THIS question (LOAD-BEARING) ---
	const screenMatch = evaluateScreenGuard({
		screen: input.screen,
		question: input.question,
		expectation: input.expectation,
		requireOptionIndex: input.requireOptionIndex,
	});
	evaluation.screen = screenMatch.ok;
	if (!screenMatch.ok) return fail("screen", screenMatch);
	advance("screen");

	// Everything below is either forgeable or merely supporting. It can only
	// REFUSE from here; the two guards that can permit have already passed.

	// --- guard 3: the session is alive (supporting) ---
	const sessionOk = await readGuardSource("session", deps, () =>
		deps.sessionActive(input.question.terminalId),
	);
	evaluation.session = sessionOk;
	if (!sessionOk) return fail("session", screenMatch);
	advance("session");

	// --- guard 2: the agent<->session binding still matches (FORGEABLE) ---
	const bindingOk = await readGuardSource("binding", deps, async () => {
		const binding = await deps.agentBinding(input.question.terminalId);
		if (binding === null) return null;
		if (!binding.bound) return false;
		if (binding.kind !== "claude") return false;
		// A /resume or a restart mints a new agent session; the captured question
		// belongs to the old one and its tool_use_id can no longer be answered.
		if (binding.agentSessionId === null) return null;
		return binding.agentSessionId === input.question.sessionId;
	});
	evaluation.binding = bindingOk;
	if (!bindingOk) return fail("binding", screenMatch);
	advance("binding");

	// --- guard 4: the permission axis is still latched (FORGEABLE) ---
	const permissionOk = await readGuardSource("permission_axis", deps, () =>
		deps.permissionAxisLatched(input.question.terminalId),
	);
	evaluation.permission_axis = permissionOk;
	if (!permissionOk) return fail("permission_axis", screenMatch);
	advance("permission_axis");

	// --- guard 6: the .askq marker still exists (VETO ONLY) ---
	// Presence is NOT evidence — markers leak. Only its absence is used, and only
	// to refuse. An unreadable marker directory also refuses.
	const markerPresent = await readVetoGuardSource("askq_marker", deps, () =>
		deps.askqMarkerExists({
			terminalId: input.question.terminalId,
			agentId: input.question.agentId,
			agentType: input.question.agentType,
		}),
	);
	evaluation.askq_marker = markerPresent;
	if (!markerPresent) return fail("askq_marker", screenMatch);
	advance("askq_marker");

	return { evaluation, passed, failed: null, screenMatch };
}

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

/** The sealed codes this module is allowed to emit. A closed set, per §10. */
type SealedCode =
	| "stale_question"
	| "already_resolved"
	| "lease_held"
	| "guard_failed"
	| "picker_open"
	| "capability_unsupported"
	| "write_disabled"
	| "bad_request"
	| "internal";

function sealed(
	statusCode: number,
	code: SealedCode,
	message: string,
	detail: Record<string, unknown> | null = null,
): SealedError {
	return new SealedError(statusCode, {
		code,
		message,
		retryAfterMs: null,
		detail,
	});
}

/**
 * Maps a pure encoding failure. Every one of these provably wrote nothing: the
 * encoder runs before the lock is taken and touches no terminal.
 */
function sealedFromEncoding(error: KeystrokeEncodingError): SealedError {
	if (error.reason === "shape_unproven") {
		return sealed(
			501,
			"capability_unsupported",
			"this prompt shape has no proven byte sequence and is refused rather than guessed; answer it at the desk",
			{ capability: "answer.multiselect", reason: error.reason },
		);
	}
	return sealed(400, "bad_request", error.message, { reason: error.reason });
}

// ---------------------------------------------------------------------------
// idempotency store
// ---------------------------------------------------------------------------

/** The attempt file, alongside `devices/`, `nonces/` and `audit/`. */
export const ATTEMPT_STORE_FILENAME = "answer-attempts.json";

/**
 * (ATTEMPT-WITNESS) The attempt file's rise-only witness, in the SAME directory.
 *
 * Same directory is not incidental: what publishes the witness's rename is the
 * attempts file's own content fsync forcing the volume metadata log those two
 * renames share. See `readAttemptWitness`.
 */
export const ATTEMPT_WITNESS_FILENAME = "answer-attempts-witness.json";

/** Bumped ONLY for an incompatible shape change; an unknown version is quarantined. */
const ATTEMPT_FILE_VERSION = 1;

const ATTEMPT_FILE_MODE = 0o600;

/**
 * The only failure codes an attempt record may carry.
 *
 * `handleAnswer` writes exactly these two. The TYPE (`AttemptFailureCode`, in
 * `types.ts`) is what actually stops a third one being written: every record is
 * built as an `AnswerAttemptRecord`, so a code that is not in that union does not
 * compile, and this list and that union have to be widened together. This runtime
 * list is the disk boundary's copy of the same rule — one unrecognised code fails
 * the whole-file schema below and the whole file is then quarantined, so a single
 * mislabelled record would cost every other record's 24 h of coverage.
 *
 * `satisfies` ties the list to the type; the type ties it to `ErrorCode`.
 */
const ATTEMPT_FAILURE_CODES = [
	"guard_failed",
	"internal",
] as const satisfies readonly AttemptFailureCode[];

/**
 * A record whose shape this build cannot store — a PROGRAMMER error, not an I/O
 * failure, and separated from one so it cannot be swallowed as if it were.
 *
 * `recordOutcome` deliberately logs-and-continues when the disk write fails
 * (reporting a landed answer as failed is worse than an undurable record). That
 * tolerance must not extend to "this record can never be stored at all": a
 * `failureCode` outside `ATTEMPT_FAILURE_CODES` is thrown BEFORE the record
 * reaches memory, so swallowing it would leave the request's `in_flight` record
 * in place with nothing left to advance it — a permanent "still being typed" for
 * an attempt that finished. Distinguished by class and rethrown.
 */
export class AttemptRecordShapeError extends Error {}

const attemptGuardNameSchema = z.enum(
	Object.keys(GUARD_CLASSES) as [AnswerGuardName, ...AnswerGuardName[]],
);

/** An epoch-millisecond instant read off disk. One definition, four uses. */
const epochMsSchema = z.number().int().nonnegative();

/**
 * The witness mark, in either file. Bounded BELOW `Number.MAX_SAFE_INTEGER`
 * because `persist` increments it.
 *
 * At `MAX_SAFE_INTEGER` the increment stops advancing — `n + 1 === n` in a double
 * — so a file loaded at the boundary would be rewritten at a mark it already
 * carried, and the mark stops being an order. One past it, the value is no longer
 * an integer this schema accepts, so the NEXT start quarantines the file and every
 * record in it is lost. Neither is reachable by any real number of rewrites; both
 * are reachable from a hand-edited or corrupt file, which is exactly the input
 * this boundary exists to reject. Refusing the value here means such a file is
 * quarantined ONCE, deliberately, instead of first being written into a state that
 * silently cannot be ordered.
 */
const rewriteMarkSchema = z
	.number()
	.int()
	.nonnegative()
	.max(Number.MAX_SAFE_INTEGER - 1);

/**
 * The on-disk record, validated at the disk boundary exactly as a wire body is
 * validated at the HTTP boundary. Nothing here is trusted because it came from
 * our own directory.
 */
const attemptRecordSchema = z.object({
	requestId: z.string().min(1).max(64),
	questionId: z.string().min(1).max(64),
	deviceId: z.string().min(1).max(64),
	surface: z.enum(["phone", "watch"]),
	leaseId: z.string().min(1).max(64),
	startedAtMs: epochMsSchema,
	status: z.enum(["confirmed", "failed", "unconfirmed", "in_flight"]),
	resolvedAtMs: epochMsSchema.nullable(),
	failureCode: z.enum(ATTEMPT_FAILURE_CODES).nullable(),
	guardsPassed: z.array(attemptGuardNameSchema),
});

const attemptFileSchema = z.object({
	version: z.literal(ATTEMPT_FILE_VERSION),
	/**
	 * The instant from which a MISSING record proves the request never arrived,
	 * carried across every rewrite and advanced only when a gap is detected.
	 *
	 * LOAD-BEARING as of (ATTEMPT-WITNESS): `recordsSinceMs` publishes this value
	 * (floored by the retention) instead of this mount's start, which is what lets
	 * a MISSING record from before a restart be resolved as "the request never
	 * arrived" instead of the unhelpful "cannot tell". It does nothing for a
	 * record that is PRESENT — that one always read back with its own status,
	 * because the file is durable and the status handler returns it regardless of
	 * coverage. What
	 * made that unsound is unchanged — a file that a lost rename rolled back
	 * carries this stamp UNCHANGED and would assert over the very records the
	 * rollback removed — so it is only ever believed while the witness beside it
	 * can prove the file is the latest version that was ever durable. When the
	 * witness reports a gap instead, the store advances this stamp to the mount
	 * instant BEFORE it writes again, so the gap is recorded once in the file
	 * itself and no later, clean mount re-asserts over it.
	 */
	coverageSinceMs: epochMsSchema,
	/**
	 * The witness mark: how many durable rewrites this file has had. See
	 * `readAttemptWitness` for why a rewrite counter is the right mark.
	 *
	 * OPTIONAL, defaulting to 0, which is what a pre-(ATTEMPT-WITNESS) file
	 * hydrates as. That default is DIAGNOSTIC, not a licence to trust: an absent
	 * mark says only "no witness could have been written for this", and a file no
	 * witness can vouch for gets its coverage narrowed to the mount exactly like a
	 * file whose witness was deleted — see the `witness === null` branch in
	 * `createAttemptStore` for why treating those two as different reopened the
	 * whole failure. What the 0 is still good for is the LOG: it says which of the
	 * two situations a degraded mount is reporting.
	 *
	 * `ATTEMPT_FILE_VERSION` is deliberately NOT bumped for it: adding a field that
	 * an older build's schema simply strips is a compatible change, and a bump
	 * would quarantine every existing file — throwing away a real 24 h of records —
	 * for no gain, since those records are still SERVED after a degrade. Only the
	 * coverage window narrows.
	 */
	seq: rewriteMarkSchema.default(0),
	records: z.array(attemptRecordSchema),
});

// ---------------------------------------------------------------------------
// (ATTEMPT-WITNESS) the rise-only witness
// ---------------------------------------------------------------------------

/**
 * (ATTEMPT-WITNESS) A second, independent durable record of how far
 * `answer-attempts.json` has been written, so a file that a lost rename rolled
 * back is DETECTED rather than believed.
 *
 * WHY THE ATTEMPTS FILE NEEDED ONE. `writeFileDurable` gives content durability
 * and rename ORDER, but `syncDirectory` is a no-op on win32, so the most recent
 * rename can sit in the NTFS log for seconds and a hard reset reverts the file to
 * its previous version. `coverageSinceMs` survives that revert UNCHANGED, so the
 * file cannot declare its own gap: records the rollback removed would sit inside
 * a window still claiming to cover them, and `known: false` inside a covered
 * window is the terminal "the desktop never saw this request — it was not sent"
 * that §11.4 records as unrecoverable. Publishing a window that started at THIS
 * MOUNT was the honest answer while nothing could see the revert, and it cost
 * every pre-restart MISS its resolution on every restart the desktop performs —
 * which this fork does often. A miss that genuinely never arrived reported as
 * "cannot tell" instead of "it was not sent". Present records were never
 * affected either way.
 *
 * WHY A REWRITE COUNTER IS THE MARK. The question the mark has to answer is "is
 * this file BEHIND a version that was already durable" — an ORDER question, so
 * the mark must be ordered, and it must advance on every rewrite that can add a
 * record. A count of records is not monotonic (`prune` and `forget` lower it). A
 * write timestamp depends on a clock that can go backwards and cannot separate
 * two rewrites inside one millisecond. A content hash proves "different" but not
 * "behind", so it cannot tell a rollback from an ordinary prune. A rewrite
 * counter has none of those problems, needs no clock, and gaps in it are harmless
 * because only the comparison is ever read.
 *
 * IT IS A PLAIN INTEGER, NOT keys.ts's DECIMAL-STRING BIGINT. The send-nonce mark
 * counts nonces and genuinely reaches uint64; this one counts answers a human
 * sent from a phone, so `Number.MAX_SAFE_INTEGER` is unreachable by many orders
 * of magnitude and JSON round-trips it exactly. A bigint here would add a parsing
 * boundary to guard for no property gained.
 *
 * BOUND TO THE INSTALL `generation` — the state anchor's install identity, minted
 * once per install in `keys.ts`. A witness whose generation does not match means
 * the anchor was deleted or replaced while the witness survived, and nothing left
 * can prove the attempts file is current.
 *
 * ORDERING IS THE WHOLE MECHANISM, AND IT IS BORROWED WHOLE FROM SEND-WITNESS.
 * The witness is raised BEFORE the attempts file on every rewrite, and it is the
 * attempts file's own `handle.sync()` — a FlushFileBuffers, which forces NTFS's
 * volume metadata log, by then already carrying the witness's rename record —
 * that PUBLISHES the witness's rename. Call order alone would not: two renames
 * issued microseconds apart sit in the same unflushed window. So a crash cannot
 * discard the witness while keeping a file version it was meant to bound.
 *
 * THAT MAKES THE PAIRING LOAD-BEARING: every raise must be followed by the
 * attempts-file write, in the same directory, before anything reads coverage from
 * the file again. `persist()` is the only caller and does exactly that,
 * unconditionally. A WITNESS-ONLY WRITE PATH — a periodic refresh, a repair pass,
 * a raise whose file write is skipped — would put both renames in one unflushed
 * log window where a hard reset takes both, and coverage would silently go back
 * to being believed rather than proven. Do not add one.
 *
 * WHAT THIS DELIBERATELY DOES *NOT* DO, and it is the one place it must diverge
 * from SEND-WITNESS. `keys.ts` throws `StateRollbackError` and REFUSES TO START
 * on a witness mismatch, because a rewound send-nonce counter repeats a nonce and
 * that destroys AES-GCM outright. A rolled-back attempts file costs idempotency
 * and status RECORDS. Refusing to start would take away the phone's only channel
 * in order to protect a scratch file — the same trade `createAttemptStore`
 * already refuses to make for a malformed file. So every verdict this witness can
 * reach DEGRADES the published window to this mount, which is exactly the
 * behaviour that predates it, and logs loudly. Nothing about what the witness
 * SAYS may ever throw. (A witness that cannot be WRITTEN is a different fact —
 * the directory is not usable — and follows this store's existing I/O contract.)
 *
 * ABSENT is `null` with no reason: the first start after this build lands (the
 * file is then `seq: 0`, which is what makes that case distinguishable) or a
 * fresh install. UNPARSABLE, MALFORMED or UNREADABLE is also `null`, but WITH a
 * reason, because "cannot prove the file is current" is the degrade path and not
 * an outage.
 */
const ATTEMPT_WITNESS_VERSION = 1;

const attemptWitnessSchema = z.object({
	version: z.literal(ATTEMPT_WITNESS_VERSION),
	/**
	 * The anchor's install generation. Checked with the same canonical §0.1 test
	 * every other wire id crosses, so a generation that would compare unequal to
	 * the anchor's for a base64url encoding reason is refused here rather than
	 * silently reading as a rollback.
	 */
	generation: z.string().refine(isCanonicalWireId, {
		message: "not a canonical wire id",
	}),
	/** The highest `seq` `answer-attempts.json` was ever durably written with. */
	seq: rewriteMarkSchema,
});

type AttemptWitness = z.infer<typeof attemptWitnessSchema>;

/**
 * The witness, or `null` plus the reason it is unusable. NEVER throws — see the
 * section header: a witness cannot be allowed to fail the bridge's start.
 */
async function readAttemptWitness(
	path: string,
): Promise<{ witness: AttemptWitness | null; unusable: string | null }> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		// ENOENT is the first run or a fresh install and carries no reason; every
		// other read failure DOES, because it leaves the file unproven.
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { witness: null, unusable: null };
		}
		return {
			witness: null,
			unusable: `cannot be read (${
				error instanceof Error ? error.message : String(error)
			})`,
		};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		return {
			witness: null,
			unusable: `is not valid JSON (${
				error instanceof Error ? error.message : String(error)
			})`,
		};
	}
	const file = attemptWitnessSchema.safeParse(parsed);
	if (!file.success) {
		return {
			witness: null,
			unusable: `does not match the shape this build writes (${file.error.message})`,
		};
	}
	return { witness: file.data, unusable: null };
}

async function writeAttemptWitness(
	path: string,
	witness: AttemptWitness,
): Promise<void> {
	await writeFileDurable(
		path,
		new Uint8Array(
			Buffer.from(`${JSON.stringify(witness, null, "\t")}\n`, "utf8"),
		),
		ATTEMPT_FILE_MODE,
	);
}

/**
 * §11.4/§11.5 — the 24 h idempotency + status record, keyed by `requestId`.
 * A replay returns the RECORDED outcome; a status read reports it.
 *
 * ---------------------------------------------------------------------------
 * IT IS ON DISK, AND THAT IS THE WHOLE POINT
 * ---------------------------------------------------------------------------
 * This used to be a bare `Map` built in `start()`. §11.5 says two things a
 * process-lifetime map cannot honour: records are retained for 24 HOURS, and
 * `known: false` is an ASSERTION THAT NOTHING WAS SENT which has to be true
 * whenever it is made. The bridge deliberately dies with the desktop app, which
 * this fork restarts often, so after every restart every earlier `requestId`
 * came back `known: false` — and the client turns that into a TERMINAL
 * "the desktop never saw this request — it was not sent". For an answer that
 * actually landed, that sends the user to re-answer a picker at the desk, which
 * §11.4 records as unrecoverable. `(ANSWER-INFLIGHT)` closed the ~15 s
 * pre-injection window and left this much larger one open, with a worse message.
 *
 * So: `tmp -> fsync -> rename` on every write (`writeFileDurable`, the same
 * discipline the §3.5 replay cache uses), hydrated at start, and a `put` that
 * does not resolve until the record is durable. `handleAnswer` awaits the
 * `in_flight` put BEFORE it takes the terminal lock, so any attempt that could
 * possibly have written a byte has a durable record first — which is what makes
 * `recordsSinceMs` a real guarantee rather than a hope.
 */
export interface AttemptStore {
	get(requestId: RequestId): AnswerAttemptRecord | null;
	/**
	 * Records in memory AND on disk. Resolves only once the record is durable;
	 * rejects if it could not be made durable, so the caller decides what an
	 * unrecordable attempt means (before the lock: refuse; after it: log, because
	 * a landed write must never be reported as failed).
	 */
	put(record: AnswerAttemptRecord): Promise<void>;
	/**
	 * Undoes a `put` whose durable write REJECTED, for a caller that is about to
	 * tell the client nothing was written.
	 *
	 * `put` records in memory before it persists, because the post-lock caller
	 * MUST keep an accurate in-memory outcome even when the disk write fails — a
	 * landed answer that read back as unsent is the exact lie this store exists to
	 * remove. The pre-lock caller needs the opposite: its 503 says "nothing was
	 * typed; nothing was written", and a surviving `in_flight` record would make
	 * `/v1/answer/status` answer "still being typed" for that same requestId
	 * forever (nothing advances a record whose lock was never taken), while a
	 * replay would collect `409 lease_held`. The store cannot pick one ordering,
	 * so the caller that needs the rollback asks for it.
	 *
	 * Identity, not requestId alone: if a concurrent attempt has already replaced
	 * the record, the newer one is live and dropping it would strand THAT attempt.
	 * Removal from memory is the guarantee — that is what `get` reads. The rewrite
	 * is attempted and a failure is logged, not thrown: the disk copy (if any)
	 * rehydrates as `unconfirmed`, which §11.5 permits, while the caller's own
	 * loud refusal is already on its way out.
	 */
	forget(record: AnswerAttemptRecord): Promise<void>;
	/** Drops records past the retention. Returns how many. */
	prune(nowMs: EpochMs): Promise<number>;
	/**
	 * The instant from which `known: false` is PROVABLY "nothing was sent".
	 *
	 * The bridge guarantees: for every answer attempt it admitted whose attempt
	 * began at or after this instant, a record exists — so `known: false` for a
	 * request the client sent after it means the request never arrived. Before it,
	 * `known: false` means only "no record", and §11.5 requires the client to
	 * render that as `unconfirmed`, never as failed.
	 *
	 * It is `max(the store's PROVEN coverage start, nowMs - retention)`: a record
	 * older than the retention has been pruned, and a record from before the
	 * coverage start cannot be asserted over at all.
	 *
	 * IT REACHES BEHIND THIS MOUNT, WHICH IS THE POINT OF THE FILE. The coverage
	 * start is the FILE's own `coverageSinceMs` whenever
	 * `answer-attempts-witness.json` proves the file is the latest version that was
	 * ever durable, so a MISSING record from before a restart can be resolved as
	 * "it never arrived" rather than "cannot tell". A record that is PRESENT keeps
	 * its own status either way — that never depended on this. What made that
	 * unsound before the witness is unchanged, and is exactly why the witness
	 * exists: `writeFileDurable` cannot force a directory entry on win32
	 * (`syncDirectory` returns immediately there), so a hard reset can discard this
	 * file's most recent rename and revert it to an earlier version — and the
	 * reverted file carries the SAME `coverageSinceMs` as the version that was
	 * lost, so it cannot declare its own gap. The witness is what turns that from
	 * believed into detected (ATTEMPT-WITNESS).
	 *
	 * WHEN THE WITNESS CANNOT PROVE IT the coverage start DEGRADES to this mount,
	 * which is precisely the window that predates the witness: a rollback needs a
	 * crash and therefore a restart, so a window starting at this mount is one a
	 * rollback can never reach behind. Records already in the file are still
	 * returned either way — degrading narrows what a MISSING record proves, not
	 * what a present one says. `createAttemptStore` degrades and logs; it never
	 * refuses to start, because a scratch file must not be able to take down the
	 * phone's only channel.
	 */
	recordsSinceMs(nowMs: EpochMs): EpochMs;
	/**
	 * Releases the store: every later write becomes a no-op.
	 *
	 * (STORE-CLOSED) This is what actually stops a stale writer, and it belongs
	 * here rather than in the scheduler. `nonceCache` and `deviceStore` already
	 * guard themselves this way; this store did not, and it is the one that got
	 * clobbered — a detached `prune` from a stopped bridge resumed after a
	 * replacement had written newer state and rewrote the file from its own stale
	 * snapshot.
	 *
	 * The teardown ALSO drains in-flight maintenance (MAINTENANCE-DRAIN), but a
	 * drain alone cannot be the answer: waiting is unbounded by nature, `settle`
	 * imposes no timeout, and `stop()` runs inside the lifecycle's `exclusive()` —
	 * so one `persist` stalled on a handle an antivirus or indexer is holding would
	 * hang `stop()` forever and no later `start()` could ever run. A guard here
	 * needs no waiting at all: whatever the scheduler failed to cancel finds the
	 * door shut. `deviceStore` makes the same point — its debounced persist is
	 * detached and invisible to any drain, and `closed` is what protects it.
	 *
	 * Idempotent, and NOT an error to write after: a stale caller is doing what it
	 * was told to do before the door closed, so its write is dropped quietly rather
	 * than thrown at code that has no way to handle it.
	 */
	close(): void;
}

/**
 * Opens (and hydrates) the durable attempt store.
 *
 * `dir` is the companion root — already created and ACL-restricted to this user
 * by `ensureCompanionDirs` before this is called.
 *
 * TWO DIFFERENT FAILURES, TWO DIFFERENT ANSWERS:
 *
 *  - the file cannot be READ or WRITTEN (EPERM, EIO, a full disk): THROW. The
 *    bridge would be unable to record the answers it types, and the first write
 *    at the bottom of this function proves the path is usable before a single
 *    request can be served. The witness shares the directory and is written by
 *    that same first write, so it is covered by this clause and by no other.
 *  - the file is present but MALFORMED (truncated by something that is not this
 *    code, hand-edited, written by a second process): it is moved aside, the
 *    fault is logged, and the store starts EMPTY. This is not tolerance of bad
 *    state — the bad file is preserved for diagnosis and nothing from it is
 *    believed — and it cannot re-open the failure this store exists to close:
 *    the published coverage window starts at this mount either way, so every
 *    request older than this moment reads back as `unconfirmed`, never as "it
 *    was not sent". Throwing instead would turn a scratch file into a total
 *    outage of the phone's only channel, which is the same trade
 *    `device-store`'s pending-destroy list already refuses to make.
 *
 * AND A THIRD, ADDED WITH (ATTEMPT-WITNESS): the file parses but the witness
 * cannot prove it is CURRENT (rolled back, bound to another install generation,
 * unreadable, missing beside a file this build wrote, or unbindable because no
 * generation was supplied). That is the same answer as MALFORMED minus the
 * quarantine: the records are kept and still served, and only the published
 * window degrades to this mount. It follows the malformed clause's reasoning
 * exactly — and NOT `keys.ts`'s, which refuses to start on the same shape,
 * because a repeated nonce breaks AES-GCM while a lost attempt record costs a
 * status read its precision.
 */
export async function createAttemptStore(options: {
	dir: string;
	/** Structured diagnostics. Never carries question or answer text. */
	log: (event: Record<string, unknown>) => void;
	/**
	 * The install `generation` from the state anchor (`keys.ts`), which is what
	 * binds the witness to this install.
	 *
	 * REQUIRED, but explicitly nullable. A missing or non-canonical value DEGRADES
	 * coverage to this mount rather than throwing — the (ATTEMPT-WITNESS) rule that
	 * nothing about the witness may take the bridge down — and that runtime
	 * leniency is exactly why the TYPE has to be strict. As an optional property it
	 * compiled when omitted and then silently cost every mount its pre-restart
	 * coverage, guarded only by a warn nobody reads. `index.ts` opens the anchor
	 * before it builds this store, so an absent generation is a WIRING mistake
	 * rather than a state fact: making the caller write `null` on purpose is the
	 * difference between declaring that and forgetting it. Compare the `log`
	 * option, which throws at this same boundary for the same class of fault.
	 */
	generation: string | null;
	retentionMs?: DurationMs;
	nowMs?: EpochMs;
}): Promise<AttemptStore> {
	const retentionMs = options.retentionMs ?? ANSWER_ATTEMPT_RETENTION_MS;
	const path = join(options.dir, ATTEMPT_STORE_FILENAME);
	const witnessPath = join(options.dir, ATTEMPT_WITNESS_FILENAME);
	const startedAtMs = options.nowMs ?? Date.now();
	/**
	 * Asserted at the boundary, because (ATTEMPT-WITNESS) made an omission newly
	 * fatal and in the least useful way.
	 *
	 * `log` is required by the type, so a caller without one is a programmer error
	 * — but before the witness this function only logged on the malformed-file and
	 * persist-failure paths, so a JS caller that omitted it ran clean through every
	 * ordinary open and never found out. The witness added a path that logs on a
	 * PERFECTLY HEALTHY open (a caller that supplies no generation degrades, and a
	 * degrade logs), which turned that latent omission into a `TypeError` thrown
	 * from inside `degradeCoverage` — pointing at this file's internals for a fault
	 * that belongs entirely to the caller, and doing it while executing the very
	 * path whose whole contract is "this must never take the bridge down".
	 *
	 * So: name the fault here, where it is true, rather than letting it surface as
	 * an internal crash somewhere it is not.
	 */
	if (typeof options.log !== "function") {
		throw new TypeError(
			`(COMPANION-BRIDGE) createAttemptStore requires a \`log\` function; got ${typeof options.log}. This is a caller wiring fault — the store logs on ordinary opens (a degraded coverage window is reported, not silent), so there is no path that can run without it.`,
		);
	}
	const log = options.log;
	const records = new Map<RequestId, AnswerAttemptRecord>();

	// Validated ONCE, at the boundary, with the same canonical §0.1 test the
	// generation crosses everywhere else — an id that passes an outer gate and
	// fails an inner one is the failure `isCanonicalWireId` was written to close.
	// `null` from here on means "this mount cannot witness anything", and every
	// path below reads that one variable rather than re-deriving the condition.
	const generation = isCanonicalWireId(options.generation)
		? options.generation
		: null;

	let raw: string | null;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			throw new Error(
				`(COMPANION-BRIDGE) cannot read the answer-attempt store at ${path}; §11.5 cannot be honoured without it: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
		raw = null;
	}

	let coverageSinceMs = startedAtMs;
	/** The file's rewrite mark. 0 = no file, or one written before this witness. */
	let seq = 0;
	if (raw !== null) {
		/**
		 * Moves the unusable file aside and starts with no coverage. A failure to
		 * even rename it DOES throw: at that point the directory itself is not
		 * behaving, and the next `writeFileDurable` would fail anyway.
		 */
		const quarantine = async (why: string): Promise<void> => {
			const aside = `${path}.corrupt-${startedAtMs}`;
			await rename(path, aside);
			log({
				event: "companion.answer.attempt_store_corrupt",
				path,
				movedTo: aside,
				why,
				effect:
					"records before this start are gone; /v1/answer/status reports them as unconfirmed, never as unsent",
			});
		};

		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (error) {
			await quarantine(
				`not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
			);
			parsed = null;
		}
		if (parsed !== null) {
			const file = attemptFileSchema.safeParse(parsed);
			if (!file.success) {
				await quarantine(
					`does not match the shape this build writes: ${file.error.message}`,
				);
			} else {
				// Carried forward, floored at this start so a future-dated stamp from a
				// skewed clock cannot claim coverage that has not happened yet. It is
				// what `recordsSinceMs` publishes — but only if the witness verdict
				// below leaves it alone.
				coverageSinceMs = Math.min(file.data.coverageSinceMs, startedAtMs);
				seq = file.data.seq;
				for (const record of file.data.records) {
					if (startedAtMs - record.startedAtMs > retentionMs) continue;
					records.set(
						record.requestId,
						// An `in_flight` record was written by a process that is now GONE:
						// it took the lease, wrote the record, and died before it could
						// record the outcome. Keystrokes may or may not have landed, which
						// is precisely `unconfirmed` — "it was sent, the outcome is
						// unknown, NEVER re-send". Leaving it `in_flight` would make the
						// client poll a record nothing will ever advance; dropping it
						// would answer `known: false`, which is the lie this store exists
						// to remove.
						record.status === "in_flight"
							? { ...record, status: "unconfirmed" }
							: record,
					);
				}
			}
		}
	}

	/**
	 * (ATTEMPT-WITNESS) Gives up on the file's own stamp.
	 *
	 * It does not merely narrow what THIS mount publishes — it advances the stamp
	 * the file is about to be rewritten with, so the gap is recorded ONCE, in the
	 * file, and the next clean mount reads a stamp that already excludes it instead
	 * of re-asserting over it. A gap is permanent; a degraded mount that healed the
	 * stamp back would hand the lie to its successor.
	 */
	const degradeCoverage = (why: string): void => {
		coverageSinceMs = startedAtMs;
		log({
			event: "companion.answer.attempt_coverage_degraded",
			path,
			witnessPath,
			why,
			effect:
				"records already in the file are still served; only the coverage window narrows to this mount, so an earlier request with no record reports as unconfirmed, never as unsent",
		});
	};

	if (generation === null) {
		// Nothing this mount writes can be witnessed, so any witness left beside the
		// file goes stale at the first `persist()` below — and a stale witness reads
		// as merely BEHIND the file, which is the harmless direction and would make
		// the next mount BELIEVE a file that advanced unwitnessed. Removing it is
		// what makes the next mount see `seq >= 1` with no witness and degrade, which
		// is the truth. A removal that fails is logged, not thrown: the degrade below
		// stands either way and the bridge must still start.
		try {
			await unlink(witnessPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				log({
					event: "companion.answer.attempt_witness_unlink_failed",
					witnessPath,
					error: error instanceof Error ? error.message : String(error),
					effect:
						"a witness this mount cannot bind is still on disk; the next mount may read it as behind the file and believe an unwitnessed file",
				});
			}
		}
		degradeCoverage(
			// `undefined` as well as `null`: the type now REQUIRES the property, so a
			// caller that omits it entirely is untyped (a harness, or JS) — and it is
			// making exactly the mistake this branch reports, so it should read the
			// same message rather than "the generation supplied (undefined)".
			options.generation === null || options.generation === undefined
				? "no install generation was supplied, so no witness can be bound to this install — this is a wiring fault in the caller, not a state fact"
				: `the install generation supplied (${String(options.generation)}) is not a canonical wire id, so no witness can be bound to it`,
		);
	} else {
		const { witness, unusable } = await readAttemptWitness(witnessPath);
		if (unusable !== null) {
			degradeCoverage(`the witness ${unusable}`);
		} else if (witness === null) {
			// NO WITNESS AND A FILE THAT REACHES BACK IS AN UNPROVABLE CLAIM, whatever
			// wrote it.
			//
			// This deliberately does NOT distinguish "a build that predates the witness
			// wrote this" (`seq` absent, schema-defaulted to 0) from "the witness was
			// removed" (`seq >= 1`). An earlier revision trusted the first case once,
			// reasoning that a legacy file is legitimately unwitnessed. It is — and it
			// is also exactly as unverifiable as a deleted witness, so trusting it
			// reopened the precise lie this witness exists to remove: the OLD build
			// could lose a rename the same way (win32 cannot force a directory entry),
			// reverting the file while its `coverageSinceMs` stamp stayed put, and the
			// first mount of THIS build would then publish that stamp as proven and
			// report a landed answer's missing record as the terminal "it was not
			// sent". Nothing about a seq-0 file can rule that out.
			//
			// The test is therefore whether the stamp claims anything at all: a file
			// whose stamp predates this mount is asserting coverage that no witness
			// backs. A fresh install (no file, or a stamp already at this mount) claims
			// nothing, so it degrades nothing and stays silent rather than logging a
			// fault that did not happen.
			//
			// The cost is one mount: an upgrading install loses its pre-restart
			// coverage exactly once — which is the behaviour of every build before this
			// change — and is witnessed from the `persist()` below onwards. Set against
			// a possible false "it was not sent" for an answer that landed, this is the
			// trade the rest of the subsystem already makes everywhere: over-claiming
			// is the worst outcome, and narrowing the window is the harmless direction.
			if (coverageSinceMs < startedAtMs) {
				degradeCoverage(
					seq > 0
						? `the witness is missing beside an attempts file this build wrote (seq ${seq}) — it was deleted or never landed, so nothing can prove the file is current`
						: "the attempts file carries no rewrite mark, so it was written by a build with no witness — its coverage stamp cannot be verified, and a rollback under that build would be invisible",
				);
			}
		} else if (witness.generation !== generation) {
			degradeCoverage(
				`the witness was written under install generation ${witness.generation} but this install is ${generation} — the state anchor was deleted or replaced while the witness survived, so nothing can prove freshness`,
			);
		} else if (witness.seq > seq) {
			// THE CASE THIS WITNESS WAS BUILT FOR. The witness is raised before the
			// file, so a witness ahead of the file means the file's rename was lost and
			// reverted it to an earlier version — taking records with it that the
			// unchanged `coverageSinceMs` would otherwise claim to cover.
			degradeCoverage(
				`the witness records rewrite ${witness.seq} but the attempts file is at ${seq} — the file's most recent rename was lost, so records it held are gone`,
			);
		}
		// A matching generation with `witness.seq <= seq` needs nothing: the file is
		// the latest version that was ever durable, and its stamp stands. BEHIND is
		// the harmless direction — the witness's own rename was lost, which the
		// `persist()` below repairs by raising it past the file.
		seq = Math.max(seq, witness?.seq ?? 0);
	}

	/** Serialises rewrites: `writeFileDurable` uses one tmp name per target. */
	let tail: Promise<unknown> = Promise.resolve();

	/** (STORE-CLOSED) Set by `close()`; every later rewrite is dropped. */
	let closed = false;

	/**
	 * (ATTEMPT-WITNESS) Raises the mark, RAISE-ONLY, checked against the FILE
	 * rather than against this object's beliefs — the same discipline as
	 * `raiseWitness` in `keys.ts`, and for the same reason: a witness whose own
	 * rename was lost is repaired on the next raise instead of being trusted, and a
	 * lowered witness could not bound a rolled-back file at all. A raise to the
	 * value already durable writes nothing.
	 *
	 * A witness that is unreadable or bound to another generation is REPLACED, not
	 * thrown over: this store may never fail a `put` because of what a witness
	 * SAYS, and the coverage such a witness would have proven is already forfeit
	 * for this mount (the verdict above degraded it). Replacing it is what makes
	 * the NEXT mount provable again.
	 *
	 * A raise that cannot be WRITTEN does reject, and deliberately: the alternative
	 * is a file that advanced beyond its witness, which reads as merely "behind" at
	 * the next start and would make an unwitnessed file be believed. A rejected
	 * `put` is a path `handleAnswer` already handles on both sides of the lock — an
	 * unwitnessed advance is a silent lie, and silence is the thing this subsystem
	 * exists to remove.
	 */
	const raiseWitness = async (through: number): Promise<void> => {
		if (generation === null) return;
		const { witness } = await readAttemptWitness(witnessPath);
		if (
			witness !== null &&
			witness.generation === generation &&
			witness.seq >= through
		) {
			return;
		}
		await writeAttemptWitness(witnessPath, {
			version: ATTEMPT_WITNESS_VERSION,
			generation,
			seq: through,
		});
	};

	function persist(): Promise<void> {
		const run = tail.then(async () => {
			// (STORE-CLOSED) Checked INSIDE the serialised section, not before it: a
			// rewrite that queued while the store was open can still be sitting in
			// `tail` when `close()` lands, and that queued write is exactly the stale
			// writer this guard exists to stop. Checking on entry would let it through.
			if (closed) return;
			// (ATTEMPT-WITNESS) One rewrite, one mark, and the mark is raised BEFORE
			// the file — the ordering the witness's whole guarantee rests on (see
			// `readAttemptWitness`). It advances on EVERY rewrite rather than only on
			// `put`, so "the file is behind what was witnessed" stays a single
			// comparison instead of a case analysis over which kind of write was lost.
			// `prune` and `forget` cost one extra small durable write each; both are
			// rare next to the answer path, and neither is on it.
			const next = seq + 1;
			// (ATTEMPT-WITNESS) A witness that cannot be WRITTEN degrades coverage; it
			// does not take the bridge down.
			//
			// This was the rule from the start and the code broke it anyway. The raise
			// was unguarded, so any write fault on the witness — ENOSPC, EACCES, a
			// backup or indexer holding the target against replacement, a directory
			// sitting at the path, a failing sync or close — rejected the whole
			// `persist`. `createAttemptStore` ends with an unconditional proving write,
			// so the rejection propagated out of the store's construction and
			// `startCompanionBridgeIfEnabled` rethrew it: a fault in the SECOND file
			// took away the phone's only channel, to protect an idempotency record.
			// Read, JSON and schema faults were already handled; only the write path
			// was not.
			//
			// Continuing after the degrade is safe, and specifically because
			// `degradeCoverage` advances `coverageSinceMs` BEFORE `file` is built two
			// lines below. The file therefore lands carrying a stamp that claims
			// nothing earlier than this mount, so the witness-behind-file state this
			// leaves — which the next mount deliberately trusts — publishes a window
			// that is honest even though this rewrite went unwitnessed.
			try {
				await raiseWitness(next);
			} catch (error) {
				degradeCoverage(
					`the witness could not be written (${error instanceof Error ? error.message : String(error)}), so this rewrite is unwitnessed`,
				);
			}
			const file = {
				version: ATTEMPT_FILE_VERSION,
				coverageSinceMs,
				seq: next,
				records: [...records.values()],
			};
			await writeFileDurable(
				path,
				new Uint8Array(
					Buffer.from(`${JSON.stringify(file, null, "\t")}\n`, "utf8"),
				),
				ATTEMPT_FILE_MODE,
			);
			// Only after the write is durable. A failed write leaves `seq` where it
			// was, so the next `persist` re-raises to the same mark (a no-op against
			// the witness already on disk) and writes the file at it — the file never
			// silently skips past a mark it was never written with.
			seq = next;
		});
		tail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	// Written once at start, unconditionally: it stamps `coverageSinceMs` for a
	// fresh store, collapses any `in_flight` records the previous process left,
	// raises the witness so a file that predates it (or a degraded mount's file) is
	// witnessed from here on, and — the reason it is not conditional — PROVES both
	// files are writable before the bridge accepts an answer it would then be
	// unable to record.
	await persist();

	return {
		get(requestId) {
			return records.get(requestId) ?? null;
		},
		async put(record) {
			if (
				record.failureCode !== null &&
				!(ATTEMPT_FAILURE_CODES as readonly string[]).includes(
					record.failureCode,
				)
			) {
				throw new AttemptRecordShapeError(
					`(COMPANION-BRIDGE) refusing to record answer attempt ${record.requestId} with failureCode ${record.failureCode}: add it to ATTEMPT_FAILURE_CODES and to AttemptFailureCode, or the next start cannot parse its own store`,
				);
			}
			records.set(record.requestId, record);
			await persist();
		},
		async forget(record) {
			// (STORE-CLOSED) Same reason as `prune`: this removes from memory first.
			if (closed) return;
			if (records.get(record.requestId) !== record) return;
			records.delete(record.requestId);
			try {
				await persist();
			} catch (error) {
				log({
					event: "companion.answer.attempt_forget_persist_failed",
					requestId: record.requestId,
					questionId: record.questionId,
					error: error instanceof Error ? error.message : String(error),
					effect:
						"the record is gone from memory, which is what /v1/answer/status reads; a copy left on disk rehydrates as unconfirmed, never as sent",
				});
			}
		},
		async prune(nowMs) {
			// (STORE-CLOSED) Guarded HERE as well as inside `persist`, because prune
			// mutates memory before it writes. Dropping records from the map while the
			// rewrite is refused would leave this store's answers disagreeing with its
			// own file — `get` reads the map, so a read racing teardown would report a
			// miss for a record still durably present. Nothing may reach this store's
			// state once its bridge is gone, in memory or on disk.
			if (closed) return 0;
			let dropped = 0;
			for (const [requestId, record] of [...records]) {
				if (nowMs - record.startedAtMs <= retentionMs) continue;
				records.delete(requestId);
				dropped += 1;
			}
			if (dropped > 0) await persist();
			return dropped;
		},
		recordsSinceMs(nowMs) {
			// `coverageSinceMs` IS the proven start: the file's own stamp when the
			// witness proved the file current, or this mount's start when it could not
			// (`degradeCoverage` collapses the two cases into one variable rather than
			// leaving a second one for a later reader to keep in step). Floored by the
			// retention because anything older has been pruned.
			return Math.max(coverageSinceMs, nowMs - retentionMs);
		},
		close() {
			closed = true;
		},
	};
}

/**
 * §7.5 — the message path's own idempotency record. Kept separate from
 * `AnswerAttemptRecord` rather than folded into it: a message has no question
 * and no lease, and inventing empty values for those would put fiction into the
 * audit trail the residual race (§11.7) depends on.
 */
export interface MessageAttemptRecord {
	requestId: RequestId;
	terminalId: TerminalId;
	startedAtMs: EpochMs;
	status: "sent" | "unconfirmed" | "failed";
	sentAtMs: EpochMs | null;
}

export interface MessageAttemptStore {
	get(requestId: RequestId): MessageAttemptRecord | null;
	put(record: MessageAttemptRecord): void;
	prune(nowMs: EpochMs): number;
}

export function createMessageAttemptStore(
	options: { retentionMs?: DurationMs } = {},
): MessageAttemptStore {
	const retentionMs = options.retentionMs ?? ANSWER_ATTEMPT_RETENTION_MS;
	const records = new Map<RequestId, MessageAttemptRecord>();
	return {
		get(requestId) {
			return records.get(requestId) ?? null;
		},
		put(record) {
			records.set(record.requestId, record);
		},
		prune(nowMs) {
			let dropped = 0;
			for (const [requestId, record] of [...records]) {
				if (nowMs - record.startedAtMs <= retentionMs) continue;
				records.delete(requestId);
				dropped += 1;
			}
			return dropped;
		},
	};
}

// ---------------------------------------------------------------------------
// POST /v1/answer
// ---------------------------------------------------------------------------

/**
 * Records an outcome the injection has already produced.
 *
 * An I/O failure here is LOGGED, not thrown, and that is a deliberate asymmetry
 * with the `in_flight` put above rather than a swallowed error. By the time this
 * runs the keystrokes have already landed (or, for `guard_failed`, provably have
 * not), so throwing would replace a truthful `confirmed` / `unconfirmed` response
 * with a 500 the client renders as a failure — and §11.5 forbids reporting a
 * landed write as failed far more strongly than it requires this particular
 * update to be durable. The in-memory record still answers every status read for
 * the life of this process; if the process then dies, the durable `in_flight`
 * record written before the lock rehydrates as `unconfirmed`, which is the safe
 * direction.
 *
 * `AttemptRecordShapeError` is EXEMPT and rethrown. It is a programmer error —
 * a `failureCode` that is not in `ATTEMPT_FAILURE_CODES` — raised BEFORE the
 * record reaches memory, so logging it would leave the pre-lock `in_flight`
 * record standing with nothing left to advance it: `/v1/answer/status` would
 * report "still being typed" for an attempt that has finished, for the life of
 * the process. Loud is the only safe direction for a fault whose quiet form is
 * indistinguishable from a hang.
 */
async function recordOutcome(
	deps: AnswerDeps,
	record: AnswerAttemptRecord,
): Promise<void> {
	try {
		await deps.attempts.put(record);
	} catch (error) {
		if (error instanceof AttemptRecordShapeError) throw error;
		deps.log({
			event: "companion.answer.attempt_persist_failed",
			requestId: record.requestId,
			questionId: record.questionId,
			status: record.status,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

// ---------------------------------------------------------------------------
// the shared pre-lock preflight
// ---------------------------------------------------------------------------

/**
 * The ONLY agent kind either write path may type into.
 *
 * Both endpoints used to state this for themselves, so "which agents are
 * writable" was one policy living in two places: `handleAnswer` special-cased
 * `codex` and then rejected everything that was not `claude`, while
 * `handleMessage` rejected everything that was not `claude` with a different
 * code. Widening the bridge to a second agent had to be remembered twice, and
 * the failure of remembering is a write to an agent whose picker semantics the
 * byte contract in `keystrokes.ts` was never proven against.
 */
const WRITABLE_AGENT_KIND: AgentKind = "claude";

/**
 * The binding half of the preflight, shared by both write paths: this terminal
 * carries an agent binding, and that agent is one the bridge may write to.
 *
 * Only the POLICY is shared. The refusal for a non-writable kind is supplied by
 * the caller, because the two endpoints mean genuinely different things by it —
 * an answer to a Codex picker is a capability this version does not have, while
 * a message to ANY non-Claude agent cannot be sent at all because the picker
 * store that gates the trailing `\r` is structurally blind to it.
 *
 * Deliberately returns nothing. The binding is re-read INSIDE the lock by guard
 * 2 on the answer path; a value carried out of here would be a pre-lock fact
 * that looks like a post-lock one.
 */
async function assertWritableBinding(
	deps: AnswerDeps,
	terminalId: TerminalId,
	notWritable: (kind: AgentKind) => SealedError,
): Promise<void> {
	const binding = await deps.agentBinding(terminalId);
	if (binding === null || !binding.bound) {
		throw sealed(412, "guard_failed", "terminal has no agent binding", {
			guard: "no_agent_binding",
		});
	}
	if (binding.kind !== WRITABLE_AGENT_KIND) throw notWritable(binding.kind);
}

/**
 * The host.db half of the preflight: the opaque wire handle resolves to a live
 * `(terminal, workspace)` pair. Both ids come back together — see
 * `AnswerDeps.resolveHostTerminal` for why resolving them separately once made
 * every answer fail as `Terminal session not found`.
 */
async function requireHostTerminal(
	deps: AnswerDeps,
	terminalId: TerminalId,
): Promise<HostTerminalRef> {
	const host = await deps.resolveHostTerminal(terminalId);
	if (host === null) {
		throw sealed(412, "guard_failed", "terminal has no workspace", {
			guard: "session",
		});
	}
	return host;
}

/**
 * The whole write.
 *
 * Refusals are cheap and happen before anything is acquired; the lease, the
 * audit line and the terminal lock are taken in that order, and the lease is
 * released on every exit path.
 */
export async function handleAnswer(
	deps: AnswerDeps,
	ctx: SealedRequestContext,
	request: AnswerRequest,
): Promise<AnswerResponse> {
	// 1. Idempotent replay. The SAME requestId NEVER re-executes — it returns the
	//    recorded outcome of the original attempt (§11.4). A recorded FAILURE is
	//    re-thrown as that failure; downgrading it to "unconfirmed" would send the
	//    client to /v1/answer/status for an outcome we already know.
	const previous = deps.attempts.get(request.requestId);
	if (previous !== null) {
		if (previous.status === "failed") {
			throw sealed(
				412,
				(previous.failureCode as SealedCode | null) ?? "guard_failed",
				"this answer attempt already failed; it is never re-executed",
				{ guard: "session" },
			);
		}
		// (ANSWER-INFLIGHT) The sequence for this very requestId is still typing.
		// Returning `recordToResponse` here would report `unconfirmed`, which the
		// client treats as terminal, for a write that is about to confirm. The
		// lease is genuinely held — say so, and let the client poll §11.5.
		if (previous.status === "in_flight") {
			throw sealed(
				409,
				"lease_held",
				"this answer is still being typed into the terminal; poll /v1/answer/status",
				{ leaseHolderLabel: null, expiresInMs: null },
			);
		}
		return recordToResponse(previous);
	}

	// 2. Panic write-disable. The phone can always reduce its own privilege.
	if (!ctx.device.writeEnabled) {
		throw sealed(
			403,
			"write_disabled",
			"write access is disabled for this device; re-enable is desktop-only",
		);
	}

	// 3..6. The question must still be the thing the client thinks it is.
	const question = deps.questions.get(request.questionId);
	if (question === null) {
		throw sealed(410, "stale_question", "unknown question");
	}
	if (question.state === "resolved") {
		throw sealed(
			409,
			"already_resolved",
			"this question was already answered",
			{
				resolvedBy: question.resolvedBy,
				resolvedAtMs: question.resolvedAtMs,
				outcome: "answered",
			},
		);
	}
	if (question.state !== "pending") {
		throw sealed(410, "stale_question", `question is ${question.state}`);
	}
	if (question.fingerprint !== request.fingerprint) {
		// Constant-time comparison is unnecessary: the client was given this value
		// and it is not a secret. What matters is that a mismatch writes nothing.
		throw sealed(
			410,
			"stale_question",
			"fingerprint no longer matches; the question moved on",
		);
	}

	// 7. Free text requires biometric confirmation at the client (§11.2).
	const hasFreeText = request.answers.some((item) => item.kind === "freetext");
	if (hasFreeText && !request.confirmedBiometric) {
		throw sealed(
			400,
			"bad_request",
			"free text requires confirmedBiometric === true",
		);
	}

	// 8. Encode. PURE — no terminal, no lock, so every failure here provably
	//    wrote nothing.
	let keystrokes: Keystroke[];
	try {
		keystrokes = encodeAnswer(question.questions, request.answers);
	} catch (error) {
		if (error instanceof KeystrokeEncodingError)
			throw sealedFromEncoding(error);
		throw error;
	}

	// 9. Refuse plain shells and non-Claude agents EXPLICITLY. This reads a
	//    forgeable source, which is sound here because it can only cause a
	//    refusal — a forged binding cannot make us write.
	await assertWritableBinding(deps, question.terminalId, (kind) =>
		kind === "codex"
			? // v1 scope: the byte contract was established against Claude Code and
				// NONE of it generalises — Codex's picker is a different program with
				// different keys. Refused explicitly rather than attempted.
				sealed(
					501,
					"capability_unsupported",
					"Codex terminals cannot be answered from the companion in v1",
					{ capability: "agent.codex" },
				)
			: sealed(412, "guard_failed", `unsupported agent kind: ${kind}`, {
					guard: "no_agent_binding",
				}),
	);

	const host = await requireHostTerminal(deps, question.terminalId);

	// The branded writer. Minted (and probed) here rather than inside the lock, so
	// a mis-wired writer fails before a lease or a lock is taken.
	const writer = rawWriterFor(deps);

	// 10. The answer-wide lease. A second device is REFUSED, never queued (§11.4).
	const startedAtMs = deps.now();
	const acquisition = deps.leases.acquire({
		questionId: request.questionId,
		deviceId: ctx.device.deviceId,
		surface: request.surface,
		nowMs: startedAtMs,
	});
	if (!acquisition.ok) {
		throw sealed(
			409,
			"lease_held",
			"another device is answering this question",
			{
				leaseHolderLabel: null,
				expiresInMs: acquisition.expiresInMs,
			},
		);
	}
	const lease = acquisition.lease;

	const payloadHash = hashRequest(request);
	const baseAudit = {
		kind: "answer" as const,
		deviceId: ctx.device.deviceId,
		surface: request.surface,
		requestId: request.requestId,
		leaseId: lease.leaseId,
		questionId: request.questionId,
		terminalId: question.terminalId,
		payloadHash,
	};

	/**
	 * The identity every attempt record for this request carries, spread into the
	 * six outcome records below exactly as `baseAudit` is spread into the audit
	 * lines.
	 *
	 * ONLY the identity. `status`, `resolvedAtMs`, `failureCode` and
	 * `guardsPassed` stay written out at each site on purpose: the difference
	 * between `confirmed`, `failed`, `unconfirmed` and `in_flight` is the whole
	 * point of §11.5, and a default for any of them here would let a new outcome
	 * inherit another outcome's honesty by omission.
	 */
	const baseAttempt = {
		requestId: request.requestId,
		questionId: request.questionId,
		deviceId: ctx.device.deviceId,
		surface: request.surface,
		leaseId: lease.leaseId,
		startedAtMs,
	};

	// 11. Audit BEFORE execution (§14). Inside the try, so a failure to write the
	//     audit line still releases the lease — and still refuses the answer,
	//     because an unauditable write is not one we are willing to perform.
	try {
		await deps.audit.append({
			...baseAudit,
			tsMs: startedAtMs,
			guards: null,
			outcome: "attempted",
			failureCode: null,
		});

		// (ANSWER-INFLIGHT) Visible to /v1/answer/status from HERE, not from the
		// far side of the injection. The lock wait plus the sequence deadline is up
		// to ~15 s during which the client's only documented recovery from an
		// unconfirmed write used to answer `known: false` — "the desktop never saw
		// this request" — while the desktop was mid-sequence. Every exit path below
		// overwrites this record.
		//
		// AWAITED, AND DURABLE, BEFORE THE LOCK. This is the ordering that makes
		// `AttemptStore.recordsSinceMs` a guarantee: no byte can reach a terminal
		// for an attempt whose record is not already on disk, so a crash mid-write
		// leaves an `in_flight` record (rehydrated as `unconfirmed`) rather than
		// nothing — and nothing is what the client renders as "it was not sent".
		const inFlight: AnswerAttemptRecord = {
			...baseAttempt,
			status: "in_flight",
			resolvedAtMs: null,
			failureCode: null,
			guardsPassed: [],
		};
		try {
			await deps.attempts.put(inFlight);
		} catch (error) {
			// Nothing has been written to the terminal — the lock has not been taken.
			// Refuse loudly rather than injecting an answer this bridge could not
			// record, which would leave the client's only recovery read lying.
			//
			// AND TAKE THE RECORD BACK OUT. `put` writes to memory before it
			// persists (the post-lock caller depends on that), so a rejected put
			// leaves an `in_flight` record behind — and `get` is what
			// `/v1/answer/status` reads. Left standing it would answer "this answer
			// is still being typed into the terminal" forever, and a replay of the
			// same requestId would collect `409 lease_held` saying the same thing,
			// both contradicting the 503 below. Nothing else can ever advance it:
			// `recordOutcome` only runs on the far side of a lock that was never
			// taken. After `forget`, `known: false` is the honest answer, and this
			// mount's coverage window makes that mean exactly "it was not sent".
			await deps.attempts.forget(inFlight);
			deps.log({
				event: "companion.answer.attempt_store_unwritable",
				requestId: request.requestId,
				questionId: request.questionId,
				error: error instanceof Error ? error.message : String(error),
			});
			throw sealed(
				503,
				"internal",
				"this answer could not be recorded, so it was not typed; nothing was written",
			);
		}

		const result = await deps.locks.runExclusive(
			question.terminalId,
			LOCK_WAIT_TIMEOUT_MS,
			() =>
				injectSequence(deps, {
					question,
					host,
					keystrokes,
					leaseId: lease.leaseId,
					writer,
				}),
		);

		if (result.kind === "confirmed") {
			const resolvedAtMs = deps.now();
			const recorded = deps.questions.resolve(
				request.questionId,
				{ deviceLabel: ctx.device.label, surface: request.surface },
				resolvedAtMs,
			);
			if (!recorded) {
				// The record left `pending` while the sequence ran — the hook
				// superseded or settled it. The keystrokes still landed and the audit
				// entry below still carries the true provenance; what we must NOT do
				// is stamp this device onto a record it did not resolve.
				deps.log({
					event: "companion.answer.resolve_skipped",
					questionId: request.questionId,
					terminalId: question.terminalId,
					state: question.state,
				});
			}
			const record: AnswerAttemptRecord = {
				...baseAttempt,
				status: "confirmed",
				resolvedAtMs,
				failureCode: null,
				guardsPassed: result.guardsPassed,
			};
			await recordOutcome(deps, record);
			await deps.audit.append({
				...baseAudit,
				tsMs: resolvedAtMs,
				guards: result.evaluation,
				outcome: "confirmed",
				failureCode: null,
			});
			return recordToResponse(record);
		}

		if (result.kind === "guard_failed") {
			// Nothing was written: the failure happened before the first byte.
			const record: AnswerAttemptRecord = {
				...baseAttempt,
				status: "failed",
				resolvedAtMs: null,
				failureCode: "guard_failed",
				guardsPassed: result.guardsPassed,
			};
			await recordOutcome(deps, record);
			await deps.audit.append({
				...baseAudit,
				tsMs: deps.now(),
				guards: result.evaluation,
				outcome: "failed",
				failureCode: "guard_failed",
			});
			throw sealed(412, "guard_failed", `guard ${result.guard} failed`, {
				guard: result.guard,
			});
		}

		// result.kind === "unconfirmed": at least one byte landed and the sequence
		// then aborted. The prompt is in a state we cannot describe, so we say so
		// rather than guessing "failed" (which invites a re-send that could answer
		// a DIFFERENT question) or "confirmed" (which is a lie).
		//
		// The question is marked STALE here, while this request still holds the
		// lease, so no second attempt can ever be accepted for it. Leaving it
		// `pending` is what made a partial multi-select write catastrophic: the
		// toggles that landed are invisible to the screen matcher (a checked row and
		// an unchecked row squash identically), so the user would see the same
		// question still listed, tap the same options again with a fresh requestId,
		// and the replayed toggles would DESELECT them and submit an empty
		// selection — reported back as `confirmed`. §11.4's idempotency is keyed on
		// requestId and cannot stop that; only retiring the question can. Recovery
		// after an unconfirmed write is desk-only, by design.
		deps.questions.markStale(
			request.questionId,
			`partial write: ${result.written}/${keystrokes.length} keystrokes landed, then ${result.reason}`,
		);
		deps.log({
			event: "companion.answer.unconfirmed",
			questionId: request.questionId,
			terminalId: question.terminalId,
			leaseId: lease.leaseId,
			keystrokesWritten: result.written,
			keystrokesTotal: keystrokes.length,
			abortedAt: result.abortedAt,
			reason: result.reason,
		});
		const record: AnswerAttemptRecord = {
			...baseAttempt,
			status: "unconfirmed",
			resolvedAtMs: null,
			failureCode: null,
			guardsPassed: result.guardsPassed,
		};
		await recordOutcome(deps, record);
		await deps.audit.append({
			...baseAudit,
			tsMs: deps.now(),
			guards: result.evaluation,
			outcome: "unconfirmed",
			failureCode: null,
		});
		return recordToResponse(record);
	} catch (error) {
		if (error instanceof SealedError) throw error;

		// The lock was never taken, so the critical section never ran and nothing
		// was written. Reported honestly; the client MUST NOT retry a write.
		if (error instanceof TerminalLockTimeoutError) {
			await deps.audit.append({
				...baseAudit,
				tsMs: deps.now(),
				guards: null,
				outcome: "failed",
				failureCode: "internal",
			});
			await recordOutcome(deps, {
				...baseAttempt,
				status: "failed",
				resolvedAtMs: null,
				failureCode: "internal",
				guardsPassed: [],
			});
			throw sealed(
				503,
				"internal",
				"the terminal was busy; nothing was written",
			);
		}
		// (ANSWER-INFLIGHT) An unexpected throw from inside the critical section.
		// The `in_flight` record MUST NOT be left behind — the client would poll it
		// forever — and it must not be downgraded to "never sent" either, because
		// bytes may already have landed. Unknown outcome, stated as such.
		deps.log({
			event: "companion.answer.internal_error",
			questionId: request.questionId,
			terminalId: question.terminalId,
			leaseId: lease.leaseId,
			error: error instanceof Error ? error.message : String(error),
		});
		await recordOutcome(deps, {
			...baseAttempt,
			status: "unconfirmed",
			resolvedAtMs: null,
			failureCode: null,
			guardsPassed: [],
		});
		await deps.audit.append({
			...baseAudit,
			tsMs: deps.now(),
			guards: null,
			outcome: "unconfirmed",
			failureCode: null,
		});
		throw error;
	} finally {
		// Released on confirmed, on guard_failed, on unconfirmed and on any
		// unexpected throw. A lease that outlives its answer would lock the
		// question out until its TTL lapsed.
		deps.leases.release(lease.leaseId);
	}
}

// ---------------------------------------------------------------------------
// the critical section
// ---------------------------------------------------------------------------

type InjectionResult =
	| {
			kind: "confirmed";
			guardsPassed: AnswerGuardName[];
			evaluation: GuardEvaluation;
	  }
	| {
			kind: "guard_failed";
			guard: AnswerGuardName;
			guardsPassed: AnswerGuardName[];
			evaluation: GuardEvaluation;
	  }
	| {
			kind: "unconfirmed";
			reason: string;
			abortedAt: number;
			written: number;
			guardsPassed: AnswerGuardName[];
			evaluation: GuardEvaluation;
	  };

/**
 * Runs entirely inside the per-terminal lock.
 *
 * Before EVERY keystroke: the lease is re-verified and renewed, the emulator
 * mirror is proven to have caught up with the previous byte, a fresh snapshot is
 * taken, and the full guard stack is evaluated against THAT snapshot. Only then
 * is the byte written.
 *
 * There is no compensating action on a mid-sequence abort. Sending Escape to
 * "clean up" would be another blind byte against a screen we just admitted we
 * cannot characterise. We stop, and we say the outcome is unknown.
 */
async function injectSequence(
	deps: AnswerDeps,
	input: {
		question: PendingQuestion;
		host: HostTerminalRef;
		keystrokes: readonly Keystroke[];
		leaseId: string;
		writer: RawPtyWriter;
	},
): Promise<InjectionResult> {
	const { question, host, keystrokes, leaseId, writer } = input;
	const deadlineMs = deps.now() + SEQUENCE_DEADLINE_MS;

	let written = 0;
	let previousScreen: string | null = null;
	let guardsPassed: AnswerGuardName[] = [];
	let evaluation: GuardEvaluation = {
		transcript: false,
		screen: false,
		binding: false,
		permission_axis: false,
		session: false,
		askq_marker: false,
	};

	/**
	 * The one fork every abandonment takes: nothing landed => the guard-style
	 * refusal the client knows how to show; something landed => `unconfirmed`,
	 * which is never downgraded to a failure.
	 *
	 * `guard` is a PARAMETER rather than a constant. Most call sites here are not
	 * guard failures at all — a lapsed lease, the sequence deadline, a mirror that
	 * never repainted — and they report `session` because that is what they share
	 * with a client: this terminal is not in a state we can safely write to. That
	 * used to be hardcoded, so a reader of the `guard_failed` result could not
	 * tell a genuine guard 3 failure from a deadline. Now each site says which
	 * name it is reporting under, and the mid-sequence guard failure passes the
	 * guard that actually failed instead of rebuilding this same fork inline.
	 */
	const abort = (
		reason: string,
		index: number,
		guard: AnswerGuardName,
	): InjectionResult =>
		written === 0
			? {
					kind: "guard_failed",
					guard,
					guardsPassed,
					evaluation,
				}
			: {
					kind: "unconfirmed",
					reason,
					abortedAt: index,
					written,
					guardsPassed,
					evaluation,
				};

	for (let index = 0; index < keystrokes.length; index += 1) {
		const keystroke = keystrokes[index];
		if (keystroke === undefined) {
			return abort("missing keystroke", index, "session");
		}

		if (deps.now() >= deadlineMs) {
			return abort("sequence deadline exceeded", index, "session");
		}

		// The lease can lapse mid-sequence. Renewing must be able to FAIL, or we
		// would keep typing into a question another device has taken over.
		const extension = deps.leases.extend(leaseId, deps.now());
		if (!extension.ok) {
			deps.log({
				event: "companion.answer.lease_lost",
				questionId: question.questionId,
				leaseId,
				reason: extension.reason,
				keystrokeIndex: index,
			});
			return abort(`lease ${extension.reason}`, index, "session");
		}

		// Prove the mirror reflects our previous byte before trusting it. Without
		// this, guard 5 could pass against a repaint that has not happened yet.
		if (previousScreen !== null) {
			const advanced = await awaitScreenAdvance(
				deps,
				question.terminalId,
				previousScreen,
				Math.min(deadlineMs, deps.now() + SCREEN_ADVANCE_TIMEOUT_MS),
			);
			if (advanced === null) {
				return abort(
					"screen did not advance after the previous keystroke",
					index,
					"session",
				);
			}
			// (ADVANCE-SCREEN-DISCARDED) `advanced` IS DELIBERATELY NOT REUSED as
			// the guard's screen, and the redundant snapshot below is the point.
			//
			// `awaitScreenAdvance` returns the FIRST snapshot that differs from the
			// previous one, which proves the TUI consumed our byte — it does not
			// prove the repaint finished, and a half-drawn frame is exactly the
			// input guard 5's matcher must not be handed. Reusing it would also
			// widen the gap between "what we observed" and "what we then wrote
			// into" by up to one poll interval, on the one guard §11.3 lists as
			// load-bearing. One extra viewport snapshot per keystroke is the price
			// of evaluating guard 5 against the freshest screen there is.
		}

		const screen = await safeSnapshot(deps, question.terminalId);
		if (screen === null) {
			// Guard 5 is load-bearing; an unreadable screen is not a reason to
			// proceed, it is the reason not to.
			return abort("screen snapshot unavailable", index, "session");
		}
		const outcome = await evaluateGuards(deps, {
			question,
			screen,
			expectation: keystroke.expect,
			requireOptionIndex: keystroke.optionIndex,
		});
		guardsPassed = outcome.passed;
		evaluation = outcome.evaluation;

		if (outcome.failed !== null) {
			deps.log({
				event: "companion.answer.guard_failed",
				questionId: question.questionId,
				terminalId: question.terminalId,
				guard: outcome.failed,
				guardClass: GUARD_CLASSES[outcome.failed],
				keystrokeIndex: index,
				written,
				screenReason: outcome.screenMatch?.reason ?? null,
				screenMissing: outcome.screenMatch?.missing ?? null,
			});
			return abort(
				`guard ${outcome.failed} failed mid-sequence`,
				index,
				outcome.failed,
			);
		}

		// The write. Synchronous and unframed — the only thing a picker consumes.
		//
		// The pty writer is keyed on host.db ids, NOT on the opaque wire handle:
		// `writeInputToSession` looks `terminalId` up in the live session map, and
		// the handle is a truncated SHA-256 that is never a key there.
		let result: { success: true } | { error: string };
		try {
			result = writer.write({
				terminalId: host.hostTerminalId,
				workspaceId: host.hostWorkspaceId,
				data: keystroke.data,
			});
		} catch (error) {
			// The pty write itself threw. Whether the bytes reached the daemon is
			// genuinely unknown, so this is unconfirmed even for the first
			// keystroke — we do not get to claim nothing happened.
			deps.log({
				event: "companion.answer.write_threw",
				questionId: question.questionId,
				terminalId: question.terminalId,
				keystrokeIndex: index,
				error: error instanceof Error ? error.message : String(error),
			});
			return {
				kind: "unconfirmed",
				reason: "pty write threw",
				abortedAt: index,
				written,
				guardsPassed,
				evaluation,
			};
		}

		if ("error" in result) {
			// `writeInputToSession` validates and returns BEFORE touching the pty,
			// so this branch provably wrote nothing on THIS keystroke.
			deps.log({
				event: "companion.answer.write_refused",
				questionId: question.questionId,
				terminalId: question.terminalId,
				keystrokeIndex: index,
				written,
				error: result.error,
			});
			return abort(`pty write refused: ${result.error}`, index, "session");
		}

		written += 1;
		previousScreen = screen;
	}

	return { kind: "confirmed", guardsPassed, evaluation };
}

/**
 * A snapshot that never throws into the critical section. A source that fails is
 * `null`, which every caller treats as "do not write" — never as "carry on".
 */
async function safeSnapshot(
	deps: AnswerDeps,
	terminalId: TerminalId,
): Promise<string | null> {
	try {
		return await deps.snapshotScreen(terminalId);
	} catch (error) {
		deps.log({
			event: "companion.answer.snapshot_error",
			terminalId,
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

/**
 * Polls the emulator until the screen differs from `previous`, proving the TUI
 * consumed our last byte and the mirror caught up. Returns the new screen, or
 * `null` on timeout or on an unreadable emulator — never the stale screen.
 */
async function awaitScreenAdvance(
	deps: AnswerDeps,
	terminalId: TerminalId,
	previous: string,
	deadlineMs: EpochMs,
): Promise<string | null> {
	for (;;) {
		const screen = await safeSnapshot(deps, terminalId);
		if (screen === null) return null;
		if (screen !== previous) return screen;
		if (deps.now() >= deadlineMs) return null;
		await sleep(SCREEN_ADVANCE_POLL_MS);
	}
}

// ---------------------------------------------------------------------------
// POST /v1/answer/status
// ---------------------------------------------------------------------------

/**
 * §11.5 — a READ, and the ONLY correct response to a write whose outcome is
 * unknown. Safe to retry, safe to poll.
 *
 * `known: false` after a full round trip means the write never reached the
 * bridge — but ONLY inside the coverage range published alongside it, which is
 * what the rest of this comment is about. Outside that range it means no more
 * than "no record", and the client must render it as `unconfirmed`. Even the
 * in-range claim is only honest because `handleAnswer` records an `in_flight`
 * attempt as soon as it takes the lease (ANSWER-INFLIGHT) — before that, this
 * endpoint reported "not sent" for ~15 s while the answer was actively being
 * typed.
 *
 * ---------------------------------------------------------------------------
 * "NOT SENT" IS A CLAIM ABOUT A TIME RANGE, SO THE RANGE IS ON THE WIRE
 * ---------------------------------------------------------------------------
 * A record can be missing for two completely different reasons — the request
 * never arrived, or the bridge no longer has records reaching that far back —
 * and `known: false` alone cannot tell them apart. It used to be reported as if
 * it always meant the first, which after a desktop restart turned every earlier
 * MISS into a terminal "the desktop never saw this request — it was not sent".
 *
 * (COVERAGE-CONTRACT) The three proof fields this endpoint publishes —
 * `recordsSinceMs`, `serverTimeMs`, `bridgeStartedMs` — are specified ONCE, on
 * `AnswerStatusResponse` in `types.ts`, and for the wire in `PROTOCOL.md` §11.5.
 * Read them there rather than trusting a paraphrase here: this explanation used to
 * be restated in four places and five copies of one sentence went stale in a
 * single commit.
 *
 * The only two facts local to THIS function, which is all it needs to state:
 *   - a record that EXISTS is returned with its own status, unconditionally. The
 *     coverage range plays no part in that branch, and the witness never did.
 *   - the range is asked for at the top and attached to BOTH branches, so a client
 *     never has to correlate a verdict with a separately-fetched window.
 */
export async function handleAnswerStatus(
	deps: AnswerDeps,
	_ctx: SealedRequestContext,
	request: AnswerStatusRequest,
): Promise<AnswerStatusResponse> {
	const nowMs = deps.now();
	const proof = {
		serverTimeMs: nowMs,
		recordsSinceMs: deps.attempts.recordsSinceMs(nowMs),
		bridgeStartedMs: deps.bridgeStartedMs,
	};
	const record = deps.attempts.get(request.requestId);
	if (record === null) {
		return {
			requestId: request.requestId,
			known: false,
			status: "unknown",
			questionId: null,
			resolvedAtMs: null,
			failureCode: null,
			...proof,
		};
	}
	return {
		requestId: record.requestId,
		known: true,
		status: record.status,
		questionId: record.questionId,
		resolvedAtMs: record.resolvedAtMs,
		failureCode: record.failureCode,
		...proof,
	};
}

// ---------------------------------------------------------------------------
// POST /v1/message
// ---------------------------------------------------------------------------

/**
 * §7.5 — free text to an existing agent.
 *
 * Refused outright while a picker is open (`picker_open`, 409): with a question
 * on screen, a message whose first character is a digit COMMITS AN ANSWER
 * ATOMICALLY.
 *
 * This path uses the PASTE-FRAMING writer, not the raw one. That is deliberate
 * and is the opposite choice from the answer path: framing is what carries
 * embedded newlines to a TUI composer as literal newlines.
 *
 * ---------------------------------------------------------------------------
 * FRAMING IS NOT A PICKER GUARD. Do not restore the claim that it is.
 * ---------------------------------------------------------------------------
 * `writeFramedInputToSession` emits `\x1b[200~<text>\x1b[201~` and then appends
 * `\r` OUTSIDE the frame. The BODY is inert against a picker; the trailing `\r`
 * is a real key — on a multi-select it toggles the highlighted row, on the
 * N-question review screen it submits, and it does so silently. (Worse: if
 * bracketed paste is not active on that session the body is written raw too, so
 * a message beginning with a digit commits an option outright.) An earlier
 * revision of this comment asserted that "a picker we failed to detect swallows
 * the text harmlessly", and that assertion was the stated justification for
 * carrying only a best-effort picker check here. It was false.
 *
 * So the picker check has to be real, and it cannot rest on the question store
 * alone. That store is fed exclusively by the unauthenticated `notifications.hook`
 * and is lossy in three ways that all fail OPEN:
 *   (a) it is in-memory — a host-service restart while a picker is open loses
 *       that question permanently, because PreToolUse already fired and never
 *       fires again;
 *   (b) `validateCapture` drops any malformed capture entirely;
 *   (c) it is structurally blind to Codex: `capture()` is only reachable from
 *       the Claude hook, so a Codex picker is never recorded at all.
 * The same endpoint can also CLEAR an entry on demand, so a forgeable source can
 * move the guard in the permitting direction rather than merely failing to
 * populate it.
 *
 * ---------------------------------------------------------------------------
 * (MESSAGE-ECHO) THE SUBMIT IS A SECOND, SEPARATELY EARNED ACT
 * ---------------------------------------------------------------------------
 * The dangerous byte on this path is the trailing `\r`, and it used to leave the
 * bridge in the SAME call as the body — so the only thing standing between a
 * picker and a committed answer was a check made before either byte was written.
 * Absence of a question-store record was doing a lot of that work, and absence of
 * a record proves nothing (see (a)-(c) above): the endpoint was inferring "the
 * composer is focused" from "we have no record saying otherwise".
 *
 * The send is therefore split, inside ONE lock hold:
 *   1. the full picker refusal (`assertNoPickerOnScreen`), which is unchanged and
 *      still fails closed on any unreadable source;
 *   2. the body, framed, with `submit: false` — no bare `\r` leaves the bridge;
 *   3. POSITIVE evidence: the screen must demonstrably change AND then render our
 *      own text. A picker does not echo a bracketed paste into itself, so this is
 *      the composer identifying itself by behaviour rather than by our failure to
 *      find a record. It is unforgeable — the needle is text WE were handed, not
 *      anything the hook supplied;
 *   4. a last store/permission-axis re-check, then the submit.
 * If step 3 or 4 refuses, the text is in the composer and unsent: the outcome is
 * `unconfirmed` (§7.5), never `sent` and never `failed`, and it is resolved at the
 * desk. That is the honest report — bytes landed.
 *
 * The picker-CHROME detector is deliberately NOT re-run at step 4: by then our
 * own text is on screen, and a message reading "1. do X / 2. do Y" renders as a
 * numbered list. Re-running it there would refuse ordinary messages AFTER
 * pasting them, which strands the user rather than protecting them.
 */
export async function handleMessage(
	deps: AnswerDeps,
	ctx: SealedRequestContext,
	request: MessageRequest,
): Promise<MessageResponse> {
	if (!ctx.device.writeEnabled) {
		throw sealed(
			403,
			"write_disabled",
			"write access is disabled for this device",
		);
	}
	if (!request.confirmedBiometric) {
		throw sealed(
			400,
			"bad_request",
			"free text requires confirmedBiometric === true",
		);
	}
	assertMessageText(request.text);

	const replay = deps.messageAttempts.get(request.requestId);
	if (replay !== null) {
		// §11.4's rule applies to every write: the same requestId returns the
		// RECORDED outcome and never re-executes.
		if (replay.status === "failed") {
			throw sealed(
				412,
				"guard_failed",
				"this message already failed; it is not retried",
				{ guard: "session" },
			);
		}
		return {
			status: replay.status === "sent" ? "sent" : "unconfirmed",
			requestId: request.requestId,
			sentAtMs: replay.sentAtMs,
		};
	}

	await assertWritableBinding(deps, request.terminalId, (kind) =>
		// The picker store can only ever know about Claude, so for any other agent
		// this path has NO way to tell whether a picker is on screen — and the
		// trailing `\r` would commit whatever is there. Refuse rather than write
		// blind.
		sealed(
			501,
			"capability_unsupported",
			`messages are only supported on Claude terminals in v1 (this one is ${kind})`,
			{ capability: kind === "codex" ? "agent.codex" : "agent.claude" },
		),
	);
	const active = await deps.sessionActive(request.terminalId);
	if (active !== true) {
		throw sealed(412, "guard_failed", "terminal session is not active", {
			guard: "session",
		});
	}

	const host = await requireHostTerminal(deps, request.terminalId);

	const startedAtMs = deps.now();

	// (MESSAGE-LEASE) One send per terminal at a time, and a second device is
	// REFUSED rather than queued behind it. The terminal lock alone only orders
	// them, which would let device B start typing into a composer that already
	// holds device A's half-sent message.
	const acquisition = deps.leases.acquireMessage({
		terminalId: request.terminalId,
		deviceId: ctx.device.deviceId,
		surface: ctx.device.surface,
		nowMs: startedAtMs,
	});
	if (!acquisition.ok) {
		throw sealed(
			409,
			"lease_held",
			"another device is sending a message to this terminal",
			{ leaseHolderLabel: null, expiresInMs: acquisition.expiresInMs },
		);
	}
	const messageLeaseId = acquisition.lease.leaseId;

	const payloadHash = hashRequest(request);
	const auditMessage = (
		outcome: "attempted" | "confirmed" | "failed" | "unconfirmed",
		failureCode: SealedCode | null,
	) =>
		deps.audit.append({
			tsMs: deps.now(),
			kind: "message",
			deviceId: ctx.device.deviceId,
			surface: ctx.device.surface,
			requestId: request.requestId,
			leaseId: messageLeaseId,
			questionId: null,
			terminalId: request.terminalId,
			guards: null,
			payloadHash,
			outcome,
			failureCode,
		});

	/**
	 * The identity every message-attempt record for this request carries, spread
	 * into the six outcome records below exactly as `auditMessage` closes over the
	 * same fields for the audit lines.
	 *
	 * `status` and `sentAtMs` stay written out at each site: §7.5's `sent` /
	 * `unconfirmed` / `failed` distinction is the honest report of what reached
	 * the terminal, and a default for either would let a new exit path inherit
	 * another one's claim.
	 */
	const baseAttempt = {
		requestId: request.requestId,
		terminalId: request.terminalId,
		startedAtMs,
	};

	try {
		// Audit BEFORE execution (§14).
		await auditMessage("attempted", null);

		let outcome: MessageWriteOutcome;
		try {
			outcome = await deps.locks.runExclusive(
				request.terminalId,
				LOCK_WAIT_TIMEOUT_MS,
				() => writeMessageInLock(deps, { request, host }),
			);
		} catch (error) {
			if (error instanceof SealedError) {
				// Only the pre-write refusals throw: `writeMessageInLock` returns a
				// result for everything that happens once a byte has landed.
				deps.messageAttempts.put({
					...baseAttempt,
					status: "failed",
					sentAtMs: null,
				});
				await auditMessage("failed", error.body.code as SealedCode);
				throw error;
			}
			if (error instanceof TerminalLockTimeoutError) {
				// The critical section never ran, so nothing was written.
				deps.messageAttempts.put({
					...baseAttempt,
					status: "failed",
					sentAtMs: null,
				});
				await auditMessage("failed", "internal");
				throw sealed(
					503,
					"internal",
					"the terminal was busy; nothing was written",
				);
			}
			// The write threw somewhere unknown. Ambiguous, so: unconfirmed, and NO
			// re-send. The client reads the outcome instead (§11.5).
			deps.log({
				event: "companion.message.unconfirmed",
				terminalId: request.terminalId,
				requestId: request.requestId,
				leaseId: messageLeaseId,
				error: error instanceof Error ? error.message : String(error),
			});
			deps.messageAttempts.put({
				...baseAttempt,
				status: "unconfirmed",
				sentAtMs: null,
			});
			await auditMessage("unconfirmed", null);
			return {
				status: "unconfirmed",
				requestId: request.requestId,
				sentAtMs: null,
			};
		}

		if (outcome.kind === "refused") {
			// Provably nothing was written: `writeFramedInputToSession` validates the
			// session and returns before it touches the pty.
			deps.messageAttempts.put({
				...baseAttempt,
				status: "failed",
				sentAtMs: null,
			});
			await auditMessage("failed", "guard_failed");
			throw sealed(412, "guard_failed", outcome.error, { guard: "session" });
		}

		if (outcome.kind === "unconfirmed") {
			// The body landed and the submit was withheld or failed. The message is
			// sitting in the composer, unsent. Say exactly that; do not re-send, and
			// do not call it failed.
			deps.log({
				event: "companion.message.submit_withheld",
				terminalId: request.terminalId,
				requestId: request.requestId,
				leaseId: messageLeaseId,
				reason: outcome.reason,
			});
			deps.messageAttempts.put({
				...baseAttempt,
				status: "unconfirmed",
				sentAtMs: null,
			});
			await auditMessage("unconfirmed", null);
			return {
				status: "unconfirmed",
				requestId: request.requestId,
				sentAtMs: null,
			};
		}

		const sentAtMs = deps.now();
		deps.messageAttempts.put({
			...baseAttempt,
			status: "sent",
			sentAtMs,
		});
		await auditMessage("confirmed", null);
		return { status: "sent", requestId: request.requestId, sentAtMs };
	} finally {
		deps.leases.releaseMessage(messageLeaseId);
	}
}

/**
 * (MESSAGE-ECHO) What one `/v1/message` send can end as, once the lock is held.
 *
 * `refused` is reserved for the case where the pty writer rejected the body
 * before touching the terminal — the ONLY post-lock outcome that provably wrote
 * nothing. Everything after the first byte is `sent` or `unconfirmed`; there is
 * no path that calls a landed write "failed".
 */
type MessageWriteOutcome =
	| { kind: "sent" }
	| { kind: "unconfirmed"; reason: string }
	| { kind: "refused"; error: string };

/**
 * The whole send, inside the per-terminal lock. Checking outside the lock and
 * writing inside it would be two acts, and a question can open in between.
 */
async function writeMessageInLock(
	deps: AnswerDeps,
	input: { request: MessageRequest; host: HostTerminalRef },
): Promise<MessageWriteOutcome> {
	const { request, host } = input;

	// 1. The full picker refusal. Throws `409 picker_open` on anything it cannot
	//    rule out, including an unreadable source. Nothing has been written yet.
	const beforeScreen = await assertNoPickerOnScreen(deps, request.terminalId);

	// 2. The body ONLY. `submit: false` keeps the `\r` out of this write entirely,
	//    so a picker that survived step 1 sees an inert bracketed paste.
	const body = await deps.writeFramed({
		terminalId: host.hostTerminalId,
		workspaceId: host.hostWorkspaceId,
		text: request.text,
		submit: false,
	});
	if ("error" in body) return { kind: "refused", error: body.error };

	// 3. Positive proof that a text field — not a picker — consumed it.
	const echo = await awaitComposerEcho(deps, {
		terminalId: request.terminalId,
		text: request.text,
		beforeScreen,
	});
	if (!echo.ok) return { kind: "unconfirmed", reason: echo.reason };

	// 4. Last look for a question that opened between the body and the submit.
	//    Store + permission axis only — see the docblock on `handleMessage` for
	//    why the chrome detector cannot be re-run against our own echoed text.
	const opened = await questionOpenedDuringSend(deps, request.terminalId);
	if (opened !== null) return { kind: "unconfirmed", reason: opened };

	// 5. The submit. An empty framed body plus the `\r`; the frame is inert and
	//    the `\r` lands on the composer we just watched render our text.
	const submit = await deps.writeFramed({
		terminalId: host.hostTerminalId,
		workspaceId: host.hostWorkspaceId,
		text: "",
		submit: true,
	});
	if ("error" in submit) {
		return {
			kind: "unconfirmed",
			reason: `submit refused after the body landed: ${submit.error}`,
		};
	}
	return { kind: "sent" };
}

/**
 * (MESSAGE-ECHO) Waits for the terminal to render the text we just pasted.
 *
 * Two conditions, both required:
 *  - the screen CHANGED, which proves something consumed the write rather than
 *    the mirror being stale (`awaitScreenAdvance`);
 *  - our own text is on screen. Head OR tail anchor: a long paste scrolls the
 *    composer, so the beginning can legitimately be off-screen while the end is
 *    visible, and either one is equally good evidence.
 *
 * A bracketed paste is inert against the AskUserQuestion picker — it does not
 * echo it — so satisfying both is the composer identifying itself by behaviour.
 *
 * THE NEEDLE IS CLIENT-CHOSEN, so on its own it is exactly as parameterisable as
 * guard 5's capture-derived anchors were, and it needed the same two remedies:
 *  - a FLOOR on its length (`MESSAGE_ECHO_MIN_ANCHOR_CHARS`); a three-character
 *    message matches a picker's own option label or row number;
 *  - a BEFORE/AFTER differential; a needle already visible in `beforeScreen` is
 *    discarded, so what is proved is that the text appeared BECAUSE of the
 *    paste, not that it happens to be on screen.
 * With both, the evidence is behavioural rather than textual and the client
 * cannot supply text that satisfies it against a picker.
 *
 * The search window is as tall as the message plus wrap slack, because a
 * multi-line message legitimately renders across several screen lines and the
 * picker default of two would refuse it. It is still a BAND — the anchor may not
 * be assembled from text at opposite ends of the viewport — and it is capped, so
 * a pathological message cannot widen it into "anywhere on screen".
 *
 * Every failure here withholds the submit, which leaves the text sitting in the
 * composer and reports `unconfirmed`. That is the safe direction but it is not a
 * free refusal, so the anchors are deliberately forgiving about layout.
 */
async function awaitComposerEcho(
	deps: AnswerDeps,
	input: { terminalId: TerminalId; text: string; beforeScreen: string },
): Promise<{ ok: true } | { ok: false; reason: string }> {
	const squashed = squash(input.text);
	if (squashed.length === 0) {
		// `assertMessageText` rejects whitespace-only text, so this is unreachable
		// through the wire. It is still a refusal rather than a pass: with nothing
		// to search for there is no evidence, and no evidence never permits a write.
		return { ok: false, reason: "message has no searchable text to verify" };
	}
	if (squashed.length < MESSAGE_ECHO_MIN_ANCHOR_CHARS) {
		return {
			ok: false,
			reason: `the message is ${squashed.length} searchable characters, below the ${MESSAGE_ECHO_MIN_ANCHOR_CHARS} needed for an on-screen echo to be evidence — a short string can match a picker's own option label or row number`,
		};
	}
	const windowLines = Math.min(
		input.text.split("\n").length + SCREEN_LINE_WINDOW,
		MESSAGE_ECHO_MAX_WINDOW_LINES,
	);

	// The needle must prove the text appeared BECAUSE of our paste. A needle that
	// was ALREADY on screen before the write proves only that it was on screen,
	// which is exactly the long-message variant of the short-message hole above:
	// a client that quotes text it knows is rendered gets a free pass. Anything
	// visible beforehand is therefore discarded, and if that leaves nothing the
	// submit is withheld.
	const beforeWindows = squashedWindows(input.beforeScreen, windowLines);
	const candidates = [
		squashed.slice(0, MESSAGE_ECHO_ANCHOR_CHARS),
		squashed.slice(-MESSAGE_ECHO_ANCHOR_CHARS),
	];
	const needles = candidates.filter(
		(needle) => !anyWindowIncludes(beforeWindows, needle),
	);
	if (needles.length === 0) {
		return {
			ok: false,
			reason:
				"the message text was already on screen before it was pasted, so its presence afterwards proves nothing about which widget consumed it",
		};
	}

	const deadlineMs = deps.now() + MESSAGE_ECHO_TIMEOUT_MS;
	for (;;) {
		const screen = await awaitScreenAdvance(
			deps,
			input.terminalId,
			input.beforeScreen,
			deadlineMs,
		);
		if (screen === null) {
			return {
				ok: false,
				reason:
					"the terminal never repainted after the text was pasted, so nothing proves a composer consumed it",
			};
		}
		const windows = squashedWindows(screen, windowLines);
		if (needles.some((needle) => anyWindowIncludes(windows, needle))) {
			return { ok: true };
		}
		if (deps.now() >= deadlineMs) {
			return {
				ok: false,
				reason:
					"the pasted text was never rendered on screen, so an open picker cannot be ruled out",
			};
		}
		await sleep(SCREEN_ADVANCE_POLL_MS);
	}
}

/**
 * The permission axis, read WITHOUT `readGuardSource`'s null collapse.
 *
 * `readGuardSource` turns "could not read" into `false`. On the guard stack that
 * is correct — a guard that cannot be evaluated must not permit. On the message
 * path it is exactly backwards: `false` there means "no picker", so collapsing a
 * failed read into it would turn an unreadable source into a PERMISSION to write
 * the trailing `\r`. So `null` survives, and each of the two callers states for
 * itself what it does with it — one refuses the send outright, the other
 * withholds the submit and reports `unconfirmed`.
 */
async function readPermissionAxis(
	deps: AnswerDeps,
	terminalId: TerminalId,
): Promise<GuardSourceResult> {
	try {
		return await deps.permissionAxisLatched(terminalId);
	} catch (error) {
		deps.log({
			event: "companion.message.permission_axis_error",
			terminalId,
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

/**
 * (MESSAGE-ECHO) The between-body-and-submit re-check: did a question appear
 * while we were pasting?
 *
 * Returns the reason to withhold the submit, or `null` when there is none. Both
 * sources are hook-fed and therefore forgeable — but here they can only REFUSE,
 * which is the sound direction. An unreadable permission axis refuses too: this
 * runs immediately before the one byte on this path that commits irreversibly.
 */
async function questionOpenedDuringSend(
	deps: AnswerDeps,
	terminalId: TerminalId,
): Promise<string | null> {
	const known = deps.questions.byTerminal(terminalId);
	if (known !== null && known.state === "pending") {
		return "a question opened on this terminal while the text was being pasted";
	}
	const permissionLatched = await readPermissionAxis(deps, terminalId);
	if (permissionLatched === null) {
		return "the agent's permission state could not be re-read before the submit";
	}
	if (permissionLatched) {
		return "the agent became blocked waiting for input while the text was being pasted";
	}
	return null;
}

/**
 * §7.5 boundary validation of the message body. Every failure is
 * `400 bad_request` and nothing is written, coerced or normalised.
 *
 * The scan is the answer path's implementation (`findForbiddenControlChar`,
 * `findUnpairedSurrogate`) run under this path's OWN policy set,
 * `MESSAGE_ALLOWED_C0`, so the two writers share one notion of "control byte"
 * while keeping two policies that each match what that writer was proven
 * against:
 *  - LF and TAB are permitted here and only here. `writeFramedInputToSession`
 *    frames the body as a bracketed paste, which carries both to the composer as
 *    literal characters rather than as Enter and focus movement. The picker path
 *    writes raw and so permits neither (`FREETEXT_ALLOWED_C0` is empty);
 *  - CR is refused — `writeFramedInputToSession` appends its own submit, and a CR
 *    inside the body would submit the message half-typed;
 *  - ESC and the rest of C0 are terminal control, not text;
 *  - a lone surrogate is refused rather than encoded as U+FFFD, which would type
 *    something other than what the user wrote.
 * Whitespace-only text is refused too: there would be nothing to send and, more
 * to the point, nothing for the (MESSAGE-ECHO) check to verify on screen.
 */
function assertMessageText(text: string): void {
	if (text.length === 0 || text.length > MESSAGE_MAX_CHARS) {
		throw sealed(
			400,
			"bad_request",
			`text must be 1..${MESSAGE_MAX_CHARS} chars`,
		);
	}
	if (squash(text).length === 0) {
		throw sealed(400, "bad_request", "text is whitespace only");
	}
	const control = findForbiddenControlChar(text, MESSAGE_ALLOWED_C0);
	if (control !== null) {
		throw sealed(
			400,
			"bad_request",
			`text carries control byte 0x${control.code.toString(16)} at ${control.index}; only LF and TAB are permitted, and it is refused rather than stripped`,
		);
	}
	const surrogate = findUnpairedSurrogate(text);
	if (surrogate !== null) {
		throw sealed(
			400,
			"bad_request",
			`text carries an unpaired surrogate 0x${surrogate.unit.toString(16)} at ${surrogate.index}; it would reach the terminal as U+FFFD`,
		);
	}
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * The `/v1/message` picker guard, run inside the terminal lock.
 *
 * Throws `409 picker_open` if ANYTHING suggests a question is on screen. It
 * never returns "probably fine": an unreadable source is a refusal here, because
 * the byte this gates on (`\r`) commits irreversibly against a picker.
 *
 * Three independent sources, none of them individually load-bearing:
 *
 *  1. The question store, for the terminal — the common case, and the only one
 *     that can name the question.
 *  2. The permission axis. `TerminalAgentStore` is hydrated from host.db's
 *     `terminal_agent_bindings`, so `lastEventType === "PermissionRequest"`
 *     survives the host-service restart that empties (1). A latched permission
 *     axis means the agent is blocked waiting for the user, which is exactly the
 *     state in which a stray `\r` is unrecoverable. Forgeable — but only in the
 *     REFUSING direction here, which is sound.
 *  3. The LIVE SCREEN. Unforgeable, and the only source that can catch a picker
 *     whose record was already retired or never captured.
 *
 * ---------------------------------------------------------------------------
 * (PICKER-CHROME) SOURCE 3 RUNS UNCONDITIONALLY. DO NOT PUT IT BEHIND A RECORD.
 * ---------------------------------------------------------------------------
 * It used to sit after `if (known === null) return;`. `byTerminal` can only
 * return a record that is still in `pendingByHostTerminal`, and every exit from
 * `pending` (resolve, stale, supersede) removes it from that index — so `known`
 * was either `pending` (and source 1 had already thrown) or `null` (and this
 * returned before looking). The screen was NEVER read. Exactly the three loss
 * modes it exists for — a host-service restart with a picker up, a capture
 * dropped by `validateCapture`, a record retired a moment ago — are the ones
 * that produce `known === null`, so the documented defence-in-depth was a
 * no-op and the only surviving layer was a last-writer-wins scalar that a
 * background subagent's `PostToolUse` routinely stomps off `PermissionRequest`.
 *
 * Because the record can be absent, the screen check cannot rest on matching a
 * known prompt: `screenShowsPickerChrome` is record-independent, and the
 * per-question match is an ADDITIONAL check when a record does exist.
 *
 * ---------------------------------------------------------------------------
 * A MISSING RECORD IS NOT EVIDENCE OF ANYTHING
 * ---------------------------------------------------------------------------
 * Everything here is NEGATIVE: it rules pickers out. `known === null` means the
 * store has nothing to say, not that the composer is focused, and this function
 * deliberately does not pretend otherwise. The POSITIVE half — proof that a text
 * field, and not a picker, is what consumed the write — is `awaitComposerEcho`,
 * which runs after the inert body has landed and before the `\r` that commits.
 * Do not fold either into the other: this one must pass before ANY byte is
 * written, and that one cannot run until a byte has been.
 *
 * Returns the exact screen it based its decision on, so the caller uses THAT
 * snapshot as the "before" state of the echo check rather than taking a second
 * one that may already have moved.
 */
async function assertNoPickerOnScreen(
	deps: AnswerDeps,
	terminalId: TerminalId,
): Promise<string> {
	const known = deps.questions.byTerminal(terminalId);
	if (known !== null && known.state === "pending") {
		throw sealed(
			409,
			"picker_open",
			"a question is on screen; answer it or wait before sending a message",
		);
	}

	// An UNREADABLE permission axis is a refusal here, not a pass — which is why
	// this reads through `readPermissionAxis` and not `readGuardSource`.
	const permissionLatched = await readPermissionAxis(deps, terminalId);
	if (permissionLatched !== false) {
		throw sealed(
			409,
			"picker_open",
			permissionLatched === null
				? "the agent's permission state could not be read, so an open picker cannot be ruled out"
				: "this agent is blocked waiting for input; answer it or wait before sending a message",
		);
	}

	// UNCONDITIONAL. An unreadable screen is a refusal, not a pass — the same
	// rule the docblock states and the previous control flow silently skipped.
	const screen = await safeSnapshot(deps, terminalId);
	if (screen === null) {
		throw sealed(
			409,
			"picker_open",
			"the terminal screen could not be read, so an open picker cannot be ruled out",
		);
	}
	if (screenShowsPickerChrome(screen)) {
		throw sealed(
			409,
			"picker_open",
			"this terminal is rendering a numbered chooser; answer it or wait before sending a message",
		);
	}
	if (known === null) return screen;
	// A record exists but is no longer pending. Ask the screen whether the TUI
	// agrees, because the store is the side that can be wrong. An anchor too
	// weak to search for proves nothing either way, so it refuses too.
	for (const item of known.questions) {
		const match = matchPromptStillOnScreen({ screen, item });
		// `anchor_absent` is the ONLY outcome that rules the retired question out —
		// it is the one that positively demonstrates the prompt is not rendered.
		// Everything else is inconclusive and inconclusive is a refusal here:
		// `anchor_too_weak` means there was nothing worth searching for, and
		// `empty_screen` means the snapshot was blank (a terminal mid-clear, an
		// emulator mirror that has not painted). A blank snapshot rules nothing
		// out, and letting it through left the whole containment resting on
		// `awaitComposerEcho`.
		if (!match.ok && match.reason === "anchor_absent") continue;
		throw sealed(
			409,
			"picker_open",
			"a recently retired question may still be rendered on this terminal",
		);
	}
	return screen;
}

function recordToResponse(record: AnswerAttemptRecord): AnswerResponse {
	return {
		// `failed` never reaches a client as a 200: `handleAnswer` throws a
		// SealedError on the failing path and only records the outcome. A replayed
		// `failed` record is surfaced through /v1/answer/status, which is where a
		// client is told to look.
		status: record.status === "confirmed" ? "confirmed" : "unconfirmed",
		requestId: record.requestId,
		questionId: record.questionId,
		leaseId: record.leaseId,
		resolvedAtMs: record.status === "confirmed" ? record.resolvedAtMs : null,
		guardsPassed: record.guardsPassed,
	};
}

/**
 * §14 — the audit log stores a HASH of the payload, never the payload: the log
 * must not become a transcript of everything typed into terminals.
 *
 * NOTE: this hashes a re-serialisation of the decoded request, not the exact
 * sealed plaintext bytes (a handler never sees those). It is stable for a given
 * request and is enough to correlate an audit line with a client-side record; it
 * is NOT a byte-for-byte attestation of what arrived on the wire.
 */
function hashRequest(request: AnswerRequest | MessageRequest): string {
	return hashJsonPayload(request);
}
