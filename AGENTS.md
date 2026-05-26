# superset-windows-arm64

Public repo: https://github.com/khairm/superset-windows-arm64

A **build-automation repo** (not app source). Nightly it produces a native
Windows **ARM64** (`aarch64`) one-click installer of
[superset-sh/superset](https://github.com/superset-sh/superset) with our
Windows-compat fixes + enhancements applied on top.

## Objective

**One reliable build = latest upstream Superset + the COMPLETE fixed patch set,
every time.** Not per-version, not partial.

- **Every patch is mandatory — hard-abort.** A build either applies the whole set
  or fails loudly. NO skip-not-abort; never ship an incomplete build.
- **Deterministic wherever there's a stable anchor.** Changes that key on stable
  code (a unique string / anchor, not line numbers) are applied by inline
  regex/brace-match fixups or `git apply` — identical result every run.
- **AI agent for genuinely shifting code.** Where upstream code moves/varies too
  much between versions for a rigid patch, Claude Code applies it from
  `PATCHES.md` intelligently. Cost = non-determinism; the hard-abort guards +
  post-apply verification catch any miss.
- **When a "deterministic" patch starts drifting, make it MORE deterministic**
  (re-anchor on stable content — see (M)/(S)/(W.1)). Do NOT reintroduce skipping
  and do NOT just retry-and-hope.

## Pipeline (`.github/workflows/nightly-build.yml`)

detect new upstream release → clone upstream → **Claude Code applies `PATCHES.md`**
(AI, non-deterministic) → **ARM64 arch + patch fixup step** (deterministic inline
fixups + `git apply` of `patches/*.patch`, all hard-abort) → self-healing
`bun install` → `electron-builder --win --arm64` → publish Release.
Manual run on an already-built tag publishes a `<tag>-beta` pre-release.

## Current patch set

Applied to every build; the fixup step fails loud if any can't apply. Mechanism
in brackets: **[inline]** = deterministic PowerShell regex/brace-match;
**[git apply]** = `patches/*.patch` diff; **[AI]** = part of `PATCHES.md`.

**Native / ARM64 packaging** (all [inline] fixups A–K, F):
node-pty→@lydell/node-pty alias (A); bun arm64 build target (B); node-pty
win32-arm64 packaging — self-sufficient, rewrites x64→arm64 or injects (C);
validate-native made arch-aware (D); electron-builder win arch=arm64 (E); stage
`materialize-native-closure.sh` (F); NSIS oneClick installer (G); bundle
@anush008/tokenizers-win32-arm64 (I); pty-daemon `ELECTRON_RUN_AS_NODE=1` (J);
renderer CORS `allowedOrigins += superset-app://` (K).

**Windows UX / behaviour:**
- (H) native window controls (titleBarOverlay) [inline]
- (L) git-storm-fix — kill the `.git/`-watch spawn storm (~25→~0.2/s) [git apply]
- (M) skip quit-confirmation — remove Patch 19's `if (PLATFORM.IS_WINDOWS){…}`
  block from `window.on("close")` so close→quit doesn't hang [inline brace-match]
- (R) windows-shell-fallback — `getDefaultShell` → cmd.exe when pwsh missing [git apply]
- (S) `await resolveLaunchShell` — one-token await; fixes v2 preset spawn [inline regex]
- (T) hidden-window watchdog — 12s force-show + early-crash reload + electron-log
  lifecycle logging (window is `show:false` until a load event that may never fire) [git apply]
- (V) xterm `screenReaderMode: true` — exposes the hidden xterm `<textarea>` as a UIA
  TextPattern provider so Wispr Flow / screen readers can inject input. Touches BOTH
  v1 `Terminal/config.ts` AND v2 `terminal-runtime.ts` (independent xterm option objects).
  Post-compile guard verifies the flag in both built bundles [git apply]
- (X) terminal-tab-focus-trap — companion to (V): with `screenReaderMode: true`, xterm
  no longer cancels Tab's default, so without this Tab steals focus out of the terminal [git apply]
- (Y) force-foreground — `focusMainWindow` raises past the Windows foreground lock
  so relaunch surfaces a buried window [git apply]
- (Z) v2-workspace blank-pane fix — cache-first hold-last-good in `layout.tsx` so an
  Electric re-sync can't blank the workspace content (rule-9: never blank on `!isReady`) [git apply]

**Agent status dots (Claude + Codex):**
- (N) agent-jsonl-watcher — tail `~/.claude/projects` + `~/.codex/sessions` JSONL,
  derive working/review/permission, emit to `notificationsEmitter`; portable Python
  SessionStart hook for per-pane mapping [git apply]
- (O) v1 per-terminal dots; (P) v2 per-terminal dots; (Q) v2 per-tab read (drop the
  workspace-level bulk-clear) [git apply]
- (W) notification-logging — `[agent-dots]` diagnostics → `~/.superset/*.log` + `main.log`
  [git apply: renderer + (N)-created watcher files] **+ (W.1)** the `main.ts`
  console-message forwarder, inserted before the `if (ipcHandler)` anchor [inline]

**Disabled (kept in `patches/` for reference, NOT applied):**
- (U) v2-cwd-fallback — hung the renderer at `V2NotificationController` mount.

## Key files / scripts

- `PATCHES.md` — the AI-applied Windows-compat patch instructions.
- `patches/*.patch` — `git apply`'d diffs. `.gitattributes` forces them (+`*.sh`/`*.snippet`)
  to LF; CRLF breaks `git apply` on the Windows runner.
- `scripts/materialize-native-closure.sh` — deterministic ARM64 native modules.
- `scripts/resolve-release-age.mjs` — self-healing `bun install`: repins deps blocked by
  upstream's 72h `minimumReleaseAge` to the latest aged-safe version, retries ≤5×.
- `scripts/fixup-snippets/*.snippet` — plain-TS fragments spliced by inline fixups.
- Companion repos build the consumed ARM64 native packages:
  https://github.com/khairm/libsql-windows-arm64 ·
  https://github.com/khairm/tokenizers-windows-arm64

## Limitations (known, accepted — don't "fix" silently)

- **Unsigned** installer → SmartScreen warns ("More info" → "Run anyway").
- **PATCHES.md is AI-applied** → non-deterministic; a drift makes the build fail
  loud (fix/re-anchor the patch, don't skip). The patch step retries 3× on API drops.
- **Daemon updates can't preserve sessions on Windows** (upstream gates fd-handoff on
  `IS_WINDOWS`); "Force restart" closes terminals — upstream behaviour, leave it.
- Static checks can't catch missing native deps or renderer runtime bugs — exercise
  startup / login / terminal / agents / WisprFlow end-to-end before shipping.
</content>
