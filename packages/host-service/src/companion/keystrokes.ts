/**
 * (COMPANION-BRIDGE) — the keystroke encoder. The ONLY place in the system that
 * turns intent into bytes for a terminal.
 *
 * The client sends SEMANTIC INTENT ONLY (questionId, fingerprint, chosen option
 * indices, typed text). There is no field anywhere in the wire contract through
 * which a client can express "send these bytes to that terminal" (PROTOCOL
 * §11.1), so a compromised or buggy client is STRUCTURALLY incapable of emitting
 * a stray key. All byte encoding lives here.
 *
 * ---------------------------------------------------------------------------
 * THE PROVEN KEY CONTRACT (`PROVEN_AGAINST`)
 * ---------------------------------------------------------------------------
 * It is a PRIVATE contract with a TUI that auto-updates: when Claude Code
 * changes, only this file changes, and re-proving it against a live picker is
 * this module's standing obligation. Keys below are named; their bytes are the
 * table at `(ANSWER-CSIU-ENCODING)`.
 *
 *   single-select, ONE question
 *     ONE digit both SELECTS AND SUBMITS. No Return. The act is atomic.
 *
 *   single-select, N > 1 questions in one call
 *     one digit per question, then Return on the review screen.
 *
 *   multiSelect, ONE question
 *     digits TOGGLE a row; Right moves onto the Submit tab, THEN Return submits.
 *     A Return on the rows TOGGLES the caret's row and does NOT submit.
 *
 *   multiSelect inside N > 1  (MSEL-N2-PROVEN)
 *     digits toggle, then the SAME Right ADVANCES — to the next question
 *     mid-prompt, to the review screen on the last — and the review-screen
 *     Return submits. NO Return may land inside a multi-select question except
 *     where the free-text group below puts it (`assertNoReturnIntoMultiSelect`).
 *
 *   free text on a single-select question  (FREETEXT-N2-PROVEN)
 *     digit N+1 (the slot after the last option) opens the inline editor, then
 *     the text, then Return. At N = 1 that Return submits; at N > 1 it ADVANCES
 *     and the review-screen Return submits.
 *
 *   free text on a multiSelect question  (MSEL-FREETEXT-PROVEN)
 *     toggle digits, then Down × options.length from the untouched first row
 *     onto "Type something", the text, Down, Return. At N = 1 a second Return
 *     submits the review screen; at N > 1 the Return ADVANCES.
 *
 * Text goes as a bracketed paste, which carries it into the focused editor or
 * "Type something" field as one event. Only the acknowledged raw writer
 * (`writeAcknowledgedInputToSession`) drives the picker, because it reports
 * daemon refusal; `createRawPtyWriter` makes any other writer a loud startup
 * failure.
 *
 * ---------------------------------------------------------------------------
 * WHY EVERY REFUSAL HERE IS DELIBERATE
 * ---------------------------------------------------------------------------
 * Stale bytes are dangerous and unrecoverable. With the picker gone a digit
 * lands in the composer and a following Enter submits it as a real prompt;
 * mid-turn it queues and steers the running agent; against a DIFFERENT picker it
 * commits instantly. So: any shape whose key sequence was not PROVEN is refused
 * outright (`shape_unproven`) rather than guessed at. A refusal costs the user
 * one walk to the desk. A guess costs them an irreversible wrong answer.
 */

import type { AcknowledgedInputFailureKind } from "../terminal/DaemonClient";
import type { AnswerItem, QuestionItem } from "./types";

/**
 * The Claude Code build the contract above was proven against. Its keys were
 * DRIVEN there and the agent's own `tool_result` confirmed each shape.
 *
 * (PROVEN-VERSION-DRIFT) `proven-version.ts` compares this against the CLI that
 * is actually installed and reports a mismatch on the bridge's status surface. It
 * does NOT refuse anything: a bridge that refused every answer the day after a
 * Claude Code auto-update would be a worse failure than the drift it warned
 * about. Never advance this constant on the strength of reading the CLI's
 * source; only a live pty shows behaviour.
 */
export const PROVEN_AGAINST = "claude-code@2.1.303";

/**
 * (PICKER-CONTRACT-VERSIONED) One entry per Claude Code build the fork has
 * OBSERVED, owning both halves of the contract for that build: the keys, and the
 * exact copy the free-text rows render.
 *
 * The `*BytesProven` flags are PER SHAPE and per version, because the shapes are
 * independent behaviours. An entry records what a pty run showed on THAT build;
 * a later build's proof never backfills an earlier one. An UNKNOWN version
 * resolves to `null` and everything downstream fails closed.
 */
export interface PickerContract {
	version: string;
	/** The free-text row's exact label on a SINGLE-SELECT question. */
	freeTextRowLabel: string;
	/** `[digit N+1, text, Return]` on a prompt of exactly ONE single-select question. */
	freeTextOneBytesProven: boolean;
	/** (FREETEXT-N2-PROVEN) The same group inside an N > 1 prompt, where the Return advances. */
	freeTextManyBytesProven: boolean;
	/** (MSEL-N2-PROVEN) `[toggle × k, Right]` as a group inside an N > 1 prompt. */
	multiSelectManyBytesProven: boolean;
	/** The multi-select free-text group on a prompt of exactly ONE question. */
	multiSelectFreeTextOneBytesProven: boolean;
	/** The multi-select free-text group inside an N > 1 prompt. */
	multiSelectFreeTextManyBytesProven: boolean;
	/** The free-text row's exact label on a MULTI-SELECT question; `null` when never captured. */
	multiSelectFreeTextRowLabel: string | null;
}

export const PICKER_CONTRACTS: readonly PickerContract[] = [
	{
		version: "claude-code@2.1.220",
		freeTextRowLabel: "Other",
		freeTextOneBytesProven: true,
		freeTextManyBytesProven: false,
		multiSelectManyBytesProven: false,
		multiSelectFreeTextOneBytesProven: false,
		multiSelectFreeTextManyBytesProven: false,
		multiSelectFreeTextRowLabel: null,
	},
	{
		version: "claude-code@2.1.226",
		freeTextRowLabel: "Type something.",
		freeTextOneBytesProven: true,
		// (FREETEXT-N2-PROVEN) N=2 first, last and both, twice each, plus N=3 middle.
		freeTextManyBytesProven: true,
		// (MSEL-N2-PROVEN) first, last and middle, twice each (tmp/pty-proof-msel/PROOF.md).
		multiSelectManyBytesProven: true,
		// Raw-key drive on this build toggled the row and swallowed the text.
		multiSelectFreeTextOneBytesProven: false,
		multiSelectFreeTextManyBytesProven: false,
		// tmp/pty-proof-msel/mix_ft_first-r1-04..06: `[ ] Type something`, no full stop.
		multiSelectFreeTextRowLabel: "Type something",
	},
	// (MSEL-FREETEXT-PROVEN) Driven with the (ANSWER-CSIU-ENCODING) keys, one write
	// per picker screen and the final Return alone; evidence under
	// tmp/multiselect-other/.
	{
		version: "claude-code@2.1.303",
		// round5 screens.
		freeTextRowLabel: "Type something.",
		// round6 one-question bulk single Other 5/5; round5 core 75/75; written as
		// [2,1]: round7 cases.json cjk300-single 10/10.
		freeTextOneBytesProven: true,
		// round6 G2000 P1 5/5, D P1 5/5.
		freeTextManyBytesProven: true,
		// round6 G2000 P2 and P3 5/5 each.
		multiSelectManyBytesProven: true,
		// round6 one-question bulk ticks + Other and Other alone 5/5 each; written
		// as [8,1]: round7 cases.json cjk300-multi 10/10, cjk200-multi 5/5,
		// hook-blind-combined 10/10; options-2 [7,1] and options-4 [11,1] 5/5 each.
		multiSelectFreeTextOneBytesProven: true,
		// round6 G2000 multi-a and 4-question 5/5 each; round7 G-SHAPES 5/5.
		multiSelectFreeTextManyBytesProven: true,
		// round5 screens.
		multiSelectFreeTextRowLabel: "Type something",
	},
];

export function pickerContractFor(version: string): PickerContract | null {
	return (
		PICKER_CONTRACTS.find((contract) => contract.version === version) ?? null
	);
}

/** The contract for the build the key sequences are proven against. */
export function provenPickerContract(): PickerContract | null {
	return pickerContractFor(PROVEN_AGAINST);
}

/**
 * The single-select free-text row's label for the proven build, or `null` when
 * that build has no proven single-select free-text sequence / is unknown.
 * Production code reaches for `provenFreeTextOption`, which also knows the shape.
 */
export function provenFreeTextRowLabel(): string | null {
	const contract = provenPickerContract();
	if (contract === null) return null;
	if (!contract.freeTextOneBytesProven && !contract.freeTextManyBytesProven) {
		return null;
	}
	return contract.freeTextRowLabel;
}

/** Every proof ran on prompts of at most this many questions. */
const PROOF_MAX_QUESTIONS = 4;
/** Multi-select free text was proven on questions of 2..4 options. */
const MULTISELECT_FREETEXT_MIN_OPTIONS = 2;
const MULTISELECT_FREETEXT_MAX_OPTIONS = 4;

function inMultiSelectFreeTextOptionRange(optionCount: number): boolean {
	return (
		optionCount >= MULTISELECT_FREETEXT_MIN_OPTIONS &&
		optionCount <= MULTISELECT_FREETEXT_MAX_OPTIONS
	);
}

/**
 * (FREETEXT-N2-PROVEN) THE free-text derivation — the whole of it, in one place.
 *
 * Both the capture PRODUCER
 * (`trpc/router/notifications/companion-question-sink.ts`) and the capture
 * VALIDATOR (`companion/question-store.ts`) call this, so they cannot disagree.
 *
 * Returns `null` — no free-text row offered, and `validateAnswerItem` then refuses
 * any free-text answer for the item — whenever the SHAPE has no proven key
 * sequence on the proven build, or (multi-select) the question is outside the
 * proof range.
 */
export function provenFreeTextOption(input: {
	multiSelect: boolean;
	optionCount: number;
	questionCount: number;
}): { index: number; label: string } | null {
	const contract = provenPickerContract();
	if (contract === null) return null;
	if (input.multiSelect) {
		const proven =
			input.questionCount === 1
				? contract.multiSelectFreeTextOneBytesProven
				: contract.multiSelectFreeTextManyBytesProven;
		if (
			!proven ||
			input.questionCount > PROOF_MAX_QUESTIONS ||
			!inMultiSelectFreeTextOptionRange(input.optionCount)
		) {
			return null;
		}
		if (contract.multiSelectFreeTextRowLabel === null) {
			throw new Error(
				`(MSEL-FREETEXT-PROVEN) ${contract.version} claims a proven multi-select free-text sequence but records no row label`,
			);
		}
		return {
			index: input.optionCount,
			label: contract.multiSelectFreeTextRowLabel,
		};
	}
	const proven =
		input.questionCount === 1
			? contract.freeTextOneBytesProven
			: contract.freeTextManyBytesProven;
	return proven
		? { index: input.optionCount, label: contract.freeTextRowLabel }
		: null;
}

// ---------------------------------------------------------------------------
// bytes
// ---------------------------------------------------------------------------

/**
 * (ANSWER-CSIU-ENCODING) The byte table, one place:
 *
 *   select_digit / toggle_digit / freetext_open   CSI-u digit, `\x1b[<48+d>u`
 *   freetext_body                                 `\x1b[200~` text `\x1b[201~`
 *   submit_tab                                    `\x1b[C` (raw)
 *   submit_return                                 `\x1b[13u`
 *   focus_down                                    `\x1b[B` (raw)
 *
 * When Claude is slow, separate writes merge into one read. Static analysis of
 * the pinned 2.1.303 claude.exe (zero-based byte offsets) shows why raw keys
 * break there and these survive:
 *  - 225017607: raw C0 bytes split from text only in a read under 64 UTF-16
 *    units; in a longer read a raw CR stays inside the text (243810438 inserts
 *    it, 243780925 renders it as a line break), so it never submits.
 *  - 225017267 / 239338405: contiguous text is ONE key event, and the picker
 *    accepts `/^[0-9]$/` only (249508113), so a merged "13" or "4hello" toggles
 *    nothing.
 *  - 239333117 / 239342282 / 239339984: CSI-u keys parse as their own events
 *    with no negotiation gate; code 13 is Return.
 *  - 239337321: a bracketed paste is one paste event; 239443928 flushes sync
 *    work between actionable events in one read.
 * Return is always outside the paste brackets.
 */
const KEY_RIGHT_ARROW = "\x1b[C";
const KEY_DOWN_ARROW = "\x1b[B";
const KEY_RETURN = "\x1b[13u";
/** Never emitted. The self-checks still treat it as a Return wherever it appears. */
const RAW_CARRIAGE_RETURN = "\r";
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/** The CSI-u key for picker row `row` (1..9). */
function csiuDigit(row: number): string {
	return `\x1b[${48 + row}u`;
}

function pasteFrame(text: string): string {
	return `${PASTE_START}${text}${PASTE_END}`;
}

/** Highest option index that can be addressed by a single digit ("9"). */
export const MAX_DIGIT_ADDRESSABLE_INDEX = 8;

/**
 * PROTOCOL §11.2 — a free-text answer is 1..300 UTF-16 units, on both free-text
 * kinds. Proven at that length: round5 24/24, round6 single and multi 300 5/5
 * each, round7 G-CJK300 20/20.
 */
export const FREETEXT_MAX_CHARS = 300;

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

export type KeystrokeEncodingReason =
	/** The prompt/answer combination has no PROVEN key sequence. Never guessed. */
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
	/**
	 * A plain `multiselect` with empty `optionIndexes`. Zero toggles is
	 * mechanically drivable (a bare advance arrow) but the CLI then OMITS the
	 * question from the agent's tool_result (tmp/pty-proof-msel/PROOF.md §3), so
	 * an empty selection cannot be committed as if it were an answer.
	 */
	| "empty_selection"
	/** An option index needs two digits; a single digit cannot address it. */
	| "digit_out_of_range"
	/** Free text was empty, too long, or carried control bytes. */
	| "freetext_invalid"
	/** The emitted sequence failed its own post-encode shape assertion. */
	| "encoder_self_check";

/**
 * Every one of these means NOTHING WAS WRITTEN — this module is pure and runs
 * entirely before the injector takes the terminal lock. The caller maps it to
 * `400 bad_request` (client sent something impossible) or
 * `501 capability_unsupported` (`shape_unproven`), and writes nothing.
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

/** The shapes with a PROVEN key sequence. Anything else is `shape_unproven`. */
export type AnswerShape =
	/** Exactly one single-select question: `[digit]`. Atomic select+submit. */
	| "single_select_one"
	/** N > 1 questions, ALL single-select, ALL answered by digit: `[digit × N, Return]`. */
	| "single_select_many"
	/** Exactly one multi-select question: `[toggle × k, Right, Return]`. */
	| "multiselect_one"
	/** Exactly one question answered with free text: `[digit N+1, text, Return]`. */
	| "freetext_one"
	/**
	 * Exactly one multi-select question answered with ticks plus free text:
	 * `[toggle × k, Down × options, text, Down, Return, Return]`.
	 */
	| "multiselect_freetext_one"
	/**
	 * (FREETEXT-N2-PROVEN) N > 1 single-select questions, at least one answered
	 * with free text, then the review-screen Return.
	 */
	| "freetext_many"
	/**
	 * (MSEL-N2-PROVEN) N > 1 questions, at least one multi-select. Per question
	 * a digit, a single-select free-text group, `[toggle × k, Right]`, or
	 * `[toggle × k, Down × options, text, Down, Return]`; then the review-screen
	 * Return.
	 */
	| "multiselect_many";

export type KeystrokeKind =
	/** A digit that selects (and, when it is the only one, submits). */
	| "select_digit"
	/** A digit that TOGGLES a multi-select row. */
	| "toggle_digit"
	/** The digit that opens a single-select question's inline free-text editor. */
	| "freetext_open"
	/** The free-text body. */
	| "freetext_body"
	/** Down. Moves a multi-select caret onto "Type something" and off it again. */
	| "focus_down"
	/**
	 * Right. On a lone multi-select it moves onto the Submit tab; inside an
	 * N > 1 prompt it ADVANCES a multi-select question. Never itself a submit.
	 */
	| "submit_tab"
	/** Return — submits a review screen, closes an editor, or presses Next/Submit. */
	| "submit_return";

export interface Keystroke {
	kind: KeystrokeKind;
	/** The exact bytes, written verbatim by the raw pty writer. Never reframed. */
	data: string;
	/** 0-based index of the `QuestionItem` this keystroke acts on. */
	questionIndex: number;
	/** The option index this keystroke selects/toggles/opens, when applicable. */
	optionIndex: number | null;
	/**
	 * true => after this keystroke the prompt is submitted and the picker is
	 * gone. Exactly one keystroke in a sequence carries this.
	 */
	submits: boolean;
}

/** One write: the keys of one picker screen, or the final Return alone. */
export interface KeystrokeFrame {
	data: string;
	keystrokes: readonly Keystroke[];
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
			if (answer.optionIndexes.length === 0) {
				throw new KeystrokeEncodingError(
					"empty_selection",
					`item ${item.index} selects nothing; the desk CLI silently drops an untoggled multi-select question from the agent's result, so an empty selection cannot be committed`,
				);
			}
			assertSortedUniqueOptions(answer.optionIndexes, optionCount, item.index);
			return;
		}
		case "freetext": {
			// PROTOCOL §11.3: `kind` MUST match the item's `multiSelect` flag AND
			// the presence of `freeTextOption`. A multi-select item's free text is
			// the separate `multiselect_freetext` kind, with its own key group.
			if (item.multiSelect) {
				throw new KeystrokeEncodingError(
					"kind_mismatch",
					`item ${item.index} is multiSelect; its free text is "multiselect_freetext", never "freetext"`,
				);
			}
			assertFreeTextSlot(item);
			assertFreeText(answer.text, item.index);
			return;
		}
		case "multiselect_freetext": {
			if (!item.multiSelect) {
				throw new KeystrokeEncodingError(
					"kind_mismatch",
					`item ${item.index} is single-select; "multiselect_freetext" is never coerced into it`,
				);
			}
			assertFreeTextSlot(item);
			assertSortedUniqueOptions(answer.optionIndexes, optionCount, item.index);
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

/** The item's free-text slot index, which must sit right after its options. */
function assertFreeTextSlot(item: QuestionItem): number {
	if (item.freeTextOption === null) {
		throw new KeystrokeEncodingError(
			"kind_mismatch",
			`item ${item.index} has no free-text slot`,
		);
	}
	if (item.freeTextOption.index !== item.options.length) {
		throw new KeystrokeEncodingError(
			"option_out_of_range",
			`item ${item.index} free-text slot is ${item.freeTextOption.index}, expected ${item.options.length}`,
		);
	}
	return item.freeTextOption.index;
}

function assertSortedUniqueOptions(
	optionIndexes: readonly number[],
	optionCount: number,
	itemIndex: number,
): void {
	let previous = -1;
	for (const optionIndex of optionIndexes) {
		assertOptionIndex(optionIndex, optionCount, itemIndex);
		if (optionIndex === previous) {
			throw new KeystrokeEncodingError(
				"duplicate_option",
				`item ${itemIndex} repeats option ${optionIndex}; two toggles cancel out, so this is refused rather than normalised`,
			);
		}
		if (optionIndex < previous) {
			throw new KeystrokeEncodingError(
				"unsorted_options",
				`item ${itemIndex} optionIndexes must be sorted ascending`,
			);
		}
		previous = optionIndex;
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
 * The complete, explicit allow-list of C0 control characters inside a picker
 * free-text body. It is EMPTY: every C0 byte and DEL is REFUSED, never
 * stripped, because stripping would send text the user did not write.
 *
 *  - `\x1b` (0x1B) would end the bracketed paste early (`\x1b[201~`) and let the
 *    rest of the text drive the TUI directly.
 *  - `\r` (0x0D) and `\n` (0x0A) were never driven inside a picker body; an
 *    unproven byte is refused rather than guessed at.
 *  - `\t` (0x09) moves focus between the picker's tabs.
 *  - the rest of C0 has no meaning as typed text and is terminal control.
 *  - DEL (0x7F) and C1 (0x80..0x9F) are refused by the scan itself and can never
 *    be allow-listed: `U+009B` is CSI, the single-character `ESC [`.
 */
const FREETEXT_ALLOWED_C0: ReadonlySet<number> = new Set<number>();

/**
 * The allow-list for a `/v1/message` body, which is a DIFFERENT writer with a
 * different proof: `writeFramedInputToSession` frames the body as a bracketed
 * paste into the composer, which carries LF and TAB as literal characters.
 *
 * Kept as a separate constant rather than by widening `FREETEXT_ALLOWED_C0`,
 * because one writer's genuine need must never loosen the other writer's
 * validator. §0.3 of PROTOCOL.md is the normative table both runtimes implement.
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
 * option.
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
 * "Control" is the full set PROTOCOL §0.3 names: C0 `U+0000`..`U+001F`, DEL
 * `U+007F` and C1 `U+0080`..`U+009F`. `U+009B` is CSI — Node encodes it as
 * `c2 9b`, which a UTF-8 terminal consumes as a control-sequence introducer — and
 * `U+0085` (NEL) is a line break by another name.
 *
 * The scan is over UTF-16 code units, the same unit both runtimes count length
 * in, so an index reported here means the same position on both sides.
 *
 * `allowed` is REQUIRED and names the policy explicitly at each call site: the
 * picker's free-text body passes `FREETEXT_ALLOWED_C0` (empty), `/v1/message`
 * passes `MESSAGE_ALLOWED_C0` (`{LF, TAB}`). An allow-list may only ever name C0
 * members.
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

function shapeUnproven(message: string): KeystrokeEncodingError {
	return new KeystrokeEncodingError("shape_unproven", message);
}

/**
 * Classifies a validated (questions, answers) pair into one of the PROVEN
 * shapes, or throws `shape_unproven`.
 *
 * Call `validateAnswerItems` first — this assumes the pair is already
 * structurally sound.
 */
export function classifyAnswerShape(
	questions: readonly QuestionItem[],
	answers: readonly AnswerItem[],
): AnswerShape {
	if (questions.length > PROOF_MAX_QUESTIONS) {
		throw shapeUnproven(
			`a ${questions.length}-question prompt is outside the proof range (at most ${PROOF_MAX_QUESTIONS}); refused rather than guessed`,
		);
	}
	const contract = provenPickerContract();
	let sawFreeText = false;
	let sawMultiSelect = false;
	let sawMultiSelectFreeText = false;
	for (let i = 0; i < answers.length; i += 1) {
		const answer = answers[i];
		const item = questions[i];
		if (answer === undefined || item === undefined) {
			throw new KeystrokeEncodingError(
				"arity_mismatch",
				`missing answer or question item at position ${i}`,
			);
		}
		if (answer.kind === "freetext") sawFreeText = true;
		if (answer.kind === "multiselect") sawMultiSelect = true;
		if (answer.kind !== "multiselect_freetext") continue;
		sawMultiSelectFreeText = true;
		const optionCount = item.options.length;
		if (!inMultiSelectFreeTextOptionRange(optionCount)) {
			throw shapeUnproven(
				`multi-select free text on a ${optionCount}-option question is outside the proof range (${MULTISELECT_FREETEXT_MIN_OPTIONS}..${MULTISELECT_FREETEXT_MAX_OPTIONS} options); refused rather than guessed`,
			);
		}
	}

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
			case "multiselect_freetext":
				if (contract?.multiSelectFreeTextOneBytesProven !== true) {
					throw shapeUnproven(
						`multi-select free text on a one-question prompt has no proven key sequence on ${PROVEN_AGAINST}; refused rather than guessed`,
					);
				}
				return "multiselect_freetext_one";
			default: {
				const unreachable: never = only;
				throw new KeystrokeEncodingError(
					"kind_mismatch",
					`unknown answer kind: ${JSON.stringify(unreachable)}`,
				);
			}
		}
	}

	// N > 1. Every group leaves the picker on the NEXT question, so they compose.
	if (sawMultiSelect && contract?.multiSelectManyBytesProven !== true) {
		throw shapeUnproven(
			`a multi-select group inside a ${questions.length}-question prompt has no proven key sequence on ${PROVEN_AGAINST}; refused rather than guessed`,
		);
	}
	if (
		sawMultiSelectFreeText &&
		contract?.multiSelectFreeTextManyBytesProven !== true
	) {
		throw shapeUnproven(
			`a multi-select free-text group inside a ${questions.length}-question prompt has no proven key sequence on ${PROVEN_AGAINST}; refused rather than guessed`,
		);
	}
	if (sawMultiSelect || sawMultiSelectFreeText) return "multiselect_many";
	return sawFreeText ? "freetext_many" : "single_select_many";
}

// ---------------------------------------------------------------------------
// encoding
// ---------------------------------------------------------------------------

/**
 * The picker numbers its rows from 1; the protocol indexes options from 0.
 * A single digit can only address 1..9, so an option at index >= 9 has NO
 * single-key encoding. Pressing "1" then "0" for row 10 would select row 1 and
 * then press 0 — a different, wrong, irreversible answer. Refused.
 */
export function digitFor(optionIndex: number, itemIndex: number): string {
	if (optionIndex > MAX_DIGIT_ADDRESSABLE_INDEX) {
		throw new KeystrokeEncodingError(
			"digit_out_of_range",
			`item ${itemIndex} option ${optionIndex} needs row ${optionIndex + 1}, which is not a single digit; refused (typing "1" then "0" would select row 1 and then press 0)`,
		);
	}
	return csiuDigit(optionIndex + 1);
}

/**
 * Intent -> the exact key sequence, one frame per write. Pure: it touches no
 * terminal, holds no lock and has no side effects, so every failure here is
 * provably "nothing was written".
 */
export function encodeAnswer(
	questions: readonly QuestionItem[],
	answers: readonly AnswerItem[],
): KeystrokeFrame[] {
	validateAnswerItems(questions, answers);
	const shape = classifyAnswerShape(questions, answers);
	const keystrokes = encodeKeys(questions, answers);
	assertEmittedShape(shape, questions, keystrokes);
	assertNoReturnIntoMultiSelect(questions, keystrokes);
	const frames = groupFrames(keystrokes);
	assertFrameGrouping(frames);
	return frames;
}

/**
 * One write per picker screen: a frame ends after a selecting digit, a Right or
 * a Return, and always before the final key, so the final Return is a write of
 * its own. A one-key answer is one frame.
 */
function groupFrames(keystrokes: readonly Keystroke[]): KeystrokeFrame[] {
	const frames: KeystrokeFrame[] = [];
	let run: Keystroke[] = [];
	keystrokes.forEach((keystroke, index) => {
		run.push(keystroke);
		const endsFrame =
			keystroke.kind === "select_digit" ||
			keystroke.kind === "submit_tab" ||
			keystroke.kind === "submit_return" ||
			index >= keystrokes.length - 2;
		if (!endsFrame) return;
		frames.push({ data: run.map((key) => key.data).join(""), keystrokes: run });
		run = [];
	});
	return frames;
}

const SCREEN_CLOSING_KINDS: ReadonlySet<KeystrokeKind> = new Set([
	"select_digit",
	"submit_tab",
	"submit_return",
]);

/**
 * The final write is the submitting key alone, and every earlier write is a
 * whole picker screen. The write just before the final one may end on any key:
 * the final key always splits off, so a lone free-text answer ends there on
 * its paste.
 */
export function assertFrameGrouping(frames: readonly KeystrokeFrame[]): void {
	if (frames.length <= 1) return;
	const finalFrame = frames[frames.length - 1];
	const finalKey = finalFrame?.keystrokes[0];
	if (
		finalFrame?.keystrokes.length !== 1 ||
		finalKey?.submits !== true ||
		finalFrame.data !== finalKey.data
	) {
		throw selfCheck("the final write is not the submitting key alone");
	}
	for (const [index, frame] of frames.slice(0, -1).entries()) {
		const closing = frame.keystrokes[frame.keystrokes.length - 1];
		if (closing === undefined) {
			throw selfCheck(`write ${index} of ${frames.length} is empty`);
		}
		if (
			index < frames.length - 2 &&
			!SCREEN_CLOSING_KINDS.has(closing.kind)
		) {
			throw selfCheck(
				`write ${index} of ${frames.length} ends on ${closing.kind}, inside a picker screen`,
			);
		}
	}
}

function toggleKeys(
	optionIndexes: readonly number[],
	questionIndex: number,
): Keystroke[] {
	return optionIndexes.map((optionIndex) => ({
		kind: "toggle_digit",
		data: digitFor(optionIndex, questionIndex),
		questionIndex,
		optionIndex,
		submits: false,
	}));
}

/**
 * `[toggle × k, Right]`. On a lone question Right moves onto the Submit tab; in
 * an N > 1 prompt it ADVANCES (MSEL-N2-PROVEN). A Return on the rows would
 * TOGGLE the caret's row instead.
 */
function plainMultiSelectKeys(
	optionIndexes: readonly number[],
	questionIndex: number,
): Keystroke[] {
	return [
		...toggleKeys(optionIndexes, questionIndex),
		{
			kind: "submit_tab",
			data: KEY_RIGHT_ARROW,
			questionIndex,
			optionIndex: null,
			submits: false,
		},
	];
}

function focusDown(questionIndex: number): Keystroke {
	return {
		kind: "focus_down",
		data: KEY_DOWN_ARROW,
		questionIndex,
		optionIndex: null,
		submits: false,
	};
}

/** The Return that submits the review screen (or a lone multi-select's Submit tab). */
function reviewReturn(questionIndex: number): Keystroke {
	return {
		kind: "submit_return",
		data: KEY_RETURN,
		questionIndex,
		optionIndex: null,
		submits: true,
	};
}

/** `[digit N+1, text, Return]`. The Return submits a lone question, else advances. */
function singleSelectFreeTextKeys(
	item: QuestionItem,
	text: string,
	questionIndex: number,
	submits: boolean,
): Keystroke[] {
	const slot = assertFreeTextSlot(item);
	return [
		{
			kind: "freetext_open",
			data: digitFor(slot, questionIndex),
			questionIndex,
			optionIndex: slot,
			submits: false,
		},
		{
			kind: "freetext_body",
			data: pasteFrame(text),
			questionIndex,
			optionIndex: slot,
			submits: false,
		},
		{
			kind: "submit_return",
			data: KEY_RETURN,
			questionIndex,
			optionIndex: slot,
			submits,
		},
	];
}

/**
 * `[toggle × k, Down × options, text, Down, Return]`. The caret starts on the
 * first option (the desk-touch fence refuses any answer to a touched picker), so
 * `options.length` Downs land on "Type something" whatever was toggled. The
 * Return presses Submit on a lone question, else advances; it never submits.
 */
function multiSelectFreeTextKeys(
	item: QuestionItem,
	optionIndexes: readonly number[],
	text: string,
	questionIndex: number,
): Keystroke[] {
	const slot = assertFreeTextSlot(item);
	return [
		...toggleKeys(optionIndexes, questionIndex),
		...item.options.map(() => focusDown(questionIndex)),
		{
			kind: "freetext_body",
			data: pasteFrame(text),
			questionIndex,
			optionIndex: slot,
			submits: false,
		},
		focusDown(questionIndex),
		{
			kind: "submit_return",
			data: KEY_RETURN,
			questionIndex,
			optionIndex: slot,
			submits: false,
		},
	];
}

/** One question's key group. On a lone question a digit or free-text Return submits. */
function questionKeys(
	item: QuestionItem,
	answer: AnswerItem,
	questionIndex: number,
	alone: boolean,
): Keystroke[] {
	switch (answer.kind) {
		case "select":
			return [
				{
					kind: "select_digit",
					data: digitFor(answer.optionIndex, questionIndex),
					questionIndex,
					optionIndex: answer.optionIndex,
					submits: alone,
				},
			];
		case "multiselect":
			return plainMultiSelectKeys(answer.optionIndexes, questionIndex);
		case "freetext":
			return singleSelectFreeTextKeys(item, answer.text, questionIndex, alone);
		case "multiselect_freetext":
			return multiSelectFreeTextKeys(
				item,
				answer.optionIndexes,
				answer.text,
				questionIndex,
			);
		default: {
			const unreachable: never = answer;
			throw new KeystrokeEncodingError(
				"kind_mismatch",
				`item ${questionIndex} carries an unknown answer kind: ${JSON.stringify(unreachable)}`,
			);
		}
	}
}

/**
 * One group per question, then the review-screen Return unless the last group
 * already submitted.
 *
 * Free text on the LAST question of N > 1 emits two consecutive Returns: the
 * first closes the editor (or presses Next) and lands on the review screen, the
 * second submits. Both were driven; neither is inferred from the other.
 */
function encodeKeys(
	questions: readonly QuestionItem[],
	answers: readonly AnswerItem[],
): Keystroke[] {
	const alone = questions.length === 1;
	const keystrokes: Keystroke[] = [];
	for (let i = 0; i < answers.length; i += 1) {
		const answer = answers[i];
		const item = questions[i];
		if (answer === undefined || item === undefined) {
			throw new KeystrokeEncodingError(
				"arity_mismatch",
				`missing answer or question item at position ${i}`,
			);
		}
		keystrokes.push(...questionKeys(item, answer, i, alone));
	}
	if (keystrokes[keystrokes.length - 1]?.submits !== true) {
		keystrokes.push(reviewReturn(questions.length - 1));
	}
	return keystrokes;
}

// ---------------------------------------------------------------------------
// post-encode self-check
// ---------------------------------------------------------------------------

function selfCheck(message: string): KeystrokeEncodingError {
	return new KeystrokeEncodingError("encoder_self_check", message);
}

function isReturnKey(keystroke: Keystroke): boolean {
	return (
		keystroke.kind === "submit_return" ||
		keystroke.data.includes(KEY_RETURN) ||
		keystroke.data.includes(RAW_CARRIAGE_RETURN)
	);
}

/**
 * (SELFCHECK-BYTES) The DATA grammar: the exact bytes each `KeystrokeKind` is
 * permitted to carry, against the `(ANSWER-CSIU-ENCODING)` table. Labels are
 * what a future bug gets wrong; bytes are what the picker consumes, so bytes are
 * what is asserted.
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
				const optionIndex = keystroke.optionIndex;
				if (
					optionIndex === null ||
					!Number.isInteger(optionIndex) ||
					optionIndex < 0 ||
					optionIndex > MAX_DIGIT_ADDRESSABLE_INDEX
				) {
					throw selfCheck(
						`${at}: a digit key must name an option 0..${MAX_DIGIT_ADDRESSABLE_INDEX}, got ${String(optionIndex)}`,
					);
				}
				if (keystroke.data !== csiuDigit(optionIndex + 1)) {
					throw selfCheck(
						`${at}: data must be the CSI-u key for row ${optionIndex + 1}, got ${JSON.stringify(keystroke.data)}`,
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
			case "focus_down": {
				if (keystroke.data !== KEY_DOWN_ARROW) {
					throw selfCheck(
						`${at}: data must be the down-arrow escape, got ${JSON.stringify(keystroke.data)}`,
					);
				}
				if (keystroke.submits) {
					throw selfCheck(`${at}: a Down key never submits`);
				}
				break;
			}
			case "submit_return": {
				if (keystroke.data !== KEY_RETURN) {
					throw selfCheck(
						`${at}: data must be exactly the CSI-u Return, got ${JSON.stringify(keystroke.data)}`,
					);
				}
				break;
			}
			case "freetext_body": {
				const { data } = keystroke;
				if (!data.startsWith(PASTE_START) || !data.endsWith(PASTE_END)) {
					throw selfCheck(`${at}: the body must be one bracketed paste`);
				}
				// Same boundary rules as the request that produced it; no ESC, so the
				// text cannot close the brackets itself.
				assertFreeText(
					data.slice(PASTE_START.length, data.length - PASTE_END.length),
					keystroke.questionIndex,
				);
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
 * Walks one multi-select free-text group starting at `start` and returns the
 * index after it. The Down count must reach the question's own "Type something"
 * row, and the group's Return never submits.
 */
function walkMultiSelectFreeTextGroup(
	shape: AnswerShape,
	questions: readonly QuestionItem[],
	keystrokes: readonly Keystroke[],
	start: number,
	question: number,
): number {
	const optionCount = questions[question]?.options.length;
	if (optionCount === undefined) {
		throw selfCheck(`${shape}: question ${question} does not exist`);
	}
	let cursor = start;
	while (
		keystrokes[cursor]?.kind === "toggle_digit" &&
		keystrokes[cursor]?.questionIndex === question
	) {
		cursor += 1;
	}
	let downs = 0;
	while (
		keystrokes[cursor]?.kind === "focus_down" &&
		keystrokes[cursor]?.questionIndex === question
	) {
		downs += 1;
		cursor += 1;
	}
	if (downs !== optionCount) {
		throw selfCheck(
			`${shape} question ${question}: "Type something" is ${optionCount} Down presses below the first option, got ${downs}`,
		);
	}
	const body = keystrokes[cursor];
	const down = keystrokes[cursor + 1];
	const close = keystrokes[cursor + 2];
	if (
		body?.kind !== "freetext_body" ||
		body.questionIndex !== question ||
		down?.kind !== "focus_down" ||
		down.questionIndex !== question ||
		close?.kind !== "submit_return" ||
		close.questionIndex !== question ||
		close.submits
	) {
		throw selfCheck(
			`${shape} question ${question} free-text group must be [toggle_digit × k, focus_down × ${optionCount}, freetext_body, focus_down, submit_return]`,
		);
	}
	return cursor + 3;
}

/**
 * (SELFCHECK-BYTES) The SEQUENCE grammar: which kinds may appear, in what order,
 * for each proven shape. Checked against the emitted array rather than against
 * the encoder's intent.
 */
function assertShapeGrammar(
	shape: AnswerShape,
	questions: readonly QuestionItem[],
	keystrokes: readonly Keystroke[],
): void {
	const kinds = keystrokes.map((keystroke) => keystroke.kind);
	switch (shape) {
		case "single_select_one": {
			if (kinds.length !== 1 || kinds[0] !== "select_digit") {
				throw selfCheck(
					`single_select_one must be exactly one digit — no Return, ever; got [${kinds.join(", ")}]`,
				);
			}
			return;
		}
		case "single_select_many": {
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
		case "multiselect_freetext_one": {
			const end = walkMultiSelectFreeTextGroup(
				shape,
				questions,
				keystrokes,
				0,
				0,
			);
			if (end !== keystrokes.length - 1 || kinds[end] !== "submit_return") {
				throw selfCheck(
					`multiselect_freetext_one must be the free-text group then the review-screen return; got [${kinds.join(", ")}]`,
				);
			}
			return;
		}
		case "freetext_many":
		case "multiselect_many": {
			// One GROUP per question, in question order, then the review-screen
			// return. freetext_many must carry a free-text group and no multi-select
			// one; multiselect_many must carry a multi-select one.
			const trailing = keystrokes[keystrokes.length - 1];
			if (trailing?.kind !== "submit_return" || !trailing.submits) {
				throw selfCheck(
					`${shape} must end with the submitting review-screen return; got [${kinds.join(", ")}]`,
				);
			}
			let index = 0;
			let question = 0;
			let freeTextGroups = 0;
			let multiSelectGroups = 0;
			while (index < keystrokes.length - 1) {
				const first = keystrokes[index];
				if (first?.questionIndex !== question) {
					throw selfCheck(
						`${shape} position ${index} answers question ${first?.questionIndex}, expected ${question}; groups must run 0..N-1 in order`,
					);
				}
				const multiSelect = questions[question]?.multiSelect === true;
				const singleSelectGroup =
					first.kind === "select_digit" || first.kind === "freetext_open";
				if (singleSelectGroup === multiSelect) {
					throw selfCheck(
						`${shape} question ${question}: a ${first.kind} group does not belong on a ${multiSelect ? "multi" : "single"}-select question`,
					);
				}
				if (first.kind === "select_digit") {
					index += 1;
				} else if (first.kind === "freetext_open") {
					const body = keystrokes[index + 1];
					const close = keystrokes[index + 2];
					if (
						body?.kind !== "freetext_body" ||
						close?.kind !== "submit_return" ||
						body.questionIndex !== question ||
						close.questionIndex !== question
					) {
						throw selfCheck(
							`${shape} question ${question} free-text group must be [freetext_open, freetext_body, submit_return]; got [${kinds.join(", ")}]`,
						);
					}
					// The editor-closing return ADVANCES; only the review-screen one
					// submits.
					if (close.submits) {
						throw selfCheck(
							`${shape} question ${question}: the editor-closing return advances to the next question, it does not submit`,
						);
					}
					freeTextGroups += 1;
					index += 3;
				} else {
					let cursor = index;
					while (
						keystrokes[cursor]?.kind === "toggle_digit" &&
						keystrokes[cursor]?.questionIndex === question
					) {
						cursor += 1;
					}
					const advance = keystrokes[cursor];
					if (
						advance?.kind === "submit_tab" &&
						advance.questionIndex === question &&
						!advance.submits
					) {
						index = cursor + 1;
					} else {
						index = walkMultiSelectFreeTextGroup(
							shape,
							questions,
							keystrokes,
							index,
							question,
						);
					}
					multiSelectGroups += 1;
				}
				question += 1;
			}
			if (question < 2 || question !== questions.length) {
				throw selfCheck(
					`${shape} covers ${question} question(s) of ${questions.length}; it is the N > 1 shape`,
				);
			}
			if (trailing.questionIndex !== question - 1) {
				throw selfCheck(
					`${shape} review-screen return names question ${trailing.questionIndex}, expected the last one (${question - 1})`,
				);
			}
			if (shape === "freetext_many" && freeTextGroups === 0) {
				throw selfCheck(
					"freetext_many carries no free-text group; an all-digit prompt is single_select_many",
				);
			}
			if (shape === "freetext_many" && multiSelectGroups > 0) {
				throw selfCheck(
					"freetext_many carries a multi-select group; that prompt is multiselect_many",
				);
			}
			if (shape === "multiselect_many" && multiSelectGroups === 0) {
				throw selfCheck(
					"multiselect_many carries no multi-select group; that prompt is freetext_many or single_select_many",
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
 * A second, independent pass over the emitted sequence: the DATA each keystroke
 * carries, the ORDER of kinds for this shape, exactly one submitting keystroke
 * and it last, and the one-question multi-select submit tails.
 */
export function assertEmittedShape(
	shape: AnswerShape,
	questions: readonly QuestionItem[],
	keystrokes: readonly Keystroke[],
): void {
	if (keystrokes.length === 0) {
		throw selfCheck(`shape ${shape} produced no keystrokes`);
	}

	assertKeystrokeBytes(shape, keystrokes);
	assertShapeGrammar(shape, questions, keystrokes);

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
 * A naive "append Enter to submit" against a multi-select TOGGLES a row instead
 * of submitting. On the one-question multi-select shapes the raw bytes must end
 * with the proven submit tail and carry no Return — by kind or in either byte
 * form — anywhere before it.
 */
export function assertMultiSelectSubmitShape(
	shape: AnswerShape,
	keystrokes: readonly Keystroke[],
): void {
	const tail =
		shape === "multiselect_one"
			? { bytes: `${KEY_RIGHT_ARROW}${KEY_RETURN}`, returns: 1 }
			: shape === "multiselect_freetext_one"
				? {
						bytes: `${PASTE_END}${KEY_DOWN_ARROW}${KEY_RETURN}${KEY_RETURN}`,
						returns: 2,
					}
				: null;
	if (tail === null) return;

	const raw = keystrokes.map((keystroke) => keystroke.data).join("");
	if (!raw.endsWith(tail.bytes)) {
		throw selfCheck(
			`${shape} bytes do not end with the proven submit tail; a return that is not preceded by it toggles a row`,
		);
	}
	if (
		keystrokes.slice(0, keystrokes.length - tail.returns).some(isReturnKey)
	) {
		throw selfCheck(
			`${shape} carries a return before the submit tail; every such return silently flips a selection`,
		);
	}
}

/**
 * (MSEL-N2-PROVEN) The one absolute rule of the multi-select contract, checked
 * against the BYTES, the kinds and the PROMPT: a Return (by kind, or `\r` /
 * `\x1b[13u` in the data) may target a multi-select question only as the
 * sequence-final submit or right after `[freetext_body, focus_down]` of that
 * question. Anywhere else it TOGGLES the caret's row and silently adds an option
 * nobody chose. Runs for EVERY shape.
 */
export function assertNoReturnIntoMultiSelect(
	questions: readonly QuestionItem[],
	keystrokes: readonly Keystroke[],
): void {
	for (let index = 0; index < keystrokes.length; index += 1) {
		const keystroke = keystrokes[index];
		if (keystroke === undefined || !isReturnKey(keystroke)) continue;
		const item = questions[keystroke.questionIndex];
		if (item === undefined) {
			throw selfCheck(
				`keystroke ${index} targets question ${keystroke.questionIndex}, which does not exist`,
			);
		}
		if (!item.multiSelect) continue;
		if (index === keystrokes.length - 1 && keystroke.submits) continue;
		const down = keystrokes[index - 1];
		const body = keystrokes[index - 2];
		if (
			down?.kind === "focus_down" &&
			down.questionIndex === keystroke.questionIndex &&
			body?.kind === "freetext_body" &&
			body.questionIndex === keystroke.questionIndex
		) {
			continue;
		}
		throw selfCheck(
			`keystroke ${index} carries a return into multi-select question ${keystroke.questionIndex}; a return there toggles the caret's row and silently adds an option nobody chose`,
		);
	}
}

// ---------------------------------------------------------------------------
// the raw writer — making the wrong writer impossible to wire
// ---------------------------------------------------------------------------

export interface RawWriteTarget {
	terminalId: string;
	workspaceId: string;
}

export interface RawWriteInput extends RawWriteTarget {
	data: string;
	/** How long to wait for the daemon's acknowledgement before reporting `unknown`. */
	ackTimeoutMs: number;
}

export type RawPrepareResult =
	| { success: true; acknowledgedInputSupported: boolean }
	| { error: string };

export type RawWriteResult =
	| { success: true }
	| {
			error: string;
			/** Whether the failed acknowledgement still leaves a possible PTY write. */
			writeOutcome: AcknowledgedInputFailureKind;
	  };

export const RAW_PTY_WRITER_KIND = "companion-raw-pty-ack-v1" as const;

/**
 * An acknowledged, unframed PTY write. Success means the daemon's `pty.write`
 * returned, not merely that a socket frame was queued.
 */
export type RawWriteFn = ((input: RawWriteInput) => Promise<RawWriteResult>) & {
	readonly writerKind: typeof RAW_PTY_WRITER_KIND;
	prepare(input: RawWriteTarget): Promise<RawPrepareResult>;
};

const RAW_PTY_WRITER_BRAND: unique symbol = Symbol("RAW_PTY_WRITER_BRAND");

export interface RawPtyWriter {
	readonly [RAW_PTY_WRITER_BRAND]: "writeAcknowledgedInputToSession";
	prepare(input: RawWriteTarget): Promise<RawPrepareResult>;
	write(input: RawWriteInput): Promise<RawWriteResult>;
}

/**
 * Wraps the acknowledged raw writer and fails loud if the composition root wires
 * the fire-and-forget or paste-framed path instead. The explicit runtime marker
 * survives bundling and distinguishes async writers whose return shape alone can
 * no longer do so.
 */
export function createRawPtyWriter(
	writeAcknowledgedInputToSession: RawWriteFn,
): RawPtyWriter {
	if (typeof writeAcknowledgedInputToSession !== "function") {
		throw new Error(
			"(COMPANION-BRIDGE) raw pty writer: expected a function, got " +
				typeof writeAcknowledgedInputToSession,
		);
	}
	if (writeAcknowledgedInputToSession.writerKind !== RAW_PTY_WRITER_KIND) {
		throw new Error(
			"(COMPANION-BRIDGE) raw pty writer is not the acknowledged terminal " +
				"writer; refusing a path that could confirm before daemon pty.write.",
		);
	}
	if (typeof writeAcknowledgedInputToSession.prepare !== "function") {
		throw new Error(
			"(COMPANION-BRIDGE) raw pty writer has no headless prepare step",
		);
	}

	return {
		[RAW_PTY_WRITER_BRAND]: "writeAcknowledgedInputToSession",
		prepare: (input) => writeAcknowledgedInputToSession.prepare(input),
		write: (input) => writeAcknowledgedInputToSession(input),
	};
}
