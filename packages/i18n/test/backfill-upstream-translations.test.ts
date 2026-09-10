import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { dirname, resolve, sep } from "node:path";
import {
	assertFullCommitSha,
	assertNoNativePlurals,
	planLocaleBackfill,
	TARGET_LOCALES,
} from "../scripts/backfill-upstream-translations";
import config from "../lingui.config";

// The backfill copies upstream's own translations into entries extraction left
// empty. What it must never do is invent text, overwrite a translation the fork
// already has, or write anything at all when one message cannot be filled.

type Catalog = Parameters<typeof planLocaleBackfill>[1];

const entry = (message: string, translation: string, extra?: Partial<Catalog[string]>) =>
	({ message, translation, ...extra }) as Catalog[string];

const catalog = (entries: Record<string, Catalog[string]>) => entries as Catalog;

describe("planLocaleBackfill", () => {
	test("fills an empty translation with upstream's exact text", () => {
		const plan = planLocaleBackfill(
			"ja",
			catalog({ a1: entry("Skills", "") }),
			catalog({ a1: entry("Skills", "スキル") }),
		);
		expect(plan.failures).toEqual([]);
		expect([...plan.fills]).toEqual([["a1", "スキル"]]);
	});

	test("leaves a translation the fork already has alone", () => {
		const plan = planLocaleBackfill(
			"ja",
			catalog({ a1: entry("Skills", "フォーク訳") }),
			catalog({ a1: entry("Skills", "スキル") }),
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
			catalog({ icu1: entry(icu, translated) }),
		);
		expect([...plan.fills.values()]).toEqual([translated]);
	});

	test("refuses an upstream entry whose context differs", () => {
		const plan = planLocaleBackfill(
			"ja",
			catalog({ v1: entry("View", "", { context: "menu" }) }),
			catalog({ v1: entry("View", "見る", { context: "button" }) }),
		);
		expect(plan.fills.size).toBe(0);
		expect(plan.failures[0]).toContain("different message/context");
	});

	test.each([
		["missing upstream", {}, "a human must translate it"],
		["empty upstream", { a1: entry("Skills", "") }, "untranslated too"],
		["fuzzy upstream", { a1: entry("Skills", "スキル", { extra: { flags: ["fuzzy"] } }) }, "fuzzy"],
		["obsolete upstream", { a1: entry("Skills", "スキル", { obsolete: true }) }, "obsolete"],
	])("rejects %s and fills nothing", (_name, donor, reason) => {
		const plan = planLocaleBackfill("ja", catalog({ a1: entry("Skills", "") }), catalog(donor));
		expect(plan.fills.size).toBe(0);
		expect(plan.failures).toHaveLength(1);
		expect(plan.failures[0]).toContain("ja: ");
		expect(plan.failures[0]).toContain(reason);
	});
});

describe("CLI boundaries", () => {
	test.each(["desktop-v1.28.0", "a415227", "", undefined, "A415227DC25F806DD3EF6BF05B464ADBA5AC08FB"])(
		"rejects %p as an upstream sha",
		(value) => {
			expect(() => assertFullCommitSha(value)).toThrow("full 40-hex");
		},
	);

	test("accepts a full commit sha", () => {
		const sha = "a415227dc25f806dd3ef6bf05b464adba5ac08fb";
		expect(assertFullCommitSha(sha)).toBe(sha);
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
