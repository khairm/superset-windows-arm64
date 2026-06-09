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
| Shell-running blue dot | OSC 133 C/D command-running detection | `scanForOsc133Cd` |
| Non-git / multi-repo workspaces | open a non-git folder as a plain workspace | `resolveNonGitFolder` |
| Multi-repo branch workspaces | "Open from multi-folder" groups N git repos; "+" fans the same branch out as a worktree per repo under one container workspace | `readMultiRepoConfig`, `createMultiRepoWorkspaceFlow` |
| Thread snooze / archive | per-thread timed Snooze + sticky Archive in the sidebar | `getWorkspaceSidebarBucket`, `APP_LAUNCH_ID`, `DashboardSidebarStateSection` |
| Sidebar hover-freeze | rows never re-sort while the pointer is over the project list (order applies on leave) | `(HOVER-FREEZE)` |
| Terminal links | plain click copies a URL/path, Ctrl/Cmd+click opens; `.html` paths open in Chrome (OS default fallback) | `useLinkClickHint`, `openHtmlInBrowser` |
| Agent-hook bash-wrap | Gemini/Cursor `.sh` hooks run via Git-for-Windows bash | `agent-wrappers` |
| Kanban board | device-local board mirroring branches + Queued column | `v2KanbanCards`, `KANBAN_QUEUE_COLUMN_ID` |
| Kanban append-only backup | daily write-once JSON snapshot of the board; code can never delete/overwrite one | `writeKanbanBackup` |

## Machine-readable markers (the nightly gate reads this block)

Format per line: `<marker-token>\t<path-glob-root>`. The gate greps the token
under the path root in the merged tree; absence = fail.

```markers
npm:@lydell/node-pty	packages
bun-windows-arm64	apps/desktop/scripts
titleBarOverlay	apps/desktop/src/main
windows-child-process	apps/desktop/src/main
pane-map-hook	apps/desktop/src/main
scanForOsc133Cd	packages
StatusIndicator	apps/desktop/src/renderer
resolveNonGitFolder	packages/host-service
readMultiRepoConfig	packages/host-service
createMultiRepoWorkspaceFlow	packages/host-service
MultiFolderProjectModal	apps/desktop/src/renderer
getWorkspaceSidebarBucket	apps/desktop/src/renderer
APP_LAUNCH_ID	apps/desktop/src/renderer
DashboardSidebarStateSection	apps/desktop/src/renderer
useLinkClickHint	apps/desktop/src/renderer
openHtmlInBrowser	apps/desktop/src
v2KanbanCards	apps/desktop/src/renderer
KANBAN_QUEUE_COLUMN_ID	apps/desktop/src/renderer
writeKanbanBackup	apps/desktop/src
agent-wrappers	apps/desktop/src/main
MAX_RENDERABLE_CHANGED_LINES	apps/desktop/src/renderer
(ACTIVE-FIRST)	apps/desktop/src/renderer
(HOVER-FREEZE)	apps/desktop/src/renderer
togglePinProject	apps/desktop/src/renderer
```
