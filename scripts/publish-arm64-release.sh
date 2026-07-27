#!/usr/bin/env bash
# Publish (or skip) the desktop-v<version> Release. Run from repo root after a
# verified build. Env: PUBLISH ('true' to publish), GH_TOKEN, GITHUB_REPOSITORY.
set -euo pipefail

if [ "${PUBLISH:-false}" != "true" ]; then
  echo "PUBLISH != true — skipping release publish."
  exit 0
fi

V=$(node -p "require('./apps/desktop/package.json').version")
[ -n "$V" ] || { echo "::error::could not read apps/desktop/package.json version"; exit 1; }

A=$(ls apps/desktop/release/*arm64*.exe 2>/dev/null | head -1 || true)
[ -n "$A" ] || A=$(ls apps/desktop/release/*.exe 2>/dev/null | grep -v blockmap | head -1 || true)
[ -n "$A" ] || { echo "::error::no .exe produced in apps/desktop/release/"; ls -la apps/desktop/release || true; exit 1; }
echo "Installer: $A"

# ONE version per upstream release: desktop-v<version>, rebuilt in place.
# Delete + recreate so the tag always points at the latest build of that
# version. No beta / prerelease split.
TAG="desktop-v${V}"
gh release delete "$TAG" --repo "$GITHUB_REPOSITORY" --yes 2>/dev/null || true
git push --delete origin "refs/tags/$TAG" 2>/dev/null || true
# (NIGHTLY-INTEGRITY) Tag the exact checked-out commit, then prove the remote
# tag landed on it. The tag is pushed via GIT first and the release created on
# the EXISTING tag: `gh release create --target <sha>` uses the releases API,
# and GITHUB_TOKEN may only create a tag there when the sha is a CURRENT
# BRANCH HEAD — a push to main during a long build strips that status from the
# built commit and the create 403s ("Resource not accessible by integration",
# run 29566648149). A plain git tag push has no such restriction. (Without
# explicit tagging at all, gh would tag the default-branch tip — during a
# nightly that's main BEFORE advance, one commit behind the candidate the
# installer was built from.)
BUILT_SHA=$(git rev-parse HEAD)
git push origin "$BUILT_SHA:refs/tags/$TAG"
gh release create "$TAG" "$A" \
  --repo "$GITHUB_REPOSITORY" \
  --title "Superset $V (Windows ARM64)" \
  --notes "Native **Windows ARM64** build of the vendored superset-sh/superset fork (version $V). Built deterministically from committed source; failures are AI-repaired in a bounded loop and every deterministic gate re-runs on the repaired tree. Installer is **unsigned**. Not the official superset-sh distribution."
REMOTE_TAG_SHA=$(git ls-remote origin "refs/tags/$TAG" | cut -f1)
if [ "$REMOTE_TAG_SHA" != "$BUILT_SHA" ]; then
  echo "::error::release tag $TAG points at ${REMOTE_TAG_SHA:-<missing>}, expected built commit $BUILT_SHA"
  exit 1
fi
echo "Release $TAG published at $BUILT_SHA."
