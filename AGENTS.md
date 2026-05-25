# superset-windows-arm64

Public repo: https://github.com/khairm/superset-windows-arm64

A **build-automation repo**, not app source. It produces a native Windows
**ARM64** (`aarch64`) one-click installer of [superset-sh/superset](https://github.com/superset-sh/superset).

## Layout

- `.github/workflows/nightly-build.yml` — nightly: detect new upstream release →
  clone → Claude Code applies `PATCHES.md` → deterministic fixup step (ARM64
  arch, native-closure, source patches A–S incl. `git apply` of `patches/*.patch`)
  → `electron-builder --win --arm64` → publish Release.
- `PATCHES.md` — the Windows-compat patches (AI-applied each night).
- `patches/*.patch` — deterministic `git diff` patches the workflow `git apply`s
  (idempotent + fail-fast). Used for multi-line code fixes too brittle for
  anchor-regex — `git-storm-fix.patch` (host-service `.git/`-watch
  feedback loop that pegged Windows; measured ~25→~0.2 git spawns/sec),
  `skip-quit-confirmation-windows.patch` (drops Patch 19's quit-confirmation
  dialog from `window.on("close")` on Windows — the dialog is a `#32770`
  parented to the main window, easy to miss when alt-tabbed, hangs Electron
  main on the `await` and holds the single-instance lock so the next launch
  silently no-ops; supersedes the misdiagnosis in `kill-on-close.patch`),
  `agent-jsonl-watcher.patch` (Claude + Codex state-indicator: bash hook
  chain is broken across 4 layers on Windows, so we tail JSONL
  transcripts from `~/.claude/projects/` and `~/.codex/sessions/`,
  derive working/review/permission lifecycle, install a portable Python
  SessionStart hook for precise per-pane mapping, and emit into
  Superset's `notificationsEmitter` — green/amber/red badges, see
  `patches/agent-jsonl-watcher.patch` + companion `pane-map-hook.ts`.
  Permission (red) is driven by the `AskUserQuestion` tool_use; only
  literal `Request interrupted by user`/`Request cancelled by user`
  markers release it on ESC — broader user-line matching wrongly
  cleared it on Claude's own tool_result echoes. Writes a forensic
  log to `~/.superset/agent-watcher-debug.log` (every line
  classification + transition + emit; gate with
  `SUPERSET_AGENT_WATCHER_DEBUG=0`, rotates at 2 MB)),
  `per-terminal-dots.patch` (companion UI: one `<StatusIndicator>`
  per active terminal pane inline with the sidebar workspace name,
  replacing upstream's single rolled-up overlay),
  `v2-per-terminal-dots.patch` (the v2-workspace equivalent — adds
  `selectV2WorkspaceTerminalStatuses` + renders dots in
  `DashboardSidebarExpandedWorkspaceRow`), and
  `v2-per-tab-read.patch` (drops the workspace-level `clearWorkspaceAttention`
  bulk-clear from `handleClick`; per-tab mark-as-read survives via the
  existing `useClearActivePaneAttention` hook firing on active-pane focus),
  `windows-shell-fallback.patch` (`getDefaultShell` validates the
  resolved shell exists on PATH+PATHEXT; falls back to `cmd.exe` when
  `pwsh.exe` is configured as default but not installed — was the
  root cause of "Failed to run preset open <uuid>: spawn failed
  (shell=pwsh.exe ...)" toasts), and
  (v2-terminal-await-shell was a `.patch` but is now the inline regex fixup
  **(S)** — upstream forgot `await` on `resolveLaunchShell(baseEnv)` in
  `packages/host-service/src/terminal/terminal.ts`, leaking a Promise into
  `path.basename()` and crashing every v2 preset spawn with "The 'path'
  argument must be of type string. Received an instance of Promise". The
  line-anchored patch hard-aborted when the AI's other `terminal.ts` edits
  shifted its `@@` context even though the target line was untouched, so (S)
  now inserts the one-token `await` by regex, immune to line drift), and
  `fix-hidden-window-watchdog.patch` (the main window is created
  `show: false` and only shown from `did-finish-load`/`did-fail-load`; if
  NEITHER fires — renderer crash mid-load, or a load/visibility race under
  `superset-app://` — every `Superset.exe` stays alive but the window is
  permanently hidden ("spins up in Task Manager, nothing hits the UI").
  Adds a 12 s show-watchdog force-show + one-time renderer reload on early
  crash, and moves the window-lifecycle logs to `electron-log` so
  `main.log` captures the cause. Touches only the load/crash handlers, so
  it coexists with the close-handler patches. Guard (T) HARD-ABORTS on
  apply-failure (2026-05-25: NO skip-not-abort anywhere — every build must
  contain the full patch set or fail loudly); its multi-hunk main.ts context
  can drift with the AI patch step, so on failure the build aborts and the
  patch is regenerated/hardened rather than shipped without the watchdog), and
  `v2-cwd-fallback.patch` (**DISABLED 2026-05-22** — patch file kept in
  repo for future revival but the workflow no longer applies it. The
  applied build navigated to a v2-workspace route, fired
  `did-start-loading`, and NEVER reached `did-finish-load`: the renderer
  hung mid-mount of `V2NotificationController`, leaving terminals
  visible but with no live xterm bound to input. Static checks
  (`git apply --check`, TS compile) and `main.log` showed nothing; the
  fault only surfaced when a real Superset instance tried to mount the
  component. **Lesson:** any renderer-side patch must run end-to-end in
  a real Superset render before any user-visible install — runtime hook
  / IPC issues won't show up in build-time validation. Design intent
  preserved in `patches/v2-cwd-fallback.patch`: match `cwd` → workspace
  via each workspace's host-service worktree path, derive `terminalId`
  from the workspace's pane layout. To revive, validate at runtime that
  `getHostServiceClientByUrl` and `workspace.get` work as the patch
  assumes, and consider moving the resolver to the main process so it
  never blocks renderer mount), and
  `xterm-screen-reader-mode.patch` (**DISABLED 2026-05-25** — kept in repo
  for reference, not applied). Flipped `screenReaderMode: true` (v1
  `Terminal/config.ts` + v2 `terminal-runtime.ts`) on the THEORY it would
  expose xterm's hidden `<textarea>` to UIA for voice-to-text (WisprFlow) +
  screen readers. It BROKE WisprFlow instead: with `screenReaderMode: true`
  xterm's accessibility manager owns/syncs the textarea, so WisprFlow's
  injected text never reaches the PTY — "nothing appears" when dictating
  into a terminal (user-confirmed 2026-05-25; WisprFlow works fine in
  non-terminal boxes). Upstream default `screenReaderMode: false` is the
  known-good state (pre-(V) 1.10.2 had no (V) and WisprFlow pasted fine).
  To revive screen-reader support, expose the textarea to UIA WITHOUT
  xterm's accessibility manager clobbering injected input)), and
  `notification-logging.patch` (**logging-only**, no behaviour/logic
  change — additive diagnostics for the agent-status-dots pipeline so a
  shipped build can be used to debug flaky/inconsistent dots. Applies
  AFTER (N) and (V): the pane-map hook's Python gains a `_log()` writing
  one JSON line per invocation to `~/.superset/pane-map-hook.log`
  (every phase incl. skip-reason: missing-terminal-env / missing-session-id
  / invalid-payload-json / payload-not-object / mkdir-failed / write-failed;
  gate with `SUPERSET_AGENT_WATCHER_DEBUG=0`); the watcher gains an
  `eventId` join-key + `mapping_load` + enriched `transition` /
  `transition-suppressed` dbg records (`~/.superset/agent-watcher-debug.log`);
  `main.ts` gains a PRODUCTION `console-message` forwarder that persists
  renderer `[agent-dots]` lines to `electron-log` (`main.log`); and the
  renderer (`V2NotificationController`, `lib/lifecycleEvents.ts`, the
  `v2-notifications` store) emits `[agent-dots]` records —
  `electron_agent_lifecycle_received`, per-`return` `…_drop` with a
  `reason` (missing-workspaceId / missing-terminalId / workspace-not-loaded;
  the highest-value diagnostic), `status_transition_computed`, and
  `store_mutation`. Selectors are left untouched (hot path). Guard (W)
  HARD-ABORTS on apply-failure (mandatory in every build). The `main.ts`
  `[agent-dots]`→`main.log` forwarder (which (Z)'s blank-pane logging also
  relies on) is now inserted DETERMINISTICALLY by inline fixup **(W.1)** —
  regex `.IndexOf`/`.Insert` before the stable `if (ipcHandler) {` anchor,
  UTF-8-no-BOM round-trip — because `main.ts` is AI-edited and the old
  line-anchored git-apply hunk drifted and failed build 26419405280. The
  `notification-logging.patch` git-apply now covers only the 5 stable files
  (the two (N)-created watcher files + `V2NotificationController` /
  `lifecycleEvents` / the `v2-notifications` store); marker
  `pane-map-hook.log`), and
  `terminal-tab-focus-trap.patch` (**DISABLED 2026-05-25 with (V)** — kept
  in repo for reference, not applied). Only ever existed to counteract (V)
  `screenReaderMode: true`'s Tab focus-escape side-effect (xterm no longer
  cancelling the Tab keydown default). With (V) disabled (screenReaderMode
  back to default false), xterm cancels Tab's default itself, so Tab stays
  in-terminal without this patch — it is unnecessary. Revive only if (V)
  is ever revived)), and
  `windows-force-foreground.patch` (`focusMainWindow()` — the second-instance /
  deep-link handler — did only `show()`+`focus()`, which Windows' foreground lock
  ignores: relaunching Superset while its window was buried in z-order behind the
  app holding the foreground surfaced nothing (`IsWindowVisible` true, just not
  raised; distinct from the (T) hidden-window case). Adds a brief always-on-top
  pin (exempt from the lock) to force the window to the top on Windows, released
  on the next tick. Guard (Y) HARD-ABORTS on apply-failure (every build must
  include it; regenerate on drift), marker `Windows holds a foreground lock`), and
  `v2-workspace-blank-fix.patch` (the v2-workspace `layout.tsx` blanked the
  ENTIRE workspace content area — returned an empty
  `<div className="flex h-full w-full"/>` — whenever the `v2Workspaces`
  `useLiveQuery` transiently returned undefined/empty with `isReady=false` on a
  background Electric re-sync, no user action; pane stayed blank until a manual
  Ctrl+R remount. Violates upstream's own `apps/desktop/AGENTS.md` rule 9
  (cache-first: never blank existing data on `!isReady`). Fix is cache-first
  hold-last-good: keep the last resolved workspace for the current id and reuse
  it (incl. into `useRemoteHostStatus`, so the dead `hostStatus==="loading"`
  branch can't re-blank) through the transient. Also logs the per-transition
  render decision (`branch`: blank-data-not-ready / held-through-transient /
  not-found / ready) via `console.info("[agent-dots] ...")` → the (W) main.ts
  forwarder → `main.log`. `layout.tsx` is pure upstream (no PATCHES.md/AI
  overlap), so (Z) HARD-ABORTS on drift — it's a load-bearing user-facing fix;
  marker `lastResolvedWorkspaceRef`).
- `scripts/materialize-native-closure.sh` — deterministic ARM64 native modules.
- `scripts/resolve-release-age.mjs` — makes `bun install` self-healing. Upstream's
  `bunfig.toml` sets `minimumReleaseAge` (72h); a fresh upstream release can pin
  deps published inside that window (e.g. the whole expo stack), failing
  `bun install` ("No version matching … blocked by minimum-release-age"). The
  install step catches *only* that error, runs this resolver to repin each
  blocked package to its latest aged-safe version (`<=` upstream's pin, via the
  npm registry → `overrides` + dep entries), and retries (≤5×) — so the nightly
  never waits a night for packages to age. Generalises the hardcoded
  "Pin Mastra dependencies" step; any *other* install failure still fails loud.
- `scripts/fixup-snippets/*.snippet` — plain-TS fragments spliced verbatim into
  upstream files by inline fixup **(C)**, which is now **self-sufficient**: it
  rewrites `node-pty-win32-x64`→`-arm64` when the AI applied PATCHES.md Patch 12/14
  with the x64 literal, skips when the materialization is already present in *any*
  form (arm64 literal, or the AI's elaborated `copyNodePtyPlatformBinary` /
  process.arch `OPTIONAL_PLATFORM_MODULES` variant — detecting only the literal once
  injected a colliding 2nd const and TDZ-crashed `prepareNativeModules`), and
  **injects the arm64 packaging deterministically only on a total AI flake** (Patch
  14's `NATIVE_MODULE_DEPS` anchor no longer exists upstream, so it's drop-prone). (C) verifies *both* electron-builder.ts
  and copy-native-modules.ts end up arm64 — the old guard aborted only if *neither*
  had the literal, which could ship with node-pty unmaterialized. So a single
  non-deterministic AI miss can no longer abort the build.
- **NO skip-not-abort guards (2026-05-25).** Every patch/fixup HARD-ABORTS on
  apply-failure: a build either contains the COMPLETE set (latest upstream + all of
  L M N O P Q R S T V X W Y Z) or fails loudly — never ships partial. (Previously
  V/X/W/Y/T were skip-not-abort and silently dropped on AI-drift; that shipped
  incomplete builds, e.g. (W) + (Z)'s logging missing from desktop-v1.11.3-beta.)
  When a patch drifts (main.ts ones — T, W — are the AI-edited drift risk), the
  build fails with the `git apply --check` stderr logged; regenerate/harden that
  patch (deterministic regex like (S)/(C) if it keeps drifting) and re-run — do NOT
  reintroduce skipping.
- The fixup step still ends with `exit 0`: a trailing `git apply --check`/Get-Content
  can leave `$LASTEXITCODE=1` even on full success, so force a clean exit code.
- `.gitattributes` — forces `*.patch`/`*.sh`/`*.snippet` to LF; CI `git apply` on the
  Windows runner fails on CRLF.
- `README.md` — user-facing download/build docs.

Upstream app source is **not** in this repo; it's cloned fresh at build time.
Companion repos build the ARM64 native packages consumed at build time:

- https://github.com/khairm/libsql-windows-arm64
- https://github.com/khairm/tokenizers-windows-arm64

## Limitations (known, accepted — don't "fix" silently)

- **Unsigned** installer → Windows SmartScreen warns ("More info" → "Run anyway").
- **Non-deterministic** build: an AI agent applies `PATCHES.md` nightly. It
  **fails loud** (won't ship broken) but a new upstream version can flake — fix
  the patch when it does. The patch step retries 3× on transient Anthropic
  API socket drops before failing.
- **Daemon updates can't preserve sessions on Windows.** Upstream gates
  fd-handoff on `IS_WINDOWS` (`DaemonSupervisor.ts`); "Force restart" closes
  open terminals. This is **upstream behaviour, not a fork bug** — leave it.
- Static checks can't prove zero missing native deps; only startup / login /
  terminal / agents are exercised end-to-end.
