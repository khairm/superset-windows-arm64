import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { dirname, resolve, sep } from "node:path";
import {
	assertFullCommitSha,
	assertNoNativePlurals,
	type Donor,
	parseDonorArgs,
	planLocaleBackfill,
	TARGET_LOCALES,
} from "../scripts/backfill-upstream-translations";
import config from "../lingui.config";

// The backfill copies a pinned donor's own translations into entries extraction
// left empty, asking the fork commit before upstream. What it must never do is
// invent text, overwrite a translation the merged catalog already has, or write
// anything at all when a message no donor can fill is left.

type Catalog = Parameters<typeof planLocaleBackfill>[1];

const entry = (message: string, translation: string, extra?: Partial<Catalog[string]>) =>
	({ message, translation, ...extra }) as Catalog[string];

const catalog = (entries: Record<string, Catalog[string]>) => entries as Catalog;

/** The real donor order: the fork's own commit first, upstream second. */
const donors = (
	fork: Record<string, Catalog[string]>,
	upstream: Record<string, Catalog[string]>,
): Donor[] => [
	{ label: "fork@f", catalog: catalog(fork) },
	{ label: "upstream@u", catalog: catalog(upstream) },
];

describe("planLocaleBackfill", () => {
	test("fills an empty translation from the fork before upstream", () => {
		const plan = planLocaleBackfill(
			"ja",
			catalog({ a1: entry("Skills", "") }),
			donors({ a1: entry("Skills", "フォーク訳") }, { a1: entry("Skills", "スキル") }),
		);
		expect(plan.failures).toEqual([]);
		expect([...plan.fills]).toEqual([["a1", "フォーク訳"]]);
	});

	test("leaves a translation the merged catalog already has alone", () => {
		const plan = planLocaleBackfill(
			"ja",
			catalog({ a1: entry("Skills", "既存訳") }),
			donors({ a1: entry("Skills", "フォーク訳") }, { a1: entry("Skills", "スキル") }),
		);
		expect(plan.fills.size).toBe(0);
		expect(plan.failures).toEqual([]);
	});

	test("carries an ICU plural message across by id", () => {
		const icu = "{count, plural, one {# file} other {# files}}";
		const translated = "{count, plural, other {# 個のファイル}}";
		const plan = planLocaleBackfill(
			"ja",
			catalog({ icu1: entry(icu, "") }),
			donors({}, { icu1: entry(icu, translated) }),
		);
		expect([...plan.fills.values()]).toEqual([translated]);
	});

	test.each([
		["has no catalog at all (a locale new to the fork)", {}],
		["does not carry the message", { z9: entry("Other", "他") }],
		["leaves it empty", { a1: entry("Skills", "") }],
		["marks it fuzzy", { a1: entry("Skills", "古い訳", { extra: { flags: ["fuzzy"] } }) }],
		["marks it obsolete", { a1: entry("Skills", "古い訳", { obsolete: true }) }],
		["has the same id under another context", { a1: entry("Skills", "古い訳", { context: "menu" }) }],
	])("falls back to upstream when the fork donor %s", (_name, fork) => {
		const plan = planLocaleBackfill(
			"ja",
			catalog({ a1: entry("Skills", "") }),
			donors(fork, { a1: entry("Skills", "スキル") }),
		);
		expect(plan.failures).toEqual([]);
		expect([...plan.fills]).toEqual([["a1", "スキル"]]);
	});

	test("fails naming both donors and their reasons when neither can fill", () => {
		const plan = planLocaleBackfill(
			"ja",
			catalog({ v1: entry("View", "", { context: "menu" }) }),
			donors({}, { v1: entry("View", "見る", { context: "button" }) }),
		);
		expect(plan.fills.size).toBe(0);
		expect(plan.failures).toHaveLength(1);
		expect(plan.failures[0]).toContain("ja: ");
		expect(plan.failures[0]).toContain("View");
		expect(plan.failures[0]).toContain("[context: menu]");
		expect(plan.failures[0]).toContain("fork@f does not ship this message");
		expect(plan.failures[0]).toContain("upstream@u has the same id but a different message/context");
		expect(plan.failures[0]).toContain("a human must translate it");
	});

	test.each([
		["empty", entry("Skills", ""), "upstream@u leaves it untranslated too"],
		[
			"fuzzy",
			entry("Skills", "スキル", { extra: { flags: ["fuzzy"] } }),
			"upstream@u marks its translation fuzzy",
		],
		["obsolete", entry("Skills", "スキル", { obsolete: true }), "upstream@u marks its entry obsolete"],
	])("names the upstream reason when its entry is %s", (_name, upstream, reason) => {
		const plan = planLocaleBackfill(
			"ja",
			catalog({ a1: entry("Skills", "") }),
			donors({}, { a1: upstream }),
		);
		expect(plan.fills.size).toBe(0);
		expect(plan.failures[0]).toContain(reason);
	});
});

describe("CLI boundaries", () => {
	const UPSTREAM = "a415227dc25f806dd3ef6bf05b464adba5ac08fb";
	const FORK = "b8c5ed387378034ef7fedb0ee1ce01d5465d3798";

	test.each(["desktop-v1.28.0", "a415227", "", undefined, UPSTREAM.toUpperCase()])(
		"rejects %p as a donor sha",
		(value) => {
			expect(() => assertFullCommitSha(value, "--fork")).toThrow("full 40-hex");
		},
	);

	test("accepts a full commit sha", () => {
		expect(assertFullCommitSha(UPSTREAM, "--upstream")).toBe(UPSTREAM);
	});

	test("takes both donors as named flags, in either order", () => {
		expect(parseDonorArgs([`--upstream=${UPSTREAM}`, `--fork=${FORK}`])).toEqual({
			fork: FORK,
			upstream: UPSTREAM,
		});
	});

	test.each([
		["a missing donor", [`--fork=${FORK}`], "missing --upstream"],
		["a repeated donor", [`--fork=${FORK}`, `--fork=${FORK}`, `--upstream=${UPSTREAM}`], "more than once"],
		["an unknown flag", [`--fork=${FORK}`, `--upstream=${UPSTREAM}`, "--donor=x"], "unexpected argument"],
		["a positional sha", [UPSTREAM, FORK], "unexpected argument"],
		["a donor that is not a sha", ["--fork=desktop-v1.28.0", `--upstream=${UPSTREAM}`], "--fork expected a full 40-hex"],
	])("rejects %s", (_name, argv, reason) => {
		expect(() => parseDonorArgs(argv)).toThrow(reason);
	});

	test("rejects native gettext plural forms", () => {
		const po = 'msgid "file"\nmsgid_plural "files"\nmsgstr[0] "soubor"\n';
		expect(() => assertNoNativePlurals(po, "donor")).toThrow("native gettext plural");
		expect(() => assertNoNativePlurals('msgid "file"\nmsgstr "soubor"\n', "donor")).not.toThrow();
	});

	test("never targets the source locale, which is derived from source", () => {
		expect(TARGET_LOCALES).not.toContain(config.sourceLocale as string);
		expect(TARGET_LOCALES).toHaveLength(config.locales.length - 1);
	});
});

describe("catalog round-trip", () => {
	// Writing a filled catalog re-serializes every entry, so an untouched one
	// must come back byte-identical or the backfill would dirty the gate's diff.
	test("re-serializing a parsed catalog reproduces the file", async () => {
		const format = config.format!;
		const ctx = { locale: "ja", sourceLocale: "en", filename: "messages.po" };
		const original = await Bun.file(
			new URL("../locales/ja/messages.po", import.meta.url),
		).text();
		const parsed = await format.parse(original, ctx);
		expect(await format.serialize(parsed, { ...ctx, existing: original })).toBe(original);
	});
});

describe("fork-only strings", () => {
	// The case the fork donor exists for, over the real catalogs and the real
	// formatter rather than a fixture: two fork dialog strings reached the
	// backfill with an empty translation in every locale, and upstream, which has
	// never shipped either, could fill neither. Both are context-free and the
	// fork's own catalogs carry them translated.
	const LOST = [
		"Remove project from sidebar?",
		"This will remove workspaces from the sidebar and delete all project sections. The workspaces or projects won't be deleted.",
	];

	test("recover verbatim from the fork donor in every target locale", async () => {
		const format = config.format!;
		for (const locale of TARGET_LOCALES) {
			const ctx = {
				locale,
				sourceLocale: config.sourceLocale as string,
				filename: `${locale}/messages.po`,
			};
			const fork = await format.parse(
				await Bun.file(new URL(`../locales/${locale}/messages.po`, import.meta.url)).text(),
				ctx,
			);
			const ids = Object.entries(fork)
				.filter(([, e]) => LOST.includes(e.message as string))
				.map(([id]) => id);
			expect(ids).toHaveLength(LOST.length);
			// What extraction hands the backfill after the merge: the same entries,
			// emptied, with an upstream donor that does not carry them at all.
			const merged = { ...fork } as Catalog;
			for (const id of ids) merged[id] = { ...(fork[id] as Catalog[string]), translation: "" };
			const plan = planLocaleBackfill(locale, merged, [
				{ label: "fork@head", catalog: fork },
				{ label: "upstream@tag", catalog: catalog({}) },
			]);
			expect(plan.failures).toEqual([]);
			expect([...plan.fills.keys()].sort()).toEqual([...ids].sort());
			for (const id of ids) {
				const original = (fork[id] as Catalog[string]).translation as string;
				expect(original).not.toBe("");
				expect(plan.fills.get(id)).toBe(original);
			}
		}
		expect(TARGET_LOCALES.length).toBeGreaterThan(1);
	});
});

describe("extraction excludes", () => {
	// Reproduces how the Lingui CLI globs: absolute include roots, exclude
	// patterns matched against the CWD it runs in, which is this package. The
	// glob runs in a spawned `node` because node is what runs the CLI, and the
	// two runtimes disagree exactly here: bun's node:fs honours a bare
	// `**/*.test.*` against an absolute path, so under bun this assertion stays
	// green with the root-anchored patterns deleted and proves nothing about the
	// bug it exists for. Named files are deliberately not asserted — a renamed
	// upstream test would break the assertion without breaking the invariant.
	const packageDir = dirname(import.meta.dir);
	const rooted = (p: string) => p.replaceAll("<rootDir>", packageDir);
	const catalogConfig = config.catalogs![0]!;
	const crossApp = catalogConfig.include
		.map(rooted)
		.filter((dir) => !resolve(dir).startsWith(packageDir + sep))
		.map((dir) => resolve(dir, "**/*.*").replaceAll(sep, "/"));
	const isFixture = (f: string) => /\.(test|stories)\./.test(f);
	const glob = (exclude: string[]): string[] =>
		JSON.parse(
			execFileSync(
				"node",
				[
					"-e",
					"const {globSync}=require('node:fs');const [p,o]=JSON.parse(process.argv[1]);process.stdout.write(JSON.stringify(globSync(p,o)))",
					JSON.stringify([crossApp, { cwd: packageDir, exclude }]),
				],
				{ encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
			),
		);

	test("keeps test and story fixtures outside this package out of extraction", () => {
		expect(crossApp.length).toBeGreaterThan(0);
		expect(glob([]).filter(isFixture).length).toBeGreaterThan(0);
		const kept = glob(catalogConfig.exclude!.map(rooted));
		expect(kept.filter(isFixture)).toEqual([]);
		expect(kept.length).toBeGreaterThan(0);
	}, 60_000);

	test("the root-anchored patterns are the ones doing it", () => {
		// Deleting them from the config leaves the bare patterns, and this is
		// what they achieve on their own: nothing. That is why the test above
		// fails the moment someone trims the config back.
		const bare = catalogConfig.exclude!.filter((p) => !p.startsWith("<rootDir>"));
		expect(bare.length).toBeGreaterThan(0);
		expect(glob(bare.map(rooted)).filter(isFixture).length).toBeGreaterThan(0);
	}, 60_000);
});
