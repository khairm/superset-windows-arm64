import { describe, expect, it } from "bun:test";
import { encodeAnswer, KeystrokeEncodingError } from "./keystrokes";
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
// What is still refused is refused for reasons nobody has driven either way:
// multi-select free text, and free text on an N>1 prompt.
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
