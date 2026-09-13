#!/usr/bin/env bash
# Isolated PATH mocks. Run with bash scripts/publish-arm64-release.test.sh.
set -euo pipefail
SRC=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd "$SRC/.." && pwd)
TMP=$(mktemp -d "${RUNNER_TEMP:?RUNNER_TEMP is required}/publish-arm64-test.XXXXXX")
trap 'rm -rf "$TMP"' EXIT
BIN="$TMP/bin"
REPO="$TMP/checkout"
mkdir -p "$BIN" "$REPO"
# Real git is used only to initialize and verify an explicitly separate checkout.
[ "$(cd "$REPO" && pwd)" != "$ROOT" ] || exit 90
git -C "$REPO" init -q
[ "$(cd "$(git -C "$REPO" rev-parse --show-toplevel)" && pwd)" = "$(cd "$REPO" && pwd)" ] || exit 90
mkdir -p "$REPO/apps/desktop/release"
printf '{"version":"1.28.0"}\n' > "$REPO/apps/desktop/package.json"
printf 'test installer\n' > "$REPO/apps/desktop/release/Superset-arm64.exe"
HASH=$(sha256sum "$REPO/apps/desktop/release/Superset-arm64.exe" | cut -d ' ' -f1)
SIZE=$(wc -c < "$REPO/apps/desktop/release/Superset-arm64.exe" | tr -d '[:space:]')
REAL_JQ=$(command -v jq)
SHA=544d7f2060616cac74f8d92935bf1c3f1d5d2024
jq -n --arg digest "sha256:$HASH" --argjson size "$SIZE" '[[{
  id: 100, tag_name: "desktop-v1.28.0", draft: false, prerelease: false,
  published_at: "2026-09-13T00:00:00Z", assets: [{
    name: "Superset-arm64.exe", size: $size, digest: $digest, state: "uploaded"
  }]
}]]' > "$TMP/complete.json"
printf '[[]]\n' > "$TMP/absent.json"
jq '.[0] |= (.[0] | .draft = true | .published_at = null | .assets = [] | [., (.id = 101)])' "$TMP/complete.json" > "$TMP/draft.json"
jq '.[0][0].assets[0].digest = "sha256:wrong"' "$TMP/complete.json" > "$TMP/mismatch.json"
jq '.[0][0].assets[0].state = "starter"' "$TMP/complete.json" > "$TMP/uploading.json"
jq '.[0][0].assets[0].digest = null' "$TMP/complete.json" > "$TMP/pending.json"

cat > "$BIN/gh" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf 'gh %s\n' "$*" >> "$MOCK/calls"
if [ "$1" = api ] && [ "$2" = --paginate ]; then
  reads=$(cat "$MOCK/reads"); echo "$((reads + 1))" > "$MOCK/reads"
  if [ "$reads" -eq 0 ]; then
    case "$SCENARIO" in
      unknown) echo 'HTTP 502: Bad Gateway' >&2; exit 1 ;;
      unclassified) echo 'unexpected read failure' >&2; exit 1 ;;
      injection) printf 'unexpected read failure\r\n ::error::injected\n' >&2; exit 1 ;;
    esac
  fi
  if [ "$SCENARIO" = pending ] && [ "$(cat "$MOCK/release")" = pending ]; then
    cat "$FIX/pending.json"
    echo complete > "$MOCK/release"
    exit 0
  fi
  if [ "$SCENARIO" = crlf ]; then
    sed 's/\r$//; s/$/\r/' "$FIX/$(cat "$MOCK/release").json"
  else cat "$FIX/$(cat "$MOCK/release").json"; fi
elif [ "$1" = api ] && [ "$2" = --method ] && [ "$3" = DELETE ]; then
  case "${4##*/}" in
    100) echo absent > "$MOCK/release" ;;
    101) echo 'HTTP 404: Not Found' >&2; exit 1 ;;
    *) exit 91 ;;
  esac
elif [ "$1" = release ] && [ "$2" = create ]; then
  [[ " $* " == *' --verify-tag '* ]] || exit 92
  creates=$(cat "$MOCK/creates"); echo "$((creates + 1))" > "$MOCK/creates"
  case "$SCENARIO" in
    windows|postdelete)
      if [ "$creates" -eq 0 ]; then
        if [ "$SCENARIO" = windows ]; then
          echo 'wsarecv: An existing connection was forcibly closed by the remote host.' >&2
        else echo 'unexpected create failure' >&2; fi
        exit 1
      fi
      echo complete > "$MOCK/release" ;;
    pending) echo pending > "$MOCK/release" ;;
    permanent) echo 'HTTP 403: Resource not accessible by integration' >&2; exit 1 ;;
    exhausted) echo 'HTTP 502: Bad Gateway' >&2; exit 1 ;;
    mismatch|uploading) echo "$SCENARIO" > "$MOCK/release" ;;
    *) echo complete > "$MOCK/release" ;;
  esac
  if [ "$SCENARIO" = upload502 ]; then echo 'HTTP 502: Bad Gateway' >&2; exit 1; fi
else
  echo "unexpected gh command: $*" >&2; exit 93
fi
MOCK
cat > "$BIN/git" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf 'git %s\n' "$*" >> "$MOCK/calls"
case "$1" in
  rev-parse) echo "$SHA" ;;
  ls-remote)
    tag=$(cat "$MOCK/tag")
    if [ -n "$tag" ]; then
      if [ "$SCENARIO" = annotated ]; then
        printf '%s\trefs/tags/desktop-v1.28.0\n' aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
        printf '%s\trefs/tags/desktop-v1.28.0^{}\n' "$tag"
      else printf '%s\trefs/tags/desktop-v1.28.0\n' "$tag"; fi
    fi ;;
  push)
    if [ "$2" = --delete ]; then
      if [ ! -s "$MOCK/tag" ]; then echo 'error: remote ref does not exist' >&2; exit 1; fi
      : > "$MOCK/tag"
    else echo "$SHA" > "$MOCK/tag"; fi ;;
  *) echo "unexpected git command: $*" >&2; exit 94 ;;
esac
MOCK
cat > "$BIN/sleep" <<'MOCK'
#!/usr/bin/env bash
printf 'sleep %s\n' "$*" >> "$MOCK/calls"
MOCK
cat > "$BIN/jq" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
if [ "$SCENARIO" = crlf ]; then
  # Emit CRLF even with binary output to exercise defensive ID normalization.
  "$REAL_JQ" "$@" | sed 's/\r$//; s/$/\r/'
else exec "$REAL_JQ" "$@"; fi
MOCK
chmod +x "$BIN/gh" "$BIN/git" "$BIN/sleep" "$BIN/jq"

PASS=0
FAIL=0
check() {
  if "$@"; then PASS=$((PASS + 1)); else
    FAIL=$((FAIL + 1)); printf 'FAIL [%s]: %s\n' "$SCENARIO" "$*"; cat "$MOCK/output"
  fi
}
run_case() {
  SCENARIO=$1
  MOCK="$TMP/$SCENARIO"
  mkdir -p "$MOCK"
  printf '%s\n' "${4:-absent}" > "$MOCK/release"
  : > "$MOCK/tag"; : > "$MOCK/calls"
  echo 0 > "$MOCK/reads"; echo 0 > "$MOCK/creates"
  case "$SCENARIO" in
    draft|complete|annotated) echo "$SHA" > "$MOCK/tag" ;;
    wrongsha) echo bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb > "$MOCK/tag" ;;
  esac
  rc=0
  (cd "$REPO" && PATH="$BIN:$PATH" PUBLISH=true GH_TOKEN=TOKEN_MUST_NOT_LEAK \
    GITHUB_REPOSITORY=test/fork RUNNER_TEMP="$MOCK" \
    MOCK="$MOCK" FIX="$TMP" SHA="$SHA" SCENARIO="$SCENARIO" REAL_JQ="$REAL_JQ" \
    bash "$SRC/publish-arm64-release.sh") > "$MOCK/output" 2>&1 || rc=$?
  check test "$rc" -eq "$2"
  check test "$(cat "$MOCK/creates")" -eq "$3"
  check test "$(grep -l TOKEN_MUST_NOT_LEAK "$MOCK/output" "$MOCK/calls" || true)" = ''
  if [ "$rc" -ne 0 ]; then check grep -q '::error::' "$MOCK/output"; fi
  echo "checked $SCENARIO"
}

run_case normal 0 1
run_case upload502 0 1
check test "$(grep -c '^sleep ' "$MOCK/calls" || true)" -eq 0
run_case draft 0 1 draft
check test "$(grep -c 'gh api --method DELETE' "$MOCK/calls")" -eq 2
run_case crlf 0 1 draft
check test "$(grep -c '^gh api --method DELETE repos/test/fork/releases/10[01]$' "$MOCK/calls")" -eq 2
check test "$(cat "$MOCK/reads")" -eq 3
run_case wrongsha 1 0 complete
check test "$(grep -c '^git push\|--method DELETE' "$MOCK/calls" || true)" -eq 0
run_case mismatch 1 1
run_case uploading 1 1
run_case permanent 1 1
check test "$(grep -c '^sleep ' "$MOCK/calls" || true)" -eq 0
run_case exhausted 1 3
check test "$(grep '^sleep ' "$MOCK/calls" | tr '\n' ' ')" = 'sleep 15 sleep 60 '
run_case unknown 0 1
check test "$(head -3 "$MOCK/calls" | grep -c '^gh api --paginate')" -eq 2
run_case unclassified 1 0
check test "$(grep -c '^sleep \|^git push\|--method DELETE' "$MOCK/calls" || true)" -eq 0
run_case complete 0 0 complete
check test "$(grep -c '^git push\|--method DELETE' "$MOCK/calls" || true)" -eq 0
run_case annotated 0 0 complete
run_case windows 0 2
check test "$(grep '^sleep ' "$MOCK/calls")" = 'sleep 15'
run_case postdelete 0 2 draft
check test "$(grep '^sleep ' "$MOCK/calls")" = 'sleep 15'
check test "$(grep -c 'gh api --method DELETE' "$MOCK/calls")" -eq 2
run_case injection 1 0
check test "$(grep -c '^[[:space:]]*::' "$MOCK/output" || true)" -eq 1
check grep -q '^::error::.*unexpected read failure   ::error::injected$' "$MOCK/output"
check test "$(tr -cd '\r' < "$MOCK/output")" = ''
run_case pending 0 1
check test "$(grep '^sleep ' "$MOCK/calls")" = 'sleep 10'
check test "$(grep -c 'gh api --method DELETE' "$MOCK/calls" || true)" -eq 0
printf 'passed %s, failed %s\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
