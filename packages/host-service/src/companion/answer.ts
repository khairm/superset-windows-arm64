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
 *     guards are added) — with ONE listed exception, `permission_axis`, which
 *     ABSTAINS once both load-bearing guards have passed because its refusal was
 *     as forgeable as its permission would have been and proved nothing they had
 *     not. See (GUARD4-ABSTAIN) on `ABSTAINING_GUARDS`;
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
 *   - guard 5 requires the row it is about to PRESS to be strongly verified and
 *     the rows to form one picker block — ascending digit order, every gap
 *     between consecutive rows explained by the render of the option above it
 *     (`rowIsStronglyVerified`, `rowsFormPickerBlock`). Without those, a capture
 *     with one-character labels reduced the check to a two-character substring
 *     search that an idle composer satisfied. The strength requirement is tiered
 *     by role rather than applied to every row, because upstream's own tool
 *     schema asks for labels of "1-5 words" — see (GUARD5-EVIDENCE-TIERS).
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

import type {
	AttemptLedger,
	LedgerRecord,
	StatusOutcome,
} from "./attempt-ledger";
import { type AuditLog, hashJsonPayload } from "./audit";
import { ANSWER_ATTEMPT_RETENTION_MS } from "./config";
import { sleep } from "./crypto";
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
	type AnswerStatusOutcome,
	type AnswerStatusRequest,
	type AnswerStatusResponse,
	type AttemptFailureCode,
	type DurationMs,
	type EpochMs,
	type GuardEvaluation,
	type MessageRequest,
	type MessageResponse,
	type QuestionId,
	type QuestionItem,
	type QuestionOption,
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

/**
 * (GUARD4-ABSTAIN) Forgeable guards that ABSTAIN rather than refuse once every
 * load-bearing guard has passed.
 *
 * "May refuse; may never permit" is the right rule for a forgeable source in
 * general, and it stays the rule for `binding` — which proves the captured
 * question belongs to the agent session currently on the terminal, something
 * neither the transcript nor the screen says anything about.
 *
 * `permission_axis` is different in two ways that together make its refusal
 * worth less than the honest answers it was costing:
 *
 *   - IT ADDS NOTHING. The axis is `lastEventType === PermissionRequest` — "a
 *     permission request is the most recent thing this terminal reported". By
 *     the time it is read, guard 1 has proved the tool call is still unanswered
 *     in the agent's own transcript and guard 5 has proved THIS question's
 *     picker is on screen right now with the pressed row where the capture says
 *     it is. Those two prove a pending permission request more directly than a
 *     single latched enum ever did.
 *   - IT IS A LATCH, AND ITS REFUSAL IS ITSELF FORGEABLE. Any later hook event
 *     overwrites `lastEventType`, so an ordinary race between capture and answer
 *     clears it and the wire code for that is indistinguishable from staleness.
 *     And the same unauthenticated localhost hook that could forge the axis to
 *     `true` can clear it to `false` — so leaving it able to refuse hands an
 *     attacker a denial primitive while giving the defence nothing, which is the
 *     wrong side of every trade in this file.
 *
 * The abstain is CONDITIONAL and the condition is checked, not assumed: it
 * applies only when every guard in `LOAD_BEARING_GUARDS` has actually passed.
 * The evaluation order already guarantees that at the point guard 4 runs, but a
 * reordering must break the build's behaviour loudly rather than silently widen
 * this, so the condition is evaluated from `evaluation` rather than inferred
 * from position.
 */
export const ABSTAINING_GUARDS: readonly AnswerGuardName[] = [
	"permission_axis",
];

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
	// (GUARD4-ABSTAIN) The abstain list was inert: it was a name the branch below
	// happened to check against, with nothing stopping a guard being added to it
	// that is load-bearing, or that runs BEFORE the guards whose passing is the
	// entire premise of abstaining. Both are now startup crashes, so the list
	// carries the weight the abstain branch gives it.
	const lastLoadBearing = Math.max(
		...LOAD_BEARING_GUARDS.map((name) => GUARD_EVALUATION_ORDER.indexOf(name)),
	);
	for (const name of ABSTAINING_GUARDS) {
		if (GUARD_CLASSES[name] !== "forgeable") {
			throw new Error(
				`(COMPANION-BRIDGE) guard ${name} may abstain but is classified ${GUARD_CLASSES[name]}; only a forgeable guard — one whose refusal is as forgeable as its permission would be — may abstain. Refusing to load`,
			);
		}
		const position = GUARD_EVALUATION_ORDER.indexOf(name);
		if (position < 0) {
			throw new Error(
				`(COMPANION-BRIDGE) guard ${name} may abstain but is never evaluated; refusing to load`,
			);
		}
		if (position < lastLoadBearing) {
			throw new Error(
				`(COMPANION-BRIDGE) guard ${name} may abstain but is evaluated at position ${position}, before the load-bearing guard at ${lastLoadBearing}; abstaining is only sound once every load-bearing guard has PASSED. Refusing to load`,
			);
		}
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
	/**
	 * (ANSWER-LEDGER) The durable idempotency + status ledger, and the fence that
	 * closes the status/answer race. It replaced a JSON store that sat here beside
	 * it during the migration; there is only one now.
	 */
	ledger: AttemptLedger;
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

	/**
	 * GUARD 4, FORGEABLE and ABSTAINING. The permission (red) axis is still
	 * latched. A non-positive reading no longer refuses on its own once both
	 * load-bearing guards have passed — see (GUARD4-ABSTAIN) on
	 * `ABSTAINING_GUARDS` for why, and for the one thing it is still read for.
	 */
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
 * (GUARD5-PICKER-GEOMETRY) How many screen-line windows two consecutive option
 * rows may be apart with NO further explanation — pure wrap slack.
 *
 * A row that is not followed by description text sits directly above the next
 * row, give or take the emulator wrapping a long label and the odd blank
 * separator line. Anything wider than this has to be explained by the option's
 * own rendered description; see `gapIsExplained`.
 */
export const SCREEN_ROW_ADJACENT_SLACK = 3;

/**
 * (GUARD5-PICKER-GEOMETRY) Squashed prefix of an option's DESCRIPTION used as
 * the on-screen anchor that explains the gap below its row.
 *
 * A prefix rather than the whole string because the picker hard-wraps the
 * description and may ellipsise its tail; the opening survives both. Longer
 * than the label anchor because a description is prose and a 16-character
 * opening ("same rule as the ") is a weaker discriminator than 16 characters of
 * a label.
 */
export const SCREEN_DESCRIPTION_ANCHOR_CHARS = 24;

export type PickerMatchReason =
	| "match"
	| "empty_screen"
	| "anchor_absent"
	| "anchor_too_weak"
	| "row_absent"
	| "rows_out_of_order"
	| "row_gap_unexplained"
	| "freetext_row_conflict";

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
	// NO whole-screen special case for short screens. It returned a single window
	// covering everything, which breaks the invariant every caller relies on —
	// window i starts at line i — so a two-line screen could not match a row that
	// was plainly on it. The general loop below handles any length.
	const windows: string[] = [];
	// EVERY line starts a window, including the last one (whose window is just
	// itself). Stopping a line early left the final line unable to START a window,
	// which was invisible while the row pattern was an unanchored substring search
	// — the row could still be found inside the previous line's window — and became
	// a refusal the moment (GUARD5-ROW-ANCHOR) required the row to begin its
	// window. A picker whose last option is the last line of the viewport is
	// ordinary, not suspicious.
	for (let i = 0; i < lines.length; i += 1) {
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
 *   - the row being PRESSED must be strongly verified — a label anchor clearing
 *     `SCREEN_MIN_ANCHOR_CHARS`, or its own description rendered in its region of
 *     the screen (`anchor_too_weak`). A one-character label still cannot collapse
 *     the check into "does `<digit><char>` occur anywhere"; what changed in
 *     (GUARD5-EVIDENCE-TIERS) is that the requirement now falls on the row whose
 *     digit is about to be typed instead of on all of them;
 *   - the rows that ARE on screen must form one PICKER BLOCK
 *     (`rows_out_of_order` / `row_gap_unexplained`), which is the structural
 *     property defined on `rowsFormPickerBlock` below. Rows that are NOT on
 *     screen are admitted only under (GUARD5-CLIPPED-VIEWPORT);
 *   - the free-text row is matched against bridge-owned copy read out of the
 *     Claude Code binary, never against a caller-supplied label
 *     (`question-store.deriveFreeTextOption`).
 *
 * (GUARD5-PICKER-GEOMETRY) CANARIED against a real Claude Code picker: the
 * fixture in `picker-screen.test.ts` is an unedited 120-column viewport captured
 * off the live emulator through this guard's own snapshot path, plus renders of
 * the same prompt at 80 and 100 columns.
 *
 * ---------------------------------------------------------------------------
 * (GUARD5-CLIPPED-VIEWPORT) WHEN THE PICKER IS TALLER THAN THE WINDOW
 * ---------------------------------------------------------------------------
 * This used to require EVERY option row, and the prompt's own anchor, to be
 * visible. Claude Code renders inline in the normal buffer, so a terminal
 * shorter than the prompt shows its TAIL: the header goes first, then the
 * question, then the early option rows. Every honest answer from a small window
 * was therefore refused — `row_absent` when only rows were lost, `anchor_absent`
 * once the header went too — and the user walked to the desk for a picker that
 * was plainly on their phone.
 *
 * A clip is now ADMITTED, but only when it is PROVEN to be a clip rather than
 * assumed from what is missing. Three things must hold, and each replaces
 * evidence the clip took away with evidence the clip cannot fake:
 *
 *   1. THE PRESSED ROW IS VISIBLE AND STRONG. A row that is not on screen is
 *      never pressed — that has not moved, and is the whole reason a clip is
 *      survivable at all: the claim guard 5 makes is about ONE row.
 *   2. THE VISIBLE ROWS ARE A PREFIX OR A SUFFIX of the block, never a hole in
 *      the middle and never both ends at once. A hole is not a clip; it is a
 *      screen whose digits do not belong to one list.
 *   3. THE CLIPPED EDGE IS AT THE VIEWPORT BOUNDARY, affirmatively. Below, the
 *      space under the last visible row is explained by that row's own
 *      description with no room left for the next row (`gapIsExplained`, the
 *      same rule interior gaps use). Above, the space over the first visible row
 *      must MATCH THE TAIL of the text that renders immediately above it — the
 *      previous option's description, or the item's own question when no row was
 *      lost (`clipAboveIsExplained`). There is deliberately no "the row is on
 *      line 0, so nothing could be above it" escape: a viewport whose very first
 *      line is a numbered row proves nothing about which list that row is in.
 *
 * The prompt anchor is subject to (3) rather than exempt from it. When the
 * header and the question opening are BOTH off screen the matcher does not fail
 * fast on `anchor_absent`; it continues, and the top-edge rule then has to be
 * satisfied by capture-derived prose. That needle is held to a HIGHER floor than
 * ordinary screen evidence — `SCREEN_CLIP_ANCHOR_CHARS`, the header anchor's own
 * length, not `SCREEN_MIN_ANCHOR_CHARS` — and it is END-ANCHORED to the row
 * rather than found anywhere in the region, so it is at least as long as the
 * anchor it replaces and pinned to a position the prompt anchor never was. If
 * that proof does not land, the refusal reported is the ORIGINAL `anchor_absent`,
 * so no screen refused before this change is refused differently now, and
 * nothing about the relaxation leaks into diagnostics.
 *
 * NOT admitted: a clip at both ends at once (a viewport shorter than the block
 * with rows lost above AND below). It is representable and it is refused — one
 * intact end is what keeps a run of digits tied to a list rather than to a
 * window someone chose.
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
	/**
	 * (GUARD5-CLIPPED-VIEWPORT) The refusal a screen with no prompt anchor on it
	 * gets, held rather than returned. EVERY later refusal returns this instead of
	 * its own reason when it is set, so relaxing the anchor cannot change what a
	 * currently-refused screen reports.
	 *
	 * `empty_screen` and `anchor_too_weak` are NOT held: the first has no rows to
	 * reason about, and the second means the item carries no anchor worth
	 * searching for at all, which no amount of screen evidence repairs.
	 */
	let anchorFailure: PickerScreenMatch | null = null;
	let windows: string[];
	if (prologue.ok) {
		windows = prologue.windows;
	} else {
		if (prologue.failure.reason !== "anchor_absent") return prologue.failure;
		anchorFailure = prologue.failure;
		windows = squashedWindows(input.screen);
	}
	/**
	 * The raw lines. The gap rule works on LINES rather than on the overlapping
	 * two-line windows, because a window that starts on the last gap line also
	 * contains the NEXT ROW's line — which let that row's own text be counted as
	 * the previous row's description.
	 */
	const lines = input.screen.split("\n");

	const missing: string[] = [];
	/**
	 * (GUARD5-CLIPPED-VIEWPORT) Only the rows actually ON SCREEN, with their
	 * options kept alongside so the two arrays stay index-aligned: everything
	 * downstream addresses a row by its position in the block, and a clipped block
	 * is a shorter block rather than one with holes in it.
	 */
	const presentOptions: QuestionOption[] = [];
	const presentWindows: number[][] = [];
	let firstPresent = -1;
	let lastPresent = -1;
	for (let position = 0; position < input.item.options.length; position += 1) {
		const option = input.item.options[position];
		if (option === undefined) continue;
		const hits = screenRowWindows(windows, option.index, option.label);
		if (hits.length === 0) {
			missing.push(`option:${option.index}`);
			continue;
		}
		if (firstPresent < 0) firstPresent = position;
		lastPresent = position;
		presentOptions.push(option);
		presentWindows.push(hits);
	}

	/**
	 * (GUARD5-FREETEXT-CONTRADICTION) The free-text row's presence is established
	 * on EVERY keystroke, not only on the one that presses its digit.
	 *
	 * It used to be looked for only when `requireOptionIndex` named it, which made
	 * the contradiction check below unreachable on an ordinary option press — and
	 * that is the press the check matters for. A screen showing `1. <option>` and
	 * `5. Type something.` with rows 2-4 nowhere on it was accepted as a bottom
	 * clip, when the visible editor row proves the opposite: the editor renders
	 * BELOW every option, so the options between them were not clipped away, they
	 * are not there.
	 *
	 * The verdicts are read differently by press, because they mean different
	 * things to it:
	 *   - ABSENT is only a refusal when this keystroke presses that digit.
	 *   - CONFLICT (the contract copy at more than one digit) is FATAL only on a
	 *     press — that is when "which row does this digit select" has to have an
	 *     answer. Off a press it just means presence is unknown, so it is not used
	 *     as evidence in either direction.
	 *   - FOUND feeds the chain only on a press (GUARD5-FREETEXT-PLACEMENT), but
	 *     feeds the contradiction check always.
	 */
	const freeText = input.item.freeTextOption;
	const pressingFreeText =
		freeText !== null && input.requireOptionIndex === freeText.index;
	/** Where the editor row is, whoever is pressing. `null` = absent or unknown. */
	let freeTextRowAt: number[] | null = null;
	if (freeText !== null) {
		const verdict = verifyFreeTextRow({
			windows,
			lines,
			item: input.item,
			digitIndex: freeText.index,
		});
		if (verdict.kind === "found") freeTextRowAt = verdict.windows;
		if (verdict.kind === "absent" && pressingFreeText) {
			missing.push(`freetext:${freeText.index}`);
		}
		if (verdict.kind === "conflict" && pressingFreeText) {
			return (
				anchorFailure ?? {
					ok: false,
					reason: "freetext_row_conflict",
					missing: [`freetext:${freeText.index}`],
					digitMapped: true,
				}
			);
		}
	}
	/** (GUARD5-FREETEXT-PLACEMENT) In the chain ONLY when its digit is pressed. */
	const freeTextWindows = pressingFreeText ? freeTextRowAt : null;

	const rowsRefusal: PickerScreenMatch = anchorFailure ?? {
		ok: false,
		reason: "row_absent",
		missing,
		digitMapped: true,
	};
	const clippedAbove = firstPresent > 0;
	const clippedBelow =
		lastPresent >= 0 && lastPresent < input.item.options.length - 1;
	// (GUARD5-FREETEXT-CONTRADICTION) The editor row renders BELOW every option,
	// so seeing it while options below the block are missing is not a clip — it is
	// a screen whose numbering does not match the capture. Refused on EVERY
	// keystroke, including the ones that press an ordinary option.
	if (clippedBelow && freeTextRowAt !== null) return rowsRefusal;
	if (missing.length > 0) {
		// (GUARD5-CLIPPED-VIEWPORT) 1. The row being pressed is never optional.
		if (pressedRowIsMissing(input, missing)) return rowsRefusal;
		// A block with nothing left in it is not a clipped block.
		if (presentOptions.length === 0) return rowsRefusal;
		// 2. A run, at one end. Anything else is a hole or a two-ended window.
		if (presentOptions.length !== lastPresent - firstPresent + 1) {
			return rowsRefusal;
		}
		if (clippedAbove && clippedBelow) return rowsRefusal;
	}

	/**
	 * (GUARD5-CLIPPED-VIEWPORT) 3. The text that must render immediately above the
	 * first visible row, when the top edge has to be proven at all. `null` means
	 * nothing was lost above it and the region is not examined.
	 */
	const clipAboveText = clippedAbove
		? (input.item.options[firstPresent - 1]?.description ?? null)
		: anchorFailure !== null
			? input.item.question
			: null;
	if (clippedAbove && clipAboveText === null) return rowsRefusal;

	if (!rowsAreOrdered(presentWindows)) {
		return (
			anchorFailure ?? {
				ok: false,
				reason: "rows_out_of_order",
				missing: ["row_order"],
				digitMapped: true,
			}
		);
	}
	// (GUARD5-BLOCK-ANCHOR) There is deliberately NO separate "at least one strong
	// row" pre-check here. There was one, and once the evidence region was clamped
	// below each row it degenerated into "does any label anywhere near the top of
	// the viewport reach eight characters" — which a multi-select of short labels
	// fails even when its rows are perfectly anchored by their descriptions. That
	// turned a REFUSAL into a PARTIAL WRITE: the toggle digits passed and were
	// typed, then the submit keystroke (which presses no option) refused, leaving
	// the picker half-toggled and the question unanswerable. `rowsFormPickerBlock`
	// already enforces the same property correctly, at the ACCEPTED PLACEMENT, for
	// every call including the no-digit ones.
	const block = rowsFormPickerBlock({
		rowWindows: presentWindows,
		options: presentOptions,
		lines,
		cols: derivedCols(lines),
		requireOptionIndex: input.requireOptionIndex,
		freeTextWindows,
		clipAboveText,
		clipBelow: clippedBelow,
	});
	if (block !== "ok") {
		return (
			anchorFailure ?? {
				ok: false,
				reason: block === "gap" ? "row_gap_unexplained" : "anchor_too_weak",
				missing: block === "gap" ? ["row_block"] : [evidenceSubject(input)],
				digitMapped: true,
			}
		);
	}
	return { ok: true, reason: "match", missing: [], digitMapped: true };
}

/**
 * (GUARD5-CLIPPED-VIEWPORT) Is the row this keystroke is about to press one of
 * the rows that is NOT on screen?
 *
 * Asked against the `missing` list rather than recomputed, so there is exactly
 * one place that decides a row is absent. A press with no row behind it
 * (`null` — a multi-select toggle re-check or the submit) has no row to lose.
 */
function pressedRowIsMissing(
	input: { requireOptionIndex: number | null },
	missing: readonly string[],
): boolean {
	const pressed = input.requireOptionIndex;
	if (pressed === null) return false;
	return (
		missing.includes(`option:${pressed}`) ||
		missing.includes(`freetext:${pressed}`)
	);
}

/**
 * (GUARD5-EVIDENCE-SUBJECT) What an evidence refusal is ABOUT.
 *
 * It used to always read `option:<requireOptionIndex ?? 0>`, which named a row
 * that does not exist when the free-text digit is pressed (`option:2` on a
 * two-option item) and blamed option 0 when no digit is pressed at all. A
 * diagnostic that points at the wrong row is worse than a vague one.
 */
function evidenceSubject(input: {
	item: QuestionItem;
	requireOptionIndex: number | null;
}): string {
	const pressed = input.requireOptionIndex;
	if (pressed === null) return "row_evidence";
	const freeText = input.item.freeTextOption;
	if (freeText !== null && pressed === freeText.index) {
		return `freetext:${pressed}`;
	}
	return `option:${pressed}`;
}

/**
 * (GUARD5-PICKER-GEOMETRY) Can the matched rows be assigned window indices that
 * are non-decreasing in digit order?
 *
 * Windows overlap by design (`SCREEN_LINE_WINDOW`), so two adjacent rows can
 * legitimately match the SAME window — hence non-decreasing rather than strictly
 * increasing. Taking the earliest hit for each row in turn is optimal here
 * because ordering alone has no upper bound: no earlier choice can strand a
 * later row that a later choice would have reached.
 */
function rowsAreOrdered(rowWindows: readonly number[][]): boolean {
	let cursor = 0;
	for (const hits of rowWindows) {
		const next = hits.find((window) => window >= cursor);
		if (next === undefined) return false;
		cursor = next;
	}
	return true;
}

/**
 * (GUARD5-PICKER-GEOMETRY) THE INVARIANT: the matched rows are one picker block
 * — every gap between consecutive option rows is accounted for by the render of
 * the option above it.
 *
 * A gap is admissible when EITHER it is small enough to be wrap slack
 * (`SCREEN_ROW_ADJACENT_SLACK`), OR the preceding option's own description is
 * rendered inside it AND the gap fits the number of lines that description can
 * occupy (`descriptionLineBudget`).
 *
 * Why not simply "the rows sit inside one narrow band": a real Claude Code
 * picker renders each option's DESCRIPTION under its row, wrapped, so four
 * options span ten or more screen lines and no band that admits that is worth
 * anything. Explaining each gap is the stronger property anyway. A band asks
 * only "are these close together"; this asks "is the space between row N and
 * row N+1 filled by the text option N is supposed to be showing" — which forged
 * or unrelated content does not satisfy even when it is dense, and which an
 * honest picker satisfies at any column width.
 *
 * Rows are still permitted to share a window, and the LAST row's trailing region
 * is not examined UNLESS rows were clipped off the bottom
 * ((GUARD5-CLIPPED-VIEWPORT), `clipBelow`): with nothing following the block
 * there is no gap to explain, and requiring the last description to be fully on
 * screen would refuse a picker whose footer has scrolled — a refusal that buys
 * nothing, because every row's presence and every earlier gap has already been
 * proven. When a row IS missing below, that same region becomes the proof that
 * the viewport ended rather than the list.
 *
 * The search is exhaustive over row placements rather than greedy: an upper
 * bound on a gap means an earlier hit for row N can strand row N+1 where a later
 * hit would have fitted, so committing to the first placement would refuse
 * honest pickers whose digits also appear elsewhere on screen (an N-question
 * prompt restarts at 1 for every question).
 *
 * (GUARD5-EVIDENCE-TIERS) The PRESSED row additionally has to be STRONGLY
 * verified at the placement the accepted block uses — see `rowIsStronglyVerified`
 * for what that means and why the requirement lands here rather than as a
 * pre-filter over every row.
 *
 * Returns which property failed, because the two are different accidents: `gap`
 * means the rows are not one block, `evidence` means the block is fine but the
 * one row this keystroke is about to press is not pinned down well enough to
 * press it.
 */
function rowsFormPickerBlock(input: {
	rowWindows: readonly number[][];
	options: readonly QuestionOption[];
	lines: readonly string[];
	cols: number;
	requireOptionIndex: number | null;
	/**
	 * (GUARD5-FREETEXT-PLACEMENT) Where the free-text row was found, when its digit
	 * is the one being pressed. It is appended to the chain as a FINAL row so it has
	 * to sit inside the SAME accepted placement as the options — a viewport-wide
	 * "is it anywhere below the last row" test let a truncated capture point the
	 * digit at a real option further down the real picker.
	 */
	freeTextWindows: readonly number[] | null;
	/**
	 * (GUARD5-CLIPPED-VIEWPORT) The text that renders immediately ABOVE the first
	 * row of this block — the previous option's description when rows were clipped
	 * off the top, or the item's own question when only the prompt was. `null`
	 * means nothing was lost above the block and the region is not examined at
	 * all, which is the ordinary unclipped case.
	 */
	clipAboveText: string | null;
	/**
	 * (GUARD5-CLIPPED-VIEWPORT) Rows were lost off the BOTTOM, so the last visible
	 * row's trailing region — normally not examined at all — has to prove there was
	 * no room left on screen for the row that follows it.
	 */
	clipBelow: boolean;
	/**
	 * (GUARD5-REASON-PER-CANDIDATE) Internal: re-run ignoring the evidence tier, to
	 * decide which property actually blocked a refusal. Never set by callers.
	 */
	evidenceBlind?: boolean;
}): "ok" | "gap" | "evidence" {
	const { rowWindows, options, lines, cols, requireOptionIndex } = input;
	const evidenceBlind = input.evidenceBlind === true;
	const chain: readonly (readonly number[])[] =
		input.freeTextWindows === null
			? rowWindows
			: [...rowWindows, input.freeTextWindows];
	const last = chain.length - 1;
	if (last < 0) return "gap";
	/**
	 * Whether any placement satisfied the gap rule but failed only on evidence.
	 * Tracked so a refusal names the property that actually blocked it.
	 */
	let blockedOnEvidence = false;
	/**
	 * (GUARD5-BLOCK-ANCHOR) Whether the ACCEPTED placement contains at least one
	 * option row strongly verified at the position the block gave it.
	 *
	 * Two holes shared this root. Pressing the FREE-TEXT digit names no option, so
	 * every option row counted as "not the row being pressed" and nothing had to be
	 * strong at all — an item of one-character labels passed on that digit while
	 * being refused on every other press. And the fallback meant to cover the
	 * no-digit case searched the WHOLE SCREEN rather than the accepted block, so
	 * evidence outside the picker satisfied it. Requiring it per placement closes
	 * both, and ties the anchor to the block instead of to the viewport.
	 */
	let sawStrongRow = false;
	/** `row:window` -> can the rows BELOW `row` be placed from here. */
	const memo = new Map<string, boolean>();
	const placeable = (row: number, at: number): boolean => {
		const key = `${row}:${at}`;
		const cached = memo.get(key);
		if (cached !== undefined) return cached;
		let ok = false;
		if (row === last) {
			// (GUARD5-CLIPPED-VIEWPORT) The trailing region is examined ONLY when a
			// row was lost below it. Unclipped, the last description is allowed to
			// have scrolled — there is no following row for it to explain.
			const edgeOk =
				!input.clipBelow ||
				gapIsExplained({
					lines,
					cols,
					option: options[row],
					from: at,
					to: lines.length,
				});
			const evidenceOk =
				evidenceBlind ||
				rowIsVerifiedEnough({
					options,
					lines,
					requireOptionIndex,
					row,
					from: at,
					to: lines.length,
				});
			if (!evidenceOk) blockedOnEvidence = true;
			ok = edgeOk && evidenceOk;
			if (ok && rowIsOptionAndStrong(options, row, lines, at, lines.length)) {
				sawStrongRow = true;
			}
		} else {
			for (const next of chain[row + 1] ?? []) {
				if (next < at) continue;
				if (
					!gapIsExplained({
						lines,
						cols,
						option: options[row],
						from: at,
						to: next,
					})
				) {
					continue;
				}
				if (
					!evidenceBlind &&
					!rowIsVerifiedEnough({
						options,
						lines,
						requireOptionIndex,
						row,
						from: at,
						to: next,
					})
				) {
					blockedOnEvidence = true;
					continue;
				}
				if (placeable(row + 1, next)) {
					ok = true;
					if (rowIsOptionAndStrong(options, row, lines, at, next)) {
						sawStrongRow = true;
					}
					break;
				}
			}
		}
		memo.set(key, ok);
		return ok;
	};
	if (
		(chain[0] ?? []).some(
			(start) =>
				clipAboveIsExplained({
					lines,
					cols,
					text: input.clipAboveText,
					at: start,
				}) && placeable(0, start),
		)
	) {
		// (GUARD5-BLOCK-ANCHOR) A block whose every row is weakly anchored is not
		// evidence that this picker is on screen, whichever digit is being pressed.
		return evidenceBlind || sawStrongRow ? "ok" : "evidence";
	}
	// (GUARD5-REASON-PER-CANDIDATE) `blockedOnEvidence` latches across candidate
	// placements, so on its own it would report `anchor_too_weak` for a screen the
	// GAP rule rejected. Re-run with the evidence requirement dropped: if the block
	// then forms, evidence was the blocker; if it still does not, the geometry was.
	if (blockedOnEvidence && evidenceBlind === false) {
		const withoutEvidence = rowsFormPickerBlock({
			...input,
			evidenceBlind: true,
		});
		return withoutEvidence === "ok" ? "evidence" : "gap";
	}
	return "gap";
}

/** Is row `row` an OPTION row (not the appended free-text row) and strong here? */
function rowIsOptionAndStrong(
	options: readonly QuestionOption[],
	row: number,
	lines: readonly string[],
	at: number,
	to: number,
): boolean {
	const option = options[row];
	if (option === undefined) return false;
	return rowIsStronglyVerified({ option, lines, from: at, to });
}

/**
 * (GUARD5-EVIDENCE-TIERS) Is row `row` pinned down well enough for what this
 * keystroke is about to do?
 *
 * TWO TIERS, because the rows do not carry equal weight. The claim guard 5 has to
 * establish is "the digit I am about to press selects the option I believe it
 * selects". That is a claim about ONE row. The others are corroboration: they
 * show the block is this question's picker, which the prompt anchor and the gap
 * rule already carry most of.
 *
 * So the row being PRESSED must be STRONGLY verified — its label anchor clears
 * `SCREEN_MIN_ANCHOR_CHARS`, or its own DESCRIPTION is rendered in its region of
 * the screen. Every other row need only match its digit.
 *
 * This is what a blanket anchor floor over all rows got wrong. Upstream's own
 * tool schema asks agents for labels of "1-5 words" and makes `description`
 * REQUIRED, so "Yes" / "No" / "Skip" / "Later" are the DOCUMENTED shape of a real
 * option, and a floor of eight characters refused honest pickers — including,
 * live, a four-option prompt whose fourth option was "Skip" and whose refusal
 * named `option:3`, a row the user was not even pressing. The floor was aimed at
 * a forged item collapsing the row test into a two-character substring search;
 * that attack is about the row being PRESSED, and it is still refused here.
 *
 * A short label plus a description that is genuinely on screen is not weak
 * evidence: the description is long prose the forger would have to reproduce
 * from the victim's own screen at the right row, which is the same bar the label
 * floor was imposing, met by a different needle.
 */
function rowIsVerifiedEnough(input: {
	options: readonly QuestionOption[];
	lines: readonly string[];
	requireOptionIndex: number | null;
	row: number;
	from: number;
	to: number;
}): boolean {
	const option = input.options[input.row];
	// The APPENDED free-text row has no entry in `options`. It is not verified by
	// this tier at all: its evidence is the end-anchored match against the proven
	// contract copy plus its placement inside this block, both already established
	// by `verifyFreeTextRow`. Failing it here would refuse every free-text press.
	if (input.row >= input.options.length) return true;
	if (option === undefined) return false;
	// Not the row being pressed: matching its digit is all that is asked of it.
	// When the pressed digit names NO option (a toggle re-check, or the free-text
	// slot) this makes every row corroboration-only, which is why the caller
	// additionally requires one strong row inside the accepted placement.
	if (option.index !== input.requireOptionIndex) return true;
	return rowIsStronglyVerified({
		option,
		lines: input.lines,
		from: input.from,
		to: input.to,
	});
}

/**
 * (GUARD5-EVIDENCE-TIERS) Strong verification for a single row: a label anchor
 * long enough to be evidence on its own, or the option's description rendered in
 * the row's own region of the screen.
 */
/**
 * (GUARD5-EVIDENCE-REGION) How far below a row its own description may start.
 *
 * An option's description begins on the line after its row, give or take the
 * label wrapping. It is NOT "anywhere below the picker": the last row's region
 * used to run to the end of the viewport, so a short-labelled last option — the
 * exact "Skip" case this tiering exists for — was verified by its description
 * appearing anywhere further down the screen, including in unrelated output.
 * A tight constant is also viewport-independent, so a taller terminal cannot buy
 * a bigger search region.
 */
const SCREEN_EVIDENCE_REGION_LINES = SCREEN_ROW_ADJACENT_SLACK + 1;

function rowIsStronglyVerified(input: {
	option: QuestionOption;
	lines: readonly string[];
	from: number;
	to: number;
}): boolean {
	if (
		anchorOf(input.option.label, SCREEN_OPTION_ANCHOR_CHARS).length >=
		SCREEN_MIN_ANCHOR_CHARS
	) {
		return true;
	}
	const description = anchorOf(
		input.option.description,
		SCREEN_DESCRIPTION_ANCHOR_CHARS,
	);
	if (description.length < SCREEN_MIN_ANCHOR_CHARS) return false;
	// (GUARD5-EVIDENCE-REGION) RAW LINES, bounded below the row, and STRICTLY
	// SHORT OF THE NEXT ROW. The overlapping two-line windows used here before let
	// the NEXT option's row supply this option's description: a capture claiming
	// option 1's description is "Escalate to the owner" matched the text of row 2,
	// so a phone could present row 1 as the escalation while digit 1 selected
	// "Yes". `to` is the next row's line and is never included.
	const end = Math.min(input.to, input.from + SCREEN_EVIDENCE_REGION_LINES);
	if (end <= input.from) return false;
	const region = squash(input.lines.slice(input.from, end).join(""));
	return region.includes(description);
}

/**
 * (GUARD5-FREETEXT-PLACEMENT) Where the free-text row is, if it is on screen.
 *
 * The label comes from `item.freeTextOption.label`, which `question-store`
 * DERIVES from the versioned picker contract — never from the capture, and never
 * from a union of every version's copy. On the proven build (2.1.226) that is
 * "Type something.", byte-exact including the full stop, and the free-text
 * sequence behind it has been driven end to end.
 *
 * The match is EXACT and END-BOUNDED against the raw line: no squashing, no case
 * folding, no substring. Squashing accepted "Type some thing.", "TYPE
 * SOMETHING." and a tab-separated spelling as the editor row, so a REAL option
 * wearing any of those was pressed instead. And if the label turns up at more
 * than one digit, that is a refusal rather than a choice — which row the digit
 * lands on is precisely what cannot be established.
 */
function freeTextRowLines(
	lines: readonly string[],
	digit: number,
	label: string,
): number[] {
	// RAW line, EXACT label: no squash, no case folding, no substring. Squashing
	// made "Type some thing.", "TYPE SOMETHING." and "Type\tsomething." all match
	// the contract copy, so a REAL option wearing any of those spellings was
	// accepted as the editor slot and its digit pressed. `$` after the label is
	// what stops "Type something else entirely" matching too.
	const pattern = new RegExp(
		`^[^0-9A-Za-z]{0,${SCREEN_ROW_DECORATION_MAX_CHARS}}${digit}[.)\\]:]?[ \\t]{0,4}${escapeRegExp(label)}[ \\t]*$`,
	);
	const hits: number[] = [];
	for (let i = 0; i < lines.length; i += 1) {
		if (pattern.test(lines[i] ?? "")) hits.push(i);
	}
	return hits;
}

/** Every digit whose row carries the contract label, exactly. */
function digitsCarryingLabel(
	lines: readonly string[],
	label: string,
): Set<number> {
	const found = new Set<number>();
	for (let digit = 1; digit <= 9; digit += 1) {
		if (freeTextRowLines(lines, digit, label).length > 0) found.add(digit);
	}
	return found;
}

/**
 * (GUARD5-FREETEXT-CONTRADICTION) Three verdicts, and the caller reads each of
 * them differently depending on whether this keystroke presses that digit. There
 * is deliberately no `not_pressed` member: the row's presence is now established
 * on every keystroke, and a fourth value meaning "did not look" was the shape
 * that let the contradiction check go unreachable on an option press.
 */
type FreeTextVerdict =
	| { kind: "absent" }
	| { kind: "conflict" }
	| { kind: "found"; windows: number[] };

function verifyFreeTextRow(input: {
	windows: readonly string[];
	lines: readonly string[];
	item: QuestionItem;
	digitIndex: number;
}): FreeTextVerdict {
	const freeText = input.item.freeTextOption;
	if (freeText === null) return { kind: "absent" };
	const digit = input.digitIndex + 1;
	const hits = freeTextRowLines(input.lines, digit, freeText.label);
	if (hits.length === 0) return { kind: "absent" };
	// TWO candidate rows is a refusal, not a choice. If the contract label appears
	// at more than one digit — a real option spelled exactly like the system row,
	// with the true system row sitting below it — then which one this digit selects
	// is exactly what cannot be established, and pressing it is irreversible.
	const carrying = digitsCarryingLabel(input.lines, freeText.label);
	if (carrying.size !== 1 || !carrying.has(digit)) return { kind: "conflict" };
	if (hits.length !== 1) return { kind: "conflict" };
	// A real option wearing this digit means the capture and the screen disagree
	// about the numbering; pressing it would submit an answer nobody chose.
	for (const option of input.item.options) {
		if (
			screenRowWindows(input.windows, input.digitIndex, option.label).length > 0
		) {
			return { kind: "conflict" };
		}
	}
	return { kind: "found", windows: hits };
}

/**
 * (GUARD5-CELL-WIDTH) Width of `text` in TERMINAL CELLS, not code units.
 *
 * Every wrap estimate here is really a question about how many screen lines a
 * string occupies, and that is measured in cells. `String.length` gets it wrong
 * in both directions: a CJK ideograph is one code unit and TWO cells, so 80 Han
 * characters occupy 160 cells and wrap to twice as many lines as a length-based
 * estimate predicts — which refused honest CJK pickers as `row_gap_unexplained`
 * — while a combining mark is one code unit and zero cells.
 *
 * Deliberately a small wcwidth rather than a dependency: the ranges below are the
 * ones that occur in picker text (CJK, Hangul, Kana, fullwidth forms, emoji
 * presentation), and being approximate is acceptable because the result only ever
 * bounds a gap. A tab is counted as `TAB_CELLS` because the emulator has already
 * expanded it by the time the snapshot is read.
 */
const TAB_CELLS = 8;

function cellWidth(codePoint: number): number {
	if (codePoint === 0x09) return TAB_CELLS;
	// Combining marks and zero-width joiners occupy no cell.
	if (
		(codePoint >= 0x0300 && codePoint <= 0x036f) ||
		codePoint === 0x200b ||
		codePoint === 0x200d ||
		codePoint === 0xfe0f
	) {
		return 0;
	}
	if (
		(codePoint >= 0x1100 && codePoint <= 0x115f) || // Hangul Jamo
		(codePoint >= 0x2e80 && codePoint <= 0xa4cf) || // CJK radicals .. Yi
		(codePoint >= 0xac00 && codePoint <= 0xd7a3) || // Hangul syllables
		(codePoint >= 0xf900 && codePoint <= 0xfaff) || // CJK compatibility
		(codePoint >= 0xfe30 && codePoint <= 0xfe6f) || // CJK compatibility forms
		(codePoint >= 0xff00 && codePoint <= 0xff60) || // Fullwidth forms
		(codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
		(codePoint >= 0x1f300 && codePoint <= 0x1f64f) || // emoji
		(codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
		(codePoint >= 0x20000 && codePoint <= 0x3fffd)
	) {
		return 2;
	}
	return 1;
}

const graphemes =
	typeof Intl.Segmenter === "function"
		? new Intl.Segmenter(undefined, { granularity: "grapheme" })
		: null;

/**
 * (GUARD5-CELL-WIDTH) Width in cells, counted per GRAPHEME rather than per code
 * point.
 *
 * Per code point gets emoji wrong in both directions. A variation-selector
 * sequence like "☺️" is U+263A + U+FE0F: the base is narrow and VS16 is zero, so
 * it counted as ONE cell while the terminal renders TWO — an emoji-heavy
 * description then looked narrower than it is and was refused as an unexplained
 * gap. A ZWJ family is the opposite: many wide code points that render as one
 * two-cell glyph, counted as eight.
 */
export function displayWidth(text: string): number {
	if (graphemes === null) {
		let fallback = 0;
		for (const character of text) {
			fallback += cellWidth(character.codePointAt(0) ?? 0);
		}
		return fallback;
	}
	let width = 0;
	for (const { segment } of graphemes.segment(text)) {
		const points = [...segment].map((c) => c.codePointAt(0) ?? 0);
		// VS16 forces emoji presentation: the whole cluster is two cells.
		if (points.includes(0xfe0f) || points.includes(0x200d)) {
			width += 2;
			continue;
		}
		let cluster = 0;
		for (const point of points) cluster += cellWidth(point);
		// A cluster always occupies at least one cell, even if it is all marks.
		width += Math.max(cluster, 1);
	}
	return width;
}

/**
 * (GUARD5-CELL-WIDTH) The terminal's usable width, derived FROM THE SCREEN.
 *
 * The matcher is not given the column count, and it must not take one from the
 * caller — a wide claimed width would shrink every wrap estimate and buy the
 * caller bigger gaps. The widest rendered line is a sound screen-derived
 * estimate, floored so a nearly-empty viewport cannot drive the estimate to zero
 * and divide by it.
 */
const MIN_DERIVED_COLS = 20;

function derivedCols(lines: readonly string[]): number {
	let widest = 0;
	for (const line of lines) {
		const width = displayWidth(line);
		if (width > widest) widest = width;
	}
	return Math.max(widest, MIN_DERIVED_COLS);
}
function gapIsExplained(input: {
	lines: readonly string[];
	cols: number;
	option: QuestionOption | undefined;
	from: number;
	to: number;
}): boolean {
	if (input.to - input.from <= SCREEN_ROW_ADJACENT_SLACK) return true;
	const option = input.option;
	if (option === undefined) return false;

	// The region STRICTLY BETWEEN the two row lines. Both row lines are excluded:
	// including the next row's line let that row's own text supply the previous
	// row's description anchor, which is the overlap the 2-line windows introduced
	// and is exactly backwards — the point is to explain the space between them.
	const between = input.lines.slice(input.from + 1, input.to);
	if (between.length === 0) return false;
	const betweenText = squash(between.join(""));

	// How much of the description is ACTUALLY on screen here. The budget is
	// derived from this and never from `option.description.length`: the capture
	// may claim thousands of characters while putting a two-line prefix on screen,
	// and a claim-derived budget therefore bought a viewport-sized gap for free.
	const matched = matchedDescriptionPrefix(option.description, betweenText);
	if (matched < SCREEN_MIN_ANCHOR_CHARS) return false;

	// Cells, not code units, and the screen's own width — see (GUARD5-CELL-WIDTH).
	// Measured on the UNSQUASHED prefix, because the rendered text carries the
	// inter-word spaces the squash removed, and divided by the width actually
	// available to a description rather than the full terminal: the picker indents
	// it. Ignoring both made the estimate far too small, so an honest description
	// of a thousand-odd characters at 80 columns wrapped to more lines than the
	// budget allowed and was refused.
	const matchedCells = displayWidth(
		unsquashedPrefix(option.description, matched),
	);
	const usableCols = Math.max(input.cols - DESCRIPTION_INDENT_CELLS, 8);
	const budget =
		Math.ceil(matchedCells / usableCols) + SCREEN_ROW_ADJACENT_SLACK;
	return input.to - input.from <= budget;
}

/**
 * (GUARD5-MATCHED-BUDGET) How far a picker indents a description under its row.
 * Subtracted from the terminal width so the wrap estimate uses the space the text
 * actually gets.
 */
const DESCRIPTION_INDENT_CELLS = 5;

/**
 * (GUARD5-CLIPPED-VIEWPORT) Is the space ABOVE the first row of the block filled
 * by the tail of the text that is supposed to render there?
 *
 * The mirror image of `gapIsExplained`, and it exists for the same reason: a gap
 * is admissible when the render of what belongs in it is actually in it. What
 * differs is which end survives. An interior gap shows the description from its
 * START, so the needle is a PREFIX; a clipped top shows whatever the viewport
 * did not eat, so the needle is a SUFFIX.
 *
 * `text` is the previous option's description when option rows were lost off the
 * top, and the item's own question when only the header/question opening was.
 *
 * (GUARD5-CLIP-ADJACENT) THE MATCH IS END-ANCHORED, NOT A SUBSTRING SEARCH, and
 * that is the whole of its strength. `includes` accepted the needle ANYWHERE in
 * the region, so a screen reading
 *
 *     …genuine description tail
 *     THEN SOME UNRELATED OUTPUT
 *      4. Final expected choice
 *
 * passed: the description tail was up there somewhere, and the line the digit
 * actually sits under was not examined at all. The squashed region must now END
 * with the needle, so the proven text is the text IMMEDIATELY ABOVE the row —
 * which is the only position the claim "this row follows that description" is
 * about. Squashing strips whitespace, so blank separator lines and indentation
 * do not break the anchoring; anything else between the two does, deliberately.
 *
 * The floor is `SCREEN_CLIP_ANCHOR_CHARS`, which is not
 * `SCREEN_MIN_ANCHOR_CHARS`: this needle STANDS IN FOR the prompt anchor, so it
 * has to be at least as long as the header anchor it replaces rather than merely
 * long enough to be evidence at all.
 *
 * THERE IS NO `at === 0` ESCAPE. A viewport whose very first line is a numbered
 * row has nothing above it to corroborate, and "nothing to check" is not
 * "checked" — that is the rule this whole file is built on. Such a screen is
 * refused, which costs the rare maximal clip and buys the guarantee that a
 * clipped block is always tied to this item by text outside the rows.
 */
function clipAboveIsExplained(input: {
	lines: readonly string[];
	cols: number;
	text: string | null;
	at: number;
}): boolean {
	if (input.text === null) return true;
	const above = input.lines.slice(0, input.at);
	if (above.length === 0) return false;
	const aboveText = squash(above.join(""));
	const matched = matchedTextSuffix(input.text, aboveText);
	if (matched < SCREEN_CLIP_ANCHOR_CHARS) return false;
	// Same budget arithmetic as `gapIsExplained`: how many lines the text that WAS
	// matched can occupy at this width, plus wrap slack. It bounds the TERMINAL
	// SEGMENT — the matched tail now provably ends at the row, so this is what
	// stops a screenful of unrelated output sitting above it and still counting.
	const matchedCells = displayWidth(unsquashedSuffix(input.text, matched));
	const usableCols = Math.max(input.cols - DESCRIPTION_INDENT_CELLS, 8);
	return (
		input.at <= Math.ceil(matchedCells / usableCols) + SCREEN_ROW_ADJACENT_SLACK
	);
}

/**
 * (GUARD5-CLIPPED-VIEWPORT) The floor on a clip needle.
 *
 * Deliberately the HEADER anchor's length rather than `SCREEN_MIN_ANCHOR_CHARS`.
 * The clip proof is what a viewport with no header and no question opening on it
 * offers INSTEAD of the prompt anchor, so a floor of eight would have accepted a
 * shorter needle than the one it replaces — which is the opposite of the trade
 * the clip relaxation is supposed to be making.
 */
const SCREEN_CLIP_ANCHOR_CHARS = SCREEN_HEADER_ANCHOR_CHARS;

/**
 * (GUARD5-CLIPPED-VIEWPORT) The longest SUFFIX of `text` (squashed) that the
 * region ENDS WITH, in characters. `matchedDescriptionPrefix` from the other end.
 *
 * Binary search on the same monotonicity: a region that ends with the n-character
 * suffix also ends with every shorter one, so if length n does not match, no
 * longer one does either.
 */
function matchedTextSuffix(text: string, region: string): number {
	const squashed = squash(text);
	if (squashed.length < SCREEN_CLIP_ANCHOR_CHARS) return 0;
	// `endsWith`, never `includes` — see (GUARD5-CLIP-ADJACENT).
	if (!region.endsWith(squashed.slice(-SCREEN_CLIP_ANCHOR_CHARS))) return 0;
	let low = SCREEN_CLIP_ANCHOR_CHARS;
	let high = squashed.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (region.endsWith(squashed.slice(squashed.length - mid))) {
			low = mid;
		} else {
			high = mid - 1;
		}
	}
	return low;
}

/**
 * The suffix of the ORIGINAL `text` holding `squashedChars` non-whitespace
 * characters — the same text the matcher proved, with its spaces put back, which
 * is what the terminal actually wrapped. `unsquashedPrefix` from the other end.
 */
function unsquashedSuffix(text: string, squashedChars: number): string {
	const characters = [...text];
	let counted = 0;
	let start = characters.length;
	for (let index = characters.length - 1; index >= 0; index -= 1) {
		start = index;
		if (!/\s/.test(characters[index] ?? "")) counted += 1;
		if (counted >= squashedChars) break;
	}
	return characters.slice(start).join("");
}

/**
 * The prefix of the ORIGINAL description holding `squashedChars` non-whitespace
 * characters — i.e. the same text the matcher proved, with its spaces put back,
 * which is what the terminal actually wrapped.
 */
function unsquashedPrefix(description: string, squashedChars: number): string {
	let counted = 0;
	let index = 0;
	for (const character of description) {
		index += character.length;
		if (!/\s/.test(character)) counted += 1;
		if (counted >= squashedChars) break;
	}
	return description.slice(0, index);
}

/**
 * (GUARD5-MATCHED-BUDGET) The longest prefix of `description` (squashed) that
 * actually appears in `betweenText`, in characters.
 *
 * Binary search rather than a scan: `includes` is monotone in the prefix length —
 * if a prefix of length n is absent, every longer one is too — so the boundary is
 * findable in log steps, which keeps this cheap enough to run per candidate row
 * placement.
 *
 * A PREFIX specifically, because that is what a rendered description is: the
 * picker wraps it from the start and may ellipsise the tail, so the opening is the
 * part guaranteed to be there if any of it is.
 */
function matchedDescriptionPrefix(
	description: string,
	betweenText: string,
): number {
	const squashed = squash(description);
	if (squashed.length === 0) return 0;
	if (!betweenText.includes(squashed.slice(0, SCREEN_MIN_ANCHOR_CHARS))) {
		return 0;
	}
	let low = SCREEN_MIN_ANCHOR_CHARS;
	let high = squashed.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (betweenText.includes(squashed.slice(0, mid))) {
			low = mid;
		} else {
			high = mid - 1;
		}
	}
	return low;
}

/**
 * Which screen lines OPEN with `<decoration><digit><=6 decoration><label anchor>`.
 *
 * LINE-ANCHORED (`^`). Without the anchor this was a substring search over a
 * squashed two-line window, so ordinary prose containing a number matched a row:
 * "…then step 2. Then do X" satisfied row 2, and any agent output that happens to
 * enumerate something could stand in for a picker. A row is a LINE that begins
 * with its digit, and windows already start at a line boundary, so anchoring the
 * pattern to the window start is exactly "the line starts with this row".
 *
 * Returns ALL the indices rather than a boolean, because the caller then has to
 * choose a placement per row that satisfies `rowsFormPickerBlock` — "each needle
 * is somewhere on screen" is a much weaker claim than "these rows are rendered
 * as one list", and a row's digit can legitimately appear more than once (an
 * N-question prompt restarts its numbering for every question).
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
		`^[^0-9a-z]{0,${SCREEN_ROW_DECORATION_MAX_CHARS}}${digit}[^a-z0-9]{0,${SCREEN_ROW_DECORATION_MAX_CHARS}}${escapeRegExp(anchor)}`,
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
	/**
	 * The guards that PASSED — the durable audit answer to "what permitted this
	 * write". An abstaining guard is deliberately NOT here: it did not pass, and a
	 * row saying it did while `evaluation` records `false` for it is a durable
	 * self-contradiction nobody can later resolve.
	 */
	passed: AnswerGuardName[];
	/**
	 * (GUARD4-ABSTAIN) Guards that did NOT read positively and were carried
	 * anyway, because every load-bearing guard had passed, the screen guard ran in
	 * its strong form, and they are in `ABSTAINING_GUARDS`. Disjoint from `passed`.
	 */
	abstained: AnswerGuardName[];
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
 * (GUARD4-ABSTAIN) The reader for a guard in `ABSTAINING_GUARDS`, which needs
 * the RAW tri-state rather than `readGuardSource`'s collapse to `false`.
 *
 * "Could not read" and "read, and it is clear" are the same outcome for such a
 * guard — neither refuses — but they are not the same DIAGNOSIS, and the abstain
 * event says which one happened. Collapsing them first would throw that away at
 * the only place it is cheap to keep.
 */
async function readAbstainingGuardSource(
	name: AnswerGuardName,
	deps: AnswerDeps,
	read: () => Promise<GuardSourceResult>,
): Promise<GuardSourceResult> {
	try {
		return await read();
	} catch (error) {
		deps.log({
			event: "companion.guard.error",
			guard: name,
			result: null,
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
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
	/** (GUARD4-ABSTAIN) Guards carried on a non-positive reading. */
	const abstained: AnswerGuardName[] = [];
	/**
	 * Every step through the stack is checked against `GUARD_EVALUATION_ORDER`, so
	 * the classification's ordering rule is enforced against what this function
	 * ACTUALLY does rather than against the shape of the source below.
	 *
	 * (GUARD4-ABSTAIN) The position is its OWN counter and no longer
	 * `passed.length`. An abstaining guard advances the stack without joining
	 * `passed` — it did not pass, and `guardsPassed` is the durable audit answer
	 * to "what permitted this write" — so deriving position from that array would
	 * throw the self-check off by one for every guard after it.
	 */
	let position = 0;
	const at = (guard: AnswerGuardName): void => {
		if (GUARD_EVALUATION_ORDER[position] !== guard) {
			throw new Error(
				`(COMPANION-BRIDGE) guard stack self-check: reached ${guard} at position ${position}, where GUARD_EVALUATION_ORDER requires ${String(GUARD_EVALUATION_ORDER[position])}`,
			);
		}
	};
	const advance = (guard: AnswerGuardName): void => {
		at(guard);
		position += 1;
		passed.push(guard);
	};
	/**
	 * (GUARD4-ABSTAIN) Walk past a guard WITHOUT recording it as passed. The two
	 * arrays are disjoint by construction, so a durable row can never say a guard
	 * both permitted the write and read false.
	 */
	const abstain = (guard: AnswerGuardName): void => {
		at(guard);
		position += 1;
		abstained.push(guard);
	};
	const fail = (
		guard: AnswerGuardName,
		screenMatch: PickerScreenMatch | null,
	) => {
		at(guard);
		return {
			evaluation,
			passed,
			abstained,
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

	// --- guard 4: the permission axis is still latched (FORGEABLE, ABSTAINS) ---
	const permissionAxis = await readAbstainingGuardSource(
		"permission_axis",
		deps,
		() => deps.permissionAxisLatched(input.question.terminalId),
	);
	// The RAW reading, never written up to `true`. The ledger's `guards` column is
	// evidence about what was observed, and an abstain must not be able to forge a
	// record of a latch that was not there.
	evaluation.permission_axis = permissionAxis === true;
	if (permissionAxis === true) {
		advance("permission_axis");
	} else {
		// (GUARD4-ABSTAIN) THREE conditions, all checked here rather than inferred
		// from the fact that guard 4 runs fourth:
		//
		//  1. every load-bearing guard actually passed, read back off `evaluation`,
		//     so a reordering makes the axis refuse again rather than quietly
		//     abstain on a stack that has proved less than it claims;
		//  2. this guard is on the abstain list, which `assertGuardClassification`
		//     now holds to its own rules at module load;
		//  3. THE SCREEN GUARD RAN IN ITS STRONG FORM. This is the one that is not
		//     about guard 4 at all. `matchPromptStillOnScreen` — the `same_prompt`
		//     expectation — asserts only that this prompt's text is on screen, and
		//     a Claude Code composer echoing the prompt satisfies it with the
		//     picker GONE. The free-text tail is three consecutive `same_prompt`
		//     keystrokes carrying arbitrary text, so abstaining there would let a
		//     desk Escape mid-sequence turn the remainder into a typed-and-
		//     submitted prompt. On a weak-form keystroke the axis keeps its
		//     refusal: it is the only thing left that notices the picker closed.
		const loadBearingPassed = LOAD_BEARING_GUARDS.every(
			(guard) => evaluation[guard],
		);
		const strongScreenForm = input.expectation.kind === "item_picker";
		if (
			!loadBearingPassed ||
			!ABSTAINING_GUARDS.includes("permission_axis") ||
			!strongScreenForm
		) {
			return fail("permission_axis", screenMatch);
		}
		deps.log({
			event: "companion.guard.abstain",
			guard: "permission_axis",
			guardClass: GUARD_CLASSES.permission_axis,
			// The two readings an abstain covers, kept apart: a latch the next hook
			// event overwrote, versus a store this process could not read at all.
			reading: permissionAxis === null ? "unreadable" : "clear",
			loadBearing: [...LOAD_BEARING_GUARDS],
			expectation: input.expectation.kind,
			questionId: input.question.questionId,
			terminalId: input.question.terminalId,
		});
		abstain("permission_axis");
	}

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

	return { evaluation, passed, abstained, failed: null, screenMatch };
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
	/** (ANSWER-LEDGER) The fence. See where it is thrown for why not `already_resolved`. */
	| "request_closed"
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
// idempotency
// ---------------------------------------------------------------------------
//
// (ANSWER-LEDGER) The ~900-line JSON attempt store that used to live here — its
// `answer-attempts.json`, its rise-only witness, its quarantine and degrade
// paths, its PRUNE-FLOOR and STORE-CLOSED guards — is gone. `attempt-ledger.ts`
// replaced it with a table and a transaction.
//
// It was not deleted for being untidy. It could not close the race it existed to
// describe: a status read can overtake an admitted answer, and deciding between
// them needs an atomic compare-and-set that a read-modify-rewrite of a file
// cannot provide. Every mechanism above was in service of DETECTING that the file
// had rolled back, which was a true and useless thing to know.
//
// Two accepted weaknesses went with it. Its durability rested on an undocumented
// inference about NTFS rename ordering (see `writeFileDurable`); SQLite's is
// documented, and asserted at FULL. And it validated the file as a WHOLE, so one
// incoherent record quarantined every other record's 24 hours — rows validate
// individually now, so a corrupt row costs exactly one requestId its status.
//
// The message path keeps its own small in-memory store below: a message has no
// question and no lease, and it makes no coverage claim, so it needs none of this.

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
 * A failure here is LOGGED, not thrown, and that is a deliberate asymmetry with
 * the CLAIM at the top of `handleAnswer` rather than a swallowed error. The claim
 * must be durable before a byte moves, so it throws. By the time THIS runs the
 * keystrokes have already landed (or, for `guard_failed`, provably have not), so
 * throwing would replace a truthful `confirmed` / `unconfirmed` response with a
 * 500 the client renders as a failure — and §11.5 forbids reporting a landed
 * write as failed far more strongly than it requires this particular update to
 * commit.
 *
 * What makes that safe is that the outcome is not the fence. The claim is. If
 * this update is lost the row stays `in_flight`, and `(LEDGER-REHYDRATE)` turns
 * every `in_flight` row from a previous lifetime into `unconfirmed` at the next
 * open — so the failure degrades a definite answer into "cannot say", never into
 * a wrong one. Within this lifetime the committed row keeps answering status
 * reads directly from the database; there is no in-memory copy to diverge from
 * it, which is what the JSON store this replaced could not promise.
 *
 * There is no shape exemption left to rethrow. `failureCode` is typed
 * `LedgerFailureCode`, the ledger validates each row as it is read, and an
 * outcome with no `in_flight` row to advance is logged AT THE LEDGER as
 * `ledger_outcome_orphaned` instead of being written somewhere it would be
 * mistaken for a state transition.
 */
async function recordOutcome(
	deps: AnswerDeps,
	record: AnswerAttemptRecord,
): Promise<void> {
	try {
		// (ANSWER-LEDGER) Advances the `in_flight` row this request claimed at the
		// top of `handleAnswer`. The ledger's update is predicated on that status, so
		// it can neither erase a tombstone nor revive a pruned row; an outcome with
		// nowhere to land is logged there rather than thrown, because by this point
		// the keystrokes may already have landed and reporting a landed answer as
		// failed is the worse lie.
		//
		// `in_flight` is excluded at the type level and skipped here: the claim
		// already wrote it, and re-writing it would be a no-op that reads like a
		// state transition.
		if (record.status !== "in_flight") {
			deps.ledger.recordOutcome({
				requestId: record.requestId,
				status: record.status,
				resolvedAtMs: record.resolvedAtMs,
				failureCode: record.failureCode,
				guardsPassed: record.guardsPassed,
				leaseId: record.leaseId,
			});
		}
	} catch (error) {
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
	// 1. THE DURABLE CLAIM, AND IT IS FIRST FOR A REASON.
	//
	//    (ANSWER-LEDGER) This used to be a plain read here, with the `in_flight`
	//    record written ~195 lines later, after the guards and the lock. A status
	//    read landing in that window saw nothing, planted no fence, and told the
	//    phone the answer had never been sent — and then this function carried on
	//    and typed it. Claiming first is what makes that impossible: after this
	//    line the requestId is occupied, so a status read can only report
	//    `in_flight`, never a negative.
	//
	//    It also subsumes §11.4 replay. The claim is a compare-and-set, so a repeat
	//    of the SAME requestId does not re-execute — it comes back as `replay` with
	//    the recorded outcome, or as `fenced` if a status read got there first.
	const claim = deps.ledger.claimForAnswer({
		requestId: request.requestId,
		questionId: request.questionId,
		deviceId: ctx.device.deviceId,
		surface: request.surface,
		startedAtMs: deps.now(),
	});

	if (claim.kind === "fenced") {
		// A status read already told a client nothing was received for this
		// requestId. Typing now would make that answer retroactively false, so this
		// is refused permanently rather than deferred. The client is told plainly:
		// the request was closed out, start a new one.
		// `request_closed`, NOT `already_resolved`. The latter means a question was
		// answered — by another device or at the desk — and a client renders it as
		// "already answered", which for a fenced request is false in the one direction
		// that matters: nothing was answered, this request was closed out. The chip
		// would have contradicted the very message explaining what happened. The
		// remedy differs too: `already_resolved` means stop, whereas this means the
		// question may still be open, so submit a NEW request.
		throw sealed(
			409,
			"request_closed",
			"a status read already reported this request as never received, and fenced it; it will never be typed. The question may still be open — submit a new answer.",
			null,
		);
	}

	if (claim.kind === "replay") {
		const previous = claim.record;
		if (previous.status === "failed") {
			// A recorded FAILURE is re-thrown as that failure. Downgrading it to
			// unconfirmed would send the client to §11.5 for an outcome we know.
			throw sealed(
				412,
				(previous.failureCode as SealedCode | null) ?? "guard_failed",
				"this answer attempt already failed; it is never re-executed",
				{ guard: "session" },
			);
		}
		// (ANSWER-INFLIGHT) The sequence for this very requestId is still typing.
		// Reporting `unconfirmed` here — which the client treats as terminal — for a
		// write about to confirm was the original sin this whole area is fixing.
		if (previous.status === "in_flight") {
			throw sealed(
				409,
				"lease_held",
				"this answer is still being typed into the terminal; poll /v1/answer/status",
				{ leaseHolderLabel: null, expiresInMs: null },
			);
		}
		return ledgerRecordToResponse(previous);
	}

	// (LEDGER-REFUSAL) Every refusal from here on records an outcome before it
	// escapes.
	//
	// The claim above is durable, so a refusal that threw straight past it used to
	// leave the row `in_flight` FOREVER — and `in_flight` means "keystrokes are
	// landing right now". Ten paths did exactly that: the panic write-disable, three
	// stale-question checks, already-resolved, the biometric gate, encoding, the
	// agent-binding assertion, the host-terminal lookup, the lease denial and the
	// writer probe. None of them types anything, so the fence was safe — it simply
	// traded the old false "never sent" for a false "still being typed".
	//
	// The lease denial made it routine rather than exotic: two devices answer the
	// same question, the loser is refused, and its §11.4 replay then collected
	// `409 lease_held` — "still being typed" — for 24 h, long after the winner
	// finished, while its status polls said the same thing.
	//
	// So the outcome is recorded with the REAL sealed code, which is why
	// `AttemptFailureCode` was widened past `guard_failed`/`internal`: §11.4 says a
	// replay returns the recorded outcome, and recording `internal` for a
	// `write_disabled` refusal would make that replay lie about why.
	//
	// The guard is `status === "in_flight"`: the in-lock paths already record their
	// own outcomes, so without it this would fire on every ordinary refusal and log
	// an orphaned-outcome warning for a row that was correctly advanced. One extra
	// read, on the failure path only.
	try {
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
		const hasFreeText = request.answers.some(
			(item) => item.kind === "freetext",
		);
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
			// (GUARD4-ABSTAIN) Null until the stack has actually run. The three sites
			// below that HAVE a guard evaluation override it with the real list; the
			// ones that do not are lines written before or instead of the stack, and
			// `[]` there would read as "nothing abstained" rather than "never asked".
			guardsAbstained: null as AnswerGuardName[] | null,
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
				guardsAbstained: null,
				outcome: "attempted",
				failureCode: null,
			});

			// (ANSWER-LEDGER) There is no `in_flight` write here any more, and its absence
			// is the fix rather than an omission.
			//
			// This block used to build an `in_flight` record and durably write it just
			// before taking the lock, with a long comment explaining that the ~15 s of
			// lock-wait-plus-sequence was a window in which the client's recovery read
			// answered "the desktop never saw this request". Writing it HERE only narrowed
			// that window; it could not close it, because everything above this line —
			// preflight, the agent-kind check, the writer probe, the lease — still ran
			// before the record existed.
			//
			// The claim now happens at the very top of `handleAnswer`, as an atomic
			// compare-and-set, so by the time control reaches here the requestId has been
			// occupied for the whole of that work and a status read can only ever report
			// `in_flight`. The unwritable-store branch is gone with it: a claim that cannot
			// be persisted throws out of `claimForAnswer` before any of this runs, which is
			// the same refusal one step earlier and without a record to take back out.

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
					guardsAbstained: result.guardsAbstained,
				};
				await recordOutcome(deps, record);
				await deps.audit.append({
					...baseAudit,
					tsMs: resolvedAtMs,
					guards: result.evaluation,
					guardsAbstained: result.guardsAbstained,
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
					guardsAbstained: result.guardsAbstained,
				};
				await recordOutcome(deps, record);
				await deps.audit.append({
					...baseAudit,
					tsMs: deps.now(),
					guards: result.evaluation,
					guardsAbstained: result.guardsAbstained,
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
				guardsAbstained: result.guardsAbstained,
			};
			await recordOutcome(deps, record);
			await deps.audit.append({
				...baseAudit,
				tsMs: deps.now(),
				guards: result.evaluation,
				guardsAbstained: result.guardsAbstained,
				outcome: "unconfirmed",
				failureCode: null,
			});
			return recordToResponse(record);
		} catch (error) {
			if (error instanceof SealedError) throw error;

			// The lock was never taken, so the critical section never ran and nothing
			// was written. Reported honestly; the client MUST NOT retry a write.
			if (error instanceof TerminalLockTimeoutError) {
				// LEDGER FIRST, AUDIT SECOND, and the order is load-bearing rather than
				// stylistic. `audit.append` does I/O and can throw; when it went first, a
				// failed audit write skipped the ledger advance entirely and left the
				// claim `in_flight` — "keystrokes are landing right now" for a request
				// whose lock was never even taken. `recordOutcome` swallows its own
				// failures, so putting it first cannot cost the audit entry, while the
				// reverse order costs the ledger. The branch below already had this order;
				// this one did not.
				await recordOutcome(deps, {
					...baseAttempt,
					status: "failed",
					resolvedAtMs: null,
					failureCode: "internal",
					guardsPassed: [],
					guardsAbstained: [],
				});
				await deps.audit.append({
					...baseAudit,
					tsMs: deps.now(),
					guards: null,
					guardsAbstained: null,
					outcome: "failed",
					failureCode: "internal",
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
				guardsAbstained: [],
			});
			await deps.audit.append({
				...baseAudit,
				tsMs: deps.now(),
				guards: null,
				guardsAbstained: null,
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
	} catch (error) {
		// A row still `in_flight` here means the throw got past every path that
		// records its own outcome, so this is the last chance to stop it claiming
		// forever that keystrokes are landing.
		//
		// A SealedError is a REFUSAL with a known reason, recorded verbatim so §11.4's
		// replay can say why. Anything else is a fault of unknown extent — it could
		// have escaped after bytes moved — so it degrades to `unconfirmed` rather than
		// to a `failed` that would assert nothing was typed.
		if (deps.ledger.get(request.requestId)?.status === "in_flight") {
			deps.ledger.recordOutcome({
				requestId: request.requestId,
				...(error instanceof SealedError
					? {
							status: "failed" as const,
							failureCode: error.body.code as AttemptFailureCode,
						}
					: { status: "unconfirmed" as const, failureCode: null }),
				resolvedAtMs: null,
				guardsPassed: [],
				leaseId: null,
			});
		}
		throw error;
	}
}

// ---------------------------------------------------------------------------
// the critical section
// ---------------------------------------------------------------------------

type InjectionResult =
	| {
			kind: "confirmed";
			guardsPassed: AnswerGuardName[];
			/** (GUARD4-ABSTAIN) Disjoint from `guardsPassed`; see `GuardOutcome`. */
			guardsAbstained: AnswerGuardName[];
			evaluation: GuardEvaluation;
	  }
	| {
			kind: "guard_failed";
			guard: AnswerGuardName;
			guardsPassed: AnswerGuardName[];
			guardsAbstained: AnswerGuardName[];
			evaluation: GuardEvaluation;
	  }
	| {
			kind: "unconfirmed";
			reason: string;
			abortedAt: number;
			written: number;
			guardsPassed: AnswerGuardName[];
			guardsAbstained: AnswerGuardName[];
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
	/** (GUARD4-ABSTAIN) Carried beside `guardsPassed`, never merged into it. */
	let guardsAbstained: AnswerGuardName[] = [];
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
					guardsAbstained,
					evaluation,
				}
			: {
					kind: "unconfirmed",
					reason,
					abortedAt: index,
					written,
					guardsPassed,
					guardsAbstained,
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
		guardsAbstained = outcome.abstained;
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
				guardsAbstained,
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

	return {
		kind: "confirmed",
		guardsPassed,
		guardsAbstained,
		evaluation,
	};
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
 * (COVERAGE-CONTRACT) What this endpoint returns is specified ONCE, on
 * `AnswerStatusResponse` in `types.ts`, and for the wire in `PROTOCOL.md` §11.5.
 * Read them there rather than trusting a paraphrase here: this explanation used to
 * be restated in four places and five copies of one sentence went stale in a
 * single commit — which is also why this paragraph no longer lists the fields. It
 * used to name the three proof instants in the present tense, and they were gone.
 *
 * The only two facts local to THIS function, which is all it needs to state:
 *   - a record that EXISTS is returned with its own status, unconditionally.
 *     Coverage plays no part in that branch and never did.
 *   - the verdict is computed by the ledger, behind the fence, and returned whole.
 *     Nothing here re-derives it, so there is no second copy of the rule to drift.
 */
export async function handleAnswerStatus(
	deps: AnswerDeps,
	_ctx: SealedRequestContext,
	request: AnswerStatusRequest,
): Promise<AnswerStatusResponse> {
	// (ANSWER-LEDGER) The verdict is computed where the state is, behind a durable
	// fence, and returned whole. This function used to publish three instants and
	// let the client prove "never sent" by arithmetic — which could not be correct,
	// because a status read can overtake an admitted answer that has not yet
	// recorded itself, and no reasoning about the past licenses a claim about
	// whether something is about to be typed. `resolveStatus` plants the fence in
	// the same transaction as the negative, so the answer path is bound by it.
	const resolved = deps.ledger.resolveStatus(
		request.requestId,
		request.coverageEpoch,
	);
	return {
		requestId: request.requestId,
		outcome: toWireOutcome(resolved),
		// The epoch in force now, so a client whose token went stale can adopt the
		// current one without a second round trip.
		coverageEpoch: deps.ledger.currentEpoch(),
	};
}

/**
 * Maps the ledger's verdict onto the wire's.
 *
 * The one non-obvious case is the tombstone. It IS a row, so the ledger reports it
 * as `known` — but it is not a STATUS a client renders, it is the negative itself,
 * and it already has its own wire kind. Collapsing it here keeps `known` to the
 * four statuses §11.5 defines and stops `closed_not_received` leaking onto the wire
 * as a fifth one the client would have to learn.
 */
function toWireOutcome(resolved: StatusOutcome): AnswerStatusOutcome {
	if (resolved.kind === "not_received") {
		return { kind: "not_received" };
	}
	if (resolved.kind === "unconfirmed") {
		return { kind: "unconfirmed", why: resolved.why };
	}
	if (resolved.record.status === "closed_not_received") {
		return { kind: "not_received" };
	}
	return {
		kind: "known",
		status: resolved.record.status,
		questionId: resolved.record.questionId as QuestionId | null,
		resolvedAtMs: resolved.record.resolvedAtMs,
		failureCode: resolved.record.failureCode,
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
			guardsAbstained: null,
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

/**
 * (ANSWER-LEDGER) The §11.4 replay response, from a ledger row.
 *
 * `leaseId` can legitimately be null here: the claim is made before the lease is
 * acquired, so a row whose attempt died between the two has no lease to report.
 * The wire field is non-null, so an empty string would be a lie — an absent lease
 * is reported as absent and the client shows the outcome, which is what it is
 * actually asking about.
 */
function ledgerRecordToResponse(record: LedgerRecord): AnswerResponse {
	return {
		status: record.status === "confirmed" ? "confirmed" : "unconfirmed",
		requestId: record.requestId,
		questionId: (record.questionId ?? "") as QuestionId,
		leaseId: (record.leaseId ?? "") as AnswerResponse["leaseId"],
		resolvedAtMs: record.status === "confirmed" ? record.resolvedAtMs : null,
		guardsPassed: record.guardsPassed,
		// (GUARD4-ABSTAIN) A REPLAY cannot report this: the ledger stores only
		// `guardsPassed`, deliberately (a new column would need a migration, and the
		// fact is recoverable — a row that reached an outcome with a guard in
		// `ABSTAINING_GUARDS` missing from `guardsPassed` is a row that abstained).
		// Empty is the honest shape for "this response is reconstructed from durable
		// state", not a claim that nothing abstained.
		guardsAbstained: [],
	};
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
		guardsAbstained: record.guardsAbstained,
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
