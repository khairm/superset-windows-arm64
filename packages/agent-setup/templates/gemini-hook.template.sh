#!/bin/bash
{{MARKER}}
# Gemini CLI lifecycle hook. JSON in via stdin; MUST print valid JSON to
# stdout before exit so gemini doesn't block on the hook.
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

json_field "hook_event_name" "$INPUT"; EVENT_TYPE="$JSON_FIELD"
json_field "session_id" "$INPUT"; HOOK_SESSION_ID="$JSON_FIELD"

case "$EVENT_TYPE" in
  BeforeAgent)              EVENT_TYPE="Start" ;;
  AfterAgent)               EVENT_TYPE="Stop"  ;;
  AfterTool)                EVENT_TYPE="Start" ;;
  SessionStart|SessionEnd)  ;;
  *)
    printf '{}\n'
    exit 0
    ;;
esac

printf '{}\n'

# ~/.gemini/settings.json is global, so this also fires in sessions launched
# outside Superset terminals; only those terminals set SUPERSET_* vars.
[ -n "$SUPERSET_TERMINAL_ID" ] || [ -n "$SUPERSET_TAB_ID" ] || exit 0

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

# Resolve the host-service endpoint at call time: the env URL is frozen at
# terminal creation and goes stale when the host-service restarts on a new
# port, while each org manifest is rewritten with the live endpoint on every
# start. Only the host that owns this terminal answers "ignored":false.
if [ -n "$SUPERSET_TERMINAL_ID" ]; then
  json_escape "$SUPERSET_TERMINAL_ID"; E_TERMINAL_ID="$JSON_ESCAPED"
  json_escape "$EVENT_TYPE"; E_EVENT_TYPE="$JSON_ESCAPED"
  json_escape "$SUPERSET_AGENT_ID"; E_AGENT_ID="$JSON_ESCAPED"
  json_escape "$HOOK_SESSION_ID"; E_SESSION_ID="$JSON_ESCAPED"
  PAYLOAD="{\"json\":{\"terminalId\":\"$E_TERMINAL_ID\",\"eventType\":\"$E_EVENT_TYPE\",\"agent\":{\"agentId\":\"$E_AGENT_ID\",\"sessionId\":\"$E_SESSION_ID\"}}}"

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

  HOOK_DELIVERED_2XX="0"
  SEEN_HOOK_URLS=""
  for HOOK_URL in $HOOK_CANDIDATE_URLS; do
    case " $SEEN_HOOK_URLS " in *" $HOOK_URL "*) continue ;; esac
    SEEN_HOOK_URLS="$SEEN_HOOK_URLS $HOOK_URL"

    RESPONSE=$(curl -sX POST "$HOOK_URL" \
      --connect-timeout 2 --max-time 5 \
      -H "Content-Type: application/json" \
      -d "$PAYLOAD" \
      -w "|%{http_code}" 2>/dev/null)
    STATUS_CODE="${RESPONSE##*|}"
    BODY="${RESPONSE%|*}"

    case "$BODY" in
      *'"ignored":false'*|*'"ignored": false'*) exit 0 ;;
    esac
    case "$STATUS_CODE" in
      2*) HOOK_DELIVERED_2XX="1" ;;
      *) echo "[gemini-hook] host-service dispatch failed status=$STATUS_CODE url=$HOOK_URL" >&2 ;;
    esac
  done

  [ "$HOOK_DELIVERED_2XX" = "1" ] && exit 0
  echo "[gemini-hook] no host-service accepted the event; falling back to v1" >&2
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
  --data-urlencode "rawEventType=$EVENT_TYPE" \
  --data-urlencode "agentId=$SUPERSET_AGENT_ID" \
  --data-urlencode "env=$SUPERSET_ENV" \
  --data-urlencode "version=$SUPERSET_HOOK_VERSION" \
  > /dev/null 2>&1

exit 0
