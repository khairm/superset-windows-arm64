#!/bin/bash
{{MARKER}}
# cursor-agent lifecycle hook. Event name comes via argv from hooks.json.
#
# (HOOK-FORK-DIET) Parsing + JSON escaping use bash builtins (read / [[ =~ ]] /
# ${//}) instead of cat + grep|grep|tr and printf|sed pipelines, cutting the
# per-call subprocess forks to a single curl. Prevents the x64-emulated msys2
# fork() cascade on Windows ARM64; the POST payload is unchanged.

IFS= read -r -d '' INPUT

# Fork-free extraction of a JSON string field's value into JSON_FIELD.
json_field() {
  local re="\"$1\"[[:blank:]]*:[[:blank:]]*\"([^\"]*)\""
  if [[ $2 =~ $re ]]; then
    JSON_FIELD="${BASH_REMATCH[1]}"
  else
    JSON_FIELD=""
  fi
}

json_field "session_id" "$INPUT"; HOOK_SESSION_ID="$JSON_FIELD"

EVENT_TYPE="$1"

NEEDS_RESPONSE=false
case "$EVENT_TYPE" in
  Start|Stop|SessionStart|SessionEnd) ;;
  PermissionRequest) NEEDS_RESPONSE=true ;;
  *) exit 0 ;;
esac

# Permission hooks auto-approve via JSON on stdout. Must print before any
# exit path so cursor-agent isn't left blocked.
if [ "$NEEDS_RESPONSE" = "true" ]; then
  printf '{"continue":true}\n'
fi

V1_EVENT_TYPE="$EVENT_TYPE"
case "$V1_EVENT_TYPE" in
  SessionStart) V1_EVENT_TYPE="Start" ;;
  SessionEnd)   V1_EVENT_TYPE="Stop" ;;
esac

# Fork-free JSON string escaping into JSON_ESCAPED (backslash then quote).
json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  JSON_ESCAPED="$s"
}

# This script only fires for Cursor sessions, so an unset SUPERSET_AGENT_ID
# means Cursor ran outside a Superset wrapper: the cursor-agent CLI stamps
# CURSOR_AGENT/CURSOR_CLI into its env; anything else is the IDE Composer.
AGENT_ID="$SUPERSET_AGENT_ID"
if [ -z "$AGENT_ID" ]; then
  if [ -n "$CURSOR_AGENT" ] || [ -n "$CURSOR_CLI" ]; then
    AGENT_ID="cursor-agent"
  else
    AGENT_ID="cursor-composer"
  fi
fi

if [ -n "$SUPERSET_HOST_AGENT_HOOK_URL" ] && [ -n "$SUPERSET_TERMINAL_ID" ]; then
  json_escape "$SUPERSET_TERMINAL_ID"; E_TERMINAL_ID="$JSON_ESCAPED"
  json_escape "$EVENT_TYPE"; E_EVENT_TYPE="$JSON_ESCAPED"
  json_escape "$AGENT_ID"; E_AGENT_ID="$JSON_ESCAPED"
  json_escape "$HOOK_SESSION_ID"; E_SESSION_ID="$JSON_ESCAPED"
  PAYLOAD="{\"json\":{\"terminalId\":\"$E_TERMINAL_ID\",\"eventType\":\"$E_EVENT_TYPE\",\"agent\":{\"agentId\":\"$E_AGENT_ID\",\"sessionId\":\"$E_SESSION_ID\"}}}"

  STATUS_CODE=$(curl -sX POST "$SUPERSET_HOST_AGENT_HOOK_URL" \
    --connect-timeout 2 --max-time 5 \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" \
    -o /dev/null -w "%{http_code}" 2>/dev/null)

  case "$STATUS_CODE" in
    2*) exit 0 ;;
  esac
fi

[ -z "$SUPERSET_TAB_ID" ] && [ -z "$SUPERSET_TERMINAL_ID" ] && exit 0

curl -sG "http://127.0.0.1:${SUPERSET_PORT:-{{DEFAULT_PORT}}}/hook/complete" \
  --connect-timeout 1 --max-time 2 \
  --data-urlencode "paneId=$SUPERSET_PANE_ID" \
  --data-urlencode "tabId=$SUPERSET_TAB_ID" \
  --data-urlencode "workspaceId=$SUPERSET_WORKSPACE_ID" \
  --data-urlencode "terminalId=$SUPERSET_TERMINAL_ID" \
  --data-urlencode "sessionId=$HOOK_SESSION_ID" \
  --data-urlencode "hookSessionId=$HOOK_SESSION_ID" \
  --data-urlencode "eventType=$V1_EVENT_TYPE" \
  --data-urlencode "env=$SUPERSET_ENV" \
  --data-urlencode "version=$SUPERSET_HOOK_VERSION" \
  > /dev/null 2>&1

exit 0
