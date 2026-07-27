#!/usr/bin/env bash
# CI build-repair loop engine. Runs on a cheap linux runner after a failed
# ARM64 build attempt: pulls the failed job's log, hands it to an Opus 5 agent
# with the checked-out repair branch, validates the result (no version drift,
# no feature-marker loss, workflow edits only when a workflow-scoped PAT is
# present), commits and pushes. The next build attempt builds the pushed sha,
# so every deterministic gate re-runs on the repaired tree.
#
# Env contract (set by build-arm64.yml):
#   REPO                     owner/name
#   RUN_ID                   current workflow run id
#   ROUND                    repair round number (1 or 2)
#   REPAIR_BRANCH            branch to push the fix to (nightly candidate, or main)
#   GH_TOKEN                 token for gh api log download
#   HAS_WORKFLOW_PAT         'true' iff WORKFLOW_PUSH_TOKEN was provided (push
#                            credential already configured by checkout)
#   CLAUDE_CODE_OAUTH_TOKEN  Claude auth
set -euo pipefail

: "${REPO:?}" "${RUN_ID:?}" "${ROUND:?}" "${REPAIR_BRANCH:?}" "${GH_TOKEN:?}" "${CLAUDE_CODE_OAUTH_TOKEN:?}"

echo "::group::collect failed build log"
JOBS_JSON="$RUNNER_TEMP/run-jobs.json"
gh api "repos/$REPO/actions/runs/$RUN_ID/jobs?per_page=100" > "$JOBS_JSON"
# NOTE: build attempts run with job-level continue-on-error, and GitHub reports
# such jobs with conclusion "success" even when they failed — so select the
# latest COMPLETED build-attempt job by name (this repair job only runs when
# that attempt's `ok` output is unset, i.e. it failed).
FAILED_JOB_ID=$(jq -r '[.jobs[] | select(.status=="completed") | select(.name|test("build-attempt"))] | sort_by(.started_at) | last | .id // empty' "$JOBS_JSON")
FAILED_JOB_NAME=$(jq -r '[.jobs[] | select(.status=="completed") | select(.name|test("build-attempt"))] | sort_by(.started_at) | last | .name // empty' "$JOBS_JSON")
FAILED_STEPS=$(jq -r '[.jobs[] | select(.status=="completed") | select(.name|test("build-attempt"))] | sort_by(.started_at) | last | [.steps[]? | select(.conclusion=="failure") | .name] | join("; ")' "$JOBS_JSON")
[ -n "$FAILED_JOB_ID" ] || { echo "::error::(BUILD-REPAIR) no completed build-attempt job found in run $RUN_ID — nothing to repair"; exit 1; }
LOG_FILE="$RUNNER_TEMP/build-failure.log"
gh api "repos/$REPO/actions/runs/$RUN_ID/jobs/$FAILED_JOB_ID/logs" > "$RUNNER_TEMP/build-failure-full.log" || {
  echo "::error::(BUILD-REPAIR) could not download logs for failed job $FAILED_JOB_ID"; exit 1; }
# Bound what the agent reads: errors first, then the tail for context.
{
  echo "===== failed step(s): ${FAILED_STEPS:-<unknown>} ====="
  echo "===== error/warning lines (grep) ====="
  grep -aiE '::error|error:|FAILED|Traceback|exit code' "$RUNNER_TEMP/build-failure-full.log" | tail -200 || true
  echo ""
  echo "===== last 800 lines of failed job '$FAILED_JOB_NAME' ====="
  tail -800 "$RUNNER_TEMP/build-failure-full.log"
} > "$LOG_FILE"
echo "Failed job: $FAILED_JOB_NAME (id $FAILED_JOB_ID); log at $LOG_FILE ($(wc -l < "$LOG_FILE") lines)"
echo "::endgroup::"

BASE_SHA=$(git rev-parse HEAD)
VERSION_BEFORE=$(node -p "require('./apps/desktop/package.json').version")
git config user.name "superset-fork-ci"
git config user.email "ci@users.noreply.github.com"

echo "::group::install claude"
npm install -g @anthropic-ai/claude-code
echo "::endgroup::"

REPAIR_PROMPT="IMPORTANT: Do NOT enter plan mode. You are the CI build-repair agent for the superset-windows-arm64 vendored fork (a Windows ARM64 fork of superset-sh/superset; see AGENTS.md for architecture). Build attempt $ROUND of the Windows ARM64 installer FAILED. The failed job's log is at: $LOG_FILE — read it, find the root cause, and fix it in this working tree (branch $REPAIR_BRANCH, currently checked out).

Rules:
- Make the MINIMAL fix that makes the build pass while preserving every fork feature. Fix root causes, not symptoms; never delete or stub out functionality to make a step pass.
- Prefer fixing files under scripts/, .github/actions/, source code, or configs — these take effect in the NEXT build attempt of THIS run.
- Only edit .github/workflows/*.yml if the root cause is genuinely in the workflow definition; such a fix takes effect NEXT run only (this run's workflow graph is frozen), so if you do that, ALSO mitigate within the repo files if at all possible.
- NEVER change the version in apps/desktop/package.json.
- NEVER weaken, remove, or rename any feature marker tracked in FEATURES.md, and never edit FEATURES.md itself.
- Respect the fork's live footguns listed in AGENTS.md (no sync fs at startup, screenReaderMode stays false, WS_NO_BUFFER_UTIL, pipeline-free hook templates).
- Do NOT run git commit, git push, or any other git state-changing command; leave your edits in the working tree — the harness commits and pushes.
- If the log shows an infrastructure-only failure (runner outage, network flake, rate limit) with NOTHING to fix in the repo, create the file .fork/repair-retry-only (content: one line explaining why) and change nothing else — the harness will retry the build as-is.
When done, stop. Output a one-paragraph summary of the root cause and your fix."

echo "::group::claude repair round $ROUND"
claude --dangerously-skip-permissions --model claude-opus-5 --effort high -p "$REPAIR_PROMPT" || true
echo "::endgroup::"

# Commit whatever the agent left (it is told not to commit; tolerate if it did).
git add -A
RETRY_ONLY=false
if [ -f .fork/repair-retry-only ]; then
  RETRY_ONLY=true
  echo "(BUILD-REPAIR) agent judged the failure infrastructure-only: $(cat .fork/repair-retry-only)"
  git reset --hard "$BASE_SHA" >/dev/null
elif ! git diff --cached --quiet || [ "$(git rev-parse HEAD)" != "$BASE_SHA" ]; then
  if ! git diff --cached --quiet; then
    git commit -m "fix(ci): AI build repair round $ROUND for run $RUN_ID" \
               -m "Automated repair of failed job '$FAILED_JOB_NAME' by the (BUILD-REPAIR) loop (claude-opus-5, effort high). All deterministic gates re-run on this tree in the next build attempt."
  fi
else
  echo "::error::(BUILD-REPAIR) agent made no changes and did not declare retry-only — cannot repair. Failing loud."
  exit 1
fi

if [ "$RETRY_ONLY" != "true" ]; then
  echo "::group::validate repair"
  VERSION_AFTER=$(node -p "require('./apps/desktop/package.json').version")
  if [ "$VERSION_AFTER" != "$VERSION_BEFORE" ]; then
    echo "::error::(BUILD-REPAIR) repair changed app version ($VERSION_BEFORE -> $VERSION_AFTER) — forbidden (breaks the one-version release invariant). Failing loud."
    exit 1
  fi
  if ! git diff --quiet "$BASE_SHA" HEAD -- FEATURES.md; then
    echo "::error::(BUILD-REPAIR) repair edited FEATURES.md — forbidden. Failing loud."
    exit 1
  fi
  node scripts/check-feature-markers.mjs
  if ! git diff --quiet "$BASE_SHA" HEAD -- .github/workflows; then
    if [ "${HAS_WORKFLOW_PAT:-false}" != "true" ]; then
      echo "::error::(BUILD-REPAIR) repair touches .github/workflows but no WORKFLOW_PUSH_TOKEN secret is configured — GITHUB_TOKEN cannot push workflow changes (platform limit). Add a fine-grained PAT with Contents+Workflows write as WORKFLOW_PUSH_TOKEN, or fix manually."
      exit 1
    fi
    echo "(BUILD-REPAIR) repair includes .github/workflows changes — pushing with the workflow-scoped PAT; they take effect NEXT run."
  fi
  echo "::endgroup::"

  echo "::group::push repair"
  # Plain fast-forward push (checkout configured the credential). The nightly
  # candidate is only ever advanced by this loop mid-run; main may have moved —
  # a non-ff rejection here is a real conflict and must fail loud.
  git push origin "HEAD:refs/heads/$REPAIR_BRANCH"
  echo "::endgroup::"
fi

FINAL_SHA=$(git rev-parse HEAD)
{
  echo "repaired=true"
  echo "sha=$FINAL_SHA"
  echo "retry_only=$RETRY_ONLY"
} >> "$GITHUB_OUTPUT"
echo "(BUILD-REPAIR) round $ROUND complete: retry_only=$RETRY_ONLY sha=$FINAL_SHA (base was $BASE_SHA)"
