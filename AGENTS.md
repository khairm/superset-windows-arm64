<!-- ===================================================================== -->
<!-- FORK MAINTENANCE (khairm Windows ARM64 fork). Everything ABOVE the -->
<!-- divider is about maintaining this fork; everything BELOW is upstream  -->
<!-- superset's own developer guide, unchanged, for working on the app.    -->
<!-- ===================================================================== -->

# superset-windows-arm64 — Windows ARM64 fork maintenance

This repo is a **vendored fork** of [superset-sh/superset]: the full upstream
source with our Windows ARM64 + feature changes committed on top, plus CI that
builds a native **Windows ARM64** one-click NSIS installer. The fork is the
source of truth; we track upstream by **merging its deltas**, not by
re-applying changes. `.fork/upstream-baseline.txt` records the upstream
`desktop-v*` tag the baseline currently sits on.

## Setup / architecture (high level)

- **Build (AI-free, deterministic).** `.github/workflows/build-arm64.yml`:
  install → compile → materialize the win-arm64 native closure
  (`scripts/materialize-native-closure.sh`: libsql/tokenizers/node-pty) →
  package the installer → verify packaged natives are ARM64.
- **Nightly merge (the only AI).** `.github/workflows/nightly-merge.yml`: when
  upstream publishes a newer `desktop-v*` tag, git merges it; Opus resolves
  conflicted files, then a `(MERGE-ADAPT)` proactive port pass adapts fork-only
  callers to cleanly-merging upstream API refactors. Deterministic gates follow
  (FEATURES.md marker survival, dependency/lock consistency, `(REFERR-GATE)`
  cannot-find-name check), then a bounded `(MERGE-SEMANTIC-GATE)` review →
  adapt → fresh-review loop (max 3 reviews / 2 repairs). Green all the way =
  build, publish the Release, advance the baseline; ANY failure hard-aborts
  with the baseline untouched → fix locally with the maintainer and
  re-baseline. A `rehearse=true` dispatch replays a night end-to-end with zero
  side effects.
- **Key files.** `FEATURES.md` (feature manifest + fenced `markers` block the
  gates parse), `.fork/upstream-baseline.txt`,
  `scripts/check-dangerous-diagnostics.mjs` (REFERR gate),
  `scripts/check-override-consistency.mjs`, `scripts/resolve-release-age.mjs`,
  companion native packages `github.com/khairm/libsql-windows-arm64` +
  `github.com/khairm/tokenizers-windows-arm64`.

## Non-negotiables

- **Whole feature set or fail loud** — every `FEATURES.md` marker survives a
  merge or the run aborts; never ship a partial fork.
- **v2-only, forever** — the v2 cloud/host-service stack is pinned on; never v1.
- **One version, ever** — exactly one Release per upstream version, tagged
  `desktop-v<version>`, rebuilt in place; no betas/prereleases.
- **No build-time type/test gate except `(REFERR-GATE)`** — the tree carries
  accepted type debt; only cannot-find-name diagnostics fail the build.
  Validate + e2e locally before relying on a release.
- **AI only in the nightly merge** (needs `CLAUDE_CODE_OAUTH_TOKEN`); the build
  is AI-free. Rate-limited/unparsable AI output aborts rather than ships.

## Custom features / overrides

`FEATURES.md` is the authoritative manifest (descriptions + marker tokens).
In brief:

- **Native Windows ARM64 packaging** — one-click installer; ARM64 node-pty,
  libsql, tokenizers; renderer CORS for `superset-app://`.
- **Window controls** — native `titleBarOverlay` is the sole min/max/close on
  Windows, theme-matched; upstream's duplicates hidden.
- **Windows behaviour fixes** — skip quit-confirm; cmd.exe fallback;
  force-foreground; hidden-window watchdog; WebGL first-paint recovery; Wispr
  Flow accessibility/paste fix; fast non-blocking startup.
- **Agent status dots (Claude + Codex)** — per-terminal + workspace-rollup dot:
  red = needs input, yellow = working (incl. subagents/teammates/compaction/
  codex-companion holds), green = ready for review, blue = shell/background/
  cloud activity; precedence red > yellow > blue > green. All surfaces (tab,
  pane header, sidebar row + agent chips, rollup, kanban card) derive from one
  per-source primitive with independent latched axes; hook-driven via
  `superset-notify.py` POSTs with self-healing markers and persistence across
  renderer reloads.
- **Auto-resume** — after an API failure, idle Claude terminals re-send
  automatically (bounded retries/budget, default-on, away-detection).
- **Recycle Bin** — every delete entry point soft-deletes (30-day display
  window); permanent delete only from inside the bin.
- **Non-git / multi-repo workspaces** — open any folder (non-git or multi-repo)
  as a plain workspace.
- **Multi-repo branch workspaces** — group N git repos under one project row;
  its "+" fans a branch out as worktrees per member (all-or-nothing, adoption
  on resume, editable membership, loud partial-state failures).
- **Workspace branch label** — branch name top-right in the tab bar; click
  copies.
- **Thread snooze / archive** — timed Snooze (auto-returns) + sticky Archive in
  revealable sidebar sections.
- **Sidebar** — pinned > active > idle tier sort with stable manual drag order;
  hover freezes re-sorting.
- **Terminal links** — plain click copies a URL/path; Ctrl/Cmd+click opens.
- **Agent-hook bash-wrap** — Gemini/Cursor `.sh` hooks run via Git-for-Windows
  bash.
- **Kanban board** — device-local board of every sidebar project's branches +
  Queued and final Completed columns, custom columns, deadlines, per-column
  date filters, promote-to-branch drag, frozen completed records, append-only
  daily JSON backups under `~/.superset/backups/kanban/`.

## Live footguns (do NOT repeat)

- No synchronous/blocking fs on the main thread at startup — the renderer's
  `superset-app://` loader starves and the window stays blank for minutes.
- Never re-enable xterm `screenReaderMode` (Wispr Flow regression); the build
  hard-fails if it is truthy in a renderer bundle.
- Never let `ws` load native bufferutil/utf-8-validate in the host-service —
  keep `WS_NO_BUFFER_UTIL=1` + `WS_NO_UTF_8_VALIDATE=1` in the coordinator
  child env AND first-import in serve.ts.
- Keep agent-hook `.sh` templates pipeline-free (bash builtins only) —
  subprocess-fork cascades crash emulated msys2 on ARM64 (`(HOOK-FORK-DIET)`).
- `.github/workflows` is fork-owned and CI's `GITHUB_TOKEN` can never push
  workflow changes — nightly-merge restores the dir mid-merge
  (`(WORKFLOW-FORK-OWNED)`); add upstream workflows only by deliberate local
  commit with a user token.

## Accepted limitations

Unsigned installer (SmartScreen warns); no full type/test gate (type debt is
accepted, `(REFERR-GATE)` only); an unattended nightly can publish a Release —
the gate stack shrinks but does not eliminate the
semantically-wrong-but-compiling window, so e2e-test before relying on one.

[superset-sh/superset]: https://github.com/superset-sh/superset

<!-- ===================================================================== -->
<!-- END FORK MAINTENANCE — upstream superset's developer guide follows.   -->
<!-- ===================================================================== -->

---

# Superset Monorepo Guide

You're running inside a Superset workspace — an isolated git-worktree copy of this repo. "Workspace" in any user message refers to this, not VS Code/editor workspaces.

## Question Tool

When you need to ask the user ANY question — including simple yes/no, confirmations, and clarifications — ALWAYS use the `ask_user` tool. Never ask questions in plain text. The Superset UI renders `ask_user` calls as an interactive overlay with clickable option buttons; plain-text questions will not be surfaced to the user in the same way.

Guidelines for agents and developers working in this repository.

## Structure

Bun + Turbo monorepo: `apps/` (web, marketing, admin, api, desktop, docs, mobile) and `packages/` — see `ls apps/ packages/` for the full list.
- Add shadcn components: `npx shadcn@latest add <component>` (run in `packages/ui/`)

## Tech Stack

- **Package Manager**: Bun (no npm/yarn/pnpm)
- **Next.js**: Version 16 - NEVER create `middleware.ts`. Next.js 16 renamed middleware to `proxy.ts`. Always use `proxy.ts` for request interception.

## Common Commands

Standard scripts live in the root `package.json` (`bun dev`, `bun test`, `bun run lint:fix`, `bun run typecheck`, ...).

```bash
# Releases (desktop + host-service + cli share one version; see scripts/release/README.md)
bun run release            # interactive: desktop release or CLI hotfix
bun run release desktop    # desktop app release (draft by default)
bun run release cli        # interim CLI hotfix (<desktop>-N prerelease)
bun run check:versions     # assert versions are unified
```

Cut releases on a dedicated release branch (not `main`); `bun run release desktop
<version> <commit>` provisions one from a commit. Full runbook: `scripts/release/README.md`.

## Code Quality

**Biome runs at root level** (not per-package) for speed — use `bun run lint:fix` to fix all issues automatically.

## CDP UI Verification

When a user asks for UI verification through the Chrome DevTools Protocol (CDP):

1. **Target the correct app instance** - confirm and report the worktree, renderer URL/port, and active route before testing. Follow any task-provided CDP/auth guidance and verify the expected signed-in session. Do not treat a different running desktop instance as equivalent.
2. **Reproduce the exact user journey** - use real browser input and visible UI navigation for the steps the user performs. Directly assigning DOM properties, invoking internal app APIs, or running component-only scripts is diagnostic support, not proof of end-to-end behavior.
3. **Capture visual and numeric evidence** - take before/after screenshots and pair them with relevant CDP measurements (for example, `scrollTop`, focused element, route, or persisted state). Confirm that the screenshot and measured state agree.
4. **Exercise the relevant lifecycle** - include the actual route change, workspace/pane/file switch, remount, close/reopen, or other teardown boundary from the report. A narrower synthetic flow cannot substitute for the reported interaction.
5. **Treat a mismatch as an incomplete reproduction** - if the test passes but the user still observes the bug, re-check the target instance, exact steps, input method, persisted keys, and lifecycle timing. Reproduce the failure before changing code; do not assume the report is disproven by a synthetic smoke test.
6. **Use an evidence gate** - for a reported bug or regression, do not claim it is verified until the original interaction demonstrably fails before the fix and passes after it under the same observations. For a new feature, record equivalent baseline evidence and demonstrate the expected behavior. In all cases, state clearly which checks were end-to-end, which were synthetic, and whether screenshots were actually captured.

## Agent Rules
1. **Type safety** - avoid `any` unless necessary
2. **Prefer `gh` CLI** - when performing git operations (PRs, issues, checkout, etc.), prefer the GitHub CLI (`gh`) over raw `git` commands where possible
3. **Shared command and skill source** - keep command definitions in `.agents/commands/` and skill definitions in `.agents/skills/`. `.claude/commands` and `.cursor/commands` should be symlinks to `../.agents/commands`; `.claude/skills` should be a symlink to `../.agents/skills`. (`packages/chat` discovers slash commands from `.claude/commands`.) Skills aren't a cross-agent format yet, so non-Claude agents (Codex, Cursor, OpenCode) should read the relevant `.agents/skills/*/SKILL.md` file directly when its description matches the task.
4. **Workspace MCP config** - keep shared MCP servers in `.mcp.json`; `.cursor/mcp.json` should link to `../.mcp.json`. Codex uses `.codex/config.toml` (run with `CODEX_HOME=.codex codex ...`). OpenCode uses `opencode.json` and should mirror the same MCP set using OpenCode's `remote`/`local` schema.

   > **Mistral Vibe compatibility**: Vibe reads `AGENTS.md` + `.agents/skills/` natively (trust granted via `--trust`; no `.agents/commands` support). Configure it via `.vibe/config.toml`; it consumes MCP servers as `[[mcp_servers]]` TOML entries (not `.mcp.json`).

   > **Kimi Code compatibility**: Kimi reads `AGENTS.md` + `.agents/skills/` natively. It does not discover `.agents/commands`; configure it through `~/.kimi-code/config.toml` or `KIMI_CODE_HOME`.

5. **Mastra dependencies** - use the published upstream `mastracode` and `@mastra/*` packages. Do not add fork tarball overrides or custom patch steps unless explicitly requested.
6. **Plan & doc placement** - implementation plans go in `plans/` (cross-cutting) or `apps/<app>/plans/` (app-scoped); shipped plans move to `plans/done/`. Architecture/reference docs go in `<app>/docs/`. Never drop `*_PLAN.md` at an app root or inside `src/`.
7. **Always fix lint warnings before pushing** - CI fails on Biome warnings, not just errors (the lint script treats warnings as errors). Run `bun run lint:fix` after edits and verify `bun run lint` exits 0 before `git push`. Never push code that produces lint output, even auto-fixable formatting.
8. **Linear ticket format** - all tickets (creation, drafting, grooming) follow `.agents/skills/ticket-format/SKILL.md`. Read that file before creating or grooming a ticket.
9. **TanStack DB / Electric live queries are cache-first** - `useLiveQuery` can return persisted rows in `data` while the collection is still not `isReady`. Always render existing rows first. Use `isReady` only to decide what to show when no row/data exists yet: no data + not ready = loading/skeleton/null; no data + ready = empty/not-found. Never hide, blank, or replace existing `data` just because `isReady` is false or `isLoading` is true. This cache-first rendering rule does not apply to write/seeding side effects: wait for strict readiness before deriving missing rows or writing defaults, unless the write is provably idempotent.
10. **PR titles are conventional commits** - PRs are squash-merged using the PR title as the commit subject, so every title needs a conventional-commit type and scope, e.g. `feat(desktop): add copy-logs button to failed CI checks` or `fix(host-service): guard against missing PR`.
11. **Mobile is iOS-only for the time being** - `apps/mobile` targets iOS only. Don't add Android fallbacks or platform guards for iOS-only APIs (e.g. `@expo/ui/swift-ui`), and don't treat Android incompatibility as a blocker until Android is explicitly put in scope.


---

## Project Structure

All projects in this repo should be structured like this:

```
app/
├── page.tsx
├── dashboard/
│   ├── page.tsx
│   ├── components/
│   │   └── MetricsChart/
│   │       ├── MetricsChart.tsx
│   │       ├── MetricsChart.test.tsx      # Tests co-located
│   │       ├── index.ts
│   │       └── constants.ts
│   ├── hooks/                             # Hooks used only in dashboard
│   │   └── useMetrics/
│   │       ├── useMetrics.ts
│   │       ├── useMetrics.test.ts
│   │       └── index.ts
│   ├── utils/                             # Utils used only in dashboard
│   │   └── formatData/
│   │       ├── formatData.ts
│   │       ├── formatData.test.ts
│   │       └── index.ts
│   ├── stores/                            # Stores used only in dashboard
│   │   └── dashboardStore/
│   │       ├── dashboardStore.ts
│   │       └── index.ts
│   └── providers/                         # Providers for dashboard context
│       └── DashboardProvider/
│           ├── DashboardProvider.tsx
│           └── index.ts
└── components/
    ├── Sidebar/
    │   ├── Sidebar.tsx
    │   ├── Sidebar.test.tsx               # Tests co-located
    │   ├── index.ts
    │   ├── components/                    # Used 2+ times IN Sidebar
    │   │   └── SidebarButton/             # Shared by SidebarNav + SidebarFooter
    │   │       ├── SidebarButton.tsx
    │   │       ├── SidebarButton.test.tsx
    │   │       └── index.ts
    │   ├── SidebarNav/
    │   │   ├── SidebarNav.tsx
    │   │   └── index.ts
    │   └── SidebarFooter/
    │       ├── SidebarFooter.tsx
    │       └── index.ts
    └── HeroSection/
        ├── HeroSection.tsx
        ├── HeroSection.test.tsx           # Tests co-located
        ├── index.ts
        └── components/                    # Used ONLY by HeroSection
            └── HeroCanvas/
                ├── HeroCanvas.tsx
                ├── HeroCanvas.test.tsx
                ├── HeroCanvas.stories.tsx
                ├── index.ts
                └── config.ts

components/                                # Used in 2+ pages (last resort)
└── Header/
```

1. **One folder per component**: `ComponentName/ComponentName.tsx` + `index.ts` for barrel export
2. **Co-locate by usage**: If used once, nest under parent's `components/`. If used 2+ times, promote to **highest shared parent's** `components/` (or `components/` as last resort)
3. **One component per file**: No multi-component files
4. **Co-locate dependencies**: Utils, hooks, constants, config, tests, stories live next to the file using them

### Exception: shadcn/ui Components

The `src/components/ui/` and `src/components/ai-elements` directories contain shadcn/ui components. These use **kebab-case single files** (e.g., `button.tsx`, `base-node.tsx`) instead of the folder structure above. This is intentional—shadcn CLI expects this format for updates via `bunx shadcn@latest add`.

## Database Rules

** IMPORTANT ** - Never touch the production database unless explicitly asked to. Even then, confirm with the user first.

- Schema in `packages/db/src/`
- Use Drizzle ORM for all database operations

## DB migrations
- Never run a migration yourself, and **NEVER manually edit files in `packages/db/drizzle/`** (`.sql` files, `meta/_journal.json`, snapshots — all auto-generated). Only modify schema files in `packages/db/src/schema/` and ask the user to run `drizzle-kit generate`.
- Workflow (Neon branch setup, drizzle-kit invocation): see `.agents/skills/db-migrations/SKILL.md`.
