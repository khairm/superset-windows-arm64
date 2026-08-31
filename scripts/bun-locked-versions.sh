#!/usr/bin/env bash
# Sourceable helper: the version(s) of a package that bun.lock RESOLVES TO.
#
# Why this exists: node_modules/.bun is a CACHE of every version any install in
# this checkout ever needed, not a picture of the current graph. Right now it
# holds @agentclientprotocol/sdk@1.2.0, which the current lockfile does not
# reference at all. Choosing a native's version out of that store — highest
# sorted entry wins — hands a companion release tag or an Electron ABI for a
# version the app never links to: the build stays green and the shipped binary
# refuses to load on the user's machine. `bun why` reads the LOCKFILE, so it
# answers the question the packaging steps are actually asking. Nothing here
# looks at, sorts or falls back to the store.
#
# Contract. $ROOT must name the repo root (bun runs there); `bun` is invoked
# through `command bun why` so a shell function or alias cannot stand in for it.
#   rc 0  stdout is one or more UNIQUE strict-semver versions, one per line.
#   rc 1  the package is not in the lockfile — Bun's exact "No packages
#         matching '<pkg>' found in lockfile". The ONLY skippable outcome (the
#         dep is aliased to another name, or absent). A caller that needs the
#         package must still treat it as fatal; bun_locked_version_one, which
#         exists only for such callers, says so on stderr and still returns 1.
#   rc 2  everything else, always fatal and never a fallback: bun failed, its
#         output no longer matches the format parsed here, a success printed no
#         version header, a version is not strict semver, a version repeats, or
#         bun_locked_version_one found more than one version.
#
# Build metadata (1.2.3+meta) is rejected as invalid on purpose: the Bun store
# spells a dedupe variant `name@version+<16 hex>`, so a version carrying its own
# `+` makes that directory name ambiguous. Fail loud rather than guess.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  echo "::error::(NATIVE-VERSION) $0 is a sourceable helper, not a command" >&2
  exit 2
fi

_blv_err() { echo "::error::(NATIVE-VERSION) $*" >&2; }

# All versions of $1 in the lockfile. See the contract above for rc 0/1/2.
bun_locked_versions_all() {
  local pkg="${1:-}" out="" errtxt="" errfile="" versions="" absent="" rc=0

  if [ "$#" -ne 1 ] || [ -z "$pkg" ]; then
    _blv_err "bun_locked_versions_all takes exactly one package name"
    return 2
  fi
  if [ -z "${ROOT:-}" ] || [ ! -d "${ROOT:-}" ]; then
    _blv_err "ROOT is not set to the repo root — refusing to guess which bun.lock to read"
    return 2
  fi
  # Validated before it reaches bun or awk: every step downstream compares this
  # name as plain text, and a name carrying shell or regex metacharacters has no
  # business in a lockfile query.
  if ! [[ "$pkg" =~ ^(@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$ ]]; then
    _blv_err "not a usable npm package name: '$pkg'"
    return 2
  fi

  errfile="$(mktemp)" || { _blv_err "mktemp failed"; return 2; }
  out="$(cd "$ROOT" && command bun why "$pkg" 2>"$errfile")" || rc=$?
  errtxt="$(cat "$errfile")"
  rm -f "$errfile"

  # Bun 1.3.14 prints the absence line on STDOUT with rc 1. Both streams are
  # checked so a future bun moving it to stderr stays a skip instead of
  # becoming an unparsable-output abort.
  absent="error: No packages matching '$pkg' found in lockfile"
  if [ "$rc" -ne 0 ] && { [ "$out" = "$absent" ] || [ "$errtxt" = "$absent" ]; }; then
    return 1
  fi
  if [ "$rc" -ne 0 ]; then
    _blv_err "bun why $pkg failed (rc $rc): ${out:-$errtxt}"
    return 2
  fi

  # bun why prints one unindented "<pkg>@<version>" header per resolved version
  # and indents every dependent row beneath it. Anything else at column 0 is
  # format drift, and guessing past drift is how a wrong version gets shipped.
  versions="$(printf '%s\n' "$out" | awk -v pkg="$pkg" '
    BEGIN { pre = pkg "@"; n = length(pre); cnt = 0; bad = "" }
    /^[[:space:]]/ { next }
    /^$/           { next }
    {
      if (substr($0, 1, n) != pre) { bad = "unexpected line at column 0: " $0; exit 2 }
      v = substr($0, n + 1)
      if (v !~ /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$/) {
        bad = "not a strict semver version: " $0; exit 2
      }
      if (v in seen) { bad = "version listed twice: " v; exit 2 }
      seen[v] = 1; cnt++
      print v
    }
    END {
      if (bad != "") { print "  " bad > "/dev/stderr"; exit 2 }
      if (cnt == 0)  { print "  bun why printed no version header" > "/dev/stderr"; exit 2 }
    }
  ')" || { _blv_err "bun why $pkg output does not parse — refusing to guess a version"; return 2; }

  printf '%s\n' "$versions"
}

# The single version of $1 in the lockfile, for callers that REQUIRE the package
# (a release tag, an Electron ABI). Anything other than exactly one is fatal to
# them, so every non-zero outcome is reported here rather than silently.
bun_locked_version_one() {
  local pkg="${1:-}" versions="" count=0 rc=0

  versions="$(bun_locked_versions_all "$pkg")" || rc=$?
  if [ "$rc" -eq 1 ]; then
    _blv_err "$pkg is not in bun.lock — this build cannot pick a version for it"
    return 1
  fi
  [ "$rc" -eq 0 ] || return "$rc"

  count="$(printf '%s\n' "$versions" | wc -l | tr -d '[:space:]')"
  if [ "$count" -ne 1 ]; then
    _blv_err "bun.lock resolves $count versions of $pkg ($(printf '%s' "$versions" | tr '\n' ' ')) — this build needs exactly one"
    return 2
  fi

  printf '%s\n' "$versions"
}
