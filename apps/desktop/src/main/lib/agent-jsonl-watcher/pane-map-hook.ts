import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSerialQueue } from "../serial-queue";
import {
	adoptRunningNotifyDaemon,
	awaitAdoptedNotifyDaemonExit,
	cancelNotifyDaemonRun,
	claudeProfileDirs,
	claudeProfileDirsAsync,
	claudeTranscriptRoots,
	ensureNotifyDaemon,
	NOTIFY_DAEMON_PORT,
	NOTIFY_HOOK_TIMEOUT_SECONDS,
	NOTIFY_HOOK_URL_PATH,
	NOTIFY_SECRET_HEADER,
	notifyDaemonRunToken,
	notifyHandBackToken,
	notifyHookUrl,
	resolvePythonPath,
	SETTINGS_RELOAD_MS,
	stopNotifyDaemon,
	watchNotifyDaemonTraffic,
} from "./notify-daemon";

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
// filename constant survives, so isAskMarkerHook can self-heal away (drop) any
// stale ask-marker hook a prior build registered; the script body, its writer,
// its command builder, and its merge function were all deleted.
const ASK_MARKER_SCRIPT_FILENAME = "superset-ask-marker.py";

// Claude agent-status hook. A third Python hook POSTs each Claude lifecycle
// event to the host-service so the dots are driven event-driven (no JSONL
// timing heuristics) — reviving what the dead bash `~/.superset/hooks/notify.sh`
// did. Registered (Claude settings.json only) on UserPromptSubmit / Stop /
// SessionEnd / Notification(permission_prompt) and on PreToolUse scoped to
// AskUserQuestion plus an unscoped PostToolUse (a MAIN-LOOP tool completion
// re-asserts working, clearing red after a permission approval or an answered
// question; a tool that ran inside a subagent — payload carries agent_id —
// asserts the red-respecting SubagentActive instead, see (SUBTOOL-RED)).
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
        # (HOOK-STDIN-UTF8) Hook payloads are UTF-8, but text-mode stdin on
        # Windows decodes with the locale code page (cp1252): any non-ASCII
        # payload char mojibakes and downstream string matching silently
        # fails. Always decode the raw bytes as UTF-8.
        raw = sys.stdin.buffer.read().decode("utf-8", "replace")
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

/**
 * (HOOK-HTTP-DAEMON) The per-request values the notify script needs, and the
 * request headers they travel in. Claude interpolates `$VAR` in a header value
 * only for names listed in the entry's `allowedEnvVars`, so this one list is
 * both the allowlist and the header set.
 *
 * SUPERSET_HOME_DIR is deliberately NOT here: Claude's http-hook sender throws
 * ERR_INVALID_CHAR before sending when a header value holds a code point above
 * U+00FF, and that value is a Windows profile path. The daemon reads it from
 * its own environment instead, and reads the terminal's own root out of the
 * transcript path in the payload, which is what keeps the manifest failover
 * working for an instance whose terminals POST a daemon it did not start.
 */
const NOTIFY_HOOK_ENV_VARS = [
	"SUPERSET_TERMINAL_ID",
	"SUPERSET_AGENT_ID",
	"SUPERSET_ORGANIZATION_ID",
	"SUPERSET_HOST_AGENT_HOOK_URL",
	"SUPERSET_AGENT_WATCHER_DEBUG",
];

function notifyHeaderForEnvVar(name: string): string {
	const titled = name
		.toLowerCase()
		.split("_")
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join("-");
	return `X-${titled}`;
}

/** The same map as a Python dict body, so the daemon cannot drift from it. */
const NOTIFY_HOOK_PYTHON_HEADER_MAP = NOTIFY_HOOK_ENV_VARS.map(
	(name) => `    "${name}": "${notifyHeaderForEnvVar(name).toLowerCase()}",`,
).join("\n");

// Exported for `pane-map-hook.test.ts`, which runs this exact source through a
// real python3 so the dot/lifecycle decisions are tested as shipped.
export const NOTIFY_SCRIPT = `#!/usr/bin/env python3
"""Superset Claude agent-status notify hook.

Installed by agent-jsonl-watcher/pane-map-hook.ts. POSTs each Claude lifecycle
event to the host-service (SUPERSET_HOST_AGENT_HOOK_URL) so the agent-status
dots are driven event-driven — reviving what the dead bash notify.sh did.

Event -> eventType mapping (NEVER defaults to Stop on an unknown event; an
unmapped event is a silent no-op, exactly like notify.sh):
  UserPromptSubmit            -> Start            (working / yellow)
  Stop                        -> Stop             (review/green) UNLESS a
                                 subagent is still running (then suppressed —
                                 stay yellow; greens on the last SubagentStop).
                                 With background_tasks[] still running, the
                                 entry TYPES decide: any agent-type entry
                                 (subagent/teammate/workflow) -> SubagentActive
                                 (yellow; red-respecting in the renderer);
                                 shell-only -> BackgroundRunning (blue)
  SessionEnd                  -> Stop             (review / green; clears state)
  StopFailure(main loop)      -> Failed + clears state, UNLESS a codex-companion
                                 job for this session is still alive ->
                                 SubagentActive (BF: codex runs on its OWN API;
                                 a Claude rate-limit abort does not stop it).
                                 (DEFERRED-FAILURE) that hold PARKS the failure
                                 in a .pendingfailure marker: the next turn-end
                                 with no hold left (Stop, SubagentStop, or a
                                 later StopFailure) emits Failed instead of
                                 green, and ONLY a new prompt supersedes it —
                                 so a LATER successful turn is never marked
                                 failed, and the abort is never swallowed
  StopFailure(in a subagent)  -> (STOPFAIL-SUBAGENT) self-scoped: drops only that
                                 fork's markers, never the shared session state /
                                 the main question guard; the central red guard
                                 keeps a still-pending AskUserQuestion red
  Notification                -> PermissionRequest (permission / red)
  PreToolUse(AskUserQuestion) -> PermissionRequest (red)   else no-op
  PostToolUse(main loop)      -> Start             (working — clears red after
                                 a permission approval or an answered question:
                                 the main loop is sequential, so a completed
                                 main-loop tool proves the red was handled)
  PostToolUse(in a subagent)  -> SubagentActive    ((SUBTOOL-RED) payload carries
                                 agent_id ONLY for tool calls inside a subagent;
                                 background agents' completions stream in WHILE
                                 an AskUserQuestion/permission red is pending and
                                 must assert working WITHOUT clearing that red)
  PostToolUseFailure          -> aliased to PostToolUse (a failed tool is the same
                                 "tool finished" dot signal; CLAUDE-WORKING-UNHOOKED
                                 — superset-notify.py owns it; notify.sh no longer does)
  SubagentStart               -> SubagentActive   (working, red-respecting — a
                                 workflow/teammate spawning an agent while a red
                                 is pending must not stomp it; the subagent
                                 marker still holds yellow through the main Stop)
  SubagentStop                -> Stop iff it was the LAST subagent AND main had
                                 already stopped, else no-op (see _decide_event_type)
  PreCompact                  -> Start            (working — context compaction is
                                 a minutes-long LLM call during which no other
                                 hook fires; manual /compact does not even fire
                                 UserPromptSubmit, verified live)
  SessionStart(source=compact)-> Stop after a MANUAL compact (same decision as
                                 Stop, so the subagent yellow-hold is respected
                                 and the persisted turn-end snapshot markers
                                 restore yellow for agent-type background work
                                 or BLUE for a still-running background shell);
                                 re-asserts Start after an AUTO compact (the turn
                                 is still live); no-op when we never marked a
                                 compact as running

Server maps Start->working, Stop->review, PermissionRequest->permission and
returns {"result":{"data":{"json":{"success":true,...}}}}. Uses only stdlib
urllib so it has no third-party dependency. Silent on every failure path — a
broken hook must NEVER raise or abort the agent.

(COMPANION-CAPTURE) The POST body additionally carries the whole
AskUserQuestion payload — companionQuestion on PreToolUse, and
companionQuestionResolved on the matching PostToolUse — so the companion
bridge can render a question on a phone/watch and retract the notification
when it is answered at the desk. Both fields are optional and additive; the
dot decision above never reads them, and a rejected companion payload is
retried once with the fields stripped so a dot is never lost.
"""
import base64
import collections
import datetime
import errno
import json
import os
import pathlib
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request


# (HOOK-HTTP-DAEMON) The six per-request values, and the names they arrive
# under on the CLI path. One long-lived daemon serves every terminal, so
# nothing that varies per request may live in a module global or in
# os.environ: both would leak one terminal's identity into another's decision.
_CTX_NAMES = (
    "SUPERSET_TERMINAL_ID",
    "SUPERSET_AGENT_ID",
    "SUPERSET_ORGANIZATION_ID",
    "SUPERSET_HOST_AGENT_HOOK_URL",
    "SUPERSET_HOME_DIR",
    "SUPERSET_AGENT_WATCHER_DEBUG",
)


class _Ctx(object):
    __slots__ = _CTX_NAMES + ("manifest_candidates", "transcript_home_dir")

    def __init__(self, values):
        for name in _CTX_NAMES:
            setattr(self, name, values[name])
        if not self.SUPERSET_AGENT_ID:
            self.SUPERSET_AGENT_ID = "claude"
        # Request-local: the companion strip-and-retry sweeps the same
        # candidates a second time within ONE request, and only within one.
        self.manifest_candidates = None
        # (HOOK-HTTP-DAEMON) The home root of the INSTANCE that owns the
        # terminal, read out of its transcript path; see _home_dir_of_transcript.
        self.transcript_home_dir = ""


def _ctx_from_environ():
    return _Ctx({name: os.environ.get(name, "").strip() for name in _CTX_NAMES})


# The ctx the calling thread is serving, so _log can read the debug flag
# without every caller threading it through.
_CURRENT = threading.local()


def _log_suppressed():
    ctx = getattr(_CURRENT, "ctx", None)
    if ctx is not None:
        return ctx.SUPERSET_AGENT_WATCHER_DEBUG == "0"
    return os.environ.get("SUPERSET_AGENT_WATCHER_DEBUG") == "0"


class _InvalidRequest(ValueError):
    # A caller-supplied value this hook refuses to act on. The daemon answers
    # 400; the CLI path logs it and exits 0, because a hook that aborts the
    # agent is worse than a lost dot.
    pass


# (HOOK-HTTP-DAEMON) One lock per log FILE: the two are appended from
# unrelated code paths, so a shared lock would serialize every decision
# append against every debug append on the hot path.
_HOOK_LOG_LOCK = threading.Lock()
_DECISION_LOG_LOCK = threading.Lock()
_ROTATE_LOCK = threading.Lock()
_ROTATE_INTERVAL_SECONDS = 5.0
_ROTATE_CHECKED = {}


def _rotate(log_path, backup_path):
    # Roll <log> to <log>.1 once it passes ~1MB, keeping exactly ONE backup.
    # Shared by _log and _decision_log, which rotate identically.
    #
    # Path.replace, not rename: it overwrites an existing backup (rename raises
    # on Windows when the target exists), so the old exists/unlink dance is
    # gone and a second rotation REPLACES the backup instead of failing.
    #
    # (HOOK-HTTP-DAEMON) Re-checked at most once per _ROTATE_INTERVAL_SECONDS
    # per path and serialized across workers, because the daemon outlives
    # millions of events. Best-effort: any failure leaves the log where it is.
    key = str(log_path)
    now = time.monotonic()
    with _ROTATE_LOCK:
        last = _ROTATE_CHECKED.get(key)
        if last is not None and now - last < _ROTATE_INTERVAL_SECONDS:
            return
        _ROTATE_CHECKED[key] = now
        try:
            if log_path.stat().st_size > 1048576:
                log_path.replace(backup_path)
        except Exception:
            pass


def _log(record):
    # Append one JSON line to ~/.superset/agent-notify-hook.log. Never raises.
    #
    # Rotates at ~1MB with a single .log.1 backup (see _rotate). This runs on
    # EVERY hook event (not just terminal decisions), so without rotation it
    # grows without bound: a live install reached 508MB.
    if _log_suppressed():
        return
    try:
        record["ts"] = datetime.datetime.now().isoformat()
        log_dir = pathlib.Path.home() / ".superset"
        log_dir.mkdir(parents=True, exist_ok=True)
        log_path = log_dir / "agent-notify-hook.log"
        _rotate(log_path, log_dir / "agent-notify-hook.log.1")
        # (HOOK-HTTP-DAEMON) one whole line per append, across worker threads.
        with _HOOK_LOG_LOCK, open(log_path, "a", encoding="utf-8") as h:
            h.write(json.dumps(record) + "\\n")
    except Exception:
        pass


def _decision_log(terminal_id, session_id, event_type, reason):
    # ALWAYS-ON (independent of SUPERSET_AGENT_WATCHER_DEBUG) one-line audit of a
    # terminal turn-end dot decision, so a stuck dot can be diagnosed after the
    # fact without reproducing it. Written ONLY at terminal decisions (Stop /
    # SubagentStop / StopFailure / manual-compact finish) — NOT on every
    # PostToolUse — so it stays cheap and bounded. Rotates at ~1MB via the
    # shared _rotate (single .log.1 backup, re-checked periodically: inside
    # the daemon this function runs for the life of the app).
    # Best-effort: ANY failure here is swallowed so the hook
    # still POSTs even if logging breaks. Never raises.
    try:
        ts = datetime.datetime.now(datetime.timezone.utc).isoformat()
        log_dir = pathlib.Path.home() / ".superset" / "logs"
        log_dir.mkdir(parents=True, exist_ok=True)
        log_path = log_dir / "dot-decisions.log"
        _rotate(log_path, log_dir / "dot-decisions.log.1")
        line = (
            ts
            + " terminal=" + str(terminal_id)
            + " session=" + str(session_id)
            + " eventType=" + str(event_type)
            + " " + str(reason)
        )
        with _DECISION_LOG_LOCK, open(log_path, "a", encoding="utf-8") as h:
            h.write(line + "\\n")
    except Exception:
        pass


def _read_payload():
    candidates = []
    try:
        # (HOOK-STDIN-UTF8) UTF-8-decode the raw bytes: Windows text-mode
        # stdin decodes cp1252 and mojibakes non-ASCII payload chars. Captured
        # live 2026-07-28: a teammate background_tasks description's em-dash
        # (U+2014, 3 UTF-8 bytes) arrived as 3 cp1252 chars, so the
        # (TEAM-ENTRY-MATCH) prefix match against the correctly-decoded
        # transcript prompt failed on that one entry forever -> the lead
        # terminal's dot latched yellow with zero agents running. Strict
        # decode first (payloads are harness-emitted JSON, always valid
        # UTF-8); on the never-expected failure, log loud and fall back to
        # replacement decoding so the hook still POSTs the lifecycle event.
        data = sys.stdin.buffer.read()
        try:
            raw = data.decode("utf-8")
        except UnicodeDecodeError as exc:
            try:
                _log({
                    "action": "payload-decode-error",
                    "error": str(exc),
                    "stdinBytes": len(data),
                })
            except Exception:
                pass
            raw = data.decode("utf-8", "replace")
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


def _compact_marker_path(terminal_id):
    # (COMPACT-YELLOW) records "a compaction is running" plus its trigger
    # (manual|auto) so the finish path knows how to clear the dot.
    return (
        pathlib.Path.home()
        / ".superset"
        / "agent-subagent-running"
        / (terminal_id + ".compacting")
    )


def _agentbg_marker_path(terminal_id):
    # (TEAM-YELLOW) records "the latest Stop/SubagentStop snapshot saw
    # agent-type background work still running". Consumed by the manual-compact
    # finish path, whose SessionStart payload carries NO background_tasks of
    # its own — without it, /compact ending while teammates/workflows run
    # would false-green. Refreshed from every turn-end payload; a stale marker
    # errs yellow (safe) and clears at the next bg-free turn end.
    return (
        pathlib.Path.home()
        / ".superset"
        / "agent-subagent-running"
        / (terminal_id + ".agentbg")
    )


def _shellbg_marker_path(terminal_id):
    # Sibling of .agentbg for the BLUE direction: records "the latest
    # Stop/SubagentStop snapshot saw ONLY shell-type background work still
    # running". Consumed by the same manual-compact finish path so /compact
    # ending while a background shell runs restores the BackgroundRunning
    # blue instead of false-greening (verified live 2026-06-11). A stale
    # marker errs blue-lingers — the same accepted (BA)/(BE) tradeoff — and
    # clears at the next turn end.
    return (
        pathlib.Path.home()
        / ".superset"
        / "agent-subagent-running"
        / (terminal_id + ".shellbg")
    )


def _bgactive_marker_path(terminal_id):
    # (BG-STALE) Last time REAL teammate/subagent activity was seen for this
    # terminal (a SubagentStart or a subagent-scoped PostToolUse). Consulted at a
    # turn-end agent-hold: an agent set Claude Code still reports "running" but
    # that has produced no activity for _BG_STALE_SECONDS is idle/zombie and must
    # stop pinning the lead's dot yellow (the harness never flips an idle
    # long-lived teammate, or one that died without a clean SubagentStop, to a
    # finished status). Refreshed ONLY on genuine forward activity (never on the
    # hold itself, which would keep it perpetually fresh); the JSONL watcher
    # re-asserts yellow within its poll if a reaped set turns out to still write.
    return (
        pathlib.Path.home()
        / ".superset"
        / "agent-subagent-running"
        / (terminal_id + ".bgactive")
    )


def _pending_failure_path(terminal_id):
    # (DEFERRED-FAILURE) records "a MAIN-loop StopFailure was DEFERRED because a
    # codex companion was still working". The abort is real, but announcing it
    # immediately would drop the companion's yellow hold, so the Failed dot is
    # parked here and released by the FIRST later turn-end that finds no hold
    # left — a Stop, the companion's own SubagentStop, or a later StopFailure.
    # EVERY one of those emits Failed instead of green, so an abort is never
    # swallowed by the cycle that carried it. ONLY a new prompt supersedes it
    # (UserPromptSubmit — typed or an auto-resume re-send), which is what stops
    # a LATER successful turn from being marked Failed; a fresh session /
    # SessionEnd also drop it as lifecycle boundaries. Consumed exactly once,
    # wherever it is released.
    return (
        pathlib.Path.home()
        / ".superset"
        / "agent-subagent-running"
        / (terminal_id + ".pendingfailure")
    )


def _teamstate_path(terminal_id):
    # (TEAMMATE-IDLE) incremental parse cache for the lead transcript's
    # teammate ledger plus named-fork tool-use mapping. Versioned so a schema
    # change forces a full reparse and heals entries written by older code.
    # Keyed by transcript path, so a /resume (new transcript file) or terminalId
    # reuse also self-invalidates. Corruption tolerated: any read failure falls
    # back to offset 0 — self-healing, never trusted blindly.
    return (
        pathlib.Path.home()
        / ".superset"
        / "agent-subagent-running"
        / (terminal_id + ".teamstate.json")
    )


def _askq_dir(terminal_id):
    # (UNTAGGED-BG-RED) a DIRECTORY of per-owner "an AskUserQuestion is pending"
    # markers for this terminal — one file per owner (the raising agent). An
    # AskUserQuestion red's ONLY valid clear is its own answer
    # (PostToolUse:AskUserQuestion) or that owner's turn boundary — NEVER a
    # generic main-loop tool completion. While ANY marker exists an untagged
    # ordinary PostToolUse asserts working WITHOUT clearing the red, so a
    # teammate/fork's parent-attributed (agent_id-less) tool cannot stomp a
    # still-open question. Keyed PER OWNER (not one terminal-wide flag) so two
    # concurrent questions (e.g. main + a subagent) are independent: answering or
    # ending one never drops the other's guard. Set at PreToolUse:AskUserQuestion
    # (synchronous with the red, so no background_tasks/agentbg timing window); an
    # owner's marker is cleared by its answer, its SubagentStop, or the main turn
    # boundary; the whole dir is cleared on session end / API abort / fresh start.
    return (
        pathlib.Path.home()
        / ".superset"
        / "agent-subagent-running"
        / (terminal_id + ".askq")
    )


def _askq_owner(sub_agent_id):
    # The raising agent's marker key: its sanitized agent_id, or "_main" for a
    # main-loop question (agent_id is empty there). An agent BLOCKS on its own
    # AskUserQuestion, so it can have at most one pending question -> one marker.
    return sub_agent_id if sub_agent_id else "_main"


def _write_text(p, text):
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8")
    except Exception:
        pass


def _read_text(p):
    try:
        return p.read_text(encoding="utf-8").strip()
    except Exception:
        return ""


def _drop_pane_map_if_ours(session_id, terminal_id):
    # (PANE-MAP-UNSTEAL) A session's pane mapping is last-writer-wins: resuming
    # a conversation that is ALSO open in another tab steals its mapping, and
    # after /branch (= SessionEnd here) the stolen entry keeps mirroring the
    # ORIGINAL conversation's live subagent activity onto THIS terminal — a
    # false "working" yellow with no work in the tab (seen live 2026-06-10).
    # When a session ends in this terminal, drop its mapping iff it still
    # points HERE; the next SessionStart rewrites the live mapping. A mapping
    # pointing elsewhere is someone else's — never touch it.
    safe_id = "".join(c for c in session_id if c.isalnum() or c in "-_")
    if not safe_id or not terminal_id:
        return
    try:
        p = pathlib.Path.home() / ".superset" / "session-pane-map" / (safe_id + ".json")
        data = json.loads(p.read_text(encoding="utf-8"))
        if isinstance(data, dict) and data.get("terminalId") == terminal_id:
            p.unlink()
    except Exception:
        pass


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


def _reap_askq(askq_dir, bg_ids):
    # (UNTAGGED-BG-RED) drop non-"_main" owner markers whose owner is no longer in
    # the authoritative running set (background_tasks ids share the agent_id space).
    # A subagent that died WITHOUT a clean PostToolUse:AskUserQuestion / exact-id
    # SubagentStop would otherwise pin its question marker forever — and since the
    # Stop guard returns SubagentActive whenever a non-"_main" owner exists, the dot
    # would never green. Mirrors MARKER-RECONCILE; only acts when bg_ids is known
    # (the payload carried background_tasks). "_main" is owned by the main turn
    # boundary and is never reaped here. A blocked-on-question agent is still
    # "running" -> listed in bg_ids -> kept, so this cannot drop a live red.
    if bg_ids is None:
        return
    try:
        for f in askq_dir.iterdir():
            if f.name != "_main" and f.name not in bg_ids:
                _remove(f)
    except Exception:
        pass


def _pid_alive(pid):
    # NOTE: this is the CODEX-job liveness probe. A SECOND, deliberately
    # different probe -- _manifest_pid_alive -- lives further down for host
    # manifests. They are not interchangeable and must never be merged: this
    # one fails CLOSED-ish toward "still active" (an uncertain pid keeps the
    # dot moving), while the manifest probe fails OPEN toward "keep the
    # candidate" and treats access-denied as alive. This one additionally
    # coerces the pid with int(), rejects pid <= 0, and confirms the exit code
    # is STILL_ACTIVE, because a codex record can carry a junk pid and a
    # not-yet-reaped handle must not read as running.
    #
    # (BF) Best-effort process-liveness, used to reject a STALE codex job file
    # (a worker hard-killed before it could write its terminal status leaves a
    # stale running record that the companion's cwd-scoped SessionEnd cleanup
    # may never prune — without this it would pin a false dot for the rest of
    # the Claude session). On ANY uncertainty return True (the SAFE direction:
    # keep showing activity rather than risk a false green). Never raises.
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return True  # no / non-int pid -> cannot disprove -> assume active
    if pid <= 0:
        return True
    try:
        if os.name == "nt":
            import ctypes
            PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
            STILL_ACTIVE = 259
            kernel32 = ctypes.windll.kernel32
            handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
            if not handle:
                return False  # no such process (own-user worker -> not access-denied)
            try:
                code = ctypes.c_ulong()
                if kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
                    return code.value == STILL_ACTIVE
                return True
            finally:
                kernel32.CloseHandle(handle)
        try:
            os.kill(pid, 0)
            return True
        except ProcessLookupError:
            return False
        except PermissionError:
            return True  # exists, owned by someone else
    except Exception:
        return True
    return True


def _skip_suffix(skipped):
    # (review #2) Render the codex cap-skip list for a GREEN/BLUE reason string
    # so a stale/long codex record dropped by the 6h cap is visible in
    # dot-decisions.log instead of reading as a bare "no active holds". An empty
    # list adds nothing. Never raises.
    try:
        if not skipped:
            return ""
        return " (skipped stale codex job " + "; ".join(skipped) + ")"
    except Exception:
        return ""


def _codex_job_active(session_id, detail_out=None, skipped_out=None):
    # (BF codex-companion parity) The codex plugin dispatches review/task work
    # to a DETACHED worker process that is invisible to Claude Code's
    # Stop-payload background_tasks[], so neither (BA) nor (TEAM-YELLOW) alone
    # surfaces it (terminal greens to idle while codex still runs). The
    # companion records each job as a JSON file with a status and the Claude
    # session_id (its CODEX_COMPANION_SESSION_ID is the SessionStart session_id
    # — the SAME id this hook receives). So an ACTIVE codex job for THIS
    # session is delegated agent work -> the dot stays on, like a teammate.
    # We do NOT inherit the codex plugin's CLAUDE_PLUGIN_DATA (it is
    # per-plugin), so glob the known on-disk job stores instead. "Active"
    # defers to the plugin's own definition (queued|running) AND requires the
    # job's worker pid to still be alive (_pid_alive). A transient mid-write
    # JSON read failure is skipped (-> a one-event missed hold that
    # self-corrects on the next turn-end: the SAFE direction). Bounded:
    # evaluated only at a real turn/subagent end (see _decide_event_type),
    # short-circuits on first match. Never raises.
    # detail_out (optional list): when provided, the holding job's
    # "<jobfile> pid=<pid> mtime_age=<s>s" is appended on a positive match, so
    # the always-on decision log can name exactly what held the dot.
    # skipped_out (optional list): when provided, a pid-ALIVE 'running' record
    # DISCARDED by the 6h staleness cap appends its
    # "<jobfile> pid=<pid> pid_alive=true mtime_age=<s>s cap=21600s" here. This
    # is the EXACT shape of the original stuck-yellow incident (a reused-pid
    # record aged past the cap) AND of a false-green of a genuinely long codex
    # job (see the cap caveat below). Without it the GREEN reason reads "no
    # active holds" and a reader cannot tell a stale/long codex record was
    # silently dropped vs there genuinely being nothing running.
    #
    # CAP CAVEAT (review findings #1/#4): the 6h cap assumes the codex-companion
    # worker touches its job JSON at least every <6h while alive. The producer
    # (the external openai-codex plugin's tracked-jobs.mjs) only rewrites the
    # JSON on phase/threadId/turnId CHANGE — there is NO periodic heartbeat — so
    # a legitimate job that stays in one phase for >6h (a long shell/model/
    # network wait) ages past the cap and is skipped here, dropping yellow to
    # green while still running. The cap is therefore a pid-REUSE heuristic, not
    # a liveness boundary; it deliberately self-corrects toward GREEN (the
    # file's documented SAFE direction) rather than risk a permanent stuck
    # yellow. The skipped_out logging above makes any such premature-green
    # immediately auditable in dot-decisions.log. A non-decaying liveness signal
    # (pid start-time/cmdline identity, or a companion-emitted heartbeat) would
    # remove the trade-off but lives in the external plugin / needs cross-platform
    # process introspection, so it is intentionally NOT done here.
    if not session_id:
        return False
    try:
        home = pathlib.Path.home()
        roots = [(home / ".claude" / "plugins" / "data", "codex*/state/*/jobs/*.json")]
        try:
            import tempfile
            roots.append((pathlib.Path(tempfile.gettempdir()) / "codex-companion", "*/jobs/*.json"))
        except Exception:
            pass
        active = ("queued", "running")
        for root, pattern in roots:
            try:
                for jf in root.glob(pattern):
                    # (R1 review) retry once on a parse failure: the worker
                    # rewrites the job JSON in place, so a read can land
                    # mid-write; skipping outright at the exact Stop moment
                    # would false-GREEN a still-running job.
                    rec = None
                    for _ in range(2):
                        try:
                            with open(jf, "r", encoding="utf-8") as h:
                                rec = json.load(h)
                            break
                        except Exception:
                            rec = None
                    if not isinstance(rec, dict):
                        continue
                    if rec.get("sessionId") != session_id:
                        continue
                    if (rec.get("status") or "") not in active:
                        continue
                    pid = rec.get("pid")
                    try:
                        int(pid)
                        has_pid = True
                    except (TypeError, ValueError):
                        has_pid = False
                    if has_pid:
                        # (pid-reuse guard) A 'running' record with a live pid is
                        # NOT trusted on its own: pids are recycled by the OS, so a
                        # long-dead worker's pid can read alive on an UNRELATED
                        # process and pin yellow forever (live incident: a 15-day-old
                        # 'running' record whose reused pid passed _pid_alive held the
                        # dot working for hours while idle). Require the job JSON to
                        # have been touched within 6h (the worker rewrites it as it
                        # progresses); an older record is stale -> skip it.
                        if _pid_alive(pid):
                            try:
                                import time
                                age = time.time() - jf.stat().st_mtime
                                if age < 21600:
                                    if detail_out is not None:
                                        detail_out.append(
                                            str(jf) + " pid=" + str(pid)
                                            + " mtime_age=" + str(int(age)) + "s"
                                        )
                                    return True
                                # pid alive but record aged past the cap: the
                                # exact incident (reused-pid stale record) OR a
                                # real >6h-in-one-phase job. Record the skip so
                                # the GREEN reason can name it (review #2).
                                if skipped_out is not None:
                                    skipped_out.append(
                                        str(jf) + " pid=" + str(pid)
                                        + " pid_alive=true mtime_age=" + str(int(age))
                                        + "s cap=21600s"
                                    )
                            except Exception:
                                if detail_out is not None:
                                    detail_out.append(str(jf) + " pid=" + str(pid) + " mtime_age=?")
                                return True
                        continue
                    # (R1 review) pid-less active record: a job written as
                    # queued whose worker never spawned would otherwise hold
                    # yellow for the REST of the session. Age-gate it — fresh
                    # (<10 min) counts as active (spawn in progress), older is
                    # stale and skipped.
                    try:
                        import time
                        age = time.time() - jf.stat().st_mtime
                        if age < 600:
                            if detail_out is not None:
                                detail_out.append(
                                    str(jf) + " pid=none mtime_age=" + str(int(age)) + "s"
                                )
                            return True
                    except Exception:
                        if detail_out is not None:
                            detail_out.append(str(jf) + " pid=none mtime_age=?")
                        return True  # cannot disprove -> active (safe)
            except Exception:
                continue
        return False
    except Exception:
        return False


# (MARKER-RECONCILE) statuses that mean a background_tasks[] entry is over.
# Shared by _split_background and _running_bg_ids so the yellow/blue split and
# the stale-marker reap can never disagree on what "running" means. A status
# DENYLIST, not an allowlist: an unknown running-ish status stays "running"
# (the safe yellow direction).
_FINISHED_BG_STATUSES = (
    "completed", "complete", "done", "finished", "failed", "error",
    "errored", "cancelled", "canceled", "stopped", "killed", "exited",
    "terminated",
)


def _bg_entry_finished(task):
    status = str(task.get("status") or "").lower()
    return (
        status in _FINISHED_BG_STATUSES
        or task.get("is_running") is False
        or task.get("isRunning") is False
    )


def _split_background(bg_tasks):
    # (TEAM-YELLOW) Classify the Stop/SubagentStop payload's background_tasks[].
    # Entries are TYPED (captured live 2026-06-10): "shell" = a backgrounded
    # command (passive -> blue), while "subagent" / "teammate" / "workflow" =
    # agents actively working for the user -> the dot must stay YELLOW, not
    # blue (user report: create-team work showed blue). An unknown or missing
    # type counts as agent work — the safe direction (yellow, never a false
    # green/blue). Returns (has_any, has_agent_work, has_shell_work); the shell
    # bit lets a stale mixed agent+shell set retain its live blue remainder.
    # (R1 review) entries whose status says they FINISHED are skipped entirely
    # (neither yellow nor blue) — a status DENYLIST, not an allowlist, so an
    # unknown running-ish status keeps the safe yellow rather than false-green.
    if not bg_tasks:
        return (False, False, False)
    if isinstance(bg_tasks, dict):
        bg_tasks = [bg_tasks]  # tolerate a single-entry object payload
    if not isinstance(bg_tasks, list):
        return (True, True, False)
    has_any = False
    has_agent = False
    has_shell = False
    for task in bg_tasks:
        if isinstance(task, dict):
            if _bg_entry_finished(task):
                continue
            task_type = str(task.get("type") or "")
        elif isinstance(task, str):
            task_type = task  # a bare string entry names its type
        else:
            task_type = ""  # unknown shape -> agent work (safe direction)
        has_any = True
        if task_type == "shell":
            has_shell = True
        else:
            has_agent = True
    return (has_any, has_agent, has_shell)


# (TEAMMATE-IDLE) Claude Code NEVER flips an idle teammate's background_tasks[]
# entry off "running" (captured live 2026-07-10: 33 teammate entries, all
# status "running", for a session whose 44 teammates had ALL finished hours
# earlier), so the payload alone cannot green a lead whose teammates are done —
# once no further hook event arrived, the dot stayed yellow forever. The lead
# TRANSCRIPT has the missing truth: every teammate that finishes delivers an
# idle_notification teammate-message into it, and every (re)activation is
# visible too (an Agent spawn tool_use, a SendMessage tool_use to it, a
# non-idle teammate-message/agent-message from it).
#
# (TEAM-ENTRY-MATCH) The original all-idle predicate (drop teammate entries
# only when EVERY tracked name is idle) proved unsatisfiable in real sessions
# (captured live 2026-07-22: 55 permanently-"active" names — named non-fork
# Agent spawns like sol/general-purpose review agents that finish via
# task-notification and never idle-notify, forks re-marked active by a later
# SendMessage, and "name [hash]" duplicate-suffix splits — held 25 finished
# wrangler teammates yellow all day). The decision is now PER ENTRY. Older
# Claude Code builds used the spawn prompt's head for a running teammate
# entry's "description"; current builds use the Agent tool's explicit
# description. Record both values at each named spawn; an entry may be dropped only
# when it matches at least one recorded spawn AND every matching name's last
# ledger event is an idle_notification. Unmatched, ambiguous-with-active, or
# unparseable -> keep that entry (the safe yellow direction). Poisoned
# "active" names can no longer block OTHER teammates' drops. A teammate that
# dies WITHOUT ever reporting stays "active" and keeps its own hold: from
# the logs that case is indistinguishable from a long think, so it is
# deliberately left to (BG-STALE).
#
# (TEAM-ENTRY-BIND) The prefix match ALONE proved unsatisfiable too: the
# description is only the prompt's first ~50 chars, and a lead that templates a
# preamble ("Repo: <path>", "You are reviewing ...") makes every teammate it ever
# spawned collide into ONE bucket, so a single running entry inherits every
# poisoned "active" name in the session. See _team_bind_entries: entry ids are
# now bound to the spawns they first appeared alongside, which narrows the bucket
# causally instead of by string.


def _team_norm(text):
    # Collapse whitespace runs to single spaces so a spawn prompt and the
    # payload description derived from it compare equal even if truncation
    # or the harness normalized newlines. String ops only (NO regex: this
    # file is a TS template literal and single backslashes in regex escapes
    # would be silently swallowed).
    return " ".join(str(text or "").split())


def _team_prompt_key(text):
    return _team_norm(text)[:160]


def _team_description_key(text):
    return _team_norm(text)[:512]


def _team_description_index(match_keys):
    index = {}
    for name, keys in match_keys.items():
        for description in keys.get("descriptions", []):
            index.setdefault(description, []).append(name)
    return index


def _team_set_state(state, name, val):
    # Write one ledger entry, mirroring a " [hash]"-suffixed duplicate name onto
    # its base key so the base tracks the LATEST same-named instance instead of
    # latching a stale idle.
    if not name:
        return
    state[name] = val
    if " [" in name:
        base = name.split(" [")[0].strip()
        if base:
            state[base] = val


def _team_scan_text(state, text):
    # Update the name -> "active"|"idle" ledger from one transcript text blob.
    # String scanning only (NO regex): this file is a TS template literal, and
    # single backslashes in regex escapes would be silently swallowed.
    # (TEAM-ENTRY-MATCH) A duplicate teammate name is delivered with a
    # " [hash]" suffix in its messages while the spawn recorded the base name;
    # mirror every suffixed update onto the base key so the base key tracks
    # the LATEST same-named instance instead of latching a stale idle.
    # Accepted narrow risk (review 2026-07-22): same name + identical prompt
    # head + the OLD instance silently working when the new one idles can
    # false-green the old entry until its next message re-actives the base.
    #
    # (TEAM-ENTRY-BIND) Scanned in DOCUMENT ORDER across BOTH tag kinds. The
    # original two-pass scan ran every teammate-message first and every
    # agent-message second, so within one delivered blob an agent-message always
    # won regardless of position: a teammate that reported (agent-message) and
    # then idled (idle_notification teammate-message) in the same blob latched
    # "active" forever, which is one of the ways the all-idle predicate became
    # unsatisfiable. Later evidence must win, so the later TAG must win.
    tag = '<teammate-message teammate_id="'
    tag2 = '<agent-message from="'
    pos = 0
    while True:
        i = text.find(tag, pos)
        a = text.find(tag2, pos)
        if i < 0 and a < 0:
            break
        if a < 0 or (i >= 0 and i < a):
            j = i + len(tag)
            k = text.find('"', j)
            if k < 0:
                break
            name = text[j:k]
            end = text.find("</teammate-message>", k)
            body = text[k:end] if end > 0 else text[k:]
            _team_set_state(
                state, name, "idle" if '"idle_notification"' in body else "active"
            )
            pos = k
        else:
            b = a + len(tag2)
            c = text.find('"', b)
            if c < 0:
                break
            _team_set_state(state, text[b:c], "active")
            pos = c


def _team_scan_completion(state, fork_tools, text):
    # Fork completion notices deterministically carry the spawning Agent
    # tool-use-id. Only a completed notice with an exact mapped id may remove a
    # name; malformed/unmatched text leaves the ledger untouched (safe yellow).
    if not text.startswith("<task-notification>"):
        return
    if "<status>completed</status>" not in text:
        return
    tag = "<tool-use-id>"
    i = text.find(tag)
    if i < 0:
        return
    j = i + len(tag)
    k = text.find("</tool-use-id>", j)
    if k < 0:
        return
    tool_use_id = text[j:k].strip()
    name = fork_tools.get(tool_use_id)
    if name:
        state.pop(name, None)


def _team_append_key(values, value):
    # Pruning happens after live row bindings are known. Capping here can drop
    # the only key that identifies a still-live trusted row when one teammate
    # name is reused for more than eight descriptions.
    if value and value not in values:
        values.append(value)


def _team_prune_match_keys(
    match_keys, entry_descriptions, entry_names, trusted_ids
):
    # Keep the ordinary eight-key history plus any older key still required by
    # a live trusted row. Once that row disappears, its key naturally falls out
    # of the next prune. This bounds historical churn without false-greening a
    # live row whose identifying key was evicted.
    required_prompts = {}
    required_descriptions = {}
    for entry_id in trusted_ids:
        raw_description = entry_descriptions.get(entry_id)
        if raw_description is None:
            continue
        description = _team_description_key(raw_description)
        prefix = (
            _team_description_key(raw_description[:-3])
            if str(raw_description).endswith("...")
            else description
        )
        for name in entry_names.get(entry_id, []):
            keys = match_keys.get(name, {})
            if description in keys.get("descriptions", []):
                required_descriptions.setdefault(name, set()).add(description)
            if len(prefix) >= 12:
                for prompt in keys.get("prompts", []):
                    if prompt and prompt.startswith(prefix):
                        required_prompts.setdefault(name, set()).add(prompt)
    for name, keys in match_keys.items():
        for kind, required in (
            ("prompts", required_prompts.get(name, set())),
            ("descriptions", required_descriptions.get(name, set())),
        ):
            values = keys.get(kind, [])
            tail = values[-8:]
            keys[kind] = [
                value for value in values if value in required and value not in tail
            ] + tail


def _team_prompt_binding_spawn(subagent_type):
    # Legacy prompt-head rows need the old coarse binding filter. Exact
    # descriptions use every named spawn independently of this list.
    value = str(subagent_type or "").strip().lower()
    if not value:
        return True
    if ":" in value:
        return False
    return value not in (
        "general-purpose",
        "explore",
        "sol",
        "statusline-setup",
        "output-style-setup",
        "project-structure-validator",
    )


def _team_scan_record(state, fork_tools, match_keys, spawns, taskstop_tools, obj):
    # One JSONL record -> state plus per-name prompt/description history.
    # Every NAMED non-fork Agent is eligible: live 2026-08-21 showed named
    # general-purpose agents producing teammate rows and idle notifications.
    top_content = obj.get("content")
    if isinstance(top_content, str):
        _team_scan_completion(state, fork_tools, top_content)
    msg = obj.get("message") or {}
    if not isinstance(msg, dict):
        return
    content = msg.get("content")
    if isinstance(content, str):
        _team_scan_text(state, content)
        _team_scan_completion(state, fork_tools, content)
        return
    if not isinstance(content, list):
        return
    for c in content:
        if not isinstance(c, dict):
            continue
        ctype = c.get("type")
        if ctype == "text":
            record_text = str(c.get("text") or "")
            _team_scan_text(state, record_text)
            _team_scan_completion(state, fork_tools, record_text)
        elif ctype == "tool_result":
            # (TEAM-TASKSTOP) apply the pending idle only on the CONFIRMED
            # result: an errored (or never-answered) TaskStop must not idle a
            # still-running teammate — that would false-green the lead until
            # the teammate's next message. Either way the pending entry is
            # consumed: a failed stop leaves the ledger untouched (active).
            result_id = str(c.get("tool_use_id") or "").strip()
            stopped_name = taskstop_tools.pop(result_id, None)
            if stopped_name and not c.get("is_error"):
                _team_set_state(state, stopped_name, "idle")
        elif ctype == "tool_use":
            inp = c.get("input")
            if not isinstance(inp, dict):
                continue
            if c.get("name") == "Agent":
                name = str(inp.get("name") or "").strip()
                if name and str(inp.get("subagent_type") or "").strip() == "fork":
                    tool_use_id = str(c.get("id") or "").strip()
                    if tool_use_id:
                        fork_tools[tool_use_id] = name
                    state.pop(name, None)
                    match_keys.pop(name, None)
                elif name:
                    state[name] = "active"
                    keys = match_keys.setdefault(
                        name, {"prompts": [], "descriptions": []}
                    )
                    prompt = _team_prompt_key(inp.get("prompt"))
                    description = _team_description_key(inp.get("description"))
                    _team_append_key(keys["prompts"], prompt)
                    _team_append_key(keys["descriptions"], description)
                    spawns.append((
                        name,
                        description,
                        _team_prompt_binding_spawn(inp.get("subagent_type")),
                    ))
                    # A non-fork spawn reclaims the name from stale fork maps.
                    stale = [k for k, value in fork_tools.items() if value == name]
                    for key in stale:
                        fork_tools.pop(key, None)
            elif c.get("name") == "SendMessage":
                name = str(inp.get("to") or "").strip()
                if name and name not in fork_tools.values():
                    state[name] = "active"
            elif c.get("name") == "TaskStop":
                # (TEAM-TASKSTOP) A teammate stopped via the TaskStop tool never
                # emits an idle_notification, so the ledger latched it "active"
                # forever and its background_tasks row could never be dropped
                # (live 2026-08-22: implementer + three simp-* reviewers stopped
                # at turn end held the lead's dot yellow permanently). Record
                # the request keyed by its tool-use id; the idle lands only when
                # the matching NON-ERROR tool_result confirms the stop (see the
                # tool_result branch above). task_id accepts "name", "name@team"
                # or an agent id; the agent-id form matches no ledger name and
                # is a harmless no-op.
                stop_target = str(inp.get("task_id") or "").strip()
                stop_name = stop_target.split("@")[0].strip()
                stop_tool_id = str(c.get("id") or "").strip()
                if (
                    stop_name
                    and stop_tool_id
                    and stop_name not in fork_tools.values()
                ):
                    taskstop_tools[stop_tool_id] = stop_name


def _team_scan_records(data, state, fork_tools, match_keys, spawns, taskstop_tools):
    for raw in data.split(b"\\n"):
        if not raw.strip():
            continue
        try:
            obj = json.loads(raw.decode("utf-8", "replace"))
        except Exception:
            continue
        if isinstance(obj, dict):
            _team_scan_record(state, fork_tools, match_keys, spawns, taskstop_tools, obj)


# (TEAM-SPAWN-CREDIT) Seconds a spawn credit slot survives unconsumed —
# WALL-CLOCK, not ledger runs: turn-ends arrive in bursts in multi-teammate
# sessions (several SubagentStops in seconds), so a run-counted TTL could
# expire before the harness first lists the row. 15 min covers any real
# spawn-to-first-listing gap while still expiring long before a much-later
# same-text workflow row could inherit the credit and false-green.
_CREDIT_TTL_SECONDS = 900


def _team_empty_ledger():
    return ({}, {}, {}, {}, [], set(), {}, {}, 0)


def _team_cached_bindings(record):
    seen_ids = [str(value) for value in record["seenIds"]]
    entry_names = {
        str(key): [str(value) for value in values]
        for key, values in record["entryNames"].items()
        if isinstance(values, list)
    }
    return seen_ids, entry_names


def _team_cache_lock(cache_file):
    # Serialize the whole read/scan/bind/replace transaction. os.replace makes
    # one write atomic but cannot stop an older overlapping process from
    # replacing a newer cache afterward. The one-byte lock works on Windows
    # and POSIX, waits at most two seconds, and returns None on every acquisition
    # error so uncertain rows stay yellow rather than running unlocked.
    lock_file = cache_file.with_name(cache_file.name + ".lock")
    handle = None
    try:
        lock_file.parent.mkdir(parents=True, exist_ok=True)
        handle = open(lock_file, "a+b")
        handle.seek(0, 2)
        if handle.tell() == 0:
            handle.write(b"\\0")
            handle.flush()
        deadline = time.monotonic() + 2.0
        while True:
            try:
                handle.seek(0)
                if os.name == "nt":
                    import msvcrt
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                return handle
            except OSError as error:
                if error.errno not in (errno.EACCES, errno.EAGAIN, errno.EDEADLK):
                    _log({
                        "action": "teamstate-lock-error",
                        "phase": "acquire",
                        "error": type(error).__name__ + ": " + str(error),
                    })
                    handle.close()
                    return None
                if time.monotonic() >= deadline:
                    handle.close()
                    return None
                time.sleep(0.025)
    except Exception as error:
        _log({
            "action": "teamstate-lock-error",
            "phase": "open",
            "error": type(error).__name__ + ": " + str(error),
        })
        try:
            if handle is not None:
                handle.close()
        except Exception:
            pass
        return None


def _team_cache_unlock(handle):
    ok = True
    try:
        handle.seek(0)
        if os.name == "nt":
            import msvcrt
            msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
    except Exception as error:
        ok = False
        _log({
            "action": "teamstate-lock-error",
            "phase": "release",
            "error": type(error).__name__ + ": " + str(error),
        })
    try:
        handle.close()
    except Exception as error:
        ok = False
        _log({
            "action": "teamstate-lock-error",
            "phase": "close",
            "error": type(error).__name__ + ": " + str(error),
        })
    return ok


def _team_write_cache(cache_file, record):
    temp_file = cache_file.with_name(
        cache_file.name + "." + str(os.getpid()) + ".tmp"
    )
    try:
        cache_file.parent.mkdir(parents=True, exist_ok=True)
        temp_file.write_text(json.dumps(record), encoding="utf-8")
        os.replace(temp_file, cache_file)
    except Exception:
        _remove(temp_file)
        raise


def _team_initialize_fresh_cache(transcript_path, terminal_id):
    # SessionStart source=startup|clear is the one provable fresh-session
    # boundary. Snapshot the transcript's CURRENT size so metadata or branched
    # history already present is historical, while every later first-turn spawn
    # is unread causal evidence. Resume/compact never call this helper.
    if not transcript_path or not terminal_id:
        return
    cache_file = _teamstate_path(terminal_id)
    lock_handle = _team_cache_lock(cache_file)
    if lock_handle is None:
        return
    try:
        try:
            offset = pathlib.Path(transcript_path).stat().st_size
        except FileNotFoundError:
            # SessionStart can fire before the new transcript file is created.
            # The named startup/clear boundary still proves offset zero; every
            # record written after this hook is unread causal evidence.
            offset = 0
        _team_write_cache(cache_file, {
            "version": 7,
            "path": transcript_path,
            "offset": offset,
            "state": {},
            "forkTools": {},
            "matchKeys": {},
            "seenIds": [],
            "entryNames": {},
            "trustedEntryIds": [],
            "spawnDescCredits": {},
            "taskStopTools": {},
        })
    except Exception as error:
        _log({
            "action": "teamstate-fresh-init-error",
            "error": type(error).__name__ + ": " + str(error),
        })
    _team_cache_unlock(lock_handle)


def _team_ledger(transcript_path, terminal_id, entry_descriptions):
    if not transcript_path or not terminal_id:
        return None
    lock_handle = _team_cache_lock(_teamstate_path(terminal_id))
    if lock_handle is None:
        return None
    try:
        result = _team_ledger_locked(
            transcript_path, terminal_id, entry_descriptions
        )
    except Exception as error:
        _log({
            "action": "teamstate-ledger-error",
            "error": type(error).__name__ + ": " + str(error),
        })
        result = None
    unlocked = _team_cache_unlock(lock_handle)
    return result if unlocked else None


def _team_ledger_locked(transcript_path, terminal_id, entry_descriptions):
    # Incrementally parse the lead transcript into state, match-key histories,
    # prompt bindings, and exact-description bindings. Cache schema v6 adds
    # descriptions; v7 adds cumulative spawn-credit counters
    # ((TEAM-SPAWN-CREDIT), v6 migrates in place with zero credits); v5
    # migration rebuilds key history while preserving its already-causal live
    # bindings. Every failure path returns None.
    entry_ids = list(entry_descriptions)
    cache_file = _teamstate_path(terminal_id)
    (
        state,
        fork_tools,
        match_keys,
        entry_names,
        seen_ids,
        trusted_ids,
        spawn_credits,
        taskstop_tools,
        offset,
    ) = _team_empty_ledger()
    migrating_v5 = False
    loaded_cache = False
    try:
        rec = json.loads(cache_file.read_text(encoding="utf-8"))
        common = (
            isinstance(rec, dict)
            and rec.get("path") == transcript_path
            and isinstance(rec.get("state"), dict)
            and isinstance(rec.get("forkTools"), dict)
            and isinstance(rec.get("seenIds"), list)
            and isinstance(rec.get("entryNames"), dict)
        )
        if (
            common
            and rec.get("version") in (6, 7)
            and isinstance(rec.get("matchKeys"), dict)
            and all(
                isinstance(value, dict)
                and isinstance(value.get("prompts"), list)
                and isinstance(value.get("descriptions"), list)
                for value in rec.get("matchKeys", {}).values()
            )
            and isinstance(rec.get("trustedEntryIds"), list)
        ):
            offset = int(rec.get("offset") or 0)
            state = {str(k): str(v) for k, v in rec["state"].items()}
            fork_tools = {
                str(k): str(v) for k, v in rec["forkTools"].items()
            }
            match_keys = {
                str(k): {
                    "prompts": [str(x) for x in v["prompts"]],
                    "descriptions": [str(x) for x in v["descriptions"]],
                }
                for k, v in rec["matchKeys"].items()
            }
            seen_ids, entry_names = _team_cached_bindings(rec)
            trusted_ids = {str(value) for value in rec["trustedEntryIds"]}
            # (TEAM-SPAWN-CREDIT) v7 adds cumulative spawn-credit records (per
            # description: the full NAME SET ever credited plus one ttl slot
            # per unconsumed spawn) and the pending-TaskStop map; a v6 cache
            # migrates in place with both empty (only records scanned from
            # HERE on can credit — never a reparse storm, never a historical
            # credit).
            if rec.get("version") == 7:
                raw_credits = rec.get("spawnDescCredits")
                if isinstance(raw_credits, dict):
                    for k, v in raw_credits.items():
                        if not isinstance(v, dict):
                            continue
                        names = [
                            str(n) for n in v.get("names", [])
                            if n and isinstance(n, str)
                        ]
                        slots = [
                            float(t) for t in v.get("slots", [])
                            if isinstance(t, (int, float))
                            and not isinstance(t, bool)
                            and t > 0
                        ]
                        if names and slots:
                            spawn_credits[str(k)] = {
                                "names": names, "slots": slots
                            }
                raw_taskstops = rec.get("taskStopTools")
                if isinstance(raw_taskstops, dict):
                    taskstop_tools = {
                        str(k): str(v) for k, v in raw_taskstops.items() if v
                    }
            loaded_cache = True
        elif (
            common
            and rec.get("version") == 5
            and isinstance(rec.get("prompts"), dict)
        ):
            # Preserve v5's already-causal bindings and offset. Rebuild its
            # historical description keys below, but never treat those old
            # records as causal evidence for a previously unbound row.
            migrating_v5 = True
            offset = int(rec.get("offset") or 0)
            state = {str(k): str(v) for k, v in rec["state"].items()}
            fork_tools = {
                str(k): str(v) for k, v in rec["forkTools"].items()
            }
            # A historical replay rebuilds prompt history in document order.
            # Seed only when no replay is available; prepending v5's latest
            # prompt before older replayed prompts would invert latest-only
            # fallback and let a stale prompt false-green a foreign row.
            match_keys = {
                str(k): {
                    "prompts": [str(v)] if str(v) else [],
                    "descriptions": [],
                }
                for k, v in rec["prompts"].items()
            } if offset == 0 else {}
            seen_ids, entry_names = _team_cached_bindings(rec)
            trusted_ids = set(entry_names)
            loaded_cache = True
    except Exception:
        (
            state,
            fork_tools,
            match_keys,
            entry_names,
            seen_ids,
            trusted_ids,
            spawn_credits,
            taskstop_tools,
            offset,
        ) = _team_empty_ledger()
        migrating_v5 = False
        loaded_cache = False
    historical_data = b""
    try:
        with open(transcript_path, "rb") as handle:
            handle.seek(0, 2)
            size = handle.tell()
            if offset < 0 or offset > size:
                (
                    state,
                    fork_tools,
                    match_keys,
                    entry_names,
                    seen_ids,
                    trusted_ids,
                    spawn_credits,
                    taskstop_tools,
                    offset,
                ) = _team_empty_ledger()
                migrating_v5 = False
                loaded_cache = False
            if migrating_v5 and offset:
                handle.seek(0)
                historical_data = handle.read(offset)
            handle.seek(offset)
            data = handle.read()
    except Exception:
        return None
    if historical_data:
        # One migration-only replay reconstructs exact-description history for
        # trusted v5 bindings. Its spawn list is discarded, so historical rows
        # cannot make an unbound v5 entry trustworthy.
        historical_state = {}
        historical_fork_tools = {}
        historical_spawns = []
        historical_taskstops = {}
        _team_scan_records(
            historical_data,
            historical_state,
            historical_fork_tools,
            match_keys,
            historical_spawns,
            historical_taskstops,
        )
        state = historical_state
        fork_tools = historical_fork_tools
    spawns = []
    newline = data.rfind(b"\\n")
    partial_tail = bool(data[newline + 1:].strip()) if newline >= 0 else bool(data.strip())
    # A partial trailing record makes the whole unread delta provisional. Do not
    # advance past complete spawn lines ahead of it: first-seen rows are deferred
    # while partial, and consuming those lines would discard their causal spawn
    # evidence before the next clean scan.
    if newline >= 0 and not partial_tail:
        _team_scan_records(
            data[:newline], state, fork_tools, match_keys, spawns, taskstop_tools
        )
        offset += newline + 1
    previously_seen = set(seen_ids)
    # (TEAM-SPAWN-CREDIT) Exact descriptions are the strongest identity in the
    # payload, but the OLD trust rule demanded the spawn record and the row's
    # FIRST listing land in the SAME scan delta. In real sessions they almost
    # never do: any turn-end seconds after the spawn (a sibling teammate's
    # SubagentStop) consumes the delta holding the spawn record, the harness
    # lists the new row only in a LATER payload, and the row is then
    # "previously seen" — permanently untrusted, so its exact-description match
    # was refused and the entry could never be dropped (live 2026-08-22: BOTH
    # stuck sessions ended a full day of teamwork with trustedEntryIds=[];
    # zombie row t7qlyg0mu "Pull New Relic logs for alerts" pinned the eMAR
    # lead yellow although its teammate had idled hours earlier). Spawn
    # evidence is now CUMULATIVE ACROSS A BOUNDED WINDOW: every named non-fork
    # Agent spawn scanned since the fresh-session boundary credits its
    # description once, and a first-seen row batch may consume that credit
    # within the next few ledger runs — still causal (credits exist only for
    # spawns observed inside this session's own scan chain, never from a cold
    # offset-0 replay), still conservative (a batch larger than the unconsumed
    # credit binds nothing, consumed credit can never be spent twice, and a
    # credit slot EXPIRES after _CREDIT_TTL_SECONDS of wall-clock so an
    # arbitrarily old spawn cannot lend causal identity to a much-later
    # same-text workflow row and let it inherit an idle verdict — the same
    # expiry principle (TEAM-ENTRY-BIND) applies to pending prompt bindings).
    if not partial_tail and loaded_cache:
        # Expire dead credit slots FIRST (wall-clock — see _CREDIT_TTL_SECONDS).
        # A description whose slots all expired/consumed is dropped WHOLE — its
        # name set with it — so later same-text rows are unbindable again.
        credit_now = time.time()
        for description in list(spawn_credits):
            slots = [t for t in spawn_credits[description]["slots"] if t > credit_now]
            if slots:
                spawn_credits[description]["slots"] = slots
            else:
                spawn_credits.pop(description)
        for spawn_name, spawn_description, _ in spawns:
            if spawn_description:
                credit = spawn_credits.setdefault(
                    spawn_description, {"names": [], "slots": []}
                )
                if spawn_name not in credit["names"]:
                    credit["names"].append(spawn_name)
                credit["slots"].append(credit_now + _CREDIT_TTL_SECONDS)
        # Bounded, always in the SAFE direction (a forgotten credit only means
        # a row stays yellow): slots trim to the newest 16; a name set past 64
        # drops the WHOLE entry — trimming names alone would narrow a later
        # row's candidate set and make its all-idle drop EASIER, the unsafe
        # direction. The map keeps the 64 most-recently-credited descriptions;
        # recency lives in the slot timestamps (newest slot = last credit), so
        # eviction reads them rather than trusting dict order. Pending
        # TaskStops keep the newest 32; a forgotten one only leaves its target
        # active.
        for description in list(spawn_credits):
            credit = spawn_credits[description]
            if len(credit["names"]) > 64:
                spawn_credits.pop(description)
                continue
            if len(credit["slots"]) > 16:
                credit["slots"] = credit["slots"][-16:]
        while len(spawn_credits) > 64:
            spawn_credits.pop(
                min(spawn_credits, key=lambda d: max(spawn_credits[d]["slots"]))
            )
        while len(taskstop_tools) > 32:
            taskstop_tools.pop(next(iter(taskstop_tools)))
        new_rows_by_description = {}
        for entry_id, raw_description in entry_descriptions.items():
            if not entry_id or entry_id in trusted_ids:
                continue
            if entry_id in previously_seen:
                continue
            description = _team_description_key(raw_description)
            if description:
                new_rows_by_description.setdefault(description, []).append(entry_id)
        for description, row_ids in new_rows_by_description.items():
            credit = spawn_credits.get(description)
            if credit is None or len(row_ids) > len(credit["slots"]):
                # Diagnosable, not silent: an unbound first-seen row is exactly
                # the pre-fix stuck shape, so name why the credit did not cover
                # it (expired TTL, consumed pool, workflow-created row, batch
                # larger than the pool).
                _log({
                    "action": "spawn-credit-miss",
                    "description": description[:160],
                    "rows": len(row_ids),
                    "slots": 0 if credit is None else len(credit["slots"]),
                })
                continue
            # The batch binds to EVERY name ever credited for this description
            # (not just the unconsumed remainder): rows are not listed in spawn
            # order, so consuming slots front-first must never exclude a row's
            # true spawner from its own candidate set — one early fast-finisher
            # would otherwise strip its sibling's name and false-green a
            # still-working teammate. Slots gate CARDINALITY only.
            causal_names = sorted(set(credit["names"]))
            del credit["slots"][: len(row_ids)]
            if not credit["slots"]:
                spawn_credits.pop(description, None)
            for entry_id in row_ids:
                entry_names[entry_id] = causal_names
                trusted_ids.add(entry_id)
    binding_ids = entry_ids
    if partial_tail:
        binding_ids = [
            entry_id
            for entry_id in entry_ids
            if entry_id in previously_seen or entry_id in entry_names
        ]
    entry_names, seen_ids = _team_bind_entries(
        entry_names,
        seen_ids,
        binding_ids,
        [name for name, _, prompt_eligible in spawns if prompt_eligible],
    )
    live_ids = set(entry_ids)
    trusted_ids.intersection_update(live_ids)
    _team_prune_match_keys(
        match_keys, entry_descriptions, entry_names, trusted_ids
    )
    description_index = _team_description_index(match_keys)
    try:
        _team_write_cache(cache_file, {
            "version": 7,
            "path": transcript_path,
            "offset": offset,
            "state": state,
            "forkTools": fork_tools,
            "matchKeys": match_keys,
            "seenIds": seen_ids,
            "entryNames": entry_names,
            "trustedEntryIds": sorted(trusted_ids),
            "spawnDescCredits": spawn_credits,
            "taskStopTools": taskstop_tools,
        })
    except Exception:
        pass
    if partial_tail:
        return None
    return (state, match_keys, description_index, entry_names, trusted_ids)

def _team_bind_entries(entry_names, seen_ids, entry_ids, spawns):
    # (TEAM-ENTRY-BIND) Bind each FIRST-SEEN running teammate entry id to the
    # spawn name(s) it appeared alongside, forget bindings for ids that have left
    # the running set, and return the updated (bindings, seen ids).
    #
    # Why this exists: a teammate entry carries ONLY {id, type, status,
    # description}, and the description is the spawn prompt's first ~50 chars.
    # Leads template that preamble (live 2026-08-18: every teammate in a session
    # described as "Repo: C:...worktrees/<uuid>-" — exactly 50 chars of
    # boilerplate), so the (TEAM-ENTRY-MATCH) prefix join maps ONE running entry
    # onto EVERY teammate the session ever spawned. The all-matching-names-idle
    # rule is then unsatisfiable the moment any one of them is stuck "active",
    # and the lead's yellow can never be released: the single running teammate
    # idled at 14:50:35Z, the turn-end Stop fired 6s later with the correct
    # ledger state, and seven unrelated names (three last heard from 19-26h
    # earlier) kept the entry.
    #
    # The entry id is stable for the entry's lifetime and appears nowhere else on
    # disk, so no exact join exists — but an id that has NEVER been listed before
    # and IS listed now was created by the spawns observed in between. That is a
    # causal link, not a string guess. One new id + one new spawn binds exactly;
    # any other shape binds the id to the whole candidate batch, which only
    # narrows the prefix bucket rather than identifying within it (still
    # requiring every candidate idle).
    #
    # Narrowing is what makes a drop EASIER, so every input to it is kept
    # deliberately conservative: only teammate-capable spawn types are
    # candidates, pendings never outlive their run, and an id is bindable only
    # once. A wrong binding CAN still false-green (that is the residual risk of
    # binding at all) — it cannot be waved away by "it only narrows".
    live = set(entry_ids)
    bound = {}
    for k, v in entry_names.items():
        if k in live:
            bound[k] = v
    # An id counts as NEW only the FIRST time it is ever observed. An id that
    # was listed before — bound or not, and whether or not it left the running
    # set in between — was NOT created by the spawns parsed since the previous
    # snapshot, and binding it to them is how live work gets false-greened: the
    # harness re-lists a resumed teammate, and an entry the count guard once
    # declined must not become bindable later just because the guard now
    # passes. Both maps stay bounded: bindings prune to the live set, and the
    # seen list keeps only a tail of the ids that have left it.
    seen = set(seen_ids)
    first_seen_ids = [i for i in entry_ids if i and i not in seen]
    new_ids = [i for i in first_seen_ids if i not in bound]
    # More first-seen entries than observed spawns means at least one of them was
    # created by something other than a lead Agent tool-use (a workflow spawning
    # its own teammate), so no assignment is trustworthy. Count rows already
    # exact-bound above too: one spawn cannot be spent once by exact matching and
    # again by this legacy prompt binder. Leave residual rows unbound so the
    # broader prompt bucket keeps uncertain work yellow.
    if new_ids and spawns and len(first_seen_ids) <= len(spawns):
        candidates = list(spawns)
        for i in new_ids:
            bound[i] = candidates
    stale = [i for i in seen_ids if i and i not in live]
    return bound, stale[-192:] + [i for i in entry_ids if i]



def _team_entry_analysis(
    entry, match_keys, description_index, entry_names, trusted_ids
):
    # Exact Agent descriptions take precedence. Only a trusted first-seen
    # binding may use them. If no Agent description equals the payload, retain
    # the legacy prompt-prefix behavior (with or without a trailing "...").
    raw_description = str(entry.get("description") or "")
    description = _team_description_key(raw_description)
    prefix = (
        _team_description_key(raw_description[:-3])
        if raw_description.endswith("...")
        else description
    )
    entry_id = str(entry.get("id") or "")
    bound = entry_names.get(entry_id) or []
    exact_names = description_index.get(description, [])
    prompt_matches = []
    description_matches = []
    if exact_names:
        # Exact text without causal trust must stay candidate-free/yellow. Never
        # fall through to legacy prompts: a foreign live row could inherit an
        # idle Agent name and false-ready.
        if entry_id in trusted_ids:
            description_matches = [name for name in exact_names if name in bound]
        candidates = description_matches
    else:
        if len(prefix) >= 12:
            for name, keys in match_keys.items():
                prompts = keys.get("prompts", [])
                # An unbound row may only compare against the name's latest
                # prompt. Old prompt history can belong to finished work and
                # must not make a later foreign row look idle. A causal legacy
                # binding may keep using its older identifying prompt.
                if name not in bound:
                    prompts = prompts[-1:]
                if any(
                    prompt and prompt.startswith(prefix)
                    for prompt in prompts
                ):
                    prompt_matches.append(name)
        narrowed = [name for name in prompt_matches if name in bound]
        candidates = narrowed or prompt_matches
    return (
        prefix,
        prompt_matches,
        description_matches,
        bound,
        candidates,
        entry_id in trusted_ids,
    )

def _team_debug_entry(
    terminal_id, entry, state, analysis, droppable, analysis_error
):
    # (TEAM-KEPT-DEBUG) One JSONL line per teammate bg entry per decision:
    # the normalized match, causal binding, candidate states, and verdict.
    # Best-effort: never raises (caller wraps too).
    (
        prefix,
        prompt_matches,
        description_matches,
        bound,
        candidates,
        trusted,
    ) = analysis
    if analysis_error:
        reason = "analysis-error"
    elif droppable:
        reason = "dropped"
    elif not (prompt_matches or description_matches):
        reason = "untrusted-description" if prefix and not trusted else "unmatched"
    else:
        reason = "matched-active"
    log_dir = pathlib.Path.home() / ".superset" / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / "teammate-idle-debug.log"
    try:
        if log_path.stat().st_size > 2097152:
            backup = log_dir / "teammate-idle-debug.log.1"
            try:
                if backup.exists():
                    backup.unlink()
            except Exception:
                pass
            log_path.rename(backup)
    except Exception:
        pass
    rec = {
        "ts": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "terminal": str(terminal_id),
        "droppable": bool(droppable),
        "reason": reason,
        "analysis_error": analysis_error,
        "prefix_len": len(prefix),
        "prefix": prefix[:220],
        "prompt_matches": [
            name + "=" + str(state.get(name)) for name in prompt_matches
        ],
        "description_matches": [
            name + "=" + str(state.get(name)) for name in description_matches
        ],
        "bound": [str(value) for value in bound],
        "trusted_binding": trusted,
        "candidates": [
            name + "=" + str(state.get(name)) for name in candidates
        ],
        "ledger_state": {str(k): str(v) for k, v in state.items()},
        "entry": {str(k): str(v)[:300] for k, v in entry.items()},
    }
    with open(log_path, "a", encoding="utf-8") as h:
        h.write(json.dumps(rec) + "\\n")

def _without_idle_teammates(bg_tasks, transcript_path, terminal_id, note_out=None):
    # (TEAMMATE-IDLE)(TEAM-ENTRY-MATCH) Returns bg_tasks with each unfinished
    # teammate-type entry dropped IFF the transcript ledger proves that
    # specific teammate idle; anything unproven stays. Only ever REMOVES
    # teammate entries — shell / subagent / workflow entries always pass
    # through untouched. Never raises.
    if not isinstance(bg_tasks, list) or not bg_tasks:
        return bg_tasks
    has_teammate = False
    entry_descriptions = {}
    for t in bg_tasks:
        if (
            isinstance(t, dict)
            and not _bg_entry_finished(t)
            and str(t.get("type") or "") == "teammate"
        ):
            has_teammate = True
            entry_descriptions[str(t.get("id") or "")] = str(
                t.get("description") or ""
            )
    if not has_teammate:
        return bg_tasks
    try:
        ledger = _team_ledger(
            transcript_path, terminal_id, entry_descriptions
        )
    except Exception:
        return bg_tasks
    if ledger is None:
        return bg_tasks
    state, match_keys, description_index, entry_names, trusted_ids = ledger
    out = []
    dropped = 0
    kept = 0
    for t in bg_tasks:
        if (
            isinstance(t, dict)
            and not _bg_entry_finished(t)
            and str(t.get("type") or "") == "teammate"
        ):
            droppable = False
            analysis = ("", [], [], [], [], False)
            analysis_error = ""
            try:
                analysis = _team_entry_analysis(
                    t,
                    match_keys,
                    description_index,
                    entry_names,
                    trusted_ids,
                )
                _, _, _, _, candidates, _ = analysis
                droppable = bool(candidates) and all(
                    state.get(name) == "idle" for name in candidates
                )
            except Exception as error:
                analysis_error = type(error).__name__
            try:
                _team_debug_entry(
                    terminal_id,
                    t,
                    state,
                    analysis,
                    droppable,
                    analysis_error,
                )
            except Exception:
                pass
            if droppable:
                dropped += 1
                continue
            kept += 1
        out.append(t)
    if (dropped or kept) and note_out is not None:
        try:
            note_out.append(
                " [teammate-idle: dropped "
                + str(dropped)
                + " idle teammate entries, kept "
                + str(kept)
                + "]"
            )
        except Exception:
            pass
    return out


def _running_bg_ids(bg_tasks):
    # (MARKER-RECONCILE) The ids of background_tasks[] entries still running,
    # sanitized EXACTLY like the SubagentStart marker names (main() applies
    # the same filter to agent_id) so set membership compares marker
    # filenames. bgTasks entry ids and SubagentStart agent_ids share one id
    # space — captured live 2026-06-12: an async Agent launch returned agentId
    # a4d216da..., its SubagentStart carried the same id, and its entry in
    # every later background_tasks[] used it as the entry id.
    ids = set()
    if isinstance(bg_tasks, dict):
        bg_tasks = [bg_tasks]
    if not isinstance(bg_tasks, list):
        return ids
    for task in bg_tasks:
        if not isinstance(task, dict) or _bg_entry_finished(task):
            continue
        raw = "".join(c for c in str(task.get("id") or "") if c.isalnum() or c in "-_")
        if raw:
            ids.add(raw)
    return ids


def _reconcile_run_dir(run_dir, bg_ids, terminal_id):
    # (MARKER-RECONCILE) Reap LEAKED yellow-hold markers. A SubagentStart whose
    # SubagentStop arrives with a mismatched or missing agent_id (observed
    # live 2026-06-12: a background fork + a workflow-internal agent) leaves
    # its marker behind forever, suppressing every later Stop -> the dot pins
    # yellow with nothing running. The Stop/SubagentStop payload's
    # background_tasks[] is the harness's authoritative list of what is STILL
    # running, so at a turn end any marker not listed there is provably stale
    # -> delete it. Genuinely-running work always survives: an async subagent
    # is listed under its own id (marker kept; the stopping agent even lists
    # ITSELF as running in its own SubagentStop payload), and workflow- or
    # teammate-internal agents are owned by their listed workflow/teammate
    # entry, whose agent type keeps the dot yellow via (TEAM-YELLOW)
    # regardless of markers. Never raises.
    reaped = []
    try:
        for f in run_dir.iterdir():
            if f.name in bg_ids:
                continue
            _remove(f)
            reaped.append(f.name)
    except Exception:
        pass
    if reaped:
        _log({
            "terminalId": terminal_id,
            "action": "reconcile-reaped-markers",
            "reaped": reaped,
        })


# (MARKER-INACTIVE) Seconds of NO subagent activity past which a yellow-hold
# marker is treated as leaked and reaped — a conservative FAR backstop. The
# marker is touched on SubagentStart AND on every PostToolUse the subagent fires
# (see the PostToolUse branch), so its mtime tracks the subagent's LAST activity,
# not just its start: an actively-working subagent (incl. one on a long tool that
# streams progress) keeps it fresh and survives; only a truly abandoned one ages
# out. The COMMON leak — an in-flight subagent orphaned by an API stream-idle-
# timeout (no SubagentStop) — is caught fast + deterministically by this file's
# OWN StopFailure branch, whose _clear_dir(run_dir) drops every orphan the moment
# the abort arrives (Claude Code fires StopFailure whenever the turn's last
# assistant record is an api-error), NOT by this timer (a short timer here
# false-greened subagents on long tools — flaky). 12h is kept only so a subagent
# that hangs with NO error signal AND that the harness keeps (wrongly) listing
# in background_tasks[] (which defeats MARKER-RECONCILE) can't pin yellow
# FOREVER; it errs green, the file's documented safe direction.
_MARKER_STALE_SECONDS = 43200


def _reap_stale_markers(run_dir, terminal_id):
    # (review #3) Time-based safety net for the MARKER-RECONCILE reap: remove
    # run-dir markers whose mtime is older than _MARKER_STALE_SECONDS. This is
    # the ONLY reap that runs when the turn-end payload carries no usable
    # background_tasks[] (bg_ids is None) — the exact case where a leaked
    # SubagentStart marker would otherwise suppress every later Stop and pin the
    # dot yellow indefinitely. Returns the count of markers STILL present after
    # the reap (so the caller can log a "HOLD working: N markers" reason).
    # Never raises.
    reaped = []
    remaining = 0
    try:
        import time
        now = time.time()
        for f in run_dir.iterdir():
            try:
                if now - f.stat().st_mtime > _MARKER_STALE_SECONDS:
                    _remove(f)
                    # (UNTAGGED-BG-RED) do NOT age-reap the matching askq owner here:
                    # a subagent legitimately BLOCKED on an open AskUserQuestion has no
                    # tool activity, so its run marker ages out while its question is
                    # still genuinely open — clearing its askq owner would drop a LIVE
                    # red. askq owners clear only via answer / exact SubagentStop /
                    # authoritative bg_ids reap / StopFailure / SessionEnd / fresh
                    # SessionStart. A leaked owner with no bg_ids errs YELLOW (safe).
                    reaped.append(f.name)
                else:
                    remaining += 1
            except Exception:
                remaining += 1  # cannot stat -> assume live (safe yellow)
    except Exception:
        return _running_count(run_dir)
    if reaped:
        _log({
            "terminalId": terminal_id,
            "action": "reap-stale-markers",
            "reaped": reaped,
            "boundSeconds": _MARKER_STALE_SECONDS,
        })
    return remaining


# (BG-STALE) Seconds of ZERO teammate/subagent activity after which a
# background_tasks[] agent set that Claude Code still reports "running" is
# treated as idle/zombie and stops pinning the lead's dot yellow. Claude Code
# never flips an idle long-lived teammate (or one that died without a clean
# SubagentStop) to a finished status, so without this the dot stays yellow until
# the team is disbanded / the session ends (live incident 2026-06-24: 6
# teammates "running" but silent 27 min). 15 min is long enough that a team
# doing real work — which streams SubagentStart / subagent-scoped PostToolUse
# events that refresh .bgactive — never ages out, while a stalled set recovers
# quickly; the JSONL watcher re-asserts yellow within its poll if a reaped set
# is in fact still writing, so the reap errs recoverable, not permanent.
_BG_STALE_SECONDS = 900


def _bg_hold_is_stale(terminal_id):
    # True iff .bgactive exists and is older than _BG_STALE_SECONDS (the held
    # agent set has shown no activity that long). A MISSING marker is NOT stale:
    # the caller seeds it at the turn-end snapshot and holds yellow once, so a
    # team that predates this code (no SubagentStart seen) still gets a single
    # benefit-of-the-doubt turn before it can be reaped. Any error -> NOT stale
    # (the safe yellow direction). Never raises.
    p = _bgactive_marker_path(terminal_id)
    try:
        import time
        return (time.time() - p.stat().st_mtime) > _BG_STALE_SECONDS
    except Exception:
        return False


def _decide_event_type(
    event,
    tool,
    terminal_id,
    sub_agent_id,
    has_background,
    has_agent_background,
    has_shell_background,
    bg_ids,
    trigger,
    source,
    session_id,
    reason_out=None,
):
    # (UNTAGGED-BG-RED) CENTRAL RED GUARD. The renderer has ONE permission axis per
    # terminal, so a red-CLEARING result (Start, or a green/blue turn-end) must NEVER
    # be emitted while a question owner is still live in the .askq dir — that would
    # clear a co-pending question's red. EVERY decision funnels through here, so no
    # individual branch (answer, UserPromptSubmit, Stop, SubagentStop, the compact
    # paths, ...) can drop the red. When a held result is a turn-end
    # (Stop/BackgroundRunning), mark .mainstopped so the eventual last SubagentStop
    # still finalizes to green once the dir empties. (The inner branches already
    # _remove the answered/own owner and _reap_askq dead owners first, so the count
    # here is the set of GENUINELY still-open questions.)
    askq_dir = _askq_dir(terminal_id)
    before = _running_count(askq_dir)
    result = _decide_event_type_inner(
        event, tool, terminal_id, sub_agent_id, has_background,
        has_agent_background, has_shell_background, bg_ids, trigger, source,
        session_id, reason_out,
    )
    after = _running_count(askq_dir)
    final = result
    # DOWNGRADE: never clear a red while a question owner is still live -> hold
    # SubagentActive; the sentinel policy below stamps .mainstopped on a held
    # turn-end so the last SubagentStop can still finalize green once the dir
    # empties.
    if result in ("Start", "Stop", "BackgroundRunning") and after > 0:
        final = "SubagentActive"
    # UPGRADE: this event removed the LAST question owner (answered / cancelled
    # SubagentStop / reaped) but the inner returned a NON-clearing result
    # (SubagentActive for a yellow/agent/codex hold, or None for a no-op) — so the
    # now-stale permission red would latch. Emit Start to clear it; working still
    # shows (red>working only applied while an owner existed), and the next genuine
    # turn-end greens. Without this, a cancelled subagent question or a main Stop
    # held by other subagents would leave the answered/gone question's red stuck.
    elif (
        event != "SessionStart"  # a fresh-session cleanup empties the dir but resolves NO question -> never assert working
        and before > 0
        and after == 0
        and (result is None or result == "SubagentActive")
    ):
        final = "Start"
    # (SENTINEL-HOLD) CENTRAL SENTINEL POLICY. The .mainstopped sentinel means
    # "the main turn ended while a hold was still live"; the eventual last
    # SubagentStop requires it to finalize green. The rule is a pure function
    # of (turn-end event, FINAL result), so it is enforced HERE, once, on the
    # result actually returned — the incident's root cause was exactly one
    # branch (Stop holding for background_tasks agents) applying it by hand and
    # getting it wrong, which no-op'd the terminal's last SubagentStop and
    # latched yellow forever (live 2026-08-22, terminal ad607899). A hold
    # result at a turn-end keeps/stamps the sentinel; a true turn-end result
    # (Stop/Failed) consumes it; None leaves whatever the inner branch decided
    # (e.g. the Stop live-markers hold touches it itself). Non-turn-end events
    # (SubagentStart, PostToolUse, UserPromptSubmit — whose branch removes it
    # explicitly) are outside the rule on purpose: their SubagentActive asserts
    # say nothing about the main turn.
    if event in ("Stop", "SubagentStop", "StopFailure", "SessionEnd") or (
        event == "SessionStart" and source == "compact"
    ):
        if final in ("Stop", "Failed"):
            _remove(_sentinel_path(terminal_id))
        elif final in ("SubagentActive", "BackgroundRunning"):
            _touch(_sentinel_path(terminal_id))
    return final


def _decide_event_type_inner(
    event,
    tool,
    terminal_id,
    sub_agent_id,
    has_background,
    has_agent_background,
    has_shell_background,
    bg_ids,
    trigger,
    source,
    session_id,
    reason_out=None,
):
    # Returns the host-service eventType or None (None => silent no-op).
    # reason_out (optional list): at a TERMINAL turn-end decision (Stop /
    # SubagentStop / StopFailure / manual-compact finish) a human-readable
    # reason string is appended so the always-on dot-decision log can explain
    # WHY the dot held yellow vs went green/blue/red. Never raises on this.
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
    # (TEAM-YELLOW) refinement: background_tasks[] entries are TYPED, so the
    # blue is reserved for a SHELL-ONLY remainder. Any running agent-type entry
    # (subagent fork, teammate, workflow) means agents are still actively
    # working -> assert Start (yellow) instead of BackgroundRunning. Every
    # later Stop re-evaluates the list, so the dot self-corrects to green (or
    # blue, if only shells remain) once the agents finish and the lead's next
    # turn ends.
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
    compact_marker = _compact_marker_path(terminal_id)
    agentbg_marker = _agentbg_marker_path(terminal_id)
    shellbg_marker = _shellbg_marker_path(terminal_id)
    bgactive_marker = _bgactive_marker_path(terminal_id)
    pending_failure_marker = _pending_failure_path(terminal_id)
    askq_dir = _askq_dir(terminal_id)

    def _reason(text):
        # Best-effort capture of the terminal-decision reason. Never raises.
        try:
            if reason_out is not None:
                reason_out.append(text)
        except Exception:
            pass

    # (CLAUDE-WORKING-UNHOOKED) superset-notify.py now OWNS PostToolUseFailure for
    # Claude (notify.sh no longer raw-posts it). A FAILED tool is, for the dot, the
    # same "tool finished" signal as a success, so route it through the guarded
    # PostToolUse branch (agent_id discrimination + the central .askq red guard):
    # a failed main-loop tool asserts working / clears a HANDLED permission, a
    # failed subagent tool stays SubagentActive, and a still-open AskUserQuestion
    # red is NEVER stomped. Without this the event would fall through to None
    # (no-op) and a generic tool-permission red could latch with no clear path.
    # (STOPFAIL-SUBAGENT is handled INLINE in the StopFailure branch below — it
    # must NOT route through the Stop/SubagentStop snapshot+reconcile machinery,
    # which would trust the abort payload's possibly-incomplete background_tasks.)
    if event == "PostToolUseFailure":
        event = "PostToolUse"

    # (TEAM-YELLOW) keep the background snapshot markers fresh from every
    # turn-end payload — including Stops the run_dir yellow-hold suppresses —
    # so payload-less events (SessionStart after /compact) can consult them.
    # .agentbg mirrors the SubagentActive direction, .shellbg the
    # BackgroundRunning one; at most one is set at a time.
    if event in ("Stop", "SubagentStop"):
        # (MARKER-RECONCILE) when the payload carries the background_tasks
        # list (bg_ids is not None), it is ground truth for what still runs —
        # reap any leaked yellow-hold marker BEFORE the count checks below
        # decide the dot, so a stale marker cannot pin yellow forever.
        if bg_ids is not None:
            _reconcile_run_dir(run_dir, bg_ids, terminal_id)
        if has_agent_background:
            _touch(agentbg_marker)
            # (BG-STALE) seed the activity timer the first time an agent set is
            # seen at a turn end, so a set that predates this code (no
            # SubagentStart observed) can still age out instead of holding
            # yellow forever. A genuinely-active set refreshes it via its own
            # SubagentStart / subagent-scoped PostToolUse before it can stale.
            if not bgactive_marker.exists():
                _touch(bgactive_marker)
        else:
            _remove(agentbg_marker)
            _remove(bgactive_marker)  # (BG-STALE) no agent bg -> clear the timer
        if has_background and not has_agent_background:
            _touch(shellbg_marker)
        else:
            _remove(shellbg_marker)

    # (COMPACT-YELLOW) Context compaction IS the agent working: it is a
    # summarization LLM call that can take minutes, during which NO other hook
    # fires — without this the dot sits green/idle the whole time (a manual
    # /compact does not even fire UserPromptSubmit; verified live 2026-06-10,
    # PreCompact at :36:53 -> SessionStart(source=compact) at :39:28).
    # PreCompact (manual /compact AND auto-compact) marks the terminal as
    # compacting and shows working/yellow. SessionStart with source=compact
    # fires when compaction completes: after a MANUAL compact the session is
    # idle again, so run the SAME decision as Stop (respects the subagent
    # yellow-hold); after an AUTO compact the turn is still live, so re-assert
    # working — the turn's real Stop greens it later. A leaked marker is the
    # SAFE direction (yellow, never a false green) and is cleared by the next
    # UserPromptSubmit / Stop / SessionEnd.
    if event == "PreCompact":
        _write_text(compact_marker, trigger or "auto")
        return "Start"
    if event == "SessionStart":
        if source != "compact":
            _clear_dir(askq_dir)  # (UNTAGGED-BG-RED) fresh session / terminalId reuse -> drop stale question guards
            _remove(pending_failure_marker)  # (DEFERRED-FAILURE) a parked abort belongs to the session that died, not this one
            return None
        was_trigger = _read_text(compact_marker)
        if not was_trigger:
            return None  # a compaction we never marked — leave the dot alone
        _remove(compact_marker)
        if was_trigger == "manual":
            live_markers = _reap_stale_markers(run_dir, terminal_id)  # (review #3) age-reap leaked markers
            if live_markers > 0:
                _touch(sentinel)  # background subagents still running -> stay yellow
                _reason("HOLD working: " + str(live_markers) + " subagent markers in " + str(run_dir) + " (manual-compact finish)")
                return None
            _remove(sentinel)
            # (R1 review) this payload carries no background_tasks — consult the
            # persisted turn-end snapshot + codex so a manual compact ending
            # while teammates/workflows/codex run cannot false-green.
            cx = []
            cx_skip = []
            # (BG-STALE) a stale agentbg snapshot (idle/zombie teammates) must not
            # re-yellow a manual /compact finish either; reap it like the Stop path.
            agent_hold = agentbg_marker.exists() and not _bg_hold_is_stale(terminal_id)
            if not agent_hold and agentbg_marker.exists():
                _remove(agentbg_marker)
                # (FIX 4 BG-STALE) leave the stale .bgactive mtime in place so the
                # set stays stale and keeps greening — removing it would let the
                # next turn-end snapshot re-seed it fresh and grant another 900s
                # yellow grace, cycling. It un-stales only on real activity (_touch),
                # and is still cleared by the no-agent-bg snapshot else, StopFailure
                # and SessionEnd.
            if agent_hold or _codex_job_active(session_id, cx, cx_skip):
                if cx:
                    _reason("HOLD working: codex job " + cx[0] + " (manual-compact finish)")
                else:
                    _reason("HOLD working: agentbg marker " + str(agentbg_marker) + " (manual-compact finish)")
                return "SubagentActive"  # red-respecting working hold
            if shellbg_marker.exists():
                _reason("BLUE: shell background remainder (shellbg marker, manual-compact finish)" + _skip_suffix(cx_skip))
                return "BackgroundRunning"  # background shell still running -> blue
            _reason("GREEN: no active holds (manual-compact finish)" + _skip_suffix(cx_skip))
            return "Stop"  # manual compact finished -> review/green (or idle)
        return "Start"  # auto-compact mid-turn: keep working/yellow

    if event == "SubagentStart":
        if sub_agent_id:
            _touch(run_dir / sub_agent_id)
        _touch(bgactive_marker)  # (BG-STALE) genuine forward teammate activity
        # SubagentActive (NOT Start): launching delegated work proves agents
        # are busy, not that a pending question/permission was answered — a
        # workflow/teammate spawning an agent mid-red must keep the red.
        return "SubagentActive"
    if event == "SubagentStop":
        if sub_agent_id:
            _remove(run_dir / sub_agent_id)
            _remove(askq_dir / sub_agent_id)  # (UNTAGGED-BG-RED) this subagent stopped -> its question (if any) is gone
        _reap_askq(askq_dir, bg_ids)  # (UNTAGGED-BG-RED) drop any other dead subagent question owners
        # (review #3) reap age-stale markers so a leaked sibling marker cannot
        # keep this count >0 forever and block the last-subagent green.
        live_markers = _reap_stale_markers(run_dir, terminal_id)
        if live_markers == 0 and sentinel.exists():
            _remove(sentinel)  # (SENTINEL-HOLD) the wrapper re-stamps it on a hold result
            # has_background here is read from THIS SubagentStop payload, which
            # carries background_tasks[] scoped to the PARENT session (Claude Code
            # docs >= 2.1.145) — i.e. what is still running now that this subagent
            # is done. So remaining agent work -> yellow, a remaining shell ->
            # blue, nothing left -> green; all accurate. (Absent field on an
            # older/odd version -> green, which only mis-greens in the narrow
            # case where Stop carried the field but SubagentStop did not — same
            # version added both, so not in practice.)
            # (BG-STALE) same idle/zombie reap as the Stop branch.
            stale_bg = has_agent_background and _bg_hold_is_stale(terminal_id)
            agent_hold = has_agent_background and not stale_bg
            if stale_bg:
                _remove(agentbg_marker)
                # (FIX 4) leave .bgactive's stale mtime so the set stays stale and
                # keeps greening; removing it would let the next Stop re-seed it
                # fresh and re-grant 900s of yellow grace, cycling. It un-stales
                # only on real activity (_touch) and is cleared by the no-agent-bg
                # snapshot else / StopFailure / SessionEnd.
            cx = []
            cx_skip = []
            if agent_hold or _codex_job_active(session_id, cx, cx_skip):
                # SubagentActive (NOT Start): the renderer asserts working only
                # when the source is not already red — a Start here would stomp
                # a teammate-raised permission/question (red trumps yellow).
                if agent_hold:
                    if bg_ids:
                        _reason("HOLD working: background_tasks agents=" + str(sorted(bg_ids)) + " (SubagentStop)")
                    else:
                        _reason("HOLD working: background_tasks agent work (SubagentStop)")
                else:
                    _reason("HOLD working: codex job " + (cx[0] if cx else "?") + " (SubagentStop)")
                return "SubagentActive"  # teammates/workflows/codex still working -> yellow
            # (FIX 5) blue is the live SHELL remainder after agent holds are
            # resolved. A stale mixed agent+shell set must retain blue even though
            # raw has_agent_background stays true; an agent-only zombie set has no
            # shell bit and still falls through to GREEN/Stop below.
            if has_shell_background and not agent_hold:
                tag = " [bg-agents idle >" + str(_BG_STALE_SECONDS) + "s reaped]" if stale_bg else ""
                _reason("BLUE: live shell background remainder" + tag + " (SubagentStop)" + _skip_suffix(cx_skip))
                return "BackgroundRunning"  # only live background shells remain -> blue
            if pending_failure_marker.exists():
                # (DEFERRED-FAILURE) the held companion finished INSIDE the
                # aborted cycle: this is the release, not a fresh clean turn.
                # Greening here would silently swallow the API abort.
                _remove(pending_failure_marker)
                _reason("FAILED: deferred StopFailure released after final hold (SubagentStop)" + _skip_suffix(cx_skip))
                return "Failed"
            if stale_bg:
                _reason("GREEN: bg-agents idle >" + str(_BG_STALE_SECONDS) + "s, stale-reaped (SubagentStop)" + _skip_suffix(cx_skip))
            else:
                _reason("GREEN: no active holds (SubagentStop, last subagent done)" + _skip_suffix(cx_skip))
            return "Stop"  # main already stopped + last subagent done -> green
        # (SENTINEL-HOLD diagnostics) this used to be a SILENT no-op — the exact
        # path the 2026-08-22 stuck-yellow incident died on. Always name why no
        # turn-end decision was made so dot-decisions.log can prove it.
        _reason(
            "NOOP: SubagentStop, markers=" + str(live_markers)
            + " main_stopped=" + str(sentinel.exists())
            + " -> no turn-end decision"
        )
        return None  # other subagents running, or main still working
    if event == "UserPromptSubmit":
        _remove(sentinel)  # main working again; keep live subagent markers
        _remove(compact_marker)  # any earlier compaction is over/irrelevant
        # (DEFERRED-FAILURE) a new prompt — typed OR an auto-resume re-send after
        # the API abort — opens a NEW work cycle. The previous cycle's parked
        # StopFailure is history from here on; leaving it would make THIS cycle's
        # clean Stop announce a false Failed.
        _remove(pending_failure_marker)
        _remove(askq_dir / "_main")  # (UNTAGGED-BG-RED) new main prompt -> main question moot (subagent owners persist)
        _reap_askq(askq_dir, bg_ids)  # drop dead subagent owners; central guard holds for any LIVE one
        return "Start"  # central guard downgrades to SubagentActive if a subagent owner remains
    if event == "Stop":
        _remove(compact_marker)  # turn ended; a leaked compact marker is stale
        _remove(askq_dir / "_main")  # (UNTAGGED-BG-RED) main turn ended -> main question done (subagent owners persist)
        _reap_askq(askq_dir, bg_ids)  # (UNTAGGED-BG-RED) drop dead subagent owners; the central guard then holds for any LIVE one
        # (review #3) reap age-stale markers first so a missing/garbled
        # background_tasks[] (no MARKER-RECONCILE) cannot pin yellow forever.
        live_markers = _reap_stale_markers(run_dir, terminal_id)
        if live_markers > 0:
            _touch(sentinel)  # defer the green; subagents still running
            _reason("HOLD working: " + str(live_markers) + " subagent markers in " + str(run_dir) + " (Stop)")
            return None  # stay yellow
        _remove(sentinel)  # (SENTINEL-HOLD) the wrapper re-stamps it on a hold result
        # (BG-STALE) an agent set the harness still reports running but that has
        # produced no activity for _BG_STALE_SECONDS is idle/zombie -> drop the
        # yellow hold (fall through to blue/green); the watcher re-asserts if it
        # is genuinely still writing.
        stale_bg = has_agent_background and _bg_hold_is_stale(terminal_id)
        agent_hold = has_agent_background and not stale_bg
        if stale_bg:
            _remove(agentbg_marker)  # the snapshot above touched it on raw has_agent_background
            # (FIX 4) leave .bgactive's stale mtime so the set keeps greening; a
            # _remove here would let the next Stop re-seed it fresh and re-grant
            # 900s of yellow grace, cycling. It un-stales only on real activity
            # (_touch); cleared by the no-agent-bg snapshot else / StopFailure /
            # SessionEnd.
        cx = []
        cx_skip = []
        if agent_hold or _codex_job_active(session_id, cx, cx_skip):
            # SubagentActive (NOT Start) — red-respecting working assert; see
            # the SubagentStop branch comment.
            if agent_hold:
                if bg_ids:
                    _reason("HOLD working: background_tasks agents=" + str(sorted(bg_ids)) + " (Stop)")
                else:
                    _reason("HOLD working: background_tasks agent work (Stop)")
            else:
                _reason("HOLD working: codex job " + (cx[0] if cx else "?") + " (Stop)")
            return "SubagentActive"  # teammates/workflows/codex still working -> yellow, not blue
        # (FIX 5) blue is the live SHELL remainder after agent holds are
        # resolved. A stale mixed agent+shell set must retain blue even though
        # raw has_agent_background stays true; an agent-only zombie set has no
        # shell bit and still falls through to GREEN/Stop below.
        if has_shell_background and not agent_hold:
            tag = " [bg-agents idle >" + str(_BG_STALE_SECONDS) + "s reaped]" if stale_bg else ""
            _reason("BLUE: live shell background remainder" + tag + " (Stop)" + _skip_suffix(cx_skip))
            return "BackgroundRunning"  # turn ended; only live background shells remain -> blue
        if pending_failure_marker.exists():
            _remove(pending_failure_marker)
            _reason("FAILED: deferred StopFailure released after final hold" + _skip_suffix(cx_skip))
            return "Failed"
        if stale_bg:
            _reason("GREEN: bg-agents idle >" + str(_BG_STALE_SECONDS) + "s, stale-reaped (Stop)" + _skip_suffix(cx_skip))
        else:
            _reason("GREEN: no active holds (Stop)" + _skip_suffix(cx_skip))
        return "Stop"
    if event == "StopFailure":
        # (STOPFAIL-SUBAGENT) A StopFailure carrying an agent_id is ONE subagent/
        # fork aborting on a rate-limit/API error — NOT the whole Claude session
        # dying. The full session abort below (clear run_dir + EVERY marker + the
        # .askq question guard, then green) would stomp the MAIN loop's still-
        # pending AskUserQuestion red (live 2026-06-27: a fork hit a limit, its
        # StopFailure cleared askq + Stop while the user was still being asked).
        # Handle it SELF-SCOPED: drop only THIS fork's run + question markers,
        # never the shared state (sibling markers, the main question owner, the
        # agent-bg snapshot), and — like the main-abort branch below — never trust
        # the abort payload's background_tasks (it may be stale/incomplete). The
        # remaining run-dir marker COUNT + the .mainstopped sentinel decide the
        # hold; the central red guard re-holds any still-open question (incl _main).
        if sub_agent_id:
            _remove(run_dir / sub_agent_id)
            _remove(askq_dir / sub_agent_id)
            live = _reap_stale_markers(run_dir, terminal_id)
            if live > 0 or not sentinel.exists():
                # Other forks still running, OR the main loop has not stopped yet
                # -> no red-clearing turn-end; leave the dot as-is. The central
                # guard keeps a pending question red (and UPGRADEs to Start if this
                # removed the LAST owner — the failed fork's own answered/dead red).
                _reason(
                    "HOLD: subagent StopFailure, "
                    + str(live) + " markers, main_stopped=" + str(sentinel.exists())
                )
                return None
            _remove(sentinel)
            cx = []
            cx_skip = []
            if _codex_job_active(session_id, cx, cx_skip):
                _reason("HOLD working: codex job " + (cx[0] if cx else "?") + " (StopFailure/subagent)")
                return "SubagentActive"  # wrapper re-stamps .mainstopped for the companion's finalize
            if pending_failure_marker.exists():
                # (DEFERRED-FAILURE) same release as the SubagentStop path — a
                # green here would swallow the parked main-loop abort.
                _remove(pending_failure_marker)
                _reason("FAILED: deferred StopFailure released after final hold (StopFailure/subagent)" + _skip_suffix(cx_skip))
                return "Failed"
            _reason("GREEN: subagent StopFailure, last fork done + main stopped" + _skip_suffix(cx_skip))
            return "Stop"  # central guard re-holds if a question owner (incl _main) remains
        # (AX)/(BF)/(API-ABORT-RELEASE) A MAIN Claude API/rate-limit abort kills
        # the shared-API Claude subagent tree and fires NO SubagentStop for any
        # of them, so their run-dir markers would pin the dot yellow with
        # nothing running. Claude Code runs StopFailure whenever the turn's last
        # assistant record is an api-error, so THIS branch is where that leak is
        # released: clear the whole run dir + every snapshot marker + the .askq
        # guard, then green. Deterministic and event-driven — no timer, and no
        # transcript reader involved (the JSONL watcher deliberately emits no
        # dot state for an api-error; see WATCHER-BLUE-STOMP). BUT a
        # codex-companion worker is a SEPARATE process on its OWN API — the
        # Claude failure does not stop it, so keep showing it as working.
        # (has_background is NOT consulted here: Claude background_tasks share
        # the dead Claude API.)
        _clear_dir(run_dir)
        _remove(sentinel)
        _remove(compact_marker)
        _remove(agentbg_marker)  # Claude bg tasks died with the Claude API
        _remove(shellbg_marker)  # snapshot is stale; StopFailure stays no-blue
        _remove(bgactive_marker)  # (BG-STALE) Claude teammates died with the API
        _clear_dir(askq_dir)  # (UNTAGGED-BG-RED) the abort killed the Claude API -> all its questions are dead
        cx = []
        cx_skip = []
        if _codex_job_active(session_id, cx, cx_skip):
            _touch(pending_failure_marker)
            # (DEFERRED-FAILURE) the main loop HAS stopped — with a failure —
            # while delegated work continues, which is exactly what .mainstopped
            # records. Stamp it (the _remove above assumed an unconditional
            # green) so the companion's own SubagentStop can finalize this cycle
            # and RELEASE the parked failure. Without it that SubagentStop hits
            # the "main still working" no-op and the abort is never announced.
            _touch(sentinel)
            _reason("HOLD working: codex job " + (cx[0] if cx else "?") + " (StopFailure)")
            return "SubagentActive"  # codex on its own API survives the abort
        _remove(pending_failure_marker)
        _reason("FAILED: no active holds (StopFailure)" + _skip_suffix(cx_skip))
        return "Failed"
    if event == "SessionEnd":
        # Session is ending — the dot context goes away, so a still-running
        # codex job does not hold the dot here; just clear state and green.
        _clear_dir(run_dir)
        _remove(sentinel)
        _remove(compact_marker)
        _remove(agentbg_marker)
        _remove(shellbg_marker)
        _remove(bgactive_marker)  # (BG-STALE) session over -> clear the timer
        _remove(_teamstate_path(terminal_id))  # (TEAMMATE-IDLE) ledger cache is per-session state
        _remove(pending_failure_marker)
        _clear_dir(askq_dir)  # (UNTAGGED-BG-RED) session over -> drop all pending-question guards
        return "Stop"
    if event == "Notification":
        _reason("RED: permission (Notification)")
        return "PermissionRequest"
    if event == "PreToolUse":
        if tool == "AskUserQuestion":
            _touch(askq_dir / _askq_owner(sub_agent_id))  # (UNTAGGED-BG-RED) this owner's question is open -> protect its red
            _reason("RED: permission (PreToolUse:AskUserQuestion)")
            return "PermissionRequest"
        return None
    if event == "PostToolUse":
        # (FIX 3) An AskUserQuestion that COMPLETES always means the user
        # answered, so it clears the pending red regardless of agent context —
        # even when the question was raised + answered INSIDE a subagent. This
        # MUST precede the sub_agent_id branch below: SubagentActive does not
        # clear the permission axis, so returning it here would leave the
        # terminal stuck RED after a subagent's question is answered. Refresh
        # the subagent's run-dir marker (mirror the per-marker touch) so the
        # yellow-hold mtime stays live, then Start to clear the red.
        if tool == "AskUserQuestion":
            _remove(askq_dir / _askq_owner(sub_agent_id))  # (UNTAGGED-BG-RED) this owner answered -> stop protecting its red
            marker = run_dir / sub_agent_id
            if sub_agent_id and marker.exists():
                _touch(marker)
            # Start clears the red; the central guard downgrades to SubagentActive if
            # ANOTHER owner's question is still open (one permission axis per terminal).
            return "Start"
        # (SUBTOOL-RED) agent_id is present iff the tool ran INSIDE a subagent
        # (Claude Code hooks doc: "use this to distinguish subagent hook calls
        # from main-thread calls"; verified live 2026-06-12). Background
        # agents' tool completions stream in while the MAIN loop is blocked on
        # an AskUserQuestion/permission red — they prove agents are working,
        # NOT that the red was answered, so they get the red-respecting
        # assert. A main-loop PostToolUse (no agent_id) still maps to Start:
        # the main loop is sequential, so a completed tool there means the
        # pending question/permission was answered and red must clear.
        if sub_agent_id:
            _touch(bgactive_marker)  # (BG-STALE) teammate/subagent forward activity
            # (MARKER-INACTIVE) refresh THIS subagent's run-dir marker so its mtime
            # tracks last activity. A subagent that dies/hangs without a clean
            # SubagentStop (e.g. caught in an API stream-idle-timeout) otherwise
            # leaks its marker and pins yellow until the 12h reap (MARKER-RECONCILE
            # keeps it because the harness still lists the zombie in background_tasks).
            # With a live mtime, _reap_stale_markers ages it out instead. Refresh an
            # EXISTING marker only — SubagentStart owns creation.
            marker = run_dir / sub_agent_id
            if marker.exists():
                _touch(marker)
            return "SubagentActive"
        # (ASYNC-TOOL-RED) the Workflow / Agent / Task tools SPAWN background agents
        # and return (or stream progress) on the MAIN loop, so their PostToolUse
        # carries NO agent_id yet fires WHILE the main loop is blocked on an
        # AskUserQuestion/permission red (a background workflow/agent finishing
        # mid-question). SUBTOOL-RED's "no agent_id => sequential main loop =>
        # the question was answered" assumption breaks for these async tools, so
        # mapping them to Start wrongly clears the pending red (live 2026-06-24: a
        # "Workflow Completed" flipped a red AskUserQuestion to yellow within ms;
        # the notify log showed 1700+ PostToolUse:Agent->Start, 245 Workflow). They
        # prove agents are busy, not that the user answered -> red-respecting
        # SubagentActive (keeps a pending red red; still asserts yellow otherwise).
        if tool in ("Workflow", "Agent", "Task"):
            _touch(bgactive_marker)  # (BG-STALE) background-agent forward activity
            return "SubagentActive"
        # (UNTAGGED-BG-RED) An AskUserQuestion red's ONLY valid clear is its own
        # answer (PostToolUse:AskUserQuestion, handled above) or its owner's turn
        # boundary — NEVER a generic tool completion. Teammate/fork tool completions
        # stream in attributed to the PARENT session WITHOUT an agent_id (live
        # 2026-06-26: 66 Read/57 Edit/56 Bash PostToolUse agentId="" -> Start flipped
        # a pending AskUserQuestion red -> yellow while 4 teammates ran), so they
        # reach this fallback as untagged tools. The .askq dir holds a per-owner
        # marker set SYNCHRONOUSLY at PreToolUse:AskUserQuestion (present from the
        # instant the question appears — no background_tasks/agentbg timing window),
        # so while ANY marker exists a question is still open: assert working WITHOUT
        # clearing the red. The main loop is BLOCKED on that question, so this
        # untagged tool is genuine teammate/fork forward activity -> refresh .bgactive
        # too (mirror the other SubagentActive branches) so a long teammate whose
        # only events are parent-attributed tools cannot be stale-reaped to a false
        # green. A genuine answer clears its OWN owner marker first, so this never
        # strands a real answer. A tool-PERMISSION red (no .askq marker) is still
        # cleared by its approved tool's main-loop completion below -> the
        # permission-approval red-clear is preserved (no regression).
        if _running_count(askq_dir) > 0:
            _touch(bgactive_marker)
            return "SubagentActive"
        return "Start"
    return None


# --- (COMPANION-CAPTURE) -------------------------------------------------
# The PreToolUse:AskUserQuestion payload already carries the WHOLE question:
# tool_use_id, transcript_path, session_id, cwd, tool_input.questions[] (each
# with question / header / multiSelect / options[] -> label + description) and
# agent_id / agent_type when a subagent asked. Until now this hook read only
# tool_name and threw the rest away, so the companion phone/watch had nothing
# to render and no way to discover a question without parsing transcripts.
#
# Everything below is PURELY ADDITIVE. It runs only for AskUserQuestion, it
# never touches _decide_event_type, and on ANY shape surprise it returns None
# and logs -- so a Claude Code payload change can degrade the companion feature
# but can NEVER move a dot. Regressing the dots is not an acceptable trade.
#
# Style constraints for this embedded template: no backticks (they break the
# esbuild template literal) and no raw backslashes.


def _post_hook(url, body, timeout):
    # Single place the notify POST is issued, so the (COMPANION-CAPTURE)
    # strip-and-retry path sends a byte-identical request to the original.
    #
    # timeout is chosen by the caller and is never above 1.5s: _deliver shrinks
    # it to whatever is left of the total probe budget, so the last attempt of a
    # sweep cannot push the whole sweep past that budget.
    #
    # (DISPOSE-LIMBO) Returns (status, body) for a 2xx and raises
    # urllib.error.HTTPError for anything else. A host-service route that took
    # the event answers 200 -- and so does one that DROPPED it, with an
    # ignored/reason body on purpose -- so the status alone cannot tell a
    # delivered dot from one the host threw away for a terminal it has no row
    # for, which is what a terminal stuck in dispose limbo produces.
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        try:
            raw = resp.read(2048).decode("utf-8", "replace")
        except Exception as read_exc:
            raw = "<unreadable response: " + str(read_exc) + ">"
        return resp.status, raw[:500]


# --- (HOOK-ENDPOINT-HEAL) ------------------------------------------------
# The host-service can restart onto a NEW port at any time. A PTY started
# before that restart keeps the OLD SUPERSET_HOST_AGENT_HOOK_URL in its env
# forever -- a live process's env cannot be rewritten -- so every notify POST
# from that terminal goes to a dead port and the dot silently stops moving,
# INCLUDING the "Start" that clears a red dot once a question is answered.
# Measured on Windows: a dead loopback port takes ~2040ms to refuse, so the
# symptom in the logs is a 1.5s timeout, not ECONNREFUSED.
#
# Fix: treat the env URL as a hint, not the address. Each org's manifest
# (<root>/host/<orgId>/manifest.json) is rewritten with the live endpoint on
# every host start, so it is never stale. This is the same failover the shell
# template already does (packages/agent-setup/templates/notify-hook.template.sh
# :170-214), ported to Python.


_KERNEL32 = None


def _kernel32():
    # Lazily loaded ONCE per process. Every _manifest_pid_alive call used to
    # re-open kernel32 and re-declare the same two prototypes; the manifest
    # sweep calls it per host, and the load is the expensive part.
    global _KERNEL32
    if _KERNEL32 is None:
        import ctypes

        lib = ctypes.WinDLL("kernel32", use_last_error=True)
        lib.OpenProcess.argtypes = [
            ctypes.c_uint32,
            ctypes.c_int,
            ctypes.c_uint32,
        ]
        lib.OpenProcess.restype = ctypes.c_void_p
        lib.CloseHandle.argtypes = [ctypes.c_void_p]
        _KERNEL32 = lib
    return _KERNEL32


def _manifest_pid_alive(pid):
    # NOTE: distinct from _pid_alive above (the codex-job staleness probe) and
    # deliberately so -- do not collapse the two. That one answers "is this
    # codex worker still working?" and leans toward keeping a dot alive; this
    # one answers "may I POST a payload to the port this manifest names?" and
    # fails OPEN: only a PROVEN-dead pid drops the candidate, and access-denied
    # counts as alive. It also takes the pid as-is (the caller has already
    # type-checked it) instead of coercing.
    #
    # (HOOK-STALE-MANIFEST) Is the host that wrote this manifest still running?
    # A crashed host leaves its manifest behind, and the OS eventually hands
    # that port to an unrelated process -- which would then be POSTed the whole
    # payload, companion question text included. The manifest stamps the
    # writer pid, so a dead pid is a manifest to skip.
    #
    # FAILS OPEN: anything uncertain returns True. Skipping a LIVE host loses a
    # dot; probing a dead one costs a single refused connection.
    #
    # NEVER os.kill(pid, 0) here. On Windows CPython os.kill ignores the signal
    # for everything but the CTRL_*_EVENT constants and calls TerminateProcess,
    # so signal 0 would KILL the process this only means to observe.
    try:
        if sys.platform == "win32":
            import ctypes

            kernel32 = _kernel32()
            # PROCESS_QUERY_LIMITED_INFORMATION (0x1000): the weakest right
            # that still proves existence, granted across integrity levels.
            handle = kernel32.OpenProcess(0x1000, 0, int(pid))
            if handle:
                kernel32.CloseHandle(handle)
                return True
            # 87 = ERROR_INVALID_PARAMETER, which is how Windows reports "no
            # process has that id". Anything else (5 = access denied on a host
            # running elevated or as another user) is a live process this
            # simply cannot open, so it stays a candidate.
            return ctypes.get_last_error() != 87
        os.kill(int(pid), 0)
        return True
    except ProcessLookupError:
        return False
    except Exception:
        return True


def _home_dir_of_transcript(transcript_path):
    # (HOOK-HTTP-DAEMON) The Superset home root of the instance that launched
    # this terminal. SUPERSET_HOME_DIR cannot travel in a header (see
    # _HEADER_FOR_CTX_NAME), and an ADOPTED daemon belongs to another instance
    # whose own root holds none of this terminal's host manifests, so the
    # terminal's transcript is what names the right one: the host-service pins
    # every Claude session it launches to
    # <home>/host/<org>/claude-profiles/<uuid>/projects/. A session that keeps
    # Claude's default config dir has no such path and gets "" instead.
    if not transcript_path:
        return ""
    parts = pathlib.PurePath(transcript_path).parts
    for index in range(len(parts) - 5, 0, -1):
        if (
            parts[index] == "host"
            and parts[index + 2] == "claude-profiles"
            and parts[index + 4] == "projects"
        ):
            return str(pathlib.PurePath(*parts[:index]))
    return ""


def _manifest_candidate_urls(ctx, already_queued):
    # Every host-manifest URL worth trying, THIS terminal's org first and the
    # rest by name, minus anything in already_queued and minus manifests whose
    # writer pid is PROVEN dead. Any per-manifest problem skips that manifest
    # with a log line. Never raises.
    #
    # (HOOK-HTTP-DAEMON) Built at most once per REQUEST and memoized on the
    # ctx: the companion strip-and-retry sweeps the same candidates a second
    # time, and the glob + JSON parse + pid probe is the expensive half of a
    # notify POST. A process-wide memo would pin one terminal's org list onto
    # every later request the daemon serves, and would never see a host that
    # restarted onto a new port.
    #
    # SUPERSET_HOME_DIR scopes the MANIFEST GLOB ONLY, alongside the root the
    # terminal's own transcript names. Every marker path in this
    # script deliberately keeps using pathlib.Path.home(): the host-service reads
    # those markers at a HARDCODED homedir()
    # (packages/host-service/src/trpc/router/notifications/agent-status-snapshot.ts
    # :133-138), so unifying the two roots would write markers where the host
    # never looks and silently break resync. The daemon runs as the same user,
    # so its Path.home() is that same root.
    if ctx.manifest_candidates is not None:
        return ctx.manifest_candidates
    urls = []
    seen_urls = set(already_queued)
    seen_paths = set()
    try:
        # The terminal's OWN instance root first (transcript-derived, so it is
        # right even when an adopted daemon's environment names another
        # instance's), then the root this process runs under.
        roots = []
        for candidate_root in (
            ctx.transcript_home_dir,
            ctx.SUPERSET_HOME_DIR,
        ):
            if candidate_root:
                candidate = pathlib.Path(candidate_root)
                if candidate not in roots:
                    roots.append(candidate)
        if not roots:
            roots.append(pathlib.Path.home() / ".superset")
        manifest_paths = []
        for root in roots:
            host_dir = root / "host"
            # This terminal's OWN host first: env.ts:256-257 stamps the org id on
            # every terminal it launches, so the common case probes one URL and
            # stops. Other orgs' hosts answer "ignored":true -- harmless, but slow.
            org_id = ctx.SUPERSET_ORGANIZATION_ID
            if org_id:
                manifest_paths.append(host_dir / org_id / "manifest.json")
            try:
                manifest_paths.extend(sorted(host_dir.glob("*/manifest.json")))
            except Exception as glob_exc:
                _log({
                    "action": "hook-candidate-glob-failed",
                    "hostDir": str(host_dir),
                    "error": str(glob_exc),
                })
        for manifest_path in manifest_paths:
            # The own-org path is also matched by the glob above. Without this
            # it would be opened, parsed and pid-probed a second time.
            if manifest_path in seen_paths:
                continue
            seen_paths.add(manifest_path)
            try:
                with open(manifest_path, "r", encoding="utf-8") as handle:
                    manifest = json.loads(handle.read(65536))
                if not isinstance(manifest, dict):
                    raise ValueError("manifest is not an object")
                endpoint = manifest.get("endpoint")
                if not isinstance(endpoint, str) or not endpoint:
                    raise ValueError("manifest has no endpoint string")
                candidate = endpoint.rstrip("/") + "/trpc/notifications.hook"
                # Deduped BEFORE the liveness probe: the common case is the env
                # URL naming this terminal's own host, and a URL already queued
                # is going to be POSTed whatever the probe would answer.
                if candidate in seen_urls:
                    continue
                # (HOOK-STALE-MANIFEST) A crashed host's manifest still names a
                # port some unrelated process may now own. Only skip on PROOF
                # the writer is gone: a missing or unusable pid keeps the entry.
                pid = manifest.get("pid")
                if (
                    isinstance(pid, int)
                    and not isinstance(pid, bool)
                    and pid > 0
                    and not _manifest_pid_alive(pid)
                ):
                    _log({
                        "action": "hook-candidate-manifest-dead-pid",
                        "manifest": str(manifest_path),
                        "pid": pid,
                    })
                    continue
                seen_urls.add(candidate)
                urls.append(candidate)
            except Exception as manifest_exc:
                _log({
                    "action": "hook-candidate-manifest-skipped",
                    "manifest": str(manifest_path),
                    "error": str(manifest_exc),
                })
    except Exception as exc:
        _log({"action": "hook-candidates-failed", "error": str(exc)})
    ctx.manifest_candidates = urls
    return urls


class _HookCandidates:
    # Every URL worth trying for one notify POST, best first: the env URL, then
    # THIS terminal's org manifest, then every other org's manifest. Deduped,
    # first position wins.
    #
    # LAZY: the env URL answers on the overwhelming majority of events, so the
    # manifest tail is enumerated only when a SECOND candidate is actually
    # asked for -- an accepted first POST never touches the disk at all.
    # RE-ITERABLE: the companion strip-and-retry sweeps the same candidates
    # again, and the ctx memoizes the tail so the second sweep costs nothing.
    def __init__(self, ctx):
        self._ctx = ctx
        self._env_url = ctx.SUPERSET_HOST_AGENT_HOOK_URL

    def __iter__(self):
        if self._env_url:
            yield self._env_url
        for candidate in _manifest_candidate_urls(
            self._ctx, [self._env_url] if self._env_url else []
        ):
            yield candidate


def _hook_ignored_flag(raw):
    # Tri-state read of ONE response body, the only parse any caller needs:
    #
    #   False -> POSITIVE acceptance by the owning host, which answers
    #            {"result":{"data":{"json":{"success":true,"ignored":false}}}}
    #            (notifications.ts:357). This and only this is delivery -- the
    #            same positive check the sh template makes.
    #   True  -> an EXPLICIT, well-formed disown. ONLY this counts toward
    #            "ignored-everywhere".
    #   None  -> neither: a truncated, empty or malformed body, HTML from a
    #            foreign server that grabbed the recycled port, or the envelope
    #            shape with a non-boolean there. NOT a disown -- nobody who
    #            understands the route answered -- so it stays an undelivered
    #            failure and probing must continue.
    #
    # Never raises. _post_hook truncates the body at 500 chars; the real
    # envelope is ~60, so the only bodies this cannot parse were never answers.
    try:
        flag = json.loads(raw)["result"]["data"]["json"]["ignored"]
    except Exception:
        return None
    return flag if flag is True or flag is False else None


# kind "delivered": url/status/body name the host that took the event.
# kind "ignored-everywhere": url/status are None and body is the last
# well-formed disown envelope.
_HookOutcome = collections.namedtuple(
    "_HookOutcome", ("kind", "url", "status", "body")
)


class _HookUndelivered(RuntimeError):
    # What _deliver raises when nothing accepted the POST.
    #
    # saw_response tells a host that ANSWERED-and-refused -- a 2xx nobody could
    # parse, an outright 4xx from the owning host rejecting the body shape, or
    # a disown sweep carrying an HTTP error -- from a dead port: when NOTHING
    # answered, a stripped-body companion retry cannot answer either, so the
    # caller skips it instead of burning another probe cycle on every
    # candidate.
    def __init__(self, message, saw_response, cause=None):
        super().__init__(message)
        self.saw_response = saw_response
        self.__cause__ = cause

    @classmethod
    def from_sweep(cls, fallback, saw_response, cause):
        # The underlying transport failure's own str() whenever there is one:
        # the post-error log and the companion retry both surface the message
        # verbatim, and a human needs "HTTP Error 400: Bad Request" there, not
        # "no hook endpoint accepted the event".
        return cls(fallback if cause is None else str(cause), saw_response, cause)


def _deliver(candidates, body, tried):
    # POST body to candidates in order until one POSITIVELY accepts it.
    # Returns an _HookOutcome; raises _HookUndelivered on anything else.
    #
    # tried (list, in/out) collects every url actually attempted, in order and
    # deduped across sweeps. candidates is lazy, so this is the only record of
    # what was reached, and the caller logs it.
    #
    # "ignored-everywhere" is a DELIVERED NO-OP and needs at least one
    # candidate to have returned a VALID envelope saying "ignored": true (every
    # reachable host disowns this terminal id; see agent-status-snapshot.ts
    # :41-48 for the ghost-terminal case). A 2xx body that does not parse to
    # that envelope proves the opposite and goes down the raise path, so a
    # foreign server on a recycled port can never be reported as delivery.
    #
    # A disown sweep that ALSO saw an HTTP ERROR status is promoted to a raise
    # here rather than returned: the owning host rejects a bad companion shape
    # with a 400 while a FOREIGN host on the same machine can answer 200
    # "ignored": true in the SAME sweep, so returning a delivered no-op would
    # let the owner's rejection hide behind a stranger and drop the dot with no
    # error anywhere.
    #
    # Bounded by a 4.0s TOTAL probe budget. Each attempt gets
    # min(1.5, remaining), so the per-request cap stays 1.5s AND the whole
    # sweep stays inside the budget -- a machine with several dead hosts
    # cannot stall the agent.
    started = time.monotonic()
    saw_response = False
    last_ignored_body = None
    http_error = None
    last_exc = None
    attempts = 0
    for url in candidates:
        remaining = 4.0 - (time.monotonic() - started)
        if remaining <= 0.0:
            _log({
                "action": "hook-probe-budget-exhausted",
                "elapsedMs": int((time.monotonic() - started) * 1000),
                "triedUrls": tried,
            })
            raise _HookUndelivered.from_sweep(
                "hook probe budget exhausted after "
                + str(attempts)
                + " candidate(s)",
                saw_response,
                last_exc,
            )
        attempts += 1
        if url not in tried:
            tried.append(url)
        try:
            status, raw = _post_hook(url, body, min(1.5, remaining))
        except urllib.error.HTTPError as status_exc:
            # A SERVER ANSWERED, with an error status. urllib turns every
            # non-2xx into this exception, which is the only place the owning
            # host schema rejection of a companion payload can land.
            saw_response = True
            last_exc = status_exc
            http_error = (
                "HTTP " + str(getattr(status_exc, "code", "?")) + " from " + url
            )
            _log({
                "action": "hook-candidate-http-error",
                "url": url,
                "status": getattr(status_exc, "code", None),
            })
            continue
        except Exception as exc:
            last_exc = exc
            continue
        saw_response = True
        ignored = _hook_ignored_flag(raw)
        if ignored is False:
            return _HookOutcome("delivered", url, status, raw)
        if ignored is True:
            last_ignored_body = raw
    if last_ignored_body is not None:
        if http_error:
            # The promotion: a disown sweep that also carries an HTTP error.
            # http_error, not the exception's own str(), is the message --
            # it names the host that refused, which the stranger's 200 hides.
            raise _HookUndelivered(http_error, saw_response, last_exc)
        return _HookOutcome("ignored-everywhere", None, None, last_ignored_body)
    raise _HookUndelivered.from_sweep(
        "no hook endpoint accepted the event ("
        + str(attempts)
        + " candidate(s) tried)",
        saw_response,
        last_exc,
    )


def _companion_stripped_body(payload_json):
    # (COMPANION-CAPTURE) Exactly the pre-companion body -- the dot fields
    # only, in their original order -- so the retry is byte-identical to what
    # this hook sent before the companion capture existed.
    stripped = dict(payload_json)
    stripped.pop("companionQuestion", None)
    stripped.pop("companionQuestionResolved", None)
    stripped.pop("companionLifecycleEventId", None)
    stripped.pop("companionLifecycleOutcome", None)
    return json.dumps({"json": stripped}).encode("utf-8")


def _companion_log(reason, detail):
    # Returns None so callers can "return _companion_log(...)" -- a skipped
    # capture is always logged, never silent.
    try:
        _log({
            "action": "companion-capture-skip",
            "reason": reason,
            "detail": str(detail)[:400],
        })
    except Exception:
        pass
    return None


def _companion_item(index, raw):
    # One tool_input.questions[] entry -> the wire shape. Returns None when the
    # entry is not the documented shape; the caller then drops the WHOLE
    # capture rather than forwarding a partial question.
    if not isinstance(raw, dict):
        return None
    question = raw.get("question")
    if not isinstance(question, str) or not question:
        return None
    # header and description are LABELS, not answer inputs. Absent means the
    # picker shows nothing there, so "" is the faithful representation, not a
    # guess -- and dropping an otherwise-answerable question over a missing
    # cosmetic label would be the worse outcome. Anything the ANSWER depends on
    # (question text, option labels, multiSelect, ordering) is required above.
    header = raw.get("header")
    if header is None:
        header = ""
    if not isinstance(header, str):
        return None
    multi = raw.get("multiSelect")
    if multi is None:
        multi = raw.get("multi_select")
    if multi is None:
        multi = False
    if not isinstance(multi, bool):
        return None
    raw_options = raw.get("options")
    if not isinstance(raw_options, list) or not raw_options:
        return None
    options = []
    for oi, opt in enumerate(raw_options):
        if not isinstance(opt, dict):
            return None
        label = opt.get("label")
        if not isinstance(label, str) or not label:
            return None
        description = opt.get("description")
        if description is None:
            description = ""
        if not isinstance(description, str):
            return None
        options.append({
            "index": oi,
            "label": label,
            "description": description,
        })
    return {
        "index": index,
        "header": header,
        "question": question,
        "multiSelect": multi,
        "options": options,
    }


def _companion_question(payload, event, tool, session_id):
    # Built only for PreToolUse:AskUserQuestion. Every field the bridge needs
    # is required -- no defaults for missing values, because a question the
    # bridge cannot fingerprint or verify is a question it must not let anyone
    # answer from a phone.
    if event != "PreToolUse" or tool != "AskUserQuestion":
        return None
    tool_use_id = str(
        payload.get("tool_use_id") or payload.get("toolUseId") or ""
    ).strip()
    if not tool_use_id:
        return _companion_log("no tool_use_id", sorted(payload.keys()))
    if not session_id:
        return _companion_log("no session_id", tool_use_id)
    transcript_path = str(
        payload.get("transcript_path") or payload.get("transcriptPath") or ""
    ).strip()
    if not transcript_path:
        return _companion_log("no transcript_path", tool_use_id)
    cwd = str(payload.get("cwd") or "").strip()
    if not cwd:
        return _companion_log("no cwd", tool_use_id)
    tool_input = payload.get("tool_input")
    if tool_input is None:
        tool_input = payload.get("toolInput")
    if not isinstance(tool_input, dict):
        return _companion_log("tool_input is not an object", type(tool_input))
    raw_questions = tool_input.get("questions")
    if not isinstance(raw_questions, list) or not raw_questions:
        return _companion_log("tool_input.questions is empty or not a list", tool_use_id)
    items = []
    for index, raw in enumerate(raw_questions):
        item = _companion_item(index, raw)
        if item is None:
            return _companion_log("question " + str(index) + " has an unexpected shape", raw)
        items.append(item)
    agent_id = str(payload.get("agent_id") or payload.get("agentId") or "").strip()
    agent_type = str(payload.get("agent_type") or payload.get("agentType") or "").strip()
    return {
        "toolUseId": tool_use_id,
        "sessionId": session_id,
        "transcriptPath": transcript_path,
        "cwd": cwd,
        "agentId": agent_id or None,
        "agentType": agent_type or None,
        "askedAtMs": int(datetime.datetime.now().timestamp() * 1000),
        "questions": items,
    }


def _companion_resolved(payload, event, tool):
    # The mirror image: an AskUserQuestion that COMPLETED was answered AT THE
    # DESK (or from a device). Without this signal a phone notification for a
    # question the user already handled in front of them is never retracted,
    # which is exactly the "muted within a week" failure the delayed push was
    # designed to avoid.
    if event != "PostToolUse" or tool != "AskUserQuestion":
        return None
    tool_use_id = str(
        payload.get("tool_use_id") or payload.get("toolUseId") or ""
    ).strip()
    if not tool_use_id:
        return _companion_log("resolve without tool_use_id", sorted(payload.keys()))
    return {"toolUseId": tool_use_id}


def handle(payload, ctx):
    # (HOOK-HTTP-DAEMON) One hook event, start to finish, for the terminal ctx
    # names. Returns "accepted" (a host took the event), "no-op" (nothing to
    # deliver, or every reachable host disowned the terminal) or
    # "delivery-failed" (nobody took it). Raises _InvalidRequest on a payload
    # value it refuses to act on; every other failure path is swallowed by the
    # helpers, because a broken hook must never abort the agent.
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
    # array means background work is still running after the turn ended.
    # (TEAM-YELLOW) the typed entries split into agent work (yellow) vs
    # shell-only (blue) — see _split_background. Absent on older versions ->
    # both falsy -> behaves exactly as before. session_crons (scheduled
    # wakeups) are intentionally NOT counted (pending, not running).
    # None-check (not "or"): an EMPTY list is an authoritative "nothing is
    # running" and must reach _running_bg_ids, where "or" would collapse it
    # to the other key's None. _split_background treats [] and None the same.
    bg_tasks = payload.get("background_tasks")
    if bg_tasks is None:
        bg_tasks = payload.get("backgroundTasks")
    # (COMPACT-YELLOW) PreCompact carries trigger ("manual"|"auto");
    # SessionStart carries source ("startup"|"resume"|"clear"|"compact").
    trigger = str(payload.get("trigger") or "").strip()
    source = str(payload.get("source") or "").strip()

    url = ctx.SUPERSET_HOST_AGENT_HOOK_URL
    terminal_id = ctx.SUPERSET_TERMINAL_ID
    agent_id = ctx.SUPERSET_AGENT_ID

    # (TEAMMATE-IDLE) At the turn-end decision points, drop teammate-type
    # entries the transcript proves idle BEFORE any consumer (the split, the
    # agentbg/shellbg/bgactive snapshot, the hold decision) — the harness
    # reports finished teammates as status "running" forever, so without this
    # a lead whose teammates are all done held yellow until the next event
    # (which, on an idle window, never came). bg_ids stays derived from the
    # RAW list: it is a KEEP-set for marker reconciliation, and teammates
    # never create run-dir markers, so extra ids are harmless while missing
    # ids could reap a genuine fork marker.
    transcript_path = str(
        payload.get("transcript_path") or payload.get("transcriptPath") or ""
    ).strip()
    # (HOOK-HTTP-DAEMON) The daemon's cwd is Electron's, not the terminal's, so
    # a relative transcript path would name a different file here than it did
    # for the agent that sent it. Refuse it rather than read the wrong one.
    if transcript_path and not os.path.isabs(transcript_path):
        raise _InvalidRequest(
            "transcript_path is not absolute: " + transcript_path
        )
    ctx.transcript_home_dir = _home_dir_of_transcript(transcript_path)
    if event == "SessionStart" and source in ("startup", "clear"):
        _team_initialize_fresh_cache(transcript_path, terminal_id)
    team_note = []
    bg_tasks_eff = bg_tasks
    if event in ("Stop", "SubagentStop"):
        bg_tasks_eff = _without_idle_teammates(
            bg_tasks, transcript_path, terminal_id, team_note
        )
    has_background, has_agent_background, has_shell_background = _split_background(
        bg_tasks_eff
    )
    # (MARKER-RECONCILE) only a payload that actually carries the list shape
    # is authoritative; absent/odd-shaped -> None -> no reconciliation (an
    # older Claude Code without background_tasks behaves exactly as before).
    bg_ids = _running_bg_ids(bg_tasks) if isinstance(bg_tasks, (list, dict)) else None
    if team_note:
        _log({
            "event": event,
            "terminalId": terminal_id,
            "sessionId": session_id,
            "action": "teammate-idle-drop",
            "note": team_note[0],
        })

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
        return "no-op"

    # (PANE-MAP-UNSTEAL) the ending session's pane mapping must not outlive it
    # on this terminal (see _drop_pane_map_if_ours).
    if event == "SessionEnd":
        _drop_pane_map_if_ours(session_id, terminal_id)

    # Also performs the SubagentStart/Stop marker side-effects, so the
    # yellow-hold state stays consistent even when url is momentarily absent.
    reason_out = []
    event_type = _decide_event_type(
        event,
        tool,
        terminal_id,
        sub_agent_id,
        has_background,
        has_agent_background,
        has_shell_background,
        bg_ids,
        trigger,
        source,
        session_id,
        reason_out,
    )

    # (dot-decisions audit) Always-on, bounded log of WHY the dot resolved the
    # way it did — but only when _decide_event_type recorded a terminal-decision
    # reason (Stop / SubagentStop / StopFailure / manual-compact finish / a
    # permission RED), so every PostToolUse does NOT write a line. Best-effort;
    # never blocks or breaks the POST below.
    if reason_out:
        _decision_log(
            terminal_id,
            session_id,
            event_type,
            reason_out[0] + (team_note[0] if team_note else ""),
        )

    if not url:
        _log({
            "event": event, "tool": tool, "mappedEventType": event_type,
            "terminalId": terminal_id, "sessionId": session_id, "url": url,
            "action": "skip-no-url",
        })
        return "no-op"
    if event_type is None:
        _log({
            "event": event, "tool": tool, "mappedEventType": None,
            "terminalId": terminal_id, "sessionId": session_id, "url": url,
            "agentId": sub_agent_id, "action": "skip-unmapped",
        })
        return "no-op"

    # (COMPANION-LIFECYCLE-ALERTS) Content-free producer identity, FRESH PER HOOK
    # INVOCATION. The lifecycle manager derives the USER-VISIBLE alert id from the
    # armed work cycle and alert kind, so this value is not an alert identity; it
    # is the sink's duplicate-DELIVERY guard, matched against a bounded window of
    # ids it has already applied.
    # It MUST therefore be unique per invocation. A derived seed is not: Claude
    # hook payloads carry no timestamp, and a Stop payload carries no tool_use_id,
    # so every Stop in one session hashed to the SAME id and the host discarded
    # every alert after the first as a duplicate. 16 bytes of os.urandom ->
    # 22 base64url chars, exactly the id shape the receiver validates.
    # The retry below deliberately re-POSTs WITHOUT the companion fields, so that
    # path never re-delivers one of these. Only hook-originated events carry it;
    # administrative status clears never pass through this producer.
    lifecycle_event_id = (
        base64.urlsafe_b64encode(os.urandom(16)).decode("ascii").rstrip("=")
    )
    lifecycle_outcome = None
    if event == "SessionEnd":
        lifecycle_outcome = "session-end"
    elif event == "StopFailure" and not sub_agent_id:
        # sub_agent_id is the sanitized STRING above — empty for the main loop,
        # never None — so this must be a truthiness test.
        # (DEFERRED-FAILURE) a companion hold PARKS the failure instead of
        # announcing it, and the later release posts eventType "Failed". The
        # central red guard can UPGRADE that hold from "SubagentActive" to
        # "Start" (this abort removed the last open question), so both working
        # results mean "held" — otherwise the companion would alert "failed"
        # here AND again at the release instead of exactly once.
        lifecycle_outcome = (
            "hold" if event_type in ("SubagentActive", "Start") else "failed"
        )
    elif event_type == "Failed":
        lifecycle_outcome = "failed"
    elif event_type == "Start":
        lifecycle_outcome = "progress"
    elif event_type == "Stop" and event in ("Stop", "SubagentStop"):
        lifecycle_outcome = "ready"

    # (COMPANION-CAPTURE) additive fields; absent for every event that is not
    # an AskUserQuestion open/close, and absent whenever the payload did not
    # carry the documented shape (see _companion_log).
    payload_json = {
        "terminalId": terminal_id,
        "eventType": event_type,
        "agent": {"agentId": agent_id, "sessionId": session_id},
    }
    if lifecycle_outcome is not None:
        payload_json["companionLifecycleEventId"] = lifecycle_event_id
        payload_json["companionLifecycleOutcome"] = lifecycle_outcome
    companion_question = _companion_question(payload, event, tool, session_id)
    if companion_question is not None:
        payload_json["companionQuestion"] = companion_question
    companion_resolved = _companion_resolved(payload, event, tool)
    if companion_resolved is not None:
        payload_json["companionQuestionResolved"] = companion_resolved

    body = json.dumps({"json": payload_json}).encode("utf-8")
    has_companion = (
        "companionQuestion" in payload_json
        or "companionQuestionResolved" in payload_json
        or "companionLifecycleEventId" in payload_json
    )

    # (HOOK-ENDPOINT-HEAL) Resolved HERE, strictly AFTER _decide_event_type has
    # mutated its markers above: the marker state must survive total delivery
    # failure, so nothing about delivery may run before it.
    #
    # Duplicate delivery is safe. The companion retry below re-sends the SAME
    # companionLifecycleEventId, which the sink dedupes, and dot broadcasts are
    # idempotent -- so re-POSTing to a host that already took the event costs
    # nothing, while a lost event costs a stuck dot.
    candidates = _HookCandidates(ctx)
    # Every url _deliver actually reached, across BOTH sweeps. candidates is
    # lazy, so this list -- not the candidate set -- is what the logs can name.
    tried = []

    outcome = None
    exc = None
    try:
        outcome = _deliver(candidates, body, tried)
    except Exception as deliver_exc:
        exc = deliver_exc

    # (COMPANION-CAPTURE) The dot event must survive a rejected companion
    # payload BYTE-FOR-BYTE -- the companion feature is additive and may never
    # cost a dot. So whenever a SERVER ANSWERED and the event still was not
    # accepted, retry ONCE with exactly the pre-companion body. The rejection
    # is then logged under its own action name: it means the capture shape and
    # the route schema disagree, which is a real bug for a human to fix, not
    # something to paper over.
    #
    # Both ways to land here raise out of _deliver with saw_response set: the
    # owning host rejecting a bad companion shape with a 400, and a disown
    # sweep that also carried an HTTP error (a foreign host answering 200
    # "ignored": true must never mask the owner refusing the body).
    #
    # (HOOK-ENDPOINT-HEAL) When NO candidate responded at all, the body was
    # never read by anyone, so a stripped body cannot fare better -- skip
    # straight to the failure log instead of probing every dead endpoint twice.
    retry_after = None
    if has_companion and isinstance(exc, _HookUndelivered) and exc.saw_response:
        # "or" guards the empty-message exception: retry_after doubles as
        # the "run the retry" flag, so it may never be falsy here.
        retry_after = str(exc) or "a host answered and refused the event"

    if retry_after:
        try:
            retry_outcome = _deliver(
                candidates, _companion_stripped_body(payload_json), tried
            )
            if retry_outcome.kind == "ignored-everywhere":
                _log({
                    "event": event, "tool": tool,
                    "mappedEventType": event_type,
                    "terminalId": terminal_id, "sessionId": session_id,
                    "url": url, "agentId": sub_agent_id,
                    "action": "companion-rejected-dot-ignored-everywhere",
                    "candidateUrls": tried,
                    "responseBody": retry_outcome.body,
                    "error": retry_after,
                })
                return "no-op"
            _log({
                "event": event, "tool": tool,
                "mappedEventType": event_type,
                "terminalId": terminal_id, "sessionId": session_id,
                "url": url, "deliveredUrl": retry_outcome.url,
                "agentId": sub_agent_id, "httpStatus": retry_outcome.status,
                "responseBody": retry_outcome.body,
                "action": "companion-rejected-dot-posted",
                "error": retry_after,
            })
            return "accepted"
        except Exception as retry_exc:
            exc = retry_exc

    if exc is None:
        if outcome.kind == "ignored-everywhere":
            # A DELIVERED NO-OP, not a failure: every reachable host answered a
            # well-formed envelope and every one of them disowned this terminal
            # id (the ghost-terminal case, agent-status-snapshot.ts:41-48).
            # Nothing was lost in transit, so this must NOT look like a
            # transport error -- no post-error line, and no companion
            # strip-and-retry, which would only be ignored again.
            # (DISPOSE-LIMBO) The body carries the reason the host disowned it,
            # which is what tells one ghost-terminal cause from another.
            _log({
                "event": event, "tool": tool, "mappedEventType": event_type,
                "terminalId": terminal_id, "sessionId": session_id, "url": url,
                "agentId": sub_agent_id, "action": "ignored-everywhere",
                "candidateUrls": tried,
                "responseBody": outcome.body,
                "companion": has_companion,
            })
            return "no-op"
        _log({
            "event": event, "tool": tool, "mappedEventType": event_type,
            "terminalId": terminal_id, "sessionId": session_id, "url": url,
            "deliveredUrl": outcome.url,
            "agentId": sub_agent_id, "httpStatus": outcome.status,
            "action": "posted",
            "responseBody": outcome.body,
            "companion": has_companion,
        })
        return "accepted"

    _log({
        "event": event, "tool": tool, "mappedEventType": event_type,
        "terminalId": terminal_id, "sessionId": session_id, "url": url,
        "agentId": sub_agent_id, "error": str(exc), "action": "post-error",
        "candidateUrls": tried,
        "companion": has_companion,
    })
    # (HOOK-ENDPOINT-HEAL) _log is debug-gated and _decision_log is not, so
    # a dot lost to delivery is otherwise invisible in a default install.
    # Name every endpoint that was tried: that list is what tells a stale
    # env URL apart from a host that is simply not running.
    _decision_log(
        terminal_id,
        session_id,
        event_type,
        "hook-post-failed candidates=" + ",".join(tried)
        + " error=" + str(exc),
    )
    return "delivery-failed"


# --- (HOOK-HTTP-DAEMON) supervised daemon mode ---------------------------
# Delivery is NOT durable and is not claimed to be: an event that arrives
# while the daemon is down or restarting is lost, exactly as a failed command
# hook was. Recovery is unchanged -- the host's 60s agent-status resync and
# the marker self-heal rebuild the dots -- and every non-2xx answer here is
# non-blocking for Claude, so a lost event never stalls an agent.

_HOOK_PATH = "/superset-notify/hook"
_HEALTH_PATH = "/superset-notify/health"
_SECRET_HEADER = "x-superset-notify-secret"
_HEADER_FOR_CTX_NAME = {
${NOTIFY_HOOK_PYTHON_HEADER_MAP}
}
# SUPERSET_HOME_DIR does NOT travel in a header: Claude interpolates it into one
# and its sender throws ERR_INVALID_CHAR before the request leaves when a header
# value holds a code point above U+00FF, which a Windows profile path can. The
# daemon reads it from its OWN environment, once, in _serve -- and because an
# ADOPTED daemon's own environment is another instance's, the manifest glob also
# takes the root the terminal's transcript names (_home_dir_of_transcript).
_DAEMON_HOME_DIR = ""
_ALLOWED_SUPERSET_HEADERS = frozenset(
    [_SECRET_HEADER] + list(_HEADER_FOR_CTX_NAME.values())
)
# Claude sends the same hook input it wrote to stdin, and tool_input/tool_response
# carry whole file contents: the largest single tool result in this machine's own
# transcripts is 478KB, and the stdin path had no limit at all. The cap is an
# abuse ceiling, not a filter -- refusing a real event loses it for good.
_MAX_BODY_BYTES = 8388608
_CHUNK_LINE_LIMIT = 8192
_DRAIN_LIMIT_BYTES = 2 * _MAX_BODY_BYTES
# A caller that has not proven the secret gets its status line, not a read of
# whatever it feels like sending: one socket buffer's worth is drained, more is
# refused unread and answered with a close the client may see as an RST.
_UNAUTH_DRAIN_LIMIT_BYTES = 65536
# socketserver puts this on the request socket. Without it a client that sends a
# Content-Length and then stalls parks a handler thread for the life of the
# daemon, and ThreadingHTTPServer caps neither threads nor connections.
_REQUEST_TIMEOUT_SECONDS = 10.0
_WORKER_COUNT = 4
_WORKER_MAX = 16
_QUEUE_DEPTH = 64
# Under the hook timeout Claude registered: past that it has closed the socket,
# and a response written into it is an error with nowhere to go.
_JOB_WAIT_SECONDS = ${NOTIFY_HOOK_TIMEOUT_SECONDS - 1}.0
_ID_MAX_LENGTH = 200
_ID_CHARS = frozenset(
    "abcdefghijklmnopqrstuvwxyz"
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    "0123456789-_"
)
_LOOPBACK_HOSTS = ("127.0.0.1", "localhost", "::1")


class _Unauthorized(Exception):
    pass


class _NotFound(Exception):
    pass


class _TooLarge(Exception):
    pass


def _valid_identifier(value):
    # Terminal/agent/org ids land in marker PATH SEGMENTS (_subagent_dir and
    # friends), so a separator or a dot-dot here would escape the marker root.
    return len(value) <= _ID_MAX_LENGTH and not set(value) - _ID_CHARS


def _valid_hook_url(value):
    if len(value) > 2048:
        return False
    # urlsplit is lazy: scheme parses eagerly, but host and port are properties
    # that raise on a malformed authority, so they are read inside the guard.
    try:
        parsed = urllib.parse.urlsplit(value)
        port = parsed.port
        host = parsed.hostname
    except ValueError:
        return False
    if parsed.scheme != "http" or port is None:
        return False
    return host in _LOOPBACK_HOSTS


def _ctx_from_headers(headers):
    for name in headers.keys():
        lowered = name.lower()
        if (
            lowered.startswith("x-superset-")
            and lowered not in _ALLOWED_SUPERSET_HEADERS
        ):
            raise _InvalidRequest("unexpected header " + lowered)
    values = {}
    for name, header in _HEADER_FOR_CTX_NAME.items():
        present = headers.get_all(header) or []
        if len(present) > 1:
            raise _InvalidRequest("duplicate header " + header)
        value = present[0].strip() if present else ""
        # Claude interpolates "$VAR" for every name in allowedEnvVars; an
        # UNSET variable is the one case that can come back uninterpolated,
        # and it means exactly "not set".
        if value == "$" + name:
            value = ""
        values[name] = value
    for name in (
        "SUPERSET_TERMINAL_ID",
        "SUPERSET_AGENT_ID",
        "SUPERSET_ORGANIZATION_ID",
    ):
        if values[name] and not _valid_identifier(values[name]):
            raise _InvalidRequest("invalid " + name + ": " + values[name])
    hook_url = values["SUPERSET_HOST_AGENT_HOOK_URL"]
    if hook_url and not _valid_hook_url(hook_url):
        raise _InvalidRequest("invalid SUPERSET_HOST_AGENT_HOOK_URL")
    values["SUPERSET_HOME_DIR"] = _DAEMON_HOME_DIR
    if values["SUPERSET_AGENT_WATCHER_DEBUG"] not in ("0", "1"):
        values["SUPERSET_AGENT_WATCHER_DEBUG"] = ""
    return _Ctx(values)


class _Job(object):
    __slots__ = ("payload", "ctx", "done", "outcome", "error")

    def __init__(self, payload, ctx):
        self.payload = payload
        self.ctx = ctx
        self.done = threading.Event()
        self.outcome = None
        self.error = None


class _Dispatcher(object):
    def __init__(self, worker_count, max_workers, queue_depth):
        self._queue_depth = queue_depth
        self._max_workers = max_workers
        self._lock = threading.Lock()
        self._queues = {}
        self._ready = collections.deque()
        self._busy = set()
        self._wake = threading.Semaphore(0)
        self._workers = 0
        self._idle = 0
        for _index in range(worker_count):
            self._start_worker()

    def _start_worker(self):
        self._workers += 1
        threading.Thread(
            target=self._work,
            name="notify-worker-" + str(self._workers),
            daemon=True,
        ).start()

    def submit(self, job):
        key = job.ctx.SUPERSET_TERMINAL_ID
        with self._lock:
            queue = self._queues.get(key)
            if queue is None:
                queue = collections.deque()
                self._queues[key] = queue
            if len(queue) >= self._queue_depth:
                return False
            queue.append(job)
            if key not in self._busy and key not in self._ready:
                self._ready.append(key)
                self._wake.release()
                if (
                    len(self._ready) > self._idle
                    and self._workers < self._max_workers
                ):
                    self._start_worker()
        return True

    def _work(self):
        while True:
            with self._lock:
                self._idle += 1
            self._wake.acquire()
            with self._lock:
                self._idle -= 1
                key = self._ready.popleft()
                self._busy.add(key)
                job = self._queues[key].popleft()
            try:
                _CURRENT.ctx = job.ctx
                job.outcome = handle(job.payload, job.ctx)
            except Exception as error:
                job.error = error
            finally:
                _CURRENT.ctx = None
                job.done.set()
                with self._lock:
                    self._busy.discard(key)
                    if self._queues[key]:
                        self._ready.append(key)
                        self._wake.release()
                    else:
                        del self._queues[key]


def _daemon_classes():
    # (HOOK-HTTP-DAEMON) Imported HERE, not at module scope: hmac (through
    # hashlib and OpenSSL) plus http.server cost ~800ms of interpreter start on
    # Windows ARM64, which the per-event CLI path would pay on every hook.
    import hmac
    import http.server

    class _NotifyHandler(http.server.BaseHTTPRequestHandler):
        server_version = "SupersetNotify"
        sys_version = ""
        timeout = _REQUEST_TIMEOUT_SECONDS

        def log_request(self, code="-", size="-"):
            # A line per response is what grew the old hook log to 508MB.
            pass

        def log_message(self, fmt, *args):
            _log({"action": "daemon-http", "message": fmt % args})

        def _respond(self, status, body=b""):
            self.close_connection = True
            try:
                self.send_response(status)
                self.send_header("Connection", "close")
                if status != 204:
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                if status != 204 and body:
                    self.wfile.write(body)
            except OSError as exc:
                # A client that gave up and closed is how a slow request ends, and
                # socketserver answers an escaping OSError with a full traceback.
                _log({
                    "action": "daemon-client-gone",
                    "status": status,
                    "error": type(exc).__name__ + ": " + str(exc),
                })

        def _authorize(self):
            present = self.headers.get_all(_SECRET_HEADER) or []
            if len(present) != 1:
                raise _Unauthorized()
            offered = present[0].strip().encode("utf-8", "replace")
            if not hmac.compare_digest(offered, self.server.secret_bytes):
                raise _Unauthorized()

        def _content_length(self):
            raw = self.headers.get("Content-Length")
            if raw is None:
                raise _InvalidRequest("no Content-Length")
            try:
                length = int(raw)
            except ValueError:
                raise _InvalidRequest("Content-Length is not an integer: " + raw)
            if length < 0:
                raise _InvalidRequest("negative Content-Length: " + raw)
            return length

        def _is_chunked(self):
            raw = self.headers.get("Transfer-Encoding")
            if raw is None:
                return False
            encoding = raw.strip().lower()
            if encoding != "chunked":
                raise _InvalidRequest("unsupported Transfer-Encoding: " + raw)
            return True

        def _read_chunked(self):
            # A client is free to stream the body instead of measuring it, and
            # http.server decodes no framing of its own.
            data = bytearray()
            while True:
                line = self.rfile.readline(_CHUNK_LINE_LIMIT + 1)
                if not line:
                    raise _InvalidRequest("chunked body ended early")
                try:
                    size = int(line.split(b";", 1)[0].strip(), 16)
                except ValueError:
                    raise _InvalidRequest("bad chunk size: " + repr(line[:32]))
                if size < 0:
                    raise _InvalidRequest("negative chunk size")
                if size == 0:
                    break
                if len(data) + size > _MAX_BODY_BYTES:
                    raise _TooLarge(str(len(data) + size) + " bytes")
                chunk = self.rfile.read(size)
                if len(chunk) != size:
                    raise _InvalidRequest("chunk shorter than its size")
                data += chunk
                if self.rfile.read(2) != b"\\r\\n":
                    raise _InvalidRequest("chunk not terminated by CRLF")
            while True:
                trailer = self.rfile.readline(_CHUNK_LINE_LIMIT + 1)
                if not trailer or trailer in (b"\\r\\n", b"\\n"):
                    break
            return bytes(data)

        def _json_object(self, data):
            try:
                text = data.decode("utf-8")
            except UnicodeDecodeError as exc:
                raise _InvalidRequest("body is not UTF-8: " + str(exc))
            try:
                payload = json.loads(text)
            except ValueError as exc:
                raise _InvalidRequest("body is not JSON: " + str(exc))
            if not isinstance(payload, dict):
                raise _InvalidRequest("body is not a JSON object")
            return payload

        def _drain(self, length, limit=_DRAIN_LIMIT_BYTES):
            # An unread request body makes Windows answer our close with an RST,
            # which throws away the status line the client came for. Only ever
            # called for a body nothing has read yet: rfile.read blocks for the
            # bytes it asks for, and a client waiting on our response will not
            # send them or close, so draining an already-read body would hang.
            # The socket timeout bounds the wait for a body a client announced
            # and never finished sending.
            if length <= 0 or length > limit:
                self.close_connection = True
                return
            try:
                remaining = length
                while remaining > 0:
                    chunk = self.rfile.read(min(remaining, 65536))
                    if not chunk:
                        return
                    remaining -= len(chunk)
            except Exception:
                self.close_connection = True

        def do_GET(self):
            if self.path != _HEALTH_PATH:
                self._respond(404)
                return
            try:
                self._authorize()
            except _Unauthorized:
                self._respond(401)
                return
            self._respond(
                200,
                json.dumps({
                    "ok": True,
                    "pid": os.getpid(),
                    "served": self.server.served_count(),
                }).encode("utf-8"),
            )

        def do_POST(self):
            length = -1
            consumed = False
            try:
                chunked = self._is_chunked()
                if not chunked:
                    length = self._content_length()
                if self.path != _HOOK_PATH:
                    raise _NotFound(self.path)
                self._authorize()
                if length > _MAX_BODY_BYTES:
                    raise _TooLarge(str(length) + " bytes")
                data = self._read_chunked() if chunked else self.rfile.read(length)
                consumed = True
                if not chunked and len(data) != length:
                    raise _InvalidRequest("body shorter than Content-Length")
                ctx = _ctx_from_headers(self.headers)
                payload = self._json_object(data)
            except _NotFound:
                self._drain(length, _UNAUTH_DRAIN_LIMIT_BYTES)
                self._respond(404)
                return
            except _Unauthorized:
                self._drain(length, _UNAUTH_DRAIN_LIMIT_BYTES)
                self._respond(401)
                return
            except _TooLarge as too_large:
                _log({"action": "daemon-body-too-large", "error": str(too_large)})
                self._drain(length)
                self._respond(413)
                return
            except _InvalidRequest as invalid:
                _log({"action": "daemon-bad-request", "error": str(invalid)})
                if not consumed:
                    self._drain(length)
                self._respond(400)
                return
            job = _Job(payload, ctx)
            if not self.server.dispatcher.submit(job):
                _log({
                    "action": "daemon-queue-full",
                    "terminalId": ctx.SUPERSET_TERMINAL_ID,
                })
                self._respond(503)
                return
            # Answers the supervisor's only question: is Claude POSTing at all?
            self.server.note_served()
            if not job.done.wait(_JOB_WAIT_SECONDS):
                _log({
                    "action": "daemon-job-timeout",
                    "terminalId": ctx.SUPERSET_TERMINAL_ID,
                })
                self._respond(500)
                return
            if job.error is not None:
                invalid = isinstance(job.error, _InvalidRequest)
                _log({
                    "action": "daemon-bad-request" if invalid else "daemon-job-error",
                    "terminalId": ctx.SUPERSET_TERMINAL_ID,
                    "error": type(job.error).__name__ + ": " + str(job.error),
                })
                self._respond(400 if invalid else 500)
                return
            if job.outcome == "delivery-failed":
                self._respond(502)
                return
            self._respond(204)

    class _NotifyServer(http.server.ThreadingHTTPServer):
        # socketserver listens with a backlog of 5, and Windows REFUSES the
        # sixth simultaneous connection outright instead of making it wait, so
        # a burst of terminals would lose hooks at the accept queue.
        request_queue_size = 64

        def note_served(self):
            with self.served_lock:
                self.served += 1

        def served_count(self):
            with self.served_lock:
                return self.served

        # allow_reuse_address is TRUE on http.server's HTTPServer, and on Windows
        # SO_REUSEADDR lets a second socket bind a port that is already LISTENING:
        # two daemons would split the hook traffic and race each other's markers.
        # On POSIX it only relaxes TIME_WAIT, which a relaunch within a minute of
        # a served request needs to bind at all.
        allow_reuse_address = os.name != "nt"
        daemon_threads = True

    return _NotifyHandler, _NotifyServer


def _exit_when_parent_closes_stdin(server):
    # Electron kills the daemon on quit, but a crashed or force-killed Electron
    # cannot. Its end of our stdin pipe closes either way, and that EOF is the
    # only parent-death signal that survives a hard kill on Windows.
    def watch():
        try:
            sys.stdin.buffer.read(1)
        except Exception:
            pass
        server.shutdown()

    threading.Thread(target=watch, name="notify-parent-watch", daemon=True).start()


def _serve(args):
    if len(args) != 3 or args[1] != "--secret-file":
        sys.stderr.write(
            "usage: superset-notify.py --serve <port> --secret-file <path>\\n"
        )
        return 2
    try:
        port = int(args[0])
    except ValueError:
        sys.stderr.write("port is not an integer: " + args[0] + "\\n")
        return 2
    if port < 1 or port > 65535:
        sys.stderr.write("port out of range: " + args[0] + "\\n")
        return 2
    try:
        with open(args[2], "r", encoding="utf-8") as handle_:
            secret = handle_.read().strip()
    except OSError as exc:
        sys.stderr.write("cannot read secret file: " + str(exc) + "\\n")
        return 2
    if not secret:
        sys.stderr.write("secret file is empty: " + args[2] + "\\n")
        return 2
    global _DAEMON_HOME_DIR
    daemon_home_dir = os.environ.get("SUPERSET_HOME_DIR", "").strip()
    if daemon_home_dir and not os.path.isabs(daemon_home_dir):
        sys.stderr.write(
            "SUPERSET_HOME_DIR is not absolute: " + daemon_home_dir + "\\n"
        )
        return 2
    _DAEMON_HOME_DIR = daemon_home_dir
    handler_class, server_class = _daemon_classes()
    try:
        server = server_class(("127.0.0.1", port), handler_class)
    except OSError as exc:
        sys.stderr.write(
            "cannot bind 127.0.0.1:" + str(port) + ": " + str(exc) + "\\n"
        )
        return 3
    server.secret_bytes = secret.encode("utf-8")
    server.served_lock = threading.Lock()
    server.served = 0
    server.dispatcher = _Dispatcher(_WORKER_COUNT, _WORKER_MAX, _QUEUE_DEPTH)
    _exit_when_parent_closes_stdin(server)
    sys.stderr.write("listening on 127.0.0.1:" + str(port) + "\\n")
    sys.stderr.flush()
    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        server.server_close()
    return 0


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--serve":
        return _serve(sys.argv[2:])
    ctx = _ctx_from_environ()
    _CURRENT.ctx = ctx
    payload = _read_payload()
    try:
        handle(payload, ctx)
    except _InvalidRequest as invalid:
        _log({"action": "invalid-request", "error": str(invalid)})
    return 0


if __name__ == "__main__":
    # Only a failing exit raises SystemExit: the CLI hook path is also run
    # under runpy by the cache-serialization test, whose wrapper has work to do
    # after main() returns.
    _exit_code = main()
    if _exit_code:
        sys.exit(_exit_code)
`;

function escapeForJsonString(p: string): string {
	return p.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * (HOOK-HTTP-DAEMON) The absolute interpreter, isolated (`-I`) and without
 * site (`-S`). `uv run python` is the fallback for a machine where no python
 * on PATH would actually execute.
 */
function pythonInvocation(pythonPath: string | null): string {
	return pythonPath
		? `"${escapeForJsonString(pythonPath)}" -I -S`
		: "uv run python";
}

/** Hook command embedded in Claude's settings.json / Codex's hooks.json. */
function hookCommand(pythonPath: string | null): string {
	return `${pythonInvocation(pythonPath)} "${escapeForJsonString(SCRIPT_PATH)}"`;
}

/** Hook command for the Claude agent-status notify script (Claude only). */
function notifyHookCommand(pythonPath: string | null): string {
	return `${pythonInvocation(pythonPath)} "${escapeForJsonString(NOTIFY_SCRIPT_PATH)}"`;
}

export type CommandTransport = { kind: "command"; pythonPath: string | null };
export type NotifyTransport =
	| CommandTransport
	| { kind: "http"; port: number; secret: string };

type HookSpec =
	| { type: "command"; command: string }
	| {
			type: "http";
			url: string;
			timeout: number;
			headers: Record<string, string>;
			allowedEnvVars: string[];
	  };
export interface HookEntry {
	matcher?: string;
	hooks?: HookSpec[];
}
interface HooksRoot {
	hooks?: Record<string, HookEntry[]>;
	[k: string]: unknown;
}

function notifyHookSpec(notify: NotifyTransport): HookSpec {
	if (notify.kind === "command") {
		return { type: "command", command: notifyHookCommand(notify.pythonPath) };
	}
	const headers: Record<string, string> = {
		[NOTIFY_SECRET_HEADER]: notify.secret,
	};
	for (const name of NOTIFY_HOOK_ENV_VARS) {
		headers[notifyHeaderForEnvVar(name)] = `$${name}`;
	}
	return {
		type: "http",
		url: notifyHookUrl(notify.port),
		timeout: NOTIFY_HOOK_TIMEOUT_SECONDS,
		headers,
		allowedEnvVars: [...NOTIFY_HOOK_ENV_VARS],
	};
}

function hookSpecCommand(spec: unknown): string {
	if (typeof spec !== "object" || spec === null) return "";
	const command = (spec as { command?: unknown }).command;
	return typeof command === "string" ? command : "";
}

function isPaneMapHook(spec: unknown): boolean {
	return hookSpecCommand(spec).includes(SCRIPT_FILENAME);
}

function isAskMarkerHook(spec: unknown): boolean {
	return hookSpecCommand(spec).includes(ASK_MARKER_SCRIPT_FILENAME);
}

/**
 * Ours, in either transport: the command form names the script file, the
 * daemon form names our own URL path. Matching the path — never a bare
 * `/hook` on loopback — is what keeps this from adopting some other tool's
 * localhost hook as ours and deleting it on the next merge.
 */
function isNotifyHook(spec: unknown): boolean {
	return (
		hookSpecCommand(spec).includes(NOTIFY_SCRIPT_FILENAME) ||
		isNotifyDaemonHook(spec)
	);
}

/** Ours, in the daemon transport only. */
function isNotifyDaemonHook(spec: unknown): boolean {
	if (typeof spec !== "object" || spec === null) return false;
	const url = (spec as { url?: unknown }).url;
	return typeof url === "string" && url.includes(NOTIFY_HOOK_URL_PATH);
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
		console.warn("[pane-map-hook] failed to write pane-map script:", error);
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
		console.warn("[pane-map-hook] failed to write notify script:", error);
		return false;
	}
}

/**
 * Read → mutate in memory → write. A file that is not JSON, or not an object,
 * is left exactly as its owner wrote it rather than stomped, and no failure
 * here aborts startup.
 *
 * (HOOK-HTTP-DAEMON) The write lands through a rename, so an agent reading
 * the file while the transport changes sees the old contents or the new
 * one, never a truncated middle. `mode` is owner-only for a file that ends up
 * holding the daemon secret.
 */
function mergedHookFile(
	filePath: string,
	existing: string | null,
	rewrite: (root: HooksRoot) => void,
): { merged: string; changed: boolean } | null {
	let parsed: HooksRoot = {};
	if (existing !== null) {
		let candidate: unknown;
		try {
			candidate = JSON.parse(existing);
		} catch (error) {
			console.warn(
				`[pane-map-hook] could not parse ${filePath}; skipping merge:`,
				error,
			);
			return null;
		}
		if (typeof candidate !== "object" || candidate === null) return null;
		parsed = candidate as HooksRoot;
	}
	rewrite(parsed);
	const merged = JSON.stringify(parsed, null, 2);
	return { changed: merged !== existing, merged };
}

/**
 * The one synchronous rewrite left, and it is reached ONLY from the process
 * `exit` handler, which has no tick left to await — every other caller goes
 * through `rewriteHookFileAsync`, so nothing on the boot path blocks the main
 * thread here any more.
 *
 * It restores entries in a file that is already there and never mints one,
 * which is why it needs no separate existence probe: an absent hook file
 * carries no daemon entries to restore. The atomic `.pending` swap stays —
 * a torn `~/.claude/settings.json` would cost the user every hook they have,
 * and at exit there is no async rename to swap it for.
 */
function rewriteHookFileSync(
	filePath: string,
	rewrite: (root: HooksRoot) => void,
	mode?: number,
): void {
	try {
		let existing: string;
		try {
			existing = fs.readFileSync(filePath, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				console.warn(
					`[pane-map-hook] could not read ${filePath}; skipping merge:`,
					error,
				);
			}
			return;
		}

		const outcome = mergedHookFile(filePath, existing, rewrite);
		if (!outcome) return;
		if (!outcome.changed) {
			if (mode !== undefined) fs.chmodSync(filePath, mode);
			return;
		}
		const pending = `${filePath}.pending`;
		fs.writeFileSync(pending, outcome.merged, { mode });
		if (mode !== undefined) fs.chmodSync(pending, mode);
		fs.renameSync(pending, filePath);
	} catch (error) {
		console.warn(
			`[pane-map-hook] failed to merge hooks into ${filePath}:`,
			error,
		);
	}
}

// (HOOK-HTTP-DAEMON) The profile mirror walks every Claude profile on the
// machine, so it runs off the main thread's synchronous path.
async function rewriteHookFileAsync(
	filePath: string,
	rewrite: (root: HooksRoot) => void,
	mode?: number,
): Promise<boolean> {
	try {
		const existing = await fs.promises
			.readFile(filePath, "utf8")
			.catch((error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT") return null;
				throw error;
			});

		const outcome = mergedHookFile(filePath, existing, rewrite);
		if (!outcome) return false;
		if (!outcome.changed) {
			if (mode !== undefined) await fs.promises.chmod(filePath, mode);
			return true;
		}
		await fs.promises
			.mkdir(path.dirname(filePath), { recursive: true })
			.catch(() => {
				// best effort
			});
		const pending = `${filePath}.pending`;
		await fs.promises.writeFile(pending, outcome.merged, { mode });
		if (mode !== undefined) await fs.promises.chmod(pending, mode);
		await fs.promises.rename(pending, filePath);
		return true;
	} catch (error) {
		console.warn(
			`[pane-map-hook] failed to merge hooks into ${filePath}:`,
			error,
		);
		return false;
	}
}

/**
 * Every entry with our own hook specs dropped out of it: co-located hooks that
 * are not ours stay where they are, and an entry left with nothing goes. What
 * makes a re-merge replace rather than append.
 */
function withoutOurSpecs(
	entries: HookEntry[],
	isOurs: (spec: unknown) => boolean,
): HookEntry[] {
	const cleaned: HookEntry[] = [];
	for (const entry of entries) {
		const innerHooks = Array.isArray(entry.hooks) ? entry.hooks : [];
		const keptHooks = innerHooks.filter((spec) => !isOurs(spec));
		if (keptHooks.length === innerHooks.length) {
			cleaned.push(entry);
		} else if (keptHooks.length > 0) {
			cleaned.push({ ...entry, hooks: keptHooks });
		}
	}
	return cleaned;
}

function withPaneMapHook(
	hooks: Record<string, HookEntry[]>,
	pythonPath: string | null,
): Record<string, HookEntry[]> {
	const entries = withoutOurSpecs(
		Array.isArray(hooks.SessionStart) ? hooks.SessionStart : [],
		isPaneMapHook,
	);
	entries.push({
		hooks: [{ type: "command", command: hookCommand(pythonPath) }],
	});
	hooks.SessionStart = entries;
	return hooks;
}

/** Event -> optional matcher. Each is a SEPARATE entry under its event. */
const NOTIFY_REGISTRATIONS: Array<{ event: string; matcher?: string }> = [
	{ event: "UserPromptSubmit" },
	{ event: "Stop" },
	{ event: "SessionEnd" },
	{ event: "Notification", matcher: "permission_prompt" },
	{ event: "PreToolUse", matcher: "AskUserQuestion" },
	{ event: "PostToolUse" },
	// (CLAUDE-WORKING-UNHOOKED) own PostToolUseFailure too — notify.sh no longer
	// raw-posts it (its host mapping -> Start bypassed the central red guard).
	// _decide_event_type rewrites it to PostToolUse so a failed tool is guarded
	// identically to a successful one (never stomps a pending AskUserQuestion red).
	{ event: "PostToolUseFailure" },
	// Background-subagent yellow-hold: keep the parent terminal working
	// (yellow) while delegated subagents run after the main turn's Stop,
	// and green only once the last one finishes. See _decide_event_type.
	{ event: "SubagentStart" },
	{ event: "SubagentStop" },
	{ event: "StopFailure" }, // rate-limit/API-error abort: main-loop -> green; subagent-scoped (agent_id) -> self-scoped (STOPFAIL-SUBAGENT)
	// (COMPACT-YELLOW) Context compaction shows working/yellow. PreCompact
	// (manual /compact AND auto-compact) flips the dot to working at
	// compaction start; SessionStart with source=compact fires at completion
	// (manual -> green via the same decision as Stop, auto -> stay yellow,
	// the live turn's Stop greens it later). See _decide_event_type.
	{ event: "PreCompact" },
	// (UNTAGGED-BG-RED) Unscoped (NOT matcher:"compact"): _decide_event_type's
	// SessionStart branch clears the per-owner .askq dir on a NON-compact
	// SessionStart (startup/resume/clear) so a stale question guard from a
	// crashed/reused session can't pin the dot; the compact source still runs
	// the COMPACT-YELLOW finish logic. (Binding/Attached stays the passthrough's
	// job — this hook returns None for non-compact, so it only does the cleanup.)
	{ event: "SessionStart" },
];

/**
 * Register the Claude agent-status notify script across the lifecycle hook
 * events in Claude's settings.json. Each event is cleaned of prior notify
 * entries (idempotent) then gets a fresh entry appended. The notify hook owns
 * Claude working/review/permission — including the AskUserQuestion red, via the
 * PreToolUse:AskUserQuestion entry (with an unscoped PostToolUse re-asserting
 * working on any tool completion) — so the ask-marker hook is no longer
 * registered for Claude. Claude-only: never merged into Codex.
 *
 * (HOOK-HTTP-DAEMON) The whole rewrite of Claude's `hooks` map, in memory:
 * `notify` decides the transport for all twelve entries at once, and every
 * co-located hook that is not ours stays where it was. Both transports are
 * recognised by isNotifyHook, so a downgrade cleans the daemon entries and an
 * upgrade cleans the command entries. Mutates and returns the map it is given.
 *
 * A null `notify` is the no-transport case — the notify script is not on disk,
 * so nothing may be registered. It strips the daemon entries a crashed run left
 * behind, because a loopback port nothing serves loses every event aimed at it,
 * and keeps the command entries, whose script is still there and still works.
 */
export function withNotifyHooks(
	hooks: Record<string, HookEntry[]>,
	notify: NotifyTransport | null,
): Record<string, HookEntry[]> {
	for (const { event, matcher } of NOTIFY_REGISTRATIONS) {
		const existing = Array.isArray(hooks[event])
			? (hooks[event] as HookEntry[])
			: [];
		if (!notify) {
			if (existing.length > 0) {
				const kept = withoutOurSpecs(existing, isNotifyDaemonHook);
				if (kept.length > 0) hooks[event] = kept;
				else delete hooks[event];
			}
			continue;
		}
		// The stale ask-marker hook from a prior build counts as ours too:
		// superset-notify.py owns the AskUserQuestion red now, and that hook
		// only wrote a marker nothing reads anymore.
		const cleaned = withoutOurSpecs(
			existing,
			(spec) => isNotifyHook(spec) || isAskMarkerHook(spec),
		);
		cleaned.push({
			...(matcher ? { matcher } : {}),
			hooks: [notifyHookSpec(notify)],
		});
		hooks[event] = cleaned;
	}
	return hooks;
}

/**
 * (HOOK-HTTP-DAEMON) The http entries carry the daemon secret as a literal
 * header value, because Claude's http hook sends headers and nothing else.
 * Owner-only is as far as this reaches: the host-service copies this file into
 * each Claude profile with the mode it finds here, but agent-setup's managed-hook
 * pass then chmods those copies back to 0644 on POSIX. Same-user loopback is the
 * accepted trust boundary for the secret.
 */
function hookFileMode(notify: NotifyTransport | null): number | undefined {
	return notify?.kind === "http" ? 0o600 : undefined;
}

let hooksRegistered = false;

/**
 * Install the pane-map script and register it as a SessionStart hook in
 * Claude's and Codex's hook config files. Idempotent — calling on every
 * app launch is safe.
 *
 * (HOOK-HTTP-DAEMON) Two passes. The first is the per-event command
 * registration, so a session starting in the next moment has a working hook.
 * The second swaps in daemon POSTs once the daemon is healthy, and reverts to
 * the command transport if the daemon dies for good or Claude never POSTs to it.
 * Both wait while another Superset instance is serving the daemon this home's
 * hook entries point at, and run once that instance exits.
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
	if (hooksRegistered) return;
	hooksRegistered = true;
	void registerHooks(notifyOk).catch((error) =>
		console.warn("[pane-map-hook] hook registration failed:", error),
	);
}

async function registerHooks(notifyOk: boolean): Promise<void> {
	// (HOOK-HTTP-DAEMON) Two instances sharing a home can both find the port
	// free -- the second looks while the first is still mid-handshake -- and the
	// one that loses the bind has to go back to waiting the winner out rather
	// than rewrite the registration the winner is serving. One token covers the
	// whole run, including the writes an adoption wait that is still returning
	// leads to, which a token sampled after it cannot see.
	const token = notifyDaemonRunToken();
	const cancelled = (): boolean => token !== notifyDaemonRunToken();
	for (;;) {
		if (cancelled()) return;
		if (!(await waitOutAnotherInstancesDaemon())) return;
		if (cancelled()) return;
		await mergeAllHooks(
			null,
			notifyOk ? { kind: "command", pythonPath: null } : null,
		);
		if (cancelled()) return;
		if (
			(await upgradeHooksToDaemon(notifyOk, token)) !== "port-owned-elsewhere"
		) {
			return;
		}
	}
}

/**
 * (HOOK-HTTP-DAEMON) False when this instance must leave the shared hook
 * registration exactly where it is: THIS instance is quitting, and the other
 * one is still serving the daemon those entries point at.
 */
async function waitOutAnotherInstancesDaemon(): Promise<boolean> {
	const owner = await adoptRunningNotifyDaemon();
	if (!owner) return true;
	console.warn(
		`[pane-map-hook] another Superset instance (pid ${owner.pid}) serves the notify daemon on 127.0.0.1:${NOTIFY_DAEMON_PORT}; leaving its hook registration and daemon alone until it exits`,
	);
	if (!(await awaitAdoptedNotifyDaemonExit(owner))) {
		console.info(
			`[pane-map-hook] shutting down while another Superset instance still serves the notify daemon on 127.0.0.1:${NOTIFY_DAEMON_PORT}; leaving its hook registration alone`,
		);
		return false;
	}
	console.info(
		`[pane-map-hook] the notify daemon on 127.0.0.1:${NOTIFY_DAEMON_PORT} stopped answering; taking over its hook registration`,
	);
	return true;
}

/**
 * The two shared hook files, off the main thread end to end: the parent-directory
 * probes and both rewrites await node:fs/promises, so a boot-path registration no
 * longer stalls the renderer's `superset-app://` loader. A missing parent
 * directory still means "this agent is not installed here" and is left alone.
 */
async function mergeSharedHookFiles(
	paneMapPython: string | null,
	notify: NotifyTransport | null,
): Promise<void> {
	if (await pathExists(path.dirname(CLAUDE_SETTINGS_PATH))) {
		await rewriteHookFileAsync(
			CLAUDE_SETTINGS_PATH,
			hookRewrite(paneMapPython, notify),
			hookFileMode(notify),
		);
	}
	if (await pathExists(path.dirname(CODEX_HOOKS_PATH))) {
		await rewriteHookFileAsync(CODEX_HOOKS_PATH, (parsed) => {
			parsed.hooks = withPaneMapHook(parsed.hooks ?? {}, paneMapPython);
		});
	}
}

// (HOOK-HTTP-DAEMON) Two writers touch the same `<file>.pending`, so each waits
// out the ones queued before it. `drained()` is how a quit waits for every
// hook-file write in flight — which is why the shared-file merge and the
// command-transport restore queue here too, not just the profile mirror.
const queueHookWrite = createSerialQueue();

/** Queued, so it cannot interleave with a profile mirror's `.pending` writes. */
function mergeAllHooks(
	paneMapPython: string | null,
	notify: NotifyTransport | null,
): Promise<void> {
	return queueHookWrite(() => mergeSharedHookFiles(paneMapPython, notify));
}

/**
 * The command-transport restore — shared files, then the profile copies — as ONE
 * queued write. `stopNotifyHookDaemon` awaits the write queue in the same tick
 * that triggers this, so a restore split across two queued jobs would leave the
 * profile half outside what that quit waits for, and those copies would keep
 * POSTing a port the process is about to close.
 */
function restoreCommandTransport(
	paneMapPython: string | null,
	notify: CommandTransport | null,
): Promise<void> {
	return queueHookWrite(async () => {
		await mergeSharedHookFiles(paneMapPython, notify);
		await mirrorProfiles(paneMapPython, notify, undefined);
	});
}

/** The `exit`-handler twin: the same two files, with no tick left to await. */
function mergeAllHooksSync(
	paneMapPython: string | null,
	notify: NotifyTransport | null,
): void {
	rewriteHookFileSync(
		CLAUDE_SETTINGS_PATH,
		hookRewrite(paneMapPython, notify),
		hookFileMode(notify),
	);
	rewriteHookFileSync(CODEX_HOOKS_PATH, (parsed) => {
		parsed.hooks = withPaneMapHook(parsed.hooks ?? {}, paneMapPython);
	});
}

/**
 * (HOOK-HTTP-DAEMON) A Superset terminal on a Pi-capable host launches Claude
 * with `CLAUDE_CONFIG_DIR=<db-dir>/claude-profiles/<uuid>`, whose settings.json
 * is the host-service's copy of `~/.claude/settings.json`. That copy is only
 * refreshed at host-service start and at a terminal launch, so a session that
 * already exists when the transport changes would keep the old one for the whole
 * run: every transport change rewrites the copies itself. Returns the profiles
 * it rewrote — the only ones whose sessions can speak for the transport.
 *
 * A machine with a Claude profile per workspace has hundreds of these, so the
 * walk and every rewrite are awaited rather than synchronous: this runs while
 * the renderer is still loading its assets off the same main thread.
 */
export function mirrorHooksIntoProfiles(
	paneMapPython: string | null,
	notify: NotifyTransport | null,
	profileDirs?: readonly string[],
): Promise<string[]> {
	return queueHookWrite(() =>
		mirrorProfiles(paneMapPython, notify, profileDirs),
	);
}

const PROFILE_MIRROR_CONCURRENCY = 8;

/**
 * (HOOK-HTTP-DAEMON) What this process last left in each profile's
 * settings.json, keyed by that file's path. The mirror re-runs on every
 * transport hand-back and on the 60s resweep over the same hundreds of
 * folders, and a copy nobody has touched since needs neither a read nor a
 * write — its size, mtime and the transport it was written for answer the
 * whole question from one stat.
 */
const mirroredProfiles = new Map<
	string,
	{ size: number; mtimeMs: number; rewriteKey: string; mirrored: boolean }
>();

function hookRewriteKey(
	paneMapPython: string | null,
	notify: NotifyTransport | null,
): string {
	return JSON.stringify([paneMapPython, notify]);
}

function statOrNull(target: string): Promise<fs.Stats | null> {
	return fs.promises.stat(target).then(
		(stats) => stats,
		() => null,
	);
}

async function mapBounded<T>(
	items: readonly T[],
	limit: number,
	fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, async () => {
			while (next < items.length) {
				const index = next;
				next += 1;
				await fn(items[index] as T, index);
			}
		}),
	);
}

async function mirrorProfiles(
	paneMapPython: string | null,
	notify: NotifyTransport | null,
	profileDirs: readonly string[] | undefined,
): Promise<string[]> {
	const dirs = profileDirs ?? (await claudeProfileDirsAsync());
	const rewrite = hookRewrite(paneMapPython, notify);
	const mode = hookFileMode(notify);
	const rewriteKey = hookRewriteKey(paneMapPython, notify);
	// Index-keyed, so the bounded fan-out still answers in profile order.
	const mirrored: (string | null)[] = dirs.map(() => null);
	await mapBounded(dirs, PROFILE_MIRROR_CONCURRENCY, async (profileDir, i) => {
		const settingsPath = path.join(profileDir, "settings.json");
		const before = await statOrNull(settingsPath);
		if (!before) return;
		const memo = mirroredProfiles.get(settingsPath);
		// A wrong mode falls through to the rewrite rather than being chmodded
		// here: that path already owns the failure reporting for it.
		if (
			memo &&
			memo.rewriteKey === rewriteKey &&
			memo.size === before.size &&
			memo.mtimeMs === before.mtimeMs &&
			(mode === undefined || (before.mode & 0o777) === mode)
		) {
			if (memo.mirrored) mirrored[i] = profileDir;
			return;
		}
		// (HOOK-HTTP-DAEMON) A profile whose write did not land still reads the
		// old transport, and naming it here would let its sessions speak for the
		// new one: the traffic gate would call a working daemon unused.
		const written = await rewriteHookFileAsync(settingsPath, rewrite, mode);
		const after = await statOrNull(settingsPath);
		if (after) {
			mirroredProfiles.set(settingsPath, {
				size: after.size,
				mtimeMs: after.mtimeMs,
				rewriteKey,
				mirrored: written,
			});
		} else {
			mirroredProfiles.delete(settingsPath);
		}
		if (written) mirrored[i] = profileDir;
	});
	return mirrored.filter((dir): dir is string => dir !== null);
}

/**
 * The mirror the process `exit` handler runs, which has no tick left to await.
 * The read itself skips a profile that has no settings.json, so this no longer
 * probes for one per profile folder — on a machine carrying a Claude profile per
 * workspace that probe was hundreds of blocking syscalls at quit.
 */
function mirrorHooksIntoProfilesSync(
	paneMapPython: string | null,
	notify: NotifyTransport | null,
): void {
	const rewrite = hookRewrite(paneMapPython, notify);
	for (const profileDir of claudeProfileDirs()) {
		rewriteHookFileSync(
			path.join(profileDir, "settings.json"),
			rewrite,
			hookFileMode(notify),
		);
	}
}

function hookRewrite(
	paneMapPython: string | null,
	notify: NotifyTransport | null,
): (parsed: HooksRoot) => void {
	return (parsed) => {
		parsed.hooks = withNotifyHooks(
			withPaneMapHook(parsed.hooks ?? {}, paneMapPython),
			notify,
		);
	};
}

function pathExists(target: string): Promise<boolean> {
	return fs.promises.access(target).then(
		() => true,
		() => false,
	);
}

export type CommandTransportReason =
	| "daemon-unusable"
	| "daemon-stopped"
	| "process-exit";

let commandTransportFallback:
	| ((reason: CommandTransportReason) => void)
	| null = null;
let exitRestoreInstalled = false;

export function armCommandTransportFallback(
	fallback: (reason: CommandTransportReason) => void,
): void {
	commandTransportFallback = fallback;
}

function fallBackToCommandTransport(reason: CommandTransportReason): void {
	const fallback = commandTransportFallback;
	commandTransportFallback = null;
	fallback?.(reason);
}

// (HOOK-HTTP-DAEMON) Claude runs with Superset closed, against the same
// settings.json, so the hooks leave the daemon before the daemon dies. The
// profile mirror is awaited here: a quit that returned before it finished would
// leave those copies POSTing a port this process is about to close.
export async function stopNotifyHookDaemon(): Promise<void> {
	cancelNotifyDaemonRun();
	fallBackToCommandTransport("daemon-stopped");
	await queueHookWrite.drained();
	await stopNotifyDaemon();
}

type HookRegistration = "registered" | "cancelled" | "port-owned-elsewhere";

let profileResweep: NodeJS.Timeout | null = null;

function clearProfileResweep(): void {
	if (profileResweep) clearTimeout(profileResweep);
	profileResweep = null;
}

/**
 * (HOOK-HTTP-DAEMON) Runs well after first paint — resolving the interpreter
 * executes candidates and the handshake waits on a socket — and the only
 * synchronous writes left are the two shared hook files, so neither the walk
 * over this machine's Claude profiles nor its rewrites sit on the startup path.
 *
 * Events during a daemon outage are lost: Claude treats a refused hook POST as
 * non-blocking and never retries it. The 60-second host resync and the notify
 * script's marker self-heal are the recovery; no durable delivery is claimed.
 */
async function upgradeHooksToDaemon(
	notifyOk: boolean,
	token: number,
): Promise<HookRegistration> {
	// (HOOK-HTTP-DAEMON) Every write below is gated on the registration run's
	// token: entries aimed at this daemon must never appear after quit cleanup
	// has already put the hooks back and reported itself done.
	const cancelled = (): boolean => token !== notifyDaemonRunToken();
	const pythonPath = await resolvePythonPath();
	if (cancelled()) return "cancelled";
	const commandTransport: CommandTransport | null = notifyOk
		? { kind: "command", pythonPath }
		: null;
	const handBack = notifyHandBackToken();
	const daemon = notifyOk
		? await ensureNotifyDaemon(NOTIFY_SCRIPT_PATH, () =>
				fallBackToCommandTransport("daemon-unusable"),
			)
		: null;
	if (cancelled()) return "cancelled";
	if (!daemon) {
		if (notifyOk && (await adoptRunningNotifyDaemon())) {
			return "port-owned-elsewhere";
		}
		if (cancelled()) return "cancelled";
		await mergeAllHooks(pythonPath, commandTransport);
		await mirrorHooksIntoProfiles(pythonPath, commandTransport);
		return "registered";
	}
	const httpTransport: NotifyTransport = {
		kind: "http",
		port: daemon.port,
		secret: daemon.secret,
	};
	armCommandTransportFallback((reason) => {
		clearProfileResweep();
		console.warn(`[pane-map-hook] notify transport back to command: ${reason}`);
		if (reason === "process-exit") {
			// No tick is left to await here, so this half stays synchronous.
			mergeAllHooksSync(pythonPath, commandTransport);
			mirrorHooksIntoProfilesSync(pythonPath, commandTransport);
			return;
		}
		void restoreCommandTransport(pythonPath, commandTransport).catch((error) =>
			console.warn("[pane-map-hook] command-transport restore failed:", error),
		);
	});
	if (!exitRestoreInstalled) {
		exitRestoreInstalled = true;
		process.once("exit", () => fallBackToCommandTransport("process-exit"));
	}
	await mergeAllHooks(pythonPath, httpTransport);
	const upgradedProfiles = await mirrorHooksIntoProfiles(
		pythonPath,
		httpTransport,
	);
	if (cancelled()) return "cancelled";
	// (HOOK-HTTP-DAEMON) Supervision can hand the hooks back while the mirror is
	// still walking the profiles. The fallback has already rewritten them and
	// cleared the resweep, so a resweep or a traffic watch armed here would aim
	// those copies at a port nothing serves.
	if (handBack !== notifyHandBackToken()) return "registered";
	profileResweep = setTimeout(() => {
		void mirrorHooksIntoProfiles(pythonPath, httpTransport);
	}, SETTINGS_RELOAD_MS);
	profileResweep.unref?.();
	await watchNotifyDaemonTraffic(
		daemon,
		claudeTranscriptRoots(upgradedProfiles),
		() => fallBackToCommandTransport("daemon-unusable"),
		handBack,
	);
	return "registered";
}
