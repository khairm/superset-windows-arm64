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
# payload is byte-for-byte identical to the previous pipeline version.

# Codex passes JSON as argv; Claude/Mastra/Droid pipe via stdin. `read -d ''`
# slurps stdin without forking `cat`.
if [ -n "$1" ]; then
  INPUT="$1"
else
  IFS= read -r -d '' INPUT
fi

# Fork-free extraction of a JSON string field's value into JSON_FIELD.
json_field() {
  local re="\"$1\"[[:space:]]*:[[:space:]]*\"([^\"]*)\""
  if [[ $2 =~ $re ]]; then
    JSON_FIELD="${BASH_REMATCH[1]}"
  else
    JSON_FIELD=""
  fi
}

json_field "session_id" "$INPUT"; HOOK_SESSION_ID="$JSON_FIELD"
json_field "resourceId" "$INPUT"; RESOURCE_ID="$JSON_FIELD"
if [ -z "$RESOURCE_ID" ]; then
  json_field "resource_id" "$INPUT"; RESOURCE_ID="$JSON_FIELD"
fi
SESSION_ID=${RESOURCE_ID:-$HOOK_SESSION_ID}

# Claude/Mastra/Droid use "hook_event_name"; Codex uses "type".
json_field "hook_event_name" "$INPUT"; EVENT_TYPE="$JSON_FIELD"
if [ -z "$EVENT_TYPE" ]; then
  json_field "type" "$INPUT"; CODEX_TYPE="$JSON_FIELD"
  case "$CODEX_TYPE" in
    agent-turn-complete|task_complete) EVENT_TYPE="Stop" ;;
    task_started) EVENT_TYPE="Start" ;;
    exec_approval_request|apply_patch_approval_request|request_user_input)
      EVENT_TYPE="PermissionRequest"
      ;;
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
  echo "[notify-hook] event=$EVENT_TYPE terminalId=$SUPERSET_TERMINAL_ID agentId=$SUPERSET_AGENT_ID hookSessionId=$HOOK_SESSION_ID resourceId=$RESOURCE_ID paneId=$SUPERSET_PANE_ID tabId=$SUPERSET_TAB_ID workspaceId=$SUPERSET_WORKSPACE_ID" >&2
fi

debug_log() {
  [ "$DEBUG_HOOKS_ENABLED" = "1" ] || return 0
  printf '%s [notify-hook] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date)" "$*" >> "${SUPERSET_HOOK_DEBUG_LOG:-/tmp/superset-agent-hooks.log}" 2>/dev/null || true
}

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

# Fork-free JSON string escaping into JSON_ESCAPED (backslash then quote).
json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  JSON_ESCAPED="$s"
}

if [ -n "$SUPERSET_HOST_AGENT_HOOK_URL" ] && [ -n "$SUPERSET_TERMINAL_ID" ]; then
  json_escape "$SUPERSET_TERMINAL_ID"; E_TERMINAL_ID="$JSON_ESCAPED"
  json_escape "$EVENT_TYPE"; E_EVENT_TYPE="$JSON_ESCAPED"
  json_escape "$SUPERSET_AGENT_ID"; E_AGENT_ID="$JSON_ESCAPED"
  json_escape "$SESSION_ID"; E_SESSION_ID="$JSON_ESCAPED"
  PAYLOAD="{\"json\":{\"terminalId\":\"$E_TERMINAL_ID\",\"eventType\":\"$E_EVENT_TYPE\",\"agent\":{\"agentId\":\"$E_AGENT_ID\",\"sessionId\":\"$E_SESSION_ID\"}}}"

  STATUS_CODE=$(curl -sX POST "$SUPERSET_HOST_AGENT_HOOK_URL" \
    --connect-timeout 2 --max-time 5 \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" \
    -o /dev/null -w "%{http_code}" 2>/dev/null)

  if [ "$DEBUG_HOOKS_ENABLED" = "1" ]; then
    echo "[notify-hook] host-service dispatched status=$STATUS_CODE" >&2
  fi
  debug_log "host-service status=$STATUS_CODE url=$SUPERSET_HOST_AGENT_HOOK_URL"

  case "$STATUS_CODE" in
    2*) exit 0 ;;
  esac
fi

# v1 fallback: Electron localhost hook server. Kept while v1 terminals exist.
[ -z "$SUPERSET_TAB_ID" ] && [ -z "$SESSION_ID" ] && [ -z "$SUPERSET_TERMINAL_ID" ] && exit 0

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
    --data-urlencode "env=$SUPERSET_ENV" \
    --data-urlencode "version=$SUPERSET_HOOK_VERSION" \
    > /dev/null 2>&1
fi

exit 0
