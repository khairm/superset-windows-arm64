#!/usr/bin/env node
// (REFERR-GATE) Narrow ReferenceError-class typecheck gate.
//
// The fork's build is esbuild-only (no type gate by design — the tree carries
// known, accepted type debt). But one class of diagnostic is ALWAYS a runtime
// bug in shipped code: "cannot find name" — a bare identifier esbuild happily
// bundles that throws ReferenceError at runtime. The v1.14.0 nightly merge
// shipped exactly that (layout.tsx kept fork code referencing a variable an
// upstream hunk renamed; git merged the hunk CLEANLY so the AI resolver never
// saw it, and every v2 workspace view crashed at render).
//
// This gate runs tsc per shipped package and fails ONLY on that class:
//   TS2304 cannot find name
//   TS2552 cannot find name (did-you-mean)
//   TS2662 cannot find name (instance member, static access)
//   TS2663 cannot find name (static member, instance access)
//   TS18004 shorthand property needs a value in scope
// The known type debt contains ZERO of these codes, so the gate cannot
// false-abort on it. Deliberately per-package direct tsc, NOT `turbo
// typecheck` — the turbo graph is blocked by unrelated upstream debt
// (@superset/pty-daemon build:types).

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

// Every workspace whose source is compiled into the shipped desktop app
// (renderer/main/preload bundles + the packaged host-service).
const PACKAGE_DIRS = [
	"apps/desktop",
	"packages/host-service",
	"packages/shared",
	"packages/local-db",
	"packages/panes",
	"packages/ui",
	"packages/workspace-client",
];

const DANGEROUS = /error TS(2304|2552|2662|2663|18004):/;

let failed = false;
for (const dir of PACKAGE_DIRS) {
	const cwd = join(REPO_ROOT, dir);
	if (!existsSync(join(cwd, "tsconfig.json"))) {
		console.log(`SKIP ${dir} (no tsconfig.json)`);
		continue;
	}
	const started = Date.now();
	const result = spawnSync("bunx", ["tsc", "--noEmit"], {
		cwd,
		shell: true,
		encoding: "utf8",
		timeout: 15 * 60 * 1000,
	});
	const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
	if (result.error) {
		// tsc not running at all must fail loud — a silently skipped gate is no gate.
		console.error(
			`::error::(REFERR-GATE) could not run tsc in ${dir}: ${result.error.message}`,
		);
		failed = true;
		continue;
	}
	const hits = output.split(/\r?\n/).filter((line) => DANGEROUS.test(line));
	const secs = ((Date.now() - started) / 1000).toFixed(0);
	if (hits.length > 0) {
		failed = true;
		console.error(
			`FAIL ${dir} (${secs}s) — ${hits.length} ReferenceError-class diagnostic(s):`,
		);
		for (const line of hits) {
			console.error(`::error::(REFERR-GATE) ${dir}: ${line.trim()}`);
		}
	} else {
		// Non-dangerous diagnostics (the known debt) are allowed; only report count.
		const total = output
			.split(/\r?\n/)
			.filter((l) => /error TS\d+:/.test(l)).length;
		console.log(
			`OK   ${dir} (${secs}s) — 0 dangerous (${total} total diagnostics, debt allowed)`,
		);
	}
}

if (failed) {
	console.error(
		"::error::(REFERR-GATE) cannot-find-name diagnostics found — a bare identifier would throw ReferenceError in the shipped bundle. Fix before building.",
	);
	process.exit(1);
}
console.log(
	"(REFERR-GATE) clean — no ReferenceError-class diagnostics in shipped packages.",
);
