import { describe, expect, it } from "bun:test";
import {
	assertEmittedShape,
	assertFrameGrouping,
	assertNoReturnIntoMultiSelect,
	encodeAnswer,
	type Keystroke,
	KeystrokeEncodingError,
	type KeystrokeFrame,
	pickerContractFor,
	provenFreeTextOption,
} from "./keystrokes";
import {
	multiItem as multi,
	singleItem as single,
} from "./question-item-fixtures";
import type { AnswerItem, QuestionItem } from "./types";

// ---------------------------------------------------------------------------
// (ANSWER-CSIU-ENCODING) The proven bytes, pinned as whole writes. The cases
// below mirror shapes driven on Claude Code 2.1.303 in
// tmp/multiselect-other/round6 and round7, whose `chunks` + `groupSizes` are
// exactly these frames. The one-question plain multi and Other-alone splits
// follow the final-Return-alone rule without a direct drive.
// ---------------------------------------------------------------------------

const K1 = "\x1b[49u";
const K2 = "\x1b[50u";
const K3 = "\x1b[51u";
const K4 = "\x1b[52u";
const RETURN = "\x1b[13u";
const RIGHT = "\x1b[C";
const DOWN = "\x1b[B";
const paste = (text: string) => `\x1b[200~${text}\x1b[201~`;

function frames(
	questions: readonly QuestionItem[],
	answers: readonly AnswerItem[],
): string[] {
	return encodeAnswer(questions, answers).map((frame) => frame.data);
}

function refusal(run: () => unknown): string {
	try {
		run();
	} catch (error) {
		if (error instanceof KeystrokeEncodingError) return error.reason;
		throw error;
	}
	throw new Error("expected a KeystrokeEncodingError");
}

const select = (questionIndex: number, optionIndex: number): AnswerItem => ({
	questionIndex,
	kind: "select",
	optionIndex,
});
const ticks = (questionIndex: number, optionIndexes: number[]): AnswerItem => ({
	questionIndex,
	kind: "multiselect",
	optionIndexes,
});
const typed = (questionIndex: number, text: string): AnswerItem => ({
	questionIndex,
	kind: "freetext",
	text,
});
const ticksAndText = (
	questionIndex: number,
	optionIndexes: number[],
	text: string,
): AnswerItem => ({
	questionIndex,
	kind: "multiselect_freetext",
	optionIndexes,
	text,
});

describe("(ANSWER-CSIU-ENCODING) a one-question answer: one key is one write, else the final Return alone", () => {
	it("a single digit selects and submits", () => {
		expect(frames([single(0)], [select(0, 1)])).toEqual([K2]);
	});

	it("free text is the slot digit and the paste, then Return", () => {
		expect(frames([single(0)], [typed(0, "a written answer")])).toEqual([
			`${K4}${paste("a written answer")}`,
			RETURN,
		]);
	});

	it("a plain multi-select is toggles and Right, then Return", () => {
		expect(frames([multi(0)], [ticks(0, [0, 2])])).toEqual([
			`${K1}${K3}${RIGHT}`,
			RETURN,
		]);
	});

	it("ticks plus Other, and Other alone, at 2, 3 and 4 options", () => {
		for (const optionCount of [2, 3, 4]) {
			const last = [K1, K2, K3, K4][optionCount - 1];
			const group = `${DOWN.repeat(optionCount)}${paste("other")}${DOWN}${RETURN}`;
			expect(
				frames(
					[multi(0, optionCount)],
					[ticksAndText(0, [0, optionCount - 1], "other")],
				),
			).toEqual([`${K1}${last}${group}`, RETURN]);
			expect(
				frames([multi(0, optionCount)], [ticksAndText(0, [], "other")]),
			).toEqual([group, RETURN]);
		}
	});
});

describe("(FREETEXT-N2-PROVEN) (MSEL-N2-PROVEN) N > 1 is one write per screen, the review Return alone", () => {
	it("P1: single Other then a digit", () => {
		expect(
			frames([single(0), single(1)], [typed(0, "hello"), select(1, 1)]),
		).toEqual(["\x1b[52u\x1b[200~hello\x1b[201~\x1b[13u", "\x1b[50u", "\x1b[13u"]);
	});

	it("P2: a plain multi then a digit", () => {
		expect(
			frames([multi(0), single(1)], [ticks(0, [0, 2]), select(1, 1)]),
		).toEqual([`${K1}${K3}${RIGHT}`, K2, RETURN]);
	});

	it("P3: a digit then a plain multi", () => {
		expect(
			frames([single(0), multi(1)], [select(0, 1), ticks(1, [0, 2])]),
		).toEqual([K2, `${K1}${K3}${RIGHT}`, RETURN]);
	});

	it("multi-a: ticks plus Other then a digit", () => {
		expect(
			frames(
				[multi(0), single(1)],
				[ticksAndText(0, [0, 2], "hello other"), select(1, 1)],
			),
		).toEqual([
			`${K1}${K3}${DOWN}${DOWN}${DOWN}${paste("hello other")}${DOWN}${RETURN}`,
			K2,
			RETURN,
		]);
	});

	it("mixes plain multi, multi Other and single Other groups in either order", () => {
		const other = (row: string) =>
			`${row}${DOWN}${DOWN}${DOWN}${paste("typed")}${DOWN}${RETURN}`;
		const singleOther = `${K4}${paste("said")}${RETURN}`;
		expect(
			frames(
				[multi(0), multi(1)],
				[ticks(0, [0]), ticksAndText(1, [1], "typed")],
			),
		).toEqual([`${K1}${RIGHT}`, other(K2), RETURN]);
		expect(
			frames(
				[multi(0), multi(1)],
				[ticksAndText(0, [1], "typed"), ticks(1, [0])],
			),
		).toEqual([other(K2), `${K1}${RIGHT}`, RETURN]);
		expect(
			frames(
				[single(0), multi(1)],
				[typed(0, "said"), ticksAndText(1, [1], "typed")],
			),
		).toEqual([singleOther, other(K2), RETURN]);
		expect(
			frames(
				[multi(0), single(1)],
				[ticksAndText(0, [1], "typed"), typed(1, "said")],
			),
		).toEqual([other(K2), singleOther, RETURN]);
	});

	it("single Other on the LAST question emits its Return, then the review Return", () => {
		expect(
			frames([single(0), single(1)], [select(0, 1), typed(1, "hello")]),
		).toEqual([K2, `${K4}${paste("hello")}${RETURN}`, RETURN]);
	});

	it("Other with no ticks inside N > 1", () => {
		expect(
			frames(
				[multi(0), single(1)],
				[ticksAndText(0, [], "only other"), select(1, 1)],
			),
		).toEqual([
			`${DOWN}${DOWN}${DOWN}${paste("only other")}${DOWN}${RETURN}`,
			K2,
			RETURN,
		]);
	});

	it("4 questions x 4 options, all ticked + Other, is 5 writes", () => {
		const group = (n: number) =>
			`\x1b[49u\x1b[50u\x1b[51u\x1b[52u\x1b[B\x1b[B\x1b[B\x1b[B\x1b[200~q${n} other\x1b[201~\x1b[B\x1b[13u`;
		expect(
			frames(
				[0, 1, 2, 3].map((index) => multi(index, 4)),
				[0, 1, 2, 3].map((index) =>
					ticksAndText(index, [0, 1, 2, 3], `q${index + 1} other`),
				),
			),
		).toEqual([group(1), group(2), group(3), group(4), "\x1b[13u"]);
	});

	it("free text on BOTH questions", () => {
		expect(
			frames([single(0), single(1)], [typed(0, "alpha"), typed(1, "beta")]),
		).toEqual([
			`${K4}${paste("alpha")}${RETURN}`,
			`${K4}${paste("beta")}${RETURN}`,
			RETURN,
		]);
	});

	it("an all-digit prompt is a digit per screen and the review Return", () => {
		expect(
			frames([single(0), single(1)], [select(0, 1), select(1, 0)]),
		).toEqual([K2, K1, RETURN]);
	});

	it("the free-text digit is the answering question's OWN slot", () => {
		// A bug deriving it from the 3-option multi sibling would press row 4.
		expect(
			frames(
				[single(0, 2), multi(1)],
				[typed(0, "a typed reply"), ticks(1, [0, 2])],
			),
		).toEqual([
			`${K3}${paste("a typed reply")}${RETURN}`,
			`${K1}${K3}${RIGHT}`,
			RETURN,
		]);
	});

	it("exactly one keystroke submits, and it is the last one", () => {
		const keystrokes = encodeAnswer(
			[single(0), multi(1)],
			[select(0, 1), ticksAndText(1, [0], "a written answer")],
		).flatMap((frame) => frame.keystrokes);
		expect(keystrokes.filter((keystroke) => keystroke.submits)).toHaveLength(1);
		expect(keystrokes[keystrokes.length - 1]?.submits).toBe(true);
	});
});

describe("(MSEL-FREETEXT-PROVEN) the proof range and refusals", () => {
	it("refuses a 5-question prompt as unproven", () => {
		expect(
			refusal(() =>
				encodeAnswer(
					[0, 1, 2, 3, 4].map((index) => single(index)),
					[0, 1, 2, 3, 4].map((index) => select(index, 0)),
				),
			),
		).toBe("shape_unproven");
	});

	it("refuses ticks plus text on a 5-option question as unproven", () => {
		expect(
			refusal(() =>
				encodeAnswer([multi(0, 5)], [ticksAndText(0, [4], "other")]),
			),
		).toBe("shape_unproven");
	});

	it("refuses an EMPTY plain multi selection — the CLI drops the question from the tool_result", () => {
		expect(
			refusal(() =>
				encodeAnswer([multi(0), single(1)], [ticks(0, []), select(1, 1)]),
			),
		).toBe("empty_selection");
	});

	it("refuses the single-select free-text kind on a multi-select item, even with a slot", () => {
		expect(
			refusal(() => encodeAnswer([multi(0)], [typed(0, "anything")])),
		).toBe("kind_mismatch");
	});

	it("refuses free text when the item has no derived slot", () => {
		expect(
			refusal(() =>
				encodeAnswer(
					[{ ...single(0), freeTextOption: null }],
					[typed(0, "anything")],
				),
			),
		).toBe("kind_mismatch");
		expect(
			refusal(() =>
				encodeAnswer(
					[single(0), { ...multi(1), freeTextOption: null }],
					[select(0, 0), ticksAndText(1, [0], "anything")],
				),
			),
		).toBe("kind_mismatch");
	});
});

describe("(SELFCHECK-BYTES) the self-checks", () => {
	it("rejects a free-text group whose Down count misses the Type something row", () => {
		const questions = [multi(0)];
		const keystrokes = encodeAnswer(questions, [
			ticksAndText(0, [0], "other"),
		]).flatMap((frame) => frame.keystrokes);
		const shortOne = keystrokes.filter(
			(keystroke, index) =>
				!(keystroke.kind === "focus_down" && index === 1),
		);
		expect(
			refusal(() =>
				assertEmittedShape("multiselect_freetext_one", questions, shortOne),
			),
		).toBe("encoder_self_check");
	});

	it("rejects a Return into a multi-select question without the text and Down before it", () => {
		const questions = [multi(0), single(1)];
		const key = (overrides: Partial<Keystroke>): Keystroke => ({
			kind: "toggle_digit",
			data: K1,
			questionIndex: 0,
			optionIndex: 0,
			submits: false,
			...overrides,
		});
		const review = key({
			kind: "submit_return",
			data: RETURN,
			questionIndex: 1,
			optionIndex: null,
			submits: true,
		});
		const bareReturn = key({ data: RETURN });
		const downThenReturn = [
			key({ kind: "focus_down", data: DOWN, optionIndex: null }),
			key({ kind: "submit_return", data: RETURN, optionIndex: null }),
		];
		for (const poisoned of [
			[key({}), bareReturn, review],
			[key({}), ...downThenReturn, review],
		]) {
			expect(
				refusal(() => assertNoReturnIntoMultiSelect(questions, poisoned)),
			).toBe("encoder_self_check");
		}
	});

	it("rejects a write grouping that merges the final Return, leaves a write empty, or splits a picker screen", () => {
		const frameOf = (keystrokes: readonly Keystroke[]): KeystrokeFrame => ({
			data: keystrokes.map((keystroke) => keystroke.data).join(""),
			keystrokes,
		});
		const p2 = encodeAnswer(
			[multi(0), single(1)],
			[ticks(0, [0, 2]), select(1, 1)],
		);
		const loneText = encodeAnswer([single(0)], [typed(0, "typed")]);
		const loneKeys = loneText.flatMap((frame) => frame.keystrokes);
		expect(() => assertFrameGrouping(p2)).not.toThrow();
		expect(() => assertFrameGrouping(loneText)).not.toThrow();
		for (const planted of [
			[...p2.slice(0, -2), frameOf(p2.slice(-2).flatMap((f) => f.keystrokes))],
			[...p2.slice(0, -1), frameOf([]), ...p2.slice(-1)],
			loneKeys.map((keystroke) => frameOf([keystroke])),
		]) {
			expect(refusal(() => assertFrameGrouping(planted))).toBe(
				"encoder_self_check",
			);
		}
	});
});

describe("(FREETEXT-N2-PROVEN) the derivation both sides of the capture share", () => {
	it("offers a slot to a single-select question whatever N is", () => {
		expect(
			provenFreeTextOption({
				multiSelect: false,
				optionCount: 2,
				questionCount: 1,
			}),
		).toEqual({ index: 2, label: "Type something." });
		expect(
			provenFreeTextOption({
				multiSelect: false,
				optionCount: 4,
				questionCount: 3,
			}),
		).toEqual({ index: 4, label: "Type something." });
	});

	it("offers a multi-select question its row, labelled without a full stop, only inside the proof range", () => {
		for (const questionCount of [1, 2, 4]) {
			for (const optionCount of [2, 3, 4]) {
				expect(
					provenFreeTextOption({
						multiSelect: true,
						optionCount,
						questionCount,
					}),
				).toEqual({ index: optionCount, label: "Type something" });
			}
		}
		for (const outside of [
			{ optionCount: 3, questionCount: 5 },
			{ optionCount: 5, questionCount: 1 },
			{ optionCount: 1, questionCount: 1 },
		]) {
			expect(
				provenFreeTextOption({ multiSelect: true, ...outside }),
			).toBeNull();
		}
	});

	it("keys the shape flags per build, so one build's proof cannot backfill another's", () => {
		const older = pickerContractFor("claude-code@2.1.220");
		expect(older?.freeTextOneBytesProven).toBe(true);
		expect(older?.freeTextManyBytesProven).toBe(false);
		expect(older?.multiSelectManyBytesProven).toBe(false);
		const previous = pickerContractFor("claude-code@2.1.226");
		expect(previous?.multiSelectManyBytesProven).toBe(true);
		for (const contract of [older, previous]) {
			expect(contract?.multiSelectFreeTextOneBytesProven).toBe(false);
			expect(contract?.multiSelectFreeTextManyBytesProven).toBe(false);
		}
		expect(pickerContractFor("claude-code@0.0.0")).toBeNull();
	});
});
