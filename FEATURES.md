# Fork feature manifest

This file is the source of truth for **what our fork adds on top of upstream
superset**. The nightly upstream-merge workflow greps every marker below against
the merged tree; **if any marker is missing the merge is rejected** (a feature
was dropped or an upstream change clobbered it) and the build hard-aborts into
the recovery loop. Markers are deliberately distinctive identifiers that only
exist because of our feature code.

When you add a new custom feature, add a marker row here in the same commit.
When upstream **deprecates/removes** a feature we mirrored, remove its marker row
in the merge that drops it (the only legitimate way a marker leaves this list).

## Features

| Feature | What it is | Marker |
|---|---|---|
| Native Windows ARM64 packaging | one-click NSIS installer; ARM64 node-pty/libsql/tokenizers | `npm:@lydell/node-pty`, `bun-windows-arm64` |
| Window controls | native `titleBarOverlay` is the sole min/max/close set on Windows | `titleBarOverlay` |
| Windows behaviour fixes | child-process patch, cmd.exe fallback, force-foreground, watchdog, WebGL recovery, fast startup | `windows-child-process` |
| Agent status dots (Claude + Codex) | per-terminal dot + workspace rollup; host-service POST + JSONL watcher | `pane-map-hook`, `StatusIndicator` |
| Claude Stop unhooked from notify.sh | upstream's raw Stop passthrough must never race superset-notify.py (it wiped the blue dot + yellow-hold) | `CLAUDE-STOP-UNHOOKED` |
| Compaction shows working | Claude context compaction (manual /compact + auto) drives the yellow dot via PreCompact / SessionStart(source=compact) | `(COMPACT-YELLOW)` |
| Team/workflow work shows working | background_tasks[] entry types split the post-turn dot: agent-type work (teammate/subagent/workflow) holds yellow; shell-only goes blue | `(TEAM-YELLOW)` |
| Codex-companion job holds the dot | detached codex worker is invisible to background_tasks[]; an active (pid-alive) codex job for the session holds yellow incl. through StopFailure | `_codex_job_active` |
| Manual compact restores shell-blue | a manual /compact ending while only a background shell runs restores the BackgroundRunning blue (turn-end snapshot marker) instead of false-greening; the JSONL-watcher re-attach after compaction must not wipe that blue | `_shellbg_marker_path`, `(BLUE-SPECTATOR)` |
| ws native modules off | host-service `ws` must use pure-JS mask/unmask — a broken packaged bufferutil wedges WS receivers and kills ALL terminal keyboard input | `WS_NO_BUFFER_UTIL` |
| Shell-running blue dot | OSC 133 C/D command-running detection | `scanForOsc133Cd` |
| Non-git / multi-repo workspaces | open a non-git folder as a plain workspace | `resolveNonGitFolder` |
| Multi-repo branch workspaces | "Open from multi-folder" groups N git repos; "+" fans the same branch out as a worktree per repo under one container workspace | `readMultiRepoConfig`, `createMultiRepoWorkspaceFlow` |
| Workspace branch label | the open workspace page names its branch top-right in the tab bar (click copies) — the only branch surface a non-git multi-repo container has | `WorkspaceBranchLabel` |
| Thread snooze / archive | per-thread timed Snooze + sticky Archive in the sidebar | `getWorkspaceSidebarBucket`, `APP_LAUNCH_ID`, `DashboardSidebarStateSection` |
| Sidebar hover-freeze | rows never re-sort while the pointer is over the project list (order applies on leave) | `(HOVER-FREEZE)` |
| Terminal links | plain click copies a URL/path, Ctrl/Cmd+click opens; `.html` paths open in Chrome (OS default fallback) | `useLinkClickHint`, `openHtmlInBrowser` |
| Agent-hook bash-wrap | Gemini/Cursor `.sh` hooks run via Git-for-Windows bash | `agent-wrappers` |
| Kanban board | device-local board mirroring branches + Queued column | `v2KanbanCards`, `KANBAN_QUEUE_COLUMN_ID` |
| Kanban Completed column | fixed FINAL column: dropping a card stamps an editable completed date and hides the thread from the sidebar ENTIRELY (drag out un-completes/restores); per-column date filter (all / last calendar month / custom range) for work-done reports; completed cards survive branch deletion as frozen records; main cards can't complete | `KANBAN_COMPLETED_COLUMN_ID` |
| Kanban append-only backup | daily write-once JSON snapshot of the board; code can never delete/overwrite one | `writeKanbanBackup` |
| Kanban sidebar button toggles | sidebar Kanban press: anywhere → full-screen board; part-screen split → full-screen (closing then reopens that workspace full size); full-screen → close back to the remembered previous page (fallback Workspaces list) | `(KANBAN-TOGGLE)` |
| Subagent tool events never stomp the red | a PostToolUse whose payload carries `agent_id` (ran inside a subagent) maps to the red-respecting SubagentActive — background agents' tool completions must not clear a pending AskUserQuestion/permission red; only a main-loop completion does. SubagentStart likewise | `(SUBTOOL-RED)` |
| Layered dot axes | a source's dot status is DERIVED as the highest-precedence active axis (permission > working > review, + the separate blue axes) — events latch/unlatch axes they have evidence about, so a lower assert can never overwrite a higher active state | `applySourceAxes` |
| Leaked yellow-hold markers self-heal | a SubagentStop arriving with a mismatched/missing agent_id leaks its run-dir marker and pins the dot yellow with nothing running; at every Stop/SubagentStop the payload's background_tasks[] (ground truth) reaps any marker not listed as still running | `(MARKER-RECONCILE)` |
| Dot state survives renderer reloads | the v2-notifications dot store persists to sessionStorage — an in-place window reload (Ctrl+R / error boundary / crash recovery) no longer wipes every dot; the background-running blue has no self-heal until the next turn end, so a reload used to hide a running background task for hours. Clears on real app restart (no stale dots across launches) | `(DOT-PERSIST)` |

## Machine-readable markers (the nightly gate reads this block)

Format per line: `<marker-token>\t<path-glob-root>`. The gate greps the token
under the path root in the merged tree; absence = fail.

```markers
npm:@lydell/node-pty	packages
bun-windows-arm64	apps/desktop/scripts
titleBarOverlay	apps/desktop/src/main
windows-child-process	apps/desktop/src/main
pane-map-hook	apps/desktop/src/main
CLAUDE-STOP-UNHOOKED	apps/desktop/src/main
(COMPACT-YELLOW)	apps/desktop/src/main
(TEAM-YELLOW)	apps/desktop/src/main
_codex_job_active	apps/desktop/src/main
_shellbg_marker_path	apps/desktop/src/main
(BLUE-SPECTATOR)	apps/desktop/src/renderer
WS_NO_BUFFER_UTIL	apps/desktop/src/main
WS_NO_BUFFER_UTIL	packages/host-service
scanForOsc133Cd	packages
StatusIndicator	apps/desktop/src/renderer
resolveNonGitFolder	packages/host-service
readMultiRepoConfig	packages/host-service
createMultiRepoWorkspaceFlow	packages/host-service
MultiFolderProjectModal	apps/desktop/src/renderer
WorkspaceBranchLabel	apps/desktop/src/renderer
getWorkspaceSidebarBucket	apps/desktop/src/renderer
APP_LAUNCH_ID	apps/desktop/src/renderer
DashboardSidebarStateSection	apps/desktop/src/renderer
useLinkClickHint	apps/desktop/src/renderer
openHtmlInBrowser	apps/desktop/src
v2KanbanCards	apps/desktop/src/renderer
KANBAN_QUEUE_COLUMN_ID	apps/desktop/src/renderer
KANBAN_COMPLETED_COLUMN_ID	apps/desktop/src/renderer
writeKanbanBackup	apps/desktop/src
(KANBAN-TOGGLE)	apps/desktop/src/renderer
(SUBTOOL-RED)	apps/desktop/src/main
(MARKER-RECONCILE)	apps/desktop/src/main
(DOT-PERSIST)	apps/desktop/src/renderer
applySourceAxes	apps/desktop/src/renderer
agent-wrappers	apps/desktop/src/main
MAX_RENDERABLE_CHANGED_LINES	apps/desktop/src/renderer
(ACTIVE-FIRST)	apps/desktop/src/renderer
(HOVER-FREEZE)	apps/desktop/src/renderer
togglePinProject	apps/desktop/src/renderer
```
