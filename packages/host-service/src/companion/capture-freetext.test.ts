import { describe, expect, it } from "bun:test";
import { provenFreeTextRowLabel } from "./keystrokes";
import { validateCapture } from "./question-store";

// ---------------------------------------------------------------------------
// (PICKER-CONTRACT-VERSIONED) The capture producer and the capture validator
// must agree about the free-text row's label.
//
// They held the literal independently, kept in agreement by a comment. When they
// drifted, `validateCapture` rejected EVERY single-question non-multiSelect
// capture at ingestion: the hook 500s, the question is never stored, and the
// phone is never notified — the whole feature off, silently. Nothing caught it
// because every other test passes `freeTextOption: null`, which skips the
// cross-check entirely.
//
// So these cases go through `validateCapture` with a SINK-SHAPED payload — one
// that carries the slot the way the producer emits it.
// ---------------------------------------------------------------------------

function sinkShapedCapture(freeTextOption: unknown) {
	return {
		hostTerminalId: "term-live",
		workspaceId: "w-1",
		projectId: "p-1",
		toolUseId: "tu-1",
		sessionId: "s-1",
		transcriptPath: "C:/tmp/session.jsonl",
		cwd: "C:/tmp",
		agentId: null,
		agentType: null,
		askedAtMs: Date.now(),
		questions: [
			{
				index: 0,
				header: "Dedupe fix",
				question: "How should alert-once be enforced?",
				multiSelect: false,
				options: [
					{
						index: 0,
						label: "DB timestamp",
						description: "Persist a timestamp on the row.",
					},
					{
						index: 1,
						label: "Stateless age-band",
						description: "No storage anywhere; alert inside a window.",
					},
				],
				freeTextOption,
			},
		],
	};
}

describe("(PICKER-CONTRACT-VERSIONED) producer/validator agreement", () => {
	it("accepts the slot exactly as the producer derives it", () => {
		const label = provenFreeTextRowLabel();
		// Today the proven build has a proven free-text sequence, so a label exists.
		// If that ever becomes null the producer emits no slot and the branch below
		// is the one that matters.
		const slot = label === null ? null : { index: 2, label };
		expect(() => validateCapture(sinkShapedCapture(slot))).not.toThrow();
	});

	it("rejects a slot whose label is not the derived one", () => {
		// The cross-check is the thing that broke; prove it still fires, so the
		// agreement above is not vacuously true.
		expect(() =>
			validateCapture(sinkShapedCapture({ index: 2, label: "Type anything" })),
		).toThrow();
	});

	it("rejects a slot at the wrong index", () => {
		const label = provenFreeTextRowLabel() ?? "Other";
		expect(() =>
			validateCapture(sinkShapedCapture({ index: 5, label })),
		).toThrow();
	});

	it("accepts a capture that omits the slot entirely", () => {
		expect(() => validateCapture(sinkShapedCapture(undefined))).not.toThrow();
	});
});
