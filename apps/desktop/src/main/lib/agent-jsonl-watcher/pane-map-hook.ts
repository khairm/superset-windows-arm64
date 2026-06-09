import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Companion to `agent-jsonl-watcher.ts`: installs a tiny portable
 * Python (`uv run python`) SessionStart hook that records the Superset
 * pane/tab/workspace identity alongside each Claude/Codex session id.
 *
 * The watcher reads these mapping files at
 * `~/.superset/session-pane-map/<sessionId>.json` so it can emit
 * `AgentLifecycleEvent`s with a precise paneId — resolving the
 * "multiple terminals in the same cwd" ambiguity that cwd-only
 * resolution can't disambiguate.
 *
 * Why install here (not via agent-setup) — upstream's `agent-wrappers`
 * already manages a bash hook that's broken on Windows; rather than
 * patch the wrapper-registration code, we add an additional managed
 * entry directly. Coexistence is safe: upstream identifies its own
 * entries by `notify.sh` path; we identify ours by the script
 * filename below. The two won't conflict.
 */

const SCRIPT_FILENAME = "superset-pane-map.py";
const SCRIPT_DIR = path.join(os.homedir(), ".superset", "hooks");
const SCRIPT_PATH = path.join(SCRIPT_DIR, SCRIPT_FILENAME);
const CLAUDE_SETTINGS_PATH = path.join(
	os.homedir(),
	".claude",
	"settings.json",
);
const CODEX_HOOKS_PATH = path.join(os.homedir(), ".codex", "hooks.json");

// Legacy AskUserQuestion deterministic-red hook. RETIRED: superset-notify.py
// now owns the AskUserQuestion red (PreToolUse:AskUserQuestion). Only the
// filename constant survives so mergeNotifyHook can self-heal away any stale
// ask-marker hook a prior build registered; the script body, its writer, its
// command builder, and its merge function were all deleted.
// Still referenced by isAskMarkerHook below, which mergeNotifyHook uses to
// self-heal (drop) any stale ask-marker hook left by a prior build — the
// notify hook now owns the AskUserQuestion red. The ask-marker SCRIPT itself
// is no longer written or registered.
const ASK_MARKER_SCRIPT_FILENAME = "superset-ask-marker.py";

// Claude agent-status hook. A third Python hook POSTs each Claude lifecycle
// event to the host-service so the dots are driven event-driven (no JSONL
// timing heuristics) — reviving what the dead bash `~/.superset/hooks/notify.sh`
// did. Registered (Claude settings.json only) on UserPromptSubmit / Stop /
// SessionEnd / Notification(permission_prompt) and on PreToolUse scoped to
// AskUserQuestion plus an unscoped PostToolUse (any tool completion re-asserts
// working, clearing red after a permission approval or an answered question).
// The server maps Start→working, Stop→review, PermissionRequest→permission.
// This hook now OWNS Claude working/review/permission (including the
// AskUserQuestion red, so the separate ask-marker hook is no longer registered
// for Claude). Python + `uv run` so it runs on Windows exactly like the
// pane-map hook.
const NOTIFY_SCRIPT_FILENAME = "superset-notify.py";
const NOTIFY_SCRIPT_PATH = path.join(SCRIPT_DIR, NOTIFY_SCRIPT_FILENAME);

/**
 * The Python script. Reads Superset terminal-identity env vars set by
 * the terminal launcher and writes
 * `~/.superset/session-pane-map/<sessionId>.json`. Both v1 and v2
 * terminal stacks are handled — v1 sets SUPERSET_PANE_ID/TAB_ID/
 * WORKSPACE_ID (apps/desktop/src/main/lib/terminal/env.ts), v2 sets
 * SUPERSET_TERMINAL_ID/WORKSPACE_ID (packages/host-service/src/
 * terminal/env.ts). The renderer's V2NotificationController bridge
 * requires `terminalId` (not paneId), so v2 sessions must carry that
 * field through to the AGENT_LIFECYCLE event. The hook payload comes
 * from stdin (Claude / Mastra / Droid) OR argv[1] (Codex). Silent on
 * every failure path — a broken hook must not abort the agent.
 */
const PANE_MAP_SCRIPT = `#!/usr/bin/env python3
"""Superset pane-map SessionStart hook (v1).

Installed by agent-jsonl-watcher/pane-map-hook.ts. Writes a
{paneId, tabId, workspaceId} record keyed by the agent session id
so the watcher can resolve per-pane identity beyond cwd matching.

Logging: every invocation appends one JSON line to
~/.superset/pane-map-hook.log (gate with SUPERSET_AGENT_WATCHER_DEBUG=0).
The logger can never raise — a broken hook must not abort the agent.
"""
import datetime
import json
import os
import pathlib
import sys


def _log(record: dict) -> None:
    # Append one JSON line to ~/.superset/pane-map-hook.log. Fully
    # self-contained and never raises: any failure (disk, perms,
    # serialization) is swallowed so the hook can never break the agent.
    if os.environ.get("SUPERSET_AGENT_WATCHER_DEBUG") == "0":
        return
    try:
        record["ts"] = datetime.datetime.now().isoformat()
        record["phase"] = "hook"
        log_dir = pathlib.Path.home() / ".superset"
        log_dir.mkdir(parents=True, exist_ok=True)
        log_path = log_dir / "pane-map-hook.log"
        with open(log_path, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(record) + "\\n")
    except Exception:
        pass


def _read_payload():
    # Codex passes the hook payload as argv[1]; Claude/Mastra/Droid
    # pipe via stdin. Try both. Returns (payload_or_None, source,
    # skip_reason). source is "argv[1]" | "stdin" | "none". skip_reason
    # distinguishes invalid-payload-json vs payload-not-object for the
    # diagnostic log; main() decides whether to abort.
    stdin_bytes = 0
    candidates = []
    if len(sys.argv) > 1:
        candidates.append(("argv[1]", sys.argv[1]))
    try:
        raw = sys.stdin.read()
        if raw:
            stdin_bytes = len(raw.encode("utf-8", "replace"))
            candidates.append(("stdin", raw))
    except (OSError, ValueError):
        pass
    if not candidates:
        return None, "none", "none", stdin_bytes
    saw_parse_error = False
    for source, src in candidates:
        try:
            parsed = json.loads(src)
        except (ValueError, TypeError):
            saw_parse_error = True
            continue
        if isinstance(parsed, dict):
            return parsed, source, None, stdin_bytes
        return None, source, "payload-not-object", stdin_bytes
    return None, candidates[0][0], "invalid-payload-json" if saw_parse_error else "none", stdin_bytes


def main() -> None:
    pid = os.getpid()
    argv_count = len(sys.argv)
    superset_env = {
        "SUPERSET_PANE_ID": os.environ.get("SUPERSET_PANE_ID", ""),
        "SUPERSET_TAB_ID": os.environ.get("SUPERSET_TAB_ID", ""),
        "SUPERSET_TERMINAL_ID": os.environ.get("SUPERSET_TERMINAL_ID", ""),
        "SUPERSET_WORKSPACE_ID": os.environ.get("SUPERSET_WORKSPACE_ID", ""),
    }

    # Read both v1 and v2 terminal-identity env vars. At least one of
    # pane_id (v1) or terminal_id (v2) must be present to indicate this
    # is a Superset-launched terminal.
    pane_id = os.environ.get("SUPERSET_PANE_ID", "").strip()
    tab_id = os.environ.get("SUPERSET_TAB_ID", "").strip()
    terminal_id = os.environ.get("SUPERSET_TERMINAL_ID", "").strip()
    workspace_id = os.environ.get("SUPERSET_WORKSPACE_ID", "").strip()
    if not pane_id and not terminal_id:
        _log({
            "pid": pid,
            "argvCount": argv_count,
            "stdinBytes": 0,
            "payloadSource": "none",
            "payloadKeys": [],
            "rawSessionIdFields": {},
            "sessionId": None,
            "supersetEnv": superset_env,
            "mapping": None,
            "action": "skip",
            "skipReason": "missing-terminal-env",
            "outPath": None,
            "error": None,
        })
        return  # not inside a Superset-launched terminal

    payload, payload_source, payload_skip, stdin_bytes = _read_payload()
    payload_dict = payload if isinstance(payload, dict) else {}
    payload_keys = sorted(payload_dict.keys())
    raw_session_id_fields = {
        "session_id": payload_dict.get("session_id"),
        "sessionId": payload_dict.get("sessionId"),
        "resourceId": payload_dict.get("resourceId"),
        "resource_id": payload_dict.get("resource_id"),
    }
    if payload_skip in ("invalid-payload-json", "payload-not-object"):
        _log({
            "pid": pid,
            "argvCount": argv_count,
            "stdinBytes": stdin_bytes,
            "payloadSource": payload_source,
            "payloadKeys": payload_keys,
            "rawSessionIdFields": raw_session_id_fields,
            "sessionId": None,
            "supersetEnv": superset_env,
            "mapping": None,
            "action": "skip",
            "skipReason": payload_skip,
            "outPath": None,
            "error": None,
        })
        return

    session_id = (
        payload_dict.get("session_id")
        or payload_dict.get("sessionId")
        or payload_dict.get("resourceId")
        or payload_dict.get("resource_id")
    )
    if not session_id or not isinstance(session_id, str):
        _log({
            "pid": pid,
            "argvCount": argv_count,
            "stdinBytes": stdin_bytes,
            "payloadSource": payload_source,
            "payloadKeys": payload_keys,
            "rawSessionIdFields": raw_session_id_fields,
            "sessionId": session_id if isinstance(session_id, str) else None,
            "supersetEnv": superset_env,
            "mapping": None,
            "action": "skip",
            "skipReason": "missing-session-id",
            "outPath": None,
            "error": None,
        })
        return

    # Only emit fields that have values — keeps the mapping file
    # minimal and lets the watcher's spread skip undefined fields.
    mapping: dict = {}
    if pane_id:
        mapping["paneId"] = pane_id
    if tab_id:
        mapping["tabId"] = tab_id
    if terminal_id:
        mapping["terminalId"] = terminal_id
    if workspace_id:
        mapping["workspaceId"] = workspace_id

    out_dir = pathlib.Path.home() / ".superset" / "session-pane-map"
    try:
        out_dir.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        _log({
            "pid": pid,
            "argvCount": argv_count,
            "stdinBytes": stdin_bytes,
            "payloadSource": payload_source,
            "payloadKeys": payload_keys,
            "rawSessionIdFields": raw_session_id_fields,
            "sessionId": session_id,
            "supersetEnv": superset_env,
            "mapping": mapping,
            "action": "skip",
            "skipReason": "mkdir-failed",
            "outPath": None,
            "error": str(exc),
        })
        return
    out_path = out_dir / f"{session_id}.json"
    try:
        out_path.write_text(
            json.dumps(mapping),
            encoding="utf-8",
        )
    except OSError as exc:
        _log({
            "pid": pid,
            "argvCount": argv_count,
            "stdinBytes": stdin_bytes,
            "payloadSource": payload_source,
            "payloadKeys": payload_keys,
            "rawSessionIdFields": raw_session_id_fields,
            "sessionId": session_id,
            "supersetEnv": superset_env,
            "mapping": mapping,
            "action": "skip",
            "skipReason": "write-failed",
            "outPath": str(out_path),
            "error": str(exc),
        })
        return

    _log({
        "pid": pid,
        "argvCount": argv_count,
        "stdinBytes": stdin_bytes,
        "payloadSource": payload_source,
        "payloadKeys": payload_keys,
        "rawSessionIdFields": raw_session_id_fields,
        "sessionId": session_id,
        "supersetEnv": superset_env,
        "mapping": mapping,
        "action": "write",
        "skipReason": None,
        "outPath": str(out_path),
        "error": None,
    })


if __name__ == "__main__":
    main()
`;

const NOTIFY_SCRIPT = `#!/usr/bin/env python3
"""Superset Claude agent-status notify hook.

Installed by agent-jsonl-watcher/pane-map-hook.ts. POSTs each Claude lifecycle
event to the host-service (SUPERSET_HOST_AGENT_HOOK_URL) so the agent-status
dots are driven event-driven — reviving what the dead bash notify.sh did.

Event -> eventType mapping (NEVER defaults to Stop on an unknown event; an
unmapped event is a silent no-op, exactly like notify.sh):
  UserPromptSubmit            -> Start            (working / yellow)
  Stop                        -> Stop             (review/green) UNLESS a
                                 subagent is still running (then suppressed —
                                 stay yellow; greens on the last SubagentStop)
  SessionEnd|StopFailure      -> Stop             (review  / green; clears state)
  Notification                -> PermissionRequest (permission / red)
  PreToolUse(AskUserQuestion) -> PermissionRequest (red)   else no-op
  PostToolUse(any tool)       -> Start             (working — clears red after
                                 a permission approval or an answered question)
  SubagentStart               -> Start            (working — a delegated subagent
                                 began; holds yellow through the main Stop)
  SubagentStop                -> Stop iff it was the LAST subagent AND main had
                                 already stopped, else no-op (see _decide_event_type)

Server maps Start->working, Stop->review, PermissionRequest->permission and
returns {"result":{"data":{"json":{"success":true,...}}}}. Uses only stdlib
urllib so it has no third-party dependency. Silent on every failure path — a
broken hook must NEVER raise or abort the agent.
"""
import datetime
import json
import os
import pathlib
import sys
import urllib.request


def _log(record):
    # Append one JSON line to ~/.superset/agent-notify-hook.log. Never raises.
    if os.environ.get("SUPERSET_AGENT_WATCHER_DEBUG") == "0":
        return
    try:
        record["ts"] = datetime.datetime.now().isoformat()
        log_dir = pathlib.Path.home() / ".superset"
        log_dir.mkdir(parents=True, exist_ok=True)
        with open(log_dir / "agent-notify-hook.log", "a", encoding="utf-8") as h:
            h.write(json.dumps(record) + "\\n")
    except Exception:
        pass


def _read_payload():
    candidates = []
    try:
        raw = sys.stdin.read()
        if raw:
            candidates.append(raw)
    except (OSError, ValueError):
        pass
    if len(sys.argv) > 1:
        candidates.append(sys.argv[1])
    for src in candidates:
        try:
            parsed = json.loads(src)
        except (ValueError, TypeError):
            continue
        if isinstance(parsed, dict):
            return parsed
    return {}


def _subagent_dir(terminal_id):
    return pathlib.Path.home() / ".superset" / "agent-subagent-running" / terminal_id


def _sentinel_path(terminal_id):
    return (
        pathlib.Path.home()
        / ".superset"
        / "agent-subagent-running"
        / (terminal_id + ".mainstopped")
    )


def _touch(p):
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.touch()
    except Exception:
        pass


def _remove(p):
    try:
        p.unlink()
    except Exception:
        pass


def _running_count(d):
    try:
        return sum(1 for _ in d.iterdir())
    except Exception:
        return 0


def _clear_dir(d):
    try:
        for f in d.iterdir():
            _remove(f)
    except Exception:
        pass


def _decide_event_type(event, tool, terminal_id, sub_agent_id, has_background):
    # Returns the host-service eventType or None (None => silent no-op).
    #
    # (BA) CLOUD/BACKGROUND-SESSION blue dot: when the main turn ends (Stop) or
    # the last local subagent finishes (SubagentStop) but a cloud/background
    # session is still running (has_background, from the Stop payload's
    # background_tasks[]), emit "BackgroundRunning" instead of "Stop". The
    # renderer treats it like a normal turn-end on the AGENT axis (review green,
    # or idle if the tab is focused) AND sets a SEPARATE blue axis; since agent
    # status outranks blue (red > yellow > green > blue), the blue shows once the
    # review green clears to idle — a running shell never masks a fresh review.
    # Cleared to green when background_tasks is empty (next Stop). Local subagents
    # (run_dir markers) keep taking precedence -> YELLOW; cloud sessions that fire
    # no SubagentStart fall through to this blue. Detection does not care whether
    # YOU or the agent launched the work. Safe direction: blue lingers, never a
    # false green.
    #
    # Background-subagent YELLOW-HOLD state machine (no timers, no polling):
    # while any subagent is running for this terminal the main agent's Stop is
    # SUPPRESSED so the dot stays working/yellow, and the terminal greens only
    # once the main agent has stopped AND the last subagent has finished. One
    # marker file per subagent (keyed by the SubagentStart/SubagentStop
    # agent_id pair key, so parallel subagents are counted) lives under
    # ~/.superset/agent-subagent-running/<terminalId>/, plus a
    # <terminalId>.mainstopped sentinel recording "main stopped while subagents
    # were still running". Foreground subagents finish inside the turn (dir
    # empties before Stop) so they green normally; background subagents outlive
    # the turn (Stop fires first) and hold yellow until their SubagentStop.
    # Failure mode is the SAFE direction: a leaked marker keeps it yellow (never
    # a false green) and SessionEnd clears everything. Marker ops never raise.
    run_dir = _subagent_dir(terminal_id)
    sentinel = _sentinel_path(terminal_id)

    if event == "SubagentStart":
        if sub_agent_id:
            _touch(run_dir / sub_agent_id)
        return "Start"
    if event == "SubagentStop":
        if sub_agent_id:
            _remove(run_dir / sub_agent_id)
        if _running_count(run_dir) == 0 and sentinel.exists():
            _remove(sentinel)
            # has_background here is read from THIS SubagentStop payload, which
            # carries background_tasks[] scoped to the PARENT session (Claude Code
            # docs >= 2.1.145) — i.e. what is still running now that this subagent
            # is done. So a remaining cloud session -> blue, nothing left -> green;
            # both accurate. (Absent field on an older/odd version -> green, which
            # only mis-greens in the narrow case where Stop carried the field but
            # SubagentStop did not — same version added both, so not in practice.)
            if has_background:
                return "BackgroundRunning"  # local subagents done; cloud/bg still running -> blue
            return "Stop"  # main already stopped + last subagent done -> green
        return None  # other subagents running, or main still working
    if event == "UserPromptSubmit":
        _remove(sentinel)  # main working again; keep live subagent markers
        return "Start"
    if event == "Stop":
        if _running_count(run_dir) > 0:
            _touch(sentinel)  # defer the green; subagents still running
            return None  # stay yellow
        _remove(sentinel)
        if has_background:
            return "BackgroundRunning"  # turn ended; cloud/bg session still running -> blue
        return "Stop"
    if event in ("SessionEnd", "StopFailure"):
        _clear_dir(run_dir)
        _remove(sentinel)
        return "Stop"
    if event == "Notification":
        return "PermissionRequest"
    if event == "PreToolUse":
        return "PermissionRequest" if tool == "AskUserQuestion" else None
    if event == "PostToolUse":
        return "Start"
    return None


def main():
    payload = _read_payload()
    session_id = (
        payload.get("session_id")
        or payload.get("sessionId")
        or payload.get("resourceId")
        or payload.get("resource_id")
        or ""
    )
    event = (payload.get("hook_event_name") or payload.get("hookEventName") or "").strip()
    tool = (payload.get("tool_name") or payload.get("toolName") or "").strip()
    # SubagentStart/SubagentStop pair key (distinct from the POST agentId).
    # Verified present + hex in practice; sanitize to a filesystem-safe marker
    # name so a marker write can never fail on an unexpected path character.
    sub_agent_id = (payload.get("agent_id") or payload.get("agentId") or "").strip()
    sub_agent_id = "".join(c for c in sub_agent_id if c.isalnum() or c in "-_")
    # (BA) Cloud/background-session signal. The Stop (and SubagentStop) hook
    # payload carries background_tasks[] (Claude Code >= 2.1.145); a NON-EMPTY
    # array means a cloud/background session is still running after the turn
    # ended. Absent on older versions -> falsy -> behaves exactly as before.
    # session_crons (scheduled wakeups) are intentionally NOT counted (pending,
    # not running).
    bg_tasks = payload.get("background_tasks") or payload.get("backgroundTasks")
    has_background = bool(bg_tasks)

    url = os.environ.get("SUPERSET_HOST_AGENT_HOOK_URL", "").strip()
    terminal_id = os.environ.get("SUPERSET_TERMINAL_ID", "").strip()
    agent_id = (os.environ.get("SUPERSET_AGENT_ID") or "claude").strip()

    # (BA diagnostic) When background_tasks is non-empty, dump its shape so we can
    # tell an actively-working teammate/subagent (should be YELLOW) apart from a
    # passive background shell/cloud session (BLUE). Truncated; never raises.
    if has_background:
        try:
            _log({
                "event": event,
                "terminalId": terminal_id,
                "sessionId": session_id,
                "action": "bg-tasks-debug",
                "bgCount": len(bg_tasks) if isinstance(bg_tasks, list) else -1,
                "bgTasks": json.dumps(bg_tasks)[:1500],
            })
        except Exception:
            pass

    if not terminal_id:
        _log({
            "event": event, "tool": tool, "mappedEventType": None,
            "terminalId": terminal_id, "sessionId": session_id, "url": url,
            "action": "skip-no-terminal",
        })
        return

    # Also performs the SubagentStart/Stop marker side-effects, so the
    # yellow-hold state stays consistent even when url is momentarily absent.
    event_type = _decide_event_type(
        event, tool, terminal_id, sub_agent_id, has_background
    )

    if not url:
        _log({
            "event": event, "tool": tool, "mappedEventType": event_type,
            "terminalId": terminal_id, "sessionId": session_id, "url": url,
            "action": "skip-no-url",
        })
        return
    if event_type is None:
        _log({
            "event": event, "tool": tool, "mappedEventType": None,
            "terminalId": terminal_id, "sessionId": session_id, "url": url,
            "action": "skip-unmapped",
        })
        return

    body = json.dumps({
        "json": {
            "terminalId": terminal_id,
            "eventType": event_type,
            "agent": {"agentId": agent_id, "sessionId": session_id},
        }
    }).encode("utf-8")

    try:
        req = urllib.request.Request(
            url,
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=1.5) as resp:
            status = resp.status
        _log({
            "event": event, "tool": tool, "mappedEventType": event_type,
            "terminalId": terminal_id, "sessionId": session_id, "url": url,
            "httpStatus": status, "action": "posted",
        })
    except Exception as exc:
        _log({
            "event": event, "tool": tool, "mappedEventType": event_type,
            "terminalId": terminal_id, "sessionId": session_id, "url": url,
            "error": str(exc), "action": "post-error",
        })
    return


if __name__ == "__main__":
    main()
`;

function escapeForJsonString(p: string): string {
	return p.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Hook command embedded in Claude's settings.json / Codex's hooks.json. */
function hookCommand(): string {
	return `uv run python "${escapeForJsonString(SCRIPT_PATH)}"`;
}

/** Hook command for the Claude agent-status notify script (Claude only). */
function notifyHookCommand(): string {
	return `uv run python "${escapeForJsonString(NOTIFY_SCRIPT_PATH)}"`;
}

interface HookSpec {
	type: "command";
	command: string;
}
interface HookEntry {
	matcher?: string;
	hooks?: HookSpec[];
}
interface HooksRoot {
	hooks?: Record<string, HookEntry[]>;
	[k: string]: unknown;
}

function isPaneMapHook(spec: unknown): boolean {
	if (typeof spec !== "object" || spec === null) return false;
	const cmd = (spec as { command?: unknown }).command;
	return typeof cmd === "string" && cmd.includes(SCRIPT_FILENAME);
}

function isAskMarkerHook(spec: unknown): boolean {
	if (typeof spec !== "object" || spec === null) return false;
	const cmd = (spec as { command?: unknown }).command;
	return typeof cmd === "string" && cmd.includes(ASK_MARKER_SCRIPT_FILENAME);
}

function isNotifyHook(spec: unknown): boolean {
	if (typeof spec !== "object" || spec === null) return false;
	const cmd = (spec as { command?: unknown }).command;
	return typeof cmd === "string" && cmd.includes(NOTIFY_SCRIPT_FILENAME);
}

/**
 * Returns true if the pane-map script is on disk with the expected
 * contents. False if any I/O step failed — caller MUST skip the hook
 * registration in that case, otherwise we'd point Claude/Codex at a
 * missing or stale script.
 */
function writeScriptIfChanged(): boolean {
	try {
		fs.mkdirSync(SCRIPT_DIR, { recursive: true });
		let existing: string | null = null;
		try {
			existing = fs.readFileSync(SCRIPT_PATH, "utf8");
		} catch {
			// ENOENT — write fresh.
		}
		if (existing !== PANE_MAP_SCRIPT) {
			fs.writeFileSync(SCRIPT_PATH, PANE_MAP_SCRIPT, { mode: 0o755 });
		} else {
			try {
				fs.chmodSync(SCRIPT_PATH, 0o755);
			} catch {
				// best effort — Windows ignores +x
			}
		}
		return true;
	} catch (error) {
		console.warn(
			"[pane-map-hook] failed to write pane-map script:",
			error,
		);
		return false;
	}
}

/**
 * Mirror of writeScriptIfChanged for the Claude agent-status notify script.
 * Returns false (caller skips notify-hook registration) if it didn't land.
 */
function writeNotifyScriptIfChanged(): boolean {
	try {
		fs.mkdirSync(SCRIPT_DIR, { recursive: true });
		let existing: string | null = null;
		try {
			existing = fs.readFileSync(NOTIFY_SCRIPT_PATH, "utf8");
		} catch {
			// ENOENT — write fresh.
		}
		if (existing !== NOTIFY_SCRIPT) {
			fs.writeFileSync(NOTIFY_SCRIPT_PATH, NOTIFY_SCRIPT, { mode: 0o755 });
		} else {
			try {
				fs.chmodSync(NOTIFY_SCRIPT_PATH, 0o755);
			} catch {
				// best effort — Windows ignores +x
			}
		}
		return true;
	} catch (error) {
		console.warn(
			"[pane-map-hook] failed to write notify script:",
			error,
		);
		return false;
	}
}

function mergeHook(filePath: string): void {
	// Atomic-ish merge: read → mutate in memory → write. Wrapped in
	// try/catch so a malformed settings file doesn't abort startup.
	try {
		let parsed: HooksRoot = {};
		try {
			const raw = fs.readFileSync(filePath, "utf8");
			const candidate = JSON.parse(raw);
			if (typeof candidate === "object" && candidate !== null) {
				parsed = candidate as HooksRoot;
			} else {
				return; // not an object — leave it alone
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				// JSON parse error — don't stomp on user-edited file
				console.warn(
					`[pane-map-hook] could not parse ${filePath}; skipping merge:`,
					error,
				);
				return;
			}
		}

		const hooks = parsed.hooks ?? {};
		const existing = Array.isArray(hooks.SessionStart)
			? hooks.SessionStart
			: [];

		// Drop only our hook commands from each entry, preserving any
		// unrelated co-located hooks. Drop the whole entry only when
		// nothing else is left inside its hooks list. Idempotent.
		const cleaned: HookEntry[] = [];
		for (const entry of existing) {
			const innerHooks = Array.isArray(entry.hooks) ? entry.hooks : [];
			const keptHooks = innerHooks.filter((spec) => !isPaneMapHook(spec));
			if (keptHooks.length === innerHooks.length) {
				cleaned.push(entry);
			} else if (keptHooks.length > 0) {
				cleaned.push({ ...entry, hooks: keptHooks });
			}
			// else: entry was wholly ours — drop it.
		}
		cleaned.push({
			hooks: [{ type: "command", command: hookCommand() }],
		});

		hooks.SessionStart = cleaned;
		parsed.hooks = hooks;

		try {
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
		} catch {
			// best effort
		}
		fs.writeFileSync(filePath, JSON.stringify(parsed, null, 2));
	} catch (error) {
		console.warn(
			`[pane-map-hook] failed to merge hook into ${filePath}:`,
			error,
		);
	}
}

/**
 * Register the Claude agent-status notify script across the lifecycle hook
 * events in Claude's settings.json. Each event is cleaned of prior notify
 * entries (idempotent) then gets a fresh entry appended. The notify hook owns
 * Claude working/review/permission — including the AskUserQuestion red, via the
 * PreToolUse:AskUserQuestion entry (with an unscoped PostToolUse re-asserting
 * working on any tool completion) — so the ask-marker hook is no longer
 * registered for Claude. Claude-only: never merged into Codex.
 */
function mergeNotifyHook(filePath: string): void {
	// Event -> optional matcher. Each is a SEPARATE entry under its event.
	const registrations: Array<{ event: string; matcher?: string }> = [
		{ event: "UserPromptSubmit" },
		{ event: "Stop" },
		{ event: "SessionEnd" },
		{ event: "Notification", matcher: "permission_prompt" },
		{ event: "PreToolUse", matcher: "AskUserQuestion" },
		{ event: "PostToolUse" },
		// Background-subagent yellow-hold: keep the parent terminal working
		// (yellow) while delegated subagents run after the main turn's Stop,
		// and green only once the last one finishes. See _decide_event_type.
		{ event: "SubagentStart" },
		{ event: "SubagentStop" },
		{ event: "StopFailure" }, // rate-limit/API-error abort: Claude fires StopFailure (not Stop) -> green
	];
	try {
		let parsed: HooksRoot = {};
		try {
			const raw = fs.readFileSync(filePath, "utf8");
			const candidate = JSON.parse(raw);
			if (typeof candidate === "object" && candidate !== null) {
				parsed = candidate as HooksRoot;
			} else {
				return; // not an object — leave it alone
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				console.warn(
					`[pane-map-hook] could not parse ${filePath}; skipping notify merge:`,
					error,
				);
				return;
			}
		}

		const hooks = parsed.hooks ?? {};
		for (const { event, matcher } of registrations) {
			const existing = Array.isArray(hooks[event])
				? (hooks[event] as HookEntry[])
				: [];
			// Drop our notify hook commands (idempotent re-merge) AND any stale
			// ask-marker hook from a prior build: superset-notify.py now owns the
			// AskUserQuestion red, so the old ask-marker hook must stop firing
			// after an upgrade (it wrote a marker nothing reads anymore).
			// Co-located unrelated hooks are preserved.
			const cleaned: HookEntry[] = [];
			for (const entry of existing) {
				const innerHooks = Array.isArray(entry.hooks) ? entry.hooks : [];
				const keptHooks = innerHooks.filter(
					(spec) => !isNotifyHook(spec) && !isAskMarkerHook(spec),
				);
				if (keptHooks.length === innerHooks.length) {
					cleaned.push(entry);
				} else if (keptHooks.length > 0) {
					cleaned.push({ ...entry, hooks: keptHooks });
				}
				// else: entry was wholly ours — drop it.
			}
			cleaned.push({
				...(matcher ? { matcher } : {}),
				hooks: [{ type: "command", command: notifyHookCommand() }],
			});
			hooks[event] = cleaned;
		}
		parsed.hooks = hooks;

		try {
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
		} catch {
			// best effort
		}
		fs.writeFileSync(filePath, JSON.stringify(parsed, null, 2));
	} catch (error) {
		console.warn(
			`[pane-map-hook] failed to merge notify hook into ${filePath}:`,
			error,
		);
	}
}

/**
 * Install the pane-map script and register it as a SessionStart hook in
 * Claude's and Codex's hook config files. Idempotent — calling on every
 * app launch is safe.
 */
export function installPaneMapHook(): void {
	// Skip hook registration entirely if the script didn't land on disk —
	// pointing Claude/Codex at a missing path would silently no-op every
	// session (or worse, log noise from the agent's hook runner).
	if (!writeScriptIfChanged()) return;
	// The notify script (Claude agent-status dots via the host-service POST) is
	// best-effort: if it didn't land we skip ITS hook registration but still
	// install the pane-map hook below. It OWNS the Claude AskUserQuestion red
	// now, so the ask-marker hook is no longer registered for Claude.
	const notifyOk = writeNotifyScriptIfChanged();
	if (fs.existsSync(path.dirname(CLAUDE_SETTINGS_PATH))) {
		mergeHook(CLAUDE_SETTINGS_PATH);
		if (notifyOk) mergeNotifyHook(CLAUDE_SETTINGS_PATH);
	}
	if (fs.existsSync(path.dirname(CODEX_HOOKS_PATH))) {
		mergeHook(CODEX_HOOKS_PATH);
	}
}
