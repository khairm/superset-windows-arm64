/**
 * (COMPANION-BRIDGE) — the keystroke encoder. The ONLY place in the system that
 * turns intent into bytes for a terminal.
 *
 * The client sends SEMANTIC INTENT ONLY (questionId, fingerprint, chosen option
 * indices). There is no field anywhere in the wire contract through which a
 * client can express "send these bytes to that terminal" (PROTOCOL §11.1), so a
 * compromised or buggy client is STRUCTURALLY incapable of emitting a stray
 * digit. All byte encoding lives here.
 *
 * ---------------------------------------------------------------------------
 * THE PROVEN BYTE CONTRACT
 * ---------------------------------------------------------------------------
 * Established empirically by driving a real Claude Code 2.1.220 AskUserQuestion
 * picker in a pty. It is a PRIVATE contract with a TUI that auto-updates: when
 * Claude Code changes, only this file changes, and re-proving it against a live
 * picker on every Claude Code upgrade is this module's standing obligation
 * (see `PROVEN_AGAINST`).
 *
 *   single-select, ONE question
 *     ONE bare digit both SELECTS AND SUBMITS. No Enter. No confirmation step.
 *     The act is atomic and there is no undo.
 *
 *   single-select, N > 1 questions in one call
 *     N digits, one per question, then `\r` on the review screen.
 *
 *   multiSelect  — INVERTS EVERY RULE ABOVE
 *     digits and space TOGGLE a row. `Enter` TOGGLES TOO and does NOT submit.
 *     Submitting is right-arrow (`\x1b[C`) onto the Submit tab, THEN `\r`.
 *     => appending Enter "to submit" a multi-select silently FLIPS a selection
 *        and still does not submit. That shape is rejected here by construction:
 *        `encodeAnswer` never emits SUBMIT_RETURN for a multi-select without a
 *        preceding SUBMIT_TAB, and `assertMultiSelectSubmitShape` re-checks the
 *        emitted sequence before it is handed to the injector.
 *
 *   free text
 *     digit N+1 (the slot after the last real option) opens an inline editor,
 *     then the UTF-8 text, then `\r`.
 *
 *   bracketed paste is INERT against the picker
 *     `terminal.send` / `writeFramedInputToSession` CANNOT drive it. Only raw
 *     `writeInputToSession` works. `createRawPtyWriter` below makes wiring the
 *     wrong one a loud startup failure rather than a silent no-op.
 *
 * ---------------------------------------------------------------------------
 * WHY EVERY REFUSAL HERE IS DELIBERATE
 * ---------------------------------------------------------------------------
 * Stale bytes are dangerous and unrecoverable. With the picker gone a digit
 * lands in the composer and a following Enter submits it as a real prompt;
 * mid-turn it queues and steers the running agent; against a DIFFERENT picker it
 * commits instantly. So: any shape whose byte sequence was not PROVEN is refused
 * outright (`shape_unproven`) rather than guessed at. A refusal costs the user
 * one walk to the desk. A guess costs them an irreversible wrong answer.
 */

import type { AnswerItem, QuestionItem } from "./types";

/**
 * The Claude Code build the contract above was proven against. A canary test
 * per Claude Code upgrade is this module's obligation (PROTOCOL §11.1); this
 * constant is what that test reports against.
 *
 * (PROVEN-VERSION-DRIFT) `proven-version.ts` compares this against the CLI that
 * is actually installed and reports a mismatch on the bridge's status surface. It
 * does NOT refuse anything: drift is a prompt to re-prove the contract, and a
 * bridge that refused every answer the day after a Claude Code auto-update would
 * be a worse failure than the drift it was warning about.
 *
 * DO NOT advance this constant on the strength of reading the CLI's source. The
 * BYTES — that one bare digit still selects and submits, that digit N+1 opens the
 * editor, that `\r` submits it — are behaviour, and only a live pty shows
 * behaviour. `RENDER_OBSERVED_AGAINST` below is the weaker claim that source
 * reading does support, kept separate on purpose so nothing can quietly upgrade
 * one into the other.
 */
export const PROVEN_AGAINST = "claude-code@2.1.220";

/**
 * The build whose RENDERED SHAPE has been read directly out of the installed
 * binary: the free-text labels below, and the row order
 * `[...options, freeText, chat?]` (the chat row context-gated and suppressed for
 * multi-select, carrying the sentinel `"__chat__"`).
 *
 * Strictly weaker than `PROVEN_AGAINST` and never a substitute for it. It exists
 * so the copy constants can cite what they are true of without implying the byte
 * contract was re-driven.
 */
export const RENDER_OBSERVED_AGAINST = "claude-code@2.1.226";

/**
 * (GUARD5-FREETEXT-COPY) The free-text row's label AS THE PICKER RENDERS IT.
 *
 * This module owns it because it is the same KIND of fact as the byte contract
 * above — an observation about a specific Claude Code build that has to be
 * re-proven when that build changes — and because two consumers must never
 * disagree about it: `question-store.deriveFreeTextOption` puts it on the item,
 * and `answer.matchPickerScreen` looks for it on screen.
 *
 * Read out of the installed binary rather than guessed off a screenshot:
 *
 *     const psh = mL.multiSelect ? "Type something" : "Type something."
 *
 * The trailing full stop on the single-select variant is real and load-bearing;
 * a matcher pinned to the wrong one refuses every free-text answer, which is
 * exactly what the previous value ("Other" — the copy from an older build) did.
 *
 * `multiSelect` is carried for completeness and is unreachable today, because
 * `deriveFreeTextOption` returns `null` for a multi-select item: that shape's
 * free-text behaviour has never been proven in a pty and is refused rather than
 * guessed. The inline editor's own placeholder ("Type something…", with U+2026)
 * is deliberately NOT here — it renders after the row has been pressed, so it is
 * never evidence that the row is there to press.
 */
export const PROVEN_FREE_TEXT_LABELS = {
	singleSelect: "Type something.",
	multiSelect: "Type something",
} as const;

/** The one variant the bridge can currently drive. */
export const FREE_TEXT_ROW_LABEL = PROVEN_FREE_TEXT_LABELS.singleSelect;

// ---------------------------------------------------------------------------
// raw bytes
// ---------------------------------------------------------------------------

/** Right-arrow. Moves onto the multi-select Submit tab. NOT a submit by itself. */
export const KEY_RIGHT_ARROW = "\x1b[C";
/** Carriage return. Submits a review screen / a free-text editor. TOGGLES a multi-select row. */
export const KEY_RETURN = "\r";

/** Highest option index that can be addressed by a single bare digit ("9"). */
export const MAX_DIGIT_ADDRESSABLE_INDEX = 8;

/** PROTOCOL §11.2 — a free-text answer is 1..4 096 chars. */
export const FREETEXT_MAX_CHARS = 4_096;

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

export type KeystrokeEncodingReason =
	/** The prompt/answer combination has no PROVEN byte sequence. Never guessed. */
	| "shape_unproven"
	/** `answers.length !== questions.length`, or indices are not 0..N-1 ascending. */
	| "arity_mismatch"
	/** `kind` does not match the item's `multiSelect` / `freeTextOption`. */
	| "kind_mismatch"
	/** An option index is outside `0..options.length-1` (or the free-text slot). */
	| "option_out_of_range"
	/** `optionIndexes` contained a duplicate — toggling twice silently deselects. */
	| "duplicate_option"
	/** `optionIndexes` was not sorted ascending. */
	| "unsorted_options"
	/** An option index needs two digits; a single bare digit cannot address it. */
	| "digit_out_of_range"
	/** Free text was empty, too long, or carried control bytes. */
	| "freetext_invalid"
	/** The emitted sequence failed its own post-encode shape assertion. */
	| "encoder_self_check";

/**
 * Every one of these means NOTHING WAS WRITTEN — this module is pure and runs
 * entirely before the injector takes the terminal lock. The caller maps it to
 * `400 bad_request` (client sent something impossible) or
 * `501 capability_unsupported` / an `answerable: false` question
 * (`shape_unproven`), and writes nothing.
 */
export class KeystrokeEncodingError extends Error {
	constructor(
		readonly reason: KeystrokeEncodingReason,
		message: string,
	) {
		super(message);
		this.name = "KeystrokeEncodingError";
	}
}

// ---------------------------------------------------------------------------
// shapes
// ---------------------------------------------------------------------------

/**
 * The four shapes with a PROVEN byte sequence. Anything else is
 * `shape_unproven` and is refused.
 *
 * Deliberately absent, and why: a multi-select or a free-text item inside an
 * N > 1 prompt. The proven multi-select submit (`\x1b[C` then `\r`) and the
 * proven free-text terminator (`\r`) were both established against a
 * SINGLE-question prompt, where they end the whole prompt. Whether they advance
 * to the next question or submit the entire prompt when other questions follow
 * was never observed. Guessing wrong either strands the prompt half-answered or
 * submits answers the user never gave — so those combinations are refused until
 * someone proves them in a pty. This is the same reason `agent.codex` is never
 * granted in v1.
 */
export type AnswerShape =
	/** Exactly one single-select question: `[digit]`. Atomic select+submit. */
	| "single_select_one"
	/** N > 1 questions, ALL single-select: `[digit × N, "\r"]`. */
	| "single_select_many"
	/** Exactly one multi-select question: `[toggle × k, "\x1b[C", "\r"]`. */
	| "multiselect_one"
	/** Exactly one question answered with free text: `[digit N+1, text, "\r"]`. */
	| "freetext_one";

export type KeystrokeKind =
	/** A bare digit that selects (and, when it is the only one, submits). */
	| "select_digit"
	/** A bare digit that TOGGLES a multi-select row. */
	| "toggle_digit"
	/** The digit that opens the inline free-text editor. */
	| "freetext_open"
	/** The UTF-8 free-text body. */
	| "freetext_body"
	/** Right-arrow onto the multi-select Submit tab. Not a submit. */
	| "submit_tab"
	/** `\r` — submits a review screen or a free-text editor. */
	| "submit_return";

/**
 * What the picker MUST be showing immediately before a keystroke is written.
 * Guard 5 is re-evaluated against this before EVERY keystroke, because each one
 * lands on a screen the previous one changed.
 */
export type ScreenExpectation =
	/**
	 * The numbered option list for `itemIndex` is on screen, and the digit this
	 * keystroke is about to press maps to the option we think it does. This is
	 * the STRONG form and it is what makes guard 5 load-bearing.
	 */
	| { kind: "item_picker"; itemIndex: number }
	/**
	 * A screen whose exact shape was never proven (the N-question review screen,
	 * the multi-select Submit tab, the open free-text editor). The only sound
	 * assertion available is the WEAK one: this prompt is still the thing on
	 * screen, anchored on `itemIndex`'s header. Weaker than `item_picker` and
	 * documented as such — never presented as equivalent.
	 */
	| { kind: "same_prompt"; itemIndex: number };

export interface Keystroke {
	kind: KeystrokeKind;
	/** The exact bytes, written verbatim by the raw pty writer. Never reframed. */
	data: string;
	/** 0-based index of the `QuestionItem` this keystroke acts on. */
	questionIndex: number;
	/** The option index this keystroke selects/toggles/opens, when applicable. */
	optionIndex: number | null;
	/** Re-checked by guard 5 immediately before this keystroke is written. */
	expect: ScreenExpectation;
	/**
	 * true => after this keystroke the prompt is submitted and the picker is
	 * gone. Exactly one keystroke in a sequence carries this.
	 */
	submits: boolean;
}

// ---------------------------------------------------------------------------
// §11.2 boundary validation
// ---------------------------------------------------------------------------

/**
 * PROTOCOL §11.2 — validate at the API boundary, before anything else happens.
 * Every failure is a hard error; nothing is coerced, normalised or defaulted.
 *
 * In particular a duplicate in `optionIndexes` is REFUSED rather than
 * de-duplicated: two toggles of the same row cancel out, so "normalising" it
 * would be guessing at intent and would silently answer something the user did
 * not choose.
 */
export function validateAnswerItems(
	questions: readonly QuestionItem[],
	answers: readonly AnswerItem[],
): void {
	if (questions.length === 0) {
		throw new KeystrokeEncodingError("arity_mismatch", "question has no items");
	}
	if (answers.length !== questions.length) {
		throw new KeystrokeEncodingError(
			"arity_mismatch",
			`answers.length ${answers.length} !== questions.length ${questions.length}; a partial answer is not a thing`,
		);
	}

	for (let i = 0; i < answers.length; i += 1) {
		const answer = answers[i];
		const item = questions[i];
		if (answer === undefined || item === undefined) {
			throw new KeystrokeEncodingError(
				"arity_mismatch",
				`missing answer or question item at position ${i}`,
			);
		}
		if (answer.questionIndex !== i) {
			throw new KeystrokeEncodingError(
				"arity_mismatch",
				`answers must be 0..N-1, each once, ascending; position ${i} carries questionIndex ${answer.questionIndex}`,
			);
		}
		if (item.index !== i) {
			throw new KeystrokeEncodingError(
				"arity_mismatch",
				`question item at position ${i} declares index ${item.index}`,
			);
		}
		validateAnswerItem(item, answer);
	}
}

function validateAnswerItem(item: QuestionItem, answer: AnswerItem): void {
	const optionCount = item.options.length;

	switch (answer.kind) {
		case "select": {
			if (item.multiSelect) {
				throw new KeystrokeEncodingError(
					"kind_mismatch",
					`item ${item.index} is multiSelect; "select" is never coerced into it`,
				);
			}
			assertOptionIndex(answer.optionIndex, optionCount, item.index);
			return;
		}
		case "multiselect": {
			if (!item.multiSelect) {
				throw new KeystrokeEncodingError(
					"kind_mismatch",
					`item ${item.index} is single-select; "multiselect" is never coerced into it`,
				);
			}
			let previous = -1;
			for (const optionIndex of answer.optionIndexes) {
				assertOptionIndex(optionIndex, optionCount, item.index);
				if (optionIndex === previous) {
					throw new KeystrokeEncodingError(
						"duplicate_option",
						`item ${item.index} repeats option ${optionIndex}; two toggles cancel out, so this is refused rather than normalised`,
					);
				}
				if (optionIndex < previous) {
					throw new KeystrokeEncodingError(
						"unsorted_options",
						`item ${item.index} optionIndexes must be sorted ascending`,
					);
				}
				previous = optionIndex;
			}
			return;
		}
		case "freetext": {
			// PROTOCOL §11.3: `kind` MUST match the item's `multiSelect` flag AND
			// the presence of `freeTextOption`. Both conjuncts are checked, and the
			// multiSelect one first — a multiSelect picker's free-text row was never
			// characterised in a pty, and typing into one would TOGGLE an arbitrary
			// subset (digits/space toggle, Enter toggles rather than submits) and
			// leave the picker open on a selection nobody made. Symmetric with the
			// "select" and "multiselect" cases above; a producer that synthesised a
			// free-text slot onto a multiSelect item must be refused here, not
			// merely be unreachable through a well-behaved client.
			if (item.multiSelect) {
				throw new KeystrokeEncodingError(
					"kind_mismatch",
					`item ${item.index} is multiSelect; "freetext" has no proven byte contract there and is never coerced into it`,
				);
			}
			if (item.freeTextOption === null) {
				throw new KeystrokeEncodingError(
					"kind_mismatch",
					`item ${item.index} has no free-text slot`,
				);
			}
			if (item.freeTextOption.index !== optionCount) {
				throw new KeystrokeEncodingError(
					"option_out_of_range",
					`item ${item.index} free-text slot is ${item.freeTextOption.index}, expected ${optionCount}`,
				);
			}
			assertFreeText(answer.text, item.index);
			return;
		}
		default: {
			// Exhaustive: `AnswerItem` is a closed union. An unknown kind reaching
			// here is a decoder bug, and is surfaced rather than ignored.
			const unreachable: never = answer;
			throw new KeystrokeEncodingError(
				"kind_mismatch",
				`unknown answer kind: ${JSON.stringify(unreachable)}`,
			);
		}
	}
}

function assertOptionIndex(
	optionIndex: number,
	optionCount: number,
	itemIndex: number,
): void {
	if (!Number.isInteger(optionIndex)) {
		throw new KeystrokeEncodingError(
			"option_out_of_range",
			`item ${itemIndex} option index ${optionIndex} is not an integer`,
		);
	}
	if (optionIndex < 0 || optionIndex >= optionCount) {
		throw new KeystrokeEncodingError(
			"option_out_of_range",
			`item ${itemIndex} option index ${optionIndex} outside 0..${optionCount - 1}`,
		);
	}
}

/** Line feed, 0x0A. Permitted only in a `/v1/message` body — see `MESSAGE_ALLOWED_C0`. */
export const CHAR_LF = "\n";

/** Horizontal tab, 0x09. Permitted only in a `/v1/message` body. */
export const CHAR_TAB = "\t";

/**
 * The complete, explicit allow-list of C0 control characters inside the PICKER's
 * inline free-text body. It is EMPTY: every C0 byte and DEL is REFUSED, never
 * stripped, because stripping would send text the user did not write.
 *
 * Empty rather than `{LF}`, deliberately. The picker's free-text body is written
 * RAW (bracketed paste is inert against the picker), and the proven contract
 * (`PROVEN_AGAINST`) covers exactly the digit, the body and the terminating `\r`
 * — what the inline editor does with a raw 0x0A is UNMEASURED. Several TUI line
 * editors treat LF as Enter, which would submit the editor mid-body and leave the
 * remainder steering the agent. This module's policy is that an unproven byte is
 * refused rather than guessed at, so LF stays out until an embedded-LF case is
 * added to the canary test and `PROVEN_AGAINST` is re-established.
 *
 * Why the individual bytes are out, precisely:
 *  - `\r` (0x0D) is the byte the picker's inline editor reads as Enter. Inside a
 *    free-text body it would SUBMIT mid-sentence and leave the remainder landing
 *    in the composer or steering the running agent. It is the single most
 *    dangerous byte this validator can pass.
 *  - `\x1b` (0x1B) is the introducer of every control sequence the encoder emits
 *    (`KEY_RIGHT_ARROW`); text carrying it could drive the TUI directly.
 *  - `\t` (0x09) moves focus between the picker's tabs, which is a navigation
 *    act, not a character.
 *  - `\n` (0x0A) is unproven against the inline editor — see above.
 *  - `\0`, BEL, BS and the rest of C0 have no meaning as typed text and are
 *    terminal control.
 *  - DEL (0x7F) and C1 (0x80..0x9F) are refused by the scan itself and can never
 *    be allow-listed: `U+009B` is CSI, the single-character `ESC [`, which a
 *    UTF-8 terminal acts on exactly like the `\x1b` above.
 */
const FREETEXT_ALLOWED_C0: ReadonlySet<number> = new Set<number>();

/**
 * The allow-list for a `/v1/message` body, which is a DIFFERENT writer with a
 * different proof: `writeFramedInputToSession` frames the body as a bracketed
 * paste, and a bracketed paste carries LF and TAB to the composer as literal
 * characters rather than as Enter or as focus movement. That framing is what
 * earns these two bytes; the picker path has no equivalent and so keeps the
 * empty set above.
 *
 * Kept as a separate constant rather than by widening `FREETEXT_ALLOWED_C0`,
 * because one writer's genuine need must never loosen the other writer's
 * validator. §0.3 of PROTOCOL.md is the normative table both runtimes implement.
 *
 * Both members are C0. DEL and C1 are refused by `findForbiddenControlChar`
 * itself on every path and are deliberately not expressible here: a bracketed
 * paste carries `U+009B` to the composer as the CSI byte pair `c2 9b`, which is
 * not a character in a sentence.
 */
export const MESSAGE_ALLOWED_C0: ReadonlySet<number> = new Set([
	CHAR_LF.charCodeAt(0),
	CHAR_TAB.charCodeAt(0),
]);

/**
 * Reject strings that are not well-formed Unicode.
 *
 * A lone surrogate (an unpaired 0xD800..0xDFFF code unit) is a legal JS string
 * but has no UTF-8 encoding. Node substitutes U+FFFD when it encodes one, so a
 * value that passed validation reached the pty as `ef bf bd` — the user's text
 * SILENTLY MUTATED on its way into a live terminal. Refusing is the only honest
 * option: the bridge cannot know what the client meant, and guessing at it is
 * the same class of mistake as normalising a duplicate option index.
 *
 * Implemented by hand rather than via `String.prototype.isWellFormed`: the
 * workspace compiles against `lib: ES2022`, where that method does not exist.
 *
 * Exported because `/v1/message` types text into the same terminals through a
 * different writer and must not have a second, drifting copy of this rule.
 */
export function findUnpairedSurrogate(
	text: string,
): { index: number; unit: number } | null {
	for (let i = 0; i < text.length; i += 1) {
		const unit = text.charCodeAt(i);
		if (unit < 0xd800 || unit > 0xdfff) continue;
		// A high surrogate must be followed by a low surrogate; a low surrogate may
		// never appear on its own.
		const isHigh = unit <= 0xdbff;
		const next = isHigh ? text.charCodeAt(i + 1) : Number.NaN;
		if (isHigh && next >= 0xdc00 && next <= 0xdfff) {
			i += 1;
			continue;
		}
		return { index: i, unit };
	}
	return null;
}

/**
 * The first character that is a control byte this text may not carry, or `null`.
 *
 * "Control" is the full set PROTOCOL §0.3 names, and nothing narrower:
 *
 *  - C0, `U+0000`..`U+001F`;
 *  - DEL, `U+007F`;
 *  - **C1, `U+0080`..`U+009F`.**
 *
 * C1 is not decoration. `U+009B` is CSI — the single-character form of `ESC [`
 * — and Node encodes it as the two UTF-8 bytes `c2 9b`, which a terminal in
 * UTF-8 mode consumes as a control-sequence introducer. The picker's free-text
 * body is written RAW (bracketed paste is inert against the picker), so a text
 * carrying `U+009B` would drive the TUI exactly the way the refused `\x1b` does,
 * and `U+0085` (NEL) is a line break by another name. Scanning only `< 0x20`
 * plus DEL admitted both into the one module whose whole policy is that an
 * unproven byte is refused rather than guessed at. Neither is reachable from the
 * Android client — `SemanticText.firstControlChar` has always rejected
 * `0x80..0x9F` — so this closes daylight between the two runtimes rather than
 * changing what any shipping client can do.
 *
 * The scan is over UTF-16 code units, the same unit both runtimes count length
 * in, so an index reported here means the same position on both sides.
 *
 * `allowed` is REQUIRED and names the policy explicitly at each call site: the
 * picker's free-text body passes `FREETEXT_ALLOWED_C0` (empty), `/v1/message`
 * passes `MESSAGE_ALLOWED_C0` (`{LF, TAB}`). One implementation so the two
 * writers cannot drift on what "control byte" means; two policies so one
 * writer's proof can never silently license the other's bytes. An allow-list may
 * only ever name C0 members — DEL and C1 have no proven meaning as typed text on
 * either writer, so nothing is exempt from them.
 *
 * Exported for the same reason as `findUnpairedSurrogate`: `/v1/message` types
 * into the same terminals through a different writer and must not carry a
 * second, drifting copy of this scan.
 */
export function findForbiddenControlChar(
	text: string,
	allowed: ReadonlySet<number>,
): { index: number; code: number } | null {
	for (let i = 0; i < text.length; i += 1) {
		const code = text.charCodeAt(i);
		const isControl =
			code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
		if (!isControl) continue;
		if (allowed.has(code)) continue;
		return { index: i, code };
	}
	return null;
}

/**
 * §11.2 boundary validation of a free-text body, before any byte is encoded.
 *
 * Length, character set and Unicode well-formedness. Every failure refuses;
 * nothing is stripped, normalised or substituted.
 */
function assertFreeText(text: string, itemIndex: number): void {
	if (text.length === 0) {
		throw new KeystrokeEncodingError(
			"freetext_invalid",
			`item ${itemIndex} free text is empty`,
		);
	}
	if (text.length > FREETEXT_MAX_CHARS) {
		throw new KeystrokeEncodingError(
			"freetext_invalid",
			`item ${itemIndex} free text is ${text.length} chars, max ${FREETEXT_MAX_CHARS}`,
		);
	}
	const control = findForbiddenControlChar(text, FREETEXT_ALLOWED_C0);
	if (control !== null) {
		throw new KeystrokeEncodingError(
			"freetext_invalid",
			`item ${itemIndex} free text carries control byte 0x${control.code.toString(16)} at ${control.index}; refused, never stripped`,
		);
	}
	const surrogate = findUnpairedSurrogate(text);
	if (surrogate !== null) {
		throw new KeystrokeEncodingError(
			"freetext_invalid",
			`item ${itemIndex} free text carries an unpaired surrogate 0x${surrogate.unit.toString(16)} at ${surrogate.index}; refused rather than encoded as U+FFFD, which would type something other than what was written`,
		);
	}
}

// ---------------------------------------------------------------------------
// shape classification
// ---------------------------------------------------------------------------

/**
 * Classifies a validated (questions, answers) pair into one of the four PROVEN
 * shapes, or throws `shape_unproven`.
 *
 * Call `validateAnswerItems` first — this assumes the pair is already
 * structurally sound.
 */
export function classifyAnswerShape(
	questions: readonly QuestionItem[],
	answers: readonly AnswerItem[],
): AnswerShape {
	if (questions.length === 1) {
		const only = answers[0];
		if (only === undefined) {
			throw new KeystrokeEncodingError("arity_mismatch", "no answer item");
		}
		switch (only.kind) {
			case "select":
				return "single_select_one";
			case "multiselect":
				return "multiselect_one";
			case "freetext":
				return "freetext_one";
			default: {
				const unreachable: never = only;
				throw new KeystrokeEncodingError(
					"kind_mismatch",
					`unknown answer kind: ${JSON.stringify(unreachable)}`,
				);
			}
		}
	}

	for (const answer of answers) {
		if (answer.kind !== "select") {
			throw new KeystrokeEncodingError(
				"shape_unproven",
				`item ${answer.questionIndex} is "${answer.kind}" inside an ${questions.length}-question prompt; the byte sequence for that combination was never proven against a live picker and is refused rather than guessed`,
			);
		}
	}
	return "single_select_many";
}

// ---------------------------------------------------------------------------
// encoding
// ---------------------------------------------------------------------------

/**
 * The picker numbers its rows from 1; the protocol indexes options from 0.
 * A single bare digit can only address 1..9, so an option at index >= 9 has NO
 * single-keystroke encoding. Emitting "1" then "0" for row 10 would select row 1
 * and then press 0 — a different, wrong, irreversible answer. Refused.
 */
export function digitFor(optionIndex: number, itemIndex: number): string {
	if (optionIndex > MAX_DIGIT_ADDRESSABLE_INDEX) {
		throw new KeystrokeEncodingError(
			"digit_out_of_range",
			`item ${itemIndex} option ${optionIndex} needs row ${optionIndex + 1}, which is not a single digit; refused (typing "1" then "0" would select row 1 and then press 0)`,
		);
	}
	return String(optionIndex + 1);
}

/**
 * (FREETEXT-CONTRACT-BROKEN) The free-text sequence in `encodeFreeTextOne` was
 * proven against claude-code@2.1.220 and is WRONG for the installed 2.1.226.
 *
 * Driving the real CLI in a pty (`tmp/refusal-2026-08-08/pty_canary_node.mjs`,
 * reproduced on two independent runs) shows that a bare digit on the free-text
 * row does NOT open the inline editor: it only moves the selection caret onto the
 * row, and the footer gains "ctrl+g to edit in Notepad". Opening the editor needs
 * a further keystroke this fork has not yet characterised.
 *
 * `[digit, text, "\r"]` against that picker would therefore move the caret, feed
 * the answer text to a picker that is not accepting text, and then press Enter —
 * committing something nobody chose while discarding the user's actual answer.
 * That is the unrecoverable outcome §11 forbids guessing at.
 *
 * So the shape is refused here, by name, until it is re-proven. It was already
 * unreachable in practice, because guard 5 was rejecting the row on drifted label
 * copy as well — but relying on one bug to contain another is not containment:
 * fixing the label (independently correct, and now fixed) would have quietly
 * re-armed this.
 *
 * TO LIFT: drive the picker in a pty, establish the keystrokes that open and
 * submit the editor, update `encodeFreeTextOne` and `PROVEN_AGAINST` together,
 * and only then flip this.
 */
const FREE_TEXT_CONTRACT_PROVEN = false;

/**
 * Intent -> the exact keystroke sequence. Pure: it touches no terminal, holds no
 * lock and has no side effects, so every failure here is provably
 * "nothing was written".
 *
 * The sequence is returned as DISCRETE keystrokes rather than one blob because
 * guard 5 is re-evaluated between every one of them.
 */
export function encodeAnswer(
	questions: readonly QuestionItem[],
	answers: readonly AnswerItem[],
): Keystroke[] {
	validateAnswerItems(questions, answers);
	const shape = classifyAnswerShape(questions, answers);

	if (shape === "freetext_one" && !FREE_TEXT_CONTRACT_PROVEN) {
		throw new KeystrokeEncodingError(
			"shape_unproven",
			"the free-text byte contract is known-wrong for the installed Claude Code: a bare digit on that row moves the caret instead of opening the editor, so the answer text would land in the picker and then be committed. Answer this one at the desk",
		);
	}

	const keystrokes: Keystroke[] =
		shape === "single_select_one"
			? encodeSingleSelectOne(questions, answers)
			: shape === "single_select_many"
				? encodeSingleSelectMany(questions, answers)
				: shape === "multiselect_one"
					? encodeMultiSelectOne(questions, answers)
					: encodeFreeTextOne(questions, answers);

	assertEmittedShape(shape, keystrokes);
	return keystrokes;
}

/** `[digit]` — one bare digit selects AND submits. No Enter, ever. */
function encodeSingleSelectOne(
	questions: readonly QuestionItem[],
	answers: readonly AnswerItem[],
): Keystroke[] {
	const answer = answers[0];
	if (answer === undefined || answer.kind !== "select") {
		throw new KeystrokeEncodingError("kind_mismatch", "expected one select");
	}
	if (questions[0] === undefined) {
		throw new KeystrokeEncodingError("arity_mismatch", "missing question item");
	}
	return [
		{
			kind: "select_digit",
			data: digitFor(answer.optionIndex, 0),
			questionIndex: 0,
			optionIndex: answer.optionIndex,
			expect: { kind: "item_picker", itemIndex: 0 },
			submits: true,
		},
	];
}

/** `[digit × N, "\r"]` — N digits, then Enter on the review screen. */
function encodeSingleSelectMany(
	questions: readonly QuestionItem[],
	answers: readonly AnswerItem[],
): Keystroke[] {
	const keystrokes: Keystroke[] = [];
	for (let i = 0; i < answers.length; i += 1) {
		const answer = answers[i];
		if (answer === undefined || answer.kind !== "select") {
			throw new KeystrokeEncodingError(
				"kind_mismatch",
				`item ${i} is not a select`,
			);
		}
		keystrokes.push({
			kind: "select_digit",
			data: digitFor(answer.optionIndex, i),
			questionIndex: i,
			optionIndex: answer.optionIndex,
			// Each digit advances the picker, so the screen guard-5 must see is
			// item i's own numbered list, not item 0's.
			expect: { kind: "item_picker", itemIndex: i },
			submits: false,
		});
	}
	keystrokes.push({
		kind: "submit_return",
		data: KEY_RETURN,
		questionIndex: questions.length - 1,
		optionIndex: null,
		// The review screen's exact layout was never proven; the only sound
		// assertion left is that this prompt is still what is on screen.
		expect: { kind: "same_prompt", itemIndex: questions.length - 1 },
		submits: true,
	});
	return keystrokes;
}

/**
 * `[toggle × k, "\x1b[C", "\r"]`.
 *
 * NOTE the inversion: `\r` here is NOT "submit the selection I just made" — on
 * the rows it would TOGGLE. It only submits once `\x1b[C` has moved focus onto
 * the Submit tab, which is why the two are emitted as an inseparable pair and
 * re-checked by `assertMultiSelectSubmitShape`.
 *
 * An empty `optionIndexes` is legal (PROTOCOL §11.2) and encodes to just the
 * submit pair.
 */
function encodeMultiSelectOne(
	questions: readonly QuestionItem[],
	answers: readonly AnswerItem[],
): Keystroke[] {
	const answer = answers[0];
	if (answer === undefined || answer.kind !== "multiselect") {
		throw new KeystrokeEncodingError(
			"kind_mismatch",
			"expected one multiselect",
		);
	}
	if (questions[0] === undefined) {
		throw new KeystrokeEncodingError("arity_mismatch", "missing question item");
	}

	const keystrokes: Keystroke[] = answer.optionIndexes.map((optionIndex) => ({
		kind: "toggle_digit" as const,
		data: digitFor(optionIndex, 0),
		questionIndex: 0,
		optionIndex,
		expect: { kind: "item_picker" as const, itemIndex: 0 },
		submits: false,
	}));

	keystrokes.push({
		kind: "submit_tab",
		data: KEY_RIGHT_ARROW,
		questionIndex: 0,
		optionIndex: null,
		expect: { kind: "item_picker", itemIndex: 0 },
		submits: false,
	});
	keystrokes.push({
		kind: "submit_return",
		data: KEY_RETURN,
		questionIndex: 0,
		optionIndex: null,
		// Focus is on the Submit tab now; that screen was never characterised
		// beyond "the prompt is still up".
		expect: { kind: "same_prompt", itemIndex: 0 },
		submits: true,
	});
	return keystrokes;
}

/** `[digit N+1, text, "\r"]` — the slot after the last real option opens an editor. */
function encodeFreeTextOne(
	questions: readonly QuestionItem[],
	answers: readonly AnswerItem[],
): Keystroke[] {
	const answer = answers[0];
	const item = questions[0];
	if (answer === undefined || answer.kind !== "freetext") {
		throw new KeystrokeEncodingError("kind_mismatch", "expected one freetext");
	}
	if (item === undefined || item.freeTextOption === null) {
		throw new KeystrokeEncodingError(
			"kind_mismatch",
			"item has no free-text slot",
		);
	}
	const slot = item.freeTextOption.index;
	return [
		{
			kind: "freetext_open",
			data: digitFor(slot, 0),
			questionIndex: 0,
			optionIndex: slot,
			expect: { kind: "item_picker", itemIndex: 0 },
			submits: false,
		},
		{
			kind: "freetext_body",
			data: answer.text,
			questionIndex: 0,
			optionIndex: slot,
			// The inline editor's layout was never proven.
			expect: { kind: "same_prompt", itemIndex: 0 },
			submits: false,
		},
		{
			kind: "submit_return",
			data: KEY_RETURN,
			questionIndex: 0,
			optionIndex: slot,
			expect: { kind: "same_prompt", itemIndex: 0 },
			submits: true,
		},
	];
}

// ---------------------------------------------------------------------------
// post-encode self-check
// ---------------------------------------------------------------------------

/** A picker row addressable by one bare digit. Rows are numbered from 1. */
const SINGLE_DIGIT = /^[1-9]$/;

function selfCheck(message: string): KeystrokeEncodingError {
	return new KeystrokeEncodingError("encoder_self_check", message);
}

/**
 * (SELFCHECK-BYTES) The DATA grammar: the exact bytes each `KeystrokeKind` is
 * permitted to carry.
 *
 * This exists because the previous self-check inspected only `kind`,
 * `questionIndex` and `submits` — the SEMANTIC LABELS the encoder attaches — and
 * never looked at `data`. A sequence labelled
 * `[toggle_digit "1", submit_tab "\r", submit_return "\r"]` therefore PASSED
 * every assertion, while its raw bytes are `1\r\r`: a bare return immediately
 * after a toggle, which on a multi-select flips a row and does not submit. That
 * is precisely the shape the check exists to catch, so the check was checking the
 * wrong thing. Labels are what a future bug gets wrong; bytes are what the picker
 * consumes, so bytes are what is asserted.
 */
export function assertKeystrokeBytes(
	shape: AnswerShape,
	keystrokes: readonly Keystroke[],
): void {
	for (let index = 0; index < keystrokes.length; index += 1) {
		const keystroke = keystrokes[index];
		if (keystroke === undefined) {
			throw selfCheck(`shape ${shape}: missing keystroke at ${index}`);
		}
		const at = `shape ${shape} keystroke ${index} (${keystroke.kind})`;
		switch (keystroke.kind) {
			case "select_digit":
			case "toggle_digit":
			case "freetext_open": {
				if (!SINGLE_DIGIT.test(keystroke.data)) {
					throw selfCheck(
						`${at}: data must be a single row digit 1-9, got ${JSON.stringify(keystroke.data)}`,
					);
				}
				if (keystroke.optionIndex === null) {
					throw selfCheck(`${at}: a digit keystroke must name its optionIndex`);
				}
				if (keystroke.data !== String(keystroke.optionIndex + 1)) {
					throw selfCheck(
						`${at}: digit ${keystroke.data} does not address option ${keystroke.optionIndex}`,
					);
				}
				break;
			}
			case "submit_tab": {
				if (keystroke.data !== KEY_RIGHT_ARROW) {
					throw selfCheck(
						`${at}: data must be the right-arrow escape, got ${JSON.stringify(keystroke.data)}`,
					);
				}
				if (keystroke.submits) {
					throw selfCheck(
						`${at}: the Submit tab is reached by this key, it is not itself a submit`,
					);
				}
				break;
			}
			case "submit_return": {
				if (keystroke.data !== KEY_RETURN) {
					throw selfCheck(
						`${at}: data must be exactly the carriage return, got ${JSON.stringify(keystroke.data)}`,
					);
				}
				break;
			}
			case "freetext_body": {
				// Same boundary rules as the request that produced it: no CR (it would
				// submit mid-body), no ESC, no LF, no other terminal control,
				// well-formed Unicode only. See `FREETEXT_ALLOWED_C0` — it is empty.
				assertFreeText(keystroke.data, keystroke.questionIndex);
				break;
			}
			default: {
				const unreachable: never = keystroke.kind;
				throw selfCheck(`${at}: unknown keystroke kind ${String(unreachable)}`);
			}
		}
	}
}

/**
 * (SELFCHECK-BYTES) The SEQUENCE grammar: which kinds may appear, in what order,
 * for each proven shape. Checked against the emitted array rather than against
 * the encoder's intent, so a future encoder that emits a plausible-looking but
 * wrong sequence is caught here rather than by a terminal.
 */
function assertShapeGrammar(
	shape: AnswerShape,
	keystrokes: readonly Keystroke[],
): void {
	const kinds = keystrokes.map((keystroke) => keystroke.kind);
	switch (shape) {
		case "single_select_one": {
			if (kinds.length !== 1 || kinds[0] !== "select_digit") {
				throw selfCheck(
					`single_select_one must be exactly one bare digit — no Enter, ever; got [${kinds.join(", ")}]`,
				);
			}
			return;
		}
		case "single_select_many": {
			// N > 1 digits, one per question, then the review-screen return.
			if (kinds.length < 3) {
				throw selfCheck(
					`single_select_many needs at least two digits and a return; got [${kinds.join(", ")}]`,
				);
			}
			for (let index = 0; index < kinds.length - 1; index += 1) {
				if (kinds[index] !== "select_digit") {
					throw selfCheck(
						`single_select_many position ${index} must be select_digit, got ${kinds[index]}`,
					);
				}
				if (keystrokes[index]?.questionIndex !== index) {
					throw selfCheck(
						`single_select_many position ${index} answers question ${keystrokes[index]?.questionIndex}; digits must run 0..N-1 in order`,
					);
				}
			}
			if (kinds[kinds.length - 1] !== "submit_return") {
				throw selfCheck(
					`single_select_many must end with the review-screen return, got ${kinds[kinds.length - 1]}`,
				);
			}
			return;
		}
		case "multiselect_one": {
			if (kinds.length < 2) {
				throw selfCheck(
					`multiselect_one needs the Submit tab and the return; got [${kinds.join(", ")}]`,
				);
			}
			for (let index = 0; index < kinds.length - 2; index += 1) {
				if (kinds[index] !== "toggle_digit") {
					throw selfCheck(
						`multiselect_one position ${index} must be toggle_digit, got ${kinds[index]}`,
					);
				}
			}
			if (
				kinds[kinds.length - 2] !== "submit_tab" ||
				kinds[kinds.length - 1] !== "submit_return"
			) {
				throw selfCheck(
					`multiselect_one must end with the Submit tab then the return; got [${kinds.join(", ")}]`,
				);
			}
			return;
		}
		case "freetext_one": {
			if (
				kinds.length !== 3 ||
				kinds[0] !== "freetext_open" ||
				kinds[1] !== "freetext_body" ||
				kinds[2] !== "submit_return"
			) {
				throw selfCheck(
					`freetext_one must be [freetext_open, freetext_body, submit_return]; got [${kinds.join(", ")}]`,
				);
			}
			return;
		}
		default: {
			const unreachable: never = shape;
			throw selfCheck(`unknown shape ${String(unreachable)}`);
		}
	}
}

/**
 * A second, independent pass over the emitted sequence. The encoder above is
 * already correct; this exists because the specific failure it catches — an
 * `Enter` reaching a multi-select without the Submit tab first — is silent,
 * flips a selection, and produces an answer nobody chose. A shape assertion is
 * cheap; that outcome is not.
 *
 * Three layers, in order: the DATA each keystroke carries, the ORDER of kinds
 * for this shape, and the multi-select submit pair. The first is what makes the
 * other two mean anything — see `assertKeystrokeBytes`.
 */
export function assertEmittedShape(
	shape: AnswerShape,
	keystrokes: readonly Keystroke[],
): void {
	if (keystrokes.length === 0) {
		throw selfCheck(`shape ${shape} produced no keystrokes`);
	}

	assertKeystrokeBytes(shape, keystrokes);
	assertShapeGrammar(shape, keystrokes);

	const submitters = keystrokes.filter((k) => k.submits);
	if (submitters.length !== 1) {
		throw selfCheck(
			`shape ${shape} produced ${submitters.length} submitting keystrokes, expected exactly 1`,
		);
	}
	const last = keystrokes[keystrokes.length - 1];
	if (last === undefined || !last.submits) {
		throw selfCheck(`shape ${shape}: the submitting keystroke is not last`);
	}

	assertMultiSelectSubmitShape(shape, keystrokes);
}

/**
 * The specific guard the assignment calls out: a naive "append Enter to submit"
 * against a multi-select TOGGLES a row instead of submitting.
 *
 * Enforced on the BYTES, and ONLY on the bytes. That is the whole of its
 * independent value: the raw concatenation must end with `\x1b[C\r` and must
 * contain no other `\r` anywhere. A `submit_tab` mislabelled onto a carriage
 * return — `[toggle "1", submit_tab "\r", submit_return "\r"]`, raw bytes
 * `1\r\r` — fails that, where a label-only version accepted it.
 *
 * It deliberately re-derives NOTHING from the labels. `assertEmittedShape` runs
 * `assertKeystrokeBytes` (each kind carries the data it is allowed to carry) and
 * then `assertShapeGrammar` (multiselect_one is toggles, then `submit_tab`, then
 * `submit_return`, in that order) BEFORE it calls this — so "the tab exists",
 * "the return immediately follows it" and "no toggle comes after it" are already
 * pinned, and restating them here only made the byte check look like one more
 * label check. Keep this reading `keystroke.data` and nothing else.
 */
export function assertMultiSelectSubmitShape(
	shape: AnswerShape,
	keystrokes: readonly Keystroke[],
): void {
	if (shape !== "multiselect_one") return;

	// The bytes as the pty will see them. Independent of every label.
	const raw = keystrokes.map((keystroke) => keystroke.data).join("");
	const submitSuffix = `${KEY_RIGHT_ARROW}${KEY_RETURN}`;
	if (!raw.endsWith(submitSuffix)) {
		throw selfCheck(
			"multi-select bytes do not end with the right-arrow followed by the return; a return that is not preceded by the Submit tab toggles a row",
		);
	}
	if (raw.slice(0, raw.length - submitSuffix.length).includes(KEY_RETURN)) {
		throw selfCheck(
			"multi-select bytes carry a return before the Submit tab; every such return silently flips a selection",
		);
	}
}

// ---------------------------------------------------------------------------
// the raw writer — making the wrong writer impossible to wire
// ---------------------------------------------------------------------------

export interface RawWriteInput {
	terminalId: string;
	workspaceId: string;
	data: string;
}

export type RawWriteResult = { success: true } | { error: string };

/** A synchronous, unframed pty write. This is `writeInputToSession`'s shape. */
export type RawWriteFn = (input: RawWriteInput) => RawWriteResult;

// A real runtime symbol, deliberately NOT `declare const`. The brand is used as
// a computed property key when the writer is minted below, so a type-only
// declaration compiles cleanly and then throws `ReferenceError` the moment
// anything constructs one — which the bridge does at startup, so the whole
// service failed to boot rather than failing on the first answer.
const RAW_PTY_WRITER_BRAND: unique symbol = Symbol("RAW_PTY_WRITER_BRAND");

/**
 * A writer that has been PROVEN, at wiring time, to be the raw synchronous pty
 * write and not a paste-framing one. The brand cannot be produced by a type
 * assertion a reviewer would miss: only `createRawPtyWriter` mints it, and only
 * after the probe below passes.
 */
export interface RawPtyWriter {
	readonly [RAW_PTY_WRITER_BRAND]: "writeInputToSession";
	write(input: RawWriteInput): RawWriteResult;
}

/**
 * A terminal id that cannot exist: `writeInputToSession` looks the id up in its
 * in-memory session map before touching a pty, and no id in that map contains a
 * NUL. The probe therefore reaches the "not found" branch and returns without
 * writing a byte anywhere. `data` is empty as a second layer of safety.
 */
const PROBE_ID = `${String.fromCharCode(0)}companion/raw-writer-probe`;

const PROBE_INPUT: RawWriteInput = {
	terminalId: PROBE_ID,
	workspaceId: PROBE_ID,
	data: "",
};

/**
 * Wraps the raw writer and FAILS LOUD at startup if what it was handed is not
 * one.
 *
 * Bracketed paste is inert against the picker, so wiring
 * `writeFramedInputToSession` / `terminal.send` here would not throw and would
 * not warn — the answer would simply never arrive, intermittently, in
 * production. The discriminator is structural rather than name-based (names do
 * not survive bundling): the framed writer is `async` and returns a Promise; the
 * raw one is synchronous and returns a plain result object. The probe is
 * side-effect-free by construction (see `PROBE_INPUT`).
 *
 * Call this ONCE, in the composition root, at bridge start.
 */
export function createRawPtyWriter(
	writeInputToSession: RawWriteFn,
): RawPtyWriter {
	if (typeof writeInputToSession !== "function") {
		throw new Error(
			"(COMPANION-BRIDGE) raw pty writer: expected a function, got " +
				typeof writeInputToSession,
		);
	}

	const probe: unknown = writeInputToSession(PROBE_INPUT);

	if (probe !== null && typeof probe === "object" && "then" in probe) {
		throw new Error(
			"(COMPANION-BRIDGE) raw pty writer returned a Promise. That is the " +
				"paste-FRAMING writer (writeFramedInputToSession / terminal.send). " +
				"Bracketed paste is INERT against the AskUserQuestion picker, so " +
				"answers would silently never arrive. Wire writeInputToSession.",
		);
	}
	if (
		probe === null ||
		typeof probe !== "object" ||
		!("error" in probe || "success" in probe)
	) {
		throw new Error(
			"(COMPANION-BRIDGE) raw pty writer probe returned an unrecognised " +
				"shape; refusing to build an injector on a writer whose contract " +
				"is not the one this module was proven against.",
		);
	}

	return {
		[RAW_PTY_WRITER_BRAND]: "writeInputToSession",
		write: (input) => writeInputToSession(input),
	} as RawPtyWriter;
}
