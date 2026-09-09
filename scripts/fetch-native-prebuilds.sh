#!/usr/bin/env bash
# Fetch the fork's companion win32-arm64 native prebuilds (libsql, tokenizers —
# each only while bun.lock still resolves the package it belongs to), then
# derive the Electron ABI and materialize the native closure. Run from repo
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

# NEITHER companion's presence is guaranteed: both reach the app transitively
# through upstream's agent stack (libsql via mastracode/@mastra, tokenizers via
# mastracode -> @mastra/fastembed), so an upstream release that drops that
# chain leaves the registry-less win32-arm64 platform package with nothing to
# be loaded by. The lockfile is the authority on which state we are in and rc 1
# is its "not in bun.lock" answer (contract: scripts/bun-locked-versions.sh) —
# the ONLY skippable one. Anything else is still fatal: an unreadable lockfile
# must never look like an absent dependency, or a build that needs the native
# ships without it. Deliberately a skip and not a deletion: if the dependency
# comes back, this supplies the ARM64 build again with no further change.
LIBSQL_DIR=""
rm -rf libsql-dl libsql-arm64
lsq_rc=0
bun_locked_versions_all libsql >/dev/null || lsq_rc=$?
if [ "$lsq_rc" -eq 1 ]; then
  echo "libsql is not in bun.lock — nothing loads the win32-arm64 libsql native, skipping its prebuild"
elif [ "$lsq_rc" -ne 0 ]; then
  echo "::error::cannot tell whether libsql is in bun.lock — refusing to decide the libsql prebuild on an unreadable lockfile"
  exit 1
else
  LV="$(bun_locked_version_one libsql)"
  echo "Resolved libsql: $LV"
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
  LIBSQL_DIR="$PWD/libsql-arm64"
fi

# Same rule for @anush008/tokenizers, asked separately: the two dependencies
# have come and gone independently.
TOKENIZERS_DIR=""
rm -rf tok-dl tokenizers-arm64
tok_rc=0
bun_locked_versions_all @anush008/tokenizers >/dev/null || tok_rc=$?
if [ "$tok_rc" -eq 1 ]; then
  echo "@anush008/tokenizers is not in bun.lock — nothing loads the win32-arm64 tokenizers native, skipping its prebuild"
elif [ "$tok_rc" -ne 0 ]; then
  echo "::error::cannot tell whether @anush008/tokenizers is in bun.lock — refusing to decide the tokenizers prebuild on an unreadable lockfile"
  exit 1
else
  TV="$(bun_locked_version_one @anush008/tokenizers)"
  echo "Resolved @anush008/tokenizers: $TV"
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
  TOKENIZERS_DIR="$PWD/tokenizers-arm64"
fi

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
export ELECTRON_ABI="$ABI" LIBSQL_ARM64_DIR="$LIBSQL_DIR" TOKENIZERS_ARM64_DIR="$TOKENIZERS_DIR"
bash scripts/materialize-native-closure.sh
echo "ELECTRON_ABI=$ABI" >> "$GITHUB_ENV"
# Empty when the lockfile has no libsql — materialize asks the lockfile the
# same question and skips the same section, so an empty value here is the
# agreed "nothing to inject", never a lost export.
echo "LIBSQL_ARM64_DIR=$LIBSQL_DIR" >> "$GITHUB_ENV"
# Empty when the lockfile has no @anush008/tokenizers, on the same rule.
echo "TOKENIZERS_ARM64_DIR=$TOKENIZERS_DIR" >> "$GITHUB_ENV"
