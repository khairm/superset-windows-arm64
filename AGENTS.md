# superset-windows-arm64

Public repo: https://github.com/khairm/superset-windows-arm64

A **build-automation repo**, not app source. It produces a native Windows
**ARM64** (`aarch64`) one-click installer of [superset-sh/superset](https://github.com/superset-sh/superset).

## Layout

- `.github/workflows/nightly-build.yml` — nightly: detect new upstream release →
  clone → Claude Code applies `PATCHES.md` → deterministic fixup step (ARM64
  arch, native-closure, source patches A–L incl. `git apply` of `patches/*.patch`)
  → `electron-builder --win --arm64` → publish Release.
- `PATCHES.md` — the Windows-compat patches (AI-applied each night).
- `patches/*.patch` — deterministic `git diff` patches the workflow `git apply`s
  (idempotent + fail-fast). Used for multi-line code fixes too brittle for
  anchor-regex — e.g. `git-storm-fix.patch` (host-service `.git/`-watch
  feedback loop that pegged Windows; measured ~25→~0.2 git spawns/sec).
- `scripts/materialize-native-closure.sh` — deterministic ARM64 native modules.
- `.gitattributes` — forces `*.patch`/`*.sh` to LF; CI `git apply` on the
  Windows runner fails on CRLF.
- `README.md` — user-facing download/build docs.

Upstream app source is **not** in this repo; it's cloned fresh at build time.
Companion repos build the ARM64 native packages consumed at build time:

- https://github.com/khairm/libsql-windows-arm64
- https://github.com/khairm/tokenizers-windows-arm64

## Limitations (known, accepted — don't "fix" silently)

- **Unsigned** installer → Windows SmartScreen warns ("More info" → "Run anyway").
- **Non-deterministic** build: an AI agent applies `PATCHES.md` nightly. It
  **fails loud** (won't ship broken) but a new upstream version can flake — fix
  the patch when it does.
- **Daemon updates can't preserve sessions on Windows.** Upstream gates
  fd-handoff on `IS_WINDOWS` (`DaemonSupervisor.ts`); "Force restart" closes
  open terminals. This is **upstream behaviour, not a fork bug** — leave it.
- Static checks can't prove zero missing native deps; only startup / login /
  terminal / agents are exercised end-to-end.
