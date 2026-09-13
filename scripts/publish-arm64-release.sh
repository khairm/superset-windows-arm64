#!/usr/bin/env bash
# Publish (or skip) the desktop-v<version> Release. Run from repo root after a
# verified build. Env: PUBLISH ('true' to publish), GH_TOKEN, GITHUB_REPOSITORY.
set -euo pipefail

if [ "${PUBLISH:-false}" != "true" ]; then
  echo "PUBLISH != true - skipping release publish."
  exit 0
fi

V=$(node -p "require('./apps/desktop/package.json').version")
[ -n "$V" ] || { echo "::error::could not read apps/desktop/package.json version"; exit 1; }
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
shopt -s nullglob
INSTALLERS=(apps/desktop/release/*.exe)
[ "${#INSTALLERS[@]}" -eq 1 ] && [ -s "${INSTALLERS[0]}" ] || {
  echo "::error::expected exactly one non-empty installer in apps/desktop/release/"; exit 1;
}
A=${INSTALLERS[0]}
NAME=${A##*/}
SIZE=$(wc -c < "$A" | tr -d '[:space:]')
HASH=$(sha256sum "$A" | cut -d ' ' -f1)
TAG="desktop-v${V}"
BUILT_SHA=$(git rev-parse HEAD)
TMP=$(mktemp -d "${RUNNER_TEMP:?RUNNER_TEMP is required}/publish-arm64.XXXXXX")
trap 'rm -rf "$TMP"' EXIT
LAST_ERROR="release verification did not complete"

# Capture errors without shell tracing or credentials in command URLs.
run() {
  if "$@" > "$TMP/out" 2> "$TMP/error"; then return 0; fi
  LAST_ERROR=$(cat "$TMP/error" "$TMP/out")
  [ -n "$LAST_ERROR" ] || LAST_ERROR="command failed without an error message: $1"
  if grep -Eiq 'HTTP[^0-9]*4[0-9][0-9]|status code[^0-9]*4[0-9][0-9]' "$TMP/error" "$TMP/out"; then
    # A missing release during cleanup is harmless, but absence still needs proof.
    if [ "$1" = gh ] && [ "${2:-}" = api ] && [ "${3:-}" = --method ] &&
       [ "${4:-}" = DELETE ] && grep -Eq '404' "$TMP/error" "$TMP/out"; then return 0; fi
    PERMANENT=true
  elif [ "$1" = git ] && [ "${2:-}" = push ] && [ "${3:-}" = --delete ] &&
       grep -Fq 'remote ref does not exist' "$TMP/error"; then
    return 0 # Still require a successful remote absence read below.
  elif grep -Eiq 'HTTP[^0-9]*5[0-9][0-9]|status code[^0-9]*5[0-9][0-9]|connection reset|timed? ?out|timeout|ECONNRESET|ETIMEDOUT|forcibly closed|broken pipe|unexpected EOF|EOF$|GOAWAY|i/o timeout' "$TMP/error"; then
    TRANSIENT=true
  else
    PERMANENT=true
  fi
  return 1
}

# Enumerate drafts too. Never infer completeness from targetCommitish: it can
# name a moving branch. Give missing server digests bounded time to appear.
classify_once() {
  STATE=UNKNOWN
  IDS=""
  # Only a recognized transient error authorizes retrying an unknown read.
  run gh api --paginate --slurp "repos/$GITHUB_REPOSITORY/releases" || return 0
  if ! jq -e --arg tag "$TAG" '
    if type != "array" or any(.[]; type != "array") then error("invalid release pages") else add // [] end
    | if any(.[]; (.tag_name | type) != "string") then error("invalid release") else . end
    | map(select(.tag_name == $tag))
    | if any(.[]; (.id | type) != "number" or (.draft | type) != "boolean"
        or (.prerelease | type) != "boolean" or (.assets | type) != "array")
      then error("invalid matching release") else . end
  ' "$TMP/out" > "$TMP/releases" 2> "$TMP/error"; then
    LAST_ERROR="invalid release API response: $(cat "$TMP/error")"
    PERMANENT=true
    return
  fi
  IDS=$(jq -br '.[].id' "$TMP/releases" | tr -d '\r')
  if [ -z "$IDS" ]; then STATE=ABSENT; return; fi
  STATE=INCOMPLETE
  STATE=$(jq -r --arg name "$NAME" --arg digest "sha256:$HASH" --argjson size "$SIZE" '
    if length == 1 and (.[0] | .draft == false and .prerelease == false
      and (.published_at | type) == "string"
      and ([.assets[] | select(.name == $name)]
        | length == 1 and (.[0] | .size == $size and .state == "uploaded")))
    then (.[0].assets[] | select(.name == $name) | .digest
      | if . == $digest then "COMPLETE"
        elif . == null or . == "" then "PENDING_DIGEST"
        else "INCOMPLETE" end)
    else "INCOMPLETE" end
  ' "$TMP/releases" | tr -d '\r')
}

classify() {
  local reread
  classify_once
  for reread in 1 2 3; do
    [ "$STATE" = PENDING_DIGEST ] || return 0
    sleep 10
    classify_once
  done
  if [ "$STATE" = PENDING_DIGEST ]; then STATE=INCOMPLETE; fi
}

# (NIGHTLY-INTEGRITY) Resolve both lightweight and annotated remote tags to
# their commit. Git pushes the built sha; the releases API must not create tags.
read_tag() {
  run git ls-remote origin "refs/tags/$TAG" "refs/tags/$TAG^{}" || return 1
  REMOTE_TAG_SHA=$(awk '/\^\{\}$/ { peeled=$1; next } { direct=$1 } END { print peeled ? peeled : direct }' "$TMP/out")
}
verify_tag() {
  read_tag || return 1
  if [ "$REMOTE_TAG_SHA" != "$BUILT_SHA" ]; then
    LAST_ERROR="release tag $TAG points at ${REMOTE_TAG_SHA:-<missing>}, expected built commit $BUILT_SHA"
    PERMANENT=true
    return 1
  fi
}

publish_attempt() {
  local id
  if [ "$STATE" != ABSENT ]; then
    for id in $IDS; do
      if run gh api --method DELETE "repos/$GITHUB_REPOSITORY/releases/$id"; then
        DELETED=true
      fi
    done
    classify
  fi
  [ "$PERMANENT" = false ] || return 1
  [ "$STATE" = ABSENT ] || { LAST_ERROR="release cleanup not confirmed: $STATE. $LAST_ERROR"; return 1; }
  run git push --delete origin "refs/tags/$TAG" || true
  # Delete can report an error after succeeding, or because the tag was absent.
  # Only the remote read proves the deletion succeeded; 4xx still fails loud.
  read_tag || return 1
  if [ -n "$REMOTE_TAG_SHA" ]; then
    LAST_ERROR="remote tag deletion not confirmed. $LAST_ERROR"; return 1
  fi
  [ "$PERMANENT" = false ] || return 1
  run git push origin "$BUILT_SHA:refs/tags/$TAG" || return 1
  verify_tag || return 1
  run gh release create "$TAG" "$A" --verify-tag \
    --repo "$GITHUB_REPOSITORY" \
    --title "Superset $V (Windows ARM64)" \
    --notes "Native **Windows ARM64** build of the vendored superset-sh/superset fork (version $V). Built deterministically from committed source; failures are AI-repaired in a bounded loop and every deterministic gate re-runs on the repaired tree. Installer is **unsigned**. Not the official superset-sh distribution."
}

# Every attempt starts with a fresh read, so UNKNOWN never authorizes deletion.
# Verify after every attempt, even an errored final upload: GitHub may have
# completed the upload before the connection failed.
for attempt in 1 2 3; do
  PERMANENT=false
  TRANSIENT=false
  DELETED=false
  PUBLISHED=false
  classify
  if [ "$STATE" = COMPLETE ]; then
    if verify_tag; then echo "Release $TAG published at $BUILT_SHA."; exit 0; fi
  elif [ "$STATE" != UNKNOWN ]; then
    if publish_attempt; then PUBLISHED=true; fi
  fi
  classify
  if [ "$STATE" = COMPLETE ]; then
    if verify_tag; then echo "Release $TAG published at $BUILT_SHA."; exit 0; fi
  elif [ "$STATE" = ABSENT ] && [ "$PUBLISHED" = true ]; then
    LAST_ERROR="release $TAG is absent: the release list did not show it after create reported success"
  elif [ "$STATE" = INCOMPLETE ]; then
    LAST_ERROR="release is incomplete or its installer name, size or SHA-256 digest does not match. $LAST_ERROR"
  fi
  # Captured API output must not introduce workflow commands or unbounded logs.
  LAST_ERROR=$(printf '%s' "$LAST_ERROR" | tr '\r\n' '  ' | sed 's/^\([[:space:]]*::\)*//')
  LAST_ERROR=${LAST_ERROR:0:2000}
  # After deletion, even an unclassified failure needs a fresh bounded attempt.
  if { [ "$DELETED" = false ] && { [ "$PERMANENT" = true ] || [ "$TRANSIENT" != true ]; }; } ||
     [ "$attempt" -eq 3 ]; then
    echo "::error::could not publish $TAG after attempt $attempt: $LAST_ERROR"
    exit 1
  fi
  echo "::warning::publish attempt $attempt failed: $LAST_ERROR"
  if [ "$attempt" -eq 1 ]; then sleep 15; else sleep 60; fi
done
