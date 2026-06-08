#!/usr/bin/env bash
# ARM64 fork: minimal Bun-store payload repair (root-cause fix).
#
# electron-builder's Bun collector follows VALID symlinks + walks up; it only
# fails on dangling/missing REQUIRED deps (Ashesh3's x64 build proves the plain
# bun isolated symlink farm works). The ONE broken thing on win-arm64 is that
# better-sqlite3's Bun-store payload is never extracted (native trustedDependency
# whose prebuild-install can't run without a toolchain), so
# node_modules/.bun/better-sqlite3@<ver>/node_modules/better-sqlite3 is missing
# while its sibling bindings/prebuild-install symlinks (one level up in that
# .bun entry) are VALID. Populating just that payload (npm tree + matching
# Electron-ABI win32-arm64 better_sqlite3.node) makes every consumer's existing
# bun symlink resolve, and the whole closure resolves through bun's intact graph.
#
# Also supply the registry-less win32-arm64 platform packages at app-root for
# runtime packaging/validate (the collector skips them: not in any required
# `dependencies`): @libsql/win32-arm64-msvc and
# @anush008/tokenizers-win32-arm64-msvc (the latter is fastembed's tokenizer;
# upstream publishes no win-arm64 build — khairm/tokenizers-windows-arm64 does).
# Platform pkgs (@lydell/node-pty, @ast-grep/napi, @parcel/watcher win32-arm64)
# resolve via bun graph + copy:native-modules already.
#
# Run AFTER a fresh `bun install`, AFTER compile:app, BEFORE copy:native-modules.
# Idempotent. Env: ELECTRON_ABI (default 143), LIBSQL_ARM64_DIR,
# TOKENIZERS_ARM64_DIR.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ABI="${ELECTRON_ABI:-143}"
BUN="$ROOT/node_modules/.bun"
APPNM="$ROOT/apps/desktop/node_modules"
pearch(){ od -An -tx1 -j"$(( $(od -An -tu4 -j60 -N4 "$1" 2>/dev/null|tr -d ' ')+4 ))" -N2 "$1" 2>/dev/null|tr -d ' '; }
mkdir -p "$ROOT/tmp"

# --- 1. Populate every native trustedDependency whose .bun-store payload was
#     never extracted (the collector treats them as required `dependencies`).
#     npm-tarball extraction satisfies the collector; better-sqlite3 also gets
#     the matching Electron-ABI win32-arm64 prebuilt .node. bufferutil/
#     utf-8-validate are ws perf-optionals (graceful JS fallback at runtime);
#     a platform binary they may lack is irrelevant to the collector. ---
TRUSTED="$(node -e 'console.log((require("./package.json").trustedDependencies||[]).join(" "))' 2>/dev/null || true)"
for n in $TRUSTED; do
  ENTRY="$( (ls -d "$BUN/$(printf '%s' "$n"|tr / +)"@* 2>/dev/null || true) | sort -r | head -1 )"
  [ -n "$ENTRY" ] || { echo "[mat] $n: no .bun entry (skip — aliased/absent)"; continue; }
  VER="$(basename "$ENTRY" | sed "s#^$(printf '%s' "$n"|tr / +)@##")"
  PAY="$ENTRY/node_modules/$n"
  # better-sqlite3 is V8-ABI bound (NOT N-API): a win32-arm64 .node is only
  # correct if its NODE_MODULE_VERSION matches the target Electron ABI. A
  # PE-machine (0xAA64) check alone is NOT sufficient — a Node-ABI (e.g.
  # node-v127) ARM64 prebuilt in the bun store passes that yet crashes Electron
  # with "compiled against a different Node.js version". So NEVER trust the
  # store copy for better-sqlite3: always re-populate (the populate path below
  # fetches the exact electron-v$ABI prebuilt and overwrites). All other
  # trustedDeps are satisfied by npm-tarball extraction alone.
  if [ -f "$PAY/package.json" ] && [ "$n" != better-sqlite3 ]; then
    echo "[mat] $n@$VER payload OK"; continue
  fi
  echo "[mat] populating $n@$VER .bun payload"
  bare="${n##*/}"
  rm -rf "$PAY"; mkdir -p "$PAY"
  curl -fsSL "https://registry.npmjs.org/$n/-/$bare-$VER.tgz" | tar -xz -C "$PAY" --strip-components=1
  [ -f "$PAY/package.json" ] || { echo "[mat] $n payload extraction failed"; exit 1; }
  if [ "$n" = better-sqlite3 ]; then
    A="better-sqlite3-v$VER-electron-v$ABI-win32-arm64.tar.gz"
    curl -fsSL "https://github.com/WiseLibs/better-sqlite3/releases/download/v$VER/$A" -o "$ROOT/tmp/$A"
    rm -rf "$ROOT/tmp/bsqpre"; mkdir -p "$ROOT/tmp/bsqpre" "$PAY/build/Release"
    tar -xzf "$ROOT/tmp/$A" -C "$ROOT/tmp/bsqpre"
    cp "$ROOT/tmp/bsqpre/build/Release/better_sqlite3.node" "$PAY/build/Release/better_sqlite3.node"
    [ "$(pearch "$PAY/build/Release/better_sqlite3.node")" = 64aa ] || { echo "[mat] better_sqlite3.node not ARM64"; exit 1; }
  fi
  echo "[mat] $n@$VER payload ready"
done

# --- 2. Supply @libsql/win32-arm64-msvc (registry has none) for runtime/validate ---
LSQ="$APPNM/@libsql/win32-arm64-msvc"
if [ -f "$LSQ/index.node" ] && [ "$(pearch "$LSQ/index.node")" = 64aa ]; then
  echo "[mat] @libsql/win32-arm64-msvc already present"
else
  [ -n "${LIBSQL_ARM64_DIR:-}" ] && [ -f "$LIBSQL_ARM64_DIR/index.node" ] || { echo "[mat] LIBSQL_ARM64_DIR missing index.node"; exit 1; }
  rm -rf "$LSQ"; mkdir -p "$APPNM/@libsql"
  cp -r "$LIBSQL_ARM64_DIR" "$LSQ"
  echo "[mat] @libsql/win32-arm64-msvc <- $LIBSQL_ARM64_DIR"
fi

# --- 3. Supply @anush008/tokenizers-win32-arm64-msvc (registry has none;
#     fastembed -> @anush008/tokenizers bare-requires it). N-API addon, so one
#     arm64 build covers any Electron — no per-ABI variant. Same injection
#     model as @libsql (collector skips it: optionalDependency, not required). ---
TOK="$APPNM/@anush008/tokenizers-win32-arm64-msvc"
if [ -f "$TOK/tokenizers.win32-arm64-msvc.node" ] && [ "$(pearch "$TOK/tokenizers.win32-arm64-msvc.node")" = 64aa ]; then
  echo "[mat] @anush008/tokenizers-win32-arm64-msvc already present"
else
  [ -n "${TOKENIZERS_ARM64_DIR:-}" ] && [ -f "$TOKENIZERS_ARM64_DIR/tokenizers.win32-arm64-msvc.node" ] || { echo "[mat] TOKENIZERS_ARM64_DIR missing tokenizers.win32-arm64-msvc.node"; exit 1; }
  [ -f "$TOKENIZERS_ARM64_DIR/package.json" ] || { echo "[mat] TOKENIZERS_ARM64_DIR missing package.json"; exit 1; }
  # Copy only the two files the platform package needs — never cp -r the source
  # dir (it may also hold the downloaded tarball/checksum; this dir is shipped
  # verbatim by electron-builder extraResources with a **/* filter).
  rm -rf "$TOK"; mkdir -p "$TOK"
  cp "$TOKENIZERS_ARM64_DIR/tokenizers.win32-arm64-msvc.node" "$TOK/tokenizers.win32-arm64-msvc.node"
  cp "$TOKENIZERS_ARM64_DIR/package.json" "$TOK/package.json"
  echo "[mat] @anush008/tokenizers-win32-arm64-msvc <- $TOKENIZERS_ARM64_DIR"
fi
echo "[mat] minimal native repair complete"
