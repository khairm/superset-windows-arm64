/**
 * (LOCK-REGEN) Dependency-consistency gate for the nightly upstream merge.
 *
 * Fails LOUD if a root `package.json` `overrides` entry pins a package to a
 * version DIFFERENT from what a workspace package.json DECLARES for that same
 * package. This is exactly the drift that broke every nightly that bumped
 * mastra:
 *
 *   - upstream bumped packages/chat (+ desktop + host-service) to
 *     `mastracode: 0.18.1` / `@mastra/core: 1.33.1`,
 *   - our fork carried a stale root `overrides.mastracode = 0.18.0` /
 *     `@mastra/core = 1.33.0` (added in the seed commit; upstream has no mastra
 *     override and keeps them consistent via identical exact pins),
 *   - so the override force-installed 0.18.0 while chat DECLARED 0.18.1, and
 *     electron-builder's dependency traversal — which reads the declared pin
 *     and requires that exact version to be present — died 25 min into the
 *     windows-arm64 build with `production dependency not found … version=0.18.1`.
 *
 * The override survives a merge untouched (upstream has no such key to conflict
 * with), so it goes stale silently on every mastra bump. This gate catches it
 * in the cheap merge job, before the expensive build, and leaves the baseline
 * untouched for the recovery loop. Pure manifest analysis — no install needed.
 *
 * Scope: only flags when BOTH the declared pin and the override are EXACT and
 * they differ (the case electron-builder reliably rejects, and the only case
 * bunfig's `exact = true` produces for direct workspace deps). Range/protocol
 * specs (^, ~, workspace:, catalog:, npm:, …) on EITHER side are skipped — a
 * range override is the legitimate reason axios/hono/kysely are overridden at
 * all, and comparing a range by string equality would false-abort a buildable
 * tree.
 *
 * Known blind spot (accepted): an override whose package is declared in NO
 * workspace manifest (a purely transitive override, e.g. axios/kysely today)
 * gets zero coverage here — there is no declared pin to compare against. The
 * mastra break that motivated this gate was a DIRECT workspace dep, so it is
 * covered; a transitive override that conflicts with a transitively-resolved
 * version would still surface only in the build. Extending coverage would mean
 * inspecting the regenerated bun.lock tree, which runs after this gate.
 *
 * Run with cwd = repo root. Exits 1 on any conflict, 0 when clean.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SECTIONS = ["dependencies", "devDependencies", "optionalDependencies"];
const SEARCH_ROOTS = ["apps", "packages", "tooling"];
const SKIP_DIRS = new Set([".git", ".bun", "dist", "node_modules", "release"]);
// An exact semver pin (optionally with prerelease/build metadata). Anything
// else — ranges, workspace:/catalog:/npm: protocols, tags — is not a fixed
// version we can compare to an override, so we leave it alone.
const EXACT = /^\d+\.\d+\.\d+(?:[-+].*)?$/;

function collectManifests(directory, out) {
	if (!existsSync(directory)) return;
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const entryPath = join(directory, entry.name);
		if (entry.isDirectory()) {
			if (!SKIP_DIRS.has(entry.name)) collectManifests(entryPath, out);
		} else if (entry.name === "package.json") {
			out.push(entryPath);
		}
	}
}

const root = JSON.parse(readFileSync("package.json", "utf8"));
const overrides = root.overrides ?? {};
const overrideNames = Object.keys(overrides);

if (overrideNames.length === 0) {
	console.log("override-consistency OK: no root overrides to check.");
	process.exit(0);
}

const files = ["package.json"];
for (const r of SEARCH_ROOTS) collectManifests(r, files);

const conflicts = [];
for (const file of files) {
	let pkg;
	try {
		pkg = JSON.parse(readFileSync(file, "utf8"));
	} catch {
		continue;
	}
	for (const section of SECTIONS) {
		const deps = pkg[section];
		if (!deps) continue;
		for (const name of overrideNames) {
			const declared = deps[name];
			const override = overrides[name];
			// Only an exact-vs-exact mismatch is the electron-builder killer.
			// A range on either side is a legitimate, non-comparable pin.
			if (!declared || !EXACT.test(declared) || !EXACT.test(override)) continue;
			if (declared !== override) {
				conflicts.push(
					`${file}: ${section}.${name} = "${declared}"  !=  root overrides.${name} = "${override}"`,
				);
			}
		}
	}
}

if (conflicts.length > 0) {
	console.error(
		"::error::root package.json `overrides` conflict with declared workspace pins — electron-builder's dependency traversal will fail with 'production dependency not found … version=<declared>' deep into the build. Bump the override to match upstream's pin, or DROP it (upstream keeps these consistent via identical exact pins, no override). Offenders:",
	);
	for (const c of conflicts) console.error(`  - ${c}`);
	process.exit(1);
}

console.log(
	`override-consistency OK: ${overrideNames.length} override(s) agree with every exact workspace pin.`,
);
