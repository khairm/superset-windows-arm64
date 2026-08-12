/**
 * (COMPANION-BRIDGE) — answer injection and idempotency (§11).
 *
 * (ANSWER-GUARDLESS) A pending, captured Claude question is directly answerable
 * from a paired phone or watch. After the request boundary validates question
 * identity and answer shape, `encodeAnswer` produces the proven byte sequence and
 * `injectSequence` writes it to the captured terminal under the per-terminal lock.
 * No transcript, screen, renderer, Windows interactive-session, agent-binding,
 * permission-latch or marker observation may veto or downgrade that write.
 *
 * The lock, answer-wide lease and durable request ledger remain: they prevent two
 * devices from interleaving bytes and make retries idempotent. Each PTY write is
 * counted only after the daemon acknowledges `pty.write`, and the response is
 * confirmed only after the ledger outcome is written and read back. An actual PTY
 * failure prevents confirmation; a ledger failure after landed bytes returns an
 * honest, duplicate-fenced `unconfirmed` outcome.
 *
 * Answer attempts record empty guard arrays and `null` evaluation solely for
 * persisted audit-schema compatibility.
 */

import type { AcknowledgedInputFailureKind } from "../terminal/DaemonClient";
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
	type RawWriteResult,
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
	type AuditEntry,
	type DurationMs,
	type EpochMs,
	type MessageRequest,
	type MessageResponse,
	type QuestionId,
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
 * A paste of up to 8 192 chars can require a substantial repaint. The wait is
 * bounded because the
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
 * the CLIENT's own text, so it is attacker-parameterisable. Measured against the
 * real `handleMessage` path with an inert paste (the picker case): the text
 * "yes" matched a picker's own option label "Yes, proceed…" and the text "1"
 * matched the picker's own row number — both returned `sent` and wrote the
 * trailing `\r` into an open picker.
 *
 * Same value and same reasoning as `SCREEN_MIN_ANCHOR_CHARS`, which fixes the
 * identical class on the retired-prompt check, kept as its own name because the
 * two paths are free to diverge.
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
// dependencies
// ---------------------------------------------------------------------------

/**
 * What a `/v1/message` observation reports. `null` means "could not determine";
 * every caller treats it as a refusal, never as a pass.
 */
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
 *    requires the acknowledged raw-writer runtime marker. Bracketed paste is
 *    INERT against the picker, while fire-and-forget input cannot report daemon
 *    refusal, so either wrong writer fails at bridge startup;
 *  - `writeFramed` is async and takes `{text, submit}`, and is used ONLY by
 *    `handleMessage`, which never touches a picker.
 */
export interface AnswerDeps {
	/**
	 * Raw, unframed, ACKNOWLEDGED pty write. MUST be the composition-root adapter
	 * around `writeAcknowledgedInputToSession` from `../terminal/terminal`; its
	 * `prepare` method is bound to host.db in THIS process so a detached session is
	 * adopted headlessly before the answer lease and final identity check. The
	 * runtime marker prevents wiring paste framing or fire-and-forget input.
	 */
	writeInput: RawWriteFn;
	/**
	 * Best-effort repaint after an acknowledged answer. This asks the running TUI
	 * to redraw from its own state; it is never an answer precondition or outcome
	 * check, and failure may only be logged.
	 */
	nudgeRepaint(input: HostTerminalRef): { success: true } | { error: string };
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
	 * The terminal's VISIBLE VIEWPORT as plain text. The `/v1/message` picker
	 * check's only source.
	 *
	 * Viewport, not buffer: Claude Code renders inline in the normal buffer, so a
	 * whole-buffer snapshot carries up to 1 000 lines of scrollback containing
	 * every earlier picker render, and the check would confirm against one of
	 * those.
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

	/** Current agent binding, used only by `/v1/message`. */
	agentBinding(terminalId: TerminalId): Promise<TerminalAgentInfo | null>;

	/** Whether the pty session is alive, used only by `/v1/message`. */
	sessionActive(terminalId: TerminalId): Promise<GuardSourceResult>;

	/** Current permission-axis latch, used only to keep `/v1/message` off pickers. */
	permissionAxisLatched(terminalId: TerminalId): Promise<GuardSourceResult>;

	/** Structured diagnostics. Never carries question or answer text. */
	log(event: Record<string, unknown>): void;
}

/**
 * One probe per distinct writer function, not one per request.
 *
 * The composition root SHOULD call `assertAnswerDeps` at bridge start so the
 * acknowledged-writer marker is checked before the first answer of the day.
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
	if (typeof deps.nudgeRepaint !== "function") {
		throw new Error(
			"(COMPANION-BRIDGE) answer deps: nudgeRepaint must be wired for post-answer redraw",
		);
	}
	if (typeof deps.writeFramed !== "function") {
		throw new Error(
			"(COMPANION-BRIDGE) answer deps: writeFramed must be writeFramedInputToSession — /v1/message needs paste framing",
		);
	}
	if (typeof deps.snapshotScreen !== "function") {
		throw new Error(
			"(COMPANION-BRIDGE) answer deps: snapshotScreen is required for /v1/message picker checks",
		);
	}
}

// ---------------------------------------------------------------------------
// message-path screen helpers
// ---------------------------------------------------------------------------

/** Squashed characters used to identify the item's header. */
const SCREEN_HEADER_ANCHOR_CHARS = 12;

/** Squashed characters used when an item has no usable header. */
const SCREEN_QUESTION_ANCHOR_CHARS = 24;

/** Minimum prompt anchor length accepted as evidence by `/v1/message`. */
const SCREEN_MIN_ANCHOR_CHARS = 8;

type PromptMatchReason =
	| "match"
	| "empty_screen"
	| "anchor_absent"
	| "anchor_too_weak";

interface PromptScreenMatch {
	ok: boolean;
	reason: PromptMatchReason;
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
	// itself). Stopping a line early leaves the final line unable to START a
	// window, which is invisible to an unanchored substring search — the row can
	// still be found inside the previous line's window — but is a silent refusal
	// for any caller that requires a match to begin its window. A picker whose
	// last option is the last line of the viewport is ordinary, not suspicious.
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

function anchorOf(text: string, maxChars: number): string {
	return squash(text).slice(0, maxChars);
}

/**
 * Prompt anchor used only to refuse `/v1/message` when a recently retired
 * question may still be rendered. Short anchors are inconclusive.
 */
function promptAnchor(item: QuestionItem): string {
	const header = anchorOf(item.header, SCREEN_HEADER_ANCHOR_CHARS);
	if (header.length >= SCREEN_MIN_ANCHOR_CHARS) return header;
	const question = anchorOf(item.question, SCREEN_QUESTION_ANCHOR_CHARS);
	if (question.length >= SCREEN_MIN_ANCHOR_CHARS) return question;
	return "";
}

/**
 * Checks whether a recently retired question's prompt remains visible. Used only
 * by `/v1/message` in the refusing direction; option rows are irrelevant.
 */
function matchPromptOnScreen(input: {
	screen: string;
	item: QuestionItem;
}): PromptScreenMatch {
	const windows = squashedWindows(input.screen);
	if (windows.every((window) => window.length === 0)) {
		return { ok: false, reason: "empty_screen" };
	}

	const anchor = promptAnchor(input.item);
	if (anchor.length === 0) {
		return { ok: false, reason: "anchor_too_weak" };
	}
	if (!anyWindowIncludes(windows, anchor)) {
		return { ok: false, reason: "anchor_absent" };
	}
	return { ok: true, reason: "match" };
}

/**
 * (PICKER-CHROME) Does the viewport show the STRUCTURE of a picker — a run of
 * numbered rows in ascending digit order starting at 1?
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
 * Advances the durable claim and reads it back from the DB before reporting
 * success. A PTY acknowledgement proves where the bytes went; only this readback
 * proves the outcome survived. Callers downgrade landed bytes to `unconfirmed`
 * when this returns false, while the original `in_flight` claim remains a fence.
 */
async function recordOutcome(
	deps: AnswerDeps,
	record: AnswerAttemptRecord,
): Promise<boolean> {
	try {
		if (record.status === "in_flight") return true;
		deps.ledger.recordOutcome({
			requestId: record.requestId,
			status: record.status,
			resolvedAtMs: record.resolvedAtMs,
			failureCode: record.failureCode,
			guardsPassed: record.guardsPassed,
			leaseId: record.leaseId,
		});
		const durable = deps.ledger.get(record.requestId);
		if (durable?.status !== record.status) {
			throw new Error(
				`ledger outcome verification read ${durable?.status ?? "missing"}, expected ${record.status}`,
			);
		}
		return true;
	} catch (error) {
		deps.log({
			event: "companion.answer.attempt_persist_failed",
			requestId: record.requestId,
			questionId: record.questionId,
			status: record.status,
			error: error instanceof Error ? error.message : String(error),
		});
		return false;
	}
}

async function appendAnswerAudit(
	deps: AnswerDeps,
	entry: AuditEntry,
): Promise<void> {
	try {
		await deps.audit.append(entry);
	} catch (error) {
		deps.log({
			event: "companion.answer.audit_persist_failed",
			requestId: entry.requestId,
			questionId: entry.questionId,
			terminalId: entry.terminalId,
			outcome: entry.outcome,
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
 * Deliberately returns nothing. This helper belongs only to `/v1/message`;
 * `(ANSWER-GUARDLESS)` never re-reads mutable agent-binding state.
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
 * `/v1/message` resolves the requested opaque wire handle to a live
 * `(terminal, workspace)` pair. Both ids come back together — see
 * `AnswerDeps.resolveHostTerminal` for why resolving them separately once made
 * every message fail as `Terminal session not found`.
 */
async function requireHostTerminal(
	deps: AnswerDeps,
	terminalId: TerminalId,
): Promise<HostTerminalRef> {
	const host = await deps.resolveHostTerminal(terminalId);
	if (host === null) {
		throw sealed(
			503,
			"internal",
			"the requested terminal is unavailable; no message bytes were written",
		);
	}
	return host;
}

function requirePendingAnswerQuestion(
	deps: AnswerDeps,
	request: Pick<AnswerRequest, "questionId" | "fingerprint">,
): PendingQuestion {
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
		throw sealed(
			410,
			"stale_question",
			"fingerprint no longer matches; the question moved on",
		);
	}
	return question;
}

function requireCurrentPendingAnswerQuestion(
	deps: AnswerDeps,
	request: Pick<AnswerRequest, "questionId" | "fingerprint">,
): PendingQuestion {
	const question = requirePendingAnswerQuestion(deps, request);
	if (
		deps.questions.byHostTerminal(question.hostTerminalId)?.questionId !==
		question.questionId
	) {
		throw sealed(
			410,
			"stale_question",
			"the captured question changed before the terminal write; nothing was written",
		);
	}
	return question;
}

/**
 * The whole write.
 *
 * Refusals are cheap and happen before anything is acquired; the lease and the
 * terminal lock are taken in that order, and the lease is released on every exit
 * path. Audit appends are attempted around the write but can never veto input or
 * replace its outcome.
 */
export async function handleAnswer(
	deps: AnswerDeps,
	ctx: SealedRequestContext,
	request: AnswerRequest,
): Promise<AnswerResponse> {
	// Intake, before the ledger claim and every refusal: a refused or fenced
	// answer must show an arrival line next to its refusal, not silence. Item
	// KINDS only — free-text bodies never reach a log.
	deps.log({
		event: "companion.answer.intake",
		requestId: request.requestId,
		questionId: request.questionId,
		deviceId: ctx.device.deviceId,
		surface: request.surface,
		itemKinds: request.answers.map((item) => item.kind),
	});
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
			// The request-id fence stays closed, but legacy guard failures never
			// re-surface as a guard refusal. A fresh request may answer the still-open
			// question through the guardless path.
			throw sealed(
				409,
				"request_closed",
				"this request id already failed and is never re-executed; submit a new answer request",
			);
		}
		// (ANSWER-INFLIGHT) The sequence for this very requestId is still typing.
		// Reporting `unconfirmed` here — which the client treats as terminal — for a
		// write about to confirm was the original sin this whole area is fixing.
		if (previous.status === "claimed" || previous.status === "in_flight") {
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
		const question = requirePendingAnswerQuestion(deps, request);

		// 7. (ANSWER-GUARDLESS) Installed clients may still send the legacy
		//    `confirmedBiometric` claim, but it is optional and ignored. Explicit
		//    submit from the paired, authenticated device is the authorization.

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

		// 9. (ANSWER-GUARDLESS) The captured question already owns the terminal
		//    target, and the capture already resolved and stored the host.db
		//    terminal/workspace pair. Do not re-check the mutable hook-fed agent
		//    binding, and do not route the pair back through the read-side liveness
		//    filter: a daemon snapshot may be stale while the PTY write succeeds.
		const host: HostTerminalRef = {
			hostTerminalId: question.hostTerminalId,
			hostWorkspaceId: question.hostWorkspaceId,
		};

		// The branded writer. Minted (and probed) here rather than inside the lock, so
		// a mis-wired writer fails before a lease or a lock is taken. Headless adoption
		// also completes here: no host.db/daemon/replay I/O may sit between the final
		// current-question check and the first input frame.
		const writer = rawWriterFor(deps);
		let prepared: Awaited<ReturnType<RawPtyWriter["prepare"]>>;
		try {
			prepared = await writer.prepare({
				terminalId: host.hostTerminalId,
				workspaceId: host.hostWorkspaceId,
			});
		} catch (error) {
			deps.log({
				event: "companion.answer.prepare_failed",
				questionId: request.questionId,
				terminalId: question.terminalId,
				error: error instanceof Error ? error.message : String(error),
			});
			throw sealed(
				503,
				"internal",
				"the terminal could not be prepared; nothing was written — submit a new request to retry",
			);
		}
		if ("error" in prepared) {
			deps.log({
				event: "companion.answer.prepare_refused",
				questionId: request.questionId,
				terminalId: question.terminalId,
				error: prepared.error,
			});
			throw sealed(
				503,
				"internal",
				`the terminal could not be prepared; nothing was written — submit a new request to retry (${prepared.error})`,
			);
		}

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
			// (ANSWER-GUARDLESS) No guard stack runs, so no audit line can claim a
			// guard evaluation. The default is `null` — "never asked" — and the sites
			// that write `[]` do so because the record type they feed cannot express
			// the difference. `[]` is never a claim that a guard abstained.
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
			await appendAnswerAudit(deps, {
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
				() => {
					// The preflight happened before audit I/O and lock acquisition. Re-check
					// the store at the last synchronous point before the first PTY write so a
					// desk answer or superseding capture cannot turn this answer into composer
					// text or an answer to the replacement picker. This is question identity,
					// not screen/transcript/session evidence.
					requireCurrentPendingAnswerQuestion(deps, request);
					let durableFence: LedgerRecord | null;
					try {
						durableFence = deps.ledger.beginWrite(
							request.requestId,
							lease.leaseId,
						);
					} catch (error) {
						deps.log({
							event: "companion.answer.begin_write_failed",
							requestId: request.requestId,
							questionId: request.questionId,
							error: error instanceof Error ? error.message : String(error),
						});
						throw sealed(
							503,
							"internal",
							"the durable write fence could not be established; nothing was written — submit a new request to retry",
						);
					}
					if (durableFence !== null) {
						throw sealed(
							409,
							"already_resolved",
							durableFence.status === "confirmed"
								? "an answer for this question was already delivered; it will not be typed again"
								: "an answer for this question may already have been delivered; it will not be typed again",
							{
								resolvedBy: null,
								resolvedAtMs: durableFence.resolvedAtMs,
								outcome:
									durableFence.status === "confirmed" ? "answered" : "unknown",
							},
						);
					}
					return injectSequence(deps, {
						question,
						host,
						keystrokes,
						leaseId: lease.leaseId,
						acknowledgedInputSupported: prepared.acknowledgedInputSupported,
						writer,
					});
				},
			);

			if (result.kind === "confirmed") {
				const resolvedAtMs = deps.now();
				const record: AnswerAttemptRecord = {
					...baseAttempt,
					status: "confirmed",
					resolvedAtMs,
					failureCode: null,
					guardsPassed: [],
					guardsAbstained: [],
				};
				if (!(await recordOutcome(deps, record))) {
					const unconfirmed: AnswerAttemptRecord = {
						...record,
						status: "unconfirmed",
						resolvedAtMs: null,
					};
					deps.log({
						event: "companion.answer.confirmed_downgraded_not_durable",
						questionId: request.questionId,
						terminalId: question.terminalId,
						requestId: request.requestId,
					});
					// A transient first failure may still allow this downgrade to commit. If
					// it does not, the original durable in-flight claim remains the fence.
					await recordOutcome(deps, unconfirmed);
					await appendAnswerAudit(deps, {
						...baseAudit,
						tsMs: resolvedAtMs,
						guards: null,
						guardsAbstained: [],
						outcome: "unconfirmed",
						failureCode: null,
					});
					return recordToResponse(unconfirmed);
				}
				// Only after the durable confirmed row exists may positive PostToolUse or
				// transcript settlement inherit this device provenance. Neither this mark
				// nor the repaint below changes the confirmed wire outcome.
				deps.questions.markRemoteAnswered(
					request.questionId,
					{
						deviceLabel: ctx.device.label,
						surface: request.surface,
					},
					resolvedAtMs,
				);
				const repaint = deps.nudgeRepaint(host);
				if ("error" in repaint) {
					deps.log({
						event: "companion.answer.repaint_failed",
						questionId: request.questionId,
						terminalId: question.terminalId,
						error: repaint.error,
					});
				}
				await appendAnswerAudit(deps, {
					...baseAudit,
					tsMs: resolvedAtMs,
					guards: null,
					guardsAbstained: [],
					outcome: "confirmed",
					failureCode: null,
				});
				return recordToResponse(record);
			}

			if (result.written === 0 && result.writeOutcome === "not_written") {
				deps.log({
					event: "companion.answer.write_failed_before_input",
					questionId: request.questionId,
					terminalId: question.terminalId,
					leaseId: lease.leaseId,
					reason: result.reason,
				});
				const record: AnswerAttemptRecord = {
					...baseAttempt,
					status: "failed",
					resolvedAtMs: null,
					failureCode: "internal",
					guardsPassed: [],
					guardsAbstained: [],
				};
				await recordOutcome(deps, record);
				await appendAnswerAudit(deps, {
					...baseAudit,
					tsMs: deps.now(),
					guards: null,
					guardsAbstained: [],
					outcome: "failed",
					failureCode: "internal",
				});
				throw sealed(
					503,
					"internal",
					"the terminal accepted no answer input; nothing was written — submit a new request to retry",
				);
			}

			deps.questions.markStale(
				request.questionId,
				result.writeOutcome === "unknown"
					? `write outcome unknown after ${result.written}/${keystrokes.length} acknowledged keystrokes: ${result.reason}`
					: `partial write: ${result.written}/${keystrokes.length} keystrokes landed, then ${result.reason}`,
			);
			deps.log({
				event: "companion.answer.unconfirmed",
				questionId: request.questionId,
				terminalId: question.terminalId,
				leaseId: lease.leaseId,
				keystrokesWritten: result.written,
				keystrokesTotal: keystrokes.length,
				abortedAt: result.abortedAt,
				writeOutcome: result.writeOutcome,
				reason: result.reason,
			});
			const record: AnswerAttemptRecord = {
				...baseAttempt,
				status: "unconfirmed",
				resolvedAtMs: null,
				failureCode: null,
				guardsPassed: [],
				guardsAbstained: [],
			};
			await recordOutcome(deps, record);
			await appendAnswerAudit(deps, {
				...baseAudit,
				tsMs: deps.now(),
				guards: null,
				guardsAbstained: [],
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
				await appendAnswerAudit(deps, {
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
			await appendAnswerAudit(deps, {
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
		const durableStatus = deps.ledger.get(request.requestId)?.status;
		if (durableStatus === "claimed" || durableStatus === "in_flight") {
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
	| { kind: "confirmed" }
	| {
			kind: "unconfirmed";
			reason: string;
			abortedAt: number;
			written: number;
			writeOutcome: AcknowledgedInputFailureKind;
	  };

/**
 * (ANSWER-GUARDLESS) Runs the proven byte sequence inside the per-terminal lock.
 *
 * The captured question identity and submitted answer are validated before this
 * function runs. Once that boundary has produced a byte sequence, no transcript,
 * screen snapshot, desktop session, agent binding, permission latch or marker may
 * veto it. In particular, this path does not depend on the renderer, the physical
 * display, or the Windows interactive login session, so display-off and locked
 * desktops behave exactly like an unlocked desktop.
 *
 * PTY input is an ordered byte stream. We therefore write the already-encoded
 * sequence in order and confirm immediately after the daemon acknowledges every
 * `pty.write`. The old mirror-advance wait could downgrade a successful write to
 * `unconfirmed` merely because the renderer had not repainted; that is explicitly
 * not an outcome check.
 */
export async function injectSequence(
	deps: AnswerDeps,
	input: {
		question: PendingQuestion;
		host: HostTerminalRef;
		keystrokes: readonly Keystroke[];
		leaseId: string;
		acknowledgedInputSupported: boolean;
		writer: RawPtyWriter;
	},
): Promise<InjectionResult> {
	const {
		question,
		host,
		keystrokes,
		leaseId,
		acknowledgedInputSupported,
		writer,
	} = input;
	const deadlineMs = deps.now() + SEQUENCE_DEADLINE_MS;
	let written = 0;

	const abort = (
		reason: string,
		index: number,
		writeOutcome: AcknowledgedInputFailureKind,
	): InjectionResult => ({
		kind: "unconfirmed",
		reason,
		abortedAt: index,
		written,
		writeOutcome,
	});

	const frames = acknowledgedInputSupported
		? keystrokes.map((keystroke, index) => ({
				data: keystroke.data,
				acknowledgedKeystrokes: 1,
				abortAt: index,
			}))
		: keystrokes.length === 0
			? []
			: [
					{
						data: keystrokes.map((keystroke) => keystroke.data).join(""),
						acknowledgedKeystrokes: keystrokes.length,
						abortAt: keystrokes.length,
					},
				];
	if (frames.length === 0) {
		return abort("missing keystroke sequence", 0, "not_written");
	}

	for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
		const frame = frames[frameIndex];
		if (frame === undefined) {
			return abort("missing input frame", frameIndex, "not_written");
		}
		if (deps.now() >= deadlineMs) {
			return abort("sequence deadline exceeded", frame.abortAt, "not_written");
		}

		const extension = deps.leases.extend(leaseId, deps.now());
		if (!extension.ok) {
			deps.log({
				event: "companion.answer.lease_lost",
				questionId: question.questionId,
				leaseId,
				reason: extension.reason,
				frameIndex,
			});
			return abort(`lease ${extension.reason}`, frame.abortAt, "not_written");
		}

		let result: RawWriteResult;
		try {
			result = await writer.write({
				terminalId: host.hostTerminalId,
				workspaceId: host.hostWorkspaceId,
				data: frame.data,
			});
		} catch (error) {
			deps.log({
				event: "companion.answer.write_threw",
				questionId: question.questionId,
				terminalId: question.terminalId,
				frameIndex,
				error: error instanceof Error ? error.message : String(error),
			});
			return abort("pty write threw", frame.abortAt, "unknown");
		}

		if ("error" in result) {
			deps.log({
				event: "companion.answer.write_refused",
				questionId: question.questionId,
				terminalId: question.terminalId,
				frameIndex,
				written,
				writeOutcome: result.writeOutcome,
				error: result.error,
			});
			return abort(
				`pty write refused: ${result.error}`,
				frame.abortAt,
				result.writeOutcome,
			);
		}

		written += frame.acknowledgedKeystrokes;
	}

	return { kind: "confirmed" };
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
	if (resolved.record.status === "claimed") {
		return {
			kind: "known",
			status: "in_flight",
			questionId: resolved.record.questionId as QuestionId | null,
			resolvedAtMs: null,
			failureCode: null,
		};
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
 * THE NEEDLE IS CLIENT-CHOSEN, so on its own it is parameterisable, and it
 * needed two remedies:
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
 * The permission axis, read so that "could not read" stays `null`.
 *
 * A collapse of `null` into `false` would be exactly backwards here: `false`
 * means "no picker", so an unreadable source would become a PERMISSION to write
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
 * The `/v1/message` picker check, run inside the terminal lock.
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
	// `readPermissionAxis` keeps `null` distinct from `false`.
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
		const match = matchPromptOnScreen({ screen, item });
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
 * (ANSWER-GUARDLESS) Durable answer rows do not carry a guard evaluation.
 * Confirmed rows therefore replay the same honest empty abstain list returned by
 * the original request; non-confirmed legacy rows retain `null` because their
 * historical evidence cannot be reconstructed from the ledger.
 */
function replayedGuardsAbstained(
	record: LedgerRecord,
): AnswerGuardName[] | null {
	return record.status === "confirmed" ? [] : null;
}

/**
 * (ANSWER-LEDGER) The §11.4 replay response, from a ledger row.
 *
 * `leaseId` can legitimately be null here: the claim is made before the lease is
 * acquired, so a row whose attempt died between the two has no lease to report.
 * The wire field is non-null, so an empty string would be a lie — an absent lease
 * is reported as absent and the client shows the outcome, which is what it is
 * actually asking about.
 *
 * Exported for the replay contract test: it is a pure record-to-response mapper,
 * and the derivation above is the part worth pinning.
 */
export function ledgerRecordToResponse(record: LedgerRecord): AnswerResponse {
	return {
		status: record.status === "confirmed" ? "confirmed" : "unconfirmed",
		requestId: record.requestId,
		questionId: (record.questionId ?? "") as QuestionId,
		leaseId: (record.leaseId ?? "") as AnswerResponse["leaseId"],
		resolvedAtMs: record.status === "confirmed" ? record.resolvedAtMs : null,
		guardsPassed: record.guardsPassed,
		guardsAbstained: replayedGuardsAbstained(record),
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
