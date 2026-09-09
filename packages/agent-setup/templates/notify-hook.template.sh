#!/bin/bash
{{MARKER}}
# CLI agent lifecycle hook — POSTs an AgentIdentity payload to the v2
# host-service endpoint, with a v1 Electron hook fallback while both
# terminal stacks are supported.
#
# (HOOK-FORK-DIET) JSON parsing and escaping run entirely on bash builtins
# (read / [[ =~ ]] / ${//}) instead of echo|grep|grep|tr and printf|sed
# pipelines. That collapses ~30 subprocess forks per invocation to a single
# fork (curl). On Windows ARM64 the Git-bash msys2 runtime is x64-emulated and
# its fork() corrupts the shared section under high concurrent fork volume —
# the `add_item ... errno 1` cascade that wedged every chat's hooks. The wire
# payload is byte-for-byte identical to the pipeline version upstream ships.

# Codex passes JSON as argv; Claude/Mastra/Droid/Kimi/Grok pipe via stdin.
# `read -d ''` slurps stdin without forking `cat`.
if [ -n "$1" ]; then
  INPUT="$1"
else
  IFS= read -r -d '' INPUT
fi

# Agent hook configs are global, so this can fire in sessions launched
# outside Superset terminals (including via stale entries from older
# installs). Only Superset terminals set SUPERSET_* vars; the agent-supplied
# payload alone must never dispatch.
[ -n "$SUPERSET_TERMINAL_ID" ] || [ -n "$SUPERSET_TAB_ID" ] || exit 0

# Fork-free extraction of a JSON string field's value into JSON_FIELD.
# `[[ =~ ]]` returns the FIRST match in the document, which is what upstream's
# `head -n 1` buys: a key can recur in nested objects (Claude's SubagentStop
# repeats agent_type inside background_tasks) and the later one must not win.
json_field() {
  local re="\"$1\"[[:blank:]]*:[[:blank:]]*\"([^\"]*)\""
  if [[ $2 =~ $re ]]; then
    JSON_FIELD="${BASH_REMATCH[1]}"
  else
    JSON_FIELD=""
  fi
}

# Same, over $INPUT, trying key aliases in order — snake_case is the Claude
# schema shared by Codex and most forks, camelCase covers harnesses that
# serialize like Grok. Add an alias here, nothing downstream cares which
# spelling arrived. (HOOK-FORK-DIET) upstream's equivalent helper is an
# echo|grep|head|grep|tr pipeline: five forks per field, per hook call.
json_input_field() {
  for JF_KEY in "$@"; do
    json_field "$JF_KEY" "$INPUT"
    [ -n "$JSON_FIELD" ] && return 0
  done
  JSON_FIELD=""
}

# Claude Code and Codex set agent_id only when the hook fires inside a
# subagent (Task tool / spawn_agent). Subagent activity must not drive
# terminal-level agent status, notifications, or the session id binding —
# only the main loop counts. It is forwarded separately so the host can keep
# a per-terminal roster of live subagents (see notifications.hook).
json_input_field agent_id agentId; SUBAGENT_ID="$JSON_FIELD"
json_input_field agent_type agentType; SUBAGENT_TYPE="$JSON_FIELD"
# transcript_path is the file the hook ran against (Claude: the parent
# session; Codex: the child's own rollout); agent_transcript_path is the
# child's transcript on SubagentStop. The host derives the child's file from
# them so the subagent pane can follow it.
json_input_field transcript_path transcriptPath; TRANSCRIPT_PATH="$JSON_FIELD"
json_input_field agent_transcript_path agentTranscriptPath
AGENT_TRANSCRIPT_PATH="$JSON_FIELD"

json_input_field session_id sessionId; HOOK_SESSION_ID="$JSON_FIELD"
json_input_field resourceId resource_id; RESOURCE_ID="$JSON_FIELD"
SESSION_ID=${RESOURCE_ID:-$HOOK_SESSION_ID}
if [ -z "$SESSION_ID" ]; then
  # Codex's legacy notify callback (agent-turn-complete) carries the
  # resumable id as thread-id — the same id `codex resume` takes.
  json_input_field thread-id thread_id; SESSION_ID="$JSON_FIELD"
fi

# Claude/Mastra/Droid/Kimi use "hook_event_name"; Grok uses camelCase
# "hookEventName" (snake_case values, mapped server-side); Codex uses "type".
json_input_field hook_event_name hookEventName; EVENT_TYPE="$JSON_FIELD"
if [ -z "$EVENT_TYPE" ]; then
  json_input_field type; CODEX_TYPE="$JSON_FIELD"
  case "$CODEX_TYPE" in
    agent-turn-complete|task_complete) EVENT_TYPE="Stop" ;;
    task_started) EVENT_TYPE="Start" ;;
    exec_approval_request|apply_patch_approval_request|request_user_input)
      EVENT_TYPE="PermissionRequest"
      ;;
  esac
fi

# Grok serializes its configured Notification event as lowercase
# "notification". Only subtypes where the agent is blocked waiting on the
# user count: permission_prompt (tool/plan approval) and elicitation_dialog
# (ask_user_question — the common case, since Superset launches grok with
# --always-approve so tool approvals rarely prompt). Keep the case pattern
# in sync with GROK_BLOCKING_NOTIFICATION_TYPES in agent-wrappers-grok.ts.
if [ "$EVENT_TYPE" = "notification" ]; then
  json_input_field notificationType notification_type
  NOTIFICATION_TYPE="$JSON_FIELD"
  case "$NOTIFICATION_TYPE" in
    permission_prompt|elicitation_dialog) EVENT_TYPE="PermissionRequest" ;;
    *) exit 0 ;;
  esac
fi

# UserPromptSubmit normalizes here; other aliases are mapped server-side
# by mapEventType so the wire stays a single source of truth.
[ "$EVENT_TYPE" = "UserPromptSubmit" ] && EVENT_TYPE="Start"

# Never default to "Stop" on parse failure — silent drop is safer than
# a false completion notification.
[ -z "$EVENT_TYPE" ] && exit 0

DEBUG_HOOKS_ENABLED="0"
if [ -n "$SUPERSET_DEBUG_HOOKS" ]; then
  case "$SUPERSET_DEBUG_HOOKS" in
    1|true|TRUE|True|yes|YES|on|ON) DEBUG_HOOKS_ENABLED="1" ;;
  esac
elif [ "$SUPERSET_ENV" = "development" ] || [ "$NODE_ENV" = "development" ]; then
  DEBUG_HOOKS_ENABLED="1"
fi

if [ "$DEBUG_HOOKS_ENABLED" = "1" ]; then
  echo "[notify-hook] event=$EVENT_TYPE terminalId=$SUPERSET_TERMINAL_ID agentId=$SUPERSET_AGENT_ID subagentId=$SUBAGENT_ID sessionId=$SESSION_ID hookSessionId=$HOOK_SESSION_ID resourceId=$RESOURCE_ID paneId=$SUPERSET_PANE_ID tabId=$SUPERSET_TAB_ID workspaceId=$SUPERSET_WORKSPACE_ID" >&2
fi

debug_log() {
  [ "$DEBUG_HOOKS_ENABLED" = "1" ] || return 0
  printf '%s [notify-hook] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date)" "$*" >> "${SUPERSET_HOOK_DEBUG_LOG:-/tmp/superset-agent-hooks.log}" 2>/dev/null || true
}

# Fork-free JSON string escaping into JSON_ESCAPED (backslash then quote).
json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  JSON_ESCAPED="$s"
}

# Resolve the host-service endpoint at call time. SUPERSET_HOST_AGENT_HOOK_URL
# is frozen into the agent's env at terminal creation; after a host-service
# restart on a new port it would point at a dead socket forever (a live
# process's env can't change). Each org's manifest
# (~/.superset/host/<orgId>/manifest.json) is rewritten with the live endpoint
# on every start, so it never goes stale. Try the env URL first (fast path),
# then every org manifest's endpoint. Only the host that owns this terminal
# answers "ignored":false; probing the other orgs' hosts is a harmless no-op.
#
# (DISPOSE-LIMBO) The per-URL probe below reads the response BODY, not just the
# status code: EVERY host-service outcome is a 200 — a dropped event answers
# 200 with an `ignored`/`reason` body on purpose — so the status code alone
# cannot distinguish a delivered dot from one the host threw away for an
# unknown terminal, which is exactly what a terminal stuck in dispose limbo
# produces. (HOOK-FORK-DIET) Escaping, the manifest read and the body/status
# split are pure builtins — one curl fork per candidate URL, no pipelines.
#
# Sets HOOK_ACCEPTED=1 when an owning host took the event and
# HOOK_DELIVERED_2XX=1 when any host answered 2xx.
dispatch_to_host() {
  DISPATCH_PAYLOAD="$1"
  HOOK_ACCEPTED="0"
  HOOK_DELIVERED_2XX="0"
  HOOK_CANDIDATE_URLS="$SUPERSET_HOST_AGENT_HOOK_URL"
  for MANIFEST_FILE in "${SUPERSET_HOME_DIR:-$HOME/.superset}"/host/*/manifest.json; do
    [ -f "$MANIFEST_FILE" ] || continue
    # (HOOK-FORK-DIET) Slurp + parse the manifest with builtins: the
    # grep|head|grep|tr pipeline this replaces forked four processes per
    # manifest per hook call, which is exactly the msys2 fork cascade on
    # Windows ARM64 that this template exists to avoid.
    MANIFEST_JSON=""
    IFS= read -r -d '' MANIFEST_JSON < "$MANIFEST_FILE"
    json_field "endpoint" "$MANIFEST_JSON"; MANIFEST_ENDPOINT="$JSON_FIELD"
    [ -n "$MANIFEST_ENDPOINT" ] || continue
    HOOK_CANDIDATE_URLS="$HOOK_CANDIDATE_URLS $MANIFEST_ENDPOINT/trpc/notifications.hook"
  done

  SEEN_HOOK_URLS=""
  for HOOK_URL in $HOOK_CANDIDATE_URLS; do
    case " $SEEN_HOOK_URLS " in *" $HOOK_URL "*) continue ;; esac
    SEEN_HOOK_URLS="$SEEN_HOOK_URLS $HOOK_URL"

    RESPONSE=$(curl -sX POST "$HOOK_URL" \
      --connect-timeout 2 --max-time 5 \
      -H "Content-Type: application/json" \
      -d "$DISPATCH_PAYLOAD" \
      -w "|%{http_code}" 2>/dev/null)
    STATUS_CODE="${RESPONSE##*|}"
    BODY="${RESPONSE%|*}"

    if [ "$DEBUG_HOOKS_ENABLED" = "1" ]; then
      echo "[notify-hook] host-service dispatched status=$STATUS_CODE url=$HOOK_URL" >&2
    fi
    debug_log "host-service status=$STATUS_CODE body=${BODY:0:500} url=$HOOK_URL"

    # "ignored":false means the owning host accepted and fanned out the event.
    case "$BODY" in
      *'"ignored":false'*|*'"ignored": false'*) HOOK_ACCEPTED="1"; return 0 ;;
    esac
    case "$STATUS_CODE" in
      2*) HOOK_DELIVERED_2XX="1" ;;
    esac
  done
  return 0
}

# Subagent events go to the host-service roster only: no v1 fallback, no
# session id (a Codex child's session_id is its own thread, never the
# terminal's resumable session), and the raw event name so the host can tell
# a start from a stop.
if [ -n "$SUBAGENT_ID" ]; then
  debug_log "subagent event=$EVENT_TYPE terminalId=$SUPERSET_TERMINAL_ID agentId=$SUPERSET_AGENT_ID subagentId=$SUBAGENT_ID subagentType=$SUBAGENT_TYPE"
  [ -n "$SUPERSET_TERMINAL_ID" ] || exit 0
  json_escape "$SUPERSET_TERMINAL_ID"; E_TERMINAL_ID="$JSON_ESCAPED"
  json_escape "$EVENT_TYPE"; E_EVENT_TYPE="$JSON_ESCAPED"
  json_escape "$SUBAGENT_ID"; E_SUBAGENT_ID="$JSON_ESCAPED"
  json_escape "$SUBAGENT_TYPE"; E_SUBAGENT_TYPE="$JSON_ESCAPED"
  json_escape "$HOOK_SESSION_ID"; E_HOOK_SESSION_ID="$JSON_ESCAPED"
  json_escape "$TRANSCRIPT_PATH"; E_TRANSCRIPT_PATH="$JSON_ESCAPED"
  json_escape "$AGENT_TRANSCRIPT_PATH"; E_AGENT_TRANSCRIPT_PATH="$JSON_ESCAPED"
  dispatch_to_host "{\"json\":{\"terminalId\":\"$E_TERMINAL_ID\",\"eventType\":\"$E_EVENT_TYPE\",\"subagent\":{\"id\":\"$E_SUBAGENT_ID\",\"type\":\"$E_SUBAGENT_TYPE\",\"sessionId\":\"$E_HOOK_SESSION_ID\",\"transcriptPath\":\"$E_TRANSCRIPT_PATH\",\"agentTranscriptPath\":\"$E_AGENT_TRANSCRIPT_PATH\"}}}"
  exit 0
fi

debug_log "event=$EVENT_TYPE terminalId=$SUPERSET_TERMINAL_ID agentId=$SUPERSET_AGENT_ID sessionId=$SESSION_ID hookSessionId=$HOOK_SESSION_ID resourceId=$RESOURCE_ID tabId=$SUPERSET_TAB_ID"

V1_EVENT_TYPE="$EVENT_TYPE"
case "$V1_EVENT_TYPE" in
  Attached|attached|SessionStart|sessionStart|session_start)
    V1_EVENT_TYPE="Start"
    ;;
  Detached|detached|SessionEnd|sessionEnd|session_end)
    V1_EVENT_TYPE="Stop"
    ;;
esac

if [ -n "$SUPERSET_TERMINAL_ID" ]; then
  json_escape "$SUPERSET_TERMINAL_ID"; E_TERMINAL_ID="$JSON_ESCAPED"
  json_escape "$EVENT_TYPE"; E_EVENT_TYPE="$JSON_ESCAPED"
  json_escape "$SUPERSET_AGENT_ID"; E_AGENT_ID="$JSON_ESCAPED"
  json_escape "$SESSION_ID"; E_SESSION_ID="$JSON_ESCAPED"
  PAYLOAD="{\"json\":{\"terminalId\":\"$E_TERMINAL_ID\",\"eventType\":\"$E_EVENT_TYPE\",\"agent\":{\"agentId\":\"$E_AGENT_ID\",\"sessionId\":\"$E_SESSION_ID\"}}}"

  dispatch_to_host "$PAYLOAD"
  [ "$HOOK_ACCEPTED" = "1" ] && exit 0
  # Delivered somewhere (2xx) but no host owned the terminal: keep the
  # pre-existing "any 2xx wins" behavior and skip the v1 fallback.
  [ "$HOOK_DELIVERED_2XX" = "1" ] && exit 0
fi

# v1 fallback: Electron localhost hook server. Kept while v1 terminals exist.
[ -z "$SUPERSET_TAB_ID" ] && [ -z "$SESSION_ID" ] && [ -z "$SUPERSET_TERMINAL_ID" ] && exit 0

# rawEventType keeps the un-collapsed event (SessionStart/SessionEnd survive)
# so the app can tell an agent's own goodbye from a turn Stop — the v1 pane
# agent-session capture needs that to mirror v2 resume-candidate detection.
if [ "$DEBUG_HOOKS_ENABLED" = "1" ]; then
  STATUS_CODE=$(curl -sG "http://127.0.0.1:${SUPERSET_PORT:-{{DEFAULT_PORT}}}/hook/complete" \
    --connect-timeout 1 --max-time 2 \
    --data-urlencode "paneId=$SUPERSET_PANE_ID" \
    --data-urlencode "tabId=$SUPERSET_TAB_ID" \
    --data-urlencode "workspaceId=$SUPERSET_WORKSPACE_ID" \
    --data-urlencode "terminalId=$SUPERSET_TERMINAL_ID" \
    --data-urlencode "sessionId=$SESSION_ID" \
    --data-urlencode "hookSessionId=$HOOK_SESSION_ID" \
    --data-urlencode "resourceId=$RESOURCE_ID" \
    --data-urlencode "eventType=$V1_EVENT_TYPE" \
    --data-urlencode "rawEventType=$EVENT_TYPE" \
    --data-urlencode "agentId=$SUPERSET_AGENT_ID" \
    --data-urlencode "env=$SUPERSET_ENV" \
    --data-urlencode "version=$SUPERSET_HOOK_VERSION" \
    -o /dev/null -w "%{http_code}" 2>/dev/null)
  echo "[notify-hook] v1 dispatched status=$STATUS_CODE" >&2
  debug_log "v1 status=$STATUS_CODE port=${SUPERSET_PORT:-{{DEFAULT_PORT}}}"
else
  debug_log "v1 dispatch port=${SUPERSET_PORT:-{{DEFAULT_PORT}}}"
  curl -sG "http://127.0.0.1:${SUPERSET_PORT:-{{DEFAULT_PORT}}}/hook/complete" \
    --connect-timeout 1 --max-time 2 \
    --data-urlencode "paneId=$SUPERSET_PANE_ID" \
    --data-urlencode "tabId=$SUPERSET_TAB_ID" \
    --data-urlencode "workspaceId=$SUPERSET_WORKSPACE_ID" \
    --data-urlencode "terminalId=$SUPERSET_TERMINAL_ID" \
    --data-urlencode "sessionId=$SESSION_ID" \
    --data-urlencode "hookSessionId=$HOOK_SESSION_ID" \
    --data-urlencode "resourceId=$RESOURCE_ID" \
    --data-urlencode "eventType=$V1_EVENT_TYPE" \
    --data-urlencode "rawEventType=$EVENT_TYPE" \
    --data-urlencode "agentId=$SUPERSET_AGENT_ID" \
    --data-urlencode "env=$SUPERSET_ENV" \
    --data-urlencode "version=$SUPERSET_HOOK_VERSION" \
    > /dev/null 2>&1
fi

exit 0
