/**
 * (PICKER-CHROME) The `/v1/message` screen check.
 *
 * `screenShowsPickerChrome` is the only screen evidence the bridge has that no
 * caller can parameterise, and it is the one thing standing between a phone
 * message and a bare `\r` written into an open picker. It is deliberately
 * ASYMMETRIC: a false positive costs one refused message, a false negative
 * toggles a multi-select row or submits a review screen irreversibly. These
 * tests pin that asymmetry — the "must match" block is the safety property, the
 * "must not match" block only guards against refusing everything.
 */
import { describe, expect, it } from "bun:test";
import { PICKER_CHROME_MIN_ROWS, screenShowsPickerChrome } from "./answer";

/** The shape the detector exists for: a Claude Code AskUserQuestion picker. */
const LIVE_PICKER = [
	"╭──────────────────────────────────────────────╮",
	"│ Ship the release?                            │",
	"│                                              │",
	"│ ❯ 1. Yes, publish it now                     │",
	"│   2. No, hold for review                     │",
	"│   3. Ask me again tomorrow                   │",
	"╰──────────────────────────────────────────────╯",
].join("\n");

describe("(PICKER-CHROME) screens that MUST be detected", () => {
	it("the live picker render", () => {
		expect(screenShowsPickerChrome(LIVE_PICKER)).toBe(true);
	});

	it("bare numbered rows with no decoration at all", () => {
		expect(screenShowsPickerChrome("1. Yes\n2. No")).toBe(true);
	});

	it("every row separator the CLI is known to use", () => {
		for (const separator of [".", ")", "]", ":", ""]) {
			expect(
				screenShowsPickerChrome(`1${separator} Yes\n2${separator} No`),
			).toBe(true);
		}
	});

	it("rows separated by an UNBOUNDED gap — a wrapped label is not suspicious", () => {
		const wrapped = [
			"  1. Rebuild the index, which on this machine means dropping",
			"     every secondary index and replaying the write-ahead log",
			"     from the last checkpoint before it can be brought online",
			"",
			"",
			"  2. Leave it alone",
		].join("\n");

		expect(screenShowsPickerChrome(wrapped)).toBe(true);
	});

	it("a continuation line that merely starts with a digit does not end the run", () => {
		// "3 tables and rebuilding…" matches the row pattern with digit 3 between
		// rows 1 and 2. Resetting the run on it hid a real picker.
		const withDecoy = [
			"1. Rebuild the index by dropping",
			"3 tables and rebuilding every one",
			"2. Leave it alone",
		].join("\n");

		expect(screenShowsPickerChrome(withDecoy)).toBe(true);
	});

	it("deep indentation plus box drawing plus a selection caret", () => {
		expect(screenShowsPickerChrome("│      ❯ 1. Yes\n│        2. No")).toBe(
			true,
		);
	});

	it("a picker whose last row is the final line of the viewport", () => {
		expect(screenShowsPickerChrome("Pick one\n1. Yes\n2. No")).toBe(true);
	});
});

describe("(PICKER-CHROME) screens that must NOT be detected", () => {
	it("an empty screen", () => {
		expect(screenShowsPickerChrome("")).toBe(false);
	});

	it("an idle composer", () => {
		expect(
			screenShowsPickerChrome(
				"╭─────────────╮\n│ >           │\n╰─────────────╯",
			),
		).toBe(false);
	});

	it("a single numbered row — one row is not a run", () => {
		expect(PICKER_CHROME_MIN_ROWS).toBe(2);
		expect(screenShowsPickerChrome("1. Yes")).toBe(false);
	});

	it("rows rendered in DESCENDING order", () => {
		expect(screenShowsPickerChrome("3. c\n2. b\n1. a")).toBe(false);
	});

	it("a run that never starts at 1", () => {
		expect(screenShowsPickerChrome("2. b\n3. c\n4. d")).toBe(false);
	});

	it("prose that merely contains numbers mid-line", () => {
		expect(
			screenShowsPickerChrome(
				"Wrote 1 file and 2 directories\nRead 2 files in 3 ms",
			),
		).toBe(false);
	});

	it("multi-digit list markers", () => {
		// `[1-9]` then an optional separator then whitespace: "12." never matches,
		// so a long numbered log cannot be mistaken for a picker on its tail.
		expect(screenShowsPickerChrome("11. eleven\n12. twelve")).toBe(false);
	});

	it("a zero-indexed list", () => {
		expect(screenShowsPickerChrome("0. zero\n1. one")).toBe(false);
	});

	it("a numbered row with nothing after the number", () => {
		expect(screenShowsPickerChrome("1.\n2.")).toBe(false);
	});
});
