#!/usr/bin/env bash
# (I18N-CATALOG-GATE) Proves the committed Lingui catalogs are exactly what the
# current source extracts to.
#
# Why the obvious cheap check does not work: at upstream 1.26.0 the English
# source text IS the message id, and the production Babel macro resolves
# `descriptorFields: "auto"` to `"id-only"` — it strips the inline fallback and
# emits only a hashed id. A string missing from the catalog therefore renders as
# `OGXtL8`, not as English. Nothing short of running extraction can tell whether
# a call site made it into the catalog, so this gate runs the real thing.
#
# It is the check upstream's own CI runs and that (WORKFLOW-FORK-OWNED) dropped
# along with every upstream workflow — which is how the sidebar shipped the
# literal text `dashboard.sidebar.header.kanban` instead of "Kanban".
#
# Failure means someone changed user-facing copy without regenerating the
# catalogs, OR a merge left a catalog stale. Both are fixed the same way, by a
# human: `bun run check:i18n`, translate anything new, commit the catalogs.
#
# DELIBERATELY NOT self-repairable ((BUILD-REPAIR) cannot reach a frozen
# workflow step, and this script is frozen in ci-repair.sh): the only way to
# satisfy a dirty-catalog failure is to write translations, and unreviewed
# machine-invented translations in sixteen languages is exactly what must not
# ship unattended.
#
# One class of failure IS handled without a human, and it is not that:
# packages/i18n/scripts/backfill-upstream-translations.ts, run by the nightly
# merge before the candidate commit, copies a pinned donor's OWN translation for
# a message verbatim — the fork's pre-merge commit first, then the tag being
# merged. Exact msgid+context or it fails.
# See (I18N-UPSTREAM-BACKFILL) in FEATURES.md. This script is unchanged by it
# and still fails on anything that copy could not reach.
set -euo pipefail

if [ ! -f package.json ]; then
	echo "::error::(I18N-CATALOG-GATE) run from the repository root; package.json is missing"
	exit 1
fi

# `git diff --quiet` trusts the index's stat cache. Regenerating rewrites all 34
# catalogs, so every one is stat-dirty afterwards, and on a checkout that wrote
# them with CRLF that alone was reported as a difference even though the content
# matched after normalisation — the gate's first run failed a build over line
# endings. Refreshing makes the comparison about content. (.gitattributes now
# pins the catalogs to LF as well; this is the belt to that's braces, because a
# stale stat entry is not specific to line endings.)
catalogs_are_clean() {
	# Whole index, no pathspec: `git update-index --refresh` takes file
	# arguments rather than a pathspec, and a form it rejects would be swallowed
	# by the `|| true` below and refresh nothing — which is how the first
	# version of this still failed a build over stale stat entries. Exit status
	# is non-zero whenever anything needed updating, so it is deliberately
	# ignored; the answer comes from the comparison that follows.
	git update-index -q --really-refresh >/dev/null 2>&1 || true
	git diff --quiet -- packages/i18n/locales &&
		[ -z "$(git status --porcelain -- packages/i18n/locales)" ]
}

if ! catalogs_are_clean; then
	echo "::error::(I18N-CATALOG-GATE) packages/i18n/locales is already dirty before extraction; refusing to run so the result cannot be attributed to this gate"
	git status --porcelain -- packages/i18n/locales
	exit 1
fi

echo "(I18N-CATALOG-GATE) regenerating catalogs from source"
# The package's own `extract`/`compile` scripts shell out through
# `bunx --bun lingui`, which on Windows mis-parses a checkout path containing a
# space as a git remote and fails to resolve. The gate calls the installed
# binary directly so it behaves the same on a maintainer's machine and on the
# runner.
LINGUI="node_modules/.bin/lingui"
if [ ! -e "packages/i18n/$LINGUI" ]; then
	echo "::error::(I18N-CATALOG-GATE) packages/i18n/$LINGUI is missing; run 'bun install' first"
	exit 1
fi
# cd, not --config: lingui resolves <rootDir> from the config it DISCOVERS by
# walking up from the cwd, and the repo root carries a re-export of this config
# for the babel macro. Running from the root therefore resolves <rootDir> to the
# root, extracts nothing, writes a stray ./locales, and leaves the real
# catalogs untouched — a gate that passes green having checked nothing.
(cd packages/i18n && "$LINGUI" extract --clean --overwrite --workers 1)
(cd packages/i18n && "$LINGUI" compile --strict --workers 1)

# Fail loud on that exact silent-pass shape rather than trusting the cd above:
# a clean diff is only evidence if extraction actually collected the catalog.
MESSAGES=$(grep -c '^msgid ' packages/i18n/locales/en/messages.po || true)
if [ "$MESSAGES" -lt 1000 ]; then
	echo "::error::(I18N-CATALOG-GATE) extraction produced $MESSAGES messages in packages/i18n/locales/en/messages.po, far below the floor of 1000. Extraction did not see the source; a clean diff here would mean nothing."
	exit 1
fi
if [ -e locales ]; then
	echo "::error::(I18N-CATALOG-GATE) extraction wrote a stray ./locales at the repository root, which means it resolved the wrong config. Refusing to report a result."
	exit 1
fi

if ! catalogs_are_clean; then
	echo "::error::(I18N-CATALOG-GATE) the committed catalogs do not match what the source extracts to. A message missing from the catalog renders as its hashed id (e.g. OGXtL8) in a production build. Run 'bun run check:i18n', fill in any new translations, and commit packages/i18n/locales."
	git status --porcelain -- packages/i18n/locales
	git --no-pager diff --stat -- packages/i18n/locales
	git --no-pager diff -- packages/i18n/locales | head -n 200
	exit 1
fi

echo "(I18N-CATALOG-GATE) catalogs match the source"
