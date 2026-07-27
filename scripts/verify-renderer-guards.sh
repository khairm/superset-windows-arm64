#!/usr/bin/env bash
# Renderer bundle guards. Run from apps/desktop after compile:app.
# Chunk names are Rollup-derived and drift with upstream refactors
# (desktop-v1.18.0 stopped emitting config-*.js and blocked three nightlies) —
# scan every renderer asset instead of naming chunks.
set -euo pipefail

assets_dir="dist/renderer/assets"
[ -d "$assets_dir" ] || { echo "::error::renderer assets dir not found at $assets_dir"; exit 1; }

# Wispr Flow regression guard: xterm screenReaderMode must never ship truthy.
# Positive control: the option name must appear somewhere or the guard is no
# longer looking at the right artifacts — refuse to pass vacuously.
if ! grep -rlq 'screenReaderMode' "$assets_dir" --include='*.js'; then
  echo "::error::screenReaderMode not found in any renderer asset — guard target drifted, refusing to pass vacuously"; exit 1
fi
truthy=$(grep -rlE 'screenReaderMode[[:space:]]*:[[:space:]]*(true|!0)' "$assets_dir" --include='*.js' || true)
if [ -n "$truthy" ]; then
  echo "::error::screenReaderMode TRUTHY in renderer asset(s) (Wispr Flow regression): $truthy"; exit 1
fi
echo "screenReaderMode verified false across all renderer assets."
