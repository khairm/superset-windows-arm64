<!-- ===================================================================== -->
<!-- FORK MAINTENANCE (khairm Windows ARM64 fork). Everything ABOVE the -->
<!-- divider is about maintaining this fork; everything BELOW is upstream  -->
<!-- superset's own developer guide, unchanged, for working on the app.    -->
<!-- ===================================================================== -->

# superset-windows-arm64 — Windows ARM64 fork maintenance

This repo is a **vendored fork** of [superset-sh/superset]: the full upstream
source with our Windows ARM64 + feature changes committed on top, plus CI that
builds a native **Windows ARM64** one-click installer. The fork is the source of
truth; we track upstream by **merging its deltas**, not by re-applying changes.

## Fork architecture

- **Baseline (frozen).** The whole fork is committed source. Building it is
  deterministic and **AI-free** — `.github/workflows/build-arm64.yml` does
  install → compile → materialize the win-arm64 native closure → package the NSIS
  installer → verify the packaged natives are ARM64. No upstream clone, no patch
  apply, no arch-fixup. `.fork/upstream-baseline.txt` records the upstream tag the
  baseline sits on.
- **Nightly (minimal AI).** `.github/workflows/nightly-merge.yml` runs nightly: if
  upstream published a newer `desktop-v*` tag, it `git merge`s it in. Git resolves
  the non-conflicting majority deterministically; an **Opus** model (`--effort
  high`) resolves **only the conflicted files**, preserving every feature. AI cost
  scales with the **upstream delta per release**, NOT with how large the fork grows.
- **Gates.** After the merge: every marker in `FEATURES.md` must still be present
  (else a feature was dropped → reject), then the deterministic build must go green.
  On a clean merge + green build the nightly **auto-publishes the single
  `desktop-v<version>` Release** (rebuilt in place — see One-version below) and
  advances the baseline. Any failure (unresolvable conflict, lost marker, build
  failure) **hard-aborts** and leaves the baseline untouched → recovery.
- **Recovery.** When a nightly merge can't be done cleanly, fix it locally with the
  maintainer, rebuild, re-freeze the baseline; the nightly then resumes merging only
  *new* upstream changes from that point.

## Fork non-negotiables

- **Whole feature set or fail loud.** Every `FEATURES.md` marker survives a merge or
  the build aborts. Never ship a partial fork.
- **v2-only, forever.** The v2 cloud/host-service stack is pinned on; never v1.
- **No build-time type/test gate.** The build runs electron-vite/esbuild only —
  type/format errors don't fail it. Validate + e2e locally before relying on a release.
- **AI only in the nightly merge.** The build is AI-free. The nightly conflict
  resolver needs `CLAUDE_CODE_OAUTH_TOKEN`; if rate-limited it aborts rather than ship
  a half-merged fork.
- **One version, ever.** Exactly one GitHub Release per upstream version, tagged
  `desktop-v<version>`, **rebuilt in place** (delete + recreate so the tag always
  points at the latest build). NO `-beta`, NO prerelease, NO separate release/beta
  split — there is just *the* `desktop-v<version>` build.

## Fork features (high-level + UX, for a full rebuild)

See `FEATURES.md` for the marker manifest. In brief:

- **Native Windows ARM64 packaging** — one-click NSIS installer; ARM64 node-pty,
  libsql, tokenizers; renderer CORS for `superset-app://`.
- **Window controls** — native `titleBarOverlay` is the sole min/max/close set on
  Windows, theme-matched; upstream's duplicate controls hidden on Windows.
- **Windows behaviour fixes** — skip quit-confirmation; cmd.exe fallback;
  force-foreground; hidden-window watchdog; WebGL first-paint recovery; Wispr Flow
  accessibility + paste fix (UIA reachable WITHOUT xterm screenReaderMode); fast
  non-blocking startup (no main-thread fs).
- **Agent status dots (Claude + Codex)** — a coloured dot per terminal + a workspace
  rollup: red = needs input, yellow = working (held while subagents run), green =
  ready for review, blue = a foreground shell command or a cloud/background session.
  Precedence red > yellow > green > blue. Host-service lifecycle POSTs + a JSONL
  watcher fallback; only open tabs are represented. superset-notify.py exclusively
  owns Claude's Stop — upstream's notify.sh is deliberately NOT registered on Stop
  (its raw passthrough raced ~1s behind and wiped BackgroundRunning blue + the
  subagent yellow-hold). Every dot surface (tab, pane header, sidebar row,
  workspace rollup, kanban card) derives from ONE per-source primitive in the
  v2-notifications store; the rollup is the fold of the per-source dots, so
  surfaces cannot drift.
- **Non-git / multi-repo workspaces** — open a non-git or multi-repo folder as a
  plain workspace (no branch/worktree); the project "+" opens its main workspace.
- **Multi-repo branch workspaces** — "Open from multi-folder" groups N arbitrary
  git repos (picker validates each; unique basenames) under one project row (no
  master row; member list in `superset-multi-repo.json` inside a
  `~/.superset/multi-repo/<projectId>` anchor — no cloud/DB schema change). Its
  "+" takes an optional branch name (AI/friendly auto-generated when blank,
  deduped across the union of member branches) and fans it out: `git worktree add -b <branch>`
  (from each repo's default branch) into `<worktrees>/<projectId>/<branch>/<repoName>`
  per member — all-or-nothing with rollback; the container opens as a plain
  workspace. A branch existing in EVERY member is adopted (resume); partial
  presence fails loud. Delete mirrors single-repo per member (worktree remove,
  optional branch -D) then removes the container; the kanban promote dialog
  resolves multi-repo projects as branch-create targets.
- **Thread snooze / archive** — per-thread timed Snooze (auto-returns) + sticky
  Archive under revealable Snoozed / Archived sidebar sections.
- **Sidebar** — projects tier-sorted pinned > active > idle, stable manual drag order
  within each tier; right-click Pin/Unpin. Rendered order freezes while the pointer
  is over the list (and during drags); the live order applies on leave.
- **Terminal links** — plain click copies a URL/path; Ctrl/Cmd+click opens (`.html`
  → Chrome, OS-default handler fallback).
- **Agent-hook bash-wrap** — Gemini/Cursor `.sh` hooks run via Git-for-Windows bash
  instead of opening in an editor.
- **Kanban board (Tasks & PRs → Kanban)** — a device-local board mirroring every
  branch as a card + a fixed Queued column for tasks with no branch yet. Card shows
  title, `repo / branch`, a date deadline (yellow on the due day, red after), and the
  live status dot. Double-click title/deadline to edit; ALL card actions (Edit card
  for Queued, Snooze, Archive, Delete) live in the card's right-click menu — no
  3-dots button, and a plain click never opens the Queued editor modal. Drag a
  Queued card out to promote it (create a branch or attach to a non-git main card).
  Click a branch card to collapse the board and open that branch's workspace — the
  board sits as a resizable TOP strip (default) or a LEFT rail (header toggle;
  device-local preference incl. strip height / rail width), and the open card
  mirrors the sidebar's active-row highlight (same ?cardId source). Task details
  get a Card tab beside Files/Changes/Review. User-created columns (add/rename/reorder/delete; deleting
  moves cards left), each with collapsible Snoozed/Archived. Snooze/archive/delete of
  a branch card == the sidebar (one source of truth); main workspaces can't be
  snoozed/archived/deleted. Local-only, ungated. APPEND-ONLY daily backup:
  write-once JSON snapshot per org per day under `~/.superset/backups/kanban/`
  (skips empty boards; no code path can delete or overwrite a snapshot).

## Fork key files

- `.github/workflows/build-arm64.yml` — deterministic no-AI ARM64 build.
- `.github/workflows/nightly-merge.yml` — nightly upstream merge (Opus resolves
  conflicts) → marker gate → build → auto-publish → advance baseline; recovery on fail.
- `FEATURES.md` — feature marker manifest (the merge-preservation gate reads it).
- `.fork/upstream-baseline.txt` — the upstream tag the baseline currently sits on.
- `scripts/materialize-native-closure.sh` — win-arm64 native-payload repair
  (libsql/tokenizers/node-pty), invoked by the build.
- `scripts/resolve-release-age.mjs` — resolves a dep pinned newer than bunfig's
  `minimumReleaseAge` to the latest aged-safe version.
- Companion ARM64 native packages: `github.com/khairm/libsql-windows-arm64`,
  `github.com/khairm/tokenizers-windows-arm64`.

## Fork traps (do NOT repeat)

- **Never do synchronous/blocking fs on the main thread at startup** — it starves the
  renderer's `superset-app://` loader and the window stays blank for minutes.
- **Never re-enable xterm `screenReaderMode`** — it was the Wispr Flow regression
  (drops injected `insertText`). The build hard-fails if it's truthy in either
  renderer bundle.
- **Don't blank the v2 workspace on `!isReady`** — TanStack/Electric live queries are
  cache-first: render existing rows; gate only the empty/loading branch on readiness.
- **Never let `ws` load native bufferutil/utf-8-validate in the host-service** —
  packaging rebuilds them nondeterministically; a broken bufferutil resolves to an
  empty module (no throw → no JS fallback) and the first ≥32-byte client frame
  wedges the socket's receiver: ALL terminal keyboard input dies while output keeps
  flowing (build 41124b7d3 incident). `WS_NO_BUFFER_UTIL=1` + `WS_NO_UTF_8_VALIDATE=1`
  are set in the coordinator child env AND first-import in serve.ts — keep both.

## Fork limitations (accepted)

- Unsigned → SmartScreen warns.
- No build-time type/test gate — validate + e2e locally.
- An auto-merged nightly can publish a Release unattended, gated only by the
  feature-marker check + the esbuild build — a semantically-wrong-but-compiling merge
  could ship. e2e-test before relying on a release.

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

Bun + Turbo monorepo with:
- **Apps**:
  - `apps/web` - Main web application (app.superset.sh)
  - `apps/marketing` - Marketing site (superset.sh)
  - `apps/admin` - Admin dashboard
  - `apps/api` - API backend
  - `apps/desktop` - Electron desktop application
  - `apps/docs` - Documentation site
  - `apps/mobile` - React Native mobile app (Expo)
- **Packages**:
  - `packages/ui` - Shared UI components (shadcn/ui + TailwindCSS v4).
    - Add components: `npx shadcn@latest add <component>` (run in `packages/ui/`)
  - `packages/db` - Drizzle ORM database schema
  - `packages/auth` - Authentication
  - `packages/trpc` - Shared tRPC definitions
  - `packages/shared` - Shared utilities
  - `packages/mcp` - MCP integration
  - `packages/local-db` - Local SQLite database
  - `packages/durable-session` - Durable session management
  - `packages/email` - Email templates/sending
  - `packages/scripts` - CLI tooling
- **Tooling**:
  - `tooling/typescript` - Shared TypeScript configs

## Tech Stack

- **Package Manager**: Bun (no npm/yarn/pnpm)
- **Build System**: Turborepo
- **Database**: Drizzle ORM + Neon PostgreSQL
- **UI**: React + TailwindCSS v4 + shadcn/ui
- **Code Quality**: Biome (formatting + linting at root)
- **Next.js**: Version 16 - NEVER create `middleware.ts`. Next.js 16 renamed middleware to `proxy.ts`. Always use `proxy.ts` for request interception.

## Common Commands

```bash
# Development
bun dev                    # Start all dev servers
bun test                   # Run tests
bun build                  # Build all packages

# Code Quality
bun run lint               # Check for lint issues (no changes)
bun run lint:fix           # Fix auto-fixable lint issues
bun run format             # Format code only
bun run format:check       # Check formatting only (CI)
bun run typecheck          # Type check all packages

# Maintenance
bun run clean              # Clean root node_modules
bun run clean:workspaces   # Clean all workspace node_modules
```

## Code Quality

**Biome runs at root level** (not per-package) for speed:
- `biome check --write --unsafe` = format + lint + organize imports + fix all auto-fixable issues
- `biome check` = check only (no changes)
- `biome format` = format only
- Use `bun run lint:fix` to fix all issues automatically

## Agent Rules
1. **Type safety** - avoid `any` unless necessary
2. **Prefer `gh` CLI** - when performing git operations (PRs, issues, checkout, etc.), prefer the GitHub CLI (`gh`) over raw `git` commands where possible
3. **Shared command and skill source** - keep command definitions in `.agents/commands/` and skill definitions in `.agents/skills/`. `.claude/commands` and `.cursor/commands` should be symlinks to `../.agents/commands`; `.claude/skills` should be a symlink to `../.agents/skills`. (`packages/chat` discovers slash commands from `.claude/commands`.) Skills aren't a cross-agent format yet, so non-Claude agents (Codex, Cursor, OpenCode) should read the relevant `.agents/skills/*/SKILL.md` file directly when its description matches the task.
4. **Workspace MCP config** - keep shared MCP servers in `.mcp.json`; `.cursor/mcp.json` should link to `../.mcp.json`. Codex uses `.codex/config.toml` (run with `CODEX_HOME=.codex codex ...`). OpenCode uses `opencode.json` and should mirror the same MCP set using OpenCode's `remote`/`local` schema.
5. **Mastra dependencies** - use the published upstream `mastracode` and `@mastra/*` packages. Do not add fork tarball overrides or custom patch steps unless explicitly requested.
6. **Plan & doc placement** - implementation plans go in `plans/` (cross-cutting) or `apps/<app>/plans/` (app-scoped); shipped plans move to `plans/done/`. Architecture/reference docs go in `<app>/docs/`. Never drop `*_PLAN.md` at an app root or inside `src/`.
7. **Always fix lint warnings before pushing** - CI fails on Biome warnings, not just errors (the lint script treats warnings as errors). Run `bun run lint:fix` after edits and verify `bun run lint` exits 0 before `git push`. Never push code that produces lint output, even auto-fixable formatting.
8. **Linear ticket format** - all tickets (creation, drafting, grooming) follow `.agents/skills/ticket-format/SKILL.md`. Read that file before creating or grooming a ticket.
9. **TanStack DB / Electric live queries are cache-first** - `useLiveQuery` can return persisted rows in `data` while the collection is still not `isReady`. Always render existing rows first. Use `isReady` only to decide what to show when no row/data exists yet: no data + not ready = loading/skeleton/null; no data + ready = empty/not-found. Never hide, blank, or replace existing `data` just because `isReady` is false or `isLoading` is true. This cache-first rendering rule does not apply to write/seeding side effects: wait for strict readiness before deriving missing rows or writing defaults, unless the write is provably idempotent.


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
- Always spin up a new neon branch to create migrations. Update our root .env files to point at the neon branch locally.
- Use drizzle to manage the migration. You can see the schema at packages/db/src/schema. Never run a migration yourself.
- Create migrations by changing drizzle schema then running `bunx drizzle-kit generate --name="<sample_name_snake_case>"`
- `NEON_ORG_ID` and `NEON_PROJECT_ID` env vars are set in .env
- list_projects tool requires org_id passed in
- **NEVER manually edit files in `packages/db/drizzle/`** - this includes `.sql` migration files, `meta/_journal.json`, and snapshot files. These are auto-generated by Drizzle. If you need to create a migration, only modify the schema files in `packages/db/src/schema/` and ask the user to run `drizzle-kit generate`.
