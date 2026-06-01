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
  workspace-delete decouple — a locked worktree no longer blocks delete (AH)[git];
  thread snooze/archive — per-thread timed Snooze + sticky Archive with per-project
  revealable Snoozed/Archived sections (AL)[git]; startup cold-start timing →
  `main.log` via `log.info` (AM)[inline]; non-blocking agent-watcher seed + gated
  discover poll + boot phase logging + event-loop lag guard (AN)[git] — fixes the
  intermittent multi-minute blank-window cold start: the dots watcher did BLOCKING
  fs on the main thread (sync 8 KB-header seed over ~11k `~/.claude`+`~/.codex`
  files, AND a 12 s discover poll that synchronously replayed every first-seen
  file's full body ~5.6 GB when it raced the seed), starving the renderer's
  `superset-app://` loader (found via boot trace + I/O measurement;
  `[boot]`/`[boot-renderer]` logs in main.log pinpoint any future stall);
  gemini/cursor agent-hook bash-wrap (AO)[git] — Gemini + Cursor write their hook
  `command` as a raw `~/.superset/hooks/<agent>-hook.sh` path, which Windows
  ShellExecutes, so the file OPENS in the user's default `.sh` editor instead of
  running (the "random .sh text file pops open" bug). `buildAgentHookCommand`
  wraps it in Git-for-Windows `bin/bash.exe` (MSYS so the hook's grep/sed/curl
  resolve; forward-slash path; NEVER System32 WSL bash — it can't read `C:/`);
  when no Git bash is found it writes no managed entry AND reconcile drops any
  stale raw-.sh entry (self-healing, no popup). POSIX output byte-for-byte
  unchanged. Copilot intentionally EXCLUDED — project-level `bash:`-field hook
  (different exec model); verify before wrapping it.
- **Agent status dots (Claude+Codex)**: JSONL watcher → notificationsEmitter +
  pane-map hook (N)[git]; v2 per-terminal dots (P) + per-tab read (Q)[git];
  `[agent-dots]` logging (W)[git] + main.ts console forwarder (W.1) + console-transport
  off (AB)[inline]; red→working on the AskUserQuestion answer (AJ)[git]; fs.watch
  poll-fallback so dots are reliable on Windows — fs.watch drops trailing
  appends/creates, which caused "ask-user stayed green" + "no dot on respond"
  (AK)[git]. ((AI) prune-orphans REVERTED — it removed LIVE sources inside
  Superset, causing "no dot"; revisit duplicates with a safer approach.)
  watcher-dot-accuracy (AP)[git, after AN] — three fixes: pendingToolUseIds so
  the 45 s idle never false-greens while a shell/build/Task tool runs ("green
  while working"); read the AskUserQuestion marker dir to drive RED
  deterministically (JSONL read lag on Windows shows the question line tens of s
  late); mirror BACKGROUND subagent activity (`<cwd>/<sid>/subagents/agent-*`)
  to the PARENT terminal so it stays YELLOW while subagents run even after the
  main agent Stops. ask-marker-hook (AQ)[git, after N] — Python PreToolUse +
  PostToolUse:AskUserQuestion hook (uv-run, Windows-safe like pane-map) writes/
  deletes `~/.superset/agent-ask-pending/<sid>.json` that (AP) polls. render-dot
  logging (AR)[git, diagnostic] — 1 s snapshot of the v2-notifications store →
  `~/.superset/agent-dot-render.log` to match rendered colour vs the watcher
  emit log. Root cause was emit-side (idle false-green + ask read-lag), proven
  from `~/.superset/agent-watcher-debug.log` — but the REAL fix is (AS) below.
  windows-notify-hook (AS)[git, after AP/AQ/AR] — REVIVES System 2 on Windows
  for Claude. A Windows-safe Python port of the dead bash notify.sh
  (`superset-notify.py`, uv-run, stdlib urllib) POSTs each Claude lifecycle
  event to the host-service (`$SUPERSET_HOST_AGENT_HOOK_URL` +
  `$SUPERSET_TERMINAL_ID` are injected per-terminal; proven live: Start→working,
  Stop→review, PermissionRequest→red, through upstream's own mapEventType→store→
  render). PURE event-driven — NO 45 s idle, NO 2.5 s poll, NO TTLs (owner
  banned timing fallbacks). `mergeNotifyHook` registers it on UserPromptSubmit/
  Stop/SessionEnd/Notification(permission_prompt)/PreToolUse(AskUserQuestion)/
  PostToolUse + self-heals stale (AQ) ask-marker entries. RETIRES System 1 for
  Claude: gates ALL Claude main JSONL lifecycle, keeps ONLY the background-
  subagent mirror (force-asserts YELLOW so a POST-green can't stick while a bg
  subagent runs; greens on the next main POST Stop — may linger yellow till next
  turn, the safe no-timer direction) + an interrupt→review release (Claude fires
  no hook on ESC); DELETES the (AP) idle/pending-tool heuristics + the (AQ) ask-
  marker path for Claude. Codex STILL uses the JSONL state machine (no host-
  service hook yet — [[project_codex_dots_plan]] is the Codex follow-up).
  Hardened by a 16-agent swarm review (caught a TDZ ReferenceError crash + a
  subagent false-green pre-ship; build runs no tsc so scope/type errors are
  caught by review + esbuild + py_compile + node-repro, not the build). Net:
  System 2 (host-service POST) drives Claude; System 1 (JSONL) drives Codex +
  the Claude bg-subagent mirror.

## Traps (do NOT repeat)

- **Never do synchronous/blocking fs work on the main thread at startup — and
  DEFERRING isn't enough if the work is still synchronous.** The agent-dots watcher
  starved the renderer's `superset-app://` loader two ways: a sync 8 KB-header seed
  over ~11k files, and a 12 s discover poll that synchronously REPLAYED every
  first-seen file's full body (~5.6 GB) when it raced the deferred seed. The window
  stayed blank for minutes and the (T) watchdog couldn't fire ("watchdog cleared but
  never fired"). Use async I/O (`fs.promises`), yield-chunk the walk, AND gate the
  discover poll until the seed tails every file to EOF so it never replays history —
  see (AN). (AN-v1 only deferred+chunked the seed but kept sync reads and an
  un-gated discover poll, which made it WORSE — confirm fixes by I/O measurement.)
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
