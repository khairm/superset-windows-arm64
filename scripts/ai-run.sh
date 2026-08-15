#!/usr/bin/env bash
# (AI-UNAVAILABLE) Shared Claude CLI wrapper + failure classifier.
#
# SOURCE this file (`source scripts/ai-run.sh`); it defines functions and
# constants and has NO side effects on source. Consumers: the nightly merge
# (.github/workflows/nightly-merge.yml) and the build-repair engine
# (scripts/ci-repair.sh).
#
# WHY THIS EXISTS. Every AI pass MUST tell "the model ran and did not fully
# succeed" apart from "the CLI never reached the model at all" (weekly usage
# cap, rate limit, dead credential). `claude … || true` throws away BOTH the
# exit code and the output, so a quota-exhausted account returns instantly,
# burns every retry in seconds, and the run reports a merge/repair verdict for
# work the AI never saw (2026-08-13/14 nightlies: "You've hit your weekly limit
# · resets Aug 17, 5pm (UTC)" three times, then "Opus could not resolve all
# conflicts — fix locally and re-baseline"). Nothing was wrong with the merge
# and there was nothing to fix locally.
#
# The phrase lists are SEEDED from the fork's corpus-validated classifier
# (apps/desktop/src/main/lib/auto-resume/classifier/classifier.ts: AUTH_TEXT /
# POLICY_TEXT / CONN_TEXT / TRANSIENT_TEXT) and EXTENDED with CLI-transport
# signatures the in-app classifier never sees (it reads parsed API-error
# records; we read raw CLI stderr). Numeric statuses stay anchored to API
# context: a bare 429 matches commit shas (8a429bfe0c11) and byte counts
# (4294967296).
#
# Consumers source this ONCE, up front. During a merge that means the loaded
# classifier is our pre-merge one for the whole run — an upstream edit to this
# file cannot change tonight's abort decisions. It is also listed in
# FROZEN_GATE_PATHS (scripts/ci-repair.sh) so a repair agent cannot edit it,
# and carries an `(AI-UNAVAILABLE)` FEATURES.md marker so a merge cannot drop
# it silently.

# HARD: cannot clear tonight (usage cap, dead credential) -> abort, no retry.
AI_HARD_RE='hit your (weekly|usage|5-hour|session) limit|(weekly|usage|5-hour|session) limit (reached|exceeded)|usage limit reached|credit balance is too low|requires usage credits|not logged in|invalid authentication credentials|please run /login|invalid api key|invalid_api_key|authentication_error|authentication_failed|invalid bearer token|(invalid|expired) oauth token|oauth token (has )?expired|invalid_grant|401 unauthorized'
# SOFT: plausibly transient (rate limit / overloaded / connection) -> retry.
AI_SOFT_RE='rate[ _-]?limit|temporarily limiting|not your usage limit|overloaded|too many requests|(api error|status|http)[^0-9]{0,8}(429|5[0-9][0-9])|service unavailable|unable to connect|socket connection was closed|failedtoopensocket|connectionrefused|\beconnrefused\b|\beconnreset\b|\betimedout\b|request timed out|fetch failed|getaddrinfo'

# Classify ONLY a small log. A CLI that never reached the model says so in one
# or two lines; a log any bigger is the model's own prose, and agents routinely
# quote these very strings while explaining a failure ("the build died on 503
# Service Unavailable", "401 Unauthorized from the registry") — a build log is
# untrusted input, so that quoting can also be induced deliberately. Residual
# risk, accepted and unavoidable without structured output: a SHORT prose reply
# that happens to quote a signature is still misread as infrastructure. That
# fails CLOSED (a loud, honest "CLI unavailable" abort, no bad merge or build
# shipped), and a nonzero exit with only a line or two of output is
# overwhelmingly a CLI diagnostic rather than a model answer.
AI_LOG_MAX_LINES=20
AI_LOG_MAX_BYTES=2048

# Exit status die_ai_unavailable uses, so a caller can tell "the CLI never
# reached the model" from any exit code the CLI itself produces. Nonzero, so a
# caller that does NOT special-case it (the nightly merge) still hard-aborts.
AI_UNAVAILABLE_EXIT=99

# What kind of run is being aborted, and how the operator recovers. Consumers
# override before calling; the defaults describe the nightly merge.
AI_RUN_CONTEXT="${AI_RUN_CONTEXT:-merge}"
AI_RUN_RECOVERY="${AI_RUN_RECOVERY:-baseline untouched; will retry next night. No local fix needed.}"

# How many times a SOFT (transient) condition may be retried in place.
# Consumers that COMMIT whatever the agent leaves behind should set 1 — see the
# rationale where scripts/ci-repair.sh sets it.
AI_RUN_MAX_TRIES="${AI_RUN_MAX_TRIES:-3}"
if ! [[ "$AI_RUN_MAX_TRIES" =~ ^[1-9][0-9]*$ ]]; then
  echo "::error::ai-run.sh: AI_RUN_MAX_TRIES must be a positive integer (got '$AI_RUN_MAX_TRIES') — a zero or malformed bound would skip the loop entirely and report success the CLI never delivered."
  exit 1
fi

die_ai_unavailable() {
  # $1 = call-site label, $2 = the CLI line that proved it
  echo "::error::(AI-UNAVAILABLE) Claude CLI unavailable during $1 (\"$2\") — not a ${AI_RUN_CONTEXT} failure; ${AI_RUN_RECOVERY}"
  exit "$AI_UNAVAILABLE_EXIT"
}

ai_backoff() {
  local s=$((30 * $1))
  echo "Backing off ${s}s before the next AI attempt…"
  sleep "$s"
}

# Install the CLI only when it is not already on PATH. Callers used to
# reinstall per attempt (the REFERR-REPAIR loop did it every round). A failed
# install is an AI-unavailable condition like any other — never a verdict about
# the merge or the build.
ensure_claude() {
  command -v claude >/dev/null 2>&1 && return 0
  npm install -g @anthropic-ai/claude-code \
    || die_ai_unavailable "claude CLI install" "npm install -g @anthropic-ai/claude-code failed"
}

# run_claude <label> <prompt>
# Streams AND captures the CLI's output, retries transient API conditions in
# place with backoff, hard-aborts the run when the CLI never reached the model,
# and otherwise returns the CLI's own exit code so callers keep their own
# bounded-retry semantics.
# Backoff lives HERE and only here: a caller only ever regains control on
# success or on a failure carrying no transient signature, so an outer sleep
# would wait out a condition that cannot be in effect.
run_claude() {
  local label="$1" prompt="$2" log rc hit try lines bytes errexit_was_on=0
  case $- in *e*) errexit_was_on=1 ;; esac
  log="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/claude-${label}.log"
  for ((try = 1; try <= AI_RUN_MAX_TRIES; try++)); do
    set +e
    claude --dangerously-skip-permissions --model claude-opus-5 --effort high -p "$prompt" 2>&1 | tee "$log"
    rc=${PIPESTATUS[0]}
    if [ "$errexit_was_on" -eq 1 ]; then set -e; fi
    # The CLI reached the model and succeeded: the log is model prose, never a
    # diagnosis. Return without looking at it — this repo's own source
    # discusses these very phrases, and an agent narrating "please run /login"
    # after a good run must not abort anything.
    if [ "$rc" -eq 0 ]; then
      return 0
    fi
    # The CLI itself never executed (missing from PATH after a failed install,
    # or not executable) — no signature to match.
    if [ "$rc" -eq 126 ] || [ "$rc" -eq 127 ]; then
      die_ai_unavailable "$label" "claude CLI did not execute (exit $rc)"
    fi
    # Failed with NOTHING on stdout/stderr: a working CLI always says why.
    # Unclassifiable, so never report it as a merge/repair verdict.
    if ! grep -q '[^[:space:]]' "$log"; then
      die_ai_unavailable "$label" "claude exited $rc with no output"
    fi
    # Too much output to be a transport diagnosis — the model ran and produced
    # prose. A real attempt: hand the exit code back unclassified.
    read -r lines bytes < <(wc -lc < "$log")
    if [ "$lines" -gt "$AI_LOG_MAX_LINES" ] || [ "$bytes" -gt "$AI_LOG_MAX_BYTES" ]; then
      echo "claude exited $rc after producing ${lines} lines / ${bytes} bytes — model output, not an infrastructure signature; treating as a real attempt."
      return "$rc"
    fi
    hit=$(grep -m1 -iE "$AI_HARD_RE" "$log" || true)
    if [ -n "$hit" ]; then
      die_ai_unavailable "$label" "$hit"
    fi
    # No transient signature either: a real attempt that failed. Hand the exit
    # code back and let the caller's own loop decide.
    hit=$(grep -m1 -iE "$AI_SOFT_RE" "$log" || true)
    if [ -z "$hit" ]; then
      return "$rc"
    fi
    if [ "$try" -lt "$AI_RUN_MAX_TRIES" ]; then
      echo "transient Claude CLI condition during ${label} (rc=$rc): ${hit}"
      ai_backoff "$try"
    fi
  done
  # Every try burned on a transient condition — the only way out of the loop.
  die_ai_unavailable "$label" "$hit"
}
