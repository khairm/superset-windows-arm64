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
  lifecycle logging (window is `show:false` until a load event that may never fire).
  Splices ADDITIVE `webContents` listeners before the `did-finish-load` registration
  (not modifications of the AI-edited handler bodies — that drifted the old git-apply
  and hard-aborted, e.g. main.ts:323) [inline]
- (AA) wispr-flow accessibility + diag (with (V) reverted). Two inline fixups:
  **(AA.1)** `main.ts` calls `app.setAccessibilitySupportEnabled(true)` so Electron
  materializes its UIA tree on Windows — this is what makes Wispr Flow recognize the
  terminal as an editable target at all (independent of `screenReaderMode`, which must
  stay false — see disabled (V)). Logs a11y state via `log.info` (main process;
  `console.log` would not reach `main.log`). **(AA.2)** `terminal-runtime.ts` instruments
  the v2 xterm textarea (every event, snapshotted sync/microtask/rAF, with
  `code`/`key`/modifier fields + a value-setter hook + a document-level `focusin` UIA
  scanner), logging `[agent-dots] [wispr-diag]` so the (W.1) forwarder persists to
  `main.log` — used to VERIFY the (AC) paste path [inline]
- (AC) windows-terminal-paste — the actual Wispr Flow terminal fix. With
  `screenReaderMode` false, Wispr injects by copying its transcript to the clipboard +
  sending a synthetic OS-level Ctrl+V. Superset's paste relies on the browser
  keydown→`paste` event (`shouldBubbleClipboardShortcut`, gated on `event.code==="KeyV"`),
  which Chrome fires only for trusted real keys — so synthetic Ctrl+V fell through and
  xterm encoded `^V` (0x16) to the PTY. Splices a Ctrl+V branch into the SHARED
  `createTerminalKeyEventHandler` (v1 + v2) just before its final `return true;`, so it
  runs ONLY for a Ctrl+V the clipboard-bubble check didn't already handle — i.e. the
  synthetic case — leaving the (confirmed perfect) MANUAL Ctrl+V path untouched. Reads
  `navigator.clipboard.readText()` (same API as right-click Paste; sandboxed renderer has
  no electron clipboard bridge) and `terminal.paste()`s it [inline]
- (Y) force-foreground — `focusMainWindow` raises past the Windows foreground lock
  so relaunch surfaces a buried window [git apply]
- (Z) v2-workspace blank-pane fix — cache-first hold-last-good in `layout.tsx` so an
  Electric re-sync can't blank the workspace content (rule-9: never blank on `!isReady`) [git apply]
- (AD) v2-pin — fork is **v2-only, forever**. Forces `useIsV2CloudEnabled()` to
  always return true (+ strips the now-unused store import) so every account
  renders v2 and all v2-targeted patches always apply; no v1 path to maintain
  [inline]
- (AE/AF/AG) **non-git / multi-repo workspaces** — open ANY folder, not just a git
  repo. Upstream hard-wires 1 workspace = 1 branch = 1 repo; git-ness is the
  filesystem truth via `isGitRepo()` (live `git rev-parse --is-inside-work-tree`,
  cached) — no persisted flag, no schema migration (the cloud `branch` NOT-NULL col
  gets an inert, gated `NON_GIT_BRANCH` marker that never reaches git).
  **(AE)** [git apply `nongit-workspaces.patch`, applied BEFORE (L) so (L)'s
  git-watcher hunks layer on top] — the bulk: host-service `kind:"nonGitFolder"`
  create path + `project.probePath` (renderer routes git→importLocal / non-git→
  nonGitFolder) + non-strict main workspace + server-side `isGitRepo` guards
  (`git.ts` `assertGitRepo`, pull-requests, workspace-creation procedures) +
  git-watcher fs-watch for non-git + Windows `path.isAbsolute` fix + renderer
  git-UI gating (Changes/Review/PR/branch/diff hidden) + non-git badge prop
  receivers + new `runtime/git/non-git.ts` & `useIsGitRepo` hook. **(AF)** [inline]
  `workspaces.create` non-git guard — workspaces.ts is also edited by Patch 28, so
  inline-spliced (anchor: first `requireLocalProject`), not git apply. **(AG)**
  [inline, AFTER (P)] non-git badge threaded into the two patch-(P) files
  (Item/ExpandedRow). A folder whose root isn't a repo opens as a plain non-git
  workspace (terminal+agents+file-tree work); no same-name branch fan-out (it
  doesn't exist upstream). True N-repo-in-one-workspace is OUT (needs the cloud
  schema, can't be a fork patch).
- (AH) workspace-delete-decouple — V2 workspace delete now succeeds on the FIRST
  try when the git worktree is locked on Windows. Upstream `runDestroy()` removes
  the worktree BEFORE the cloud + local-row delete and THROWS on a locked dir,
  aborting before the record is deleted → the renderer's optimistic row-hide
  (DeletingWorkspacesProvider) rolls back and the row reappears (the reported
  "delete twice"). Converts the two Step-2b throws to `warnings.push` (+ `git
  worktree prune`) so cloud+local-row delete run first-try; the locked folder is
  left on disk + surfaced as a warning. Decouple-only — the old force-remove
  PATCHES.md Patch 30 is RETIRED [git apply `workspace-delete-decouple.patch`, on
  pristine upstream — no other patch touches `workspace-cleanup.ts`]

**Agent status dots (Claude + Codex):**
- (N) agent-jsonl-watcher — tail `~/.claude/projects` + `~/.codex/sessions` JSONL,
  derive working/review/permission, emit to `notificationsEmitter`; portable Python
  SessionStart hook for per-pane mapping [git apply]. The watcher's `dbg()` (default-on,
  `~/.superset/agent-watcher-debug.log`) now also records, for Claude-Code dot debugging:
  `watch-start`/`watch-fail` (did we watch the dir), `file-first-seen`/`seed-skip`/
  `file-truncated`/`cwd-unknown-skip`, a per-chunk `chunk` summary (`newBytes`/`lineCount`/
  `cwdKnown` + an `unclassified` count & sample → catches "dot stuck idle / wrong colour"),
  and `idle-timeout-fired` (distinguishes "watcher gave up" from a real end-of-turn).
- (P) v2 per-terminal dots; (Q) v2 per-tab read (drop the workspace-level
  bulk-clear) [git apply]. ((O) v1 per-terminal dots RETIRED 2026-05-29 — fork
  is v2-only, the v1 row never renders; (P) covers v2.)
- (W) notification-logging — `[agent-dots]` diagnostics → `~/.superset/*.log` + `main.log`
  [git apply: renderer + (N)-created watcher files] **+ (W.1)** the `main.ts`
  console-message forwarder, inserted before the `if (ipcHandler)` anchor [inline]
  **+ (AB)** `log.transports.console.level = false;` inserted in the same atomic
  block so `[agent-dots]` lines stay in `main.log` and do NOT leak to electron-log's
  console transport (which was corrupting external Claude Code TUI sessions in the
  user's plain pwsh windows for this cwd) [inline]
- (AI) v2-dots-prune — reconcile the v2 notification store to LIVE panes so dots
  stop lingering/duplicating. Sources are keyed by raw terminalId and never pruned
  (the bulk pruner `clearWorkspaceStatuses` has zero callers); a terminal that
  reloads/adopts/reconnects gets a NEW id, orphaning the old source — the sidebar
  row (`selectV2WorkspaceTerminalStatuses`) still renders it (duplicate dot) and it
  keeps the workspace rollup non-green (never-clears). Adds a
  `pruneTerminalSourcesToLive` store mutator + a `V2NotificationController` effect
  that drops terminal sources absent from the workspace's live `paneLayout`
  (derived with the same `tabs→panes→terminalId` walk the dots use; skips
  layout-less workspaces so a live terminal is never pruned mid-sync) [git apply
  `v2-dots-prune.patch`, AFTER (P)+(W)]
- (AJ) watcher-ask-answer — release the RED (permission) dot to YELLOW (working)
  the moment the user ANSWERS an AskUserQuestion, instead of waiting for Claude's
  next assistant line / the 45s idle fallback (the reported "answered ask-user but
  it stayed red ~30s"). The watcher captures the AskUserQuestion tool_use id on the
  permission line (`"id":"toolu_…","name":"AskUserQuestion"`) and, when the matching
  `tool_result` (the answer) arrives, transitions permission→working. Matched on the
  EXACT tool_use_id so unrelated tool_results never clear the dot (the false-clear
  the `isUserLine` comments warn about) [git apply `watcher-ask-answer.patch`, AFTER
  (N)+(W)]. NOTE: a faster-green / lower idle-timeout change was considered and
  SKIPPED — explicit-stop markers (`stop_hook_summary`/`turn_duration`/`Stop`) are
  written natively to the transcript and already caught by `isExplicitStop`, so
  healthy in-Superset turns go green promptly; the 45s idle fallback only bit
  degraded/external sessions. Lowering it would risk false mid-turn "review"
  flapping. (Diagnosis: `tmp/dots-and-delete-diagnosis.html`.)

**Disabled (kept in `patches/` for reference, NOT applied):**
- (U) v2-cwd-fallback — hung the renderer at `V2NotificationController` mount.
- (V) xterm `screenReaderMode: true` — **was the Wispr Flow regression.** xterm's
  `_inputEvent` forwards programmatic `insertText` to the PTY ONLY when
  `screenReaderMode` is false; with it true, Wispr's injected text is silently dropped
  (keyboard + Ctrl+V use other paths, so they kept working). xterm's default (false) —
  what VS Code ships — is correct. UIA reachability comes from (AA.1), not this. The
  post-compile guard is now INVERTED: it hard-aborts if `screenReaderMode` is truthy.
  DO NOT re-enable (wrongly re-enabled twice already).
- (X) terminal-tab-focus-trap — only existed to compensate for (V)'s Tab side-effect;
  redundant once `screenReaderMode` is false (xterm cancels Tab natively). Reverted with (V).

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
