import { describe, expect, it } from "bun:test";
import { encodeAnswer, KeystrokeEncodingError } from "./keystrokes";
import type { AnswerItem, QuestionItem } from "./types";

// ---------------------------------------------------------------------------
// (FREETEXT-CONTRACT-BROKEN)
//
// Established by driving the REAL installed claude-code (2.1.226) in a pty
// through a headless emulator, twice, and reading the screen the guard would
// read. The picker rendered:
//
//     ❯ 1. Yes
//          Enable the first canary option for this run.
//       2. Skip
//          Leave the second canary option alone entirely.
//       3. Type something.
//     ─────────────────────────────────────────────────
//       4. Chat about this
//
// Pressing a bare "3" did NOT open an inline editor. It moved the caret onto
// row 3 and changed the footer to "... · ctrl+g to edit in Notepad · Esc to
// cancel" — i.e. the row is FOCUSED, not opened. The fork's byte contract says
// digit N+1 opens the editor, so `[digit, text, "\r"]` would type the answer
// into a picker that is not accepting text and then commit whatever was focused.
//
// Until the real sequence is characterised, the shape is refused at the encoder.
// It must be refused THERE and not merely blocked by guard 5's screen check,
// because the label copy that guard 5 was tripping over has now been fixed —
// and one bug is not allowed to be the containment for another.
// ---------------------------------------------------------------------------

function singleSelectItem(): QuestionItem {
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
	};
}

describe("(FREETEXT-CONTRACT-BROKEN) the free-text shape fails closed", () => {
	it("refuses to encode a free-text answer as shape_unproven", () => {
		const answers: AnswerItem[] = [
			{ kind: "freetext", questionIndex: 0, text: "a written answer" },
		];
		let thrown: unknown;
		try {
			encodeAnswer([singleSelectItem()], answers);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(KeystrokeEncodingError);
		expect((thrown as KeystrokeEncodingError).reason).toBe("shape_unproven");
	});

	it("still encodes an ordinary option press — one bare digit, no Enter", () => {
		// The contract that IS still true on 2.1.226: the live desk answer landed a
		// tool_result in ~2s from a single byte, so options 1..N are unaffected by
		// the free-text refusal above.
		const keystrokes = encodeAnswer([singleSelectItem()], [
			{ kind: "select", questionIndex: 0, optionIndex: 1 },
		] as AnswerItem[]);
		expect(keystrokes.map((keystroke) => keystroke.data)).toEqual(["2"]);
		expect(keystrokes).toHaveLength(1);
	});
});
