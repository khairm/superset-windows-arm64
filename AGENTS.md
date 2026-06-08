# superset-windows-arm64

Public repo: https://github.com/khairm/superset-windows-arm64

Build-automation repo (NOT app source). It produces a native **Windows ARM64**
one-click installer of [superset-sh/superset] carrying our fork's feature set.

## Architecture

We track upstream superset while maintaining our own features, using AI to keep
the two in sync:

- **Build now (manual).** A `workflow_dispatch` run builds the current upstream
  tag with our features layered on and publishes a `<tag>-beta` installer for
  e2e testing. This is what you trigger when you want a build immediately.
- **Overnight (scheduled).** When superset ships a **new release**, the pipeline
  clones it and **uses AI to incorporate that new version into our fork** — it
  carries upstream's improvements forward and re-applies our features onto the
  new base, adapting them where upstream moved code. Then it builds the ARM64
  installer and publishes a full Release. If upstream's latest is a tag we've
  already released, the scheduled job does nothing (build-once).

Our feature changes are recorded in `patches/` (+ `PATCHES.md`); the pipeline
re-incorporates them onto each new upstream. When a change no longer fits the
new upstream cleanly, the pipeline asks AI to re-fit it in-build and re-verifies;
if it still can't, the **build hard-aborts** — we never ship a partial fork.

## Non-negotiables

- **Whole feature set or fail loud.** Every feature applies or the build aborts.
  Never ship a partial fork; never silently skip a feature.
- **v2-only, forever.** The v2 cloud/host-service stack is pinned on; never target v1.
- **No build-time type/test gate.** The build runs electron-vite/esbuild only —
  no tsc, biome, or tests. Type/format errors will NOT fail the build. Validate
  changes locally and exercise startup / login / terminal / agents / WisprFlow /
  the new feature end-to-end before shipping.
- **AI re-incorporation needs Claude quota.** The overnight/manual AI steps use
  `CLAUDE_CODE_OAUTH_TOKEN`; if that account is rate-limited the build aborts
  rather than ship a half-merged fork.

## Features (high-level + UX, for a full rebuild)

- **Native Windows ARM64 packaging** — one-click NSIS installer; ARM64 node-pty,
  libsql, tokenizers; renderer CORS for `superset-app://`.
- **Window controls** — native `titleBarOverlay` is the SOLE min/max/close set on
  Windows, colour theme-matched to the app background (dark/light); upstream's
  duplicate cross-platform controls are hidden on Windows.
- **Windows behaviour fixes** — skip the quit-confirmation dialog on close;
  cmd.exe shell fallback; force-foreground on launch; hidden-window watchdog;
  WebGL first-paint recovery; Wispr Flow accessibility + paste fix (UIA reachable
  WITHOUT xterm screenReaderMode); fast non-blocking startup (no main-thread fs).
- **Agent status dots (Claude + Codex)** — a coloured dot per terminal + a
  workspace rollup: **red** = needs input (permission / a pending
  AskUserQuestion), **yellow** = working (held while background subagents run),
  **green** = ready for review, **blue** = a foreground shell command or a
  cloud/background session is running. Precedence **red > yellow > green > blue**.
  Reliable on Windows (host-service lifecycle POSTs + a JSONL watcher fallback);
  only currently-open tabs are represented.
- **Non-git / multi-repo workspaces** — open a non-git or multi-repo folder as a
  plain workspace (no branch/worktree); the project "+" opens its main workspace;
  per-project badges.
- **Thread snooze / archive** — per-thread timed Snooze (auto-returns) + sticky
  Archive, surfaced under per-project revealable Snoozed / Archived sidebar
  sections.
- **Sidebar** — top-level projects tier-sorted **pinned > active > idle**, stable
  manual drag order within each tier; right-click Pin/Unpin.
- **Terminal links** — plain click on a URL copies it (Ctrl/Cmd+click opens);
  plain click on a file path copies it, Ctrl/Cmd+click opens it in the OS default
  app (`.html` → browser).
- **Agent-hook bash-wrap** — Gemini/Cursor `.sh` hooks run via Git-for-Windows
  bash instead of opening in an editor.
- **Kanban board (Tasks & PRs → Kanban)** — a single device-local board that
  **mirrors every branch as a card** plus a fixed **Queued** column for tasks
  with no branch yet. A card shows its title, the `repo / branch` it belongs to,
  a **date deadline** (yellow on the due day, red after), and the live status
  dot. Double-click the title/deadline to edit inline; a Queued card single-click
  opens a modal (title / description / deadline). Drag a Queued card out of
  Queued to **promote** it — pick a repo to create a new git branch, or attach to
  a non-git repo's existing main card (merge). Click a branch card to **collapse
  the board to a left rail and open that branch's workspace** (terminals /
  changes / files); its task details get a **Card** tab beside Files/Changes/
  Review. Columns are user-created (add / rename / reorder / delete; deleting
  moves cards left); each has collapsible Snoozed / Archived sections. Per-column
  sort is manual drag with a display-only sort-by-deadline toggle. Snooze/archive
  and delete of a branch card are the SAME as the sidebar (one source of truth);
  main workspaces can't be snoozed/archived/deleted from the board. Local-only
  (no cloud sync), ungated.

## Key files

- `.github/workflows/nightly-build.yml` — the full pipeline (detect → clone → AI
  incorporate → ARM64 build → publish). The mechanism detail lives in its step
  comments.
- `patches/` + `PATCHES.md` — where our feature changes are recorded and
  re-incorporated from. `.gitattributes` forces `patches/*.patch` (+ `*.sh`,
  `*.mjs`, `*.snippet`) to LF — CRLF breaks application on the Linux runner.
- `scripts/materialize-native-closure.sh`, `scripts/resolve-release-age.mjs`,
  `scripts/fixup-snippets/`.
- Companion ARM64 native packages: `github.com/khairm/libsql-windows-arm64`,
  `github.com/khairm/tokenizers-windows-arm64`.

## Traps (do NOT repeat)

- **Never do synchronous/blocking fs on the main thread at startup** — it starves
  the renderer's `superset-app://` loader and the window stays blank for minutes
  (the watchdog can't fire). Use async, yield-chunked I/O.
- **Never re-enable xterm `screenReaderMode`** — it was the Wispr Flow regression
  (drops injected `insertText`). UIA reachability is achieved another way.
- **Don't blank the v2 workspace on `!isReady`** — TanStack/Electric live queries
  are cache-first: render existing rows; only gate the empty/loading branch on
  readiness; wait for strict readiness before seeding/writing defaults.

## Limitations (accepted)

- Unsigned → SmartScreen warns.
- The build has no type/test gate (see non-negotiables) — validate + e2e locally.
- Daemon updates can't preserve sessions on Windows (upstream gates fd-handoff on
  `IS_WINDOWS`).
- An auto-incorporated build can ship a full Release unattended, gated only by
  esbuild + per-feature marker checks — a semantically-wrong-but-compiling AI
  re-fit could ship. e2e-test betas before relying on a release.
