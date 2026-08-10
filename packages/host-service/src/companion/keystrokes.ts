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
 *     Submitting a LONE multi-select is right-arrow (`\x1b[C`) onto the Submit
 *     tab, THEN `\r`.
 *     => appending Enter "to submit" a multi-select silently FLIPS a selection
 *        and still does not submit. That shape is rejected here by construction:
 *        `encodeAnswer` never emits SUBMIT_RETURN for a multi-select without a
 *        preceding SUBMIT_TAB, and `assertMultiSelectSubmitShape` re-checks the
 *        emitted sequence before it is handed to the injector.
 *
 *   multiSelect inside N > 1  (MSEL-N2-PROVEN)
 *     digits toggle exactly as at N=1, then the SAME `\x1b[C` ADVANCES — to the
 *     next question mid-prompt, to the review screen on the last — and the
 *     review-screen `\r` submits the whole prompt. Driven first, middle and
 *     last, twice each (`tmp/pty-proof-msel/PROOF.md`). The one absolute rule:
 *     NO `\r` may ever land inside a multi-select question — mid-prompt or not,
 *     it TOGGLES the caret's row and silently adds an option nobody chose
 *     (`assertNoReturnIntoMultiSelect` re-checks the emitted sequence). An
 *     earlier refutation of this shape refuted only the N=1 submit PAIR
 *     (`\x1b[C` then `\r`): that trailing `\r` was landing on the NEXT
 *     question. Dropping it and letting the next question's own group run is
 *     the whole difference.
 *
 *   free text, ONE question
 *     digit N+1 (the slot after the last real option) opens an inline editor,
 *     then the UTF-8 text, then `\r`, which SUBMITS the prompt.
 *
 *   free text, N > 1 questions  (FREETEXT-N2-PROVEN)
 *     the SAME three keystrokes per question — digit N+1, the text, `\r` — but
 *     there the `\r` ADVANCES to the next question instead of submitting, exactly
 *     as a bare select digit does. The prompt is submitted by the review-screen
 *     `\r` that already terminates `single_select_many`. So a question answered
 *     with free text and a question answered with a digit compose freely, and
 *     free text on the LAST question emits two consecutive returns: one to leave
 *     the editor, one on the review screen.
 *
 *   bracketed paste is INERT against the picker
 *     `terminal.send` / `writeFramedInputToSession` CANNOT drive it. Only raw
 *     `writeAcknowledgedInputToSession` works, and it reports daemon refusal.
 *     `createRawPtyWriter` makes either wrong writer a loud startup failure.
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
 * behaviour. It stands at 2.1.226 because all three were DRIVEN there and the
 * agent's own `tool_result` confirmed each one; source reading alone would never
 * have earned it. `RENDER_OBSERVED_AGAINST` below is the weaker claim that source
 * reading does support, kept separate so nothing can quietly upgrade one into the
 * other.
 */
export const PROVEN_AGAINST = "claude-code@2.1.226";

/**
 * The build whose RENDERED SHAPE has been observed directly: the free-text labels
 * below, and the row order `[...options, freeText, chat?]` with the chat row
 * carrying the sentinel `"__chat__"`.
 *
 * REFUTED by a live pty run, and corrected here rather than left as folklore: a
 * multi-select picker DOES render a free-text row at N+1 and the chat row at N+2.
 * The binary's `!mL.multiSelect` gate does not mean what the earlier comment
 * claimed. What that row does when its digit is pressed was then driven, twice,
 * and the answer is worse than "unknown" — see `multiSelectFreeTextBytesProven`.
 * Chat-row context-gating is still unconfirmed, so nothing asserts its presence
 * OR its absence.
 *
 * Strictly weaker than `PROVEN_AGAINST` and never a substitute for it. It exists
 * so the copy constants can cite what they are true of without implying the byte
 * contract was re-driven.
 */
export const RENDER_OBSERVED_AGAINST = "claude-code@2.1.226";

/**
 * (PICKER-CONTRACT-VERSIONED) One entry per Claude Code build the fork has
 * OBSERVED, owning both halves of the contract for that build: the bytes, and the
 * exact copy the free-text row renders.
 *
 * The two halves have to live together and be keyed by version, because they were
 * briefly not: the free-text labels pinned 2.1.226's "Type something." while
 * `PROVEN_AGAINST` declared 2.1.220, whose row reads "Other". One of the two was
 * always going to be false, and on the build whose bytes the fork claims to drive
 * the row would never have been found at all.
 *
 * The `*BytesProven` flags are PER SHAPE and per version, because the shapes are
 * genuinely independent behaviours of the same row: on 2.1.226 the one-question
 * and N>1 free-text sequences both work and the multi-select one is actively
 * harmful (see each flag). 2.1.220 is recorded as it was driven at the time —
 * only the one-question shape — and is NOT retro-fitted with claims about a build
 * nobody re-drove.
 *
 * An UNKNOWN version resolves to `null` and everything downstream fails closed.
 * To add a build: append an entry with what a pty run actually showed, and move
 * `PROVEN_AGAINST` only if its bytes were re-driven.
 */
export interface PickerContract {
	version: string;
	/**
	 * The label the free-text row renders, exactly, on a SINGLE-SELECT question.
	 * A multi-select question renders different copy (2.1.226: "Type something",
	 * no full stop) and a checkbox before it, which is deliberately not recorded
	 * as a usable label — no multi-select free-text row is ever pressed.
	 */
	freeTextRowLabel: string;
	/**
	 * Whether `[digit N+1, text, "\r"]` was driven on a prompt of exactly ONE
	 * single-select question, where the `\r` submits the whole prompt.
	 */
	freeTextOneBytesProven: boolean;
	/**
	 * (FREETEXT-N2-PROVEN) Whether the SAME three keystrokes were driven for a
	 * question inside an N > 1 single-select prompt, where the `\r` advances to
	 * the next question and the prompt is submitted by the review-screen return.
	 */
	freeTextManyBytesProven: boolean;
	/**
	 * (MSEL-N2-PROVEN) Whether `[toggle digit × k, "\x1b[C"]` was driven as a
	 * per-question group for a multi-select question INSIDE an N > 1 prompt —
	 * the arrow advancing to the next question mid-prompt and onto the review
	 * screen on the last, with the review-screen `\r` submitting.
	 */
	multiSelectManyBytesProven: boolean;
	/**
	 * Whether free text on a MULTI-SELECT question has a proven sequence.
	 *
	 * `false` on every build, and on 2.1.226 that is a REFUTATION rather than an
	 * absence of evidence — see the refusal in `validateAnswerItem`.
	 */
	multiSelectFreeTextBytesProven: boolean;
	/**
	 * (GUARD5-MSEL-EDITOR-DETECT) DETECTION-ONLY: the exact raw-row copy of the
	 * multi-select editor row in each toggle state, as the build renders it at
	 * digit `options.length + 1`. Guard 5 uses it as numbering evidence — the
	 * row renders BELOW every option, so seeing it while options are missing
	 * proves a mis-numbered screen rather than a clip. It is NEVER offered as a
	 * pressable slot (`provenFreeTextOption` refuses multi-select free text;
	 * on 2.1.226 the press is refuted, not unproven). Empty when the copy was
	 * never captured for the build — the contradiction check then simply stays
	 * unarmed for multi items, exactly as it was before the needle existed.
	 */
	multiSelectFreeTextRowDetectLabels: readonly string[];
}

export const PICKER_CONTRACTS: readonly PickerContract[] = [
	{
		version: "claude-code@2.1.220",
		freeTextRowLabel: "Other",
		freeTextOneBytesProven: true,
		// Never driven on this build. Not inferred from 2.1.226: the flags are per
		// version precisely so a later build's proof cannot backfill an earlier one.
		freeTextManyBytesProven: false,
		multiSelectManyBytesProven: false,
		multiSelectFreeTextBytesProven: false,
		// Never captured on 2.1.220 — check stays unarmed for multi items there.
		multiSelectFreeTextRowDetectLabels: [],
	},
	{
		version: "claude-code@2.1.226",
		// Byte-exact, confirmed twice over: read out of the installed binary
		// (`mL.multiSelect ? "Type something" : "Type something."`) and then seen
		// rendered in a live pty. The trailing full stop is real.
		freeTextRowLabel: "Type something.",
		// DRIVEN, not inferred: digit N+1 opened the inline editor, the text was
		// typed, `\r` submitted, and the agent's own `tool_result` came back
		// carrying that text verbatim. A `tool_result` is the only ground truth
		// this contract accepts for a byte sequence.
		freeTextOneBytesProven: true,
		// (FREETEXT-N2-PROVEN) Driven on N=2 prompts in three arrangements — free
		// text on the first question, on the last, and on both — twice each, plus
		// an N=3 prompt with free text in the middle. Every run's `tool_result`
		// carried the typed text against the right question and the digit-selected
		// label against the others.
		freeTextManyBytesProven: true,
		// (MSEL-N2-PROVEN) Driven with the multi-select question FIRST (N=2),
		// LAST (N=2) and in the MIDDLE (N=3), twice each, plus the empty
		// zero-toggle group first and last — `tmp/pty-proof-msel/PROOF.md`. Every
		// run's `tool_result` carried exactly the toggled options (a 3-option
		// multi with `Mtwo` untouched proves no over-commit) and the digit answer
		// on every sibling question. The ENTER probe in the same proof is why the
		// encoder never emits `\r` inside a multi-select group: it TOGGLED the
		// caret's row (`Multi="Mthree, Mone"` from one intended toggle).
		multiSelectManyBytesProven: true,
		// REFUTED on this build, twice, and this is why it is a hard refusal
		// rather than a cautious one. Pressing the multi-select free-text row's
		// digit TOGGLES its checkbox and leaves the caret where it was; the body
		// text is then swallowed entirely (nothing echoes); and the terminating
		// `\r` toggles whatever row the caret is still on. The run that drove it
		// asked for free text and the agent's `tool_result` came back
		// `"…"="Mone"` — the first option, which nobody chose.
		multiSelectFreeTextBytesProven: false,
		// (GUARD5-MSEL-EDITOR-DETECT) Captured live
		// (tmp/pty-proof-msel/mix_ft_first-r1-04..06-*.txt): the checkbox editor
		// row renders `[ ] Type something` untoggled — no full stop, unlike the
		// single-select row above — and `[✔] Type something` once toggled.
		multiSelectFreeTextRowDetectLabels: [
			"[ ] Type something",
			"[✔] Type something",
		],
	},
];

export function pickerContractFor(version: string): PickerContract | null {
	return (
		PICKER_CONTRACTS.find((contract) => contract.version === version) ?? null
	);
}

/**
 * The contract for the build the byte sequences are proven against. This is what
 * the answer path drives, so it is what `question-store` derives the free-text
 * row's label from.
 */
export function provenPickerContract(): PickerContract | null {
	return pickerContractFor(PROVEN_AGAINST);
}

/**
 * (PICKER-CONTRACT-VERSIONED) The free-text row's label for the proven build, or
 * `null` when that build has no proven free-text sequence / is unknown.
 *
 * THE label. Kept as its own accessor because the label is also what guard 5
 * matches the row against and what the copy tests pin, but production code should
 * reach for `provenFreeTextOption` instead: the label alone cannot say whether
 * THIS prompt shape has a proven sequence.
 */
export function provenFreeTextRowLabel(): string | null {
	const contract = provenPickerContract();
	if (contract === null) return null;
	if (!contract.freeTextOneBytesProven && !contract.freeTextManyBytesProven) {
		return null;
	}
	return contract.freeTextRowLabel;
}

/**
 * (GUARD5-MSEL-EDITOR-DETECT) The multi-select editor row's exact raw-row
 * copies for the proven build — one per toggle state — or `[]` when unknown.
 *
 * DETECTION ONLY. Guard 5 uses these as numbering evidence on multi-select
 * items (the row renders below every option, so its presence proves missing
 * option rows were not clipped away); nothing ever presses this row, and
 * `provenFreeTextOption` keeps refusing multi-select free text regardless.
 */
export function provenMultiSelectFreeTextDetectLabels(): readonly string[] {
	return provenPickerContract()?.multiSelectFreeTextRowDetectLabels ?? [];
}

/**
 * (FREETEXT-N2-PROVEN) THE free-text derivation — the whole of it, in one place.
 *
 * Both the capture PRODUCER
 * (`trpc/router/notifications/companion-question-sink.ts`) and the capture
 * VALIDATOR (`companion/question-store.ts`) call this. They previously held the
 * shape rules AND the label independently, with a comment saying "change the two
 * together" as the only thing holding them in agreement. When they drifted,
 * `validateCapture` rejected EVERY single-question capture at ingestion — the
 * hook 500s, the question is never stored and the phone is never notified — and
 * no test caught it because they all pass `freeTextOption: null`, which skips the
 * cross-check. So the rules moved here with the label, and the two call sites
 * became one-line delegations that cannot disagree.
 *
 * Returns `null` — no free-text row offered, and `validateAnswerItem` then refuses
 * any `freetext` answer for the item — whenever the SHAPE has no proven byte
 * sequence on the proven build:
 *
 *   - `multiSelect`, on every build. On 2.1.226 this is a refutation, not
 *     caution: the row is rendered, and driving it answers the question WRONG.
 *     See `multiSelectFreeTextBytesProven`.
 *   - `questionCount > 1` on a build where the per-question sequence was not
 *     driven (2.1.220).
 *   - an unknown build.
 */
export function provenFreeTextOption(input: {
	multiSelect: boolean;
	optionCount: number;
	questionCount: number;
}): { index: number; label: string } | null {
	const contract = provenPickerContract();
	if (contract === null) return null;
	if (input.multiSelect) {
		return contract.multiSelectFreeTextBytesProven
			? { index: input.optionCount, label: contract.freeTextRowLabel }
			: null;
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
// raw bytes
// ---------------------------------------------------------------------------

/**
 * Right-arrow. On a LONE multi-select it moves onto the Submit tab; inside an
 * N > 1 prompt it ADVANCES a multi-select question (next question mid-prompt,
 * review screen on the last). Never a submit by itself.
 */
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
	/**
	 * `optionIndexes` was empty. Zero toggles is mechanically drivable (a bare
	 * advance arrow) but claude-code@2.1.226 then OMITS the question from the
	 * agent's tool_result — proven in tmp/pty-proof-msel/PROOF.md §3 — so an
	 * empty selection cannot be committed as if it were an answer.
	 */
	| "empty_selection"
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
 * The six shapes with a PROVEN byte sequence. Anything else is
 * `shape_unproven` and is refused.
 *
 * (MSEL-N2-PROVEN) A multi-select question inside an N > 1 prompt joined the
 * proven set once its per-question group — toggles, then the right-arrow as the
 * ADVANCE — was driven first, middle and last (`tmp/pty-proof-msel/PROOF.md`).
 * The earlier refutation of this shape refuted only the N=1 submit pair
 * (`\x1b[C` then `\r`) reused verbatim: that trailing `\r` landed on the NEXT
 * question and selected its focused row. The group form has no trailing `\r`,
 * and `assertNoReturnIntoMultiSelect` makes emitting one impossible.
 *
 * Still deliberately absent: free text ON a multi-select question — REFUTED,
 * not unproven (see `multiSelectFreeTextBytesProven`).
 */
export type AnswerShape =
	/** Exactly one single-select question: `[digit]`. Atomic select+submit. */
	| "single_select_one"
	/** N > 1 questions, ALL single-select, ALL answered by digit: `[digit × N, "\r"]`. */
	| "single_select_many"
	/** Exactly one multi-select question: `[toggle × k, "\x1b[C", "\r"]`. */
	| "multiselect_one"
	/** Exactly one question answered with free text: `[digit N+1, text, "\r"]`. */
	| "freetext_one"
	/**
	 * (FREETEXT-N2-PROVEN) N > 1 single-select questions, at least one answered
	 * with free text: per question either `[digit]` or `[digit N+1, text, "\r"]`,
	 * then the review-screen `"\r"`.
	 */
	| "freetext_many"
	/**
	 * (MSEL-N2-PROVEN) N > 1 questions, at least one multi-select. Per question
	 * either `[digit]`, `[digit N+1, text, "\r"]` (free text on a single-select
	 * sibling), or `[toggle digit × k, "\x1b[C"]` for a multi-select — k may be
	 * 0, which the CLI accepts and then OMITS that question from the
	 * `tool_result`, exactly as a desk submit past the review-screen warning
	 * does. Then the review-screen `"\r"`.
	 */
	| "multiselect_many";

export type KeystrokeKind =
	/** A bare digit that selects (and, when it is the only one, submits). */
	| "select_digit"
	/** A bare digit that TOGGLES a multi-select row. */
	| "toggle_digit"
	/** The digit that opens the inline free-text editor. */
	| "freetext_open"
	/** The UTF-8 free-text body. */
	| "freetext_body"
	/**
	 * Right-arrow. On a lone multi-select it moves onto the Submit tab; inside
	 * an N > 1 prompt it ADVANCES a multi-select question (next question
	 * mid-prompt, review screen on the last). The same byte either way, and
	 * never itself a submit. The picker's own footer under the rows reads
	 * `Next` mid-prompt and `Submit` on the last question — a rendering detail,
	 * never a reason to branch on which byte to send.
	 */
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
			if (answer.optionIndexes.length === 0) {
				throw new KeystrokeEncodingError(
					"empty_selection",
					`item ${item.index} selects nothing; the desk CLI silently drops an untoggled multi-select question from the agent's result, so an empty selection cannot be committed`,
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
			// multiSelect one first, because on 2.1.226 driving that row is not
			// merely unproven — it was DRIVEN and it answers the question wrong.
			// Twice: the digit toggles the row's checkbox without moving the caret,
			// the body text is swallowed with no echo at all, and the terminating
			// `\r` toggles whatever row the caret was still resting on. The run that
			// asked for free text got back `tool_result` `"…"="Mone"`, the first
			// option. Symmetric with the "select" and "multiselect" cases above; a
			// producer that synthesised a free-text slot onto a multiSelect item
			// must be refused here, not merely be unreachable through a well-behaved
			// client.
			if (item.multiSelect) {
				throw new KeystrokeEncodingError(
					"kind_mismatch",
					`item ${item.index} is multiSelect; its free-text row toggles a checkbox and swallows the text, so "freetext" is never coerced into it`,
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

	// N > 1. All three kinds compose freely here, because every per-question
	// group leaves the picker on the NEXT question: a bare digit advances, the
	// `\r` that closes an inline editor advances (FREETEXT-N2-PROVEN), and a
	// multi-select group's terminating `\x1b[C` advances (MSEL-N2-PROVEN).
	// The multi-select group is gated on its per-version proof: on a build
	// where it was never driven, refusing is still the only honest option.
	let sawFreeText = false;
	let sawMultiSelect = false;
	for (const answer of answers) {
		if (answer.kind === "select") continue;
		if (answer.kind === "freetext") {
			sawFreeText = true;
			continue;
		}
		sawMultiSelect = true;
	}
	if (sawMultiSelect) {
		if (provenPickerContract()?.multiSelectManyBytesProven !== true) {
			throw new KeystrokeEncodingError(
				"shape_unproven",
				`a multi-select group inside an ${questions.length}-question prompt has no proven byte sequence on ${PROVEN_AGAINST}; refused rather than guessed`,
			);
		}
		return "multiselect_many";
	}
	return sawFreeText ? "freetext_many" : "single_select_many";
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
 * (FREETEXT-CONTRACT-REPROVEN) The free-text sequence, re-driven on 2.1.226.
 *
 * This was briefly refused outright on my reading that a bare digit on the
 * free-text row only MOVED THE CARET — the caret did move onto the row and the
 * footer gained "ctrl+g to edit in Notepad", which I took as "focused, not
 * opened". That screen does not actually distinguish the two: the option list
 * stays rendered either way, and I never typed, so the reading rested on a
 * placeholder string I expected and did not see. A later run drove the WHOLE
 * sequence and the agent's `tool_result` came back with the typed text verbatim,
 * which settles it — the original `[digit N+1, text, "\r"]` shape is correct.
 *
 * The lesson worth keeping: a missing needle is not evidence of a missing
 * behaviour. Only a `tool_result` proves a byte sequence.
 */

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

	const keystrokes: Keystroke[] =
		shape === "single_select_one"
			? encodeSingleSelectOne(questions, answers)
			: shape === "single_select_many" ||
					shape === "freetext_many" ||
					shape === "multiselect_many"
				? encodeMany(questions, answers)
				: shape === "multiselect_one"
					? encodeMultiSelectOne(questions, answers)
					: encodeFreeTextOne(questions, answers);

	assertEmittedShape(shape, keystrokes);
	assertNoReturnIntoMultiSelect(questions, keystrokes);
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

/**
 * Every N > 1 prompt: per question `[digit]`, `[digit N+1, text, "\r"]`
 * (FREETEXT-N2-PROVEN) or `[toggle digit × k, "\x1b[C"]` (MSEL-N2-PROVEN),
 * then the review-screen `"\r"`.
 *
 * ONE encoder for `single_select_many`, `freetext_many` and `multiselect_many`
 * because the picker makes no distinction between them — every per-question
 * group ends with the picker sitting on the next question, which is exactly why
 * they compose. Three shapes, because their PROOFS are separate and a build may
 * earn one without the others (`freeTextManyBytesProven`,
 * `multiSelectManyBytesProven`); one encoder, because a second copy of the
 * "…then the review-screen return" rule is a place for them to drift.
 *
 * Note the two consecutive returns when the LAST question is answered with free
 * text: the first closes the inline editor and advances onto the review screen,
 * the second submits. Both were driven; neither is inferred from the other.
 *
 * A multi-select group with an EMPTY `optionIndexes` never reaches this encoder:
 * `validateAnswerItems` refuses it (`empty_selection`) because the CLI, though
 * it accepts the bare advance arrow, then OMITS that question from the
 * `tool_result` entirely (PROOF §3) — a "confirmed" answer the agent never
 * sees is not an answer. The zero-toggle byte group itself was driven and
 * works; the refusal is at the meaning layer, not the byte layer.
 */
function encodeMany(
	questions: readonly QuestionItem[],
	answers: readonly AnswerItem[],
): Keystroke[] {
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
		if (answer.kind === "select") {
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
			continue;
		}
		if (answer.kind === "multiselect") {
			// (MSEL-N2-PROVEN) toggles, then the arrow as the ADVANCE. No `\r`
			// anywhere in the group: the ENTER probe showed it TOGGLES the caret's
			// row, silently adding an option nobody chose.
			for (const optionIndex of answer.optionIndexes) {
				keystrokes.push({
					kind: "toggle_digit",
					data: digitFor(optionIndex, i),
					questionIndex: i,
					optionIndex,
					expect: { kind: "item_picker", itemIndex: i },
					submits: false,
				});
			}
			keystrokes.push({
				kind: "submit_tab",
				data: KEY_RIGHT_ARROW,
				questionIndex: i,
				optionIndex: null,
				// The multi's own numbered list is still on screen when the arrow is
				// pressed — the STRONG expectation holds, exactly as it does for the
				// lone multi-select's tab in `encodeMultiSelectOne`.
				expect: { kind: "item_picker", itemIndex: i },
				submits: false,
			});
			continue;
		}
		if (answer.kind !== "freetext") {
			// `classifyAnswerShape` has already refused every other kind here, so
			// `answer` narrows to `never`: a 4th AnswerItem kind added later fails
			// COMPILATION on this line instead of sailing past a string cast. This
			// is the encoder refusing to be the place where that stops being true.
			const unreachable: never = answer;
			throw new KeystrokeEncodingError(
				"kind_mismatch",
				`item ${i} carries an unknown answer kind: ${JSON.stringify(unreachable)}`,
			);
		}
		if (item.freeTextOption === null) {
			throw new KeystrokeEncodingError(
				"kind_mismatch",
				`item ${i} has no free-text slot`,
			);
		}
		const slot = item.freeTextOption.index;
		keystrokes.push({
			kind: "freetext_open",
			data: digitFor(slot, i),
			questionIndex: i,
			optionIndex: slot,
			expect: { kind: "item_picker", itemIndex: i },
			submits: false,
		});
		keystrokes.push({
			kind: "freetext_body",
			data: answer.text,
			questionIndex: i,
			optionIndex: slot,
			// The inline editor's layout was never proven.
			expect: { kind: "same_prompt", itemIndex: i },
			submits: false,
		});
		keystrokes.push({
			kind: "submit_return",
			data: KEY_RETURN,
			questionIndex: i,
			optionIndex: slot,
			expect: { kind: "same_prompt", itemIndex: i },
			// It closes the editor and advances. Only the review-screen return below
			// submits, and `assertEmittedShape` requires exactly one that does.
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
 * An empty `optionIndexes` never reaches this encoder — `validateAnswerItems`
 * refuses it (`empty_selection`); see the note on `encodeMany`.
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
		case "freetext_many": {
			// (FREETEXT-N2-PROVEN) One GROUP per question, in question order, each
			// either `[select_digit]` or `[freetext_open, freetext_body,
			// submit_return]`, then the review-screen `submit_return`. At least one
			// group must be a free-text one, or this is `single_select_many` wearing
			// the wrong shape name and the stricter grammar above should have run.
			const trailing = keystrokes[keystrokes.length - 1];
			if (trailing?.kind !== "submit_return" || !trailing.submits) {
				throw selfCheck(
					`freetext_many must end with the submitting review-screen return; got [${kinds.join(", ")}]`,
				);
			}
			let index = 0;
			let question = 0;
			let freeTextGroups = 0;
			while (index < keystrokes.length - 1) {
				const first = keystrokes[index];
				if (first?.questionIndex !== question) {
					throw selfCheck(
						`freetext_many position ${index} answers question ${first?.questionIndex}, expected ${question}; groups must run 0..N-1 in order`,
					);
				}
				if (first.kind === "select_digit") {
					index += 1;
					question += 1;
					continue;
				}
				const body = keystrokes[index + 1];
				const close = keystrokes[index + 2];
				if (
					first.kind !== "freetext_open" ||
					body?.kind !== "freetext_body" ||
					close?.kind !== "submit_return" ||
					body.questionIndex !== question ||
					close.questionIndex !== question
				) {
					throw selfCheck(
						`freetext_many question ${question} must be [select_digit] or [freetext_open, freetext_body, submit_return]; got [${kinds.join(", ")}]`,
					);
				}
				// The editor-closing return ADVANCES; only the review-screen one
				// submits. A group whose return claimed to submit would satisfy the
				// "exactly one submitting keystroke" check on the wrong key.
				if (close.submits) {
					throw selfCheck(
						`freetext_many question ${question}: the editor-closing return advances to the next question, it does not submit`,
					);
				}
				freeTextGroups += 1;
				index += 3;
				question += 1;
			}
			if (question < 2) {
				throw selfCheck(
					`freetext_many covers ${question} question(s); it is the N > 1 shape`,
				);
			}
			if (freeTextGroups === 0) {
				throw selfCheck(
					"freetext_many carries no free-text group; an all-digit prompt is single_select_many",
				);
			}
			if (trailing.questionIndex !== question - 1) {
				throw selfCheck(
					`freetext_many review-screen return names question ${trailing.questionIndex}, expected the last one (${question - 1})`,
				);
			}
			return;
		}
		case "multiselect_many": {
			// (MSEL-N2-PROVEN) One GROUP per question, in question order, each
			// `[select_digit]`, `[freetext_open, freetext_body, submit_return]` or
			// `[toggle_digit × k(≥0), submit_tab]`, then the review-screen
			// `submit_return`. At least one group must be a multi-select one, or
			// this is `freetext_many`/`single_select_many` wearing the wrong shape
			// name and a stricter grammar should have run.
			const trailing = keystrokes[keystrokes.length - 1];
			if (trailing?.kind !== "submit_return" || !trailing.submits) {
				throw selfCheck(
					`multiselect_many must end with the submitting review-screen return; got [${kinds.join(", ")}]`,
				);
			}
			let index = 0;
			let question = 0;
			let multiSelectGroups = 0;
			while (index < keystrokes.length - 1) {
				const first = keystrokes[index];
				if (first?.questionIndex !== question) {
					throw selfCheck(
						`multiselect_many position ${index} answers question ${first?.questionIndex}, expected ${question}; groups must run 0..N-1 in order`,
					);
				}
				if (first.kind === "select_digit") {
					index += 1;
					question += 1;
					continue;
				}
				if (first.kind === "freetext_open") {
					const body = keystrokes[index + 1];
					const close = keystrokes[index + 2];
					if (
						body?.kind !== "freetext_body" ||
						close?.kind !== "submit_return" ||
						body.questionIndex !== question ||
						close.questionIndex !== question
					) {
						throw selfCheck(
							`multiselect_many question ${question} free-text group must be [freetext_open, freetext_body, submit_return]; got [${kinds.join(", ")}]`,
						);
					}
					// The editor-closing return ADVANCES; only the review-screen one
					// submits.
					if (close.submits) {
						throw selfCheck(
							`multiselect_many question ${question}: the editor-closing return advances to the next question, it does not submit`,
						);
					}
					index += 3;
					question += 1;
					continue;
				}
				// A multi-select group: zero or more toggles, then the advance arrow.
				let cursor = index;
				while (
					keystrokes[cursor]?.kind === "toggle_digit" &&
					keystrokes[cursor]?.questionIndex === question
				) {
					cursor += 1;
				}
				const advance = keystrokes[cursor];
				if (
					advance?.kind !== "submit_tab" ||
					advance.questionIndex !== question ||
					advance.submits
				) {
					throw selfCheck(
						`multiselect_many question ${question} multi-select group must be [toggle_digit × k, submit_tab]; got [${kinds.join(", ")}]`,
					);
				}
				multiSelectGroups += 1;
				index = cursor + 1;
				question += 1;
			}
			if (question < 2) {
				throw selfCheck(
					`multiselect_many covers ${question} question(s); it is the N > 1 shape`,
				);
			}
			if (multiSelectGroups === 0) {
				throw selfCheck(
					"multiselect_many carries no multi-select group; that prompt is freetext_many or single_select_many",
				);
			}
			if (trailing.questionIndex !== question - 1) {
				throw selfCheck(
					`multiselect_many review-screen return names question ${trailing.questionIndex}, expected the last one (${question - 1})`,
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

/**
 * (MSEL-N2-PROVEN) The one absolute rule of the multi-select contract, checked
 * against the BYTES and the PROMPT rather than the encoder's labels: no
 * keystroke whose data carries a `\r` may target a multi-select question,
 * except the sequence-final review-screen submit.
 *
 * The ENTER probe in `tmp/pty-proof-msel/PROOF.md` is why: a `\r` landing on a
 * multi-select — lone or inside an N > 1 prompt — TOGGLES the caret's row and
 * silently adds an option nobody chose. `questions[].multiSelect` is ground
 * truth from the captured prompt, so a future encoder bug that mislabels a
 * return's kind or its questionIndex still cannot slip one past this: either
 * the data says `\r` into a multi-select and it throws here, or the label lies
 * about the target question and the grammar walker's group-order check throws.
 * Runs for EVERY shape — on the ones with no multi-select question it is a
 * no-op by construction.
 */
export function assertNoReturnIntoMultiSelect(
	questions: readonly QuestionItem[],
	keystrokes: readonly Keystroke[],
): void {
	for (let index = 0; index < keystrokes.length; index += 1) {
		const keystroke = keystrokes[index];
		if (keystroke === undefined) continue;
		if (!keystroke.data.includes(KEY_RETURN)) continue;
		const item = questions[keystroke.questionIndex];
		if (item === undefined) {
			throw selfCheck(
				`keystroke ${index} targets question ${keystroke.questionIndex}, which does not exist`,
			);
		}
		if (!item.multiSelect) continue;
		// The review-screen submit is labeled with the LAST question; when that
		// question is a multi-select this is the one legitimate return to name it.
		if (index === keystrokes.length - 1 && keystroke.submits) continue;
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
}

export type RawPrepareResult =
	| { success: true; acknowledgedInputSupported: boolean }
	| { error: string };

export type RawWriteResult =
	| { success: true }
	| {
			error: string;
			/** Whether the failed acknowledgement still leaves a possible PTY write. */
			writeOutcome: "not_written" | "unknown";
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
