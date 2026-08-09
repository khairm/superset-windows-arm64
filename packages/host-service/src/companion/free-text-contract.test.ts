import { describe, expect, it } from "bun:test";
import {
	assertNoReturnIntoMultiSelect,
	encodeAnswer,
	type Keystroke,
	KeystrokeEncodingError,
	pickerContractFor,
	provenFreeTextOption,
} from "./keystrokes";
import type { AnswerItem, QuestionItem } from "./types";

// ---------------------------------------------------------------------------
// (FREETEXT-CONTRACT-REPROVEN)
//
// The free-text shape was briefly refused outright, on a reading that a bare
// digit on that row only moved the selection caret. The caret DID move and the
// footer did gain "ctrl+g to edit in Notepad" — but that screen does not
// distinguish "row focused" from "editor open": the option list stays rendered
// either way, and that run never typed anything, so the conclusion rested on a
// placeholder string that was expected and not seen.
//
// A later run drove the whole sequence against the installed 2.1.226 and the
// agent's own `tool_result` came back carrying the typed text verbatim. That is
// ground truth for a byte sequence in a way a screen reading is not, so the
// original `[digit N+1, text, "\r"]` shape stands.
//
// What is still refused is refused on a REFUTED run, not on absence of
// evidence: free text on a multi-select question — the digit toggles the row's
// checkbox and the typed body is swallowed. See (MSEL-N2-PROVEN) below for the
// multi-select groups that ARE proven, N > 1 included.
// ---------------------------------------------------------------------------

function singleSelectItem(overrides: Partial<QuestionItem> = {}): QuestionItem {
	return {
		index: 0,
		header: "Canary",
		question: "Which canary option do you want for this run?",
		multiSelect: false,
		options: [
			{
				index: 0,
				label: "Yes",
				description: "Enable the first canary option for this run.",
			},
			{
				index: 1,
				label: "Skip",
				description: "Leave the second canary option alone entirely.",
			},
		],
		freeTextOption: { index: 2, label: "Type something." },
		...overrides,
	};
}

describe("(FREETEXT-CONTRACT-REPROVEN) the proven shapes encode", () => {
	it("free text is [digit N+1, text, submit]", () => {
		const keystrokes = encodeAnswer(
			[singleSelectItem()],
			[{ kind: "freetext", questionIndex: 0, text: "a written answer" }],
		);
		expect(
			keystrokes.map((keystroke) => ({
				kind: keystroke.kind,
				data: keystroke.data,
			})),
		).toEqual([
			{ kind: "freetext_open", data: "3" },
			{ kind: "freetext_body", data: "a written answer" },
			{ kind: "submit_return", data: "\r" },
		]);
	});

	it("an ordinary option press is one bare digit, no Enter", () => {
		const keystrokes = encodeAnswer([singleSelectItem()], [
			{ kind: "select", questionIndex: 0, optionIndex: 1 },
		] as AnswerItem[]);
		expect(keystrokes.map((keystroke) => keystroke.data)).toEqual(["2"]);
	});
});

describe("(FREETEXT-CONTRACT-REPROVEN) shapes nobody has driven stay refused", () => {
	it("refuses free text on a multi-select item", () => {
		// The row IS rendered there ("Type something", no full stop) — the earlier
		// comment claiming otherwise was refuted by the same pty run. It is refused
		// because its editor was never driven, not because it is absent.
		let thrown: unknown;
		try {
			encodeAnswer(
				[singleSelectItem({ multiSelect: true })],
				[{ kind: "freetext", questionIndex: 0, text: "anything" }],
			);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(KeystrokeEncodingError);
	});

	it("refuses free text when the item has no derived slot", () => {
		let thrown: unknown;
		try {
			encodeAnswer(
				[singleSelectItem({ freeTextOption: null })],
				[{ kind: "freetext", questionIndex: 0, text: "anything" }],
			);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(KeystrokeEncodingError);
	});
});

// ---------------------------------------------------------------------------
// (FREETEXT-N2-PROVEN)
//
// Free text inside an N > 1 prompt, which was refused outright until it was
// driven. The refusal was honest — the free-text terminator `\r` was proven on a
// ONE-question prompt, where it submits, and whether it submitted or merely
// advanced when other questions followed had never been observed.
//
// It advances. Driven on Claude Code 2.1.226 in a pty, on N=2 prompts in three
// arrangements (free text on the first question, on the last, on both), twice
// each, with the agent's own `tool_result` as ground truth every time:
//
//   free text on Q1:   ["3", text, "\r", "1",  "\r"]
//   free text on Q2:   ["1", "3", text, "\r",  "\r"]
//   free text on both: ["3", t1, "\r", "3", t2, "\r", "\r"]
//
// So a free-text question and a digit question compose freely — both leave the
// picker on the next question — and the prompt is submitted by the same
// review-screen return that already terminates `single_select_many`. Free text on
// the LAST question therefore emits two consecutive returns: one closes the
// editor, one submits.
//
// What is still refused, and now for a REFUTED rather than an unknown reason:
// free text on a multi-select question. See the negative cases at the bottom.
// ---------------------------------------------------------------------------

function twoQuestions(): QuestionItem[] {
	return [
		{
			index: 0,
			header: "Alpha",
			question: "Which alpha value should this canary run use?",
			multiSelect: false,
			options: [
				{
					index: 0,
					label: "Aone",
					description: "Use the first alpha value for this canary run.",
				},
				{
					index: 1,
					label: "Atwo",
					description: "Use the second alpha value for this canary run.",
				},
			],
			freeTextOption: { index: 2, label: "Type something." },
		},
		{
			index: 1,
			header: "Beta",
			question: "Which beta value should this canary run use?",
			multiSelect: false,
			options: [
				{
					index: 0,
					label: "Bone",
					description: "Use the first beta value for this canary run.",
				},
				{
					index: 1,
					label: "Btwo",
					description: "Use the second beta value for this canary run.",
				},
			],
			freeTextOption: { index: 2, label: "Type something." },
		},
	];
}

/** The bytes as the pty will see them, independent of every keystroke label. */
function rawBytes(keystrokes: readonly { data: string }[]): string[] {
	return keystrokes.map((keystroke) => keystroke.data);
}

describe("(FREETEXT-N2-PROVEN) free text inside an N > 1 prompt", () => {
	it("encodes free text on the FIRST question exactly as it was driven", () => {
		const keystrokes = encodeAnswer(twoQuestions(), [
			{ kind: "freetext", questionIndex: 0, text: "zebrafreetextalpha" },
			{ kind: "select", questionIndex: 1, optionIndex: 0 },
		]);
		expect(rawBytes(keystrokes)).toEqual([
			"3",
			"zebrafreetextalpha",
			"\r",
			"1",
			"\r",
		]);
		expect(keystrokes.map((keystroke) => keystroke.kind)).toEqual([
			"freetext_open",
			"freetext_body",
			"submit_return",
			"select_digit",
			"submit_return",
		]);
	});

	it("encodes free text on the LAST question, two returns and all", () => {
		// The first `\r` closes the inline editor and lands on the review screen;
		// the second submits. Both were driven. A reader tempted to collapse them
		// should note that the editor-closing one is `submits: false`.
		const keystrokes = encodeAnswer(twoQuestions(), [
			{ kind: "select", questionIndex: 0, optionIndex: 0 },
			{ kind: "freetext", questionIndex: 1, text: "zebrafreetextbeta" },
		]);
		expect(rawBytes(keystrokes)).toEqual([
			"1",
			"3",
			"zebrafreetextbeta",
			"\r",
			"\r",
		]);
	});

	it("encodes free text on BOTH questions", () => {
		const keystrokes = encodeAnswer(twoQuestions(), [
			{ kind: "freetext", questionIndex: 0, text: "zebrafreetextalpha" },
			{ kind: "freetext", questionIndex: 1, text: "zebrafreetextbeta" },
		]);
		expect(rawBytes(keystrokes)).toEqual([
			"3",
			"zebrafreetextalpha",
			"\r",
			"3",
			"zebrafreetextbeta",
			"\r",
			"\r",
		]);
	});

	it("exactly one keystroke submits, and it is the last one", () => {
		// The property the two-consecutive-returns shape could most easily break.
		// An editor-closing return that claimed to submit would satisfy
		// `assertEmittedShape`'s count on the wrong key, and the answer path would
		// stop writing one keystroke early — leaving the prompt on the review
		// screen with every answer entered and nothing submitted.
		const keystrokes = encodeAnswer(twoQuestions(), [
			{ kind: "select", questionIndex: 0, optionIndex: 1 },
			{ kind: "freetext", questionIndex: 1, text: "a written answer" },
		]);
		expect(keystrokes.filter((keystroke) => keystroke.submits)).toHaveLength(1);
		expect(keystrokes[keystrokes.length - 1]?.submits).toBe(true);
	});

	it("guards each question's own picker before pressing its digit", () => {
		// Guard 5 is re-evaluated per keystroke against `expect`. The digit that
		// opens question 1's editor must be checked against QUESTION 1's row list,
		// not question 0's — every question in an N > 1 prompt numbers its rows from
		// 1, so the wrong `itemIndex` here confirms the wrong screen and types into
		// the wrong list.
		const keystrokes = encodeAnswer(twoQuestions(), [
			{ kind: "select", questionIndex: 0, optionIndex: 1 },
			{ kind: "freetext", questionIndex: 1, text: "a written answer" },
		]);
		expect(keystrokes.map((keystroke) => keystroke.expect)).toEqual([
			{ kind: "item_picker", itemIndex: 0 },
			{ kind: "item_picker", itemIndex: 1 },
			{ kind: "same_prompt", itemIndex: 1 },
			{ kind: "same_prompt", itemIndex: 1 },
			{ kind: "same_prompt", itemIndex: 1 },
		]);
	});

	it("repeats the per-question group at N = 3", () => {
		const questions = twoQuestions();
		const third: QuestionItem = {
			index: 2,
			header: "Gamma",
			question: "Which gamma value should this canary run use?",
			multiSelect: false,
			options: [
				{
					index: 0,
					label: "Gone",
					description: "Use the first gamma value for this canary run.",
				},
				{
					index: 1,
					label: "Gtwo",
					description: "Use the second gamma value for this canary run.",
				},
			],
			freeTextOption: { index: 2, label: "Type something." },
		};
		const keystrokes = encodeAnswer([...questions, third], [
			{ kind: "select", questionIndex: 0, optionIndex: 0 },
			{ kind: "freetext", questionIndex: 1, text: "middle answer" },
			{ kind: "select", questionIndex: 2, optionIndex: 1 },
		] as AnswerItem[]);
		expect(rawBytes(keystrokes)).toEqual([
			"1",
			"3",
			"middle answer",
			"\r",
			"2",
			"\r",
		]);
	});

	it("still encodes an all-digit N > 1 prompt as the older shape", () => {
		// `single_select_many` keeps its own stricter grammar. Its proof is separate
		// and predates this one; nothing here may loosen it.
		const keystrokes = encodeAnswer(twoQuestions(), [
			{ kind: "select", questionIndex: 0, optionIndex: 1 },
			{ kind: "select", questionIndex: 1, optionIndex: 0 },
		]);
		expect(rawBytes(keystrokes)).toEqual(["2", "1", "\r"]);
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

	it("never offers one to a multi-select question", () => {
		for (const questionCount of [1, 2, 5]) {
			expect(
				provenFreeTextOption({
					multiSelect: true,
					optionCount: 2,
					questionCount,
				}),
			).toBeNull();
		}
	});

	it("keys the shape flags per build, so one build's proof cannot backfill another's", () => {
		// 2.1.220's one-question sequence was driven; its N > 1 one never was, and
		// 2.1.226 proving the latter says nothing about it.
		const older = pickerContractFor("claude-code@2.1.220");
		expect(older?.freeTextOneBytesProven).toBe(true);
		expect(older?.freeTextManyBytesProven).toBe(false);
		expect(pickerContractFor("claude-code@0.0.0")).toBeNull();
	});

	it("refuses free text on a multi-select item even when a slot is forged onto it", () => {
		// The derivation never produces this item; a compromised producer could.
		let thrown: unknown;
		try {
			encodeAnswer(
				[singleSelectItem({ multiSelect: true })],
				[{ kind: "freetext", questionIndex: 0, text: "anything" }],
			);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(KeystrokeEncodingError);
		expect((thrown as KeystrokeEncodingError).reason).toBe("kind_mismatch");
	});
});

describe("(MSEL-N2-PROVEN) a multi-select question inside N > 1 encodes", () => {
	// Mirrors tmp/pty-proof-msel/PROOF.md: the multi under test has THREE options
	// so "toggle 1 and 3" leaves Mtwo provably untouched.
	function multiItem(index: number): QuestionItem {
		return {
			index,
			header: "Multi",
			question: "Which multi values should this canary run use?",
			multiSelect: true,
			options: [
				{ index: 0, label: "Mone", description: "The first multi value." },
				{ index: 1, label: "Mtwo", description: "The second multi value." },
				{ index: 2, label: "Mthree", description: "The third multi value." },
			],
			freeTextOption: null,
		};
	}

	function reindex(items: QuestionItem[]): QuestionItem[] {
		return items.map((item, index) => ({ ...item, index }));
	}

	it("multi FIRST in N=2 is toggles, the advance arrow, the digit, the review return (PROOF case A)", () => {
		const questions = reindex([multiItem(0), ...twoQuestions().slice(1)]);
		const keystrokes = encodeAnswer(questions, [
			{ kind: "multiselect", questionIndex: 0, optionIndexes: [0, 2] },
			{ kind: "select", questionIndex: 1, optionIndex: 1 },
		]);
		expect(keystrokes.map((keystroke) => keystroke.data)).toEqual([
			"1",
			"3",
			"\x1b[C",
			"2",
			"\r",
		]);
		// The arrow ADVANCES with the multi's list still on screen — strong
		// expectation, and never itself the submit.
		const arrow = keystrokes[2];
		expect(arrow?.kind).toBe("submit_tab");
		expect(arrow?.expect).toEqual({ kind: "item_picker", itemIndex: 0 });
		expect(arrow?.submits).toBe(false);
		expect(keystrokes[keystrokes.length - 1]?.submits).toBe(true);
	});

	it("multi LAST in N=2 advances onto the review screen, then the return submits (PROOF case B)", () => {
		const questions = reindex([
			twoQuestions()[0] as QuestionItem,
			multiItem(1),
		]);
		const keystrokes = encodeAnswer(questions, [
			{ kind: "select", questionIndex: 0, optionIndex: 0 },
			{ kind: "multiselect", questionIndex: 1, optionIndexes: [0, 2] },
		]);
		expect(keystrokes.map((keystroke) => keystroke.data)).toEqual([
			"1",
			"1",
			"3",
			"\x1b[C",
			"\r",
		]);
	});

	it("multi MIDDLE in N=3 (PROOF case C)", () => {
		const [alpha, beta] = twoQuestions() as [QuestionItem, QuestionItem];
		const questions = reindex([alpha, multiItem(1), beta]);
		const keystrokes = encodeAnswer(questions, [
			{ kind: "select", questionIndex: 0, optionIndex: 0 },
			{ kind: "multiselect", questionIndex: 1, optionIndexes: [0, 2] },
			{ kind: "select", questionIndex: 2, optionIndex: 1 },
		]);
		expect(keystrokes.map((keystroke) => keystroke.data)).toEqual([
			"1",
			"1",
			"3",
			"\x1b[C",
			"2",
			"\r",
		]);
	});

	it("an EMPTY multi selection is refused at the boundary — the CLI silently drops the question from the tool_result (PROOF §3)", () => {
		// The zero-toggle byte group (a bare advance arrow) was driven and works
		// mechanically, but the agent's tool_result then omits the question
		// entirely: "confirmed" would claim an answer the agent never sees. The
		// refusal is at the meaning layer (`validateAnswerItems`), mirrored by
		// the HTTP schema's min-1.
		const questions = reindex([multiItem(0), ...twoQuestions().slice(1)]);
		expect(() =>
			encodeAnswer(questions, [
				{ kind: "multiselect", questionIndex: 0, optionIndexes: [] },
				{ kind: "select", questionIndex: 1, optionIndex: 1 },
			]),
		).toThrow(
			expect.objectContaining({
				name: "KeystrokeEncodingError",
				reason: "empty_selection",
			}),
		);
	});

	it("a multi group composes with a free-text sibling in the same prompt (PROOF §4)", () => {
		const [alpha, beta] = twoQuestions() as [QuestionItem, QuestionItem];
		const questions = reindex([alpha, multiItem(1), beta]);
		const keystrokes = encodeAnswer(questions, [
			{ kind: "select", questionIndex: 0, optionIndex: 0 },
			{ kind: "multiselect", questionIndex: 1, optionIndexes: [0, 2] },
			{ kind: "freetext", questionIndex: 2, text: "a typed reply" },
		]);
		expect(keystrokes.map((keystroke) => keystroke.data)).toEqual([
			"1",
			"1",
			"3",
			"\x1b[C",
			"3",
			"a typed reply",
			"\r",
			"\r",
		]);
		// The editor-closing return targets the free-text question, never the
		// multi; the final return is the review-screen submit.
		expect(keystrokes[6]?.questionIndex).toBe(2);
		expect(keystrokes[6]?.submits).toBe(false);
	});

	it("free text FIRST with the multi LAST (PROOF §4 case H) — and the free-text digit is the answering question's OWN slot", () => {
		// Alpha has 2 options + slot at 3; the multi sibling has 3 options. A bug
		// deriving the free-text digit from any other question's option count
		// would emit "4" here.
		const [alpha, beta] = twoQuestions() as [QuestionItem, QuestionItem];
		const questions = reindex([alpha, beta, multiItem(2)]);
		const keystrokes = encodeAnswer(questions, [
			{ kind: "freetext", questionIndex: 0, text: "a typed reply" },
			{ kind: "select", questionIndex: 1, optionIndex: 1 },
			{ kind: "multiselect", questionIndex: 2, optionIndexes: [0, 2] },
		]);
		expect(keystrokes.map((keystroke) => keystroke.data)).toEqual([
			"3",
			"a typed reply",
			"\r",
			"2",
			"1",
			"3",
			"\x1b[C",
			"\r",
		]);
	});

	it("never emits a return into a multi-select question — the assertion throws on a handcrafted one", () => {
		const questions = reindex([multiItem(0), ...twoQuestions().slice(1)]);
		const poisoned: Keystroke[] = [
			{
				kind: "toggle_digit",
				data: "1",
				questionIndex: 0,
				optionIndex: 0,
				expect: { kind: "item_picker", itemIndex: 0 },
				submits: false,
			},
			{
				// The refuted N=1 tail reused verbatim: this return lands on the
				// multi and toggles the caret's row.
				kind: "submit_return",
				data: "\r",
				questionIndex: 0,
				optionIndex: null,
				expect: { kind: "same_prompt", itemIndex: 0 },
				submits: false,
			},
		];
		expect(() => assertNoReturnIntoMultiSelect(questions, poisoned)).toThrow(
			/return into multi-select question 0/,
		);
	});

	it("keys the shape flag per build: 2.1.220 never earned it", () => {
		expect(
			pickerContractFor("claude-code@2.1.220")?.multiSelectManyBytesProven,
		).toBe(false);
		expect(
			pickerContractFor("claude-code@2.1.226")?.multiSelectManyBytesProven,
		).toBe(true);
	});

	it("refuses a free-text answer for an N > 1 item that has no derived slot", () => {
		const questions = twoQuestions();
		questions[1] = { ...(questions[1] as QuestionItem), freeTextOption: null };
		let thrown: unknown;
		try {
			encodeAnswer(questions, [
				{ kind: "select", questionIndex: 0, optionIndex: 0 },
				{ kind: "freetext", questionIndex: 1, text: "anything" },
			]);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(KeystrokeEncodingError);
		expect((thrown as KeystrokeEncodingError).reason).toBe("kind_mismatch");
	});
});
