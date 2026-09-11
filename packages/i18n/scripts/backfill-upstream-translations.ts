/**
 * (I18N-UPSTREAM-BACKFILL) Fills catalog entries that extraction left
 * untranslated with the EXACT translation a pinned donor already ships for the
 * same message. Two donors are consulted in order: the fork's OWN commit first,
 * then the upstream commit being merged.
 *
 * Why this exists: a merge brings upstream's new source strings, and
 * `lingui extract` adds them to every locale with an empty `msgstr`. One empty
 * entry fails `compile --strict`, which fails the (I18N-CATALOG-GATE) build,
 * which fails the night. The translations are not missing — they are sitting in
 * the same catalogs one commit away.
 *
 * Why the fork commit comes first: a fork-only string is one upstream has never
 * seen, so upstream can never fill it, but the fork's own catalogs already
 * carry it in all sixteen languages. Asking the fork commit first recovers that
 * text verbatim instead of sending a night red over words the repository
 * already holds. Upstream stays the donor for upstream's own new strings.
 *
 * This is NOT machine translation and never invents a word. A message is filled
 * only when a donor catalog for the SAME locale carries the same msgid and
 * context with a non-empty, non-fuzzy, non-obsolete translation. A donor that
 * cannot answer is skipped and the next one is asked; when NO donor can answer,
 * the run fails loud naming the locale, the message and what each donor said,
 * and nothing is written. Native gettext plural forms are refused outright —
 * the formatter reads one form and would drop the rest.
 *
 *   bun packages/i18n/scripts/backfill-upstream-translations.ts \
 *     --fork=<fork-commit-sha> --upstream=<upstream-commit-sha>
 *
 * Both must be full 40-hex commits (the nightly pins the fork one before the
 * merge and resolves the upstream one from `refs/upstream-tags/<tag>^{commit}`).
 * A bare tag is rejected: tags move, and a moved tag would change what
 * "the donor's translation" means after review. The flags are named rather than
 * positional so the two commits can never be swapped by accident.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import config from "../lingui.config";

type Formatter = NonNullable<typeof config.format>;
type Catalog = Awaited<ReturnType<Formatter["parse"]>>;

/** A pinned catalog the fill may copy from, in the order it is asked. */
export type Donor = { label: string; catalog: Catalog };

const PACKAGE_DIR = join(import.meta.dir, "..");
const FULL_SHA = /^[0-9a-f]{40}$/;
const DONOR_FLAGS = ["fork", "upstream"] as const;
type DonorName = (typeof DONOR_FLAGS)[number];

/** English is derived from source, so it is never a backfill target. */
export const TARGET_LOCALES = config.locales.filter((l) => l !== config.sourceLocale);

/** The PO formatter parks gettext flags here; `@lingui/conf` types it as `{}`. */
const flagsOf = (entry: Catalog[string]): string[] =>
	(entry.extra as { flags?: string[] } | undefined)?.flags ?? [];

export function assertFullCommitSha(value: string | undefined, label: string): string {
	if (!value || !FULL_SHA.test(value)) {
		throw new Error(
			`(I18N-UPSTREAM-BACKFILL) ${label} expected a full 40-hex commit sha, got '${value ?? ""}'. Resolve it once with 'git rev-parse <ref>^{commit}'.`,
		);
	}
	return value;
}

/**
 * Both donors are named and required. An unknown, missing or repeated flag is a
 * caller bug, and the one it would hide — fork and upstream the wrong way round
 * — silently changes which translation wins.
 */
export function parseDonorArgs(argv: string[]): Record<DonorName, string> {
	const seen = new Map<DonorName, string>();
	for (const arg of argv) {
		const match = /^--([^=]+)=(.*)$/.exec(arg);
		const name = match?.[1];
		if (!name || !(DONOR_FLAGS as readonly string[]).includes(name)) {
			throw new Error(
				`(I18N-UPSTREAM-BACKFILL) unexpected argument '${arg}'; expected exactly --fork=<40-hex> and --upstream=<40-hex>.`,
			);
		}
		const donor = name as DonorName;
		if (seen.has(donor)) {
			throw new Error(
				`(I18N-UPSTREAM-BACKFILL) --${donor} was given more than once; each donor takes exactly one commit.`,
			);
		}
		seen.set(donor, assertFullCommitSha(match?.[2], `--${donor}`));
	}
	for (const donor of DONOR_FLAGS) {
		if (!seen.has(donor)) {
			throw new Error(
				`(I18N-UPSTREAM-BACKFILL) missing --${donor}=<40-hex>; both --fork and --upstream are required.`,
			);
		}
	}
	return Object.fromEntries(seen) as Record<DonorName, string>;
}

/**
 * The formatter reads `msgstr[0]` only, so a gettext-native plural entry would
 * lose every other form silently. The Lingui catalogs on both sides put plurals
 * inside the ICU message instead and carry none of these; if that ever changes,
 * stop.
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

/** Why this donor entry cannot be copied, or null when it can. */
function rejection(source: Catalog[string] | undefined, entry: Catalog[string]): string | null {
	if (!source) return "does not ship this message";
	if (source.message !== entry.message || source.context !== entry.context)
		return "has the same id but a different message/context";
	if (source.obsolete) return "marks its entry obsolete";
	if (flagsOf(source).includes("fuzzy")) return "marks its translation fuzzy";
	if (!source.translation) return "leaves it untranslated too";
	return null;
}

/**
 * Returns the entries `locale` should adopt from the first donor that can
 * answer, or the reasons none could. Pure: the caller decides whether to write.
 */
export function planLocaleBackfill(
	locale: string,
	merged: Catalog,
	donors: Donor[],
): { fills: Map<string, string>; failures: string[] } {
	const fills = new Map<string, string>();
	const failures: string[] = [];
	for (const [id, entry] of Object.entries(merged)) {
		if (entry.obsolete || entry.translation) continue;
		const refused: string[] = [];
		for (const donor of donors) {
			const source = donor.catalog[id];
			const why = rejection(source, entry);
			if (why) {
				refused.push(`${donor.label} ${why}`);
				continue;
			}
			fills.set(id, (source as Catalog[string]).translation as string);
			break;
		}
		if (!fills.has(id)) {
			failures.push(
				`${locale}: ${identity(id, entry)} — ${refused.join("; ")}; a human must translate it`,
			);
		}
	}
	return { fills, failures };
}

function catalogFile(locale: string, root: string): string {
	const catalog = config.catalogs?.[0];
	if (!catalog) throw new Error("(I18N-UPSTREAM-BACKFILL) lingui.config.ts has no catalog");
	return `${catalog.path.replace("<rootDir>", root).replace("{locale}", locale)}.po`;
}

async function main(): Promise<void> {
	const shas = parseDonorArgs(process.argv.slice(2));
	const format = config.format;
	if (!format) throw new Error("(I18N-UPSTREAM-BACKFILL) lingui.config.ts has no format");
	const sourceLocale = config.sourceLocale;
	if (!sourceLocale) throw new Error("(I18N-UPSTREAM-BACKFILL) lingui.config.ts has no sourceLocale");
	const git = (...args: string[]) =>
		execFileSync("git", ["-C", PACKAGE_DIR, ...args], {
			encoding: "utf8",
			maxBuffer: 256 * 1024 * 1024,
		});
	for (const [name, sha] of Object.entries(shas)) {
		// `--verify` exits nonzero for anything git cannot resolve to an object,
		// and execFileSync raises that as its own opaque throw, so the sha the
		// caller actually passed has to be named from the catch as well. A spawn
		// failure carries no exit status and is re-thrown untouched.
		let resolved = "";
		try {
			resolved = git("rev-parse", "--verify", "--quiet", `${sha}^{commit}`).trim();
		} catch (error) {
			if (typeof (error as { status?: unknown }).status !== "number") throw error;
		}
		if (resolved !== sha) {
			throw new Error(`(I18N-UPSTREAM-BACKFILL) --${name} ${sha} is not a commit in this repository`);
		}
	}

	/**
	 * A catalog absent at a pinned fork commit is an empty donor, not a failure
	 * — a locale the fork gained in this merge is the ordinary cause, and
	 * upstream is then the only donor for it. Existence is asked of git
	 * directly: reading `git show` for a throw would also swallow a corrupt
	 * object or a bad sha as "absent".
	 */
	const donorCatalog = async (
		name: DonorName,
		ctx: { locale: string; sourceLocale: string },
	): Promise<Donor> => {
		const locale = ctx.locale;
		const sha = shas[name];
		const path = catalogFile(locale, ".");
		const label = `${name}@${sha}`;
		const present = git("ls-tree", "-r", "--name-only", sha, "--", path).trim() !== "";
		if (!present) {
			if (name !== "fork") {
				throw new Error(
					`(I18N-UPSTREAM-BACKFILL) ${label} has no catalog at ${path} for locale ${locale}`,
				);
			}
			console.log(
				`(I18N-UPSTREAM-BACKFILL) ${label} has no catalog at ${path}; the catalog is absent at the pinned fork commit, so upstream is ${locale}'s only donor`,
			);
			return { label, catalog: {} as Catalog };
		}
		const content = git("show", `${sha}:${path}`);
		assertNoNativePlurals(content, `${path} at ${label}`);
		return { label, catalog: await format.parse(content, { ...ctx, filename: path }) };
	};

	const failures: string[] = [];
	const writes: { file: string; content: string; filled: number; locale: string }[] = [];
	for (const locale of TARGET_LOCALES) {
		const file = catalogFile(locale, PACKAGE_DIR);
		const existing = readFileSync(file, "utf8");
		const ctx = { locale, sourceLocale, filename: file };
		const merged = await format.parse(existing, ctx);
		const donors = [await donorCatalog("fork", ctx), await donorCatalog("upstream", ctx)];
		const plan = planLocaleBackfill(locale, merged, donors);
		failures.push(...plan.failures);
		if (plan.failures.length > 0 || plan.fills.size === 0) continue;
		// The merged side is checked only for a catalog about to be rewritten:
		// serializing is what would drop the extra forms, and a locale with
		// nothing to fill is never serialized.
		assertNoNativePlurals(existing, file);
		for (const [id, translation] of plan.fills) {
			(merged[id] as { translation: string }).translation = translation;
		}
		writes.push({
			file,
			content: await format.serialize(merged, { ...ctx, existing }),
			filled: plan.fills.size,
			locale,
		});
	}

	// All-or-nothing: one unfillable message must not leave half the catalogs
	// rewritten, because the next gate would then blame the wrong thing.
	if (failures.length > 0) {
		throw new Error(
			`(I18N-UPSTREAM-BACKFILL) ${failures.length} message(s) have no usable translation at fork@${shas.fork} or upstream@${shas.upstream}; nothing written:\n  ${failures.join("\n  ")}`,
		);
	}
	for (const write of writes) {
		writeFileSync(write.file, write.content, "utf8");
		console.log(`(I18N-UPSTREAM-BACKFILL) ${write.locale}: filled ${write.filled}`);
	}
	console.log(
		writes.length === 0
			? "(I18N-UPSTREAM-BACKFILL) every catalog was already translated; nothing to fill"
			: `(I18N-UPSTREAM-BACKFILL) filled ${writes.reduce((n, w) => n + w.filled, 0)} translation(s) across ${writes.length} locale(s) from fork@${shas.fork} then upstream@${shas.upstream}`,
	);
}

if (import.meta.main) await main();
