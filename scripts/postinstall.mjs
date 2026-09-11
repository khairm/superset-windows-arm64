/**
 * Cross-platform postinstall script.
 *
 * Replaces the bash-only postinstall.sh so that `bun install` works on
 * Windows, macOS and Linux without special flags.
 *
 * Steps:
 *  1. Guard against infinite recursion (electron-builder install-app-deps
 *     can trigger nested bun installs which would re-run this script).
 *  2. Run sherif for workspace validation.
 *  3. Materialize the compiled Lingui catalogs.
 *  4. Install native dependencies for the desktop app.
 */

import { execSync } from "node:child_process";

// Prevent infinite recursion during postinstall
if (process.env.SUPERSET_POSTINSTALL_RUNNING) {
	process.exit(0);
}
process.env.SUPERSET_POSTINSTALL_RUNNING = "1";

const env = { ...process.env, SUPERSET_POSTINSTALL_RUNNING: "1" };

/** Run a command, inheriting stdio so output is visible. */
function run(cmd) {
	execSync(cmd, { stdio: "inherit", env });
}

/** Run a command but don't fail if it errors (optional native deps, catalogs). */
function tryRun(cmd, label) {
	try {
		execSync(cmd, { stdio: "inherit", env });
	} catch {
		console.warn(`[postinstall] ${label} failed (non-fatal) — continuing`);
	}
}

// Run sherif for workspace validation
run("sherif");

// Materialize the compiled Lingui catalogs. They are generated, not committed
// (upstream stopped committing packages/i18n/locales/*/messages.ts and
// .gitignore now excludes them), and turbo builds them for any task that goes
// through the graph — but a direct `bun run --filter=<pkg> typecheck`, or a
// plain `bun test`, bypasses turbo and hits
// "Cannot find module '../locales/en/messages'" on a fresh clone. Mirrors the
// step upstream added to scripts/postinstall.sh, which this file replaces.
// Non-fatal for the same reason it is there: a missing translation must fail a
// real build, not an install.
tryRun("bun run --filter=@superset/i18n build", "lingui compile");

// Install native dependencies for desktop app.
// On Windows, native module compilation may fail if Visual Studio Build Tools
// are not installed. This is non-fatal — prebuilt binaries will be used when available.
if (process.platform === "win32") {
	tryRun("bun run --filter=@superset/desktop install:deps", "install:deps");
} else {
	run("bun run --filter=@superset/desktop install:deps");
}
