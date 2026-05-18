# Superset — Windows ARM64

Automated nightly **native Windows ARM64** builds of [Superset](https://github.com/superset-sh/superset) — the terminal/IDE for coding agents.

This is an **ARM64 fork** of the approach in
[`Ashesh3/superset-windows`](https://github.com/Ashesh3/superset-windows) (which builds x64).
It produces a native `aarch64` installer that runs without x64 emulation on Windows on ARM
(Snapdragon X / other ARM64 PCs).

## How it works

1. A GitHub Actions workflow runs nightly at 12:00 AM UTC (also `workflow_dispatch`).
2. Checks if `superset-sh/superset` has a new release this repo hasn't built yet.
3. Clones the upstream release.
4. Uses **Claude Code** to apply the Windows compatibility patches in [`PATCHES.md`](PATCHES.md).
5. A deterministic **`ARM64 arch fixup`** step rewrites the x64 native-module references
   (`@lydell/node-pty-win32-x64` → `@lydell/node-pty-win32-arm64`) with fail-fast assertions,
   so the architecture is correct regardless of LLM non-determinism.
6. Builds the Electron app with native ARM64 Bun and `electron-builder --win --arm64`.
7. Publishes the `Superset-<version>-arm64.exe` installer (and the patched source tarball,
   for review) as a GitHub Release.

## Download

Go to [Releases](../../releases) for the latest **Windows ARM64** installer.

> The installer is **unsigned**, and the build is **non-deterministic** (an AI agent
> applies the patches each night). Each release also ships
> `superset-patched-source.tar.gz` so the exact AI-applied changes can be diffed against
> the official upstream tag.

## Manual build (on a Windows ARM64 machine)

```bash
# Native ARM64 Bun 1.3.10+ required (1.3.5 and older are x64-only and segfault under emulation)
git clone https://github.com/superset-sh/superset.git
cd superset
git config core.longpaths true

# Apply patches with Claude Code:
#   "Read ../superset-windows-arm64/PATCHES.md and apply all patches to this repo"

# ARM64 fixup (the nightly workflow does this deterministically):
#   replace 'node-pty-win32-x64' -> 'node-pty-win32-arm64' in
#   apps/desktop/scripts/copy-native-modules.ts and apps/desktop/electron-builder.ts

bun install
cd apps/desktop
bun run generate:icons
bun run compile:app
TARGET_ARCH=arm64 TARGET_PLATFORM=win32 bun run copy:native-modules
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --win --arm64 --config electron-builder.ts
# Installer: apps/desktop/release/Superset-<version>-arm64.exe
```

## Patches

See [`PATCHES.md`](PATCHES.md) for the full list of Windows compatibility patches and rationale.

## Requirements

- Windows 11 **ARM64** (`aarch64`)
- [Bun](https://bun.sh) **1.3.10+** (native Windows ARM64 build; ships since v1.3.10)
- [Git](https://git-scm.com) 2.20+
- [GitHub CLI](https://cli.github.com) (`gh`)

## CI configuration

The nightly workflow needs one repository secret so Claude Code can apply the patches:

- **`CLAUDE_CODE_OAUTH_TOKEN`** — generate locally with `claude setup-token`, then add it under
  *Settings → Secrets and variables → Actions* (or `gh secret set CLAUDE_CODE_OAUTH_TOKEN`).

The build job runs on the free `windows-11-arm` GitHub-hosted runner (public repos only).

## Attribution

- Upstream application: [superset-sh/superset](https://github.com/superset-sh/superset) (Elastic License 2.0).
- Windows port patches & build approach: [Ashesh3/superset-windows](https://github.com/Ashesh3/superset-windows).
- This fork only adapts that approach to produce native ARM64 artifacts. Not affiliated with or
  endorsed by superset-sh.
