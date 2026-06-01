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
  fix (L)[git]; skip quit-confirm (M)[inline] + before-quit Windows gate (M2)[inline,
  after M — deep-review #2: the AI Patch 19 before-quit step anchored on a
  `const shouldConfirm` that doesn't exist in 1.12.1, so the dialog still fired on
  Windows close; M2 `.Replace`s the real `if (!skipQuitConfirmation && !isDev &&
  getConfirmOnQuitSetting()) {` to add `!PLATFORM.IS_WINDOWS &&`]; webgl render
  recovery (AV)[inline, replaces retired AI Patch 20 — deep-review #1: Patch 20's
  anchor (createTerminalInstance/loadRenderer/rendererRef) is gone in 1.12.1; AV
  splices `clearTextureAtlas?.()`+`refresh()` after the real
  `terminal.loadAddon(webglAddon)` in `lib/terminal/terminal-addons.ts` loadAddons
  rAF — verify first-paint on device]; cmd.exe shell fallback (R)[git];
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
  v2-dots-open-tabs (AT)[git, after AS] — the sidebar dot row (+ workspace-icon
  status + unread badge) must represent ONLY currently-OPEN terminals; a closed
  tab is never representable. (P)'s per-terminal dots rendered one dot per
  `terminal:<id>` entry in the in-memory v2-notifications store with NO
  tab-gating, so a `review` emitted ONCE at startup for a terminal never opened
  as a tab stuck green forever ("orphan/legacy green dots" — proven from
  main.log: each stuck dot had a single `None->review` store mutation, never
  cleared; store is in-memory, absent from Local Storage). Fix derives the
  workspace's OPEN-terminal id set from the persisted `v2WorkspaceLocalState`
  `.paneLayout` (useLiveQuery — the SAME cross-workspace source
  `V2NotificationController` reads) and gates the three workspace-level
  selectors (NotificationStatus / TerminalStatuses / IsUnread) to terminal
  sources in that set, INSIDE the `useV2Workspace*` hooks so all callers
  (DashboardSidebarWorkspaceItem / the actions hook / collapsed button) are
  UNCHANGED. Render-time filter only — no store mutation, no reconcile race;
  chat/manual sources ungated (chat-orphan analogue deferred). SAFE form of the
  reverted (AI) prune: signal = the renderer's open-tabs layout, NOT JSONL
  session presence (which killed live-but-quiet dots). store.ts ONLY (gated on
  P+W+AR). TRAP (caught by the codex+architect plan review): `useTabsStore` is
  the v1 tab store — EMPTY under the v2-pin (AD) — so gating against it would
  show ZERO dots everywhere; the v2 source of truth is the `v2WorkspaceLocalState`
  paneLayout collection, not `renderer/stores/tabs`.
  v2-subagent-yellow-hold (AU)[git, after AS] — keep a terminal WORKING (yellow)
  while its delegated BACKGROUND subagents run, instead of greening at the main
  agent's turn-end Stop. (AS) POSTs Stop->review(green) when the main agent ends
  its turn — but with BACKGROUND Task subagents the turn ends (Stop fires) WHILE
  they run, so the dot wrongly greened (proven: Stop POST at turn-end + the JSONL
  subagent-mirror missed the new subagent files on Windows — last mirror emit
  hours stale). Docs say Stop fires AFTER subagents, but that's the FOREGROUND
  case; background subagents outlive the turn. Fix: extend superset-notify.py
  with a NO-TIMER marker state machine keyed by the SubagentStart/SubagentStop
  `agent_id` pair key (one marker per subagent under
  `~/.superset/agent-subagent-running/<terminalId>/` + a `.mainstopped` sentinel):
  SubagentStart->Start; main Stop is SUPPRESSED while any marker exists (writes
  the sentinel, stays yellow); the LAST SubagentStop greens iff main already
  stopped; UserPromptSubmit clears the sentinel (keeps live markers); SessionEnd
  clears all. Registers SubagentStart+SubagentStop in `mergeNotifyHook`. Hook-
  dispatched (NOT fs.watch) so it's reliable on Windows; failure mode is the SAFE
  direction (a leaked marker stays yellow, never a false green). Leaves the (AS)
  JSONL subagent-mirror in place (harmless — it only ever force-yellows).
  pane-map-hook.ts ONLY. TRAP: the script is a JS template literal (backticks) —
  NO backtick chars inside the embedded Python (esbuild closes the template early
  + fails; py_compile alone won't catch it). 2 codex reviews REJECTED on a
  theoretical false-green race (SubagentStart's marker not yet written when the
  main Stop counts); EMPIRICALLY DISPOSITIONED by a live hook-ordering probe
  (temp logging hooks; settings.json hot-reloads): SubagentStart fired ~9 s
  before the main Stop (zero overlap) and `agent_id` is always present + matched
  on Start/Stop — the race needs Stop within ~150 ms of launch, which the
  architectural tool→PostToolUse→final-text→Stop gap precludes, and it
  self-corrects on the next UserPromptSubmit. Hardened agent_id (sanitized to a
  filesystem-safe marker name). Residual R2 (Stop vs last SubagentStop) is
  safe-direction (stuck-yellow, self-corrects next turn). The (AS) interrupt-
  release (ESC) still greens directly — accepted.
  red-over-yellow (AW)[git emit-tag + inline statusTransitions fixup, after AS/AU]
  — RED (AskUserQuestion/permission) must TRUMP yellow whenever both are true; a
  pending question showed YELLOW (user ignored it for ages) when background
  subagents were running. Root cause: the store is last-writer-wins and the
  renderer's `resolveV2AgentStatusTransition` maps `Start`->working
  UNCONDITIONALLY, while the System-1 background-subagent MIRROR
  (windows-notify-hook.patch `mirrorSubagentToParent`) FORCE-asserts activity on
  the parent terminal every time a fork writes its transcript. The mirror is
  blind to the POST-hook-driven red (split-brain: System 2 sets permission, the
  watcher's own `lastStatus` never sees it), so its `emit("Start")` repeatedly
  stomped the red->yellow. Fix: the mirror now emits the DISTINCT eventType
  `SubagentActive` (emit-union widened in agent-jsonl-watcher.patch); the (AW)
  inline fixup adds a `SubagentActive` branch to `statusTransitions.ts` that sets
  working ONLY when the source is not already `permission` (red wins; otherwise
  it still overrides a false-green review->working, the mirror's real job). The
  legit answer-release stays `Start` (PostToolUse) so it still clears red->working
  — that's why the mirror needed its OWN eventType rather than a blanket "Start
  never clears red". A new SubagentStart can't fire mid-AskUserQuestion (the main
  turn is single-threaded and blocked), so (AU)'s System-2 SubagentStart->Start is
  not a clobberer and was left as-is. The System-1 IPC path passes `SubagentActive`
  through unfiltered (precedent: `PendingQuestion`); validated by running the (AW)
  .Replace on the real statusTransitions.ts + esbuild.

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
- **Stale [AI] PATCHES.md instructions are a silent-skip / misapply hazard** — an
  Opus deep review (2026-06-01, 22 reviewers + adversarial verify) found several AI
  patches anchored on symbols upstream 1.12.1 renamed/removed. Dispositions:
  Patch 6 (feature-flag blank-screen) RETIRED — upstream no longer gates render on
  an undefined flag; Patch 18 (Ctrl+C/V) RETIRED — native via
  `shouldBubbleClipboardShortcut` + covered by (AC); Patch 20 (webgl recovery)
  RETIRED as [AI] → re-implemented deterministically as (AV); Patch 19 before-quit
  gate → deterministic (M2); Patch 27 (worktree base dir) re-anchored
  SATISFIED-BY-UPSTREAM (host-DB `worktreeBaseDir` + `getHostWorktreeBaseDir`; do
  NOT inject `SUPERSET_WORKTREE_BASE_DIR` — the live var is
  `SUPERSET_LEGACY_WORKTREE_BASE_DIR`, DB is source of truth); Patch 15 extended to
  the `runCommand` `\r` path; Patch 8 corrected ("~5"→7 occurrences, name
  `isSocketLive`). **Rule: a "mandatory" AI patch whose anchor has drifted must be
  RETIRED or re-anchored — never left dangling** (no gate catches a silent skip /
  scope-broken misapply under the no-tsc build).
- **ABI is derived authoritatively, not `EM+103`** — that linear guess was correct
  only at Electron 40; the real node-abi map is non-linear. nightly-build.yml now
  prefers `node-abi getAbi(EV,'electron')`, falls back to a pinned 36–42 map, and
  HARD-FAILS on an unknown major (better-sqlite3 is V8-ABI-bound; a wrong ABI
  silently fetches a crashing prebuilt that the PE-arch check can't detect).
- **KNOWN-LOW, deferred (deep-review #9):** re-importing an ALREADY-set-up *non-git*
  folder routes `useFolderFirstImport` → `project.setup({mode:"import"})` →
  `resolveLocalRepo` → `git rev-parse` → throws BAD_REQUEST. (AE) guards
  `findByPath`/`project.create` (adds `nonGitFolder`) but NOT `project.setup`'s
  import case. Fails LOUD, no corruption, narrow edge. Fix = guard `project.setup`
  import with `isGitRepo()` and route non-git through `resolveNonGitFolder` +
  `ensureMainWorkspace({nonGit:true})` — but it touches the shipped non-git feature
  and MUST be runtime-validated, so it's a separate validated follow-up, not folded
  into a fixup build.
