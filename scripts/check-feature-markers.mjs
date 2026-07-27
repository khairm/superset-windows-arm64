#!/usr/bin/env node
// Feature-marker survival gate, standalone. Mirrors run_marker_gate in
// nightly-merge.yml: parse the fenced ```markers block in FEATURES.md
// (lines are "<token>\t<glob-root>") and require every token to appear
// somewhere under its root. An empty/renamed block fails LOUD (a vacuous
// pass would let a repair silently delete a feature).
// Used by the CI build-repair loop to prove an AI repair removed no feature.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const features = readFileSync("FEATURES.md", "utf8");
const m = features.match(/^```markers\r?\n([\s\S]*?)^```/m);
if (!m) {
	console.error("::error::FEATURES.md markers block is missing — the marker gate would pass vacuously. Refusing to pass.");
	process.exit(1);
}
const lines = m[1]
	.split(/\r?\n/)
	.map((l) => l.trim())
	.filter((l) => l.length > 0);
if (lines.length === 0) {
	console.error("::error::FEATURES.md markers block is empty — the marker gate would pass vacuously. Refusing to pass.");
	process.exit(1);
}

let missing = 0;
for (const line of lines) {
	const tab = line.indexOf("\t");
	// Parity with the awk gate in nightly-merge.yml: a tab-less line there
	// yields an empty root and reports MISSING — fail loud here too rather
	// than silently defaulting to repo root.
	if (tab === -1) {
		console.error(`::error::malformed FEATURES.md marker line (no tab separator): '${line}'`);
		process.exit(1);
	}
	const tok = line.slice(0, tab);
	const root = line.slice(tab + 1).trim();
	if (!tok || !root) {
		console.error(`::error::malformed FEATURES.md marker line (empty token or root): '${line}'`);
		process.exit(1);
	}
	let found = false;
	try {
		// -r recursive, -q quiet, -s no fs errors, -F fixed string
		execFileSync("grep", ["-rqsF", "--", tok, root], { stdio: "ignore" });
		found = true;
	} catch {
		found = false;
	}
	if (found) {
		console.log(`  OK   ${tok} (${root})`);
	} else {
		console.error(`::error::feature marker MISSING: '${tok}' under ${root}`);
		missing++;
	}
}
if (missing > 0) {
	console.error(`::error::${missing} feature marker(s) missing — refusing to pass.`);
	process.exit(1);
}
console.log(`All ${lines.length} feature markers present.`);
