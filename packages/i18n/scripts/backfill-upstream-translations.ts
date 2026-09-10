/**
 * (I18N-UPSTREAM-BACKFILL) Fills catalog entries that extraction left
 * untranslated with the EXACT translation upstream already ships for the same
 * message, read from a pinned upstream commit.
 *
 * Why this exists: a merge brings upstream's new source strings, and
 * `lingui extract` adds them to every locale with an empty `msgstr`. One empty
 * entry fails `compile --strict`, which fails the (I18N-CATALOG-GATE) build,
 * which fails the night. The translations are not missing — upstream wrote them
 * in all sixteen languages and they are sitting in the same catalogs one commit
 * away.
 *
 * This is NOT machine translation and never invents a word. A message is filled
 * only when the pinned upstream catalog for the SAME locale carries the same
 * msgid and context with a non-empty, non-fuzzy, non-obsolete translation.
 * Anything else — donor absent, empty, fuzzy, obsolete, native gettext plural
 * forms — fails loud with the locale and the message, and nothing is written.
 * A fork-only string still has to be translated by a human.
 *
 *   bun packages/i18n/scripts/backfill-upstream-translations.ts <upstream-commit-sha>
 *
 * The sha must be a full 40-hex commit (the nightly resolves it once from
 * `refs/upstream-tags/<tag>^{commit}`). A bare tag is rejected: tags move, and a
 * moved tag would change what "upstream's translation" means after review.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import config from "../lingui.config";

type Formatter = NonNullable<typeof config.format>;
type Catalog = Awaited<ReturnType<Formatter["parse"]>>;

const PACKAGE_DIR = join(import.meta.dir, "..");
const FULL_SHA = /^[0-9a-f]{40}$/;

/** English is derived from source, so it is never a backfill target. */
export const TARGET_LOCALES = config.locales.filter((l) => l !== config.sourceLocale);

/** The PO formatter parks gettext flags here; `@lingui/conf` types it as `{}`. */
const flagsOf = (entry: Catalog[string]): string[] =>
	(entry.extra as { flags?: string[] } | undefined)?.flags ?? [];

export function assertFullCommitSha(value: string | undefined): string {
	if (!value || !FULL_SHA.test(value)) {
		throw new Error(
			`(I18N-UPSTREAM-BACKFILL) expected a full 40-hex upstream commit sha, got '${value ?? ""}'. Resolve it once with 'git rev-parse refs/upstream-tags/<tag>^{commit}'.`,
		);
	}
	return value;
}

/**
 * The formatter reads `msgstr[0]` only, so a gettext-native plural entry would
 * lose every other form silently. Upstream's Lingui catalogs put plurals inside
 * the ICU message instead and carry none of these; if that ever changes, stop.
 */
export function assertNoNativePlurals(content: string, where: string): void {
	if (content.split("\n").some((line) => line.startsWith("msgid_plural "))) {
		throw new Error(
			`(I18N-UPSTREAM-BACKFILL) ${where} uses native gettext plural forms, which this backfill cannot carry across without dropping forms.`,
		);
	}
}

const identity = (id: string, entry: Catalog[string]) =>
	`${JSON.stringify(entry.message ?? id)}${entry.context ? ` [context: ${entry.context}]` : ""}`;

/**
 * Returns the entries `locale` should adopt from `donor`, or the reasons it
 * cannot. Pure: the caller decides whether to write.
 */
export function planLocaleBackfill(
	locale: string,
	fork: Catalog,
	donor: Catalog,
): { fills: Map<string, string>; failures: string[] } {
	const fills = new Map<string, string>();
	const failures: string[] = [];
	for (const [id, entry] of Object.entries(fork)) {
		if (entry.obsolete || entry.translation) continue;
		const reject = (why: string) =>
			failures.push(`${locale}: ${identity(id, entry)} — ${why}`);
		const source = donor[id];
		if (!source) {
			reject("upstream does not ship this message; a human must translate it");
			continue;
		}
		if (source.message !== entry.message || source.context !== entry.context) {
			reject("upstream entry has the same id but a different message/context");
			continue;
		}
		if (source.obsolete) reject("upstream marks its entry obsolete");
		else if (flagsOf(source).includes("fuzzy"))
			reject("upstream marks its translation fuzzy");
		else if (!source.translation) reject("upstream leaves it untranslated too");
		else fills.set(id, source.translation);
	}
	return { fills, failures };
}

function catalogFile(locale: string, root: string): string {
	const catalog = config.catalogs?.[0];
	if (!catalog) throw new Error("(I18N-UPSTREAM-BACKFILL) lingui.config.ts has no catalog");
	return `${catalog.path.replace("<rootDir>", root).replace("{locale}", locale)}.po`;
}

async function main(): Promise<void> {
	const sha = assertFullCommitSha(process.argv[2]);
	const format = config.format;
	if (!format) throw new Error("(I18N-UPSTREAM-BACKFILL) lingui.config.ts has no format");
	const sourceLocale = config.sourceLocale;
	if (!sourceLocale) throw new Error("(I18N-UPSTREAM-BACKFILL) lingui.config.ts has no sourceLocale");
	const git = (...args: string[]) =>
		execFileSync("git", ["-C", PACKAGE_DIR, ...args], {
			encoding: "utf8",
			maxBuffer: 256 * 1024 * 1024,
		});
	if (git("rev-parse", "--verify", "--quiet", `${sha}^{commit}`).trim() !== sha) {
		throw new Error(`(I18N-UPSTREAM-BACKFILL) ${sha} is not a commit in this repository`);
	}

	const failures: string[] = [];
	const writes: { file: string; content: string; filled: number; locale: string }[] = [];
	for (const locale of TARGET_LOCALES) {
		const file = catalogFile(locale, PACKAGE_DIR);
		const existing = readFileSync(file, "utf8");
		const donorPath = catalogFile(locale, ".");
		const donorContent = git("show", `${sha}:${donorPath}`);
		assertNoNativePlurals(donorContent, `${donorPath} at ${sha}`);
		const ctx = { locale, sourceLocale, filename: file };
		const fork = await format.parse(existing, ctx);
		const donor = await format.parse(donorContent, { ...ctx, filename: donorPath });
		const plan = planLocaleBackfill(locale, fork, donor);
		failures.push(...plan.failures);
		if (plan.failures.length > 0 || plan.fills.size === 0) continue;
		// The fork side is checked only for a catalog about to be rewritten:
		// serializing is what would drop the extra forms, and a locale with
		// nothing to fill is never serialized.
		assertNoNativePlurals(existing, file);
		for (const [id, translation] of plan.fills) {
			(fork[id] as { translation: string }).translation = translation;
		}
		writes.push({
			file,
			content: await format.serialize(fork, { ...ctx, existing }),
			filled: plan.fills.size,
			locale,
		});
	}

	// All-or-nothing: one unfillable message must not leave half the catalogs
	// rewritten, because the next gate would then blame the wrong thing.
	if (failures.length > 0) {
		throw new Error(
			`(I18N-UPSTREAM-BACKFILL) ${failures.length} message(s) have no usable upstream translation at ${sha}; nothing written:\n  ${failures.join("\n  ")}`,
		);
	}
	for (const write of writes) {
		writeFileSync(write.file, write.content, "utf8");
		console.log(`(I18N-UPSTREAM-BACKFILL) ${write.locale}: filled ${write.filled} from ${sha}`);
	}
	console.log(
		writes.length === 0
			? "(I18N-UPSTREAM-BACKFILL) every catalog was already translated; nothing to fill"
			: `(I18N-UPSTREAM-BACKFILL) filled ${writes.reduce((n, w) => n + w.filled, 0)} translation(s) across ${writes.length} locale(s)`,
	);
}

if (import.meta.main) await main();
