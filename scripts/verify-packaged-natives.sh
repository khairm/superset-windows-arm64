#!/usr/bin/env bash
# Verify the packaged app's native closure is ARM64. Run from apps/desktop
# after electron-builder.
set -euo pipefail

APP="release/win-arm64-unpacked"
[ -d "$APP" ] || { echo "::error::$APP not found"; exit 1; }
pearch() { od -An -tx1 -j"$(( $(od -An -tu4 -j60 -N4 "$1"|tr -d ' ')+4 ))" -N2 "$1" | tr -d ' '; }
fail=0
m="$(pearch "$APP/Superset.exe")"
[ "$m" = 64aa ] && echo "OK  Superset.exe ARM64" || { echo "::error::Superset.exe not ARM64 (0x$m)"; fail=1; }
TOK="$APP/resources/node_modules/@anush008/tokenizers-win32-arm64-msvc/tokenizers.win32-arm64-msvc.node"
if [ -f "$TOK" ] && [ "$(pearch "$TOK")" = 64aa ]; then
  echo "OK  @anush008/tokenizers-win32-arm64-msvc packaged (ARM64)"
else
  echo "::error::@anush008/tokenizers-win32-arm64-msvc missing/!ARM64 at $TOK"; fail=1
fi
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
