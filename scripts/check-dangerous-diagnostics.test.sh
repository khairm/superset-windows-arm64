#!/usr/bin/env bash
# MANUAL regression test for scripts/check-dangerous-diagnostics.mjs, the
# (REFERR-GATE) that is the build's only type gate.
#
#   bash scripts/check-dangerous-diagnostics.test.sh
#
# Deliberately NOT wired into CI. It runs the REAL gate against a stub `bunx`
# on PATH that replays canned tsc output, so no compiler runs, nothing in the
# repo is written, and the gate's own package list and parsing are what gets
# tested. The stub ships in both flavours because the gate spawns through a
# shell: cmd.exe picks bunx.cmd on Windows, /bin/sh picks bunx elsewhere.
set -uo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUBJECT="$SRC/check-dangerous-diagnostics.mjs"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if command -v node >/dev/null 2>&1; then RUNNER=node
elif command -v bun >/dev/null 2>&1; then RUNNER=bun
else echo "need node or bun on PATH"; exit 1; fi

PASS=0
FAIL=0
ok()   { PASS=$((PASS + 1)); echo "  ok    $1"; }
no()   { FAIL=$((FAIL + 1)); echo "  FAIL  $1"; }
zero() { if [ "$2" -eq 0 ]; then ok "$1"; else no "$1 — expected rc 0, got $2"; fi; }
nonz() { if [ "$2" -ne 0 ]; then ok "$1"; else no "$1 — expected nonzero rc, got 0"; fi; }
has()  { if printf '%s' "$2" | grep -qF -- "$3"; then ok "$1"; else no "$1 — [$3] not in output"; fi; }

# cmd.exe cannot read the POSIX path bash hands it, and MSYS only rewrites
# PATH-shaped variables, so the fixture path is converted by hand.
nat() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi; }

BIN="$TMP/bin"; mkdir -p "$BIN"
cat > "$BIN/bunx" <<'MOCK'
#!/usr/bin/env bash
[ -n "${STUB_TSC_OUT:-}" ] && [ -f "$STUB_TSC_OUT" ] && cat "$STUB_TSC_OUT"
exit "${STUB_TSC_STATUS:-0}"
MOCK
chmod +x "$BIN/bunx"
printf '@echo off\r\nif exist "%%STUB_TSC_OUT%%" type "%%STUB_TSC_OUT%%"\r\nexit /b %%STUB_TSC_STATUS%%\r\n' > "$BIN/bunx.cmd"

FIX="$TMP/fixtures"; mkdir -p "$FIX"
# The new class: one name declared twice in one scope, which a merge produces
# when fork and upstream each add their own copy. It does not compile at all.
cat > "$FIX/duplicate.txt" <<'OUT'
src/main/lib/repair/state.ts(12,7): error TS2451: Cannot redeclare block-scoped variable 'attemptCount'.
src/main/lib/repair/state.ts(44,7): error TS2451: Cannot redeclare block-scoped variable 'attemptCount'.
OUT
# The five the gate has always caught, in one compiler run: each one it still
# catches is echoed back by code.
cat > "$FIX/referr.txt" <<'OUT'
src/a.ts(3,1): error TS2304: Cannot find name 'buildLogPath'.
src/b.ts(9,5): error TS2552: Cannot find name 'colect'. Did you mean 'collect'?
src/c.ts(4,2): error TS2662: Cannot find name 'attempts'. Did you mean the static member 'Repair.attempts'?
src/d.ts(7,2): error TS2663: Cannot find name 'round'. Did you mean the instance member 'this.round'?
src/e.ts(2,8): error TS18004: No value exists in scope for the shorthand property 'sha'.
OUT
# Type debt the fork accepts: real diagnostics, none of them a runtime crash.
cat > "$FIX/debt.txt" <<'OUT'
src/f.ts(10,3): error TS2322: Type 'string' is not assignable to type 'number'.
src/g.ts(21,9): error TS7006: Parameter 'row' implicitly has an 'any' type.
OUT
: > "$FIX/empty.txt"

OUT=""
RC=0
# run_gate <fixture> <tsc-exit-status>
run_gate() {
  OUT="$(PATH="$BIN:$PATH" STUB_TSC_OUT="$(nat "$FIX/$1")" STUB_TSC_STATUS="$2" \
    "$RUNNER" "$SUBJECT" 2>&1)"
  RC=$?
}

echo "== a duplicate declaration fails the gate, naming both sites =="
run_gate duplicate.txt 2
nonz "gate fails" "$RC"
has  "first declaration is reported" "$OUT" "state.ts(12,7)"
has  "second declaration is reported" "$OUT" "state.ts(44,7)"
has  "as a (REFERR-GATE) error" "$OUT" "::error::(REFERR-GATE)"

echo "== every cannot-find-name code still fails the gate =="
run_gate referr.txt 2
nonz "gate fails" "$RC"
for code in TS2304 TS2552 TS2662 TS2663 TS18004; do
  has "$code is reported" "$OUT" "$code"
done

echo "== accepted type debt still passes =="
run_gate debt.txt 2
zero "gate passes" "$RC"
has  "counted as debt, not danger" "$OUT" "0 dangerous"

echo "== a clean compile passes =="
run_gate empty.txt 0
zero "gate passes" "$RC"

echo "== a compiler that fails without diagnostics is not a pass =="
run_gate empty.txt 2
nonz "gate fails" "$RC"
has  "and says why" "$OUT" "without producing any diagnostics"

echo ""
echo "passed $PASS, failed $FAIL"
[ "$FAIL" -eq 0 ]
