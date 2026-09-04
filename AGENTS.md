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

- **Build (deterministic steps, self-repairing).** `.github/workflows/build-arm64.yml`
  orchestrates a bounded attempt/repair loop `(BUILD-REPAIR)`: the actual build
  steps (install → compile → materialize the win-arm64 native closure
  (`scripts/materialize-native-closure.sh`: libsql/tokenizers/node-pty) →
  package the installer → verify packaged natives are ARM64 → publish) live in
  `.github/actions/arm64-build/action.yml` as thin shims over `scripts/*.sh`.
  A failed attempt triggers an Opus 5 (`claude-opus-5`, effort high) repair job
  that reads the failed log, fixes the checked-out tree, and pushes to the
  repair branch (nightly candidate / dispatched branch); the next attempt
  builds that exact sha so every deterministic gate re-runs. Max 3 attempts /
  2 repairs, then fail loud. Repairs may never change the app version or touch
  `FEATURES.md` (`scripts/check-feature-markers.mjs` gates marker survival).
- **Nightly merge.** `.github/workflows/nightly-merge.yml` (02:13 UTC): when
  upstream publishes a newer `desktop-v*` tag, git merges it; Opus 5 resolves
  conflicted files, then a `(MERGE-ADAPT)` proactive port pass adapts fork-only
  callers to cleanly-merging upstream API refactors. Deterministic gates follow
  (FEATURES.md marker survival, dependency/lock consistency, `(REFERR-GATE)`
  cannot-find-name check), then a bounded `(MERGE-SEMANTIC-GATE)` review →
  adapt → fresh-review loop (max 3 reviews / 2 repairs). Green all the way =
  build (with its own repair loop), publish the Release, advance the baseline
  to the BUILT sha; ANY unrepaired failure hard-aborts with the baseline
  untouched → fix locally with the maintainer and re-baseline. A
  `rehearse=true` dispatch replays a night's merge half with zero side effects.
  A night blocked ONLY by a PROVEN `(AI-UNAVAILABLE)` abort (declared by the
  wrapper, never an exit code alone) merged, built and published nothing, so it
  concludes GREEN (no email) as a loud no-op with build/advance skipped — until
  `AI_UNAVAILABLE_STREAK_THRESHOLD` (7, owned by the script) consecutive blocked
  NIGHTS, which fails RED. Same-day re-runs count once, and only a night where
  the CLI provably reached the model clears the streak.
- **Key files.** `FEATURES.md` (feature manifest + fenced `markers` block the
  gates parse), `.fork/upstream-baseline.txt`,
  `scripts/check-dangerous-diagnostics.mjs` (REFERR gate),
  `scripts/check-feature-markers.mjs` (standalone marker gate),
  `scripts/check-no-bundled-skills.mjs` (blocks bundled Superset skills),
  `scripts/ci-repair.sh` (build-repair engine),
  `scripts/ai-run.sh` ((AI-UNAVAILABLE) classification + shared Claude CLI wrapper),
  `scripts/ai-streak.sh` ((AI-UNAVAILABLE) green no-op + consecutive-blocked-night
  escalation),
  `scripts/check-override-consistency.mjs`, `scripts/resolve-release-age.mjs`,
  companion native packages `github.com/khairm/libsql-windows-arm64` +
  `github.com/khairm/tokenizers-windows-arm64`.

## Non-negotiables

- **Whole feature set or fail loud** — every `FEATURES.md` marker survives a
  merge or the run aborts; never ship a partial fork.
- **v2-only, forever** — the v2 cloud/host-service stack is pinned on; never v1.
- **No bundled Superset skills** — never package or inject them; remove only
  marker-proven legacy copies. Keep hooks and user-owned skills.
- **No phone-home to upstream (phase 1)** — upstream's telemetry, auto-update
  and desktop-notice channels are deliberately SEVERED as of cloud severance
  phase 1 (`(CLOUD-SEVERANCE-P1)`, `(EGRESS-FENCE)`): dead PostHog/Sentry keys,
  a no-op CLI analytics call, a disabled updater and a notices poll that fetches
  nothing are the intended state, not breakage to repair. Sign-in, Electric and
  the api.superset.sh data plane are still live and are phase 2/3.
- **One version, ever** — exactly one Release per upstream version, tagged
  `desktop-v<version>`, rebuilt in place; no betas/prereleases.
- **No build-time type/test gate except `(REFERR-GATE)`** — the tree carries
  accepted type debt; only cannot-find-name diagnostics fail the build.
  Validate + e2e locally before relying on a release.
- **Everything is AI-touchable** (needs `CLAUDE_CODE_OAUTH_TOKEN`): the nightly
  merge resolves/ports/reviews, and the build self-repairs via `(BUILD-REPAIR)`.
  Workflow YAML self-repair additionally needs the `WORKFLOW_PUSH_TOKEN` secret
  (fine-grained PAT, Contents+Workflows write) and only takes effect the NEXT
  run — workflow files are frozen once a run starts, which is why all step
  logic lives in `.github/actions/` + `scripts/` (repairable mid-run).
  Rate-limited/unparsable AI output aborts rather than ships.

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
  renderer reloads; companion phone/watch alerts cover blocked questions,
  ready-for-review, and terminal-agent failures.
- **Auto-resume** — after an API failure, idle Claude terminals re-send
  automatically (bounded retries/budget, default-on, away-detection).
- **Recycle Bin** — every delete entry point soft-deletes (30-day display
  window); permanent delete only from inside the bin.
- **Exiting a card closes its runtime** — Completed, Archive, Snooze and Recycle
  Bin clear the workspace's tabs, dispose its terminals and release its pinned
  Claude account, for every card type and entry point. Worktree and branch
  untouched; a restored thread comes back empty. Snooze's account release is
  permanent even though the snooze is not: the thread returns Following.
  Renderer and host teardown wait until the exit row is durably saved. The host
  half is retried from a persisted `runtimeCleanupPendingAt` stamp until
  the OWNING host confirms a teardown or the workspace is authoritatively
  absent — stamped for every workspace, reached at its own host (locally or over
  the relay) plus a local broadcast for other orgs, retried when a local
  host-service is replaced or an owner's socket reopens, and cancelled if the
  user un-exits. The host refuses terminal launches for the whole retirement.
  Sidebar removal is unchanged (still non-destructive).
- **Non-git / multi-repo workspaces** — open any folder (non-git or multi-repo)
  as a plain workspace.
- **Multi-repo branch workspaces** — group N git repos under one project row;
  its "+" fans a branch out as worktrees per member (all-or-nothing, adoption
  on resume, editable membership, loud partial-state failures).
- **Workspace branch label** — branch name top-right in the tab bar; click
  copies.
- **Thread snooze / archive** — timed Snooze (auto-returns) + sticky Archive in
  revealable sidebar sections; both are exits (see above), not display-only.
- **Sidebar** — pinned > active > idle tier sort with stable manual drag order;
  hover freezes re-sorting.
- **Terminal links** — plain click copies a URL/path; Ctrl/Cmd+click opens.
- **Agent-hook bash-wrap** — Gemini/Cursor `.sh` hooks run via Git-for-Windows
  bash.
- **Kanban board** — device-local board of every sidebar project's branches +
  Queued and final Completed columns, custom columns, deadlines, per-column
  date filters, promote-to-branch drag, sidebar Mark completed for active
  worktrees, frozen completed records, append-only daily JSON backups under
  `~/.superset/backups/kanban/`.
- **Per-workspace Claude accounts** — every local workspace on a Pi-capable
  host (push-key at `~/.usage-display/push-key.txt`) owns a Claude profile
  folder under `<db-dir>/claude-profiles/<uuid>`; sidebar right-click
  "Account ▸" pins it to a Pi-managed account or follows the tray default,
  hot-swapped by rewriting credentials in place (no restarts). Pinned accounts
  crossing the tray's usage trigger lines (or marked dead on the Pi) auto-fall
  back to Following, permanently. A Pi outage gets a 10-minute grace period:
  switches are saved and apply on recovery; later attempts fail. Two-phase
  delete-intent markers + a gated janitor own folder lifecycle (destroy deletes,
  archive never does); sentinel refresh token —
  the Pi owns all real credential lineages. The sidebar chip and the
  "Account ▸" menu show pace-coloured 5h/weekly/Fable percentages with reset
  countdowns, mirroring the tray. Glossary: `CONTEXT.md`. Module:
  `packages/host-service/src/claude-accounts/`.

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
  commit with a user token. `(BUILD-REPAIR)` pushes that touch workflow files
  use `WORKFLOW_PUSH_TOKEN` (also the advance job's push credential, since a
  repaired candidate may carry workflow commits into main).
- Never assert upstream-derived incidental names (Rollup chunk filenames, file
  hashes, ordering) in fork-owned gates — assert the invariant over the whole
  artifact set (`SCREENREADER-GUARD-DRIFT`: a chunk rename blocked 3 nightlies).
- In the fork's ARM64 native scripts (`scripts/fetch-native-prebuilds.sh`,
  `scripts/materialize-native-closure.sh`,
  `apps/desktop/scripts/copy-native-modules.ts`), never pick a native's version
  by taking the highest one in `node_modules/.bun` — that store caches versions
  other consumers needed, and a tag/ABI from one the app never links to ships a
  binary it cannot load. Ask `bun why` (via `scripts/bun-locked-versions.sh`),
  then touch only the store dirs matching that version exactly (`key@ver`,
  `key@ver+<16 hex>`).

## Accepted limitations

Unsigned installer (SmartScreen warns); no full type/test gate (type debt is
accepted, `(REFERR-GATE)` only); an unattended nightly can publish a Release —
the gate stack shrinks but does not eliminate the
semantically-wrong-but-compiling window, so e2e-test before relying on one.
`(BUILD-REPAIR)` widens that window: an unattended repair agent can push code
that passes every deterministic gate yet is semantically wrong or (via
prompt-injected build logs) malicious — containment is credential-less agent
steps, trusted-blob validation, version/FEATURES.md freezes, and tip-pinning,
not semantic review. A direct build dispatch racing a just-started nightly
fails that nightly loudly (non-ff advance) and self-heals next night. Repair
commits on a nightly candidate do NOT persist across nights: an aborted
nightly's candidate is deleted and re-derived next run, so a break needing
more than 2 repairs re-derives them from zero each night until fixed locally.
Gate scripts are frozen against repair edits — a genuine bug in a gate script
is deliberately NOT self-repairable (fail loud, maintainer fixes).

[superset-sh/superset]: https://github.com/superset-sh/superset

<!-- ===================================================================== -->
<!-- END FORK MAINTENANCE — upstream superset's developer guide follows.   -->
<!-- ===================================================================== -->

---

# Superset Monorepo

Superset is an agent-first development platform, with an Electron desktop IDE, Next.js web apps, and an Expo mobile app as the main customer-facing surfaces. It's a Turborepo monorepo, deployed apps are in apps/ and supporting packages are in packages/, and we use tRPC for the api.

You're working inside a Superset workspace, an isolated git-worktree copy of this repo. "Workspace" in a user message means that, not an editor workspace.

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

## Database

Drizzle ORM, schema in `packages/db/src/`. Follow `.agents/skills/db-migrations/SKILL.md` to generate
migrations. Never hand-edit `packages/db/drizzle/` (SQL, `meta/_journal.json`, snapshots) without
explicit user confirmation, and never apply migrations against a shared or production database.

## Releases

Desktop, host-service, and cli share one version; cut releases on a dedicated branch. Runbook:
`scripts/release/README.md`. A *canary* is a separate thing: `bash scripts/release-canary.sh
[commit]` builds the rolling internal `desktop-canary` prerelease, not a versioned release.

## Orchestrating agents and workspaces

When work wants a fresh isolated environment, a parallel agent, or a long-running job, reach for the
`superset` CLI instead of hand-rolling git worktrees or doing it all serially in this one. It's
already on `PATH` in Superset terminals, and we dogfood it.

Replace the capitalized placeholders before running these:

```bash
superset ws create --project PROJECT_ID --branch BRANCH --agent claude --prompt "..."
superset agents create --workspace WORKSPACE_ID --agent claude --prompt "..."
superset ws list
superset terminals read --workspace WORKSPACE_ID --terminal TERMINAL_ID
superset ws delete WORKSPACE_ID
```

In order: an isolated workspace with an agent already working in it, another agent in an existing
workspace, what's running, what an agent is doing right now, and cleanup when you're done.

Spawning several related workspaces? Add `--tag SOME_TAG` (repeatable) to `ws create` — tagged
workspaces group into a sidebar folder of that name automatically, so a batch files itself instead
of scattering across the project. `ws list --tag SOME_TAG` filters to them, and
`ws update WORKSPACE_ID --tag ...` retags (`--clear-tags` ungroups). Automation-created workspaces
are tagged `automation` by default and collect in an "automation" folder.

`superset <command> --help` covers the rest (tasks, automations, hosts, settings). Pass `--json` for
parsable output; it's on by default under agent environments.

## Internationalization

User-facing strings use Lingui macros with the English text as the message id —
`<Trans>Text</Trans>` or `useLingui()`'s `t({ message })` in React, `i18n._(msg({ message }))`
outside React (Electron main). Identical English with different meanings gets a `context`
so it translates separately. Numbers, currencies, and dates go through
`@superset/i18n/format` helpers, never `new Intl.*("en-US")` or `toLocale*` with a hardcoded
locale. After adding or changing strings, run `bun run check:i18n` (CI enforces it): it
regenerates the catalogs and lists every untranslated message per locale. Write those
translations yourself into each `locales/<locale>/messages.po` and commit the catalogs with
the change — nothing on CI fills translations for you. Conventions: `packages/i18n/README.md`;
terms that never translate: `packages/i18n/glossary.md`; strategy and phasing:
`plans/20260826-i18n-strategy.md`.
Directories listed in `packages/i18n/test/enforced-dirs.ts` must not contain hardcoded
JSX text — add a directory there once it is fully converted. `errorMessage()` output is potentially
translated and is display-only: logs, Sentry/PostHog, and error classification use
`rawErrorMessage()` or the error object (enforced by `packages/i18n/test/display-only.test.ts`).

**Shipping locales.** `SUPPORTED_LOCALES` in `packages/i18n/src/locales.ts` is the single
source of truth — adding a locale there is what makes it appear in the Settings picker and
the optional onboarding step, and what `lingui.config.ts` must list. Every enabled locale
must be **fully translated**: `compile --strict` fails the build on a missing message, so
finish a translation before adding its locale. Native language names live in `LOCALE_LABELS`
and are never translated — someone stuck in the wrong language has to recognize their own.
Relative times use `formatRelativeTime`/`formatCompactRelativeTime`, not hand-rolled
"3d ago" helpers; `Intl` already knows every locale's wording.

Three traps worth knowing before you touch catalogs:

- **Editing English copy re-keys the message.** The text is the id, so an edit creates a
  new entry that is empty in every locale and `check:i18n` lists it. If the edit was cosmetic,
  the old translations are still in `git diff` on the catalogs to copy from.
- **Regenerate from a clean tree.** `lingui.config.ts` keeps `messages.po` deterministic:
  `orderBy: "message"` fixes entry order, and `origins: false` drops the `#:` file
  references, whose order follows filesystem traversal and differs between macOS and
  Linux. A catalog regenerated on top of local experiments will still commit noise.
- **`bun test` runs uncompiled source.** The Lingui macro rewrites `` message: `${n} items` ``
  into a placeholder message plus values at build time, so the catalog stores `{n} items`.
  Tests see neither, which is why `apps/desktop/test-setup.ts` shims the macros and `i18n._`.
  Mock that module with a Proxy, never a spread — `i18n` is a class instance and a spread
  drops `load`/`activate`.

## Further reading

- `.agents/skills/`: CDP UI verification, DB migrations, ticket format, and more. Read the matching
  `SKILL.md` when a task fits its description.
- `docs/agent-tooling.md`: where commands, skills, and per-agent-CLI config live.
- `docs/environment-variables.md`: read before adding an environment variable. Five places,
  and missing one fails silently.
- `apps/desktop/AGENTS.md`: desktop specifics (notices, persisted renderer state).
- `apps/mobile/AGENTS.md`: mobile structure and iOS-only scope.
- `docs/cloud-sandbox-mismatches.md`: where cloud workspace sandboxes don't fit assumptions the
  app makes about a machine someone owns. Read it before touching sandboxes, and add to it when
  you find a new one.
- `docs/cloud-sandbox-considerations.md`: what cloud sandboxes still owe before they leave the
  team — billing, credential blast radius, untested behaviour.
