#!/usr/bin/env bash
# MANUAL regression test for scripts/bun-locked-versions.sh, the store mapping,
# required-ABI check, lock-pinned companion versions and safe swaps in
# scripts/materialize-native-closure.sh, and the PE-header checks both that
# script and scripts/verify-packaged-natives.sh gate every native on.
#
#   bash scripts/bun-locked-versions.test.sh
#
# Deliberately NOT wired into the build or CI: it proves the parsing and the
# directory selection, which is where the "highest version in node_modules/.bun"
# bug lived, and proves nothing about a real install. `bun`, `curl` and `cp` are
# mocked on PATH and every fixture lives under a temp dir — the real
# node_modules/.bun is never read or written (asserted at the end).
set -uo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REAL_STORE="$(cd "$SRC/.." && pwd)/node_modules/.bun"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAIL=0
ok()  { PASS=$((PASS + 1)); echo "  ok    $1"; }
no()  { FAIL=$((FAIL + 1)); echo "  FAIL  $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1"; else no "$1 — expected [$3], got [$2]"; fi; }
has() { if printf '%s' "$2" | grep -qF -- "$3"; then ok "$1"; else no "$1 — [$3] not in output"; fi; }

BIN="$TMP/bin"; mkdir -p "$BIN"
ASSETS="$TMP/assets"; mkdir -p "$ASSETS"

cat > "$BIN/bun" <<'MOCK'
#!/usr/bin/env bash
# mock `bun why <pkg>`: stdout from $MOCK_WHY_DIR/<key>.out, rc from <key>.rc,
# Bun's real absence line (on stdout, rc 1) when no fixture exists.
echo "$*" >> "$MOCK_WHY_DIR/.calls"
[ "${1:-}" = why ] || { echo "mock bun: unexpected argv: $*" >&2; exit 99; }
key="$(printf '%s' "${2:-}" | tr / +)"
if [ ! -f "$MOCK_WHY_DIR/$key.out" ]; then
  echo "error: No packages matching '${2:-}' found in lockfile"
  exit 1
fi
cat "$MOCK_WHY_DIR/$key.out"
exit "$(cat "$MOCK_WHY_DIR/$key.rc" 2>/dev/null || echo 0)"
MOCK

cat > "$BIN/curl" <<'MOCK'
#!/usr/bin/env bash
# mock curl -fsSL <url> [-o file]: serves tarball fixtures, injects failure for
# any url containing $MOCK_CURL_FAIL.
url=""; outfile=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) outfile="${2:-}"; shift 2 ;;
    -*) shift ;;
    *)  url="$1"; shift ;;
  esac
done
if [ -n "${MOCK_CURL_FAIL:-}" ]; then
  case "$url" in *"$MOCK_CURL_FAIL"*) echo "mock curl: refusing $url" >&2; exit 22 ;; esac
fi
case "$url" in
  *registry.npmjs.org*)               src="$MOCK_ASSETS/pkg.tgz" ;;
  *WiseLibs/better-sqlite3/releases*) src="$MOCK_ASSETS/${MOCK_PREBUILT:-prebuilt-arm64.tgz}" ;;
  *) echo "mock curl: unexpected url $url" >&2; exit 1 ;;
esac
[ -f "$src" ] || { echo "mock curl: missing fixture $src" >&2; exit 1; }
if [ -n "$outfile" ]; then cp "$src" "$outfile"; else cat "$src"; fi
MOCK
REAL_CP="$(command -v cp)"
cat > "$BIN/cp" <<MOCK
#!/usr/bin/env bash
# mock cp: fails when \$MOCK_CP_FAIL appears in its argv (kills one copy
# mid-swap), otherwise defers to the real cp.
if [ -n "\${MOCK_CP_FAIL:-}" ]; then
  case "\$*" in *"\$MOCK_CP_FAIL"*) echo "mock cp: refusing \$*" >&2; exit 1 ;; esac
fi
exec "$REAL_CP" "\$@"
MOCK
REAL_MV="$(command -v mv)"
cat > "$BIN/mv" <<MOCK
#!/usr/bin/env bash
# mock mv: with \$MOCK_MV_FAIL set, the FIRST mv whose argv contains it is let
# through and every later one fails. That drives a swap past "move the old copy
# aside" and into a rollback that cannot put it back — the one path that leaves
# a rescued copy on disk, whose location this test pins down.
if [ -n "\${MOCK_MV_FAIL:-}" ]; then
  case "\$*" in
    *"\$MOCK_MV_FAIL"*)
      if [ -e "\${MOCK_MV_STATE:-}" ]; then echo "mock mv: refusing \$*" >&2; exit 1; fi
      : > "\${MOCK_MV_STATE:?mock mv needs MOCK_MV_STATE}" ;;
  esac
fi
exec "$REAL_MV" "\$@"
MOCK
chmod +x "$BIN/bun" "$BIN/curl" "$BIN/cp" "$BIN/mv"

# A PE file whose machine field is where pearch() reads it: "MZ" at 0, e_lfanew
# at offset 60 points at "PE\0\0", the 2 machine bytes follow. 0xAA64 (ARM64) is
# stored little-endian, which is why od prints it as 64aa.
mkpe() {
  { printf 'MZ'; printf '\000%.0s' $(seq 58)
    printf '\100\000\000\000PE\000\000'
    case "$2" in arm64) printf '\144\252' ;; x64) printf '\144\206' ;; esac
  } > "$1"
}
# The decoy every pearch() check exists for: NOT a PE image (no MZ, no PE\0\0)
# but carrying 64aa at the exact offset a naive two-byte read looks at. Anything
# that waves this through would ship an arbitrary file as an ARM64 native.
mkdecoy() {
  { printf '\000%.0s' $(seq 60)
    printf '\100\000\000\000XX\000\000\144\252'
  } > "$1"
}
mkdir -p "$TMP/src/package" "$TMP/src/arm/build/Release" "$TMP/src/x64/build/Release" "$TMP/src/decoy/build/Release"
printf '{"name":"materialized","version":"0.0.0"}\n' > "$TMP/src/package/package.json"
tar -czf "$ASSETS/pkg.tgz" -C "$TMP/src" package
mkpe "$TMP/src/arm/build/Release/better_sqlite3.node" arm64
mkpe "$TMP/src/x64/build/Release/better_sqlite3.node" x64
mkdecoy "$TMP/src/decoy/build/Release/better_sqlite3.node"
tar -czf "$ASSETS/prebuilt-arm64.tgz" -C "$TMP/src/arm" build
tar -czf "$ASSETS/prebuilt-x64.tgz" -C "$TMP/src/x64" build
tar -czf "$ASSETS/prebuilt-decoy.tgz" -C "$TMP/src/decoy" build
mkdir -p "$TMP/libsql" "$TMP/tok"
# The prebuild directories fetch-native-prebuilds.sh would have downloaded, with
# the manifests the real companion artifacts carry: name, version and a main
# naming the .node the app loads. materialize checks the CONTENTS against this
# directory and the VERSION against bun.lock, so neither a destination nor a
# Release tag can vouch for itself.
LSQ_PKG='{"name":"@libsql/win32-arm64-msvc","version":"0.5.22","main":"index.node"}'
TOK_PKG='{"name":"@anush008/tokenizers-win32-arm64-msvc","version":"0.0.0","main":"tokenizers.win32-arm64-msvc.node"}'
mkpe "$TMP/libsql/index.node" arm64
printf '%s\n' "$LSQ_PKG" > "$TMP/libsql/package.json"
mkpe "$TMP/tok/tokenizers.win32-arm64-msvc.node" arm64
printf '%s\n' "$TOK_PKG" > "$TMP/tok/package.json"
# Unusable companion sources: wrong arch, a decoy that is not a PE image at all,
# no package.json, and manifests that name another version or another file.
mkdir -p "$TMP/libsql-x64" "$TMP/libsql-decoy" "$TMP/libsql-nopkg" "$TMP/libsql-noversion" "$TMP/libsql-wrongver" \
         "$TMP/tok-x64" "$TMP/tok-decoy" "$TMP/tok-nopkg" "$TMP/tok-badmain" "$TMP/tok-wrongver"
mkpe "$TMP/libsql-x64/index.node" x64
printf '%s\n' "$LSQ_PKG" > "$TMP/libsql-x64/package.json"
mkdecoy "$TMP/libsql-decoy/index.node"
printf '%s\n' "$LSQ_PKG" > "$TMP/libsql-decoy/package.json"
mkpe "$TMP/libsql-nopkg/index.node" arm64
mkpe "$TMP/libsql-noversion/index.node" arm64
printf '{"name":"@libsql/win32-arm64-msvc","main":"index.node"}\n' > "$TMP/libsql-noversion/package.json"
mkpe "$TMP/libsql-wrongver/index.node" arm64
printf '{"name":"@libsql/win32-arm64-msvc","version":"0.5.21","main":"index.node"}\n' > "$TMP/libsql-wrongver/package.json"
mkpe "$TMP/tok-x64/tokenizers.win32-arm64-msvc.node" x64
printf '%s\n' "$TOK_PKG" > "$TMP/tok-x64/package.json"
mkdecoy "$TMP/tok-decoy/tokenizers.win32-arm64-msvc.node"
printf '%s\n' "$TOK_PKG" > "$TMP/tok-decoy/package.json"
mkpe "$TMP/tok-nopkg/tokenizers.win32-arm64-msvc.node" arm64
mkpe "$TMP/tok-badmain/tokenizers.win32-arm64-msvc.node" arm64
printf '{"name":"@anush008/tokenizers-win32-arm64-msvc","version":"0.0.0","main":"index.js"}\n' > "$TMP/tok-badmain/package.json"
mkpe "$TMP/tok-wrongver/tokenizers.win32-arm64-msvc.node" arm64
printf '{"name":"@anush008/tokenizers-win32-arm64-msvc","version":"0.0.1","main":"tokenizers.win32-arm64-msvc.node"}\n' > "$TMP/tok-wrongver/package.json"
# Machine field of a PE built by mkpe: e_lfanew is 64, so the 2 arch bytes sit
# at 68. 64aa = ARM64.
arch_of() { od -An -tx1 -j68 -N2 "$1" 2>/dev/null | tr -d ' '; }

echo "== helper parsing =="
WHY="$TMP/why"; mkdir -p "$WHY"; : > "$WHY/.calls"
export MOCK_WHY_DIR="$WHY" MOCK_ASSETS="$ASSETS"
PATH="$BIN:$PATH"
ROOT="$TMP"                                   # helper only needs a real dir
# shellcheck source=./bun-locked-versions.sh
. "$SRC/bun-locked-versions.sh"

why_fixture() { cat > "$WHY/$(printf '%s' "$1" | tr / +).out"; }
all() { rc=0; out="$(bun_locked_versions_all "$1" 2>/dev/null)" || rc=$?; }
one() { rc=0; out="$(bun_locked_version_one "$1" 2>/dev/null)" || rc=$?; }

why_fixture better-sqlite3 <<'EOF'
better-sqlite3@12.11.1
  ├─ @superset/desktop@workspace (requires 12.11.1)
  └─ mastracode@0.18.1 (requires ^12.0.0)
EOF
all better-sqlite3; eq "single stable version: rc" "$rc" 0
eq "single stable version: value" "$out" "12.11.1"
one better-sqlite3; eq "one-mode single version: rc" "$rc" 0
eq "one-mode single version: value" "$out" "12.11.1"

why_fixture esbuild <<'EOF'
esbuild@0.25.12
  └─ tsx@4.20.6 (requires ~0.25.0)

esbuild@0.18.20
  └─ @esbuild-kit/core-utils@3.3.2 (requires ~0.18.20)

esbuild@0.28.2
  └─ fumadocs-mdx@15.2.0 (requires ^0.28.1)
EOF
all esbuild; eq "several versions: rc" "$rc" 0
eq "several versions: all reported" "$(printf '%s' "$out" | tr '\n' ' ')" "0.25.12 0.18.20 0.28.2"
one esbuild; eq "one-mode rejects ambiguity" "$rc" 2

why_fixture pre-release-pkg <<'EOF'
pre-release-pkg@1.2.3-beta.1
  └─ someone@1.0.0 (requires ^1.2.3-beta.1)
EOF
all pre-release-pkg; eq "prerelease: rc" "$rc" 0
eq "prerelease: value" "$out" "1.2.3-beta.1"

all node-pty; eq "not in lockfile: all-mode rc 1 (skippable)" "$rc" 1
eq "not in lockfile: no version printed" "$out" ""
one node-pty; eq "not in lockfile: one-mode rc 1" "$rc" 1

why_fixture drifted <<'EOF'
drifted 0.5.22
  └─ someone@1.0.0 (requires 0.5.22)
EOF
all drifted; eq "output drift at column 0: rc 2" "$rc" 2

why_fixture partial-semver <<'EOF'
partial-semver@12.11
EOF
all partial-semver; eq "not strict semver: rc 2" "$rc" 2

why_fixture build-meta <<'EOF'
build-meta@1.2.3+0123456789abcdef
EOF
all build-meta; eq "build metadata is ambiguous with the store suffix: rc 2" "$rc" 2

why_fixture twice <<'EOF'
twice@1.0.0
  └─ a@1.0.0 (requires 1.0.0)

twice@1.0.0
  └─ b@1.0.0 (requires 1.0.0)
EOF
all twice; eq "same version twice: rc 2" "$rc" 2

: > "$WHY/empty.out"
all empty; eq "success with no version header: rc 2" "$rc" 2

printf 'error: lockfile is corrupt\n' > "$WHY/broken.out"
printf '1\n' > "$WHY/broken.rc"
all broken; eq "bun failed for another reason: rc 2" "$rc" 2

CALLS_BEFORE="$(wc -l < "$WHY/.calls")"
all "../evil"; eq "invalid package name: rc 2" "$rc" 2
eq "invalid package name never reaches bun" "$(wc -l < "$WHY/.calls")" "$CALLS_BEFORE"

SAVED_ROOT="$ROOT"; unset ROOT
all better-sqlite3; eq "ROOT unset: rc 2" "$rc" 2
ROOT="$SAVED_ROOT"

echo "== store mapping and safe swap =="
FIX="$TMP/fixture"
BWHY="$TMP/why-mat"

mkentry() { # <store dir> <payload pkg> [marker]  — no marker: payload missing
  mkdir -p "$FIX/node_modules/.bun/$1/node_modules"
  if [ -n "${3:-}" ]; then
    mkdir -p "$FIX/node_modules/.bun/$1/node_modules/$2"
    printf '{"name":"%s","marker":"%s"}\n' "$2" "$3" > "$FIX/node_modules/.bun/$1/node_modules/$2/package.json"
  fi
}
marker() { # <store dir> <payload pkg> -> marker value, "" when absent/replaced
  local f="$FIX/node_modules/.bun/$1/node_modules/$2/package.json"
  [ -f "$f" ] || return 0
  sed -n 's/.*"marker":"\([^"]*\)".*/\1/p' "$f"
}
build_fixture() { # $1 = marker for the live better-sqlite3 payload ("" = missing)
  rm -rf "$FIX" "$BWHY"; mkdir -p "$FIX/scripts" "$FIX/apps/desktop/node_modules" "$FIX/tmp" "$BWHY"
  : > "$BWHY/.calls"
  rm -f "$TMP/mv.state"
  cp "$SRC/materialize-native-closure.sh" "$SRC/bun-locked-versions.sh" "$FIX/scripts/"
  printf '{"name":"fixture","trustedDependencies":["better-sqlite3","esbuild","node-pty"]}\n' > "$FIX/package.json"
  # Live version 12.11.1 exists ONLY as bun's dedupe variant. 12.6.2 is a stale
  # cache entry, 12.11.10 is the prefix-collision decoy a `12.11.1*` glob would
  # eat, esbuild@0.28.3 is a higher version nothing resolves to.
  mkentry "better-sqlite3@12.11.1+0123456789abcdef" better-sqlite3 "${1:-}"
  mkentry "better-sqlite3@12.6.2"  better-sqlite3 stale
  mkentry "better-sqlite3@12.11.10" better-sqlite3 decoy
  mkentry "esbuild@0.25.12" esbuild ok-already
  mkentry "esbuild@0.28.2"  esbuild
  mkentry "esbuild@0.28.3"  esbuild cache-only
  printf 'better-sqlite3@12.11.1\n  └─ fixture@workspace (requires 12.11.1)\n' > "$BWHY/better-sqlite3.out"
  printf 'esbuild@0.25.12\n\nesbuild@0.28.2\n' > "$BWHY/esbuild.out"
  # The versions bun.lock owns for the two companion prebuilds. LSQ_PKG/TOK_PKG
  # carry exactly these, so the happy path agrees and a payload from another
  # Release does not.
  printf 'libsql@0.5.22\n  └─ fixture@workspace (requires 0.5.22)\n' > "$BWHY/libsql.out"
  printf '@anush008/tokenizers@0.0.0\n  └─ fastembed@2.1.0 (requires ^0.0.0)\n' > "$BWHY/@anush008+tokenizers.out"
}
run_mat() { # stdout+stderr -> $LOG, rc -> $rc
  # MAT_ABI overrides the Electron ABI and MAT_NO_ABI=1 runs with none;
  # MAT_LIBSQL / MAT_TOK swap in a different companion prebuild dir.
  local abi=(ELECTRON_ABI="${MAT_ABI:-145}")
  [ -z "${MAT_NO_ABI:-}" ] || abi=()
  LOG="$TMP/mat.log"
  ( cd "$FIX" && PATH="$BIN:$PATH" MOCK_WHY_DIR="$BWHY" MOCK_ASSETS="$ASSETS" \
      env -u ELECTRON_ABI "${abi[@]}" \
      MOCK_MV_STATE="$TMP/mv.state" \
      LIBSQL_ARM64_DIR="${MAT_LIBSQL:-$TMP/libsql}" \
      TOKENIZERS_ARM64_DIR="${MAT_TOK:-$TMP/tok}" \
      bash "$FIX/scripts/materialize-native-closure.sh" ) > "$LOG" 2>&1
  rc=$?
}

APPNM="apps/desktop/node_modules"
LSQ_REL="$APPNM/@libsql/win32-arm64-msvc"
TOK_REL="$APPNM/@anush008/tokenizers-win32-arm64-msvc"
seed_app_natives() { # pre-existing but UNUSABLE (x64) app-level copies, marked
  mkdir -p "$FIX/$LSQ_REL" "$FIX/$TOK_REL"
  mkpe "$FIX/$LSQ_REL/index.node" x64
  printf 'previous\n' > "$FIX/$LSQ_REL/MARKER"
  mkpe "$FIX/$TOK_REL/tokenizers.win32-arm64-msvc.node" x64
  printf 'previous\n' > "$FIX/$TOK_REL/MARKER"
}
seed_app_current() { # app-level copies that hold EXACTLY what the prebuilds hold
  seed_app_natives
  mkpe "$FIX/$LSQ_REL/index.node" arm64
  printf '%s\n' "$LSQ_PKG" > "$FIX/$LSQ_REL/package.json"
  mkpe "$FIX/$TOK_REL/tokenizers.win32-arm64-msvc.node" arm64
  printf '%s\n' "$TOK_PKG" > "$FIX/$TOK_REL/package.json"
}
app_marker() { cat "$FIX/$1/MARKER" 2>/dev/null; }  # "" once replaced
app_field() { sed -n "s/.*\"$2\":\"\([^\"]*\)\".*/\1/p" "$FIX/$1/package.json" 2>/dev/null; }
app_leftovers() { # staging dirs AND moved-aside copies, at either scope depth
  # Nothing named either way may survive under apps/desktop/node_modules: that
  # whole tree is copied into the installer, so a leftover here ships.
  find "$FIX/$APPNM" -maxdepth 3 \( -name '.mat-stage-*' -o -name '*.old' \) 2>/dev/null | wc -l | tr -d ' '
}
tmp_rescued() { # copies a failed swap parked in the repo's tmp/, which ships nothing
  find "$FIX/tmp" -maxdepth 1 -name '.mat-stage-*.old' 2>/dev/null | wc -l | tr -d ' '
}

STORE_BEFORE="$(ls "$REAL_STORE" 2>/dev/null | wc -l)"

build_fixture ""
run_mat
LOGTXT="$(cat "$LOG")"
eq "happy path: rc" "$rc" 0
eq "lock-resolved dedupe entry populated" \
  "$(marker "better-sqlite3@12.11.1+0123456789abcdef" better-sqlite3)" ""
if [ -f "$FIX/node_modules/.bun/better-sqlite3@12.11.1+0123456789abcdef/node_modules/better-sqlite3/package.json" ]; then
  ok "lock-resolved dedupe entry has a payload"
else
  no "lock-resolved dedupe entry has a payload"
fi
eq "ARM64 prebuilt landed in the payload" \
  "$(od -An -tx1 -j68 -N2 "$FIX/node_modules/.bun/better-sqlite3@12.11.1+0123456789abcdef/node_modules/better-sqlite3/build/Release/better_sqlite3.node" 2>/dev/null | tr -d ' ')" "64aa"
eq "stale 12.6.2 untouched"  "$(marker better-sqlite3@12.6.2 better-sqlite3)"  "stale"
eq "12.11.10 decoy untouched" "$(marker better-sqlite3@12.11.10 better-sqlite3)" "decoy"
eq "higher unrelated esbuild cache untouched" "$(marker esbuild@0.28.3 esbuild)" "cache-only"
eq "already-valid esbuild payload untouched" "$(marker esbuild@0.25.12 esbuild)" "ok-already"
has "already-valid payload is skipped, not refetched" "$LOGTXT" "esbuild@0.25.12 payload OK"
eq "second locked esbuild version populated" \
  "$(marker esbuild@0.28.2 esbuild)" ""
if [ -f "$FIX/node_modules/.bun/esbuild@0.28.2/node_modules/esbuild/package.json" ]; then
  ok "second locked esbuild version has a payload"
else
  no "second locked esbuild version has a payload"
fi
has "aliased/absent dep is skipped loudly" "$LOGTXT" "node-pty: not in bun.lock (skip"
# Depth 4: an unscoped payload stages at `<key@ver>/node_modules/.mat-stage-*`,
# a scoped one at `<key@ver>/node_modules/@scope/.mat-stage-*`.
eq "no staging dirs left behind" \
  "$(find "$FIX/node_modules/.bun" -maxdepth 4 -name '.mat-stage-*' | wc -l | tr -d ' ')" "0"
eq "every mutation stayed under the fixture store" \
  "$(printf '%s\n' "$LOGTXT" | grep -c 'payload at ' || true)" \
  "$(printf '%s\n' "$LOGTXT" | grep -c "payload at $FIX/node_modules/.bun/" || true)"
eq "app-level libsql copy installed (ARM64)" "$(arch_of "$FIX/$LSQ_REL/index.node")" "64aa"
eq "app-level tokenizers copy installed (ARM64)" \
  "$(arch_of "$FIX/$TOK_REL/tokenizers.win32-arm64-msvc.node")" "64aa"
if [ -f "$FIX/$LSQ_REL/package.json" ] && [ -f "$FIX/$TOK_REL/package.json" ]; then
  ok "app-level copies carry their package.json"
else
  no "app-level copies carry their package.json"
fi
eq "no app-level staging dirs left behind" "$(app_leftovers)" "0"

build_fixture ""
printf 'better-sqlite3@12.11.1\n\nbetter-sqlite3@12.6.2\n' > "$BWHY/better-sqlite3.out"
run_mat
if [ "$rc" -ne 0 ]; then ok "two live better-sqlite3 versions: fatal"; else no "two live better-sqlite3 versions: fatal"; fi
has "two live better-sqlite3 versions: says why" "$(cat "$LOG")" "one Electron ABI prebuilt cannot cover"

build_fixture ""
printf 'better-sqlite3@13.0.0\n' > "$BWHY/better-sqlite3.out"
run_mat
if [ "$rc" -ne 0 ]; then ok "locked version with no store dir: fatal"; else no "locked version with no store dir: fatal"; fi
has "locked version with no store dir: says why" "$(cat "$LOG")" "holds no directory for it"

build_fixture previous
MOCK_CURL_FAIL=registry.npmjs.org run_mat
if [ "$rc" -ne 0 ]; then ok "failed download: fatal"; else no "failed download: fatal"; fi
eq "failed download keeps the old payload" \
  "$(marker "better-sqlite3@12.11.1+0123456789abcdef" better-sqlite3)" "previous"
eq "failed download leaves no staging dir" \
  "$(find "$FIX/node_modules/.bun" -maxdepth 4 -name '.mat-stage-*' | wc -l | tr -d ' ')" "0"

build_fixture previous
MOCK_PREBUILT=prebuilt-x64.tgz run_mat
if [ "$rc" -ne 0 ]; then ok "non-ARM64 prebuilt: fatal"; else no "non-ARM64 prebuilt: fatal"; fi
eq "non-ARM64 prebuilt keeps the old payload" \
  "$(marker "better-sqlite3@12.11.1+0123456789abcdef" better-sqlite3)" "previous"
eq "non-ARM64 prebuilt leaves no staging dir" \
  "$(find "$FIX/node_modules/.bun" -maxdepth 4 -name '.mat-stage-*' | wc -l | tr -d ' ')" "0"

build_fixture previous
MOCK_PREBUILT=prebuilt-decoy.tgz run_mat
if [ "$rc" -ne 0 ]; then ok "decoy prebuilt (arch bytes, no PE header): fatal"; else no "decoy prebuilt (arch bytes, no PE header): fatal"; fi
eq "decoy prebuilt keeps the old payload" \
  "$(marker "better-sqlite3@12.11.1+0123456789abcdef" better-sqlite3)" "previous"
eq "decoy prebuilt leaves no staging dir" \
  "$(find "$FIX/node_modules/.bun" -maxdepth 4 -name '.mat-stage-*' | wc -l | tr -d ' ')" "0"

echo "== the Electron ABI is required, before anything is touched =="
build_fixture previous
MAT_NO_ABI=1 run_mat
if [ "$rc" -ne 0 ]; then ok "unset ELECTRON_ABI: fatal"; else no "unset ELECTRON_ABI: fatal"; fi
has "unset ELECTRON_ABI: says why" "$(cat "$LOG")" "ELECTRON_ABI must be the Electron ABI number"
eq "unset ELECTRON_ABI keeps the old payload" \
  "$(marker "better-sqlite3@12.11.1+0123456789abcdef" better-sqlite3)" "previous"
eq "unset ELECTRON_ABI touches no app-level natives" \
  "$(find "$FIX/$APPNM" -mindepth 1 | wc -l | tr -d ' ')" "0"

build_fixture previous
MAT_ABI=v145 run_mat
if [ "$rc" -ne 0 ]; then ok "non-numeric ELECTRON_ABI: fatal"; else no "non-numeric ELECTRON_ABI: fatal"; fi
eq "non-numeric ELECTRON_ABI keeps the old payload" \
  "$(marker "better-sqlite3@12.11.1+0123456789abcdef" better-sqlite3)" "previous"

echo "== app-level libsql/tokenizers safe swap =="
build_fixture ""; seed_app_natives
MOCK_CP_FAIL=libsql run_mat
if [ "$rc" -ne 0 ]; then ok "libsql copy failure: fatal"; else no "libsql copy failure: fatal"; fi
eq "libsql copy failure keeps the old copy" "$(app_marker "$LSQ_REL")" "previous"
eq "libsql copy failure leaves no staging dir" "$(app_leftovers)" "0"

build_fixture ""; seed_app_natives
MAT_LIBSQL="$TMP/libsql-x64" run_mat
if [ "$rc" -ne 0 ]; then ok "non-ARM64 libsql source: fatal"; else no "non-ARM64 libsql source: fatal"; fi
eq "non-ARM64 libsql source keeps the old copy" "$(app_marker "$LSQ_REL")" "previous"
eq "non-ARM64 libsql source leaves no staging dir" "$(app_leftovers)" "0"

build_fixture ""; seed_app_natives
MAT_LIBSQL="$TMP/libsql-decoy" run_mat
if [ "$rc" -ne 0 ]; then ok "decoy libsql source: fatal"; else no "decoy libsql source: fatal"; fi
eq "decoy libsql source keeps the old copy" "$(app_marker "$LSQ_REL")" "previous"
eq "decoy libsql source leaves no staging dir" "$(app_leftovers)" "0"

build_fixture ""; seed_app_natives
MAT_LIBSQL="$TMP/libsql-nopkg" run_mat
if [ "$rc" -ne 0 ]; then ok "libsql source without package.json: fatal"; else no "libsql source without package.json: fatal"; fi
eq "libsql source without package.json keeps the old copy" "$(app_marker "$LSQ_REL")" "previous"

build_fixture ""; seed_app_natives
MOCK_CP_FAIL=tokenizers run_mat
if [ "$rc" -ne 0 ]; then ok "tokenizers copy failure: fatal"; else no "tokenizers copy failure: fatal"; fi
eq "tokenizers copy failure keeps the old copy" "$(app_marker "$TOK_REL")" "previous"
eq "tokenizers copy failure leaves no staging dir" "$(app_leftovers)" "0"

build_fixture ""; seed_app_natives
MAT_TOK="$TMP/tok-x64" run_mat
if [ "$rc" -ne 0 ]; then ok "non-ARM64 tokenizers source: fatal"; else no "non-ARM64 tokenizers source: fatal"; fi
eq "non-ARM64 tokenizers source keeps the old copy" "$(app_marker "$TOK_REL")" "previous"
eq "non-ARM64 tokenizers source leaves no staging dir" "$(app_leftovers)" "0"

build_fixture ""; seed_app_natives
MAT_TOK="$TMP/tok-decoy" run_mat
if [ "$rc" -ne 0 ]; then ok "decoy tokenizers source: fatal"; else no "decoy tokenizers source: fatal"; fi
eq "decoy tokenizers source keeps the old copy" "$(app_marker "$TOK_REL")" "previous"
eq "decoy tokenizers source leaves no staging dir" "$(app_leftovers)" "0"

build_fixture ""; seed_app_natives
run_mat
eq "successful swap over an unusable copy: rc" "$rc" 0
eq "libsql swapped to the ARM64 copy" "$(arch_of "$FIX/$LSQ_REL/index.node")" "64aa"
eq "libsql old content is gone" "$(app_marker "$LSQ_REL")" ""
eq "tokenizers swapped to the ARM64 copy" \
  "$(arch_of "$FIX/$TOK_REL/tokenizers.win32-arm64-msvc.node")" "64aa"
eq "tokenizers old content is gone" "$(app_marker "$TOK_REL")" ""
eq "successful swap leaves no staging dir" "$(app_leftovers)" "0"
eq "successful swap leaves no rescued copy in tmp" "$(tmp_rescued)" "0"

echo "== an installed copy is judged against the lock, never against itself =="
build_fixture ""; seed_app_current
run_mat
LOGTXT="$(cat "$LOG")"
eq "copies matching the prebuild: rc" "$rc" 0
eq "matching libsql copy is left alone" "$(app_marker "$LSQ_REL")" "previous"
has "matching libsql copy names the version it kept" "$LOGTXT" \
  "@libsql/win32-arm64-msvc already present (0.5.22)"
# Tokenizers gets no such shortcut: 0.0.0 is EVERY release's version, so a
# matching manifest answers nothing and the two-file payload is re-staged from
# the verified prebuild on every run.
eq "matching tokenizers copy is re-staged anyway" "$(app_marker "$TOK_REL")" ""
has "tokenizers re-stage names the prebuild it took" "$LOGTXT" \
  "@anush008/tokenizers-win32-arm64-msvc <- "

# The hole that closes: an ARM64 .node from an older companion build carries a
# manifest byte-for-byte identical to the current one, so name, version, main
# and ARM64-ness all pass while the binary itself is the wrong one.
build_fixture ""; seed_app_current
printf 'stale\n' >> "$FIX/$TOK_REL/tokenizers.win32-arm64-msvc.node"
run_mat
eq "same-version stale tokenizers binary: rc" "$rc" 0
if cmp -s "$FIX/$TOK_REL/tokenizers.win32-arm64-msvc.node" "$TMP/tok/tokenizers.win32-arm64-msvc.node"; then
  ok "same-version stale tokenizers binary is replaced by the prebuild's"
else
  no "same-version stale tokenizers binary is replaced by the prebuild's"
fi
eq "tokenizers re-stage leaves nothing in the packaged tree" "$(app_leftovers)" "0"
eq "tokenizers re-stage leaves no rescued copy in tmp" "$(tmp_rescued)" "0"
eq "the matching libsql copy beside it is still left alone" "$(app_marker "$LSQ_REL")" "previous"

# The hole this closes for libsql: an ARM64 index.node from an EARLIER companion
# release passes every "is it there and is it ARM64" test while being the wrong
# version, and ships a native the app links to at a version it never resolved.
build_fixture ""; seed_app_current
printf '{"name":"@libsql/win32-arm64-msvc","version":"0.4.0","main":"index.node"}\n' > "$FIX/$LSQ_REL/package.json"
run_mat
eq "stale libsql version: rc" "$rc" 0
eq "stale libsql copy is replaced" "$(app_marker "$LSQ_REL")" ""
eq "stale libsql copy now holds the locked version" "$(app_field "$LSQ_REL" version)" "0.5.22"
eq "stale replacement leaves nothing in the packaged tree" "$(app_leftovers)" "0"

build_fixture ""; seed_app_current
rm -f "$FIX/$LSQ_REL/package.json" "$FIX/$TOK_REL/package.json"
run_mat
eq "copies without a package.json: rc" "$rc" 0
eq "libsql copy without a package.json is replaced" "$(app_marker "$LSQ_REL")" ""
eq "libsql copy without a package.json gains the locked version" "$(app_field "$LSQ_REL" version)" "0.5.22"
eq "tokenizers copy without a package.json is replaced" "$(app_marker "$TOK_REL")" ""
eq "tokenizers copy without a package.json gains the prebuild's" "$(app_field "$TOK_REL" version)" "0.0.0"

build_fixture ""; seed_app_current
printf '{"name":"@libsql/darwin-arm64","version":"0.5.22","main":"index.node"}\n' > "$FIX/$LSQ_REL/package.json"
run_mat
eq "copy holding another package: rc" "$rc" 0
eq "copy holding another package is replaced" "$(app_marker "$LSQ_REL")" ""
eq "copy holding another package gains the right name" \
  "$(app_field "$LSQ_REL" name)" "@libsql/win32-arm64-msvc"

build_fixture ""; seed_app_current
mkpe "$FIX/$LSQ_REL/index.node" x64
mkpe "$FIX/$TOK_REL/tokenizers.win32-arm64-msvc.node" x64
run_mat
eq "matching manifest over an x64 binary: rc" "$rc" 0
eq "x64 libsql binary is replaced despite its matching manifest" "$(app_marker "$LSQ_REL")" ""
eq "libsql binary is ARM64 again" "$(arch_of "$FIX/$LSQ_REL/index.node")" "64aa"
eq "x64 tokenizers binary does not survive the re-stage" "$(app_marker "$TOK_REL")" ""
eq "tokenizers binary is ARM64 again" \
  "$(arch_of "$FIX/$TOK_REL/tokenizers.win32-arm64-msvc.node")" "64aa"

build_fixture ""; seed_app_current
rm -f "$FIX/$LSQ_REL/index.node" "$FIX/$TOK_REL/tokenizers.win32-arm64-msvc.node"
run_mat
eq "manifest with no binary beside it: rc" "$rc" 0
eq "libsql manifest with no binary is replaced" "$(app_marker "$LSQ_REL")" ""
eq "libsql binary is back" "$(arch_of "$FIX/$LSQ_REL/index.node")" "64aa"
eq "tokenizers manifest with no binary does not survive the re-stage" "$(app_marker "$TOK_REL")" ""
eq "tokenizers binary is back" \
  "$(arch_of "$FIX/$TOK_REL/tokenizers.win32-arm64-msvc.node")" "64aa"

echo "== a prebuild that cannot say what belongs there is fatal =="
build_fixture ""; seed_app_current
MAT_LIBSQL="$TMP/libsql-noversion" run_mat
if [ "$rc" -ne 0 ]; then ok "libsql prebuild with no version: fatal"; else no "libsql prebuild with no version: fatal"; fi
has "libsql prebuild with no version: says why" "$(cat "$LOG")" \
  "is version '<missing>', but bun.lock resolves 0.5.22"
eq "libsql prebuild with no version keeps the installed copy" "$(app_marker "$LSQ_REL")" "previous"

build_fixture ""; seed_app_current
MAT_TOK="$TMP/tok-nopkg" run_mat
if [ "$rc" -ne 0 ]; then ok "tokenizers prebuild with no package.json: fatal"; else no "tokenizers prebuild with no package.json: fatal"; fi
eq "tokenizers prebuild with no package.json keeps the installed copy" "$(app_marker "$TOK_REL")" "previous"

build_fixture ""; seed_app_current
MAT_TOK="$TMP/tok-badmain" run_mat
if [ "$rc" -ne 0 ]; then ok "tokenizers prebuild whose main is not the .node: fatal"; else no "tokenizers prebuild whose main is not the .node: fatal"; fi
has "tokenizers prebuild whose main is not the .node: says why" "$(cat "$LOG")" \
  "not the package the app loads"
eq "tokenizers prebuild whose main is not the .node keeps the installed copy" \
  "$(app_marker "$TOK_REL")" "previous"

# The Release is downloaded by the tag bun.lock named, and a tag is a label
# someone typed. A payload built against another version of the package the app
# imports is the failure this catches, and the checksum beside it cannot: it
# only proves the download matched what the Release actually holds.
echo "== a companion Release whose payload is another version is fatal =="
build_fixture ""; seed_app_current
MAT_LIBSQL="$TMP/libsql-wrongver" run_mat
if [ "$rc" -ne 0 ]; then ok "libsql payload from another Release: fatal"; else no "libsql payload from another Release: fatal"; fi
has "libsql payload from another Release: says why" "$(cat "$LOG")" \
  "is version '0.5.21', but bun.lock resolves 0.5.22"
eq "libsql payload from another Release keeps the installed copy" "$(app_marker "$LSQ_REL")" "previous"
eq "libsql payload from another Release mutates nothing in the packaged tree" "$(app_leftovers)" "0"

build_fixture ""; seed_app_current
MAT_TOK="$TMP/tok-wrongver" run_mat
if [ "$rc" -ne 0 ]; then ok "tokenizers payload from another Release: fatal"; else no "tokenizers payload from another Release: fatal"; fi
has "tokenizers payload from another Release: says why" "$(cat "$LOG")" \
  "is version '0.0.1', but bun.lock resolves 0.0.0"
eq "tokenizers payload from another Release keeps the installed copy" "$(app_marker "$TOK_REL")" "previous"
eq "tokenizers payload from another Release mutates nothing in the packaged tree" "$(app_leftovers)" "0"

build_fixture previous; seed_app_current
rm -f "$BWHY/libsql.out"
run_mat
if [ "$rc" -ne 0 ]; then ok "libsql absent from bun.lock: fatal"; else no "libsql absent from bun.lock: fatal"; fi
has "libsql absent from bun.lock: says why" "$(cat "$LOG")" \
  "cannot resolve libsql's locked version"
eq "libsql absent from bun.lock keeps the installed copies" \
  "$(app_marker "$LSQ_REL")$(app_marker "$TOK_REL")" "previousprevious"
# Both lock lookups sit beside the ABI check, ahead of the store payloads: a
# lockfile this build cannot read writes nothing at all, not even the payload
# repair that has nothing to do with the companion packages.
eq "libsql absent from bun.lock never reaches the store payloads" \
  "$(marker "better-sqlite3@12.11.1+0123456789abcdef" better-sqlite3)" "previous"

build_fixture previous; seed_app_current
rm -f "$BWHY/@anush008+tokenizers.out"
run_mat
if [ "$rc" -ne 0 ]; then ok "@anush008/tokenizers absent from bun.lock: fatal"; else no "@anush008/tokenizers absent from bun.lock: fatal"; fi
has "@anush008/tokenizers absent from bun.lock: says why" "$(cat "$LOG")" \
  "cannot resolve @anush008/tokenizers's locked version"
# Resolved up front together, so the libsql half does not get to succeed on a
# run the tokenizers half cannot finish.
eq "@anush008/tokenizers absent from bun.lock keeps the installed copies" \
  "$(app_marker "$LSQ_REL")$(app_marker "$TOK_REL")" "previousprevious"
eq "@anush008/tokenizers absent from bun.lock never reaches the store payloads" \
  "$(marker "better-sqlite3@12.11.1+0123456789abcdef" better-sqlite3)" "previous"

echo "== a failed rollback parks the rescued copy outside the packaged tree =="
build_fixture ""; seed_app_natives
MOCK_MV_FAIL=@libsql run_mat
if [ "$rc" -ne 0 ]; then ok "swap that cannot roll back: fatal"; else no "swap that cannot roll back: fatal"; fi
has "swap that cannot roll back: says the copy was rescued" "$(cat "$LOG")" "ROLLBACK FAILED"
eq "failed rollback leaves nothing under apps/desktop/node_modules" "$(app_leftovers)" "0"
eq "failed rollback parks the only remaining copy in tmp" "$(tmp_rescued)" "1"
eq "the copy parked in tmp is the one that was installed" \
  "$(cat "$(find "$FIX/tmp" -maxdepth 1 -name '.mat-stage-*.old')/MARKER" 2>/dev/null)" "previous"

# The last gate before publish reads the same PE header, on the packaged tree
# instead of the source. Run against a fabricated release/win-arm64-unpacked so
# the decoy cases are proved end to end and not by reading the two scripts side
# by side.
echo "== the packaged-closure gate reads a PE header, not two bytes at an offset =="
VERIFY="$TMP/verify"
VAPP="$VERIFY/release/win-arm64-unpacked"
VTOK="$VAPP/resources/node_modules/@anush008/tokenizers-win32-arm64-msvc/tokenizers.win32-arm64-msvc.node"
VPTY="$VAPP/resources/app.asar.unpacked/node_modules/@lydell/node-pty-win32-arm64"
build_verify_tree() { # the layout electron-builder.ts pins, every native ARM64
  rm -rf "$VERIFY"
  mkdir -p "$(dirname "$VTOK")" "$VPTY"
  mkpe "$VAPP/Superset.exe" arm64
  mkpe "$VTOK" arm64
  mkpe "$VPTY/conpty.node" arm64
  mkpe "$VPTY/conpty_console_list.node" arm64
}
run_verify() { # stdout+stderr -> $LOG, rc -> $rc
  LOG="$TMP/verify.log"
  ( cd "$VERIFY" && bash "$SRC/verify-packaged-natives.sh" ) > "$LOG" 2>&1
  rc=$?
}

build_verify_tree
run_verify
eq "an all-ARM64 packaged tree passes" "$rc" 0

build_verify_tree; mkdecoy "$VAPP/Superset.exe"
run_verify
if [ "$rc" -ne 0 ]; then ok "decoy Superset.exe: fatal"; else no "decoy Superset.exe: fatal"; fi

build_verify_tree; mkdecoy "$VTOK"
run_verify
if [ "$rc" -ne 0 ]; then ok "decoy tokenizers native: fatal"; else no "decoy tokenizers native: fatal"; fi

build_verify_tree; mkdecoy "$VPTY/conpty_console_list.node"
run_verify
if [ "$rc" -ne 0 ]; then ok "decoy conpty binary: fatal"; else no "decoy conpty binary: fatal"; fi

build_verify_tree; mkpe "$VPTY/conpty.node" x64
run_verify
if [ "$rc" -ne 0 ]; then ok "x64 conpty binary: fatal"; else no "x64 conpty binary: fatal"; fi

build_verify_tree; rm -f "$VTOK"
run_verify
if [ "$rc" -ne 0 ]; then ok "missing tokenizers native: fatal"; else no "missing tokenizers native: fatal"; fi

eq "the real node_modules/.bun was never written" \
  "$(ls "$REAL_STORE" 2>/dev/null | wc -l)" "$STORE_BEFORE"
eq "no staging dir in the real store" \
  "$(find "$REAL_STORE" -maxdepth 4 -name '.mat-stage-*' 2>/dev/null | wc -l | tr -d ' ')" "0"

echo
echo "passed $PASS, failed $FAIL"
[ "$FAIL" -eq 0 ]
