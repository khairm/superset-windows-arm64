#!/usr/bin/env bash
# (AI-UNAVAILABLE) Quiet-no-op conversion + consecutive-outage escalation for
# the nightly merge.
#
# SOURCE this file AFTER scripts/ai-run.sh; it defines functions and constants
# and has NO side effects on source beyond validating its own configuration.
# Consumer: the nightly merge (.github/workflows/nightly-merge.yml). The build
# repair loop deliberately does NOT use it — a failed build is real news even
# when the repair agent's CLI was down.
#
# WHY THIS EXISTS. ai-run.sh already tells "the model ran and did not succeed"
# apart from "the CLI never reached the model" and aborts the latter with exit
# AI_UNAVAILABLE_EXIT. But an aborted run still CONCLUDES FAILURE, and GitHub
# emails on failure — so a weekly usage cap mailed the maintainer a red nightly
# every night of the outage, for a night that merged, built and published
# nothing. A run aborted ONLY by a PROVEN outage (ai_unavailable_proven) is
# therefore converted to a loud-but-GREEN no-op: ::notice:: + step summary +
# should_build=false, baseline untouched, retry tomorrow. Any other exit — and
# any 99 the wrapper did not declare — passes through red.
#
# BOTH DIRECTIONS NEED PROOF. Going green must not turn a permanent problem
# (revoked CLAUDE_CODE_OAUTH_TOKEN, cancelled plan) into permanent silence, so
# consecutive blocked NIGHTS are counted and the threshold fails RED. That
# backstop is only as good as its counter, so the counter is cleared only when
# ai_model_reached proves the CLI got through — never merely because tonight
# exited non-99. Otherwise one unrelated flake during a dead-credential week
# (an upstream fetch timeout, a runner death before the AI even runs) would zero
# the count and starve the escalation forever. Consequence, deliberate: a night
# that never needed the AI (nothing new upstream) touches the store not at all.
#
# NIGHTS, NOT RUNS. The counter stores the UTC date it last counted and moves
# only when that date is not today: seven dispatches on one blocked afternoon
# are one blocked night and must not escalate.
#
# THE STORE. A repo Actions variable is NOT usable: the workflow `permissions:`
# block has no `variables` scope (docs enumerate actions, attestations, checks,
# contents, deployments, discussions, id-token, issues, packages, pages,
# pull-requests, security-events, statuses, …), and the variables REST API
# requires a classic PAT with `repo` scope / collaborator access — i.e. another
# secret to provision and rotate. The counter therefore lives on a dedicated
# ref, AI_STREAK_REF, holding one line "<count> <UTC-date>", written with the
# SAME contents:write credential that already pushes candidate branches, as a
# single orphan commit built with plumbing (hash-object/mktree/commit-tree) so
# it never touches the index or work tree — the trap fires mid-merge, with a
# staged merge and possibly conflicts in flight.
#
# DELIBERATE TRADE-OFF: a store we cannot READ leaves the stored value ALONE
# and stays green (a transient read failure must never force-push a 1 over a
# real 6); contents we cannot PARSE are warned about, treated as 0 and
# rewritten, which self-heals corruption. Failing red on a store glitch would
# re-create the exact email this exists to prevent. The cost is that a
# permanently broken store also disables the escalation backstop — hence the
# ::warning::, the loudest thing available that does not mail, carrying git's
# own stderr so a ruleset rejection is diagnosable.
#
# This file is listed in FROZEN_GATE_PATHS (scripts/ci-repair.sh) so a build
# repair agent cannot edit the code that decides whether nights go green, and
# carries an `(AI-UNAVAILABLE)` FEATURES.md marker so a merge cannot drop it.

# ai-run.sh owns the outage protocol: the exit code, and the proof helpers this
# file consumes. Nothing here knows how that proof is stored.
if [ -z "${AI_UNAVAILABLE_EXIT:-}" ] || ! declare -F ai_unavailable_proven >/dev/null; then
  echo "::error::ai-streak.sh: source scripts/ai-run.sh first — its outage protocol (AI_UNAVAILABLE_EXIT, ai_unavailable_proven/ai_unavailable_reason/ai_model_reached) is undefined, so this file cannot tell a proven AI outage from a real failure."
  exit 1
fi

# The ref carrying the counter. Deliberately outside refs/heads and refs/tags:
# it is not a branch, must never appear in the branch list, must never be
# merged, and must never fire a push-triggered workflow. GitHub accepts custom
# ref namespaces (this is what `git notes` and git-meta do) and a ref is a GC
# root, so the orphan commit it points at cannot be pruned. If a repository
# ruleset ever rejects the namespace the write warns with git's own message and
# nights stay green; the fix is one env override —
# AI_STREAK_REF=refs/heads/ci-ai-unavailable-streak — which is provably
# pushable with the same credential, at the cost of a scratch branch visible
# while an outage streak is open.
AI_STREAK_REF="${AI_STREAK_REF:-refs/meta/ai-unavailable-streak}"
AI_STREAK_REMOTE="${AI_STREAK_REMOTE:-origin}"
AI_STREAK_FILE_NAME="streak"

# Every remote git call is bounded. The nightly holds a serialised concurrency
# group, so an ls-remote into a black hole would block tomorrow's run too — up
# to the 6h job limit — for a counter not worth one minute.
AI_STREAK_TIMEOUT_S="${AI_STREAK_TIMEOUT_S:-60}"

# Consecutive blocked nights that stop being routine. THIS is the only
# definition of the threshold: 7 is more than a full week of blocked nights, so
# a weekly-cap week (2-3 nights, then a real run) never reaches it and only a
# genuinely dead credential does. Validated at source time (fail fast, loud): a
# malformed bound would either escalate every night or never escalate at all.
AI_UNAVAILABLE_STREAK_THRESHOLD="${AI_UNAVAILABLE_STREAK_THRESHOLD:-7}"
if ! [[ "$AI_UNAVAILABLE_STREAK_THRESHOLD" =~ ^[1-9][0-9]*$ ]]; then
  echo "::error::ai-streak.sh: AI_UNAVAILABLE_STREAK_THRESHOLD must be a positive integer (got '$AI_UNAVAILABLE_STREAK_THRESHOLD')."
  exit 1
fi

# Zero side effects on the store. The workflow sets this from its validated
# rehearse input; the name is ours so the script never reads a caller's vocab.
ai_streak_dry_run() { [ "${AI_STREAK_DRY_RUN:-}" = "true" ]; }

# One warning shape for the whole store: <verb> what failed, <consequence> what
# that costs. git's own stderr is always quoted — a ruleset rejection or a DNS
# failure must be diagnosable from the log alone.
ai_streak_warn() { # $1 = verb phrase, $2 = consequence
  echo "::warning::(AI-UNAVAILABLE) could not $1 the streak store ${AI_STREAK_REF} (git said: ${AI_STREAK_GIT_ERR:-<none>}) — $2"
}

# Run a git command under a timeout, capturing stdout in AI_STREAK_GIT_OUT and,
# only on failure, a one-line summary of stderr in AI_STREAK_GIT_ERR. A timeout
# exits 124 — nonzero like any other unreachable-store outcome, and said so.
ai_streak_git() {
  local errfile rc=0
  errfile="${AI_TMPDIR}/ai-streak-git-err"
  AI_STREAK_GIT_OUT=$(timeout "$AI_STREAK_TIMEOUT_S" git "$@" 2>"$errfile") || rc=$?
  if [ "$rc" -ne 0 ]; then
    AI_STREAK_GIT_ERR=$(tr '\r\n' '  ' < "$errfile" | cut -c1-300)
    [ "$rc" -ne 124 ] || AI_STREAK_GIT_ERR="timed out after ${AI_STREAK_TIMEOUT_S}s. ${AI_STREAK_GIT_ERR}"
  fi
  rm -f "$errfile"
  return "$rc"
}

# Read the store into AI_STREAK_VALUE (count) / AI_STREAK_DATE (UTC date last
# counted) / AI_STREAK_STATE, one of:
#   ok          parsed a count and a date
#   absent      no ref yet — the normal steady state, NOT a warning
#   invalid     ref exists but its content is not "<count> <YYYY-MM-DD>"
#   unreachable could not talk to the remote (warned; caller must not write)
# Results come back in globals, not on stdout, so the caller does not need a
# command-substitution subshell — which would swallow the warnings.
ai_streak_read() {
  local raw count date extra
  AI_STREAK_VALUE=0
  AI_STREAK_DATE=""
  AI_STREAK_STATE=absent
  # ONE round trip: a wildcard refspec succeeds-with-nothing when the ref does
  # not exist yet, so "absent" needs no separate ls-remote. The local ref is
  # dropped first so a stale copy can never be read as tonight's value.
  git update-ref -d "$AI_STREAK_REF" 2>/dev/null || true
  if ! ai_streak_git fetch --no-tags --quiet --force "$AI_STREAK_REMOTE" "+${AI_STREAK_REF}*:${AI_STREAK_REF}*"; then
    AI_STREAK_STATE=unreachable
    ai_streak_warn "reach" "not counting tonight; the consecutive-outage escalation is paused."
    return 0
  fi
  git rev-parse -q --verify "$AI_STREAK_REF" >/dev/null || return 0
  # FIRST line only, and it must be EXACTLY "<count> <YYYY-MM-DD>". Stripping
  # whitespace instead would read a two-line blob "6\n9" as 69, and a bare
  # numeric test would accept "08" — which bash arithmetic then rejects as a
  # bad octal constant, aborting inside the already-disarmed trap and turning
  # tonight RED: the exact email this mechanism exists to prevent. No
  # arithmetic ever touches unvalidated input.
  raw=$(git cat-file -p "${AI_STREAK_REF}:${AI_STREAK_FILE_NAME}" 2>/dev/null | head -1 | tr -d '\r') || raw=""
  read -r count date extra <<< "$raw" || true
  if ! [[ "${count:-}" =~ ^(0|[1-9][0-9]{0,4})$ ]] \
    || ! [[ "${date:-}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] \
    || [ -n "${extra:-}" ]; then
    AI_STREAK_STATE=invalid
    echo "::warning::(AI-UNAVAILABLE) streak store ${AI_STREAK_REF} holds '${raw}', not '<count> <YYYY-MM-DD>' — treating the streak as 0 and rewriting it."
    return 0
  fi
  AI_STREAK_VALUE="$count"
  AI_STREAK_DATE="$date"
  AI_STREAK_STATE=ok
}

# Store "<count> <date>" as a parentless commit — this ref is a counter, not a
# history, so a constant-size force-push is the whole lifecycle. Committer
# identity comes from ambient git config, which the workflow sets in its first
# two lines (and a local rehearsal inherits from the developer's config).
# Never fails the caller: a store we cannot write costs the backstop, not the
# night.
ai_streak_write() { # $1 = count, $2 = date
  local blob tree commit=""
  if ai_streak_dry_run; then
    echo "(REHEARSAL) streak store not written (would be '$1 $2')."
    return 0
  fi
  blob=$(printf '%s %s\n' "$1" "$2" | git hash-object -w --stdin) \
    && tree=$(printf '100644 blob %s\t%s\n' "$blob" "$AI_STREAK_FILE_NAME" | git mktree) \
    && commit=$(git commit-tree "$tree" -m "(AI-UNAVAILABLE) consecutive nights: $1 as of $2 (run ${GITHUB_RUN_ID:-local})") \
    || commit=""
  if [ -z "$commit" ]; then
    AI_STREAK_GIT_ERR="could not build the streak object locally"
    ai_streak_warn "build" "the consecutive-outage escalation is not counting tonight."
    return 0
  fi
  if ! ai_streak_git push --force --quiet "$AI_STREAK_REMOTE" "${commit}:${AI_STREAK_REF}"; then
    ai_streak_warn "write" "the consecutive-outage escalation is not counting; if outages continue this run will keep concluding green. Investigate the store if this repeats."
    return 0
  fi
  echo "Streak store ${AI_STREAK_REF} set to '$1 $2'."
}

# The outage is over: drop the counter. Deleting IS the reset — an absent ref
# reads as 0 — and a delete of a ref that is already gone is a no-op push we
# skip, so the common case costs one round trip.
ai_streak_reset() {
  ai_streak_dry_run && return 0
  if ! ai_streak_git ls-remote "$AI_STREAK_REMOTE" "$AI_STREAK_REF"; then
    ai_streak_warn "reach" "could not clear it; the next outage may escalate early."
    return 0
  fi
  [ -n "$AI_STREAK_GIT_OUT" ] || return 0
  if ! ai_streak_git push --quiet --delete "$AI_STREAK_REMOTE" "$AI_STREAK_REF"; then
    ai_streak_warn "clear" "the next outage may escalate early."
    return 0
  fi
  echo "Streak store ${AI_STREAK_REF} cleared — the CLI provably reached the model this run."
}

ai_streak_install_trap() { trap 'ai_streak_on_exit $?' EXIT; }

# The green no-op. `should_build=false` is not a new mechanism: it is the SAME
# output the two existing no-op sites in nightly-merge.yml write ("Already at
# <baseline> — nothing to merge" and the REHEARSAL exit), so build and advance
# skip through the `needs.merge.outputs.should_build == 'true'` condition that
# was already there.
ai_streak_quiet_noop() { # $1 = streak clause, $2 = CLI reason
  echo "::notice::(AI-UNAVAILABLE) AI unavailable tonight — nothing was merged, built or published, baseline untouched, retrying next night; $1. CLI reason: $2"
  {
    echo "## (AI-UNAVAILABLE) no-op — nothing merged, built or published"
    echo "The Claude CLI never reached the model (usage cap / credential / transport). Baseline untouched; retrying next night."
    echo "CLI reason: $2"
    echo "Streak: $1 — at ${AI_UNAVAILABLE_STREAK_THRESHOLD} consecutive blocked nights the run fails RED for maintainer action."
  } >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
  [ -z "${GITHUB_OUTPUT:-}" ] || echo "should_build=false" >> "$GITHUB_OUTPUT"
  exit 0
}

# EXIT-trap handler. Install with ai_streak_install_trap. Every exit code other
# than a PROVEN AI outage passes through unchanged — real failures stay red and
# keep emailing.
ai_streak_on_exit() {
  local rc="${1:-0}" n today reason
  # Our own exit below re-enters EXIT; and a subshell that inherited the trap
  # must never touch the remote store on the main shell's behalf ($$ stays the
  # main shell's pid, BASHPID does not).
  trap - EXIT
  [ "${BASHPID:-$$}" = "$$" ] || exit "$rc"

  if [ "$rc" -ne "$AI_UNAVAILABLE_EXIT" ] || ! ai_unavailable_proven; then
    if [ "$rc" -eq "$AI_UNAVAILABLE_EXIT" ]; then
      echo "::error::(AI-UNAVAILABLE) the run exited ${rc} WITHOUT ai-run.sh's outage proof — only run_claude/ensure_claude may declare an AI outage, so this is an ordinary failure and stays red. Baseline untouched."
    fi
    # Clearing the streak is a claim that the outage ENDED, and only a CLI that
    # got through proves that. A failure before the AI ever ran proves nothing.
    if ai_model_reached; then
      ai_streak_reset
    else
      echo "(AI-UNAVAILABLE) this run never reached the model — leaving any streak store untouched."
    fi
    exit "$rc"
  fi

  reason=$(ai_unavailable_reason)
  today=$(date -u +%Y-%m-%d)
  ai_streak_read

  # A store we could not READ must never be overwritten: writing 1 over a real
  # 6 would silently restart the escalation clock.
  if [ "$AI_STREAK_STATE" = "unreachable" ]; then
    ai_streak_quiet_noop "not counted tonight (store unreachable, stored value left alone)" "$reason"
  fi

  # Decide the count ONCE — a repeat of a night already counted keeps its
  # number and needs no write at all.
  if [ "$AI_STREAK_DATE" = "$today" ]; then
    n="$AI_STREAK_VALUE"
    echo "This night is already counted (same-day re-run) — streak stays ${n}."
  else
    n=$((AI_STREAK_VALUE + 1))
    ai_streak_write "$n" "$today"
  fi

  if [ "$n" -lt "$AI_UNAVAILABLE_STREAK_THRESHOLD" ]; then
    ai_streak_quiet_noop "consecutive AI-unavailable nights: ${n} of ${AI_UNAVAILABLE_STREAK_THRESHOLD}" "$reason"
  fi

  echo "::error::(AI-UNAVAILABLE) consecutive AI-unavailable nights: ${n} of ${AI_UNAVAILABLE_STREAK_THRESHOLD} — no longer routine (dead credential / permanent quota problem), maintainer action needed. CLI reason: ${reason}. Check CLAUDE_CODE_OAUTH_TOKEN and the account's usage limits, then re-run this workflow. Nothing was merged, built or published; baseline untouched."
  {
    echo "## (AI-UNAVAILABLE) escalated — ${n} consecutive blocked nights"
    echo "The Claude CLI has not reached the model for ${n} nights running (threshold ${AI_UNAVAILABLE_STREAK_THRESHOLD}). That is no longer a weekly-cap week: check \`CLAUDE_CODE_OAUTH_TOKEN\` and the account's usage limits, then re-run."
    echo "CLI reason: ${reason}"
    echo "Nothing was merged, built or published; baseline untouched."
  } >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
  exit "$rc"
}
