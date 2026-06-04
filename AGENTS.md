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
  discover poll + boot phase logging + event-loop lag guard (AN)[git] + (AN-import)
  [inline, before AN] — (AN)'s `import log from "electron-log/main"` was MOVED out
  of the [git] patch (its top-of-imports hunk `@@ -1,4 +1,5 @@` was perturbed
  ~50% of runs by the AI-applied Patch 23 inserting its own import in that block →
  intermittent `git apply` HARD-FAIL at index.ts:1, "retry-and-hope" wasted 2+
  builds) into a deterministic inline fixup anchored on the stable single line
  `import path from "node:path";` (AI never edits it; idempotent). Per the
  re-anchor-don't-retry rule. (AN)[git] now only carries the mid-file boot hunks
  (stable context). Fixes the
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
  rate-limit-stop-green (AX)[git, in windows-notify-hook + v2-subagent-yellow-hold]
  — when a Claude turn ENDS on an API rate-limit/error, the dot stayed YELLOW
  forever. Claude Code fires NO `Stop` hook on an API error — it fires a separate
  **`StopFailure`** hook (matchers rate_limit/server_error/billing_error/
  authentication_failed/unknown; notification-only — output ignored but it can run
  our POST). Authoritatively confirmed via Claude Code docs ("Stop hooks do not
  fire on user interrupts. API errors fire StopFailure instead"). Fix is HOOK-based,
  NOT JSONL text-matching (the user correctly rejected a `"Server is temporarily
  limiting requests"` transcript-grep as the fragile thing the System-2 hook design
  retired): `mergeNotifyHook` registers `{ event: "StopFailure" }` (no matcher = all
  error types), and `_decide_event_type` runs it through the **SessionEnd** branch
  (`_clear_dir(run_dir)` + `_remove(sentinel)` + return "Stop"/green). Treated like
  SessionEnd — NOT a plain Stop — because a rate-limit kills the WHOLE tree (main +
  subagents share the API), so the leaked (AU) subagent markers from rate-limited
  subagents (whose SubagentStop never fired — undocumented for the error case) must
  be cleared, and the green must NOT be suppressed by the yellow-hold. The ONLY
  remaining JSONL-detected case is ESC mid-turn (docs confirm NO hook fires on
  interrupt) — that stays the documented (AS) exception. ([[project_dots_open_tabs_and_subagent_hold]])
- **shell-running dot (AY)**[git, after AT/AU] — a pulsing **BLUE** per-terminal
  dot (+ workspace-icon rollup) when a FOREGROUND command is running in the
  shell, cleared instantly on finish. Detection is OSC 133 **C** (command-start,
  pre-exec) / **D;`<exit>`** (command-end, precmd); running = saw C, no D yet.
  Self-heals: a later `133;A` (prompt redraw) while running synthesizes a
  command-end (exit unknown) — pure event-driven, NO timers/polling, and the
  existing `133;A` shell-ready detection still works (the new C/D scanner only
  engages once shell-ready is past `pending`, then it also strips A). Precedence
  is **agent > blue** (permission > working > review > shell-running > idle): blue
  shows ONLY when no agent state. CRITICAL design: shell-running is a SEPARATE
  store axis (`shellRunningTerminals: Record<terminalId,{workspaceId,occurredAt}>`)
  — NOT a 5th `PaneStatus`, NOT in the `sources` record or
  `getHighestPriorityStatus`; the precedence merge is RENDER-time only
  (`useV2WorkspaceDisplayStatus` for the icon + the refactored
  `useV2WorkspaceTerminalStatuses` returning `{terminalId,status:DisplayStatus}[]`),
  REUSING the (AT) `useV2WorkspaceOpenTerminalIds` gate so closed/never-opened tabs
  are never representable. NEW byte-scanner
  `packages/shared/src/shell-osc133-cd-scanner.ts` mirrors `shell-ready-scanner.ts`
  (held-bytes/strip, chunk-spanning, BEL or ST terminator, tolerates `D;<exit>;<aid>`
  extras); host-service `terminal.ts` runs it in `onOutput` after `scanForShellReady`
  and broadcasts `command-start`/`command-end` via the WIDENED
  `terminal:lifecycle` union (events/types.ts + workspace-client eventBus.ts);
  renderer `lifecycleEvents.ts` sets/clears the blue axis (NO sound/notification).
  Shells: bash (`trap DEBUG`→C, latched once/line + cleared at precmd; D;`$?` in
  `__superset_prompt_mark`), zsh (`preexec_functions`→C; D;`$?`), fish
  (`fish_preexec`→C; D;`$status` in fish_prompt) — both the agent-setup
  `shell-wrappers.ts` AND the v2 host-service `shell-launch.ts` fish init. pwsh is a
  **SEPARATE `superset-pwsh-integration.ps1`** written by `createPwshWrapper()`
  (dot-sourced via `-NoExit -ExecutionPolicy Bypass -Command ". '<ps1>'"`, path
  single-quoted with `'`→`''` escaping for `C:\\Users\\O'Brien\\…`) — its prompt
  fn emits D+A and a PSReadLine Enter-chord handler emits C ONLY when
  `GetBufferState` reports the buffer is a COMPLETE statement (no `IncompleteInput`
  parse error), so multi-line edits don't false-blue. The .ps1 is built from
  SINGLE/DOUBLE-quoted JS strings, **NEVER a JS template literal** (pwsh
  `$LASTEXITCODE`/`$(...)`/`${}` would break the esbuild backtick template — the
  same trap as the embedded Python hooks). `getShellName` strips `\\`/`/`/`.exe`
  so `pwsh.exe` matches. CHAINING (deep-review #1): terminal.ts runs the C/D
  scanner on the OUTPUT of the shell-ready (A) pass — NOT behind an else-if — so
  the first prompt's `D;<exit>` (emitted before the first `A` by the wrappers) is
  stripped instead of leaking a visible `]133;D;0` artifact; the first `A` is
  consumed by the A-scanner before the C/D scanner sees it (each `A` handled by
  exactly one scanner, no double-strip), and a `D` with no preceding `C` strips
  but broadcasts nothing (no-op, no false blue). store.ts/StatusIndicator/sidebar
  are co-patched by P/W/AR/AT (+ AE/AG/AL for the sidebar/Icon) — authored against
  the reconstructed post-stack tree. TRAP: pwsh `133;C` on ConPTY/ARM64 is the
  on-device UNKNOWN — if C is unreliable, the safe fallback is D+A only for pwsh
  (drop the Enter-chord handler: no blue, never a wrong-blue; D/A still fire from
  the prompt fn). Host-service restart adopts with a fresh scan state
  (`commandRunning=false`): misses one in-flight command's blue, recovers on the
  next D/A (safe direction). ([[project_dots_open_tabs_and_subagent_hold]])
- **cloud-session blue dot (BA)**[git `cloud-session-dot.patch`, after
  AS/AU/AT/AY] — when the local Claude turn ENDS but a cloud/background session
  (e.g. `/ultrareview`, or a `run_in_background` shell) is still running, show the
  **same blue** dot (tooltip "Cloud session running"), clearing to green/idle when
  it finishes. Detection does NOT care whether YOU or the agent launched the work.
  Signal is the `Stop` hook payload's `background_tasks[]` (Claude Code ≥ 2.1.145;
  absent on older → falsy → today's behaviour — no text-parsing, the owner-banned
  fragile path). `superset-notify.py` reads `has_background` and emits a NEW
  eventType **`BackgroundRunning`** from the `Stop`/`SubagentStop` decision (after
  the (AU) `run_dir`>0 yellow-hold check, so LOCAL subagents still win → yellow;
  cloud/background tasks that fire no SubagentStart fall through to blue).
  `map-event-type.ts` widens `AgentLifecycleEventType` and passes it through.
  **PRECEDENCE IS STRICT red > yellow > green > blue** (owner rule): so
  `BackgroundRunning` is DELIBERATELY *not* handled in `statusTransitions.ts` — it
  falls through to the SAME default as `Stop` (review-or-clear, respecting
  `targetVisible`), keeping the agent dot GREEN at turn-end; a SEPARATE store axis
  `backgroundRunningTerminals` (mirrors the (AY) `shellRunningTerminals`, reuses
  `V2ShellRunningEntry`, DisplayStatus `background-running` = same blue) is set in
  `lifecycleEvents.ts updatePaneStatus`. Since agent status outranks blue, the blue
  shows ONLY once the review green clears to idle (immediate for the focused tab
  via `targetVisible`) — a running shell NEVER masks a fresh review green. Render
  precedence: **agent > shell-running > background-running > idle**, gated to OPEN
  tabs (reuses (AT) `useV2WorkspaceOpenTerminalIds`). `updatePaneStatus` sets the
  axis on `BackgroundRunning` and CLEARS it on every other agent event (OSC
  shell-running axis NEVER touched here); `handleV2AgentLifecycleEvent` suppresses
  sound/notification for it (so a bg-turn-end is silent — minor, revisitable). NO
  timers: cleared by the next Stop (bg empty → green) / UserPromptSubmit /
  SubagentStop / SessionEnd / StopFailure. CRITICAL teardown (codex REJECT→fix):
  the blue has NO OSC self-clear (unlike (AY)), so `clearTerminalBackgroundRunning`
  is ALSO called on PTY `exit` (lifecycleEvents), on Ctrl+C/Esc interrupt + pane
  close (via the shared `clearV2TerminalRunStatus` in store.ts), and on
  `clearWorkspaceStatuses` — else a stale blue lingers on a live terminal.
  Known-accepted nuance: while the `claude` CLI is the foreground command (OSC
  shell-running set), shell-running wins so the tooltip reads "Command running" —
  still blue. NO statusTransitions fixup (earlier draft cleared-to-idle, which
  inverted green>blue — corrected per owner precedence). Authored against the
  reconstructed post-(AT/AU/AY) tree; 2 reviewers (codex xhigh + code-reviewer) +
  2 fix passes (teardown/shift+alt/false-toast, then precedence).
  ([[project_dots_open_tabs_and_subagent_hold]])
- **single-click hyperlink copy (AZ)**[git `terminal-link-single-click-copy.patch`]
  — a PLAIN (no-modifier) left click on a terminal URL that the configurable click
  policy maps to "do nothing" (`urlPolicy.getAction`→null, the default `plain`
  tier) now COPIES the URL to the clipboard and flashes "Copied!" in the existing
  near-cursor hint bubble; Ctrl/Cmd+click still opens in-app (the `action!==null`
  path is unchanged). v2 path only (`TerminalPane.tsx` `onUrlClick`; v1 helpers.ts
  is dormant under (AD)). `useLinkClickHint` gains an UNCAPPED `showCopied` (the
  educational unbound-link hint stays capped at 2/session; the copy confirmation
  must show every time); `LinkHoverHint` renders `clickHint.label ?? UNBOUND_HINT`.
  Copy routes through the MAIN-PROCESS clipboard (`electronTrpcClient.external.
  copyText`, always available in Electron, avoids the renderer Async-Clipboard
  permission surface) and flashes ONLY on `.then()` success — never a false
  "Copied!" (codex REJECT→fix). Gated to PLAIN clicks: shift-click (also null by
  default) keeps the original no-op + hint (codex caught the over-broad
  `action===null`). Pristine files — no ordering dependency.
- **sidebar active-first project sort + pinning (BB)**[git
  `sidebar-active-first-sort-and-pin.patch`, after AL] — the top-level project
  lane is tier-sorted **pinned > active > idle**: pinned projects on top in
  manual drag order (right-click → Pin/Unpin, pin icon on the row), then projects
  with **open chats > 0** (the right-side badge = `getProjectChildrenWorkspaces
  (children).length`, the SAME expr the badge renders so they can't disagree),
  then idle (badge 0), each tier **most-recent-agent-activity first**. Recency =
  agent status `occurredAt` (the v2-notifications store), folded per-project to a
  max and PERSISTED on a new `v2SidebarProjects.lastAgentActivityAt` (the store is
  in-memory + resets per launch, so a writer effect persists it; write-on-increase
  only → converges, no loop — confirmed by 2 codex xhigh passes + code-review).
  New `isPinned` + `lastAgentActivityAt` fields are MANUALLY healed in
  `useDashboardSidebarData` (the collection has no `withReadHeal`). The visible
  re-sort is **idle-gated** in `DashboardSidebar.tsx`: `projectOrder` commits from
  the tier-sorted `groups` ONLY when not dragging/hovering/context-menu-open, so
  rows never move under the cursor; membership (new/removed project) is reflected
  at render by `orderedGroups` (append/drop), and pin/recency reorders apply on the
  next idle commit. Comparator reuses each project's index in `sidebarProjects`
  (tabOrder ASC) for pinned manual order + tiebreak — no new order field. TRAP
  (caught by codex xhigh, FIX-FIRST→fixed): do NOT "structural-bypass" commit the
  full order while busy (it flushes queued recency reorders under the cursor +
  mutates SortableContext mid-drag); context-menu-open MUST be in the busy signal
  (the portalled menu fires the list's onPointerLeave). ([[project_sidebar_active_first_sort]])
- **terminal file-path link copy / open-in-OS (BC)**[git
  `terminal-filepath-link-open-copy.patch`, after AZ] — companion to (AZ) for the
  FILE link handler (`TerminalPane.tsx onFileLinkClick`): a PLAIN (no-modifier)
  click copies `link.resolvedPath` (clean, suffix-free) + flashes "Copied!"
  (reuses AZ's uncapped `showCopied`); a **Ctrl/Cmd (no-shift)** click on a LOCAL
  workspace opens the file in its OS default app via a NEW
  `external.openInDefaultApp` (`shell.openPath` — `.html` → default BROWSER,
  everything else → its default app; one primitive, NO `file://` via `openUrl`
  which the scheme allowlist rejects). Gated to (a) local workspaces — `shell.
  openPath` runs in the local main process, so a REMOTE path keeps upstream open
  behavior — `isLocalWorkspace` also accepts `local-starting`; and (b) the EXACT
  Ctrl/Cmd gesture, so a user's other configured tiers (shift / Ctrl+Shift / a
  custom plain mapping) still honor their action (open-in-editor with line/col)
  rather than being hijacked (codex xhigh HIGH→fixed). MUST apply after (AZ)
  (shares TerminalPane.tsx). ([[project_dots_open_tabs_and_subagent_hold]])
- **non-git project "+" opens main (BD)**[git `nongit-plus-opens-main.patch`] —
  the "+" (new workspace) on a NON-GIT project hit the (AF) guard ("Cannot create
  a branch/worktree in a non-git workspace") — a dead end. `handleNewWorkspace`
  resolves the project's main workspace across ALL buckets
  (`getProjectChildrenWorkspaces(children)` flattens sections, + snoozed +
  archived — codex/reviewer caught the section-nested/snoozed miss) and, when it
  is non-git (`useIsGitRepo`, which defaults true while loading so it only diverts
  for a CONFIRMED non-git project; empty id → enabled:false → stays git → modal),
  navigates to it (`/v2-workspace/$workspaceId`) instead of opening the create
  modal. Git projects unchanged. Pristine file — order-independent.
  ([[project_nongit_multirepo_workspace_feature]])

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
