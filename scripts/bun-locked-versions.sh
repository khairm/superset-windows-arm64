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
#         A caller that can genuinely skip uses bun_locked_version_optional,
#         which makes bun.lock confirm the absence before handing back rc 1.
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
  local pkg="${1:-}" versions="" rc=0

  versions="$(bun_locked_versions_all "$pkg")" || rc=$?
  if [ "$rc" -eq 1 ]; then
    _blv_err "$pkg is not in bun.lock — this build cannot pick a version for it"
    return 1
  fi
  [ "$rc" -eq 0 ] || return "$rc"

  _blv_exactly_one "$pkg" "$versions"
}

# The one version out of $2 (the lines bun_locked_versions_all printed for $1),
# or rc 2. Shared so the required and optional resolvers below cannot drift into
# disagreeing about what "one version" means.
_blv_exactly_one() {
  local pkg="$1" versions="$2" count=0

  count="$(printf '%s\n' "$versions" | wc -l | tr -d '[:space:]')"
  if [ "$count" -ne 1 ]; then
    _blv_err "bun.lock resolves $count versions of $pkg ($(printf '%s' "$versions" | tr '\n' ' ')) — this build needs exactly one"
    return 2
  fi

  printf '%s\n' "$versions"
}

# Every shape bun.lock can name $1 in, matched lines printed when it does.
#   rc 0  the lockfile names it
#   rc 1  the lockfile names it in none of these shapes
#   rc 2  no lockfile, or the search itself failed
#
# Fixed strings, each anchored on the opening quote so a longer name cannot
# match a shorter one: `"libsql@` never matches `"@libsql/client@`, and
# `"@anush008/tokenizers@` never matches its `-win32-x64-msvc` sibling.
#   "<pkg>@       the canonical `"key": ["<pkg>@<ver>", …]` tuple, which is
#                 also how a key ALIASED onto it resolves (bun.lock spells
#                 that `"node-pty": ["@lydell/node-pty@1.1.0", …]`)
#   "npm:<pkg>@   a dependency declaring it under another name
#                 (`"node-pty": "npm:@lydell/node-pty@^1.0.1"`)
#   "<pkg>":      a declaration map entry (a workspace's or a package's deps)
# A bare `"<pkg>"` inside an array — how the `optionalPeers` list spells names —
# matches none of them on purpose: named there and nowhere else, that is a
# mention with no resolution behind it. The `peerDependencies` map beside it is
# what decides. An exact `"<pkg>": "<range>"` key there DOES match the third
# pattern, so a package something installed still peer-declares aborts (rc 2)
# rather than skipping. Conservative on purpose: an unexplained mention is not
# proof the package is gone.
_blv_lock_mentions() {
  local pkg="$1" lock="${ROOT:-}/bun.lock" hits="" rc=0

  [ -f "$lock" ] || { _blv_err "no lockfile at $lock — it cannot confirm anything about $pkg"; return 2; }
  hits="$(grep -n -F -e "\"$pkg@" -e "\"npm:$pkg@" -e "\"$pkg\":" -- "$lock")" || rc=$?
  case "$rc" in
    0) printf '%s\n' "$hits"; return 0 ;;
    1) return 1 ;;
    *) _blv_err "searching $lock for $pkg failed (grep rc $rc) — refusing to read a failed search as an answer"; return 2 ;;
  esac
}

# Does bun.lock agree that $1 is gone? rc 0 = yes, rc 2 = not proven (fatal).
_blv_absence_is_real() {
  local pkg="$1" control=electron hits="" rc=0

  # Positive control first, because the interesting result here is zero hits and
  # a search that no longer works also returns zero. Electron is a package this
  # build cannot lose (it is what gets packaged), so it must both resolve and be
  # visible to the probe. If it is not, bun or the lockfile format moved under
  # us and nothing below is evidence of anything.
  bun_locked_version_one "$control" >/dev/null \
    || { _blv_err "positive control: $control does not resolve either — an absent $pkg proves nothing"; return 2; }
  _blv_lock_mentions "$control" >/dev/null || rc=$?
  if [ "$rc" -ne 0 ]; then
    if [ "$rc" -eq 1 ]; then
      _blv_err "positive control: bun.lock never names $control in any shape searched — the lockfile format moved; refusing to read a missing $pkg as absent"
    fi
    return 2
  fi

  rc=0
  hits="$(_blv_lock_mentions "$pkg")" || rc=$?
  case "$rc" in
    1) return 0 ;;
    0)
      _blv_err "bun why says $pkg is absent but bun.lock still names it — graph and lockfile disagree; refusing to skip its native:"
      printf '%s\n' "$hits" | sed 's/^/  /' >&2
      return 2 ;;
    *) return 2 ;;
  esac
}

# Is every package that PULLS $1 IN gone too? rc 0 = yes, rc 2 = no (fatal).
#
# A package vanishing while something that depends on it stays is not an upstream
# removal, it is an inconsistent lockfile — and skipping the native there ships an
# installer whose consumer is still present and still loads it. So each consumer a
# caller names is asked of BOTH sources the package itself was: the graph
# (bun_locked_versions_all — any version resolving is a contradiction) and then
# bun.lock (_blv_lock_mentions: canonical tuple, `npm:` alias, declaration key).
# Either one still holding a consumer is fatal rather than skippable, and a
# failure of either probe is fatal too.
_blv_consumers_gone() { # $1 = the absent pkg; $2.. = packages that pull it in
  local pkg="$1" consumer="" hits="" rc=0
  shift

  for consumer in "$@"; do
    rc=0
    bun_locked_versions_all "$consumer" >/dev/null || rc=$?
    case "$rc" in
      1) ;;
      0)
        _blv_err "bun why says $pkg is gone but the graph still resolves $consumer, which pulls it in — refusing to skip a native its consumer still loads"
        return 2 ;;
      *) return 2 ;;
    esac

    rc=0
    hits="$(_blv_lock_mentions "$consumer")" || rc=$?
    case "$rc" in
      1) ;;
      0)
        _blv_err "bun.lock agrees $pkg is gone but still names $consumer, which pulls it in — refusing to skip a native its consumer still loads:"
        printf '%s\n' "$hits" | sed 's/^/  /' >&2
        return 2 ;;
      *) return 2 ;;
    esac
  done
  return 0
}

# The single version of $1 for callers that inject a native FOR it but can live
# without it — upstream is free to drop the dependency, and then there is no
# native to fetch, no payload to inject and nothing to verify. $2.. are the
# packages that pull $1 in, and they have to be gone too.
#
#   rc 0  one version on stdout, exactly as bun_locked_version_one.
#   rc 1  PROVEN absent: skip it.
#   rc 2  fatal, as ever.
#
# Proven, because `bun why` alone is not proof and the cost of a wrong skip is
# an installer quietly shipped without a native the app loads. So an absence is
# re-asked of bun.lock directly (see _blv_lock_mentions) and ANY mention of the
# package there — a resolution, an alias onto it, a dependency declaring it —
# contradicts bun and is fatal instead of skippable. Same again for every named
# consumer: the package is only really gone when nothing that needs it is left.
bun_locked_version_optional() {
  local pkg="${1:-}" versions="" rc=0
  [ "$#" -eq 0 ] || shift

  versions="$(bun_locked_versions_all "$pkg")" || rc=$?
  if [ "$rc" -eq 0 ]; then
    _blv_exactly_one "$pkg" "$versions"
    return
  fi
  [ "$rc" -eq 1 ] || return "$rc"

  _blv_absence_is_real "$pkg" || return 2
  _blv_consumers_gone "$pkg" "$@" || return 2
  return 1
}
