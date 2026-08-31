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
# Idempotent. Env: ELECTRON_ABI (REQUIRED, no default), LIBSQL_ARM64_DIR,
# TOKENIZERS_ARM64_DIR.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# The ABI decides WHICH better-sqlite3 prebuilt gets installed, and a wrong one
# is a crash on the user's machine, not a build failure — so there is no safe
# default to fall back to. scripts/fetch-native-prebuilds.sh derives it from the
# resolved electron version and exports it (and writes it to GITHUB_ENV for the
# later validate step). Demand it before touching anything.
ABI="${ELECTRON_ABI:-}"
case "$ABI" in
  '' | *[!0-9]*)
    echo "[mat] ELECTRON_ABI must be the Electron ABI number (got '$ABI') — scripts/fetch-native-prebuilds.sh derives and exports it; refusing to guess which better-sqlite3 prebuilt to install"
    exit 1 ;;
esac
BUN="$ROOT/node_modules/.bun"
APPNM="$ROOT/apps/desktop/node_modules"
# shellcheck source=./bun-locked-versions.sh
. "$ROOT/scripts/bun-locked-versions.sh"
# The versions the two companion prebuilds in sections 2 and 3 must carry.
# Resolved ONE at a time (`_one`, not `_all`): a graph that somehow resolves two
# libsql versions has no single native to inject, and picking either would ship
# a binary against a version half of it never asked for. Demanded here, beside
# the ABI, so a lockfile this build cannot read fails before anything at all is
# written. Why the version and not just the file: see check_companion_source.
LIBSQL_LOCKED="$(bun_locked_version_one libsql)" \
  || { echo "[mat] cannot resolve libsql's locked version — refusing to judge the @libsql/win32-arm64-msvc prebuild against nothing"; exit 1; }
TOKENIZERS_LOCKED="$(bun_locked_version_one @anush008/tokenizers)" \
  || { echo "[mat] cannot resolve @anush008/tokenizers's locked version — refusing to judge the @anush008/tokenizers-win32-arm64-msvc prebuild against nothing"; exit 1; }

# The machine bytes of a PE image, as od prints them (little-endian, so ARM64
# reads 64aa) — or nothing at all when the file is not a PE image this can read.
# Every step is checked because the alternative is trusting two bytes at a fixed
# offset, and ANY file can carry 64aa at offset 68 by accident or by design: a
# text file, a truncated download, a decoy. Printing nothing fails the `= 64aa`
# comparison at every call site, which is the loud path.
# Same checks as pearch() in scripts/verify-packaged-natives.sh.
pearch() {
  local file="$1" size lfanew
  [ -f "$file" ] || return 0
  size="$(wc -c < "$file" | tr -d ' ')"
  [ "$size" -ge 64 ] || return 0                                            # room for a DOS header
  [ "$(od -An -tx1 -j0 -N2 "$file" | tr -d ' ')" = 4d5a ] || return 0       # "MZ"
  lfanew="$(od -An -tu4 -j60 -N4 "$file" | tr -d ' ')"                      # e_lfanew, at 0x3c
  [ "$lfanew" -ge 64 ] && [ "$((lfanew + 6))" -le "$size" ] || return 0     # past the DOS header, inside the file
  [ "$(od -An -tx1 -j"$lfanew" -N4 "$file" | tr -d ' ')" = 50450000 ] || return 0  # "PE\0\0"
  od -An -tx1 -j"$((lfanew + 4))" -N2 "$file" | tr -d ' '
}
mkdir -p "$ROOT/tmp"

# Every payload below is built in a staging dir beside it and swapped in only
# once all of its downloads and checks have passed. MAT_OLD holds the previous
# payload for the length of that swap, and the trap deliberately does NOT
# delete it: if we die between the two moves, it is the only copy left.
MAT_STAGE=""
MAT_OLD=""
_mat_cleanup() {
  [ -z "$MAT_STAGE" ] || rm -rf "$MAT_STAGE"
  [ -z "$MAT_OLD" ] || echo "[mat] the previous payload is at $MAT_OLD"
  return 0
}
trap _mat_cleanup EXIT

# Swap the staged dir in $MAT_STAGE into place at $1 ($2 labels it in messages).
# The old copy moves aside first and is deleted only after the staged one is
# in place, so a failed move rolls the old copy back and a death mid-swap
# leaves it at $MAT_OLD rather than nowhere. Fatal on any failure.
#
# $3 says WHERE the old copy waits. Store payloads leave it beside the staging
# dir under node_modules/.bun, which no packaging step reads. App-level packages
# must not: apps/desktop/node_modules/@libsql is copied whole into the
# installer, so a `.old` left there by a failed rollback would SHIP. Those
# callers pass $ROOT/tmp — same volume, so the moves stay cheap, and outside
# every packaged root.
swap_into_place() { # $1 = target path, $2 = label, $3 = optional dir to park the old copy in
  local target="$1" label="$2" old_dir="${3:-}" old="$MAT_STAGE.old"
  if [ -n "$old_dir" ]; then
    mkdir -p "$old_dir" || { echo "[mat] $label: cannot create $old_dir to park the old copy in"; exit 1; }
    old="$old_dir/${MAT_STAGE##*/}.old"
    # A leftover here is the sole surviving copy from an earlier failed
    # rollback. Moving onto it would nest this one inside it and lose both.
    [ ! -e "$old" ] || { echo "[mat] $label: $old already exists — refusing to bury an earlier rescued copy"; exit 1; }
  fi
  if [ -e "$target" ]; then
    MAT_OLD="$old"
    mv "$target" "$MAT_OLD" || { MAT_OLD=""; echo "[mat] $label: cannot move the old copy aside"; exit 1; }
  fi
  if ! mv "$MAT_STAGE" "$target"; then
    echo "[mat] $label: could not swap the staged copy into $target"
    if [ -n "$MAT_OLD" ]; then
      if mv "$MAT_OLD" "$target"; then
        echo "[mat] $label: rolled the previous copy back"
      else
        echo "[mat] $label: ROLLBACK FAILED — the previous copy is at $MAT_OLD"
      fi
      MAT_OLD=""
    fi
    exit 1
  fi
  MAT_STAGE=""
  [ -z "$MAT_OLD" ] || { rm -rf "$MAT_OLD"; MAT_OLD=""; }
}

# --- 1. Populate every native trustedDependency whose .bun-store payload was
#     never extracted (the collector treats them as required `dependencies`).
#     npm-tarball extraction satisfies the collector; better-sqlite3 also gets
#     the matching Electron-ABI win32-arm64 prebuilt .node. bufferutil/
#     utf-8-validate are ws perf-optionals (graceful JS fallback at runtime);
#     a platform binary they may lack is irrelevant to the collector. ---
TRUSTED="$(node -e '
  const t = require("./package.json").trustedDependencies;
  if (!Array.isArray(t) || t.length === 0) process.exit(1);
  console.log(t.join(" "));
')" || { echo "[mat] cannot read trustedDependencies from $ROOT/package.json — refusing to repair a payload set I could not determine"; exit 1; }

# Repair ONE store entry: extract the registry tarball (plus, for
# better-sqlite3, the matching Electron-ABI prebuilt) into a staging dir, then
# swap it into place. Any failure before the swap is fatal and leaves whatever
# payload was already there.
materialize_entry() {
  local n="$1" VER="$2" ENTRY="$3"
  local PAY="$ENTRY/node_modules/$n" parent bare url asset

  # better-sqlite3 is V8-ABI bound (NOT N-API): a win32-arm64 .node is only
  # correct if its NODE_MODULE_VERSION matches the target Electron ABI. A
  # PE-machine (0xAA64) check alone is NOT sufficient — a Node-ABI (e.g.
  # node-v127) ARM64 prebuilt in the bun store passes that yet crashes Electron
  # with "compiled against a different Node.js version". So NEVER trust the
  # store copy for better-sqlite3: always re-populate (the populate path below
  # fetches the exact electron-v$ABI prebuilt and overwrites). All other
  # trustedDeps are satisfied by npm-tarball extraction alone.
  if [ -f "$PAY/package.json" ] && [ "$n" != better-sqlite3 ]; then
    echo "[mat] $n@$VER payload OK ($PAY)"
    return 0
  fi

  echo "[mat] populating $n@$VER payload at $PAY"
  parent="$(dirname "$PAY")"
  mkdir -p "$parent"
  # Staged, never in place. The old code ran `rm -rf "$PAY"` first, so a failed
  # download — or a prebuilt that turned out not to be ARM64 — left NO payload
  # at all: the entry went from stale-but-loadable to empty, and the next step
  # failed on a file this script had deleted.
  MAT_STAGE="$(mktemp -d "$parent/.mat-stage-XXXXXX")" \
    || { echo "[mat] $n@$VER: cannot create a staging dir under $parent"; exit 1; }

  bare="${n##*/}"
  url="https://registry.npmjs.org/$n/-/$bare-$VER.tgz"
  if ! curl -fsSL "$url" | tar -xz -C "$MAT_STAGE" --strip-components=1; then
    echo "[mat] $n@$VER: registry tarball failed ($url) — existing payload left untouched"; exit 1
  fi
  [ -f "$MAT_STAGE/package.json" ] \
    || { echo "[mat] $n@$VER: extraction produced no package.json — existing payload left untouched"; exit 1; }

  if [ "$n" = better-sqlite3 ]; then
    asset="better-sqlite3-v$VER-electron-v$ABI-win32-arm64.tar.gz"
    if ! curl -fsSL "https://github.com/WiseLibs/better-sqlite3/releases/download/v$VER/$asset" -o "$ROOT/tmp/$asset"; then
      echo "[mat] $n@$VER: no electron-v$ABI win32-arm64 prebuilt ($asset) — existing payload left untouched"; exit 1
    fi
    rm -rf "$ROOT/tmp/bsqpre"; mkdir -p "$ROOT/tmp/bsqpre" "$MAT_STAGE/build/Release"
    tar -xzf "$ROOT/tmp/$asset" -C "$ROOT/tmp/bsqpre"
    cp "$ROOT/tmp/bsqpre/build/Release/better_sqlite3.node" "$MAT_STAGE/build/Release/better_sqlite3.node"
    [ "$(pearch "$MAT_STAGE/build/Release/better_sqlite3.node")" = 64aa ] \
      || { echo "[mat] $n@$VER: prebuilt better_sqlite3.node is not ARM64 — existing payload left untouched"; exit 1; }
  fi

  swap_into_place "$PAY" "$n@$VER"
  echo "[mat] $n@$VER payload ready at $PAY"
}

for n in $TRUSTED; do
  rc=0
  VERS="$(bun_locked_versions_all "$n")" || rc=$?
  # Nothing links it: an aliased dep resolves under the name it was aliased TO,
  # and an absent one has no payload to repair. Normal, and logged either way.
  if [ "$rc" -eq 1 ]; then
    echo "[mat] $n: not in bun.lock (skip — aliased/absent)"
    continue
  fi
  [ "$rc" -eq 0 ] || { echo "[mat] $n: could not determine its locked version(s)"; exit 1; }

  # A trustedDep may legitimately resolve more than once (five esbuilds, two
  # sharps) and each instance is repaired on its own terms. better-sqlite3 is
  # the exception: one electron-v$ABI prebuilt is fetched per version, and a
  # second live version needs a second, differently-versioned one — so stop
  # rather than repair one instance and ship the other broken.
  if [ "$n" = better-sqlite3 ] && [ "$(printf '%s\n' "$VERS" | wc -l)" -ne 1 ]; then
    echo "[mat] better-sqlite3 resolves to $(printf '%s' "$VERS" | tr '\n' ' ') — one Electron ABI prebuilt cannot cover them all; fix the dependency graph"
    exit 1
  fi

  KEY="$(printf '%s' "$n" | tr / +)"
  for VER in $VERS; do
    found=0
    # ONLY the two directory shapes that mean this exact version: `key@ver` and
    # bun's dedupe variant `key@ver+<16 hex>` (a version may have several of
    # those, and all of them are repaired). The literal `+` is why 12.11.1
    # cannot reach 12.11.10, and the basename is re-checked below before
    # anything destructive runs. Every other directory under $BUN is a cached
    # version this install does not resolve to, and is left alone.
    for ENTRY in "$BUN/$KEY@$VER" "$BUN/$KEY@$VER"+*; do
      [ -d "$ENTRY" ] || continue
      base="${ENTRY##*/}"
      if [ "$base" != "$KEY@$VER" ]; then
        suffix="${base#"$KEY@$VER+"}"
        [[ "$suffix" =~ ^[0-9a-f]{16}$ ]] || {
          echo "[mat] $n: unrecognized store directory '$base' — bun's layout changed; refusing to touch it"
          exit 1
        }
      fi
      found=1
      materialize_entry "$n" "$VER" "$ENTRY"
    done
    [ "$found" -eq 1 ] || {
      echo "[mat] $n@$VER: bun.lock resolves it but $BUN holds no directory for it — run bun install"
      exit 1
    }
  done
done

# --- 2. Supply @libsql/win32-arm64-msvc (registry has none) for runtime/validate ---
#
# Sections 2 and 3 inject a companion platform package from the prebuild
# directory scripts/fetch-native-prebuilds.sh downloaded, checksummed and
# extracted. Two separate things vouch for it: bun.lock owns the VERSION, and
# that directory owns the CONTENTS that belong at the destination. The
# destination vouches for nothing. A leftover copy from an earlier build (a
# previous libsql version, an interrupted copy, a hand-edited manifest) is
# exactly what these checks are looking for, and asking it to vouch for itself
# finds nothing.

# One top-level string field out of a package.json. Prints nothing when the file
# is missing or unparsable or the field is absent or not a string; every caller
# reads an empty value as "does not match".
pkg_field() { # $1 = package.json path, $2 = field name
  node -e '
    const fs = require("node:fs");
    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    } catch {
      process.exit(0);
    }
    const value = pkg && pkg[process.argv[2]];
    if (typeof value === "string") process.stdout.write(value);
  ' "$1" "$2" 2>/dev/null
}

# Check that the prebuild directory holds the package this build resolved, and
# nothing else. Fatal when it does not, before any destination is touched.
#
# The version is the load-bearing one. fetch-native-prebuilds.sh asks the
# companion repo for the Release TAGGED with the locked version, and a tag is a
# label someone typed, not a promise about the tarball hanging off it: a
# mistagged or re-pointed Release hands back a native built against another
# version of the package the app imports, and the checksum beside it only proves
# the download was not corrupted in flight. bun.lock owns the version; the
# manifest inside the payload must say the same thing.
check_companion_source() { # $1 = source dir, $2 = expected package name, $3 = required native file, $4 = version bun.lock resolved
  local src="$1" want="$2" file="$3" locked="$4" name version main
  name="$(pkg_field "$src/package.json" name)"
  version="$(pkg_field "$src/package.json" version)"
  main="$(pkg_field "$src/package.json" main)"
  [ "$name" = "$want" ] \
    || { echo "[mat] $want: the prebuild at $src calls itself '${name:-<missing>}' — wrong or unreadable artifact"; exit 1; }
  [ "$version" = "$locked" ] \
    || { echo "[mat] $want: the prebuild at $src is version '${version:-<missing>}', but bun.lock resolves $locked — wrong Release payload"; exit 1; }
  [ "$main" = "$file" ] \
    || { echo "[mat] $want: the prebuild at $src has main '${main:-<missing>}', not $file — not the package the app loads"; exit 1; }
}

# Is the copy already installed at $1 the exact package we are about to inject?
# Its package.json must carry the expected name and main and the version bun.lock
# resolved, and its native file must be there and be ARM64. Anything else — no
# package.json, a stale version, a foreign manifest, a missing or x64 binary —
# returns 1 and is replaced through the staged swap below. rc 0 means leave it
# alone. Only @libsql uses this: @anush008/tokenizers ships one constant version
# forever, so there is no question here it could answer (see section 3).
companion_dest_current() { # $1 = dest dir, $2 = package name, $3 = expected version, $4 = required native file
  local dest="$1" want="$2" ver="$3" file="$4" got
  [ -d "$dest" ] || { echo "[mat] $want: not installed yet"; return 1; }
  got="$(pkg_field "$dest/package.json" name)"
  [ "$got" = "$want" ] \
    || { echo "[mat] $want: the installed copy calls itself '${got:-<missing>}' — replacing it"; return 1; }
  got="$(pkg_field "$dest/package.json" version)"
  [ "$got" = "$ver" ] \
    || { echo "[mat] $want: the installed copy is ${got:-<missing>}, bun.lock resolves $ver — replacing it"; return 1; }
  got="$(pkg_field "$dest/package.json" main)"
  [ "$got" = "$file" ] \
    || { echo "[mat] $want: the installed copy has main '${got:-<missing>}', not $file — replacing it"; return 1; }
  [ -f "$dest/$file" ] \
    || { echo "[mat] $want: the installed copy has no $file — replacing it"; return 1; }
  [ "$(pearch "$dest/$file")" = 64aa ] \
    || { echo "[mat] $want: the installed $file is not ARM64 — replacing it"; return 1; }
  return 0
}

LSQ="$APPNM/@libsql/win32-arm64-msvc"
[ -n "${LIBSQL_ARM64_DIR:-}" ] && [ -f "$LIBSQL_ARM64_DIR/index.node" ] || { echo "[mat] LIBSQL_ARM64_DIR missing index.node"; exit 1; }
check_companion_source "$LIBSQL_ARM64_DIR" @libsql/win32-arm64-msvc index.node "$LIBSQL_LOCKED"
if companion_dest_current "$LSQ" @libsql/win32-arm64-msvc "$LIBSQL_LOCKED" index.node; then
  echo "[mat] @libsql/win32-arm64-msvc already present ($LIBSQL_LOCKED)"
else
  # Same staged swap as the store payloads above: build the whole copy beside
  # the target and check it there, so a half-copied or non-ARM64 source never
  # costs us the usable copy that was already installed.
  mkdir -p "$APPNM/@libsql"
  MAT_STAGE="$(mktemp -d "$APPNM/@libsql/.mat-stage-XXXXXX")" \
    || { echo "[mat] @libsql/win32-arm64-msvc: cannot create a staging dir under $APPNM/@libsql"; exit 1; }
  cp -r "$LIBSQL_ARM64_DIR/." "$MAT_STAGE/" \
    || { echo "[mat] @libsql/win32-arm64-msvc: copy from $LIBSQL_ARM64_DIR failed — existing copy left untouched"; exit 1; }
  [ -f "$MAT_STAGE/package.json" ] \
    || { echo "[mat] @libsql/win32-arm64-msvc: staged copy has no package.json — existing copy left untouched"; exit 1; }
  [ "$(pearch "$MAT_STAGE/index.node")" = 64aa ] \
    || { echo "[mat] @libsql/win32-arm64-msvc: staged index.node is not ARM64 — existing copy left untouched"; exit 1; }
  swap_into_place "$LSQ" "@libsql/win32-arm64-msvc" "$ROOT/tmp"
  echo "[mat] @libsql/win32-arm64-msvc <- $LIBSQL_ARM64_DIR ($LIBSQL_LOCKED)"
fi

# --- 3. Supply @anush008/tokenizers-win32-arm64-msvc (registry has none;
#     fastembed -> @anush008/tokenizers bare-requires it). N-API addon, so one
#     arm64 build covers any Electron — no per-ABI variant. Same injection
#     model as @libsql (collector skips it: optionalDependency, not required). ---
#
# Unlike @libsql, this package is published at a constant 0.0.0 — every release
# the companion repo ever built carries that same manifest. So an installed copy
# is unfalsifiable: name, version, main and ARM64-ness all match no matter which
# build it came from, and "already present (0.0.0)" would happily keep a binary
# from a rebuild that fixed a crash. The payload is two files, so it is simply
# re-staged from the verified prebuild every run rather than interrogated. The
# swap is the same one: the old copy only dies once the new one is in place.
TOK="$APPNM/@anush008/tokenizers-win32-arm64-msvc"
[ -n "${TOKENIZERS_ARM64_DIR:-}" ] && [ -f "$TOKENIZERS_ARM64_DIR/tokenizers.win32-arm64-msvc.node" ] || { echo "[mat] TOKENIZERS_ARM64_DIR missing tokenizers.win32-arm64-msvc.node"; exit 1; }
check_companion_source "$TOKENIZERS_ARM64_DIR" @anush008/tokenizers-win32-arm64-msvc tokenizers.win32-arm64-msvc.node "$TOKENIZERS_LOCKED"
# Copy only the two files the platform package needs — never cp -r the source
# dir (it may also hold the downloaded tarball/checksum; this dir is shipped
# verbatim by electron-builder extraResources with a **/* filter). Staged
# beside the target and checked there, so a failed copy keeps the old one.
mkdir -p "$APPNM/@anush008"
MAT_STAGE="$(mktemp -d "$APPNM/@anush008/.mat-stage-XXXXXX")" \
  || { echo "[mat] @anush008/tokenizers-win32-arm64-msvc: cannot create a staging dir under $APPNM/@anush008"; exit 1; }
cp "$TOKENIZERS_ARM64_DIR/tokenizers.win32-arm64-msvc.node" "$MAT_STAGE/tokenizers.win32-arm64-msvc.node" \
  || { echo "[mat] @anush008/tokenizers-win32-arm64-msvc: copy of the .node failed — existing copy left untouched"; exit 1; }
cp "$TOKENIZERS_ARM64_DIR/package.json" "$MAT_STAGE/package.json" \
  || { echo "[mat] @anush008/tokenizers-win32-arm64-msvc: copy of package.json failed — existing copy left untouched"; exit 1; }
[ "$(pearch "$MAT_STAGE/tokenizers.win32-arm64-msvc.node")" = 64aa ] \
  || { echo "[mat] @anush008/tokenizers-win32-arm64-msvc: staged tokenizers.win32-arm64-msvc.node is not ARM64 — existing copy left untouched"; exit 1; }
swap_into_place "$TOK" "@anush008/tokenizers-win32-arm64-msvc" "$ROOT/tmp"
echo "[mat] @anush008/tokenizers-win32-arm64-msvc <- $TOKENIZERS_ARM64_DIR ($TOKENIZERS_LOCKED)"
echo "[mat] minimal native repair complete"
