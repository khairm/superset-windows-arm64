#!/usr/bin/env bash
# Fetch the fork's companion win32-arm64 native prebuilds (libsql, tokenizers),
# derive the Electron ABI, and materialize the native closure. Run from repo
# root after `bun install`. Requires GH_TOKEN. Writes ELECTRON_ABI /
# LIBSQL_ARM64_DIR / TOKENIZERS_ARM64_DIR to GITHUB_ENV for later steps.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Every version below is the one bun.lock RESOLVES TO, bare semver, exactly one
# per package or the run stops. NOT the highest directory in node_modules/.bun:
# that store caches every version any past install needed, and a companion
# release tag or an Electron ABI taken from a version nothing resolves to
# fetches a native binary the app cannot load — green build, crash on the
# user's machine. Contract: scripts/bun-locked-versions.sh (fatal, never a
# fallback, on a second live version).
#
# libsql and @anush008/tokenizers are the two the fork downloads a companion
# prebuild for, and upstream is free to stop depending on either. Those two use
# bun_locked_version_optional, which skips a package only once bun.lock itself
# confirms it is gone; a skip exports an EMPTY *_ARM64_DIR (never a stale path).
# materialize-native-closure.sh deletes both packages' injected copies off its
# own proof rather than off that value. The empty value is read by the two steps
# that cannot re-derive it: packaging (electron-builder.ts) and the packaged-
# closure gate (verify-packaged-natives.sh), and only @anush008/tokenizers is
# named in either — libsql is not an extraResource and has no packaged path of
# its own to assert. electron is not optional: it is what gets packaged.
# shellcheck source=./bun-locked-versions.sh
. "$ROOT/scripts/bun-locked-versions.sh"

# Both prebuilds are fetched the same way — resolve the locked version, skip on a
# PROVEN absence, else download that exact Release, check its sha256 and unpack
# it — so it is written once and called twice. Sets COMPANION_DIR to the unpacked
# dir, or to the EMPTY string on a proven absence. Every failure exits (never
# returns): none of them has a safe fallback.
COMPANION_DIR=""
fetch_companion() { # $1 pkg  $2 platform pkg  $3 repo  $4 dispatch input  $5 slug  $6 member file  $7.. consumers
  local pkg="$1" plat="$2" repo="$3" input="$4" slug="$5" member="$6" ver="" rc=0
  shift 6

  ver="$(bun_locked_version_optional "$pkg" "$@")" || rc=$?
  [ "$rc" -le 1 ] || exit 1
  rm -rf "$slug-dl" "$slug-arm64"
  if [ "$rc" -eq 1 ]; then
    COMPANION_DIR=""
    echo "$pkg is in neither the graph nor bun.lock — nothing links $plat; skipping its prebuild"
    return 0
  fi

  COMPANION_DIR="$PWD/$slug-arm64"
  echo "Resolved $pkg: $ver"
  if ! gh release download "$ver" --repo "$repo" \
         -p "$slug-win32-arm64-msvc.tar.gz" -p "$slug-win32-arm64-msvc.tar.gz.sha256" -D "$slug-dl"; then
    echo "::error::No $plat Release for $pkg $ver in $repo."
    echo "::error::Trigger that repo's nightly (workflow_dispatch -f $input=$ver) then re-run."
    exit 1
  fi
  ( cd "$slug-dl" && sha256sum -c "$slug-win32-arm64-msvc.tar.gz.sha256" )
  mkdir -p "$slug-arm64"
  tar -xzf "$slug-dl/$slug-win32-arm64-msvc.tar.gz" -C "$slug-arm64"
  [ -f "$slug-arm64/$member" ] || { echo "::error::$pkg artifact missing $member"; exit 1; }
}

fetch_companion libsql @libsql/win32-arm64-msvc khairm/libsql-windows-arm64 \
  libsql_version libsql index.node
LIBSQL_DIR="$COMPANION_DIR"

fetch_companion @anush008/tokenizers @anush008/tokenizers-win32-arm64-msvc \
  khairm/tokenizers-windows-arm64 tokenizers_version tokenizers tokenizers.win32-arm64-msvc.node \
  mastracode
TOK_DIR="$COMPANION_DIR"

# Electron NODE_MODULE_VERSION (V8 ABI). better-sqlite3 is V8-ABI-bound;
# a wrong ABI fetches a prebuilt that crashes Electron. Derive
# authoritatively via node-abi against the resolved electron, fall back
# to a pinned map, HARD-FAIL on an unknown major (never silently guess).
EV="$(bun_locked_version_one electron)"
EM="${EV%%.*}"
ABI=$(node -e "try{process.stdout.write(String(require('node-abi').getAbi('$EV','electron')))}catch(e){}" 2>/dev/null || true)
if printf '%s' "$ABI" | grep -Eq '^[0-9]+$'; then
  echo "ABI from node-abi getAbi('$EV','electron') = $ABI"
else
  case "$EM" in
    36) ABI=135;; 37) ABI=136;; 38) ABI=139;; 39) ABI=140;; 40) ABI=143;; 41) ABI=145;; 42) ABI=146;;
    *) echo "::error::Unknown Electron major $EM and node-abi unavailable — add its NODE_MODULE_VERSION to the ABI map"; exit 1;;
  esac
  echo "ABI from pinned map (node-abi unavailable) = $ABI"
fi
echo "electron version=$EV major=$EM -> ABI=$ABI"
export ELECTRON_ABI="$ABI" LIBSQL_ARM64_DIR="$LIBSQL_DIR" TOKENIZERS_ARM64_DIR="$TOK_DIR"
bash scripts/materialize-native-closure.sh
echo "ELECTRON_ABI=$ABI" >> "$GITHUB_ENV"
# Set-and-empty, never unset and never a stale path: an empty value is how the
# later steps are told this build proved the package is gone, so packaging omits
# it and the packaged-closure gate demands its absence instead of its presence.
echo "LIBSQL_ARM64_DIR=$LIBSQL_DIR" >> "$GITHUB_ENV"
echo "TOKENIZERS_ARM64_DIR=$TOK_DIR" >> "$GITHUB_ENV"
