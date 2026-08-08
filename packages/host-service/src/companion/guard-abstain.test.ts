import { describe, expect, it } from "bun:test";
import {
	ABSTAINING_GUARDS,
	type AnswerDeps,
	evaluateGuards,
	GUARD_CLASSES,
	type GuardSourceResult,
	LOAD_BEARING_GUARDS,
} from "./answer";
import type { PendingQuestion } from "./question-store";
import type { Fingerprint, QuestionId, TerminalId } from "./types";

// ---------------------------------------------------------------------------
// (GUARD4-ABSTAIN)
//
// Guard 4 reads `lastEventType === PermissionRequest` off the same
// hook-fed binding store guard 2 reads. It is a LATCH: any later hook event
// overwrites it, so an ordinary race between capturing a question and answering
// it clears the axis and the honest answer was refused with a wire code the
// client could not tell apart from staleness.
//
// It is also FORGEABLE in both directions — whoever could set it could clear it
// — so leaving it able to refuse handed an attacker a denial primitive and gave
// the defence nothing that guards 1 and 5 had not already proved. It therefore
// ABSTAINS, but only behind a condition that is checked rather than assumed, and
// the abstain is logged as its own verdict rather than disguised as a pass.
// ---------------------------------------------------------------------------

const TERMINAL_ID = "wire-terminal" as TerminalId;

function question(): PendingQuestion {
	return {
		questionId: "q-abstain" as QuestionId,
		fingerprint: "fp" as Fingerprint,
		state: "pending",
		askedAtMs: 1,
		resolvedAtMs: null,
		resolvedBy: null,
		toolUseId: "toolu_01",
		sessionId: "session-1",
		terminalId: TERMINAL_ID,
		agentType: null,
		questions: [
			{
				index: 0,
				header: "Duplicate pairs",
				question: "How should the leftover duplicate pairs be handled today?",
				multiSelect: false,
				options: [
					{ index: 0, label: "Retire the duplicates", description: "" },
					{ index: 1, label: "Escalate to the owner", description: "" },
				],
				freeTextOption: null,
			},
		],
		origin: "unauthenticated_localhost_hook",
		hostTerminalId: "host-terminal",
		hostWorkspaceId: "host-workspace",
		transcriptPath: "/transcripts/session-1.jsonl",
		agentKind: "claude",
		agentId: null,
	};
}

/** A viewport guard 5 passes on: prompt anchor, both rows, ascending. */
const PICKER_SCREEN = [
	" ☐ Duplicate pairs ",
	"",
	"How should the leftover duplicate pairs be handled today?",
	"",
	"❯ 1. Retire the duplicates",
	"  2. Escalate to the owner",
].join("\n");

/** A viewport guard 5 refuses: an idle composer. */
const COMPOSER_SCREEN = [
	"● Ran 4 tasks",
	"",
	"> ",
	"",
	"  ? for shortcuts",
].join("\n");

interface StubOptions {
	permissionAxis: GuardSourceResult | "throws";
	toolResultExists?: GuardSourceResult;
}

function deps(options: StubOptions): {
	deps: AnswerDeps;
	events: Record<string, unknown>[];
} {
	const events: Record<string, unknown>[] = [];
	const stub = {
		toolResultExists: async () =>
			options.toolResultExists === undefined ? false : options.toolResultExists,
		sessionActive: async () => true,
		agentBinding: async () => ({
			bound: true as const,
			kind: "claude" as const,
			agentSessionId: "session-1",
		}),
		permissionAxisLatched: async () => {
			if (options.permissionAxis === "throws") {
				throw new Error("binding store is not readable");
			}
			return options.permissionAxis;
		},
		askqMarkerExists: async () => true,
		log: (event: Record<string, unknown>) => {
			events.push(event);
		},
	};
	return { deps: stub as unknown as AnswerDeps, events };
}

async function evaluate(options: StubOptions, screen: string) {
	const { deps: stub, events } = deps(options);
	const outcome = await evaluateGuards(stub, {
		question: question(),
		screen,
		expectation: { kind: "item_picker", itemIndex: 0 },
		requireOptionIndex: 0,
	});
	return { outcome, events };
}

describe("(GUARD4-ABSTAIN) the permission axis", () => {
	it("is classified forgeable and is the only guard allowed to abstain", () => {
		expect(GUARD_CLASSES.permission_axis).toBe("forgeable");
		expect([...ABSTAINING_GUARDS]).toEqual(["permission_axis"]);
		// The other forgeable guard still refuses: `binding` proves the captured
		// question belongs to the agent session on the terminal right now, which
		// neither the transcript nor the screen says anything about.
		expect(ABSTAINING_GUARDS).not.toContain("binding");
		expect([...LOAD_BEARING_GUARDS]).toEqual(["transcript", "screen"]);
	});

	it("a latched axis passes, with nothing abstained", async () => {
		const { outcome, events } = await evaluate(
			{ permissionAxis: true },
			PICKER_SCREEN,
		);
		expect(outcome.failed).toBeNull();
		expect(outcome.abstained).toEqual([]);
		expect(outcome.evaluation.permission_axis).toBe(true);
		expect(events.filter((e) => e.event === "companion.guard.abstain")).toEqual(
			[],
		);
	});

	it("a CLEARED axis abstains once transcript and screen have both passed", async () => {
		const { outcome, events } = await evaluate(
			{ permissionAxis: false },
			PICKER_SCREEN,
		);
		expect(outcome.failed).toBeNull();
		expect(outcome.abstained).toEqual(["permission_axis"]);
		// The RAW reading survives into the ledger's evidence. An abstain carries
		// the answer; it does not invent a latch that was not there.
		expect(outcome.evaluation.permission_axis).toBe(false);
		const abstains = events.filter(
			(e) => e.event === "companion.guard.abstain",
		);
		expect(abstains).toHaveLength(1);
		expect(abstains[0]?.guard).toBe("permission_axis");
		expect(abstains[0]?.reading).toBe("clear");
	});

	it("an UNREADABLE axis abstains too, and says which of the two it was", async () => {
		const unreadable = await evaluate({ permissionAxis: null }, PICKER_SCREEN);
		expect(unreadable.outcome.failed).toBeNull();
		expect(unreadable.outcome.abstained).toEqual(["permission_axis"]);
		expect(
			unreadable.events.find((e) => e.event === "companion.guard.abstain")
				?.reading,
		).toBe("unreadable");

		const threw = await evaluate({ permissionAxis: "throws" }, PICKER_SCREEN);
		expect(threw.outcome.failed).toBeNull();
		expect(
			threw.events.find((e) => e.event === "companion.guard.abstain")?.reading,
		).toBe("unreadable");
		// The throw is still reported on its own event; an abstain does not swallow
		// the fact that a source blew up.
		expect(threw.events.some((e) => e.event === "companion.guard.error")).toBe(
			true,
		);
	});

	it("a cleared axis on a screen guard 5 refuses is still an overall refusal", async () => {
		// The abstain cannot rescue anything: guard 5 short-circuits ahead of it, so
		// the axis is not even read on a screen that does not show this picker.
		const { outcome, events } = await evaluate(
			{ permissionAxis: false },
			COMPOSER_SCREEN,
		);
		expect(outcome.failed).toBe("screen");
		expect(outcome.abstained).toEqual([]);
		expect(events.filter((e) => e.event === "companion.guard.abstain")).toEqual(
			[],
		);
	});

	it("a cleared axis behind a failed transcript refuses on the transcript", async () => {
		const { outcome } = await evaluate(
			{ permissionAxis: false, toolResultExists: true },
			PICKER_SCREEN,
		);
		expect(outcome.failed).toBe("transcript");
		expect(outcome.abstained).toEqual([]);
	});

	it("an unreadable transcript still refuses — 'cannot check' is not a pass", async () => {
		const { outcome } = await evaluate(
			{ permissionAxis: true, toolResultExists: null },
			PICKER_SCREEN,
		);
		expect(outcome.failed).toBe("transcript");
	});
});
