# superset-windows-arm64 — fork maintenance guide

This repo is a **vendored fork** of [superset-sh/superset]: the full upstream
source with our Windows ARM64 + feature changes committed on top, plus the CI
that builds a native **Windows ARM64** one-click installer.

> This is the fork's own guide. Upstream superset's developer docs (`AGENTS.md`,
> `CLAUDE.md`, `DEVELOPMENT.md`, …) are left intact for working on the app code.

## Architecture

The fork is the source of truth; we track upstream by **merging its deltas**, not
by re-applying our changes.

- **Baseline (frozen).** The whole fork lives as committed source. Building it is
  deterministic and **AI-free** — `.github/workflows/build-arm64.yml` just does
  install → compile → materialize the win-arm64 native closure → package the NSIS
  installer → verify the packaged natives are ARM64. No upstream clone, no patch
  apply, no arch-fixup. `.fork/upstream-baseline.txt` records the upstream tag the
  baseline currently sits on.
- **Nightly (minimal AI).** `.github/workflows/nightly-merge.yml` runs nightly:
  if upstream published a newer `desktop-v*` tag, it `git merge`s that tag in.
  Git's 3-way merge resolves the non-conflicting majority deterministically; an
  **Opus** model (`--effort high`) resolves **only the conflicted files**,
  preserving every feature. AI cost scales with the **size of the upstream
  delta**, not with how large our fork grows.
- **Gates.** After the merge: every marker in `FEATURES.md` must still be present
  (else a feature was dropped → reject), then the deterministic build must go
  green. On a clean merge + green build the nightly **auto-publishes a Release**
  and advances the baseline. Any failure (unresolvable conflict, lost feature
  marker, build failure) **hard-aborts** and leaves the baseline untouched.
- **Recovery.** When a nightly merge can't be done cleanly, fix it locally with
  the maintainer, rebuild, re-freeze the baseline; the nightly then resumes
  merging only *new* upstream changes from that point.

## Non-negotiables

- **Whole feature set or fail loud.** Every `FEATURES.md` marker survives a merge
  or the build aborts. Never ship a partial fork.
- **v2-only, forever.** The v2 cloud/host-service stack is pinned on; never v1.
- **No build-time type/test gate.** The build runs electron-vite/esbuild only —
  type/format errors don't fail it. Validate + e2e locally before relying on a
  release.
- **AI only in the nightly merge.** The build is AI-free. The nightly conflict
  resolver needs `CLAUDE_CODE_OAUTH_TOKEN`; if rate-limited it aborts rather than
  ship a half-merged fork.

## Features (high-level + UX, for a full rebuild)

See `FEATURES.md` for the marker manifest. In brief:

- **Native Windows ARM64 packaging** — one-click NSIS installer; ARM64 node-pty,
  libsql, tokenizers; renderer CORS for `superset-app://`.
- **Window controls** — native `titleBarOverlay` is the sole min/max/close set on
  Windows, theme-matched; upstream's duplicate controls hidden on Windows.
- **Windows behaviour fixes** — skip quit-confirmation; cmd.exe fallback;
  force-foreground; hidden-window watchdog; WebGL first-paint recovery; Wispr Flow
  accessibility + paste fix (UIA reachable WITHOUT xterm screenReaderMode); fast
  non-blocking startup (no main-thread fs).
- **Agent status dots (Claude + Codex)** — a coloured dot per terminal + a
  workspace rollup: red = needs input, yellow = working (held while subagents
  run), green = ready for review, blue = a foreground shell command or a
  cloud/background session. Precedence red > yellow > green > blue. Host-service
  lifecycle POSTs + a JSONL watcher fallback; only open tabs are represented.
- **Non-git / multi-repo workspaces** — open a non-git or multi-repo folder as a
  plain workspace (no branch/worktree); the project "+" opens its main workspace.
- **Thread snooze / archive** — per-thread timed Snooze (auto-returns) + sticky
  Archive under revealable Snoozed / Archived sidebar sections.
- **Sidebar** — projects tier-sorted pinned > active > idle, stable manual drag
  order within each tier; right-click Pin/Unpin.
- **Terminal links** — plain click copies a URL/path; Ctrl/Cmd+click opens (`.html`
  → browser).
- **Agent-hook bash-wrap** — Gemini/Cursor `.sh` hooks run via Git-for-Windows
  bash instead of opening in an editor.
- **Kanban board (Tasks & PRs → Kanban)** — a device-local board mirroring every
  branch as a card + a fixed Queued column for tasks with no branch yet. Card
  shows title, `repo / branch`, a date deadline (yellow on the due day, red
  after), and the live status dot. Double-click title/deadline to edit; a Queued
  card single-click opens a modal. Drag a Queued card out to promote it (create a
  branch or attach to a non-git main card). Click a branch card to collapse the
  board to a left rail and open that branch's workspace; its task details get a
  Card tab beside Files/Changes/Review. User-created columns (add/rename/reorder/
  delete; deleting moves cards left), each with collapsible Snoozed/Archived.
  Snooze/archive/delete of a branch card == the sidebar (one source of truth);
  main workspaces can't be snoozed/archived/deleted. Local-only, ungated.

## Key files

- `.github/workflows/build-arm64.yml` — deterministic no-AI ARM64 build.
- `.github/workflows/nightly-merge.yml` — nightly upstream merge (Opus resolves
  conflicts) → marker gate → build → auto-publish → advance baseline; recovery on
  failure.
- `FEATURES.md` — feature marker manifest (the merge-preservation gate reads it).
- `.fork/upstream-baseline.txt` — the upstream tag the baseline currently sits on.
- `scripts/materialize-native-closure.sh` — win-arm64 native-payload repair
  (libsql/tokenizers/node-pty), invoked by the build.
- `scripts/resolve-release-age.mjs` — when a fresh upstream bump pins a dep newer
  than bunfig's `minimumReleaseAge`, resolves it to the latest aged-safe version.
- Companion ARM64 native packages: `github.com/khairm/libsql-windows-arm64`,
  `github.com/khairm/tokenizers-windows-arm64`.

## Traps (do NOT repeat)

- **Never do synchronous/blocking fs on the main thread at startup** — it starves
  the renderer's `superset-app://` loader and the window stays blank for minutes.
- **Never re-enable xterm `screenReaderMode`** — it was the Wispr Flow regression
  (drops injected `insertText`). The build hard-fails if it's truthy in either
  renderer bundle.
- **Don't blank the v2 workspace on `!isReady`** — TanStack/Electric live queries
  are cache-first: render existing rows; gate only the empty/loading branch on
  readiness; wait for strict readiness before seeding defaults.

## Limitations (accepted)

- Unsigned → SmartScreen warns.
- No build-time type/test gate — validate + e2e locally.
- An auto-merged nightly can publish a Release unattended, gated only by the
  feature-marker check + the esbuild build — a semantically-wrong-but-compiling
  merge could ship. e2e-test before relying on a release.

[superset-sh/superset]: https://github.com/superset-sh/superset
