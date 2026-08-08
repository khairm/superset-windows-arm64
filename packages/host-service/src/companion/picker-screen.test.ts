import { describe, expect, it } from "bun:test";
import { matchPickerScreen } from "./answer";
import type { QuestionItem } from "./types";

// ---------------------------------------------------------------------------
// (GUARD5-PICKER-GEOMETRY)
//
// Guard 5 is the only check that proves the digit about to be typed maps, on the
// screen as rendered right now, to the option the bridge believes it selects. It
// used to assert that the option rows sat inside one narrow BAND of screen
// lines, on the assumption that a picker renders its options on near-consecutive
// lines. Claude Code does not: it renders every option's DESCRIPTION under the
// row, wrapped, so four options span ten or more lines. The band admitted seven.
// Every real description-bearing picker was therefore refused with
// `rows_out_of_order`, and the fleet's answer_attempts held zero confirmations.
//
// The band is now the picker-block rule: rows in ascending digit order, with
// every gap between consecutive rows explained by the render of the option above
// it. These cases pin BOTH directions — the honest pickers that must pass, and
// the scattered/forged screens that must still be refused, because a false
// positive here types a bare digit into whatever is actually on screen.
// ---------------------------------------------------------------------------

/**
 * The real thing: an UNEDITED 120-column viewport captured off the live headless
 * emulator through `terminal.snapshot` — the same read `AnswerDeps.snapshotScreen`
 * performs — while the prompt below was blocking a Claude Code agent.
 *
 * Its four option rows sit on screen lines 16, 20, 23 and 26: a ten-line spread,
 * because Claude Code renders each option's wrapped description under its row.
 * `LIVE_ROW_SPREAD_LINES` asserts that spread so this fixture cannot quietly
 * become a picker whose rows are adjacent, which would make every case below
 * pass without exercising the gap rule at all.
 */
const LIVE_VIEWPORT = `

● Stop Task
  ⎿  SELECT-only sizing scan on production Neon. Report... · stopped
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 ☐ 587 dup pairs 

Leftover duplicates follow-up — the picture changed once we measured. We re-counted the duplicate pairs the new code    
sees but deliberately leaves alone (they sit on a resident's OTHER live chart, which the fix doesn't touch by design).  
Live count today: 587 pairs across 225 residents in 45 homes. We expected most to be yesterday's restored 
known-different products — wrong: only 11 of 587 relate to the restorations or the backfill. The other 576 are plain    
migration duplicates, e.g. one resident has "Paracetamol 500mg tablets" AND "Paracetamol 500mg Tablets" — same product, 
capitalisation twin. Another: "Lactulose 3.1-3.7g/5ml oral solution" twice. (Earlier count of 612 drifted to 587 from   
normal data churn.) These won't grow — the new code stops new ones — but the existing 576 stay until those charts end.  
How do you want them handled?

❯ 1. Batch + judged remainder (Recommended)
     Same rule as the approved 8,996 sweep: auto-retire exact same-product twins, and a judgement review on any pair    
     that doesn't qualify. I'll prepare an approval brief with exact counts and undo plan — nothing written until you   
     approve it.
  2. Judged review of all 587
     Same as yesterday's case-by-case reviews (the 211 and the 1,091): an agent judges every pair individually, retires 
     with full undo. Slower/heavier but every pair gets eyes.
  3. Leave them
     No action. New duplicates can't accumulate any more; these existing ones disappear naturally as their charts end   
     and regenerate.
  4. Show me a sample first
     I'll produce a readable HTML sample (e.g. 30 pairs across homes) so you can see what they look like before
     deciding.
  5. Type something.
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  6. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel

  44 tasks (38 done, 2 in progress, 4 open)
  ◼ /simplify: all 4 seats reported (26 raw findings); 13 applying via 2 repo lanes; BANKED: hub pass-2 port…
  ◼ OWNER Q live: 587 deferred pairs — 576 genuinely new migration twins (not restore/backfill residue); ask…
  ◻ Housekeeping: extend portal 53-col header per opus MINOR (comment-only, next portal commit)
  ◻ OWNER Q: appliance classifier catches real medicines (Logynon example) — measure + rule
  ◻ OWNER Qs (morning): 211 deferred appliance twins (SETTLED) + clinical review of 1,091 swept rows
   … +1 pending, 38 completed`;

/** From the AskUserQuestion `tool_use` that raised the prompt above. */
const LIVE_ITEM: QuestionItem = {
	index: 0,
	header: "587 dup pairs",
	question:
		'Leftover duplicates follow-up — the picture changed once we measured. We re-counted the duplicate pairs the new code sees but deliberately leaves alone (they sit on a resident\'s OTHER live chart, which the fix doesn\'t touch by design). Live count today: 587 pairs across 225 residents in 45 homes. We expected most to be yesterday\'s restored known-different products — wrong: only 11 of 587 relate to the restorations or the backfill. The other 576 are plain migration duplicates, e.g. one resident has "Paracetamol 500mg tablets" AND "Paracetamol 500mg Tablets" — same product, capitalisation twin. Another: "Lactulose 3.1-3.7g/5ml oral solution" twice. (Earlier count of 612 drifted to 587 from normal data churn.) These won\'t grow — the new code stops new ones — but the existing 576 stay until those charts end. How do you want them handled?',
	multiSelect: false,
	options: [
		{
			index: 0,
			label: "Batch + judged remainder (Recommended)",
			description:
				"Same rule as the approved 8,996 sweep: auto-retire exact same-product twins, and a judgement review on any pair that doesn't qualify. I'll prepare an approval brief with exact counts and undo plan — nothing written until you approve it.",
		},
		{
			index: 1,
			label: "Judged review of all 587",
			description:
				"Same as yesterday's case-by-case reviews (the 211 and the 1,091): an agent judges every pair individually, retires with full undo. Slower/heavier but every pair gets eyes.",
		},
		{
			index: 2,
			label: "Leave them",
			description:
				"No action. New duplicates can't accumulate any more; these existing ones disappear naturally as their charts end and regenerate.",
		},
		{
			index: 3,
			label: "Show me a sample first",
			description:
				"I'll produce a readable HTML sample (e.g. 30 pairs across homes) so you can see what they look like before deciding.",
		},
	],
	freeTextOption: { index: 4, label: "Other" },
};

/**
 * The distance, in screen lines, between the live fixture's first and last
 * option rows. Asserted below: if this fixture is ever replaced by one whose
 * rows are adjacent, every case in this file would pass without exercising the
 * gap rule at all, and the bug would be free to come back.
 */
const LIVE_ROW_SPREAD_LINES = 10;

/** Screen lines that open with `<decoration><digit>. <text>`. */
function optionRowLines(screen: string): number[] {
	const lines = screen.split("\n");
	const found: number[] = [];
	for (let i = 0; i < lines.length; i += 1) {
		if (/^[^0-9A-Za-z]*[1-9]\.\s\S/.test(lines[i] ?? "")) found.push(i);
	}
	return found;
}

function wrap(text: string, cols: number, indent: string): string[] {
	const out: string[] = [];
	let line = "";
	for (const word of text.split(" ")) {
		if (`${line} ${word}`.trim().length + indent.length > cols) {
			out.push(indent + line.trim());
			line = word;
		} else {
			line = `${line} ${word}`;
		}
	}
	if (line.trim().length > 0) out.push(indent + line.trim());
	return out;
}

/** The live fixture's layout, re-rendered at an arbitrary column width. */
function renderPicker(
	item: QuestionItem,
	cols: number,
	rowPrefix: (index: number) => string = (index) => (index === 0 ? "❯ " : "  "),
): string[] {
	const lines: string[] = ["", ` ☐ ${item.header} `, ""];
	lines.push(...wrap(item.question, cols, ""));
	lines.push("");
	for (const option of item.options) {
		lines.push(
			`${rowPrefix(option.index)}${option.index + 1}. ${option.label}`,
		);
		if (option.description.length > 0) {
			lines.push(...wrap(option.description, cols, "     "));
		}
	}
	if (item.freeTextOption !== null) {
		lines.push(`  ${item.freeTextOption.index + 1}. Type something.`);
	}
	lines.push("", "Enter to select · ↑/↓ to navigate · Esc to cancel");
	return lines;
}

function item(overrides: Partial<QuestionItem> = {}): QuestionItem {
	return {
		index: 0,
		header: "Duplicate pairs",
		question: "How should the leftover duplicate pairs be handled today?",
		multiSelect: false,
		options: [
			{ index: 0, label: "Retire the duplicates", description: "" },
			{ index: 1, label: "Escalate to the owner", description: "" },
			{ index: 2, label: "Do nothing today", description: "" },
		],
		freeTextOption: null,
		...overrides,
	};
}

const FILLER = "  running the sizing scan and printing its output";

describe("(GUARD5-PICKER-GEOMETRY) the live canary", () => {
	it("the fixture really does spread its rows — this file is not vacuous", () => {
		// 29 is the free-text row ("Type something.") and 31 the "Chat about this"
		// affordance; neither belongs to the item, and both are below option 4.
		const rows = optionRowLines(LIVE_VIEWPORT);
		expect(rows).toEqual([16, 20, 23, 26, 29, 31]);
		expect((rows[3] ?? 0) - (rows[0] ?? 0)).toBe(LIVE_ROW_SPREAD_LINES);
	});

	it("matches every option of the real picker that was refused", () => {
		for (const requireOptionIndex of [0, 1, 2, 3, null]) {
			expect(
				matchPickerScreen({
					screen: LIVE_VIEWPORT,
					item: LIVE_ITEM,
					requireOptionIndex,
				}),
			).toEqual({ ok: true, reason: "match", missing: [], digitMapped: true });
		}
	});

	it("matches the same prompt re-rendered at 80, 100 and 120 columns", () => {
		for (const cols of [80, 100, 120]) {
			const screen = renderPicker(LIVE_ITEM, cols).join("\n");
			expect(optionRowLines(screen).length).toBeGreaterThanOrEqual(4);
			expect(
				matchPickerScreen({ screen, item: LIVE_ITEM, requireOptionIndex: 0 })
					.ok,
			).toBe(true);
		}
	});
});

describe("(GUARD5-PICKER-GEOMETRY) honest pickers that must pass", () => {
	it("options with no descriptions, rendered on consecutive lines", () => {
		const subject = item();
		const screen = renderPicker(subject, 100).join("\n");
		expect(
			matchPickerScreen({ screen, item: subject, requireOptionIndex: 1 }).ok,
		).toBe(true);
	});

	it("blank separator lines between rows", () => {
		const subject = item();
		const screen = [
			` ☐ ${subject.header} `,
			"",
			"  1. Retire the duplicates",
			"",
			"",
			"  2. Escalate to the owner",
			"",
			"",
			"  3. Do nothing today",
		].join("\n");
		expect(
			matchPickerScreen({ screen, item: subject, requireOptionIndex: 2 }).ok,
		).toBe(true);
	});

	it("a label that wraps across three lines", () => {
		const long =
			"Retire the duplicates now and prepare an approval brief with exact counts, the undo plan and the per-home breakdown";
		const subject = item({
			options: [
				{ index: 0, label: long, description: "" },
				{ index: 1, label: "Escalate to the owner", description: "" },
			],
		});
		const wrapped = wrap(`  1. ${long}`, 46, "     ");
		expect(wrapped.length).toBe(3);
		const screen = [
			` ☐ ${subject.header} `,
			"",
			...wrapped,
			"  2. Escalate to the owner",
		].join("\n");
		expect(
			matchPickerScreen({ screen, item: subject, requireOptionIndex: 0 }).ok,
		).toBe(true);
	});

	it("a multi-select picker's checkbox chrome", () => {
		const subject = item({ multiSelect: true });
		const screen = renderPicker(subject, 100, (index) =>
			index === 0 ? " ❯ ◼ " : "   ◻ ",
		).join("\n");
		expect(
			matchPickerScreen({ screen, item: subject, requireOptionIndex: 0 }).ok,
		).toBe(true);
	});

	it("the free-text row is only required when its own digit is pressed", () => {
		// (GUARD5-FREETEXT-COPY) The live picker renders its free-text slot as
		// "Type something.", not the bridge-derived "Other" that the item carries,
		// so the row is matched against the copy read out of the Claude Code binary
		// rather than against `freeTextOption.label`.
		expect(
			matchPickerScreen({
				screen: LIVE_VIEWPORT,
				item: LIVE_ITEM,
				requireOptionIndex: 3,
			}).ok,
		).toBe(true);
		expect(
			matchPickerScreen({
				screen: LIVE_VIEWPORT,
				item: LIVE_ITEM,
				requireOptionIndex: 4,
			}),
		).toEqual({ ok: true, reason: "match", missing: [], digitMapped: true });
	});

	it("short labels — the live 'Skip' refusal — answer on their descriptions", () => {
		// The round-2 live failure: four options, the fourth just "Skip", refused
		// with anchor_too_weak / option:3 — a row the user was not even pressing.
		const subject = item({
			header: "Dup pairs",
			options: [
				{
					index: 0,
					label: "Yes",
					description:
						"Retire the exact same-product twins now and prepare the approval brief with counts.",
				},
				{
					index: 1,
					label: "No",
					description:
						"Leave every pair in place; new duplicates cannot accumulate any more anyway.",
				},
				{
					index: 2,
					label: "Later",
					description:
						"Revisit this after the clinical review of the 1,091 swept rows has landed.",
				},
				{
					index: 3,
					label: "Skip",
					description:
						"Do not ask again for this resident; move straight on to the next home.",
				},
			],
		});
		const screen = renderPicker(subject, 100).join("\n");
		for (const requireOptionIndex of [0, 1, 2, 3]) {
			expect(
				matchPickerScreen({ screen, item: subject, requireOptionIndex }),
			).toEqual({ ok: true, reason: "match", missing: [], digitMapped: true });
		}
	});

	it("a trailing 'Chat about this' row does not disturb options 1..N", () => {
		// Read out of the CLI: rows are [...options, freetext, chat?], the chat row
		// is context-gated and carries the sentinel "__chat__", so it neither shifts
		// a digit nor is answerable. Unknown trailing rows must be tolerated.
		const subject = item({ freeTextOption: { index: 3, label: "Other" } });
		const screen = [
			...renderPicker(subject, 100),
			"  5. Chat about this",
			"  6. Some row a later Claude Code invented",
		].join("\n");
		for (const requireOptionIndex of [0, 1, 2]) {
			expect(
				matchPickerScreen({ screen, item: subject, requireOptionIndex }).ok,
			).toBe(true);
		}
	});

	it("an N-question prompt, where the digits restart for every question", () => {
		const first = item({
			index: 0,
			header: "Duplicate pairs",
			options: [
				{ index: 0, label: "Retire the duplicates", description: "" },
				{ index: 1, label: "Keep everything as it is", description: "" },
				{ index: 2, label: "Show me a sample first", description: "" },
			],
		});
		// Deliberately shares its FIRST label with `first`, so the digit-1 row
		// matches in both blocks and only the SECOND block can complete the chain.
		const second = item({
			index: 1,
			header: "Appliance twins",
			question: "And what about the 211 deferred appliance twins?",
			options: [
				{ index: 0, label: "Retire the duplicates", description: "" },
				{ index: 1, label: "Escalate to the owner", description: "" },
				{ index: 2, label: "Do nothing today", description: "" },
			],
		});
		const screen = [
			...renderPicker(first, 100),
			...Array.from({ length: 12 }, () => FILLER),
			...renderPicker(second, 100),
		].join("\n");
		for (const subject of [first, second]) {
			expect(
				matchPickerScreen({ screen, item: subject, requireOptionIndex: 1 }).ok,
			).toBe(true);
		}
	});
});

describe("(GUARD5-PICKER-GEOMETRY) screens that must still be refused", () => {
	it("an empty screen", () => {
		expect(
			matchPickerScreen({ screen: "", item: item(), requireOptionIndex: 0 }),
		).toEqual({
			ok: false,
			reason: "empty_screen",
			missing: ["screen"],
			digitMapped: true,
		});
	});

	it("an idle composer with no prompt on it", () => {
		const screen = [
			"● Ran 4 tasks",
			"  ⎿  sizing scan complete",
			"",
			"> ",
			"",
			"  ? for shortcuts",
		].join("\n");
		expect(
			matchPickerScreen({ screen, item: item(), requireOptionIndex: 0 }).reason,
		).toBe("anchor_absent");
	});

	it("the prompt on screen but no numbered rows under it", () => {
		const subject = item();
		const screen = [
			` ☐ ${subject.header} `,
			"",
			subject.question,
			"",
			"  (the user scrolled the options away)",
		].join("\n");
		expect(
			matchPickerScreen({ screen, item: subject, requireOptionIndex: 0 }),
		).toEqual({
			ok: false,
			reason: "row_absent",
			missing: ["option:0", "option:1", "option:2"],
			digitMapped: true,
		});
	});

	it("every row present but rendered in descending digit order", () => {
		const subject = item();
		const screen = [
			` ☐ ${subject.header} `,
			"",
			"  3. Do nothing today",
			"  2. Escalate to the owner",
			"  1. Retire the duplicates",
		].join("\n");
		expect(
			matchPickerScreen({ screen, item: subject, requireOptionIndex: 0 }),
		).toEqual({
			ok: false,
			reason: "rows_out_of_order",
			missing: ["row_order"],
			digitMapped: true,
		});
	});

	it("rows scattered through unrelated output — nothing explains the gaps", () => {
		const subject = item({
			options: LIVE_ITEM.options.slice(0, 3),
		});
		const lines: string[] = [` ☐ ${subject.header} `, "", subject.question, ""];
		for (const option of subject.options) {
			lines.push(`  ${option.index + 1}. ${option.label}`);
			for (let i = 0; i < 8; i += 1) lines.push(FILLER);
		}
		expect(
			matchPickerScreen({
				screen: lines.join("\n"),
				item: subject,
				requireOptionIndex: 0,
			}),
		).toEqual({
			ok: false,
			reason: "row_gap_unexplained",
			missing: ["row_block"],
			digitMapped: true,
		});
	});

	it("a gap filled by the WRONG option's description", () => {
		const subject = item({ options: LIVE_ITEM.options.slice(0, 3) });
		const wrongFiller = wrap(
			LIVE_ITEM.options[2]?.description ?? "",
			60,
			"     ",
		);
		const lines: string[] = [` ☐ ${subject.header} `, "", subject.question, ""];
		for (const option of subject.options) {
			lines.push(`  ${option.index + 1}. ${option.label}`);
			lines.push(...wrongFiller, FILLER, FILLER, FILLER);
		}
		expect(
			matchPickerScreen({
				screen: lines.join("\n"),
				item: subject,
				requireOptionIndex: 0,
			}).reason,
		).toBe("row_gap_unexplained");
	});

	it("a short description cannot buy a gap longer than it can fill", () => {
		const short = "Retire them now.";
		const subject = item({
			options: [
				{ index: 0, label: "Retire the duplicates", description: short },
				{ index: 1, label: "Escalate to the owner", description: "" },
			],
		});
		const lines: string[] = [
			` ☐ ${subject.header} `,
			"",
			"  1. Retire the duplicates",
			`     ${short}`,
		];
		for (let i = 0; i < 20; i += 1) lines.push(FILLER);
		lines.push("  2. Escalate to the owner");
		expect(
			matchPickerScreen({
				screen: lines.join("\n"),
				item: subject,
				requireOptionIndex: 0,
			}).reason,
		).toBe("row_gap_unexplained");
	});

	it("a forged item whose labels are too short to be evidence", () => {
		const subject = item({
			header: "c",
			question: "c",
			options: [{ index: 0, label: "2", description: "" }],
		});
		expect(
			matchPickerScreen({
				screen: "  12\n  > ",
				item: subject,
				requireOptionIndex: 0,
			}).ok,
		).toBe(false);
	});

	it("a real screen answered with an item carrying one-character labels", () => {
		// (GUARD5-EVIDENCE-TIERS) The rows are deliberately PRESENT here, so the
		// only thing left to refuse on is the pressed row's evidence — this is the
		// forgery the anchor floor was built for, and it is still refused.
		const subject = item({
			options: [
				{ index: 0, label: "A", description: "" },
				{ index: 1, label: "B", description: "" },
			],
		});
		const screen = [
			` ☐ ${subject.header} `,
			"",
			subject.question,
			"",
			"  1. A",
			"  2. B",
			"",
			"> ",
		].join("\n");
		expect(
			matchPickerScreen({ screen, item: subject, requireOptionIndex: 0 }),
		).toEqual({
			ok: false,
			reason: "anchor_too_weak",
			missing: ["option:0"],
			digitMapped: true,
		});
	});

	it("a short label whose description is NOT on screen", () => {
		// The description is the substitute for a weak label, so it has to actually
		// be rendered. Claiming one that is absent must not answer.
		const subject = item({
			options: [
				{
					index: 0,
					label: "Yes",
					description: "Retire every duplicate pair across all 45 homes now.",
				},
				{ index: 1, label: "Escalate to the owner", description: "" },
			],
		});
		const screen = [
			` ☐ ${subject.header} `,
			"",
			subject.question,
			"",
			"  1. Yes",
			"  2. Escalate to the owner",
		].join("\n");
		expect(
			matchPickerScreen({ screen, item: subject, requireOptionIndex: 0 }),
		).toEqual({
			ok: false,
			reason: "anchor_too_weak",
			missing: ["option:0"],
			digitMapped: true,
		});
		// ...while the strongly-labelled sibling is still answerable on the same
		// screen, because the tier applies to the row being pressed.
		expect(
			matchPickerScreen({ screen, item: subject, requireOptionIndex: 1 }).ok,
		).toBe(true);
	});

	it("an all-weak item with no digit pressed anchors on nothing", () => {
		const subject = item({
			options: [
				{ index: 0, label: "A", description: "" },
				{ index: 1, label: "B", description: "" },
			],
		});
		const screen = [
			` ☐ ${subject.header} `,
			"",
			subject.question,
			"",
			"  1. A",
			"  2. B",
		].join("\n");
		expect(
			matchPickerScreen({ screen, item: subject, requireOptionIndex: null }),
		).toEqual({
			ok: false,
			reason: "anchor_too_weak",
			missing: ["row_evidence"],
			digitMapped: true,
		});
	});

	it("a free-text digit pressed against copy the fork has never proven", () => {
		const subject = item({
			options: LIVE_ITEM.options.slice(0, 2),
			freeTextOption: { index: 2, label: "Other" },
		});
		const screen = [
			...renderPicker(subject, 100).filter(
				(line) => !line.includes("Type something"),
			),
			"  3. Write your own answer",
		].join("\n");
		expect(
			matchPickerScreen({ screen, item: subject, requireOptionIndex: 2 }),
		).toEqual({
			ok: false,
			reason: "row_absent",
			missing: ["freetext:2"],
			digitMapped: true,
		});
	});
});
