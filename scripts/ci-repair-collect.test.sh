#!/usr/bin/env bash
# MANUAL regression test for `scripts/ci-repair.sh collect` — the step that
# hands the repair agent the failed build's log.
#
#   bash scripts/ci-repair-collect.test.sh
#
# Deliberately NOT wired into CI. It pins the failures that made a repair run
# useless in practice: a log download that died on terminal escape sequences,
# a "success" that produced an empty log, and a repair aimed at a tree the
# failed attempt never built. `gh`, `jq` and `curl` are mocked on PATH, the
# checkout is a throwaway git repo under a temp dir, and no network or
# credential is ever used.
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
nonz()  { if [ "$2" -ne 0 ]; then ok "$1"; else no "$1 — expected nonzero rc, got 0"; fi; }
has()   { if printf '%s' "$2" | grep -qF -- "$3"; then ok "$1"; else no "$1 — [$3] not in output"; fi; }
hasnt() { if printf '%s' "$2" | grep -qF -- "$3"; then no "$1 — [$3] present"; else ok "$1"; fi; }
none()  { if [ -z "$2" ]; then ok "$1"; else no "$1 — got [$2]"; fi; }
absent(){ if [ -e "$2" ]; then no "$1 — $2 exists"; else ok "$1"; fi; }

# A token that must never reach a file the repair agent (or an uploaded
# artifact) can read: the agent step runs credential-less on purpose.
TOKEN_SENTINEL="ghs_TOKEN_SENTINEL_MUST_NOT_LEAK"
JOB_ID=4242

BIN="$TMP/bin"; mkdir -p "$BIN"

# mock `gh api`: serves the run-jobs JSON and records every argv, so the test
# can prove the removed `gh api --help` capability probe is gone.
cat > "$BIN/gh" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$MOCK_CALLS/gh"
[ "${1:-}" = api ] || { echo "mock gh: unexpected argv: $*" >&2; exit 91; }
case "$*" in *--help*) echo "mock gh: help probe" >&2; exit 1 ;; esac
cat "$MOCK_JOBS_JSON"
MOCK

# mock `jq`: the jobs JSON is real, but jq is not installed everywhere this
# test runs, so each of collect's three queries answers from an env var.
# Routed on the distinguishing part of each filter, not the whole string.
cat > "$BIN/jq" <<'MOCK'
#!/usr/bin/env bash
filter=""
while [ $# -gt 0 ]; do
  case "$1" in -*) shift ;; *) [ -n "$filter" ] || filter="$1"; shift ;; esac
done
case "$filter" in
  *conclusion*) printf '%s\n' "${MOCK_JOB_STEPS-}" ;;
  *.id*)        printf '%s\n' "${MOCK_JOB_ID-}" ;;
  *.name*)      printf '%s\n' "${MOCK_JOB_NAME-}" ;;
  *) echo "mock jq: unrecognised filter: $filter" >&2; exit 92 ;;
esac
MOCK

# mock `curl`: records argv, then either fails with $MOCK_CURL_RC or writes
# $MOCK_BODY to the -o path. Only -o is parsed; every other flag and value is
# skipped one word at a time, which cannot mistake a value for -o here.
cat > "$BIN/curl" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$MOCK_CALLS/curl"
out=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o|--output) out="${2-}"; shift 2 ;;
    *) shift ;;
  esac
done
if [ "${MOCK_CURL_RC:-0}" != 0 ]; then
  echo "mock curl: (22) The requested URL returned error: 404" >&2
  exit "$MOCK_CURL_RC"
fi
cp "$MOCK_BODY" "$out"
MOCK
chmod +x "$BIN/gh" "$BIN/jq" "$BIN/curl"

FIX="$TMP/fixtures"; mkdir -p "$FIX"
printf '{"jobs":[{"id":%s,"name":"build-attempt-1","status":"completed"}]}\n' "$JOB_ID" > "$FIX/jobs.json"
# A real build log: short, and coloured — every compiler line carries terminal
# escape sequences, which is what the old downloader refused to emit.
printf '\033[31merror:\033[0m ANSI-MARKER boom\n' > "$FIX/short-ansi.log"
: > "$FIX/empty.log"

# Throwaway checkout: collect asserts HEAD is the sha the failed attempt built.
REPO_DIR="$TMP/checkout"; mkdir -p "$REPO_DIR"
git -C "$REPO_DIR" init -q -b main
git -C "$REPO_DIR" -c user.email=t@t -c user.name=t commit -q --allow-empty -m base
HEAD_SHA="$(git -C "$REPO_DIR" rev-parse HEAD)"

OUT=""; RC=0; STATE=""; CALLS=""
reset_mocks() {
  MOCK_JOB_ID="$JOB_ID"
  MOCK_BODY="$FIX/short-ansi.log"
  MOCK_CURL_RC=0
}

# run_collect <case> <expected-sha>; mock behaviour comes from reset_mocks plus
# whatever the caller overrode.
run_collect() {
  local runner="$TMP/runner/$1"
  CALLS="$TMP/calls/$1"
  STATE="$runner/build-repair"
  mkdir -p "$runner" "$CALLS"
  OUT="$(cd "$REPO_DIR" && PATH="$BIN:$PATH" \
    RUNNER_TEMP="$runner" MOCK_CALLS="$CALLS" MOCK_JOBS_JSON="$FIX/jobs.json" \
    MOCK_JOB_ID="$MOCK_JOB_ID" MOCK_JOB_NAME="build-attempt-1" \
    MOCK_JOB_STEPS="Package installer" \
    MOCK_BODY="$MOCK_BODY" MOCK_CURL_RC="$MOCK_CURL_RC" \
    REPO="khairm/superset-windows-arm64" RUN_ID=90001 GH_TOKEN="$TOKEN_SENTINEL" \
    REPAIR_BRANCH="nightly-candidate" EXPECTED_SHA="$2" \
    bash "$SUBJECT" collect 2>&1)"
  RC=$?
  echo "$1 (rc $RC)"
}

echo "== a short, escape-carrying log survives, fetched over authenticated https =="
reset_mocks
run_collect short-ansi "$HEAD_SHA"
zero  "collect succeeds" "$RC"
CURL_ARGV="$(cat "$CALLS/curl" 2>/dev/null || true)"
COLLECTED="$(cat "$STATE/build-failure.log" 2>/dev/null || true)"
has   "the agent's log keeps the coloured error line" "$COLLECTED" "ANSI-MARKER"
hasnt "no gh capability probe" "$(cat "$CALLS/gh" 2>/dev/null || true)" "--help"
has   "log is fetched over https" "$CURL_ARGV" "https://"
has   "from the failed job's log route" "$CURL_ARGV" "/actions/jobs/$JOB_ID/logs"
has   "authenticated" "$CURL_ARGV" "$TOKEN_SENTINEL"
has   "http errors fail the transfer" "$CURL_ARGV" "--fail"
has   "redirects are followed" "$CURL_ARGV" "--location"
has   "the request is https-only" "$CURL_ARGV" "--proto =https"
has   "and stays https-only across the redirect" "$CURL_ARGV" "--proto-redir =https"
hasnt "credentials are not carried across hosts" "$CURL_ARGV" "--location-trusted"
hasnt "tls verification stays on" "$CURL_ARGV" "--insecure"
none  "no token in any file handed onward" "$(grep -rlF "$TOKEN_SENTINEL" "$STATE" 2>/dev/null || true)"

echo "== a failed transfer is not a successful collect =="
reset_mocks; MOCK_CURL_RC=22
run_collect curl-error "$HEAD_SHA"
nonz  "collect fails" "$RC"
has   "loudly" "$OUT" "::error::"

echo "== an empty log is not a successful collect =="
reset_mocks; MOCK_BODY="$FIX/empty.log"
run_collect empty-log "$HEAD_SHA"
nonz  "collect fails" "$RC"
has   "loudly" "$OUT" "::error::"

echo "== no failed job found: fail before pretending to have a log =="
reset_mocks; MOCK_JOB_ID=""
run_collect no-job "$HEAD_SHA"
nonz  "collect fails" "$RC"
has   "loudly" "$OUT" "::error::"
absent "nothing was downloaded" "$CALLS/curl"

echo "== branch moved under the repair: refuse before touching the api =="
reset_mocks
run_collect sha-mismatch "0000000000000000000000000000000000000000"
nonz  "collect fails" "$RC"
has   "loudly" "$OUT" "::error::"
absent "the run's jobs were never queried" "$CALLS/gh"
absent "nothing was downloaded" "$CALLS/curl"

echo ""
echo "passed $PASS, failed $FAIL"
[ "$FAIL" -eq 0 ]
