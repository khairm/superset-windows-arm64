# superset-windows-arm64

Public repo: https://github.com/khairm/superset-windows-arm64

Build-automation repo (NOT app source). Nightly: clone latest upstream
[superset-sh/superset], apply our Windows-compat + enhancement patch set, build a
native Windows **ARM64** one-click installer, publish a Release. A manual run on an
already-built tag publishes `<tag>-beta` for e2e testing.

Per-patch rationale lives in the `nightly-build.yml` step comments, the patch files,
`PATCHES.md`, and code comments — keep detail THERE, keep this file an index.

## Non-negotiable rules

- **Every patch is mandatory — hard-abort.** The whole set applies or the build
  fails loud. Never skip-not-abort; never ship partial.
- **v2-only, forever** — (AD) pins `useIsV2CloudEnabled()`→true. Never target v1.
- **Deterministic where there's a stable anchor** ([inline] regex/brace-match or
  [git] `git apply`); [AI] `PATCHES.md` only for code that moves too much per
  version. When a deterministic patch drifts, RE-ANCHOR it — don't reintroduce
  skipping or retry-and-hope.

## Pipeline (`.github/workflows/nightly-build.yml`)

detect upstream release → clone → **Claude applies `PATCHES.md`** (AI) → ARM64 arch +
fixup step ([inline] fixups + `git apply patches/*.patch`, all hard-abort + post-apply
verify) → self-healing `bun install` → `electron-builder --win --arm64` → publish.

## Patch set

Mechanism in brackets. Tags match `Write-Host "(X)..."` in the workflow.

- **Native / ARM64 packaging** [inline]: node-pty→@lydell alias (A); bun arm64
  target (B); node-pty win32-arm64 packaging (C); arch-aware validate-native (D);
  electron-builder win arm64 (E); stage `materialize-native-closure.sh` (F); NSIS
  oneClick (G); bundle tokenizers-win32-arm64 (I); pty-daemon `ELECTRON_RUN_AS_NODE`
  (J); renderer CORS `superset-app://` (K).
- **Windows UX / behaviour**: titleBarOverlay window controls (H)[inline]; git-storm
  fix (L)[git]; skip quit-confirm (M)[inline]; cmd.exe shell fallback (R)[git];
  `await resolveLaunchShell` (S)[inline]; hidden-window watchdog (T)[inline]; Wispr
  accessibility/UIA (AA.1)[inline] + diag (AA.2)[inline]; windows-terminal-paste —
  the real Wispr fix (AC)[inline]; force-foreground (Y)[git]; v2 blank-pane
  hold-last-good (Z)[git]; v2-pin (AD)[inline]; non-git/multi-repo workspaces — bulk
  (AE)[git, before L] + create-guard (AF)[inline] + badge (AG)[inline];
  workspace-delete decouple — a locked worktree no longer blocks delete (AH)[git].
- **Agent status dots (Claude+Codex)**: JSONL watcher → notificationsEmitter +
  pane-map hook (N)[git]; v2 per-terminal dots (P) + per-tab read (Q)[git];
  `[agent-dots]` logging (W)[git] + main.ts console forwarder (W.1) + console-transport
  off (AB)[inline]; prune orphan dots to live panes (AI)[git]; red→working on the
  AskUserQuestion answer (AJ)[git].

## Traps (do NOT repeat)

- **Never re-enable xterm `screenReaderMode`** — it was the Wispr regression (drops
  injected `insertText`); the post-compile guard hard-aborts if truthy. UIA
  reachability comes from (AA.1), not this. (Wrongly re-enabled twice already.)
- Disabled, kept in `patches/` for reference, NOT applied: (U) v2-cwd-fallback (hung
  the renderer), (V) screenReaderMode, (X) tab-focus-trap. (O) v1 dots retired
  (v2-only). Don't blank the v2 workspace on `!isReady` (Z / cache-first rule-9).

## Key files

- `PATCHES.md` — AI-applied patch instructions. `patches/*.patch` — `git apply`
  diffs; `.gitattributes` forces them (+`*.sh`/`*.snippet`/`*.mjs`) to LF (CRLF
  breaks `git apply` on the Windows runner).
- `scripts/materialize-native-closure.sh`; `scripts/resolve-release-age.mjs`
  (self-healing `bun install` past upstream's 72h `minimumReleaseAge`);
  `scripts/fixup-snippets/*.snippet`.
- Companion ARM64 native pkgs: github.com/khairm/libsql-windows-arm64 ·
  github.com/khairm/tokenizers-windows-arm64.

## Limitations (accepted — don't silently "fix")

- Unsigned → SmartScreen warns. `PATCHES.md` is AI-applied → non-deterministic (drift
  fails the build loud; re-anchor, don't skip). Daemon updates can't preserve
  sessions on Windows (upstream gates fd-handoff on `IS_WINDOWS`).
- **The build runs no test / biome / tsc** (`compile:app` = electron-vite/esbuild
  only), so type/format errors won't fail it — validate patches locally and exercise
  startup / login / terminal / agents / WisprFlow end-to-end before shipping.
