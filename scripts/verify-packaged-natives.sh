#!/usr/bin/env bash
# Verify the packaged app's native closure is ARM64. Run from apps/desktop
# after electron-builder.
set -euo pipefail

APP="release/win-arm64-unpacked"
[ -d "$APP" ] || { echo "::error::$APP not found"; exit 1; }
# The machine bytes of a PE image, as od prints them (little-endian, so ARM64
# reads 64aa) — or nothing at all when the file is not a PE image this can read.
# Every step is checked because the alternative is trusting two bytes at a fixed
# offset, and ANY file can carry 64aa at offset 68 by accident or by design: a
# text file, a truncated download, a decoy. Printing nothing fails the `= 64aa`
# comparison at every call site below, which is the loud path.
# Same checks as pearch() in scripts/materialize-native-closure.sh.
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
fail=0
# Assert ONE packaged file is there and is ARM64. Every path passed here is a
# location electron-builder.ts pins (an extraResources or asarUnpack target),
# never a name some bundler chose — nothing in this gate may hinge on an
# incidental filename that an upstream merge can rename.
need_arm64() { # $1 = file, $2 = label
  if [ -f "$1" ] && [ "$(pearch "$1")" = 64aa ]; then
    echo "OK  $2 packaged (ARM64)"
  else
    echo "::error::$2 missing/!ARM64 at $1"; fail=1
  fi
}
m="$(pearch "$APP/Superset.exe")"
[ "$m" = 64aa ] && echo "OK  Superset.exe ARM64" || { echo "::error::Superset.exe not ARM64 (0x$m)"; fail=1; }
need_arm64 "$APP/resources/node_modules/@anush008/tokenizers-win32-arm64-msvc/tokenizers.win32-arm64-msvc.node" \
  "@anush008/tokenizers-win32-arm64-msvc"
# The terminal's two conpty binaries. electron-builder's `win.files` puts the
# package inside app.asar and `asarUnpack` extracts it beside it — the unpacked
# copy is the one the app loads, and its path is fixed by that config, not by
# any bundler-chosen name. The loop below only rejects a win32-arm64 .node that
# is NOT ARM64, so a package that shipped with no .node at all would pass it
# silently, and an installer whose node-pty payload is missing has no terminal.
for f in conpty.node conpty_console_list.node; do
  need_arm64 "$APP/resources/app.asar.unpacked/node_modules/@lydell/node-pty-win32-arm64/$f" \
    "@lydell/node-pty-win32-arm64/$f"
done
while IFS= read -r f; do
  case "$f" in
    *darwin*|*linux*|*musl*|*win32-ia32*|*win32-x64*|*win32_x64*|*win32_ia32*) continue ;;
  esac
  a="$(pearch "$f" 2>/dev/null || echo '')"
  if echo "$f" | grep -Eqi 'win32.?arm64|win32_arm64'; then
    [ "$a" = 64aa ] || { echo "::error::win32-arm64 native not ARM64: $f (0x$a)"; fail=1; }
  fi
done < <(find "$APP/resources" -name '*.node' 2>/dev/null)
[ "$fail" = 0 ] || { echo "::error::packaged native closure verification FAILED"; exit 1; }
echo "Packaged native closure verified (ARM64)."
