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
	freeTextOption: { index: 4, label: "Type something." },
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

	it("the free-text digit matches the real row on the live capture", () => {
		// (GUARD5-FREETEXT-PLACEMENT) The proven contract for the installed build
		// derives "Type something.", which is exactly what this real 2.1.226 capture
		// renders at digit 5 — so the free-text digit is answerable against real
		// bytes. The negative below keeps the label doing work.
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

	it("a free-text label that is not the proven copy is refused", () => {
		expect(
			matchPickerScreen({
				screen: LIVE_VIEWPORT,
				item: {
					...LIVE_ITEM,
					freeTextOption: { index: 4, label: "Write your own answer" },
				},
				requireOptionIndex: 4,
			}),
		).toEqual({
			ok: false,
			reason: "row_absent",
			missing: ["freetext:4"],
			digitMapped: true,
		});
	});

	it("matches when the last option row is the final line of the viewport", () => {
		// Regression: every line must be able to START a window, or a picker whose
		// last row sits on the last line is refused once rows are line-anchored.
		const subject = item();
		const screen = [
			` ☐ ${subject.header} `,
			"",
			"  1. Retire the duplicates",
			"  2. Escalate to the owner",
			"  3. Do nothing today",
		].join("\n");
		expect(
			matchPickerScreen({ screen, item: subject, requireOptionIndex: 2 }).ok,
		).toBe(true);
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

describe("(GUARD5-MATCHED-BUDGET) reviewer findings", () => {
	const HAN =
		"该选项会立即停用所有重复的用药记录并生成一份完整的审计报告供您在批准之前仔细检查每一项内容";

	it("a CJK description wraps to twice as many lines and still matches", () => {
		// (GUARD5-CELL-WIDTH) 46 Han characters are 46 code units but 92 cells, so a
		// length-based budget under-counted the real rendered lines and refused.
		const subject = item({
			options: [
				{ index: 0, label: "Retire the duplicates", description: HAN },
				{ index: 1, label: "Escalate to the owner", description: "" },
			],
		});
		const lines = [` ☐ ${subject.header} `, "", "  1. Retire the duplicates"];
		// 20 Han per line = 40 cells, the honest wrap at ~46 columns.
		for (let i = 0; i < HAN.length; i += 20) {
			lines.push(`     ${HAN.slice(i, i + 20)}`);
		}
		lines.push("  2. Escalate to the owner");
		expect(
			matchPickerScreen({
				screen: lines.join("\n"),
				item: subject,
				requireOptionIndex: 0,
			}).ok,
		).toBe(true);
	});

	it("a narrow viewport (~30 cells) still matches", () => {
		const description =
			"Retire the exact same-product twins and prepare the approval brief.";
		const subject = item({
			options: [
				{ index: 0, label: "Retire the duplicates", description },
				{ index: 1, label: "Escalate to the owner", description: "" },
			],
		});
		const lines = [
			" ☐ Duplicate pairs ",
			"",
			"  1. Retire the",
			"     duplicates",
		];
		for (const chunk of description.match(/.{1,24}/g) ?? []) {
			lines.push(`    ${chunk}`);
		}
		lines.push("  2. Escalate to the");
		lines.push("     owner");
		expect(
			matchPickerScreen({
				screen: lines.join("\n"),
				item: subject,
				requireOptionIndex: 0,
			}).ok,
		).toBe(true);
	});

	it("a tab-indented description still matches", () => {
		const description = "Retire the twins and prepare the approval brief.";
		const subject = item({
			options: [
				{ index: 0, label: "Retire the duplicates", description },
				{ index: 1, label: "Escalate to the owner", description: "" },
			],
		});
		const screen = [
			" ☐ Duplicate pairs ",
			"",
			"  1. Retire the duplicates",
			`\t${description}`,
			"  2. Escalate to the owner",
		].join("\n");
		expect(
			matchPickerScreen({ screen, item: subject, requireOptionIndex: 0 }).ok,
		).toBe(true);
	});

	it("a CLAIMED long description cannot buy a gap it has not rendered", () => {
		// (GUARD5-MATCHED-BUDGET) The capture may claim thousands of characters while
		// putting only a short prefix on screen. The budget is derived from what is
		// MATCHED, so the claim buys nothing.
		const onScreen = "Retire the exact same-product twins now.";
		const subject = item({
			options: [
				{
					index: 0,
					label: "Retire the duplicates",
					description: `${onScreen} ${"padding that is nowhere on the screen ".repeat(80)}`,
				},
				{ index: 1, label: "Escalate to the owner", description: "" },
			],
		});
		const lines = [
			" ☐ Duplicate pairs ",
			"",
			"  1. Retire the duplicates",
			`     ${onScreen}`,
		];
		for (let i = 0; i < 25; i += 1) lines.push(FILLER);
		lines.push("  2. Escalate to the owner");
		expect(
			matchPickerScreen({
				screen: lines.join("\n"),
				item: subject,
				requireOptionIndex: 0,
			}).reason,
		).toBe("row_gap_unexplained");
	});

	it("prose that merely contains a number is not a row", () => {
		// (GUARD5-ROW-ANCHOR) "then step 2. Then do X" used to satisfy row 2.
		const subject = item({
			options: [
				{ index: 0, label: "Retire the duplicates", description: "" },
				{ index: 1, label: "Escalate to the owner", description: "" },
			],
		});
		const screen = [
			" ☐ Duplicate pairs ",
			"",
			"  1. Retire the duplicates",
			"  I ran step 2. Escalate to the owner was not chosen by anyone",
		].join("\n");
		expect(
			matchPickerScreen({ screen, item: subject, requireOptionIndex: 1 }),
		).toEqual({
			ok: false,
			reason: "row_absent",
			missing: ["option:1"],
			digitMapped: true,
		});
	});

	it("the NEXT row's line cannot supply the previous row's description", () => {
		// The gap region is strictly between the two row lines, so a description
		// rendered on the next row's own line does not explain the gap above it.
		const description = "Retire the exact same-product twins now and report.";
		const subject = item({
			options: [
				{ index: 0, label: "Retire the duplicates", description },
				{ index: 1, label: "Escalate to the owner", description: "" },
			],
		});
		const lines = [" ☐ Duplicate pairs ", "", "  1. Retire the duplicates"];
		for (let i = 0; i < 6; i += 1) lines.push(FILLER);
		// The description sits on the SAME line as row 2, not in the gap.
		lines.push(`  2. Escalate to the owner ${description}`);
		expect(
			matchPickerScreen({
				screen: lines.join("\n"),
				item: subject,
				requireOptionIndex: 0,
			}).reason,
		).toBe("row_gap_unexplained");
	});
});

describe("(GUARD5-BLOCK-ANCHOR) final verify round", () => {
	const SHORT_WITH_DESCRIPTIONS = [
		{
			index: 0,
			label: "Yes",
			description: "Enable the nightly duplicate sweep for every home.",
		},
		{
			index: 1,
			label: "No",
			description: "Leave the sweep switched off until the review lands.",
		},
		{
			index: 2,
			label: "Later",
			description: "Revisit this after the clinical review has finished.",
		},
	];

	it("a multi-select of SHORT labels with real descriptions matches on a submit re-check", () => {
		// (V-BLOCKER) The regression that mattered most: this refused, so the toggle
		// digits were written and the submit keystroke then aborted the sequence,
		// leaving the picker half-toggled and the question unanswerable. The older
		// all-weak test used EMPTY descriptions, so it passed either way — which is
		// exactly how this got through.
		const subject = item({
			multiSelect: true,
			options: SHORT_WITH_DESCRIPTIONS,
		});
		const screen = renderPicker(subject, 100).join("\n");
		expect(
			matchPickerScreen({ screen, item: subject, requireOptionIndex: null }),
		).toEqual({ ok: true, reason: "match", missing: [], digitMapped: true });
		for (const requireOptionIndex of [0, 1, 2]) {
			expect(
				matchPickerScreen({ screen, item: subject, requireOptionIndex }).ok,
			).toBe(true);
		}
	});

	it("an all-weak block with no descriptions still refuses on a submit re-check", () => {
		const subject = item({
			multiSelect: true,
			options: [
				{ index: 0, label: "A", description: "" },
				{ index: 1, label: "B", description: "" },
			],
		});
		const screen = [` ☐ ${subject.header} `, "", "  1. A", "  2. B"].join("\n");
		expect(
			matchPickerScreen({ screen, item: subject, requireOptionIndex: null }).ok,
		).toBe(false);
	});

	it("free-text look-alike rows are not the editor slot", () => {
		// (V-S1) Each of these was accepted when the comparison squashed case and
		// whitespace. They are REAL options; pressing the digit selects them.
		for (const impostor of [
			"Type some thing.",
			"TYPE SOMETHING.",
			"Type\tsomething.",
			"Type something else entirely",
		]) {
			const subject = item({
				options: [
					{
						index: 0,
						label: "Retire the duplicates",
						description: "Retire the exact same-product twins now.",
					},
					{
						index: 1,
						label: "Escalate to the owner",
						description: "Hand the pair to the owner for a decision.",
					},
				],
				freeTextOption: { index: 2, label: "Type something." },
			});
			// The impostor sits AT THE FREE-TEXT DIGIT — the whole point. A squashing
			// comparison accepted it as the editor slot and pressed 3.
			const screen = [
				` ☐ ${subject.header} `,
				"",
				"  1. Retire the duplicates",
				"     Retire the exact same-product twins now.",
				"  2. Escalate to the owner",
				"     Hand the pair to the owner for a decision.",
				`  3. ${impostor}`,
			].join("\n");
			expect(
				matchPickerScreen({ screen, item: subject, requireOptionIndex: 2 }).ok,
			).toBe(false);
		}
	});

	it("the contract label at two digits is a refusal, not a choice", () => {
		// (V-S1) A real option spelled exactly like the system row, with the true
		// system row below it. Which one the digit selects is unknowable.
		const subject = item({
			options: [
				{
					index: 0,
					label: "Retire the duplicates",
					description: "Retire the exact same-product twins now.",
				},
				{
					index: 1,
					label: "Type something.",
					description: "A real option wearing the system row's copy.",
				},
			],
			freeTextOption: { index: 2, label: "Type something." },
		});
		const screen = [
			` ☐ ${subject.header} `,
			"",
			"  1. Retire the duplicates",
			"     Retire the exact same-product twins now.",
			"  2. Type something.",
			"     A real option wearing the system row's copy.",
			"  3. Type something.",
		].join("\n");
		expect(
			matchPickerScreen({ screen, item: subject, requireOptionIndex: 2 }),
		).toEqual({
			ok: false,
			reason: "freetext_row_conflict",
			missing: ["freetext:2"],
			digitMapped: true,
		});
	});

	it("the NEXT row's label cannot serve as this row's description", () => {
		// (V-S2) The capture claims option 1's description is the text of row 2, so
		// a phone could present row 1 as the escalation while digit 1 selects "Yes".
		const subject = item({
			options: [
				{ index: 0, label: "Yes", description: "Escalate to the owner" },
				{ index: 1, label: "Escalate to the owner", description: "" },
			],
		});
		const screen = [
			` ☐ ${subject.header} `,
			"",
			"  1. Yes",
			"  2. Escalate to the owner",
		].join("\n");
		expect(
			matchPickerScreen({ screen, item: subject, requireOptionIndex: 0 }).ok,
		).toBe(false);
	});

	it("a long honest description at 80 columns is not refused", () => {
		// (V-M1) The budget divided squashed cells by the FULL width, ignoring the
		// spaces and the indent, so honest descriptions past ~1200 characters were
		// refused even though the cap allows 4096.
		const sentence =
			"Retire the exact same-product twins and prepare an approval brief with counts. ";
		const description = sentence.repeat(16).trim();
		const subject = item({
			options: [
				{ index: 0, label: "Retire the duplicates", description },
				{ index: 1, label: "Escalate to the owner", description: "" },
			],
		});
		const lines = [` ☐ ${subject.header} `, "", "  1. Retire the duplicates"];
		for (const chunk of description.match(/.{1,74}/g) ?? []) {
			lines.push(`     ${chunk}`);
		}
		lines.push("  2. Escalate to the owner");
		expect(
			matchPickerScreen({
				screen: lines.join("\n"),
				item: subject,
				requireOptionIndex: 0,
			}).ok,
		).toBe(true);
	});

	it("an emoji-heavy description is measured in the cells it renders", () => {
		// (V-M2) "☺️" is U+263A + VS16: one code point wide, two cells rendered.
		const description = `Flag the pair ${"☺️".repeat(30)} and report it back.`;
		const subject = item({
			options: [
				{ index: 0, label: "Retire the duplicates", description },
				{ index: 1, label: "Escalate to the owner", description: "" },
			],
		});
		const lines = [` ☐ ${subject.header} `, "", "  1. Retire the duplicates"];
		for (const chunk of description.match(/.{1,20}/g) ?? []) {
			lines.push(`     ${chunk}`);
		}
		lines.push("  2. Escalate to the owner");
		expect(
			matchPickerScreen({
				screen: lines.join("\n"),
				item: subject,
				requireOptionIndex: 0,
			}).ok,
		).toBe(true);
	});

	it("a screen shorter than the window still matches its rows", () => {
		// (V-M5) The whole-screen special case broke "window i starts at line i".
		const subject = item({
			options: [
				{ index: 0, label: "Retire the duplicates", description: "" },
				{ index: 1, label: "Escalate to the owner", description: "" },
			],
			header: "Retire the duplicates",
		});
		const screen = "  1. Retire the duplicates\n  2. Escalate to the owner";
		expect(
			matchPickerScreen({ screen, item: subject, requireOptionIndex: 0 }).ok,
		).toBe(true);
	});

	it("an evidence refusal names the row it is about", () => {
		// (V-M4) It used to emit option:2 on a two-option item, or blame option 0.
		const subject = item({
			options: [
				{ index: 0, label: "A", description: "" },
				{ index: 1, label: "B", description: "" },
			],
		});
		const screen = [` ☐ ${subject.header} `, "", "  1. A", "  2. B"].join("\n");
		const verdict = matchPickerScreen({
			screen,
			item: subject,
			requireOptionIndex: null,
		});
		expect(verdict.missing).toEqual(["row_evidence"]);
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
		// (O5) This used to carry header "c", so it refused on the PROMPT anchor and
		// proved nothing about labels. It now has a real header that IS on screen,
		// so the refusal is about the pressed row's evidence and the verdict is
		// asserted in full.
		const subject = item({
			header: "Duplicate pairs",
			question: "Which one?",
			options: [{ index: 0, label: "2", description: "" }],
		});
		const screen = [" ☐ Duplicate pairs ", "", "  1. 2", "", "> "].join("\n");
		expect(
			matchPickerScreen({ screen, item: subject, requireOptionIndex: 0 }),
		).toEqual({
			ok: false,
			reason: "anchor_too_weak",
			missing: ["option:0"],
			digitMapped: true,
		});
	});

	it("a last option verified by its description far below the picker", () => {
		// (O2) The last row's evidence region ran to the end of the viewport, so a
		// short-labelled last option was verified by its description appearing
		// anywhere underneath — including in unrelated output.
		const description =
			"Do not ask again for this resident; move on to the next home.";
		const subject = item({
			options: [
				{
					index: 0,
					label: "Retire the duplicates",
					description: "Retire the exact same-product twins now.",
				},
				{ index: 1, label: "Skip", description },
			],
		});
		const lines = [
			" ☐ Duplicate pairs ",
			"",
			"  1. Retire the duplicates",
			"     Retire the exact same-product twins now.",
			"  2. Skip",
		];
		for (let i = 0; i < 12; i += 1) lines.push(FILLER);
		lines.push(`  ${description}`);
		expect(
			matchPickerScreen({
				screen: lines.join("\n"),
				item: subject,
				requireOptionIndex: 1,
			}).reason,
		).toBe("anchor_too_weak");
	});

	it("the free-text digit does not excuse an all-weak block", () => {
		// (O3) Pressing the free-text digit names no option, so every option row was
		// corroboration-only and nothing had to be strong at all.
		const subject = item({
			options: [
				{ index: 0, label: "A", description: "" },
				{ index: 1, label: "B", description: "" },
			],
			freeTextOption: { index: 2, label: "Other" },
		});
		const screen = [
			" ☐ Duplicate pairs ",
			"",
			"  1. A",
			"  2. B",
			"  3. Other",
		].join("\n");
		expect(
			matchPickerScreen({ screen, item: subject, requireOptionIndex: 2 }).ok,
		).toBe(false);
	});

	it("a viewport clipped above the picker still refuses the row it cannot see", () => {
		// (O8) A window shorter than the picker loses rows off the top. The clip is
		// now survivable — see the (GUARD5-CLIPPED-VIEWPORT) block below — but only
		// for a row that is actually on screen. Option 0's row is one of the three
		// this clip ate, so pressing it is refused exactly as before.
		const clipped = LIVE_VIEWPORT.split("\n").slice(24).join("\n");
		expect(
			matchPickerScreen({
				screen: clipped,
				item: LIVE_ITEM,
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

// ---------------------------------------------------------------------------
// (GUARD5-CLIPPED-VIEWPORT)
//
// (O8) A terminal shorter than the prompt shows its TAIL: the header goes first,
// then the question, then the early option rows. Guard 5 used to require all of
// them, so every honest answer from a small window was refused — `row_absent`
// while only rows were missing, `anchor_absent` once the header went with them.
//
// A clip is now admitted, but only when it is PROVEN: the pressed row is on
// screen and strongly verified, the visible rows are a prefix or a suffix of the
// block rather than a hole in it, and the clipped edge is affirmatively at the
// viewport boundary — the space above the block matching the TAIL of whatever
// renders there, the space below it explained by the last visible row's own
// description. These cases pin both directions.
// ---------------------------------------------------------------------------
describe("(GUARD5-CLIPPED-VIEWPORT) a picker taller than the window", () => {
	/**
	 * The live fixture with its first 24 lines eaten. Header, question and the
	 * rows for options 0-2 are all gone; option 3's row and the free-text row
	 * survive, under the tail of option 2's description.
	 */
	const CLIPPED_ABOVE = LIVE_VIEWPORT.split("\n").slice(24).join("\n");

	/** The live item's first three options, rendered whole at 100 columns. */
	function threeOptionItem(): QuestionItem {
		return item({
			header: "587 dup pairs",
			question: LIVE_ITEM.question,
			options: LIVE_ITEM.options.slice(0, 3),
		});
	}

	/** That render, cut off after `keepLines` lines. */
	function bottomClipped(keepLines: number): string {
		return renderPicker(threeOptionItem(), 100).slice(0, keepLines).join("\n");
	}

	/** The line the third row sits on, so a clip can be placed just above it. */
	function thirdRowLine(): number {
		return optionRowLines(bottomClipped(1000))[2] ?? 0;
	}

	it("the clip really did eat the prompt — this block is not vacuous", () => {
		expect(CLIPPED_ABOVE).not.toContain(LIVE_ITEM.header);
		expect(CLIPPED_ABOVE).not.toContain("Leftover duplicates follow-up");
		expect(optionRowLines(CLIPPED_ABOVE)).toEqual([2, 5, 7]);
	});

	it("a visible row on a top-clipped viewport is answerable", () => {
		expect(
			matchPickerScreen({
				screen: CLIPPED_ABOVE,
				item: LIVE_ITEM,
				requireOptionIndex: 3,
			}),
		).toEqual({ ok: true, reason: "match", missing: [], digitMapped: true });
	});

	it("the free-text row of a top-clipped viewport is answerable", () => {
		expect(
			matchPickerScreen({
				screen: CLIPPED_ABOVE,
				item: LIVE_ITEM,
				requireOptionIndex: 4,
			}).ok,
		).toBe(true);
	});

	it("a row the clip ate is still refused, and refused as anchor_absent", () => {
		// The prompt anchor went with those rows, so the refusal reads exactly as it
		// did before the relaxation: nothing about the clip leaks into diagnostics.
		for (const requireOptionIndex of [0, 1, 2]) {
			expect(
				matchPickerScreen({
					screen: CLIPPED_ABOVE,
					item: LIVE_ITEM,
					requireOptionIndex,
				}),
			).toEqual({
				ok: false,
				reason: "anchor_absent",
				missing: ["prompt"],
				digitMapped: true,
			});
		}
	});

	it("the top edge must be the previous option's own description", () => {
		// Same geometry, but the two lines above the surviving row are unrelated
		// output rather than the tail of option 2's description. That is not a clip,
		// it is a row floating in somebody else's text.
		const forged = [
			"  ⎿  ran 4 tasks and printed their output to the log",
			"     nothing here belongs to this prompt at all",
			...CLIPPED_ABOVE.split("\n").slice(2),
		].join("\n");
		expect(
			matchPickerScreen({
				screen: forged,
				item: LIVE_ITEM,
				requireOptionIndex: 3,
			}).ok,
		).toBe(false);
	});

	it("a bottom-clipped picker answers a row it can see", () => {
		// Cut the viewport off inside option 1's description: rows 1 and 2 are on
		// screen, row 3 never rendered.
		const screen = bottomClipped(thirdRowLine() - 1);
		expect(optionRowLines(screen).length).toBe(2);
		expect(
			matchPickerScreen({
				screen,
				item: threeOptionItem(),
				requireOptionIndex: 1,
			}).ok,
		).toBe(true);
	});

	it("a bottom-clipped picker still refuses the row it cannot see", () => {
		expect(
			matchPickerScreen({
				screen: bottomClipped(thirdRowLine() - 1),
				item: threeOptionItem(),
				requireOptionIndex: 2,
			}),
		).toEqual({
			ok: false,
			reason: "row_absent",
			missing: ["option:2"],
			digitMapped: true,
		});
	});

	it("a bottom clip nowhere near the bottom edge is refused", () => {
		// The rows stop, and then a screenful of unrelated output follows. Nothing
		// clipped this list; it simply is not all there.
		const screen = [
			...bottomClipped(thirdRowLine() - 1).split("\n"),
			...Array.from({ length: 12 }, () => FILLER),
		].join("\n");
		expect(
			matchPickerScreen({
				screen,
				item: threeOptionItem(),
				requireOptionIndex: 1,
			}).ok,
		).toBe(false);
	});

	it("a hole in the middle of the block is refused", () => {
		const subject = item();
		const screen = [
			` ☐ ${subject.header} `,
			"",
			subject.question,
			"",
			"  1. Retire the duplicates",
			"  3. Do nothing today",
		].join("\n");
		expect(
			matchPickerScreen({ screen, item: subject, requireOptionIndex: 0 }),
		).toEqual({
			ok: false,
			reason: "row_absent",
			missing: ["option:1"],
			digitMapped: true,
		});
	});

	it("a clip at BOTH ends at once is refused", () => {
		const subject = item({
			options: [
				{ index: 0, label: "Retire the duplicates", description: "" },
				{ index: 1, label: "Escalate to the owner", description: "" },
				{ index: 2, label: "Do nothing today", description: "" },
				{ index: 3, label: "Show me a sample first", description: "" },
			],
		});
		const screen = [
			`  ${subject.question}`,
			"  2. Escalate to the owner",
			"  3. Do nothing today",
		].join("\n");
		expect(
			matchPickerScreen({ screen, item: subject, requireOptionIndex: 1 }).ok,
		).toBe(false);
	});

	it("a viewport that opens ON the first row proves nothing and is refused", () => {
		// No prompt anchor, and nothing above the block to corroborate one. There is
		// deliberately no "the row is on line 0, so nothing could be above it" escape.
		const subject = item();
		const screen = [
			"  1. Retire the duplicates",
			"  2. Escalate to the owner",
			"  3. Do nothing today",
		].join("\n");
		expect(
			matchPickerScreen({ screen, item: subject, requireOptionIndex: 0 }).ok,
		).toBe(false);
	});

	it("the top edge must be ADJACENT to the row, not merely somewhere above it", () => {
		// (GUARD5-CLIP-ADJACENT) The executed false accept. `includes` found the
		// description tail anywhere in the region, so the line the digit actually
		// sits under was never examined — junk could be spliced between the proven
		// text and the row and the clip still counted. The squashed region must now
		// END with the needle.
		const clipped = CLIPPED_ABOVE.split("\n");
		const spliced = [
			clipped[0] ?? "",
			clipped[1] ?? "",
			"  ⎿  and then some entirely unrelated output landed here",
			...clipped.slice(2),
		].join("\n");
		expect(
			matchPickerScreen({
				screen: spliced,
				item: LIVE_ITEM,
				requireOptionIndex: 3,
			}).ok,
		).toBe(false);
	});

	it("a clip needle shorter than the header anchor it replaces is refused", () => {
		// (GUARD5-CLIPPED-VIEWPORT) The floor is SCREEN_HEADER_ANCHOR_CHARS, not
		// SCREEN_MIN_ANCHOR_CHARS: this needle stands IN FOR the prompt anchor, so a
		// shorter one would be a weaker check wearing a stronger check's clothes.
		// Eleven squashed characters clears the old floor of eight and not this one.
		const subject = item({
			options: [
				{ index: 0, label: "Retire the duplicates", description: "Do it now." },
				{ index: 1, label: "Escalate to the owner", description: "" },
			],
		});
		const screen = ["     Do it now.", "  2. Escalate to the owner"].join("\n");
		expect(
			matchPickerScreen({ screen, item: subject, requireOptionIndex: 1 }).ok,
		).toBe(false);
	});

	it("a visible free-text row below MISSING options is refused on an option press", () => {
		// (GUARD5-FREETEXT-CONTRADICTION) The editor row renders below every option,
		// so seeing it while options above it are absent is not a clip — the
		// numbering on screen does not match the capture. This used to be unreachable
		// on an option press, because the editor row was only looked for when its own
		// digit was the one being pressed.
		const subject = item({
			options: [
				{ index: 0, label: "Retire the duplicates", description: "" },
				{ index: 1, label: "Escalate to the owner", description: "" },
				{ index: 2, label: "Do nothing today", description: "" },
				{ index: 3, label: "Show me a sample first", description: "" },
			],
			freeTextOption: { index: 4, label: "Type something." },
		});
		const screen = [
			` ☐ ${subject.header} `,
			"",
			subject.question,
			"",
			"  1. Retire the duplicates",
			"  5. Type something.",
		].join("\n");
		expect(
			matchPickerScreen({ screen, item: subject, requireOptionIndex: 0 }).ok,
		).toBe(false);
	});

	it("an honest bottom clip that has NOT reached the free-text row still answers", () => {
		// The other side of the same rule: the editor row is below the fold too, so
		// there is no contradiction and the clip stands.
		const screen = bottomClipped(thirdRowLine() - 1);
		expect(screen).not.toContain("Type something.");
		expect(
			matchPickerScreen({
				screen,
				item: {
					...threeOptionItem(),
					freeTextOption: { index: 3, label: "Type something." },
				},
				requireOptionIndex: 1,
			}).ok,
		).toBe(true);
	});

	it("a question tail above the rows carries a clipped-away header", () => {
		// Only the header line went. The question's own tail is then what proves the
		// viewport was clipped, rather than that these rows belong to another list.
		const subject = item({
			question:
				"How should the leftover duplicate pairs be handled today, given that the new code already stops fresh ones from appearing at all?",
		});
		const full = renderPicker(subject, 100);
		const headerAt = full.findIndex((line) => line.includes(subject.header));
		const screen = full.slice(headerAt + 2).join("\n");
		expect(screen).not.toContain(subject.header);
		expect(
			matchPickerScreen({ screen, item: subject, requireOptionIndex: 0 }).ok,
		).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// (FREETEXT-N2-PROVEN)
//
// Free text inside an N > 1 prompt. Until the sequence was driven, no N > 1 item
// ever carried a `freeTextOption`, so guard 5 was never asked to verify a
// free-text row on a multi-question screen and nothing pinned what it does
// there. The three fixtures below are UNEDITED 100-column viewports captured off
// the live headless emulator while a real two-question AskUserQuestion prompt
// blocked Claude Code 2.1.226 — question 1's picker, question 2's picker after
// the first answer advanced it, and the review screen.
//
// The load-bearing property they pin is DISCRIMINATION BETWEEN QUESTIONS. Every
// question in an N > 1 prompt numbers its rows from 1 and renders its own
// free-text row at the same digit, and the tab bar keeps EVERY header on screen
// the whole time — so "a picker for this prompt is up" is satisfied by the wrong
// question's screen, and only the option rows tell them apart. A guard that got
// this wrong would type question 2's digit into question 1's list.
// ---------------------------------------------------------------------------

/** Question 1's picker, exactly as rendered. Free-text row at digit 3. */
const N2_QUESTION_1_VIEWPORT = `
❯ Use the AskUserQuestion tool RIGHT NOW, once, with exactly 2 questions in that single call.
  question 1: header 'Alpha', question 'Which alpha value should this canary run use?', multiSelect
  false, exactly two options: label 'Aone' with description 'Use the first alpha value for this
  canary run.' and label 'Atwo' with description 'Use the second alpha value for this canary run.'.
  question 2: header 'Beta', question 'Which beta value should this canary run use?', multiSelect
  false, exactly two options: label 'Bone' with description 'Use the first beta value for this
  canary run.' and label 'Btwo' with description 'Use the second beta value for this canary run.'.
  Do not use any other tool, do not write any files, and do not say anything before the tool call.
────────────────────────────────────────────────────────────────────────────────────────────────────
←  ☐ Alpha  ☐ Beta  ✔ Submit  →

Which alpha value should this canary run use?

❯ 1. Aone
     Use the first alpha value for this canary run.
  2. Atwo
     Use the second alpha value for this canary run.
  3. Type something.
────────────────────────────────────────────────────────────────────────────────────────────────────
  4. Chat about this

Enter to select · Tab/Arrow keys to navigate · Esc to cancel`;

/**
 * Question 2's picker, after question 1's free-text answer advanced the prompt.
 * Note what did NOT change: the tab bar still names Alpha, and the composer echo
 * above still contains every word of question 1 — including its option labels.
 */
const N2_QUESTION_2_VIEWPORT = `
❯ Use the AskUserQuestion tool RIGHT NOW, once, with exactly 2 questions in that single call.
  question 1: header 'Alpha', question 'Which alpha value should this canary run use?', multiSelect
  false, exactly two options: label 'Aone' with description 'Use the first alpha value for this
  canary run.' and label 'Atwo' with description 'Use the second alpha value for this canary run.'.
  question 2: header 'Beta', question 'Which beta value should this canary run use?', multiSelect
  false, exactly two options: label 'Bone' with description 'Use the first beta value for this
  canary run.' and label 'Btwo' with description 'Use the second beta value for this canary run.'.
  Do not use any other tool, do not write any files, and do not say anything before the tool call.
────────────────────────────────────────────────────────────────────────────────────────────────────
←  ☒ Alpha  ☐ Beta  ✔ Submit  →

Which beta value should this canary run use?

❯ 1. Bone
     Use the first beta value for this canary run.
  2. Btwo
     Use the second beta value for this canary run.
  3. Type something.
────────────────────────────────────────────────────────────────────────────────────────────────────
  4. Chat about this

Enter to select · Tab/Arrow keys to navigate · Esc to cancel`;

/** The review screen the last answer lands on. No question's option list is up. */
const N2_REVIEW_VIEWPORT = `
❯ Use the AskUserQuestion tool RIGHT NOW, once, with exactly 2 questions in that single call.
  question 1: header 'Alpha', question 'Which alpha value should this canary run use?', multiSelect
  false, exactly two options: label 'Aone' with description 'Use the first alpha value for this
  canary run.' and label 'Atwo' with description 'Use the second alpha value for this canary run.'.
  question 2: header 'Beta', question 'Which beta value should this canary run use?', multiSelect
  false, exactly two options: label 'Bone' with description 'Use the first beta value for this
  canary run.' and label 'Btwo' with description 'Use the second beta value for this canary run.'.
  Do not use any other tool, do not write any files, and do not say anything before the tool call.

────────────────────────────────────────────────────────────────────────────────────────────────────
←  ☒ Alpha  ☒ Beta  ✔ Submit  →

Review your answers

 ● Which alpha value should this canary run use?
   → zebrafreetextalpha
 ● Which beta value should this canary run use?
   → Bone

Ready to submit your answers?

❯ 1. Submit answers
  2. Cancel`;

const N2_ALPHA: QuestionItem = {
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
};

const N2_BETA: QuestionItem = {
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
};

describe("(FREETEXT-N2-PROVEN) guard 5 on a real two-question prompt", () => {
	it("confirms question 1's free-text row on question 1's screen", () => {
		expect(
			matchPickerScreen({
				screen: N2_QUESTION_1_VIEWPORT,
				item: N2_ALPHA,
				requireOptionIndex: 2,
			}),
		).toMatchObject({ ok: true, reason: "match" });
	});

	it("confirms question 2's free-text row on question 2's screen", () => {
		expect(
			matchPickerScreen({
				screen: N2_QUESTION_2_VIEWPORT,
				item: N2_BETA,
				requireOptionIndex: 2,
			}),
		).toMatchObject({ ok: true, reason: "match" });
	});

	it("refuses question 2's digit against question 1's screen", () => {
		// The whole hazard of an N > 1 prompt in one assertion. Both questions
		// number their rows from 1, both render "Type something." at digit 3, and
		// question 2's header AND its full text are on this screen — in the tab bar
		// and in the composer echo. Only the OPTION ROWS differ, so only they can
		// refuse this, and they must.
		const match = matchPickerScreen({
			screen: N2_QUESTION_1_VIEWPORT,
			item: N2_BETA,
			requireOptionIndex: 2,
		});
		expect(match.ok).toBe(false);
		expect(match.reason).toBe("row_absent");
	});

	it("refuses question 1's digit against question 2's screen", () => {
		const match = matchPickerScreen({
			screen: N2_QUESTION_2_VIEWPORT,
			item: N2_ALPHA,
			requireOptionIndex: 2,
		});
		expect(match.ok).toBe(false);
		expect(match.reason).toBe("row_absent");
	});

	it("refuses either question's digit on the review screen", () => {
		// The review screen echoes every question's text and every chosen answer,
		// and carries its own rows numbered from 1 ("Submit answers", "Cancel").
		// Pressing a picker digit there would press one of those instead.
		for (const subject of [N2_ALPHA, N2_BETA]) {
			expect(
				matchPickerScreen({
					screen: N2_REVIEW_VIEWPORT,
					item: subject,
					requireOptionIndex: 2,
				}).ok,
			).toBe(false);
		}
	});

	it("refuses a screen where a real option also spells the free-text label", () => {
		// A prompt-injected capture cannot choose the label — it is derived from the
		// picker contract — but the AGENT chooses the option labels, so it can spell
		// one of them "Type something." and sit it above the true row. Which row the
		// digit lands on is then exactly what cannot be established.
		const screen = N2_QUESTION_2_VIEWPORT.replace(
			"❯ 1. Bone",
			"❯ 1. Type something.",
		);
		const impostor: QuestionItem = {
			...N2_BETA,
			options: [
				{ index: 0, label: "Type something.", description: "" },
				{
					index: 1,
					label: "Btwo",
					description: "Use the second beta value for this canary run.",
				},
			],
		};
		const match = matchPickerScreen({
			screen,
			item: impostor,
			requireOptionIndex: 2,
		});
		expect(match.ok).toBe(false);
		expect(match.reason).toBe("freetext_row_conflict");
	});
});
