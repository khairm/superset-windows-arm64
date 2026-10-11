#!/usr/bin/env bash
# Regression coverage for the (MERGE-SEMANTIC-GATE) blocker lifecycle in
# .github/workflows/nightly-merge.yml.
#
# Seam: the three fenced (BLOCKER-LIFECYCLE:drain|retire-gate|findings) regions
# of that workflow's inline shell are extracted VERBATIM and executed here over
# temp files, so this exercises the shipped logic rather than a copy of it. The
# retire-gate region ends in `break`, so each case wraps it in a one-iteration
# loop exactly as the round loop does. Nothing here runs git, a model, or the
# network. A renamed or deleted fence fails loudly instead of passing empty.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WF="$ROOT/.github/workflows/nightly-merge.yml"
TMPDIRS=()
trap 'rm -rf ${TMPDIRS[@]+"${TMPDIRS[@]}"}' EXIT
FAILURES=0

fragment() {
  local frag
  frag="$(awk -v b="(BLOCKER-LIFECYCLE:$1) begin" -v e="(BLOCKER-LIFECYCLE:$1) end" '
    index($0, e) { inside = 0 }
    inside
    index($0, b) { inside = 1 }
  ' "$WF")"
  [ -n "$frag" ] || { echo "FATAL: no (BLOCKER-LIFECYCLE:$1) fence in $WF" >&2; exit 1; }
  printf '%s\n' "$frag"
}

prelude() {
  cat <<'PRE'
set -euo pipefail
ADAPT_FINDINGS_FILE="$RUNNER_TEMP/findings.txt"
ADAPT_DIAGS_FILE="$RUNNER_TEMP/diags.txt"
NEW_BLOCKERS_FILE="$RUNNER_TEMP/new-blockers.txt"
ADAPT_BLOCKERS_FILE="$RUNNER_TEMP/open-blockers.txt"
REVIEW_FILE="$RUNNER_TEMP/review.txt"
rm -f "$ADAPT_FINDINGS_FILE" "$ADAPT_DIAGS_FILE"
PRE
  fragment drain
}

expand() {
  while IFS= read -r line; do
    case "$line" in
      '#@prelude') prelude ;;
      '#@'*) fragment "${line#\#@}" ;;
      *) printf '%s\n' "$line" ;;
    esac
  done
}

run_case() {
  CASE_DIR="$(mktemp -d)"
  TMPDIRS+=("$CASE_DIR")
  expand > "$CASE_DIR/case.sh"
  set +e
  RUNNER_TEMP="$CASE_DIR" bash "$CASE_DIR/case.sh" > "$CASE_DIR/out.txt" 2>&1
  RC=$?
  set -e
}

ok() { printf 'PASS  %s\n' "$1"; }
bad() { printf 'FAIL  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
expect() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (got '$2', want '$3')"; fi; }
expect_has() { if grep -qF "$3" "$2"; then ok "$1"; else bad "$1 (missing '$3')"; fi; }
expect_lacks() { if grep -qF "$3" "$2"; then bad "$1 (unexpected '$3')"; else ok "$1"; fi; }
expect_empty() { if [ -s "$2" ]; then bad "$1 (file not empty)"; else ok "$1"; fi; }

BLOCKER_A='UNRESOLVED BLOCKER: apps/desktop/src/a.ts fails to compile'
BLOCKER_B='UNRESOLVED BLOCKER: packages/db/src/b.ts fails to compile'

# 1. A blocker the port pass recorded survives a BREAKAGE round whose verdict
#    never mentions it, and still reaches the next repair agent.
run_case <<CASE
#@prelude
printf '%s\n' '$BLOCKER_A' >> "\$NEW_BLOCKERS_FILE"
drain_new_blockers
printf '%s\n' 'VERDICT: BREAKAGE' 'packages/db/src/c.ts — KANBAN — fork column dropped' > "\$REVIEW_FILE"
for __once in 1; do
#@retire-gate
done
#@findings
CASE
expect "unrelated BREAKAGE round exits clean" "$RC" 0
expect_has "blocker stays open across the round" "$CASE_DIR/open-blockers.txt" "$BLOCKER_A"
expect_has "blocker reaches the next repair" "$CASE_DIR/findings.txt" "$BLOCKER_A"
expect_has "review finding reaches the next repair" "$CASE_DIR/findings.txt" 'fork column dropped'

# 2. An OK verdict cannot ship while a blocker is open, even with no gate
#    diagnostics outstanding.
run_case <<CASE
#@prelude
printf '%s\n' '$BLOCKER_A' >> "\$NEW_BLOCKERS_FILE"
drain_new_blockers
printf '%s\n' 'VERDICT: OK' > "\$REVIEW_FILE"
for __once in 1; do
#@retire-gate
done
CASE
expect "OK over an open blocker aborts" "$RC" 1
expect_has "abort is loud" "$CASE_DIR/out.txt" 'blockers recorded by an earlier round are still open'

# 3. Retirement is per-line and verbatim: the named blocker clears, the one the
#    review did not name keeps blocking OK.
run_case <<CASE
#@prelude
printf '%s\n' '$BLOCKER_A' '$BLOCKER_B' >> "\$NEW_BLOCKERS_FILE"
drain_new_blockers
printf '%s\n' 'VERDICT: OK' 'BLOCKER RESOLVED: $BLOCKER_A' > "\$REVIEW_FILE"
for __once in 1; do
#@retire-gate
done
CASE
expect "unnamed blocker still blocks OK" "$RC" 1
expect_lacks "named blocker retired" "$CASE_DIR/open-blockers.txt" 'apps/desktop/src/a.ts'
expect_has "unnamed blocker kept" "$CASE_DIR/open-blockers.txt" "$BLOCKER_B"

# 4. A repaired blocker the review verified is retired, so it does not poison
#    the round: OK ships.
run_case <<CASE
#@prelude
printf '%s\n' '$BLOCKER_A' >> "\$NEW_BLOCKERS_FILE"
drain_new_blockers
printf '%s\n' 'VERDICT: OK' 'BLOCKER RESOLVED: $BLOCKER_A' > "\$REVIEW_FILE"
for __once in 1; do
#@retire-gate
done
CASE
expect "fully retired blockers let OK ship" "$RC" 0
expect_empty "open-blocker record cleared" "$CASE_DIR/open-blockers.txt"
expect_lacks "no error raised" "$CASE_DIR/out.txt" '::error::'

# 5. A fixer that wrote the inbox some other way stops the night: truncating it
#    is what makes a drop permanent, so an unrecognised line is never discarded.
run_case <<CASE
#@prelude
printf '%s\n' '$BLOCKER_A' 'note: could not fix packages/db/src/b.ts' >> "\$NEW_BLOCKERS_FILE"
drain_new_blockers
CASE
expect "a malformed inbox line aborts the drain" "$RC" 1
expect_has "abort is loud" "$CASE_DIR/out.txt" 'without the required'
expect_has "the malformed line survives" "$CASE_DIR/new-blockers.txt" 'note: could not fix'
expect_has "and so does the well-formed one beside it" "$CASE_DIR/new-blockers.txt" "$BLOCKER_A"
expect_empty "nothing reached the open record" "$CASE_DIR/open-blockers.txt"

if [ "$FAILURES" -ne 0 ]; then
  echo "$FAILURES blocker-lifecycle assertion(s) failed"
  exit 1
fi
echo "blocker lifecycle OK"
