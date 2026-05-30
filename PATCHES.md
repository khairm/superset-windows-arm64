# Windows ARM64 Compatibility Patches

> **ARM64 build note.** The nightly workflow applies the Windows-compatibility
> patches below to a fresh clone of
> [`superset-sh/superset`](https://github.com/superset-sh/superset) (an AI agent
> reads this file and applies every patch).
>
> The patches below reference the **x64** native binary
> `@lydell/node-pty-win32-x64` (Patches 12 & 14). For this **native ARM64** build
> the workflow's `ARM64 arch fixup` step deterministically (with fail-fast
> assertions) also:
>
> - rewrites node-pty / build-target / validate-runtime references x64 → arm64
>   and builds with `electron-builder --win --arm64`;
> - injects the win32-arm64 platform packages upstream/registries do **not**
>   publish — `@libsql/win32-arm64-msvc` and `@anush008/tokenizers-win32-arm64-msvc`
>   (built by [`khairm/libsql-windows-arm64`](https://github.com/khairm/libsql-windows-arm64)
>   and [`khairm/tokenizers-windows-arm64`](https://github.com/khairm/tokenizers-windows-arm64))
>   via `scripts/materialize-native-closure.sh`;
> - replaces the `better-sqlite3` Bun-store payload with the **exact
>   `electron-v<ABI>` win32-arm64 prebuilt** (its NODE_MODULE_VERSION must match
>   the target Electron — a PE-arch check alone is insufficient);
> - ships a **single one-click** NSIS installer (`oneClick: true`);
> - adds a Windows `titleBarOverlay` (upstream is frameless + macOS-centric, so
>   Windows otherwise has no visible window controls);
> - re-asserts `ELECTRON_RUN_AS_NODE=1` in `DaemonSupervisor`'s child env so the
>   V2 terminal `pty-daemon` runs as Node instead of booting the GUI app
>   (Patch 2's bundle banner strips the var from `host-service.js`, breaking the
>   packaged daemon spawn — "Daemon unavailable");
> - adds the packaged renderer origin `superset-app://app` to the host-service
>   CORS allowlist so renderer fetches (e.g. agent settings) aren't blocked at
>   the preflight ("Couldn't load agent settings: Failed to fetch");
> - filters git's own internal churn (`*.lock`, `fsmonitor--daemon/`,
>   `objects/`, `logs/`) out of host-service's recursive `.git/` `fs.watch` and
>   memoizes `getRemoteUrl`. Unfiltered, every `git status` writes inside `.git/`
>   and re-triggers the watcher — a self-sustaining ~25 `git.exe`/sec storm that
>   saturates host-service's single Node event loop on Windows (sluggish UI,
>   terminal-keystroke lag, host-service killed → "Failed to fetch"). Applied
>   deterministically via `patches/git-storm-fix.patch` (`git apply`, idempotent
>   + fail-fast); diagnosed, Codex-reviewed, and **measured on real ARM64
>   hardware: ~25/sec → ~0.1/sec idle**.
> - skips the quit-confirmation dialog on Windows so closing the window
>   actually closes the app. Patch 19 moves the dialog into `window.on("close")`
>   so it appears BEFORE the window disappears — but on Windows the dialog is a
>   Win32 `#32770` parented to the main window and easy to miss if the user
>   alt-tabs away. `event.preventDefault()` keeps Electron main alive
>   indefinitely awaiting a dialog response that never comes; the dangling main
>   process holds the single-instance lock and the next launch hits
>   `gotTheLock === false` → silent `app.exit(0)` ("clicked Superset, nothing
>   opens"; symptom: ~6+ leftover `Superset.exe` processes — one stuck Electron
>   tree plus released host-services from prior sessions). Reproduced live:
>   `CloseMainWindow()` left the main PID alive 30s+ with a visible "Quit
>   Superset" dialog at `hWnd 48169566`; sending Enter to the dialog made the
>   app exit cleanly. Fix: remove Patch 19's `if (PLATFORM.IS_WINDOWS) { … }`
>   block from `window.on("close")` so closing the window destroys it and
>   triggers `before-quit` → `releaseAll()` → `app.exit(0)` without a prompt.
>   Patch 19's `!PLATFORM.IS_WINDOWS` gate in `before-quit` stays, so neither
>   path shows a dialog on Windows. Applied deterministically via
>   `patches/skip-quit-confirmation-windows.patch` (`git apply`, idempotent +
>   fail-fast). Supersedes the misdiagnosis in commit 860df5a
>   (`patches/kill-on-close.patch`, removed) — that patch targeted
>   `HostServiceCoordinator.stopAll()` in `before-quit`, but v1.9.6/v1.9.9 use
>   `releaseAll()` there (host-services are intentionally left alive for
>   re-adoption); the orphan was a red herring.
> - forwards Claude Code agent state from per-session JSONL transcripts into
>   Superset's existing `notificationsEmitter` → `pane.status` UI pipeline.
>   Upstream's `agent-wrappers-claude-codex-opencode.ts` writes a bash-only
>   hook command into `~/.claude/settings.json` (`[ -n "$SUPERSET_HOME_DIR" ]
>   && [ -x "$SUPERSET_HOME_DIR/hooks/notify.sh" ] && ... || true`); on
>   Windows Claude executes that via Git Bash, where `/usr/bin/[` errors out,
>   `|| true` swallows the failure, and the recorded `hookEvent: "SessionStart"`
>   JSONL entry deceptively says `"exitCode": 0` with `"type": "hook_success"`.
>   Net effect: the green "review" / amber "working" / red "permission" status
>   indicators on workspace icons never light up because no `AGENT_LIFECYCLE`
>   event ever reaches the renderer. The full bash → `notify.sh` → Electron
>   Express server (port 51741) → wrapper-script chain is broken across four
>   independent layers on Windows. Fix: add a Node `fs.watch` on
>   `~/.claude/projects/<encoded-cwd>/*.jsonl` that tails session
>   transcripts (Claude `~/.claude/projects/<encoded-cwd>/*.jsonl`,
>   Codex `~/.codex/sessions/**\/rollout-*.jsonl`), derives lifecycle
>   events per-agent (real user prompts and assistant/tool/thinking
>   entries → working with a 3-second inactivity timer;
>   `stop_reason:"end_turn"`, `hookEvent:"Stop"`,
>   `subtype:"stop_hook_summary"` → review immediate;
>   `hookEvent:"PermissionRequest"` for Claude and
>   `exec_approval_request`/`apply_patch_approval_request`/`request_user_input`
>   for Codex → permission). Lines processed in arrival order; dedup
>   state keyed per **session id** (from JSONL filename UUID) so sibling
>   sessions in the same cwd never suppress each other. Watcher emits
>   `{ eventType, cwd, [paneId, tabId, workspaceId] }` and lets the
>   **renderer** resolve against the live Zustand store — resolving in
>   the main process via `appState.tabsState` would miss newly-opened
>   terminals (debounced LowDB persistence; confirmed against upstream's
>   `resolve-pane-id.ts` which explicitly documents the lag). The live
>   cwd lookup is added alongside existing paneId/sessionId paths in
>   `resolve-notification-target.ts`. A companion `pane-map-hook.ts`
>   installs a portable Python (uv) SessionStart hook into
>   `~/.claude/settings.json` and `~/.codex/hooks.json` that records
>   `{sessionId → paneId/tabId/workspaceId}` mapping files at
>   `~/.superset/session-pane-map/`; the watcher reads them for precise
>   per-pane identity when 2+ terminals share a cwd. Hook coexists with
>   upstream's bash `notify.sh` (different filename = different identity
>   in the merge logic). Per-file fs.watch processing avoids full
>   recursive scans of large Codex archives on every append. Applied
>   deterministically via `patches/agent-jsonl-watcher.patch` — 6-file
>   touch: new `agent-jsonl-watcher/{agent-jsonl-watcher.ts,
>   pane-map-hook.ts, index.ts}`, `main/windows/main.ts` wiring (start
>   + stop), `shared/notification-types.ts` adds `cwd?: string` to
>   `NotificationIds`, and `renderer/stores/tabs/utils/
>   resolve-notification-target.ts` adds the cwd lookup (`git apply`,
>   idempotent + fail-fast). Reviewed in 6 Codex passes.
> - renders **per-terminal** status dots inline with each workspace name in
>   the sidebar. Upstream `WorkspaceListItem.tsx` rolls all pane statuses up
>   to a single overlay indicator on the workspace icon — useful, but hides
>   per-terminal granularity when a workspace has 2+ terminals each running
>   an agent. Fix: add a `useTabsStore` selector that returns the active
>   terminal-pane statuses (comma-joined for stable referential equality —
>   avoids the shallow-equality footgun on array-returning Zustand selectors),
>   render one `<StatusIndicator>` per non-idle terminal pane next to the
>   workspace name. Reuses the existing red-pulse/amber-pulse/green-static
>   visual language so it matches the rolled-up overlay. Companion to the
>   JSONL-watcher patch above — without the watcher, `pane.status` never
>   leaves `"idle"` on Windows and this row would always be empty. Applied
>   deterministically via `patches/per-terminal-dots.patch` (`git apply`,
>   idempotent + fail-fast).
> - guarantees the main window becomes visible even when its load events
>   never fire. `MainWindow()` creates the `BrowserWindow` with `show: false`
>   and only calls `window.show()` from the `did-finish-load` (success) or
>   `did-fail-load` (failure) handlers — there is **no fallback if NEITHER
>   fires**. On Windows ARM64 that gap is reachable: the renderer can crash
>   mid-load (`render-process-gone`) with nothing reloading it, or a
>   load/visibility race under the `superset-app://` protocol can swallow both
>   events, leaving every `Superset.exe` process alive but the window
>   permanently hidden ("spins up in Task Manager, nothing hits the UI").
>   Diagnosed live via Win32 `EnumWindows`: the window was present, on-screen,
>   sane bounds, but `IsWindowVisible == false`; a manual `ShowWindow` revealed
>   a fully-loaded UI — so the renderer had loaded, `show()` was simply never
>   called. Fix adds a 12 s **show-watchdog** (force-show + `focus()` + a loud
>   `electron-log` error when the window is still hidden), a **one-time
>   renderer reload** when the renderer dies before the first load, and routes
>   the window-lifecycle logs through `electron-log` — the show path previously
>   used `console.log`, which does **not** persist to `main.log`, so the failed
>   launch left zero diagnostic trace. Hunks touch only the
>   `did-finish-load`/`did-fail-load`/`render-process-gone` handlers (not the
>   close handler that Patch 19 / `skip-quit` rewrite), so it applies on top of
>   the AI-applied patches. Applied deterministically as an **inline fixup**
>   (`scripts/fixup-snippets/hidden-window-watchdog.snippet`, spliced as ADDITIVE
>   `webContents` listeners before the `did-finish-load` registration; idempotent +
>   fail-fast) — converted from a git-apply patch that drifted on the AI-edited
>   handler bodies and hard-aborted (main.ts:323).
> - ~~closes a gap in the **v2 workspace** per-terminal agent indicator~~
>   **DISABLED 2026-05-22** — `patches/v2-cwd-fallback.patch` is kept in
>   the repo but the nightly workflow no longer applies it. The build
>   that shipped it (Superset-1.10.2-arm64.exe, 10:27 UTC) booted to a
>   blank state: navigation to a v2-workspace fired `did-start-loading`
>   but never reached `did-finish-load`, the renderer hung mid-mount of
>   `V2NotificationController`, and terminals were visible but had no
>   live xterm bound to input. `git apply --check` and TS compile both
>   passed; `main.log` showed no error. The runtime symptom only
>   surfaced when a real Superset render tried to mount the patched
>   component. **Static patch checks are not sufficient for renderer
>   patches** — any future revival of this fix must be runtime-validated
>   end-to-end in a real Superset before user-visible install, and
>   probably belongs in the main process (where we can validate with
>   logs) rather than the renderer mount path.
> - adds **diagnostic logging only** (no behaviour/logic change) across the
>   agent-status-dots pipeline so a shipped build can be used to debug
>   flaky/inconsistent dots. Applied via `patches/notification-logging.patch`
>   AFTER the JSONL-watcher and xterm patches. The pane-map hook's Python
>   gains a `_log()` writing one JSON line per invocation to
>   `~/.superset/pane-map-hook.log` (records phase + skipReason:
>   missing-terminal-env / missing-session-id / invalid-payload-json /
>   payload-not-object / mkdir-failed / write-failed, gated by
>   `SUPERSET_AGENT_WATCHER_DEBUG`); the watcher gains an `eventId`
>   join-key plus `mapping_load` and enriched `transition` /
>   `transition-suppressed` records in `~/.superset/agent-watcher-debug.log`;
>   `main/windows/main.ts` gains a **production** `console-message`
>   forwarder that persists renderer `[agent-dots]` lines to `electron-log`
>   (`main.log`); and the renderer (`V2NotificationController`,
>   `lifecycleEvents.ts`, the `v2-notifications` store) emits `[agent-dots]`
>   records — `electron_agent_lifecycle_received`, a per-`return`
>   `…_drop` carrying a `reason` (missing-workspaceId / missing-terminalId /
>   workspace-not-loaded — the highest-value diagnostic for "dot never
>   lit"), `status_transition_computed`, and `store_mutation`. Selectors
>   (hot path) are deliberately not instrumented. Every log site is gated
>   and wrapped so it can never throw. Guard SKIPS (warns) rather than
>   aborts — diagnostics are non-essential and must not block the build
>   (`git apply`, idempotent; marker `pane-map-hook.log`).
> - adds per-thread **Snooze** (timed hide that auto-returns) and **Archive**
>   (sticky bucket) states to the v2 dashboard sidebar, plus per-project
>   revealable collapsible Snoozed/Archived sections (reveal + collapse remembered
>   per project; active-only count badge; hover restore icons; bulk
>   unsnooze/unarchive on the section header). Snooze persists an absolute
>   `snoozeUntil` (+ a per-launch id for "until next launch") and a ~30s ticker
>   auto-returns expired snoozes; Archive reuses the existing
>   `isHidden`/remove-from-sidebar plumbing keyed on a new `archivedAt`, replacing
>   the per-thread "Remove from Sidebar" (legacy hidden rows resurface as
>   archived). Local-only (no cloud schema change); snooze/archive never tear down
>   the worktree or running session. Applied deterministically via
>   `patches/thread-snooze-archive.patch` as git-apply step **(AL)** (`git apply`,
>   idempotent + fail-fast; markers `snoozeUntil` / `archivedAt` /
>   `DashboardSidebarStateSection`). Re-anchored on top of **(AE)**
>   nongit-workspaces + **(AG)** badge — which also edit
>   `DashboardSidebarWorkspaceContextMenu`/`useDiffStats` and
>   `DashboardSidebarWorkspaceItem`/`DashboardSidebarExpandedWorkspaceRow` — so
>   **(AL)** must run after them (it does); validated by a real `git apply` on a
>   fresh base+(AE)+(AG) LF tree. No AI patch (0–33) edits these files.
>
> This keeps the patch set portable while making the ARM64 handling
> reproducible and independent of LLM non-determinism.

---

# Windows Patches for Superset

## Instructions for AI Agent

You are patching a fresh clone of [superset-sh/superset](https://github.com/superset-sh/superset) for Windows compatibility. Apply each patch in order. **Read the target file first**, then make the described edit. If upstream has changed the code since these instructions were written, **adapt the patch to fit** — the intent and rationale for each patch are described so you can make intelligent adjustments.

After all patches are applied, run:
```bash
bun install
cd apps/desktop
bun run generate:icons
bun run compile:app
bun run copy:native-modules
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --win --publish never --config electron-builder.ts
```

The installer will be at `apps/desktop/release/Superset-<version>-x64.exe`.

---

## Patch 0: Pin Mastra packages past Bun's release-age window

**Why:** Upstream `desktop-v1.9.6` pins `@mastra/core@1.33.1` and `mastracode@0.18.1`. The repository's `bunfig.toml` has `minimumReleaseAge = 259200`, so Bun refuses to install package versions published within the last 72 hours. Pin to the closest older versions that satisfy the release-age policy.

**File: `package.json` (root)**
In the existing `"overrides"` object, keep the existing `axios` override and add:
```json
"@mastra/core": "1.33.0",
"mastracode": "0.18.0"
```

**Files:**
- `apps/desktop/package.json`
- `packages/chat/package.json`
- `packages/host-service/package.json`

In each file, change dependency values from:
```json
"@mastra/core": "1.33.1",
"mastracode": "0.18.1"
```

to:
```json
"@mastra/core": "1.33.0",
"mastracode": "0.18.0"
```

---

## Patch 1: Cross-platform postinstall script

**Why:** The default `postinstall.sh` is bash-only and fails on Windows.

**File: `package.json` (root)**
Find the `"postinstall"` script line. Change its value from the bash script (e.g. `"./scripts/postinstall.sh"`) to:
```json
"postinstall": "node scripts/postinstall.mjs"
```

**New file: `scripts/postinstall.mjs`**
Create this file with the following contents:
```javascript
/**
 * Cross-platform postinstall script.
 *
 * Replaces the bash-only postinstall.sh so that `bun install` works on
 * Windows, macOS and Linux without special flags.
 *
 * Steps:
 *  1. Guard against infinite recursion (electron-builder install-app-deps
 *     can trigger nested bun installs which would re-run this script).
 *  2. Run sherif for workspace validation.
 *  3. Install native dependencies for the desktop app.
 */

import { execSync } from "node:child_process";

// Prevent infinite recursion during postinstall
if (process.env.SUPERSET_POSTINSTALL_RUNNING) {
	process.exit(0);
}
process.env.SUPERSET_POSTINSTALL_RUNNING = "1";

const env = { ...process.env, SUPERSET_POSTINSTALL_RUNNING: "1" };

/** Run a command, inheriting stdio so output is visible. */
function run(cmd) {
	execSync(cmd, { stdio: "inherit", env });
}

/** Run a command but don't fail if it errors (for optional native deps on Windows). */
function tryRun(cmd, label) {
	try {
		execSync(cmd, { stdio: "inherit", env });
	} catch {
		console.warn(`[postinstall] ${label} failed (non-fatal on Windows) — continuing`);
	}
}

// Run sherif for workspace validation
run("sherif");

// Install native dependencies for desktop app.
// On Windows, native module compilation may fail if Visual Studio Build Tools
// are not installed. This is non-fatal — prebuilt binaries will be used when available.
if (process.platform === "win32") {
	tryRun("bun run --filter=@superset/desktop install:deps", "install:deps");
} else {
	run("bun run --filter=@superset/desktop install:deps");
}
```

---

## Patch 2: Fix TDZ in Rollup banner + strip crossorigin + defineEnv fix

**Why:** Three related Vite/Rollup fixes:
1. The ELECTRON_RUN_AS_NODE banner must use `globalThis.process` to avoid a Temporal Dead Zone error in chunks that declare `const process = require("node:process")`.
2. Vite's `crossorigin` attribute on script/link tags breaks Electron's ASAR file:// handler on Windows.
3. `defineEnv` should use `||` instead of `??` so empty strings from unresolved CI secrets fall back to defaults.

**File: `apps/desktop/electron.vite.config.ts`**

1. Add `stripCrossOriginPlugin` to the imports from `./vite/helpers`:
   ```typescript
   import {
     defineEnv,
     devPath,
     htmlEnvTransformPlugin,
     stripCrossOriginPlugin,  // ADD THIS
   } from "./vite/helpers";
   ```

2. Find the `output:` object inside the main process `rollupOptions`. Add a `banner` property inside it:
   ```typescript
   output: {
     dir: resolve(devPath, "main"),
     // VS Code and other Electron hosts set ELECTRON_RUN_AS_NODE=1 which
     // prevents Electron from entering browser mode. Clear it before any
     // require("electron") call — must be the very first statement.
     banner:
       'delete globalThis.process.env.ELECTRON_RUN_AS_NODE;',
   },
   ```

3. In the renderer `plugins` array, add `stripCrossOriginPlugin()` after `htmlEnvTransformPlugin()`:
   ```typescript
   reactPlugin(),
   htmlEnvTransformPlugin(),
   stripCrossOriginPlugin(),  // ADD THIS
   ```

**File: `apps/desktop/vite/helpers.ts`**

1. In the `defineEnv` function, change `value ?? fallback` to `value || fallback`:
   ```typescript
   return JSON.stringify(value || fallback);
   ```

2. Add the `stripCrossOriginPlugin` function after the `copyResourcesPlugin` function:
   ```typescript
   /**
    * Strips the `crossorigin` attribute that Vite adds to script/link tags.
    * Electron's ASAR file:// handler doesn't support CORS on Windows,
    * so crossorigin causes scripts/styles to silently fail to load (black screen).
    */
   export function stripCrossOriginPlugin(): Plugin {
     return {
       name: "strip-crossorigin",
       transformIndexHtml: {
         order: "post",
         handler(html) {
           if (process.platform !== "win32") return html;
           return html.replace(/ crossorigin(?:="[^"]*")?/g, "");
         },
       },
     };
   }
   ```

---

## Patch 3: (REMOVED — GPU hardware acceleration stays enabled on Windows)

**This patch has been intentionally removed.** The original black/blank screen issues on Windows were caused by CORS and protocol problems, which are fixed by Patch 2 (stripCrossOriginPlugin) and Patch 5 (custom protocol). Disabling GPU acceleration globally degrades UI performance — every scroll, animation, and CSS transform is forced to CPU rendering, making the app feel sluggish and increasing memory usage. Keep the upstream default (GPU enabled).

**No changes needed.** Do NOT modify `apps/desktop/src/lib/electron-app/factories/app/setup.ts` for this patch.

---

## Patch 4: Fix Windows junction removal in copy-native-modules

**Why:** Windows uses NTFS junctions (directory-like) instead of symlinks. `rmSync` needs `{ recursive: true }` to remove them.

**File: `apps/desktop/scripts/copy-native-modules.ts`**

Find the symlink removal line inside the `copyModuleIfSymlink` function:
```typescript
rmSync(modulePath);
```

Replace with:
```typescript
// Windows uses junctions (directory-like) instead of symlinks;
// rmSync needs { recursive: true } to remove them.
if (process.platform === "win32") {
  rmSync(modulePath, { recursive: true, force: true });
} else {
  rmSync(modulePath);
}
```

---

## Patch 5: Custom protocol + CORS bypass for Windows

**Why:** `file://` protocol breaks ES module dynamic imports (code-split chunks) on Windows. A custom `superset-app://` protocol serves renderer files properly. CORS bypass headers are needed because the API server doesn't recognize the custom protocol origin.

**File: `apps/desktop/src/lib/window-loader.ts`**

Find the production branch that loads from file (the `else` clause after the development URL branch). Add a Windows-specific case before it:

```typescript
} else if (process.platform === "win32") {
  // Production (Windows): use custom protocol for proper dynamic import support.
  // file:// protocol breaks ES module dynamic imports (code-split chunks) on Windows.
  const url = "superset-app://app/index.html#/";
  console.log("[window-loader] Loading custom protocol URL:", url);
  props.browserWindow.loadURL(url);
} else {
  // Production (macOS/Linux): load from file with hash routing
```

**File: `apps/desktop/src/main/index.ts`**

1. Find the `protocol.registerSchemesAsPrivileged([...])` call. Add a new scheme entry to the array:
   ```typescript
   {
     scheme: "superset-app",
     privileges: {
       standard: true,
       secure: true,
       supportFetchAPI: true,
       corsEnabled: true,
     },
   },
   ```

2. Inside the `app.whenReady()` callback, after the `superset-icon` protocol handler registration, add the following block:
   ```typescript
   // Register custom protocol for serving renderer files.
   // Dynamic imports (code-split chunks) fail on file:// protocol in Electron on Windows.
   const rendererDir = path.join(__dirname, "../renderer");
   const appProtocolHandler = (request: Request) => {
     let urlPath = new URL(request.url).pathname;
     if (urlPath.startsWith("/")) urlPath = urlPath.slice(1);
     const filePath = path.join(rendererDir, urlPath);
     return net.fetch(pathToFileURL(filePath).toString());
   };
   protocol.handle("superset-app", appProtocolHandler);
   session
     .fromPartition("persist:superset")
     .protocol.handle("superset-app", appProtocolHandler);

   // On Windows, the custom superset-app:// protocol origin is not recognized by
   // the API server's CORS policy. Bypass CORS for API requests by modifying headers.
   if (PLATFORM.IS_WINDOWS) {
     const appSession = session.fromPartition("persist:superset");
     appSession.webRequest.onBeforeSendHeaders(
       { urls: ["https://api.superset.sh/*", "https://*.posthog.com/*", "https://*.sentry.io/*", "https://app.outlit.ai/*"] },
       (details, callback) => {
         if (details.requestHeaders.Origin === "superset-app://app") {
           delete details.requestHeaders.Origin;
         }
         callback({ requestHeaders: details.requestHeaders });
       },
     );
     appSession.webRequest.onHeadersReceived(
       { urls: ["https://api.superset.sh/*"] },
       (details, callback) => {
         const headers = details.responseHeaders ?? {};
         headers["access-control-allow-origin"] = ["superset-app://app"];
         headers["access-control-allow-credentials"] = ["true"];
         callback({ responseHeaders: headers });
       },
     );
   }
   ```

   Make sure `net` and `pathToFileURL` are imported. `net` comes from `electron`, `pathToFileURL` from `node:url`. Check the existing imports and add if missing.

---

## Patch 6: Feature flag default to prevent infinite render block

**Why:** When PostHog is not configured (no key), feature flags stay `undefined` forever. The app blocks rendering waiting for them, causing a permanent blank/white screen.

**File: `apps/desktop/src/renderer/routes/_authenticated/providers/CollectionsProvider/CollectionsProvider.tsx`**

Find the block that returns `null` when the feature flag is undefined. It looks like this (may include an `env.SKIP_ENV_VALIDATION` guard):
```typescript
if (useElectricCloud === undefined && !env.SKIP_ENV_VALIDATION) {
  return null;
}
```

**Delete that entire `if` block** (remove all 3 lines). Then, immediately before the `setElectricUrl(...)` call, add:
```typescript
// When PostHog is not configured (no key), feature flags stay undefined forever.
// Default to false (use proxy) so the app doesn't block rendering.
const isElectricCloud = useElectricCloud ?? false;
```

Then change the `setElectricUrl` call to use `isElectricCloud` instead of `useElectricCloud`:
```typescript
setElectricUrl(
  isElectricCloud
    ? env.NEXT_PUBLIC_ELECTRIC_URL
    : env.NEXT_PUBLIC_ELECTRIC_PROXY_URL,
);
```

---

## Patch 7: Forward renderer console messages on Windows

**Why:** On Windows, renderer warnings/errors aren't visible in the terminal. This forwards them to stdout for debugging.

**File: `apps/desktop/src/main/windows/main.ts`**

Find the `MainWindow()` function. After the existing event handlers (look for window bounds persistence or similar), add:

```typescript
// Forward renderer warning/error messages to main process stdout for Windows debugging.
if (PLATFORM.IS_WINDOWS) {
  window.webContents.on(
    "console-message",
    (_event, level, message, line, sourceId) => {
      if (level < 2) return;
      const levelStr =
        ["verbose", "info", "warning", "error"][level] ?? "unknown";
      const source = sourceId ? ` (${sourceId}:${line})` : "";
      const formatted = `[renderer:${levelStr}] ${message}${source}`;
      if (level === 3) console.error(formatted);
      else console.warn(formatted);
    },
  );
}
```

Make sure `PLATFORM` is imported from `shared/constants` (it likely already is).

---

## Patch 8: Terminal named pipes for Windows

**Why:** Windows doesn't support Unix domain sockets. The terminal host daemon must use Windows named pipes (`\\.\pipe\superset-terminal-host-<user>`) instead.

**New file: `apps/desktop/src/main/lib/terminal-host/paths.ts`**

Create this file:
```typescript
import { homedir } from "node:os";
import { join } from "node:path";
import { SUPERSET_DIR_NAME } from "shared/constants";

const IS_WINDOWS = process.platform === "win32";

const SUPERSET_HOME_DIR = join(homedir(), SUPERSET_DIR_NAME);

const PIPE_SUFFIX = (
  process.env.USERNAME ?? process.env.USER ?? "user"
).replace(/[^a-zA-Z0-9_.-]/g, "_");

const SOCKET_PATH = IS_WINDOWS
  ? `\\\\.\\pipe\\superset-terminal-host-${PIPE_SUFFIX}`
  : join(SUPERSET_HOME_DIR, "terminal-host.sock");

export const TERMINAL_HOST_PATHS = {
  IS_WINDOWS,
  SUPERSET_DIR_NAME,
  SUPERSET_HOME_DIR,
  SOCKET_PATH,
  TOKEN_PATH: join(SUPERSET_HOME_DIR, "terminal-host.token"),
  PID_PATH: join(SUPERSET_HOME_DIR, "terminal-host.pid"),
  SPAWN_LOCK_PATH: join(SUPERSET_HOME_DIR, "terminal-host.spawn.lock"),
  SCRIPT_MTIME_PATH: join(SUPERSET_HOME_DIR, "terminal-host.mtime"),
};
```

**File: `apps/desktop/src/main/lib/terminal-host/client.ts`**

1. Remove `import { homedir } from "node:os";` (if `homedir` is no longer used elsewhere in the file).
2. Replace the import of `SUPERSET_DIR_NAME` from `shared/constants` with:
   ```typescript
   import { TERMINAL_HOST_PATHS } from "./paths";
   ```
3. Replace the hardcoded path constants block (SUPERSET_HOME_DIR, SOCKET_PATH, TOKEN_PATH, PID_PATH, SPAWN_LOCK_PATH, SCRIPT_MTIME_PATH) with:
   ```typescript
   const {
     IS_WINDOWS,
     SUPERSET_DIR_NAME,
     SUPERSET_HOME_DIR,
     SOCKET_PATH,
     TOKEN_PATH,
     PID_PATH,
     SPAWN_LOCK_PATH,
     SCRIPT_MTIME_PATH,
   } = TERMINAL_HOST_PATHS;
   ```
4. Find every `!existsSync(SOCKET_PATH)` check and prepend `!IS_WINDOWS &&`:
   ```typescript
   if (!IS_WINDOWS && !existsSync(SOCKET_PATH)) {
   ```
   There should be approximately 5 occurrences.
5. Find `if (existsSync(SOCKET_PATH))` in the `spawnDaemon` method. Change to:
   ```typescript
   if (IS_WINDOWS || existsSync(SOCKET_PATH)) {
   ```
6. Wrap the stale socket `unlinkSync(SOCKET_PATH)` block in `!IS_WINDOWS`:
   ```typescript
   if (!IS_WINDOWS) {
     if (DEBUG_CLIENT) {
       console.log("[TerminalHostClient] Removing stale socket file");
     }
     try {
       unlinkSync(SOCKET_PATH);
     } catch {
       // Ignore
     }
   }
   ```
7. In `waitForDaemon`, replace `if (existsSync(SOCKET_PATH))` with:
   ```typescript
   const live = await this.isSocketLive();
   if (live) {
   ```

**File: `apps/desktop/src/main/terminal-host/index.ts`**

1. Remove `import { homedir } from "node:os";` and the `join` import from `node:path` (if no longer used elsewhere).
2. Replace the import of `SUPERSET_DIR_NAME` with:
   ```typescript
   import { TERMINAL_HOST_PATHS } from "../lib/terminal-host/paths";
   ```
3. Replace hardcoded path constants with:
   ```typescript
   const {
     IS_WINDOWS,
     SUPERSET_HOME_DIR,
     SOCKET_PATH,
     TOKEN_PATH,
     PID_PATH,
   } = TERMINAL_HOST_PATHS;
   ```
4. In `isSocketLive()`, add `!IS_WINDOWS &&` before `!existsSync(SOCKET_PATH)`.
5. In `startServer()`, change `if (existsSync(SOCKET_PATH))` to `if (IS_WINDOWS || existsSync(SOCKET_PATH))`.
6. Wrap the stale socket `unlinkSync` in `startServer` with `if (!IS_WINDOWS)`.

**File: `apps/desktop/src/main/lib/terminal/dev-reset.ts`**

1. Add: `import { TERMINAL_HOST_PATHS } from "main/lib/terminal-host/paths";`
2. Remove `"terminal-host.sock"` from the `TERMINAL_STATE_PATHS` array.
3. Add after the array:
   ```typescript
   const TERMINAL_STATE_PATHS_WITH_SOCKET = TERMINAL_HOST_PATHS.IS_WINDOWS
     ? TERMINAL_STATE_PATHS
     : (["terminal-host.sock", ...TERMINAL_STATE_PATHS] as const);
   ```
4. In the cleanup loop, change `TERMINAL_STATE_PATHS` to `TERMINAL_STATE_PATHS_WITH_SOCKET`.

---

## Patch 9: Fix double-nested dist/main path for daemon and worker scripts

**Why:** When running `electron dist/main/index.js` directly, `app.getAppPath()` returns `dist/main/`. Joining with `dist/main/terminal-host.js` produces `dist/main/dist/main/terminal-host.js`.

**File: `apps/desktop/src/main/lib/terminal-host/client.ts`**

Find `getDaemonScriptPath()`. Replace it with:
```typescript
private getDaemonScriptPath(): string {
  const appPath = app.getAppPath();
  // When running `electron dist/main/index.js` directly, appPath is already
  // the dist/main directory. Check for the script there first to avoid
  // double-nesting (dist/main/dist/main/terminal-host.js).
  const direct = join(appPath, "terminal-host.js");
  if (existsSync(direct)) {
    return direct;
  }
  // Packaged app or running from project root
  return join(appPath, "dist", "main", "terminal-host.js");
}
```

**File: `apps/desktop/src/lib/trpc/routers/changes/workers/git-task-runner.ts`**

Find `getWorkerScriptPath()`. Inside the `try` block, after `const appPath = ...`, add:
```typescript
// When running `electron dist/main/index.js` directly, appPath is already
// the dist/main directory. Check for the script there first to avoid
// double-nesting (dist/main/dist/main/git-task-worker.js).
const { existsSync } = require("node:fs") as typeof import("node:fs");
const direct = join(appPath, "git-task-worker.js");
if (existsSync(direct)) {
  return direct;
}
```

---

## Patch 10: Switch node-pty to @lydell/node-pty for Windows

**Why:** `@lydell/node-pty` provides prebuilt Windows native binaries (conpty.node) that don't require Visual Studio Build Tools.

**File: `apps/desktop/package.json`**

Find the `"node-pty"` dependency line. Change it from whatever version it is to:
```json
"node-pty": "npm:@lydell/node-pty@^1.0.1",
```

---

## Patch 11: Add missing Windows env vars to PTY allowlist

**Why:** Without `SYSTEMDRIVE` in the terminal environment, tools like .NET/NuGet that reference `%SystemDrive%` create files in a literal `%SystemDrive%` directory.

**File: `apps/desktop/src/main/lib/terminal/env.ts`**

Find the `ALLOWED_ENV_VARS` set. In the Windows-specific section (look for `COMSPEC`, `USERPROFILE`, etc.), add these entries:
```typescript
"PROGRAMDATA",
"SYSTEMDRIVE",
```
after `"PROGRAMFILES(X86)"`.

Also add after `"PATHEXT"`:
```typescript
"NUMBER_OF_PROCESSORS", // Used by MSBuild for parallel builds
"PROCESSOR_ARCHITECTURE", // Used by native toolchains (x86/AMD64/ARM64)
```

---

## Patch 12: Windows NSIS installer configuration

**Why:** Configures electron-builder for Windows with proper icons, NSIS installer options, native module handling, and code signing toggle.

**File: `apps/desktop/electron-builder.ts`**

1. Near the top, after the `productName` declaration, add:
   ```typescript
   const disableWinSigning = process.env.SUPERSET_DISABLE_WIN_SIGNING === "1";
   ```

2. In `extraResources`, add an entry for icons:
   ```typescript
   {
     from: join(pkg.resources, "build/icons"),
     to: "build/icons",
     filter: ["**/*"],
   },
   ```

3. Replace the `files` array. Change:
   ```typescript
   files: [
     "dist/**/*",
     "package.json",
     {
       from: pkg.resources,
       to: "resources",
       filter: ["**/*"],
     },
   ```
   To:
   ```typescript
   files: [
     {
       filter: ["dist/**/*", "!dist/resources/migrations/**", "package.json"],
     },
     {
       from: pkg.resources,
       to: "resources",
       filter: ["**/*", "!build/**"],
     },
   ```

4. Change `npmRebuild: true` to:
   ```typescript
   npmRebuild: process.platform !== "win32",
   ```

5. In the `win` section, add after `artifactName`:
   ```typescript
   asarUnpack: ["**/node_modules/@lydell/node-pty-win32-x64/**/*"],
   files: [
     {
       from: "node_modules/@lydell/node-pty-win32-x64",
       to: "node_modules/@lydell/node-pty-win32-x64",
       filter: ["**/*"],
     },
   ],
   ```

6. In the `nsis` section, add:
   ```typescript
   createDesktopShortcut: true,
   createStartMenuShortcut: true,
   shortcutName: productName,
   installerIcon: join(pkg.resources, "build/icons/icon.ico"),
   uninstallerIcon: join(pkg.resources, "build/icons/icon.ico"),
   ```

**File: `apps/desktop/package.json`**

Find the `"build"` script. Add `--config electron-builder.ts` to the electron-builder command:
```json
"build": "cross-env CSC_IDENTITY_AUTO_DISCOVERY=false electron-builder --publish never --config electron-builder.ts",
```

---

## Patch 13: Windows app resolution for "Open in" actions

**Why:** The "Open in VS Code/Terminal/Finder" feature only handles macOS and Linux. Windows needs exe path auto-detection.

**File: `apps/desktop/src/lib/trpc/routers/external/helpers.ts`**

1. Add the filesystem imports needed for Windows app discovery at the top (alongside existing imports):
   ```typescript
   import { existsSync, readdirSync, statSync } from "node:fs";
   ```

2. After the `LINUX_CLI_CANDIDATES` object, add the entire Windows app resolution system. This includes:
   - A `WindowsAppConfig` type
   - A `WINDOWS_APP_CONFIG` record mapping every `ExternalApp` to Windows launcher info (cli name, direct CLI script paths such as `bin\\code.cmd`, GUI exe names, install directories, JetBrains exe names, custom args)
   - Helper functions: `resolveTerminalTarget`, `getWindowsProgramRoots`, `buildWindowsCommandCandidates`, `buildWindowsExeCandidates`, `findJetBrainsExe`, and any additional JetBrains Toolbox helpers you need
   - A `getWindowsAppCommand` function that tries: full CLI script path / GUI exe path / JetBrains resolution, then CLI fallback

   **IMPORTANT**: The `getWindowsProgramRoots` function MUST include `LOCALAPPDATA\Programs` as a search root. Most Windows apps (VS Code, Cursor, etc.) install per-user under `%LOCALAPPDATA%\Programs\`, NOT directly in `%LOCALAPPDATA%\`. The function should return:
   ```typescript
   function getWindowsProgramRoots(): string[] {
     const roots: string[] = [];
     const pf = process.env.ProgramFiles;
     const pfx86 = process.env["ProgramFiles(x86)"];
     const localAppData = process.env.LOCALAPPDATA;
     if (pf) roots.push(pf);
     if (pfx86) roots.push(pfx86);
     if (localAppData) {
       roots.push(nodePath.join(localAppData, "Programs")); // User installs (VS Code, Cursor, etc.)
       roots.push(localAppData);
     }
     return roots;
   }
   ```

   Key Windows app configs:
   - **vscode**: cli `code`, exe `Code.exe`, install dir `Microsoft VS Code`
   - **cursor**: cli `cursor`, exe `Cursor.exe`, install dir `Cursor`
   - **terminal**: cli `wt`, exe `wt.exe`/`WindowsTerminal.exe`, args `["-d", targetDir]`
   - **JetBrains IDEs**: search `Program Files/JetBrains/<product>/bin/<exe>` and Toolbox paths
   - **macOS-only apps** (xcode, iterm, appcode): empty config `{}`

3. In `getAppCommand()`, add a `win32` check at the top before the `darwin` check:
   ```typescript
   if (platform === "win32") {
     return getWindowsAppCommand(app, targetPath);
   }
   ```

4. In `spawnAsync`, pass `windowsHide: true` in the spawn options so fallback
   CLI launches do not show transient console windows on Windows. Also teach
   it how to launch full-path Windows `.cmd`/`.bat` shims (for example
   `%LOCALAPPDATA%\\Programs\\Microsoft VS Code\\bin\\code.cmd`) via
   `cmd.exe`/`shell: true`; a direct `spawn("...\\code.cmd")` can fail with
   `EINVAL` on Windows even when the file exists.

5. When `getWindowsAppCommand()` returns discovered GUI executable paths
   (`Code.exe`, `Cursor.exe`, JetBrains `*.exe`, etc.), tag those candidates
   with `waitForExit: false`. Keep CLI-style candidates (`code.cmd`, `code`,
   `cursor`, etc.) exit-checked. In `openPathInApp()`, pass this flag through
   to `spawnAsync`. `spawnAsync` should resolve on the child `spawn` event and
   `unref()` for `waitForExit: false`; otherwise the Open button can remain
   pending until VS Code/Cursor exits even though the editor has launched.

---

## Patch 14: Materialize @lydell/node-pty platform binary from Bun store

**Why:** `@lydell/node-pty` loads its native binary via `require("@lydell/node-pty-win32-x64/conpty.node")`. Bun keeps optional dependencies in its internal `.bun/` store, so they're not resolvable from the desktop workspace's `node_modules`. Without this, PTY spawn fails with "PTY not spawned".

**File: `apps/desktop/scripts/copy-native-modules.ts`**

1. After the `NATIVE_MODULE_DEPS` array, add a new array for platform-specific optional modules:
   ```typescript
   // Platform-specific optional native packages that must be materialized from Bun's store.
   // @lydell/node-pty uses optionalDependencies for platform binaries, but Bun keeps them
   // in .bun/ and they aren't resolvable from the desktop workspace without explicit copying.
   const OPTIONAL_PLATFORM_MODULES = [
     ...(process.platform === "win32" ? ["@lydell/node-pty-win32-x64"] : []),
     ...(process.platform === "darwin" && process.arch === "arm64" ? ["@lydell/node-pty-darwin-arm64"] : []),
     ...(process.platform === "darwin" && process.arch === "x64" ? ["@lydell/node-pty-darwin-x64"] : []),
     ...(process.platform === "linux" && process.arch === "x64" ? ["@lydell/node-pty-linux-x64"] : []),
     ...(process.platform === "linux" && process.arch === "arm64" ? ["@lydell/node-pty-linux-arm64"] : []),
   ] as const;
   ```

2. In the `prepareNativeModules()` function, before `console.log("\nDone!");`, add a block to copy these platform modules from Bun's store:
   ```typescript
   if (OPTIONAL_PLATFORM_MODULES.length > 0) {
     console.log("\nPreparing platform-specific optional modules...");
     const bunStoreDir = getBunStoreDir(nodeModulesDir);
     for (const moduleName of OPTIONAL_PLATFORM_MODULES) {
       const destPath = join(nodeModulesDir, moduleName);
       if (existsSync(destPath)) {
         console.log(`  ${moduleName}: already exists`);
         continue;
       }
       // Search Bun store for the package
       const bunPrefix = moduleName.startsWith("@")
         ? moduleName.replace("/", "+")
         : moduleName;
       const bunStoreEntries = existsSync(bunStoreDir)
         ? readdirSync(bunStoreDir).filter((e) => e.startsWith(`${bunPrefix}@`))
         : [];
       if (bunStoreEntries.length === 0) {
         console.warn(`  ${moduleName}: not found in Bun store (skipping)`);
         continue;
       }
       const sourcePath = join(
         bunStoreDir,
         bunStoreEntries.sort().reverse()[0],
         "node_modules",
         moduleName,
       );
       if (!existsSync(sourcePath)) {
         console.warn(`  ${moduleName}: Bun store path missing (${sourcePath})`);
         continue;
       }
       console.log(`  ${moduleName}: copying from Bun store`);
       mkdirSync(dirname(destPath), { recursive: true });
       cpSync(sourcePath, destPath, { recursive: true });
     }
   }
   ```

   Note: `getBunStoreDir`, `mkdirSync`, `dirname`, `readdirSync`, `cpSync`, `existsSync` should already be imported/available in this file. Verify before adding.

---

## Patch 15: Use \r instead of \n for terminal command execution on Windows

**Why:** Windows ConPTY expects `\r` (carriage return) to trigger command execution, not `\n` (linefeed). Without this, agent launch commands are typed into the terminal but not executed — the user has to manually press Enter.

**Files:**
- `apps/desktop/src/renderer/lib/terminal/launch-command.ts`
- `packages/host-service/src/terminal/terminal.ts`

V1 and some renderer-driven command launches go through
`launch-command.ts`. V2 preset launches go through host-service
`initialCommand` queuing, so both surfaces must use `\r` on Windows.

**File: `apps/desktop/src/renderer/lib/terminal/launch-command.ts`**

Find the `normalizeTerminalCommand` function:
```typescript
function normalizeTerminalCommand(command: string): string {
  return command.endsWith("\n") ? command : `${command}\n`;
}
```

Replace with:
```typescript
function normalizeTerminalCommand(command: string): string {
  // Windows ConPTY expects \r (carriage return) to execute a command,
  // while Unix terminals use \n (newline). Use \r for cross-platform compat
  // as most Unix terminal emulators also accept \r.
  const eol = "\r";
  return command.endsWith("\n") || command.endsWith("\r")
    ? command
    : `${command}${eol}`;
}
```

**File: `packages/host-service/src/terminal/terminal.ts`**

1. Add a platform-specific Enter sequence near the terminal constants:

```typescript
const TERMINAL_COMMAND_EOL = process.platform === "win32" ? "\r" : "\n";
```

2. In `queueInitialCommand`, replace the `\n`-only append logic:

```typescript
const cmd = initialCommand.endsWith("\n")
  ? initialCommand
  : `${initialCommand}\n`;
```

with:

```typescript
const cmd = initialCommand.endsWith("\n") || initialCommand.endsWith("\r")
  ? initialCommand
  : `${initialCommand}${TERMINAL_COMMAND_EOL}`;
```

**Apply this with `.endsWith()`, NEVER a regex literal.** A `/[\r\n]$/` here has
been mangled into an *unterminated regular expression* (a literal CR-LF emitted
inside the character class) during AI application, hard-failing the esbuild build
(`terminal.ts:662: Unterminated regular expression`). The `.endsWith` form is
escape-safe and matches the `launch-command.ts` half above. If the exact anchor
(`queueInitialCommand`) isn't present in this upstream, apply the same
EOL-append at whatever path performs the initial command write — still using
`.endsWith`, not a regex.

Without this host-service change, V2 presets such as Claude open a terminal
with the command typed but do not execute it until the user manually presses
Enter.

---

## Patch 16: Fix sound playback on Windows using Chromium audio engine

**Why:** The original Windows sound implementation uses `System.Media.SoundPlayer` (WAV only) and PowerShell's `System.Windows.Media.MediaPlayer` (WPF) is unreliable on Windows 11 — the WPF audio session doesn't properly wake the audio endpoint from its sleep state, causing silent failures when no other audio is playing on the system. The fix plays audio through **Chromium's built-in audio engine** in the renderer process via `executeJavaScript`. This is the most reliable approach: Chromium's media pipeline properly initializes Windows audio sessions, requires zero external dependencies, and works consistently on Windows 10 and 11.

**File: `apps/desktop/src/renderer/index.html`**

The Content Security Policy blocks `data:` URLs for media (audio). Find the `<meta http-equiv="Content-Security-Policy"` tag. Add `media-src 'self' data:;` to the CSP content. Insert it before the `font-src` directive. For example, find:
```
img-src 'self' data: blob: https: http:; font-src 'self';
```
And add `media-src 'self' data:;` so it becomes:
```
img-src 'self' data: blob: https: http:; media-src 'self' data:; font-src 'self';
```

**File: `apps/desktop/src/main/lib/notification-sound.ts`**

1. Add `readFileSync` to the existing `node:fs` import:
   ```typescript
   import { existsSync, readFileSync } from "node:fs";
   ```

2. Add `BrowserWindow` import from electron:
   ```typescript
   import { BrowserWindow } from "electron";
   ```

3. Find the Windows branch inside `playSoundFile`:
   ```typescript
   } else if (process.platform === "win32") {
     execFile("powershell", [
       "-c",
       `(New-Object Media.SoundPlayer '${soundPath}').PlaySync()`,
     ]);
   }
   ```

   Replace with:
   ```typescript
   } else if (process.platform === "win32") {
     // Play via Chromium's audio engine in the renderer for reliable playback.
     // PowerShell-based approaches (WPF MediaPlayer, SoundPlayer) are unreliable
     // on Windows 11 — the audio endpoint sleep state prevents initialization.
     const windows = BrowserWindow.getAllWindows();
     if (windows.length > 0 && windows[0].webContents) {
       try {
         const buf = readFileSync(soundPath);
         const ext = soundPath.endsWith(".wav") ? "wav" : "mpeg";
         const dataUrl = `data:audio/${ext};base64,${buf.toString("base64")}`;
         windows[0].webContents.executeJavaScript(
           `new Audio(${JSON.stringify(dataUrl)}).play().catch(()=>{})`,
         ).catch(() => {});
       } catch {}
     }
   }
   ```

**File: `apps/desktop/src/lib/trpc/routers/ringtone/index.ts`**

1. Add `readFileSync` to the existing `node:fs` import:
   ```typescript
   import { existsSync, readFileSync } from "node:fs";
   ```

2. Change the `BrowserWindow` import from type-only to a value import. Find:
   ```typescript
   import type { BrowserWindow, OpenDialogOptions } from "electron";
   import { dialog } from "electron";
   ```
   Replace with:
   ```typescript
   import type { OpenDialogOptions } from "electron";
   import { BrowserWindow, dialog } from "electron";
   ```

3. In `stopCurrentSound()`, add Windows renderer audio cleanup. Find:
   ```typescript
   function stopCurrentSound(): void {
     if (currentSession) {
       if (currentSession.process) {
         currentSession.process.kill("SIGKILL");
       }
       currentSession = null;
     }
   }
   ```

   Replace with:
   ```typescript
   function stopCurrentSound(): void {
     if (currentSession) {
       if (currentSession.process) {
         currentSession.process.kill("SIGKILL");
       }
       // Stop any renderer-side audio on Windows
       if (process.platform === "win32") {
         const windows = BrowserWindow.getAllWindows();
         if (windows.length > 0 && windows[0].webContents) {
           windows[0].webContents.executeJavaScript(`
             if (window.__supersetPreviewAudio) {
               window.__supersetPreviewAudio.pause();
               window.__supersetPreviewAudio = null;
             }
           `).catch(() => {});
         }
       }
       currentSession = null;
     }
   }
   ```

4. Find the Windows branch inside `playSoundFile`:
   ```typescript
   } else if (process.platform === "win32") {
     currentSession.process = execFile(
       "powershell",
       ["-c", `(New-Object Media.SoundPlayer '${soundPath}').PlaySync()`],
       () => {
         if (currentSession?.id === sessionId) {
           currentSession = null;
         }
       },
     );
   }
   ```

   Replace with:
   ```typescript
   } else if (process.platform === "win32") {
     // Play via Chromium's audio engine in the renderer for reliable playback.
     const windows = BrowserWindow.getAllWindows();
     if (windows.length > 0 && windows[0].webContents) {
       try {
         const buf = readFileSync(soundPath);
         const ext = soundPath.endsWith(".wav") ? "wav" : "mpeg";
         const dataUrl = `data:audio/${ext};base64,${buf.toString("base64")}`;
         windows[0].webContents.executeJavaScript(`
           (function() {
             if (window.__supersetPreviewAudio) {
               window.__supersetPreviewAudio.pause();
               window.__supersetPreviewAudio = null;
             }
             const audio = new Audio(${JSON.stringify(dataUrl)});
             window.__supersetPreviewAudio = audio;
             audio.play().catch(() => {});
             audio.onended = () => {
               if (window.__supersetPreviewAudio === audio) {
                 window.__supersetPreviewAudio = null;
               }
             };
           })()
         `).catch(() => {});
       } catch {}
     }
     // No child process to track — session clears on stop or next play
   }
   ```

---

## Patch 17: Fix workspace switching shortcut display on Windows

**Why:** The sidebar tooltip hardcodes the `⌘` symbol on all platforms. On Windows/Linux the actual keybinding is `Ctrl+Shift+1-9` (correctly derived by `deriveNonMacDefault`), but the UI still shows `⌘1`. The display should match the actual shortcut.

**File: `apps/desktop/src/renderer/screens/main/components/WorkspaceSidebar/WorkspaceListItem/WorkspaceListItem.tsx`**

1. Do NOT add any new import. This file already imports `electronTrpc` (from
   `renderer/lib/electron-trpc`) — reuse it. There is no `renderer/stores/hotkeys`
   module; `electronTrpc.window.getPlatform` is the existing tRPC route that
   returns `process.platform`.

2. Inside the `WorkspaceListItem` component function body (near the top where the
   other hooks/queries are called), add a platform query:
   ```typescript
   const { data: platform } = electronTrpc.window.getPlatform.useQuery();
   ```

3. Find the hardcoded shortcut display:
   ```tsx
   <span className="text-[10px] text-muted-foreground font-mono tabular-nums shrink-0">
     ⌘{shortcutIndex + 1}
   </span>
   ```

   Replace with:
   ```tsx
   <span className="text-[10px] text-muted-foreground font-mono tabular-nums shrink-0">
     {platform === "darwin" ? "⌘" : "Ctrl+Shift+"}{shortcutIndex + 1}
   </span>
   ```

---

## Patch 18: Windows Ctrl+C (copy) and Ctrl+V (paste) in terminal

**Why:** xterm.js is a terminal emulator, so it follows Unix terminal conventions:
- **Ctrl+C** always sends SIGINT (interrupt) to the process, even when text is selected. On Windows, users expect Ctrl+C to copy selected text (and only interrupt when nothing is selected).
- **Ctrl+V** sends the literal `\x16` character (ASCII SYN) to the terminal instead of pasting. On Windows, users expect Ctrl+V to paste from clipboard. (Ctrl+Shift+V works because xterm.js has built-in support for that as the "terminal paste" shortcut.)

**File: `apps/desktop/src/renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/Terminal/helpers.ts`**

Find the `setupKeyboardHandler()` function. Inside the `handler` function, find the line:
```typescript
if (isTerminalReservedEvent(event)) return true;
```

**Immediately before** that line (after the Ctrl+Right word navigation block), add the following two blocks:

```typescript
// Windows: Ctrl+C copies selected text to clipboard; if nothing is
// selected, fall through to send the normal interrupt signal.
if (
  isWindows &&
  event.type === "keydown" &&
  event.ctrlKey &&
  !event.shiftKey &&
  !event.altKey &&
  event.key === "c"
) {
  if (xterm.hasSelection()) {
    navigator.clipboard.writeText(xterm.getSelection());
    xterm.clearSelection();
    return false; // Copied — don't send interrupt
  }
  // No selection — fall through to terminal reserved handler (interrupt)
}

// Windows: Ctrl+V pastes from clipboard.
// xterm.js defaults to sending \x16 for Ctrl+V (Unix "quoted insert").
// Return false to block \x16 — the browser will fire a native paste event
// which setupPasteHandler() already handles (with chunking, bracketed paste, etc.).
if (
  isWindows &&
  event.type === "keydown" &&
  event.ctrlKey &&
  !event.shiftKey &&
  !event.altKey &&
  event.key === "v"
) {
  return false; // Block \x16; native paste event handles the rest
}
```

The result should look like:
```typescript
    // ... Ctrl+Right word navigation block above ...

    // Windows: Ctrl+C copies selected text ...
    if (isWindows && ...) { ... }

    // Windows: Ctrl+V pastes from clipboard ...
    if (isWindows && ...) { ... }

    if (isTerminalReservedEvent(event)) return true;
```

---

## Patch 19: Fix quit confirmation dialog on Windows

**Why:** On Windows, when the user closes the app (X button, Alt+F4, or taskbar close), the window closes immediately and THEN the quit confirmation dialog appears from the `before-quit` handler. By that point the window is already gone, so the dialog is useless. This happens because the event flow on Windows is: `window.close()` → window closes visually → `window-all-closed` → `app.quit()` → `before-quit`. The confirmation must happen at the BrowserWindow `close` event, BEFORE the window disappears.

**File: `apps/desktop/src/main/windows/main.ts`**

1. Add `dialog` to the electron import (it already imports `app`, `Notification`, `nativeTheme`):
   ```typescript
   import { app, dialog, Notification, nativeTheme } from "electron";
   ```

2. Add `settings` to the `@superset/local-db` import:
   ```typescript
   import { settings, workspaces, worktrees } from "@superset/local-db";
   ```

3. Add `DEFAULT_CONFIRM_ON_QUIT` to the `shared/constants` import:
   ```typescript
   import { DEFAULT_CONFIRM_ON_QUIT, NOTIFICATION_EVENTS, PLATFORM } from "shared/constants";
   ```

4. Find the `window.on("close", () => {` handler. Change the signature to receive the event parameter:
   ```typescript
   window.on("close", (event) => {
   ```

5. Add this block at the very top of the `close` handler, before the `saveWindowState` call:
   ```typescript
   // Windows: show quit confirmation BEFORE the window closes.
   // The before-quit handler fires too late on Windows (window is already gone).
   if (PLATFORM.IS_WINDOWS) {
     let confirmOnQuit = DEFAULT_CONFIRM_ON_QUIT;
     try {
       const row = localDb.select().from(settings).get();
       confirmOnQuit = row?.confirmOnQuit ?? DEFAULT_CONFIRM_ON_QUIT;
     } catch {}

     if (confirmOnQuit) {
       event.preventDefault();
       dialog
         .showMessageBox(window, {
           type: "question",
           buttons: ["Quit", "Cancel"],
           defaultId: 0,
           cancelId: 1,
           title: "Quit Superset",
           message: "Are you sure you want to quit?",
         })
         .then(({ response }) => {
           if (response === 0) {
             window.destroy(); // Bypass close event to avoid loop
           }
         });
       return;
     }
   }
   ```

   The handler should now look like:
   ```typescript
   window.on("close", (event) => {
     // Windows: show quit confirmation BEFORE the window closes.
     if (PLATFORM.IS_WINDOWS) {
       // ... confirmation block above ...
     }

     // Save window state first, before any cleanup
     const isMaximized = window.isMaximized();
     // ... rest of existing cleanup code ...
   });
   ```

**File: `apps/desktop/src/main/index.ts`**

In the `app.on("before-quit", ...)` handler, skip the confirmation on Windows since it's now handled at the window `close` event level. Find:
```typescript
const shouldConfirm =
  !skipConfirmation && !isDev && getConfirmOnQuitSetting();
```

Change to:
```typescript
const shouldConfirm =
  !skipConfirmation && !isDev && !PLATFORM.IS_WINDOWS && getConfirmOnQuitSetting();
```

Make sure `PLATFORM` is imported from `shared/constants` in this file (check the existing imports and add if missing).

---

## Patch 20: Fix terminal rendering on initial open (Windows)

**Why:** When a new terminal opens on Windows, the content appears garbled/overlapping — text renders on top of itself with wrong column/row calculations. Programs that use alternate screen mode (like Claude Code, vim, less) show old content underneath instead of a clean screen. Switching to another tab and back fixes it because `runReattachRecovery()` fires which calls `clearTextureAtlas()` + `fit()` + `refresh()`. The root cause is that after the WebGL renderer loads asynchronously and swaps from the DOM renderer, no recovery is performed. The fix: trigger the same recovery sequence that tab-switching does, after the WebGL renderer loads.

**File: `apps/desktop/src/renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/Terminal/helpers.ts`**

Find the `requestAnimationFrame` block that loads the WebGL renderer inside `createTerminalInstance()`:
```typescript
rafId = requestAnimationFrame(() => {
  rafId = null;
  if (isDisposed) return;
  rendererRef.current = loadRenderer(xterm);
});
```

Replace with:
```typescript
rafId = requestAnimationFrame(() => {
  rafId = null;
  if (isDisposed) return;
  rendererRef.current = loadRenderer(xterm);
  // Run the same recovery that tab-switching triggers (runReattachRecovery):
  // clear stale WebGL glyph cache, refit dimensions, and force a full repaint.
  // Without this, the terminal shows garbled/overlapping text on Windows because
  // the WebGL renderer has different metrics than the initial DOM renderer, and
  // alternate screen mode transitions (Claude Code, vim) don't render cleanly.
  rendererRef.current.clearTextureAtlas?.();
  fitAddon.fit();
  xterm.refresh(0, xterm.rows - 1);
});
```

---

## Patch 21: Skip native build of macos-process-metrics on non-Darwin

**Why:** `packages/macos-process-metrics` ships an `install` script of the form `node-gyp rebuild || echo 'Native build skipped'`. The intent is to fall back gracefully on non-macOS, but on Windows with VS Build Tools installed, `node-gyp` invokes MSBuild on the macOS-only `.vcxproj`. MSBuild then **hangs indefinitely** (rather than failing fast) trying to compile Objective-C/Cocoa source against Windows toolchains, blocking the entire `bun install`. The `||` fallback never fires because the parent process is stuck waiting on a child that never exits.

The fix short-circuits the script with a platform check before `node-gyp` is invoked.

**File: `packages/macos-process-metrics/package.json`**

Find the `"install"` script:
```json
"install": "node-gyp rebuild || echo 'Native build skipped (non-macOS or missing toolchain)'"
```

Replace with:
```json
"install": "node -e \"if(process.platform!=='darwin'){console.log('Skipping native build on '+process.platform);process.exit(0)}\" && node-gyp rebuild || echo 'Native build skipped (non-macOS or missing toolchain)'"
```

The leading `node -e` exits 0 on Windows/Linux before MSBuild is ever spawned. On macOS the script behavior is unchanged (the `node -e` is a no-op and `node-gyp rebuild` runs as before).

---

## Patch 22: Dereference symlinks when materializing native modules

**Why:** Bun's isolated install creates junctions (Windows) and symlinks (Unix) for every package, **including transitive ones**. When `copy-native-modules.ts` materializes `@superset/macos-process-metrics`, the package contains a nested `node_modules/node-addon-api` junction pointing back into the Bun store. The default `cpSync({ recursive: true })` tries to recreate that junction at the destination via `copyfile`, which on Windows raises `EPERM: operation not permitted` (creating a junction that points outside the destination tree requires elevated privileges or developer mode, and even then is fragile).

Setting `dereference: true` makes `cpSync` follow the link and copy the target's contents instead, which always succeeds and is what we actually want for an asar-packaged app: real files, no dangling links.

**File: `apps/desktop/scripts/copy-native-modules.ts`**

In `copyModuleIfSymlink` (around the line that calls `cpSync` after removing the symlink), change:
```typescript
// Copy the actual files
cpSync(realPath, modulePath, { recursive: true });
```

to:
```typescript
// Copy the actual files. dereference: true follows nested symlinks
// (e.g., node_modules/node-addon-api junctions on Windows) and copies
// their contents instead of the link itself, which avoids EPERM on
// copyfile when the destination cannot create the same junction.
cpSync(realPath, modulePath, { recursive: true, dereference: true });
```
---

## Patch 23: Force `windowsHide: true` for all child_process spawns on Windows

**Files:**
- `apps/desktop/src/main/lib/windows-child-process-patch.ts` (new)
- `apps/desktop/src/main/index.ts`

**Why:** Many third-party libraries — `pidusage` (uses `wmic`),
`@sentry/electron`'s `additional-context` integration (`powershell
Get-CimInstance Win32_ComputerSystem`), and ad-hoc `exec` calls in our
own code — invoke `child_process.{exec,spawn,execFile,…}` without
passing `windowsHide: true`. On Windows this flashes a `cmd.exe` /
console window for every console-subsystem child. Patching them
individually is whack-a-mole. We can't simply set `windowsHide: true`
globally via Node options; it's a per-call argument.

**Fix:** Monkey-patch `node:child_process` at the very start of the
main-process entry point so every spawn variant defaults to
`windowsHide: true` on Windows. Callers that explicitly pass
`windowsHide: false` are still respected.

The new `windows-child-process-patch.ts` exports
`installWindowsChildProcessPatch()`, which wraps the six spawn variants
(`spawn`, `exec`, `execFile`, `spawnSync`, `execSync`, `execFileSync`).
It also includes a tracer (enabled in dev or with
`SUPERSET_TRACE_SPAWN=1`) that logs every command spawned, so future
Windows-specific freezes can be attributed to a specific subprocess.

Wire it up in `apps/desktop/src/main/index.ts` immediately after the
import block — before any code path that may spawn (Sentry init,
terminal host, agent setup, auto-updater, etc.):

```ts
import { installWindowsChildProcessPatch } from "./lib/windows-child-process-patch";
installWindowsChildProcessPatch();
```

This is a defense-in-depth measure that, together with the targeted fixes above, should eliminate the
console-window flash on workspace tab switches and any other UI flow
that ends up spawning a Windows console-subsystem child.

**1.8.9 validation note:** these V1 freeze mitigations reduced
console-window flashes and fixed V1 terminal connectivity after Patch 8, but
V1 can still freeze when switching workspaces on Windows. The validated path
for 1.8.9 is V2 mode after applying the V2 fixes in Patches 24, 25,
26, and 27, plus the Windows launcher/preset fixes in Patches 13 and 15:
terminals work, presets auto-execute, PowerShell 7 is selected when available,
configured worktree roots are honored, "Open in VS Code" works, and workspace
switching no longer freezes.

---

## Patch 24: Use Windows named pipes for the V2 `pty-daemon`

**Files:**
- `packages/host-service/src/daemon/DaemonSupervisor.ts`
- `packages/pty-daemon/src/Server/Server.ts`

**Why:** V2 terminal mode does **not** use the desktop `terminal-host`
daemon from Patch 8. It uses `@superset/pty-daemon`, supervised by
`packages/host-service`. On Windows, the upstream supervisor still tries
to bind a Unix-style socket file in `%TEMP%`, for example:

```text
C:\Users\...\AppData\Local\Temp\superset-ptyd-4466e4457bc5.sock
```

This fails at runtime with:

```text
[pty-daemon] failed to start: Error: listen EACCES: permission denied ...\superset-ptyd-....sock
```

The fix is the same principle as Patch 8: use a named pipe on Windows and
skip Unix-only file cleanup/permission operations in the daemon.

**File: `packages/host-service/src/daemon/DaemonSupervisor.ts`**

1. Add a platform constant near the other module constants:

```ts
const IS_WINDOWS = process.platform === "win32";
```

2. Update `ptyDaemonSocketPath(organizationId)` so Windows returns a named
   pipe instead of a temp `.sock` path:

```ts
function ptyDaemonSocketPath(organizationId: string): string {
  const shortId = createHash("sha256")
    .update(organizationId)
    .digest("hex")
    .slice(0, 12);
  if (IS_WINDOWS) return `\\\\.\\pipe\\superset-ptyd-${shortId}`;
  return path.join(os.tmpdir(), `superset-ptyd-${shortId}.sock`);
}
```

3. In `waitForSocket`, do not gate connect attempts on
   `fs.existsSync(socketPath)` on Windows. Named pipes are not normal
   filesystem entries:

```ts
if (IS_WINDOWS || fs.existsSync(socketPath)) {
  if (await isSocketConnectable(socketPath, 200)) return true;
}
```

`net.createConnection({ path: socketPath })` works for both Unix sockets
and Windows named pipes, so `DaemonClient`, `probeDaemonVersion`, and
`isSocketConnectable` can keep using the same connect call.

**File: `packages/pty-daemon/src/Server/Server.ts`**

1. Add a platform constant near imports:

```ts
const IS_WINDOWS = process.platform === "win32";
```

2. In `listen()`, wrap directory creation, stale socket `unlinkSync`, and
   `chmodSync` with `if (!IS_WINDOWS)`. The Windows named pipe is created
   by `server.listen(pipeName)` and must not be treated as a file path.

3. In `close()`, only unlink `this.opts.socketPath` on non-Windows:

```ts
if (!IS_WINDOWS) {
  try {
    fs.unlinkSync(this.opts.socketPath);
  } catch {
    // ignore
  }
}
```

After this patch, V2 terminal settings should show the daemon as running
instead of "daemon unavailable".

---

## Patch 25: Disable Unix fd-handoff assumptions for V2 terminals on Windows

**Files:**
- `packages/pty-daemon/src/Pty/Pty.ts`
- `packages/pty-daemon/src/Server/Server.ts`
- `packages/host-service/src/daemon/DaemonSupervisor.ts`

**Why:** Once Patch 24 lets the V2 daemon start, opening a V2 terminal on
Windows can fail with:

```text
node-pty master fd unavailable (got number: -1). Phase 2 fd-handoff depends
on node-pty's private _fd property
```

On Unix, `node-pty` exposes a real PTY master file descriptor and the V2
daemon's hot-upgrade path can pass that fd to a successor process. On
Windows, `node-pty` is backed by ConPTY handles, not a Unix fd, so `_fd`
is `-1`. That does **not** mean normal terminal spawn is broken; it only
means the Unix fd-handoff upgrade feature is unavailable on Windows.

**File: `packages/pty-daemon/src/Pty/Pty.ts`**

1. Add a platform capability constant:

```ts
const SUPPORTS_FD_HANDOFF = process.platform !== "win32";
```

2. Keep `getMasterFd()` strict for platforms that support fd handoff, but
   do not validate it during normal Windows spawn. In `spawn()`, change:

```ts
const adapter = new NodePtyAdapter(term, meta);
adapter.getMasterFd();
return adapter;
```

to:

```ts
const adapter = new NodePtyAdapter(term, meta);
if (SUPPORTS_FD_HANDOFF) adapter.getMasterFd();
return adapter;
```

This allows normal V2 terminal sessions and presets (Claude/Codex) to open
on Windows while preserving the early assertion on Unix.

**File: `packages/pty-daemon/src/Server/Server.ts`**

In `prepareUpgrade()`, return an explicit unsupported result on Windows
before enumerating live sessions and calling `getMasterFd()`:

```ts
if (IS_WINDOWS) {
  return {
    ok: false,
    reason:
      "fd-handoff daemon upgrade is not supported on Windows; use restart instead",
  };
}
```

**File: `packages/host-service/src/daemon/DaemonSupervisor.ts`**

Add the same Windows guard to `runUpdate()` so the UI's daemon update path
does not attempt fd-handoff on Windows:

```ts
if (IS_WINDOWS) {
  return {
    ok: false,
    reason:
      "fd-handoff daemon update is not supported on Windows; use restart instead",
  };
}
```

The intended Windows behavior is: daemon restart works, normal terminals
work, and hot daemon binary handoff is disabled until a Windows ConPTY
handle-transfer implementation exists.

---

## Patch 26: Prefer PowerShell 7 for V2 terminals on Windows

**Why:** V2 terminals defaulted to `COMSPEC`, which normally points at
`cmd.exe`. Users could only force PowerShell by launching the app through a
shortcut that rewrote `ComSpec`. Resolve the terminal shell directly instead:
prefer an explicit `SUPERSET_TERMINAL_SHELL`, then `pwsh.exe`, then Windows
PowerShell, and only fall back to `COMSPEC`/`cmd.exe` if PowerShell is not
available.

**File: `packages/host-service/src/terminal/shell-launch.ts`**

1. Keep the existing POSIX behavior unchanged.

2. Add Windows shell resolution helpers near the top of the file:
   - Read `SUPERSET_TERMINAL_SHELL` as an override.
   - Read Windows environment keys case-insensitively (`PATH` vs `Path`,
     `SystemRoot` vs `SYSTEMROOT`, etc.) because GUI-launched Electron/Node
     snapshots can differ from an interactive shell.
   - Search known real PowerShell install paths before `PATH` aliases,
     including `%ProgramFiles%\PowerShell\7\pwsh.exe`,
     `%ProgramFiles%\PowerShell\7-preview\pwsh.exe`, packaged Store installs
     under `%ProgramFiles%\WindowsApps\Microsoft.PowerShell_*__8wekyb3d8bbwe\pwsh.exe`,
     and
     `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`.
   - If direct `%ProgramFiles%\WindowsApps` enumeration fails with `EPERM`,
     resolve Store PowerShell with:
     ```powershell
     Get-AppxPackage Microsoft.PowerShell |
       Sort-Object Version -Descending |
       ForEach-Object { Join-Path $_.InstallLocation 'pwsh.exe' }
     ```
   - Search `PATH`/`Path` using Windows `PATHEXT`-style extensions.
   - Treat `%LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe` as a last-resort
     app execution alias, not the preferred executable. Windows Terminal's
     PowerShell Core profile resolves to the real packaged `pwsh.exe`, not
     this alias.

3. Change `resolveLaunchShell()` so the Windows branch returns the resolved
   PowerShell path instead of `baseEnv.COMSPEC || "cmd.exe"`.

The intended Windows behavior is that a normal new V2 terminal opens in
PowerShell 7 (`pwsh`) when available. If someone wants a different shell, they
can set `SUPERSET_TERMINAL_SHELL` before launching the app.

---

## Patch 27: Honor configured worktree base dir in V2 host-service

**Why:** V2 workspace creation runs in `packages/host-service`, not the older
desktop workspaces router. The desktop router honored the global/project
worktree setting, but the V2 host-service path resolver hard-coded
`~/.superset/worktrees`, so new V2 worktrees ignored the configured Windows
location such as `D:\superset-wt`.

**Files:**
- `apps/desktop/src/main/lib/host-service-coordinator.ts`
- `apps/desktop/src/lib/trpc/routers/settings/index.ts`
- `packages/host-service/src/trpc/router/workspace-creation/shared/worktree-paths.ts`

1. In `host-service-coordinator.ts`, read `settings.worktreeBaseDir` from
   `localDb` in `buildEnv()` and pass it to the child host-service as
   `SUPERSET_WORKTREE_BASE_DIR` when set.

2. In `worktree-paths.ts`, have `supersetWorktreesRoot()` prefer
   `process.env.SUPERSET_WORKTREE_BASE_DIR?.trim()` before falling back to
   `join(homedir(), ".superset", "worktrees")`.

3. In `settings/index.ts`, update `setWorktreeBaseDir` to restart active
   host-service children after saving, the same way the relay setting restart
   works. Otherwise a running V2 host-service keeps the old environment until
   app restart.

The intended Windows behavior is that setting the worktree folder to
`D:\superset-wt` makes new V2 worktrees land under that base instead of
`C:\Users\<user>\.superset\worktrees`.

---

## Patch 28: Copy repo-local `.superset` into V2 worktrees like V1

**Why:** V1 explicitly copied `<main repo>\.superset` into new/imported
worktrees when the worktree did not already have its own `.superset` directory.
That matters because many projects keep `.superset` locally ignored, so `git
worktree add` does not materialize setup/run/ports files. V2 reads setup config
from the main repo for workspace setup, but other features and user scripts can
still expect `./.superset/...` inside the worktree. Match V1 parity without
overwriting worktree-specific config.

**Files:**
- `packages/host-service/src/trpc/router/workspace-creation/shared/project-superset-config.ts`
- `packages/host-service/src/trpc/router/workspaces/workspaces.ts`

1. Add a small helper that mirrors V1's `copySupersetConfigToWorktree()`:
   ```typescript
   import { cpSync, existsSync } from "node:fs";
   import { join } from "node:path";

   const PROJECT_SUPERSET_DIR_NAME = ".superset";

   export function copyProjectSupersetConfigToWorktree(
     repoPath: string,
     worktreePath: string,
   ): void {
     const source = join(repoPath, PROJECT_SUPERSET_DIR_NAME);
     const target = join(worktreePath, PROJECT_SUPERSET_DIR_NAME);

     if (!existsSync(source) || existsSync(target)) return;

     try {
       cpSync(source, target, { recursive: true });
     } catch (error) {
       console.warn(
         `Failed to copy ${PROJECT_SUPERSET_DIR_NAME} to worktree: ${error instanceof Error ? error.message : String(error)}`,
       );
     }
   }
   ```

2. In `workspaces.ts`, place the helper call **inside the `if (!alreadyExists) { ... }` block** that wraps the `startSetupTerminalIfPresent` call, immediately before that call. Two important details:
   - **Scope-correctness:** `worktreePath` is declared as `let worktreePath: string;` (uninitialized) and only conditionally assigned by the worktree-creation branches. Placing the call OUTSIDE `if (!alreadyExists)` triggers a `TS2454: 'worktreePath' is used before being assigned` typecheck error. TypeScript's flow analysis also can't prove the cross-variable invariant ("alreadyExists === false ⇒ worktreePath assigned") because the two flags are set in different branches — so **also change the declaration to `let worktreePath = "";`** (initialize to empty string). All downstream creation paths still overwrite it; the empty-string fallback only ever survives when `alreadyExists` is true, in which case the new call never reads it.
   - **Semantics-correctness:** the copy should only run on first-create, not on workspace re-adoption — adopted/existing worktrees already have whatever `.superset` state they have, and re-copying could overwrite worktree-specific config. Gating on `!alreadyExists` is correct on both counts.

   Example placement:
   ```typescript
   const terminalsResult: Array<{ terminalId: string; label?: string }> = [];

   if (!alreadyExists) {
     // V1 parity: copy main-repo `.superset` into worktree if it doesn't have one.
     copyProjectSupersetConfigToWorktree(localProject.repoPath, worktreePath);

     const { terminal, warning } = await startSetupTerminalIfPresent({
       // ...
     });
     // ...
   }
   ```

   Also import the helper at the top: `import { copyProjectSupersetConfigToWorktree } from "../workspace-creation/shared/project-superset-config";` (or the correct relative path from the file).

This is intentionally **not** a hard override: if the worktree already has a
`.superset` directory, V2 leaves it alone, matching V1 behavior.

Scope note: this patch only restores V1's explicit `.superset` copy behavior.
V2 still creates worktrees through `git worktree add`, so other locally ignored
files are not copied unless they are tracked by git or handled by a separate
setup step.

---

## Patch 29: Preserve `&&` in V2 agent launch commands

**Why:** The V2 agent settings UI labels the command field as "Argv used to
launch the agent", but users may reasonably enter a short shell chain such as
`clear && claude`. The parser previously dropped shell operator tokens, so after
refresh the command became `clear claude`. Preserve `&&` through parsing,
display, persistence, and final terminal command generation.

**Files:**
- `apps/desktop/src/renderer/lib/argv.ts`
- `apps/desktop/src/renderer/lib/argv.test.ts`
- `packages/host-service/src/trpc/router/agents/agents.ts`
- `packages/host-service/src/trpc/router/agents/agents.test.ts`

1. In `argv.ts`, preserve shell-quote parse tokens whose operator is `&&` when
   parsing the command field, and render stored `&&` tokens without escaping
   them when joining command args for display.

2. In `agents.ts`, update the agent command builder so argv tokens equal to
   `&&` are emitted as shell control operators instead of being single-quoted.
   This makes a stored command/args shape like `command: "clear", args:
   ["&&", "claude"]` launch as `clear && claude`.

3. Add focused tests for UI round-tripping (`clear && claude` stays unchanged)
   and command generation (`'clear' && 'claude' 'prompt'`).

Run:
```powershell
bun test apps\desktop\src\renderer\lib\argv.test.ts packages\host-service\src\trpc\router\agents\agents.test.ts
```

---

## Patch 30: (RETIRED) Worktree-delete cleanup — superseded by deterministic fixup (AH)

The original Patch 30 (best-effort leftover-folder removal via `rmSync` /
PowerShell `Remove-Item`) is **retired**. Workspace-delete on Windows is now
fixed deterministically by `patches/workspace-delete-decouple.patch`, applied as
git-apply step **(AH)** in `.github/workflows/nightly-build.yml`. It converts the
two worktree-step throws in `runDestroy()` into warnings (+ `git worktree
prune`) so the workspace record deletes on the FIRST attempt even when the
worktree folder is locked by another process; the locked folder is left on disk
and surfaced as a warning. (The user chose decouple-only over the old
force-removal behavior.)

**Do NOT modify
`packages/host-service/src/trpc/router/workspace-cleanup/workspace-cleanup.ts`
here** — the deterministic (AH) patch owns that file and a competing AI edit
would collide with it.

---

## Patch 31: Restore Windows ringtone preview playback from Settings

**Why:** Notification sounds could play during normal app use, but the Settings
page ringtone preview UI could show the sample as "playing" with no audible
sound on Windows. The shared main-process sound helper only implemented macOS
(`afplay`) and Linux (`paplay`/`aplay`) playback. The Settings preview path uses
the main-process ringtone router, so on Windows the request succeeded logically
but there was no Windows playback backend behind it.

**File: `apps/desktop/src/main/lib/play-sound.ts`**

1. Keep the existing macOS and Linux behavior, but add `windowsHide: true` to
   the existing `execFile(...)` calls so sound helpers do not flash a console
   window.

2. Add a Windows-specific `process.platform === "win32"` branch before the Linux
   path that launches `powershell.exe` with:
   - `-NoProfile`
   - `-NonInteractive`
   - `-ExecutionPolicy Bypass`
   - `-STA`
   - an inline script that loads `PresentationCore`, constructs a
     `System.Windows.Media.MediaPlayer`, opens the requested sound path as a
     `System.Uri`, waits briefly for `NaturalDuration`, sets `Volume`, plays the
     file, sleeps for the sound duration (or a short fallback timeout), then
     stops/closes the player.

3. Keep returning the spawned child process from `playSoundFile(...)` so the
   existing ringtone preview stop/race-tracking logic continues to work. The
   Windows preview path relies on being able to kill the child process when the
   user clicks Stop or starts another preview.

**Expected result:** the Settings > Notifications ringtone preview should produce
audible sound on Windows, and the existing stop/replace-preview behavior should
keep working.

---

## Patch 32: Derive branch slug from the typed workspace name when no prompt is provided

**Why:** V2 name/branch creation has two different fallback paths:
1. if the user provides a prompt (or an agent prompt exists), the host-service
   can generate AI name/branch suggestions;
2. if the branch is omitted entirely, the host-service falls back to a friendly
   random branch name.

That left a bad UX gap on Windows: if the user typed only the workspace/session
name, left agent unselected, left the prompt blank, and left branch blank, the
renderer submitted `branch: undefined`. The host-service then had no prompt to
derive from, so it generated a random friendly branch (`goofy-wax`, etc.) even
though the user had already supplied a meaningful workspace name.

**Files:**
- `apps/desktop/src/renderer/routes/_authenticated/components/DashboardNewWorkspaceModal/components/DashboardNewWorkspaceForm/PromptGroup/hooks/useSubmitWorkspace/resolveNames.ts`
- `apps/desktop/src/renderer/routes/_authenticated/components/DashboardNewWorkspaceModal/components/DashboardNewWorkspaceForm/PromptGroup/hooks/useSubmitWorkspace/resolveNames.test.ts` (new)

1. In `resolveNames.ts`, add `deriveWorkspaceBranchFromPrompt` to the
   `@superset/shared/workspace-launch` import.

2. Change the `branchName` resolution logic from:
   - explicit user branch when `branchNameEdited`,
   - otherwise `null`

   to:
   - explicit user branch when `branchNameEdited`,
   - otherwise, if `workspaceNameEdited` and non-empty, derive a branch slug from
     the typed workspace name with `deriveWorkspaceBranchFromPrompt(...)`,
   - otherwise `null`.

3. Keep the explicit user branch name path first so a typed branch still wins
   over any derived value.

4. Add a test file covering:
   - deriving `fix-auth-flow` from a typed workspace name like `Fix auth flow`
     when the branch field was left blank,
   - preserving an explicitly typed branch name unchanged when both fields are
     present.

**Expected result:** if the user types only the workspace/session name, V2 uses
that text to seed the branch slug instead of falling back to a random
friendly-words branch name.

---

## Patch 33: Never auto-fallback to Windows PowerShell for V2 terminals

**Why:** Patch 26 fixed the main `cmd.exe` issue by preferring `pwsh`, but it
still allowed an automatic fallback to legacy Windows PowerShell
(`powershell.exe`). That keeps an intermittent wrong-shell path alive: if `pwsh`
resolution fails because of environment differences, Store alias quirks, or a
timing-dependent lookup path, some terminals can still open in the old shell.
For the default Windows experience, legacy PowerShell should be **opt-in only**,
not an automatic fallback.

**File: `packages/host-service/src/terminal/shell-launch.ts`**

1. Keep the existing POSIX behavior unchanged.

2. Tighten the Windows resolver policy:
   - keep honoring an explicit `SUPERSET_TERMINAL_SHELL` override first,
   - otherwise resolve **only** `pwsh` / PowerShell 7 candidates,
   - if no valid `pwsh` is found, fall back to `COMSPEC` / `cmd.exe`,
   - do **not** auto-select `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`.

3. Keep the existing real-path `pwsh` search from Patch 30, but add a final
   validation step before accepting a candidate:
   - the executable basename should be `pwsh` / `pwsh.exe`, and
   - a lightweight version probe such as
     `-NoLogo -NoProfile -Command "$PSVersionTable.PSVersion.Major"` must return
     `7` or higher.

   Reject candidates that fail the probe, point at a legacy shim, or resolve to
   `powershell.exe`.

4. Cache the resolved Windows shell path once per app session after the first
   successful lookup. Reuse that exact path for later terminal launches instead
   of re-running the full search each time. That removes per-terminal
   nondeterminism from environment snapshots and Store alias resolution.

5. If a user truly wants Windows PowerShell, keep allowing it only through an
   explicit override (`SUPERSET_TERMINAL_SHELL=powershell.exe` or full path).

**Expected result:** a normal new V2 terminal on Windows should open in
PowerShell 7 (`pwsh`) every time it is available. Legacy Windows PowerShell
should never appear unless the user explicitly asks for it.

---

## Verification Checklist

After applying all patches, verify:
- [ ] `bun install` completes on Windows without hanging on `macos-process-metrics` (bufferutil warning is expected and non-fatal)
- [ ] `bun run compile:app` builds with 0 TypeScript errors
- [ ] `bun run copy:native-modules` completes without EPERM on `@superset/macos-process-metrics`
- [ ] `electron dist/main/index.js` launches without TDZ or path errors
- [ ] App launches to a **visible window**. If the renderer's load events never fire, the show-watchdog forces the window visible within ~12 s and writes `[main-window] show-watchdog fired` to `main.log` (was: processes alive in Task Manager but no window on Windows)
- [ ] Terminal opens without "Connection lost" or "PTY not spawned" errors
- [ ] V2 terminal settings show `pty-daemon` running, not "daemon unavailable"
- [ ] V2 terminal opens without `node-pty master fd unavailable`
- [ ] New V2 terminal opens in `pwsh`/PowerShell 7 on Windows, never legacy `powershell.exe` unless explicitly overridden
- [ ] New V2 worktrees honor the configured worktree base directory
- [ ] New V2 worktrees include repo-local `.superset` files when the worktree is missing `.superset`
- [ ] V2 Claude/Codex preset can start a terminal session
- [ ] In V2 mode, switching workspace tabs is instant (no UI freeze, no `cmd.exe` window flash)
- [ ] Agent launch (click Claude/Codex) auto-executes the command (no manual Enter needed)
- [ ] Changes panel loads (no "Unable to load changes")
- [ ] "Open in VS Code" works
- [ ] Notification sounds and ringtone preview play correctly on Windows
- [ ] Deleting a V2 workspace removes the on-disk worktree folder, or surfaces a clear lock/permission warning when another process still has it open
- [ ] Creating a V2 workspace with only a typed workspace name derives the branch from that name instead of using a random friendly branch
- [ ] Ctrl+Shift+1/2/3 switches workspaces on Windows (⌘+1/2/3 on macOS)
- [ ] Sidebar tooltip shows "Ctrl+Shift+1" on Windows instead of "⌘1"
- [ ] Ctrl+C copies selected text in terminal, sends interrupt when nothing selected (Windows)
- [ ] Ctrl+V pastes from clipboard in terminal (Windows)
- [ ] Quit confirmation dialog appears BEFORE window closes on Windows
- [ ] New terminal renders cleanly without garbled/overlapping text on Windows
- [ ] Green "review" status dot appears on the workspace icon when Claude finishes a turn in a Superset terminal (was: never appeared on Windows — bash hook chain broken; see `patches/agent-jsonl-watcher.patch`)
- [ ] Same as above also works for Codex sessions (Codex `task_complete` → green; uses `~/.codex/sessions/**/*.jsonl`)
- [ ] Red "permission" dot appears when Claude requests permission outside bypassPermissions mode, OR when Codex emits exec_approval_request / apply_patch_approval_request / request_user_input
- [ ] After opening a Claude session in a Superset terminal, `~/.superset/session-pane-map/<sessionId>.json` gets written by the pane-map hook
- [ ] Sidebar workspace rows show one small coloured dot per active terminal pane, inline with the workspace name (see `patches/per-terminal-dots.patch`)
- [ ] NSIS installer builds successfully
- [ ] V1 note: terminal connectivity should work, but workspace switching may still freeze on Windows; prefer V2
