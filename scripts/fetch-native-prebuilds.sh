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
# fallback, on an absent package or a second live version).
# shellcheck source=./bun-locked-versions.sh
. "$ROOT/scripts/bun-locked-versions.sh"

LV="$(bun_locked_version_one libsql)"
echo "Resolved libsql: $LV"
rm -rf libsql-dl libsql-arm64
if ! gh release download "$LV" --repo khairm/libsql-windows-arm64 \
       -p 'libsql-win32-arm64-msvc.tar.gz' -p 'libsql-win32-arm64-msvc.tar.gz.sha256' -D libsql-dl; then
  echo "::error::No @libsql/win32-arm64-msvc Release for libsql $LV in khairm/libsql-windows-arm64."
  echo "::error::Trigger that repo's nightly (workflow_dispatch -f libsql_version=$LV) then re-run."
  exit 1
fi
( cd libsql-dl && sha256sum -c libsql-win32-arm64-msvc.tar.gz.sha256 )
mkdir -p libsql-arm64
tar -xzf libsql-dl/libsql-win32-arm64-msvc.tar.gz -C libsql-arm64
[ -f libsql-arm64/index.node ] || { echo "::error::libsql artifact missing index.node"; exit 1; }

TV="$(bun_locked_version_one @anush008/tokenizers)"
echo "Resolved @anush008/tokenizers: $TV"
rm -rf tok-dl tokenizers-arm64
if ! gh release download "$TV" --repo khairm/tokenizers-windows-arm64 \
       -p 'tokenizers-win32-arm64-msvc.tar.gz' -p 'tokenizers-win32-arm64-msvc.tar.gz.sha256' -D tok-dl; then
  echo "::error::No @anush008/tokenizers-win32-arm64-msvc Release for tokenizers $TV in khairm/tokenizers-windows-arm64."
  echo "::error::Trigger that repo's nightly (workflow_dispatch -f tokenizers_version=$TV) then re-run."
  exit 1
fi
( cd tok-dl && sha256sum -c tokenizers-win32-arm64-msvc.tar.gz.sha256 )
mkdir -p tokenizers-arm64
tar -xzf tok-dl/tokenizers-win32-arm64-msvc.tar.gz -C tokenizers-arm64
[ -f tokenizers-arm64/tokenizers.win32-arm64-msvc.node ] || { echo "::error::tokenizers artifact missing .node"; exit 1; }

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
export ELECTRON_ABI="$ABI" LIBSQL_ARM64_DIR="$PWD/libsql-arm64" TOKENIZERS_ARM64_DIR="$PWD/tokenizers-arm64"
bash scripts/materialize-native-closure.sh
echo "ELECTRON_ABI=$ABI" >> "$GITHUB_ENV"
echo "LIBSQL_ARM64_DIR=$PWD/libsql-arm64" >> "$GITHUB_ENV"
echo "TOKENIZERS_ARM64_DIR=$PWD/tokenizers-arm64" >> "$GITHUB_ENV"
