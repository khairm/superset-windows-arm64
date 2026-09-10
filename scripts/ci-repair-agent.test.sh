#!/usr/bin/env bash
# MANUAL regression test for `scripts/ci-repair.sh agent` — the repair round
# that installs dependencies, calls the AI, and then verifies the repaired tree.
#
#   bash scripts/ci-repair-agent.test.sh
#
# Deliberately NOT wired into CI. It pins the rule the whole step exists under:
# the work around the AI call is help, never a veto. An install that fails
# still gets the agent; an advisory gate that fails, cannot start, or runs out
# of job leaves the repair standing. `bun`, `claude`, `node` and `timeout` are
# mocked on PATH, the checkout is a throwaway directory, and no network,
# credential or model call is ever used.
set -uo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUBJECT="$SRC/ci-repair.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAIL=0
ok()    { PASS=$((PASS + 1)); echo "  ok    $1"; }
no()    { FAIL=$((FAIL + 1)); echo "  FAIL  $1"; }
zero()  { if [ "$2" -eq 0 ]; then ok "$1"; else no "$1 — expected rc 0, got $2"; fi; }
has()   { if printf '%s' "$2" | grep -qF -- "$3"; then ok "$1"; else no "$1 — [$3] not in output"; fi; }
hasnt() { if printf '%s' "$2" | grep -qF -- "$3"; then no "$1 — [$3] present"; else ok "$1"; fi; }
none()  { if [ -z "$2" ]; then ok "$1"; else no "$1 — got [$2]"; fi; }
eq()    { if [ "$2" = "$3" ]; then ok "$1"; else no "$1 — expected [$3], got [$2]"; fi; }
# <label> <predicate-function>: assert the named check did / did not happen.
did()   { if "$2"; then ok "$1"; else no "$1 — it did not"; fi; }
didnt() { if "$2"; then no "$1 — it did"; else ok "$1"; fi; }

# The OAuth token reaches the agent through the environment; nothing this step
# writes for a later step may carry it.
TOKEN_SENTINEL="sk-ant-oat-TOKEN_SENTINEL_MUST_NOT_LEAK"

BIN="$TMP/bin"; mkdir -p "$BIN"

# Bounds are asserted through this mock rather than by waiting them out: it
# records the budget it was handed, and refuses to run the wrapped command when
# the case wants an expiry. Real `timeout` is what CI uses.
cat > "$BIN/timeout" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$MOCK_CALLS/timeout"
while [ $# -gt 0 ]; do
  case "$1" in --*=* | -k) shift ;; *) break ;; esac
done
shift # the duration
case "${1:-}" in
  bun)  [ "${MOCK_BUN_TIMEOUT_RC:-0}"  = 0 ] || exit "$MOCK_BUN_TIMEOUT_RC" ;;
  node) [ "${MOCK_GATE_TIMEOUT_RC:-0}" = 0 ] || exit "$MOCK_GATE_TIMEOUT_RC" ;;
esac
exec "$@"
MOCK

cat > "$BIN/bun" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$MOCK_CALLS/bun"
if [ "${MOCK_BUN_RC:-0}" != 0 ]; then
  echo "mock bun: lockfile has changes" >&2
  exit "$MOCK_BUN_RC"
fi
# A real install leaves both halves of what the gate's `bunx tsc` resolves: the
# unpacked package AND the .bin shim linked to it. A half-finished one leaves
# the package unpacked with no shim — the shape that must not read as a
# compiler.
mkdir -p node_modules/typescript/bin node_modules/.bin
: > node_modules/typescript/bin/tsc
[ "${MOCK_BUN_PARTIAL:-0}" = 1 ] || ln -sf ../typescript/bin/tsc node_modules/.bin/tsc
echo "mock bun: installed"
MOCK

# Modes stand in for what a repair round can end as: an edit, an edit that also
# repaired the install, an infrastructure verdict, and a CLI that never reached
# the model (short output matching ai-run.sh's hard-failure signatures).
cat > "$BIN/claude" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "$*" > "$MOCK_CALLS/claude-argv"
case "${MOCK_CLAUDE_MODE:-fix}" in
  fix)        echo "fixed the import" ;;
  fix-deps)   mkdir -p node_modules/typescript/bin node_modules/.bin; : > node_modules/typescript/bin/tsc; ln -sf ../typescript/bin/tsc node_modules/.bin/tsc; echo "repaired the lockfile and installed" ;;
  retry-only) mkdir -p .fork; echo "runner outage" > .fork/repair-retry-only ;;
  diagnosis)  mkdir -p .fork; echo "root cause is in a frozen path" > .fork/repair-diagnosis.md ;;
  unavailable) echo "API Error: invalid api key" >&2; exit 1 ;;
esac
MOCK

cat > "$BIN/node" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$MOCK_CALLS/node"
[ "${MOCK_GATE_RC:-0}" = 0 ] || { echo "::error::(REFERR-GATE) TS2304"; exit "$MOCK_GATE_RC"; }
echo "(REFERR-GATE) clean"
MOCK
chmod +x "$BIN/timeout" "$BIN/bun" "$BIN/claude" "$BIN/node"

JOB_MINUTES=90
OUT=""; RC=0; STATE=""; CALLS=""
reset_mocks() {
  MOCK_BUN_RC=0; MOCK_BUN_PARTIAL=0; MOCK_CLAUDE_MODE=fix; MOCK_GATE_RC=0
  MOCK_BUN_TIMEOUT_RC=0; MOCK_GATE_TIMEOUT_RC=0
  PRE_DEPS=0
  STARTED="$(date +%s)"; MINUTES="$JOB_MINUTES" # a job that has just started
}

# Empty STARTED/MINUTES is how a workflow that passed no timing envelope looks.
run_agent() {
  local work="$TMP/work/$1" runner="$TMP/runner/$1"
  CALLS="$TMP/calls/$1"
  STATE="$runner/build-repair"
  mkdir -p "$work" "$runner" "$CALLS" "$STATE"
  if [ "$PRE_DEPS" -eq 1 ]; then
    mkdir -p "$work/node_modules/typescript/bin" "$work/node_modules/.bin"
    : > "$work/node_modules/typescript/bin/tsc"
    ln -sf ../typescript/bin/tsc "$work/node_modules/.bin/tsc"
  fi
  echo "===== last 800 lines =====" > "$STATE/build-failure.log"
  OUT="$(cd "$work" && PATH="$BIN:$PATH" \
    RUNNER_TEMP="$runner" MOCK_CALLS="$CALLS" \
    MOCK_BUN_RC="$MOCK_BUN_RC" MOCK_BUN_PARTIAL="$MOCK_BUN_PARTIAL" \
    MOCK_CLAUDE_MODE="$MOCK_CLAUDE_MODE" MOCK_GATE_RC="$MOCK_GATE_RC" \
    MOCK_BUN_TIMEOUT_RC="$MOCK_BUN_TIMEOUT_RC" MOCK_GATE_TIMEOUT_RC="$MOCK_GATE_TIMEOUT_RC" \
    CLAUDE_CODE_OAUTH_TOKEN="$TOKEN_SENTINEL" ROUND=1 REPAIR_BRANCH=nightly-candidate \
    REPAIR_JOB_STARTED_EPOCH="$STARTED" REPAIR_JOB_TIMEOUT_MINUTES="$MINUTES" \
    bash "$SUBJECT" agent 2>&1)"
  RC=$?
  echo "$1 (rc $RC)"
}

bun_budget()  { grep -m1 -E ' bun( |$)'  "$CALLS/timeout" 2>/dev/null | awk '{print $2}'; }
gate_budget() { grep -m1 -E ' node( |$)' "$CALLS/timeout" 2>/dev/null | awk '{print $2}'; }
gate_ran()    { grep -qF "check-dangerous-diagnostics.mjs" "$CALLS/node" 2>/dev/null; }
claude_ran()  { [ -f "$CALLS/claude-argv" ]; }

echo "== a clean round: install, agent, advisory gate — each inside the job envelope =="
reset_mocks
run_agent clean
zero  "the step succeeds" "$RC"
did   "the advisory gate ran" gate_ran
has   "and reports what it found" "$OUT" "(REFERR-GATE) is CLEAN"
eq    "the install is bounded at its own cap" "$(bun_budget)" "600"
GATE_BUDGET="$(gate_budget)"
if [ "$GATE_BUDGET" -gt 0 ] && [ "$GATE_BUDGET" -le $((JOB_MINUTES * 60 - 300 - 30)) ]; then
  ok "the gate's bound leaves validate+push its reserve, kill grace included"
else
  no "the gate's bound leaves validate+push its reserve, kill grace included — got [$GATE_BUDGET]"
fi
has   "the whole tree is killed, not just the direct child" "$(cat "$CALLS/timeout")" "--kill-after"
eq    "the AI result is what the push step reads" "$(cat "$STATE/claude-rc")" "0"
none  "no token in anything handed onward" "$(grep -rlF "$TOKEN_SENTINEL" "$STATE" "$CALLS" 2>/dev/null || true)"

echo "== a failed install still gets the agent, and tells it so =="
reset_mocks; MOCK_BUN_RC=1
run_agent install-failed
zero  "the step succeeds" "$RC"
did   "the agent still ran" claude_ran
has   "and was told the install failed" "$(cat "$CALLS/claude-argv")" "Result: FAILED (exit 1)"
has   "loudly, without failing the round" "$OUT" "::warning::"

echo "== the agent repairs the install it was handed: the advisory gate then runs =="
reset_mocks; MOCK_BUN_RC=1; MOCK_CLAUDE_MODE=fix-deps
run_agent install-repaired
zero  "the step succeeds" "$RC"
did   "the gate runs off the tree, not the stale install status" gate_ran
has   "and reports the real verdict" "$OUT" "(REFERR-GATE) is CLEAN"

echo "== an install that hits its bound is reported, never fatal =="
reset_mocks; MOCK_BUN_TIMEOUT_RC=124
run_agent install-timeout
zero  "the step succeeds" "$RC"
has   "the agent is told it timed out" "$(cat "$CALLS/claude-argv")" "Result: TIMED OUT"
did   "the agent still ran" claude_ran

echo "== a failing advisory gate does not block the repair =="
reset_mocks; MOCK_GATE_RC=1
run_agent gate-failed
zero  "the step succeeds so validate+push still runs" "$RC"
has   "the failure is reported without guessing its cause" "$OUT" "did not pass on the repaired tree"
eq    "the AI result is untouched" "$(cat "$STATE/claude-rc")" "0"

echo "== an advisory gate that runs out of time is unavailable, not a verdict =="
reset_mocks; MOCK_GATE_TIMEOUT_RC=124
run_agent gate-timeout
zero  "the step succeeds so validate+push still runs" "$RC"
has   "verification is reported unavailable" "$OUT" "advisory verification UNAVAILABLE"
has   "and says the repair stands" "$OUT" "repair stands"
hasnt "it is not passed off as a clean gate" "$OUT" "is CLEAN"
eq    "the AI result is untouched" "$(cat "$STATE/claude-rc")" "0"

echo "== a half-finished install unpacks the package but links no shim: do not guess =="
reset_mocks; MOCK_BUN_PARTIAL=1
run_agent partial-install
zero  "the step succeeds" "$RC"
didnt "the gate never started" gate_ran
has   "and says the compiler is missing" "$OUT" "no local TypeScript compiler"
hasnt "nothing is claimed about the tree" "$OUT" "is CLEAN"

echo "== too little job left: the gate is not started at all =="
reset_mocks; STARTED=$(( $(date +%s) - (JOB_MINUTES - 1) * 60 )); PRE_DEPS=1
run_agent no-headroom
zero  "the step succeeds so validate+push still runs" "$RC"
didnt "the gate never started" gate_ran
has   "verification is reported unavailable" "$OUT" "advisory verification UNAVAILABLE"
has   "the install did not start either" "$OUT" "dependency install SKIPPED"
none  "and nothing was given a budget it did not have" "$(bun_budget)"

echo "== no timing envelope: refuse to start an unbounded check =="
reset_mocks; STARTED=""; MINUTES=""; PRE_DEPS=1
run_agent no-envelope
zero  "the step succeeds" "$RC"
didnt "the gate never started" gate_ran
has   "and says why" "$OUT" "no job timing envelope"
eq    "the install still gets its own bound" "$(bun_budget)" "600"

echo "== retry-only and a frozen-path diagnosis have no tree to verify =="
reset_mocks; MOCK_CLAUDE_MODE=retry-only
run_agent retry-only
zero  "the step succeeds" "$RC"
didnt "the gate is skipped" gate_ran
has   "and says why" "$OUT" "skipping the advisory gate"

reset_mocks; MOCK_CLAUDE_MODE=diagnosis
run_agent diagnosis
zero  "the step succeeds" "$RC"
didnt "the gate is skipped for a diagnosis too" gate_ran

echo "== an unreachable model: no repair to verify, and the push step is told =="
reset_mocks; MOCK_CLAUDE_MODE=unavailable
run_agent ai-unavailable
zero  "the step succeeds so the push step decides" "$RC"
didnt "the gate is skipped" gate_ran
eq    "the pessimistic AI result survives for the push step" "$(cat "$STATE/claude-rc")" "99"

echo ""
echo "passed $PASS, failed $FAIL"
[ "$FAIL" -eq 0 ]
