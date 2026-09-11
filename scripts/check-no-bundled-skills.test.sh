#!/usr/bin/env bash
# MANUAL regression test for scripts/check-no-bundled-skills.mjs, the
# (NO-BUNDLED-SKILLS) gate.
#
#   bash scripts/check-no-bundled-skills.test.sh
#
# Deliberately NOT wired into CI, like the other gate tests here. It runs the
# REAL gate against throwaway fixture repos in a temp dir, so nothing in this
# repository is read or written and the gate's own roots and identifier list are
# what gets tested.
set -uo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUBJECT="$SRC/check-no-bundled-skills.mjs"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if command -v node >/dev/null 2>&1; then RUNNER=node
elif command -v bun >/dev/null 2>&1; then RUNNER=bun
else echo "need node or bun on PATH"; exit 1; fi

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); echo "  ok    $1"; }
no() { FAIL=$((FAIL + 1)); echo "  FAIL  $1"; }

# Runs the gate with $1 as the repository root and reports rc + output.
run_gate() { (cd "$1" && "$RUNNER" "$SUBJECT" 2>&1); }

# packages/cli/src is the root this test exists for: the CLI is where a repair
# agent lands when a removed export breaks a command, and it was scanned only
# under packages/cli/scripts before.
CAUGHT="$TMP/caught"
mkdir -p "$CAUGHT/packages/cli/src/commands"
echo '{"name":"fixture"}' > "$CAUGHT/package.json"
cat > "$CAUGHT/packages/cli/src/commands/skills.ts" <<'TS'
import { createManagedSkills } from "@superset/agent-setup";
export const sync = () => createManagedSkills();
TS
OUT=$(run_gate "$CAUGHT"); RC=$?
if [ "$RC" -ne 0 ]; then ok "a retired export under packages/cli/src fails the gate"
else no "a retired export under packages/cli/src fails the gate — expected nonzero rc, got 0"; fi
if printf '%s' "$OUT" | grep -qF "packages/cli/src/commands/skills.ts"; then
	ok "the failure names the offending file"
else no "the failure names the offending file — [$OUT]"; fi

# The other half of the invariant: the gate must not read ordinary plugin
# metadata, user-owned skills, or unrelated CLI code as the bundled system
# returning. A repair told to "remove skills" must have no reason to touch any
# of this.
CLEAN="$TMP/clean"
mkdir -p "$CLEAN/packages/cli/src/commands" "$CLEAN/.claude/skills/my-skill" "$CLEAN/.claude-plugin"
echo '{"name":"fixture"}' > "$CLEAN/package.json"
cat > "$CLEAN/packages/cli/src/commands/plugins.ts" <<'TS'
export const listPlugins = () => readPluginMetadata();
TS
echo "# a user-owned skill" > "$CLEAN/.claude/skills/my-skill/SKILL.md"
echo '{"plugins":[{"name":"codex","source":"./plugins/codex"}]}' > "$CLEAN/.claude-plugin/marketplace.json"
OUT=$(run_gate "$CLEAN"); RC=$?
if [ "$RC" -eq 0 ]; then ok "plugin metadata, user-owned skills and unrelated CLI code stay green"
else no "plugin metadata, user-owned skills and unrelated CLI code stay green — rc $RC [$OUT]"; fi

echo
echo "passed $PASS, failed $FAIL"
[ "$FAIL" -eq 0 ]
