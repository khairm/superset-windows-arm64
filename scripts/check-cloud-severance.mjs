#!/usr/bin/env node
/**
 * (CLOUD-SEVERANCE-P1) Build gate: prove this fork's artifacts do not phone
 * home to upstream's telemetry / update channels.
 *
 * PHASE-SCOPED ON PURPOSE. In phase 1, api.superset.sh, electric, streams and
 * relay are LEGITIMATELY baked (sign-in and the data plane are severed in a
 * later phase), so a blanket cloud-hostname scan could never go green and would
 * just be switched off. Every assertion below therefore declares the phase it
 * belongs to; widening the gate later is a one-line change to PHASE.
 *
 * Artifact scanning follows the SCREENREADER-GUARD-DRIFT rule: never assert
 * against a named Rollup chunk (a rename blocked three nightlies). Assertions
 * run over the WHOLE artifact set, and each scan refuses to pass vacuously if
 * its artifact set turned out to be empty.
 *
 * Usage:
 *   node scripts/check-cloud-severance.mjs                    # full gate (needs a build + packaging)
 *   node scripts/check-cloud-severance.mjs --allow-unpackaged # post-compile, no packaging (mode=partial)
 *   node scripts/check-cloud-severance.mjs --no-artifacts     # source/env checks only
 *
 * Only a `full` run can satisfy CI: the enforcing step in
 * .github/workflows/build-arm64.yml requires mode=full and an EXACT assertion
 * count, so neither convenience flag can stand in for a real gate run. That
 * count is duplicated in three frozen enforcement steps — grow the assertions
 * here and all three must be updated in lockstep or the build refuses to
 * publish.
 *
 * Content assertions run twice: once over apps/desktop/dist (packaging's
 * input) and once over the packaged release/*-unpacked/resources/*.asar
 * (what actually ships). The second set exists because everything between
 * packaging and this gate in .github/actions/arm64-build/action.yml is
 * repairable, so a scrub of dist/ after packaging must not be able to buy a
 * green gate over a dirty artifact.
 *
 * With artifacts missing and no --no-artifacts flag, this FAILS LOUD rather
 * than skipping: a gate that silently passes when it cannot see the thing it
 * guards is worse than no gate.
 */

import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Bump when a later phase widens the assertions below. */
const PHASE = 2;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = join(repoRoot, "apps/desktop/dist");
const releaseRoot = join(repoRoot, "apps/desktop/release");
const allowlistPath = join(repoRoot, "scripts/cloud-severance-allowlist.tsv");
const bundledCliPath = join(repoRoot, "apps/desktop/dist/resources/bin");
const stampPath = join(repoRoot, ".fork/cloud-severance-stamp.json");

const noArtifacts = process.argv.includes("--no-artifacts");
// Local convenience for a post-compile check with no packaging step. It is NOT
// a way to weaken CI: it stamps mode=partial, and the enforcing step in
// .github/workflows/build-arm64.yml requires mode=full.
const allowUnpackaged = process.argv.includes("--allow-unpackaged");
/** Set only when an assertion was ACTUALLY skipped, not merely when a flag was passed. */
let skippedAnAssertion = false;

// A stale stamp must never satisfy a later verification, so drop any existing
// one up front: the only stamp that can exist after this point is one THIS run
// wrote after passing.
rmSync(stampPath, { force: true });

let failures = 0;
/** Assertions that actually executed AND passed — recorded in the stamp. */
let assertionsPassed = 0;
function fail(message) {
	console.error(`::error::${message}`);
	failures++;
}
function ok(message) {
	assertionsPassed++;
	console.log(`  OK   ${message}`);
}

// --- artifact collection -------------------------------------------------

/**
 * Sourcemaps are excluded: they embed the ORIGINAL source, including the
 * comments that explain what was severed and name the hosts involved. Scanning
 * them would flag this fork's own documentation as a violation.
 */
const SCANNABLE = /\.(js|cjs|mjs|html|css)$/;

function walk(dir, out = []) {
	if (!existsSync(dir)) return out;
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			walk(full, out);
		} else if (SCANNABLE.test(entry) && !entry.endsWith(".map")) {
			out.push(full);
		}
	}
	return out;
}

function readArtifacts(dir) {
	return walk(dir).map((path) => ({
		path,
		rel: relative(repoRoot, path).replace(/\\/g, "/"),
		text: readFileSync(path, "utf8"),
	}));
}

/**
 * Minimal ASAR reader. No dependency by design: this gate has to run from a
 * bare `node scripts/check-cloud-severance.mjs` on a runner where nothing is
 * guaranteed to be installed, and a gate that needs `npm i` to work is a gate
 * that gets skipped.
 *
 * Layout: TWO NESTED Chromium Pickles, 16 bytes of preamble in total, and the
 * nesting is the thing that is easy to get wrong:
 *
 *   [0]  u32 = 4              payload length of the outer "size" pickle
 *   [4]  u32 headerSize       the value that pickle carries
 *   [8]  u32                  payload length of the inner "header" pickle
 *   [12] u32 jsonLen          length of the header STRING (a field of that payload)
 *   [16] the header JSON
 *
 * So the JSON starts at 16, NOT at 12: byte 12 is the string's own length
 * field, sitting inside the inner pickle's payload. Reading from 12 prepends
 * four binary bytes to the JSON and JSON.parse throws, which is not a loud
 * "bad archive" — openAsarsOrFail turns it into an empty archive list and
 * every downstream assertion then fails as vacuous. That is exactly what
 * happened, so keep these offsets exact.
 *
 * The file data region is based at 8 + headerSize; each file entry carries a
 * byte offset into it. Entries pulled out by `asarUnpack` are flagged
 * `unpacked`, carry no offset, and live in the sibling <archive>.unpacked tree
 * — which therefore has to be present on disk next to the archive, or those
 * entries cannot be read at all.
 *
 * Reading entries rather than grepping the archive as one blob is what lets
 * the packaged assertions keep real per-entry paths, so the two path-scoped
 * ones (main bundle, renderer HTML) stay scoped instead of degrading into
 * archive-wide scans that could never pass.
 */
function readAsar(asarPath) {
	const buf = readFileSync(asarPath);
	if (buf.length < 16) {
		throw new Error(
			`${asarPath} is ${buf.length} byte(s) — too small to be an asar archive`,
		);
	}
	if (buf.readUInt32LE(0) !== 4) {
		throw new Error(
			`${asarPath}: pickle header is ${buf.readUInt32LE(0)}, expected 4 — not an asar archive`,
		);
	}
	const headerSize = buf.readUInt32LE(4);
	const headerPayloadSize = buf.readUInt32LE(8);
	const jsonLen = buf.readUInt32LE(12);
	if (
		headerSize < headerPayloadSize + 4 ||
		headerPayloadSize < jsonLen + 4 ||
		16 + jsonLen > buf.length ||
		8 + headerSize > buf.length
	) {
		throw new Error(
			`${asarPath}: asar header is self-inconsistent (headerSize ${headerSize}, header payload ${headerPayloadSize}, json ${jsonLen}, file ${buf.length})`,
		);
	}
	const header = JSON.parse(buf.toString("utf8", 16, 16 + jsonLen));
	const dataBase = 8 + headerSize;
	const entries = [];
	const walkNode = (node, prefix) => {
		for (const [name, child] of Object.entries(node?.files ?? {})) {
			const rel = prefix ? `${prefix}/${name}` : name;
			if (child?.files) {
				walkNode(child, rel);
			} else {
				entries.push({
					rel,
					size: Number(child?.size ?? 0),
					offset: child?.offset === undefined ? null : Number(child.offset),
					unpacked: child?.unpacked === true,
				});
			}
		}
	};
	walkNode(header, "");
	return { path: asarPath, buf, dataBase, entries };
}

/** Raw bytes of one asar entry, or null when they cannot be located. */
function asarEntryBytes(archive, entry) {
	if (entry.unpacked) {
		const external = join(`${archive.path}.unpacked`, ...entry.rel.split("/"));
		return existsSync(external) ? readFileSync(external) : null;
	}
	if (entry.offset === null || !Number.isFinite(entry.offset)) return null;
	const start = archive.dataBase + entry.offset;
	const end = start + entry.size;
	if (start < 0 || end > archive.buf.length) return null;
	return archive.buf.subarray(start, end);
}

/**
 * Open every path as an asar, reporting (not swallowing) the ones that will not
 * parse. A returned short list still feeds assertAsarSetClean, whose empty-set
 * rule then refuses to pass vacuously.
 */
function openAsarsOrFail(paths) {
	const archives = [];
	for (const path of paths) {
		try {
			archives.push(readAsar(path));
		} catch (error) {
			fail(
				`cannot read archive ${relative(repoRoot, path).replace(/\\/g, "/")}: ${error.message} — refusing to conclude anything about the shipped bytes.`,
			);
		}
	}
	return archives;
}

/**
 * The eight content assertions, run over a set of already-opened asar archives.
 *
 * Shared deliberately between the packaged-artifact scan and the extracted
 * installer scan. They are the SAME property asserted about two different
 * points in the chain (dist -> app.asar -> NSIS .exe), and if they were
 * written out twice they would drift the first time one was updated.
 *
 * @param archives result of readAsar(), one per archive
 * @param scope human name of the artifact being scanned, used in every label
 */
function assertAsarSetClean(archives, scope) {
	const artifacts = [];
	const unreadable = [];
	for (const archive of archives) {
		const archiveRel = relative(repoRoot, archive.path).replace(/\\/g, "/");
		for (const entry of archive.entries) {
			if (!SCANNABLE.test(entry.rel) || entry.rel.endsWith(".map")) continue;
			const bytes = asarEntryBytes(archive, entry);
			if (bytes === null) {
				unreadable.push(`${archiveRel}!/${entry.rel}`);
				continue;
			}
			artifacts.push({
				path: `${archive.path}!${entry.rel}`,
				rel: `${archiveRel}!/${entry.rel}`,
				// Decoded on demand, never stored. The app.asar this fork ships
				// holds ~46k scannable entries totalling ~490 MB; materialising
				// every one of them as a string alongside the archive buffer
				// already resident is a needless OOM risk on a runner. `bytes` is
				// a zero-copy subarray of that buffer, so the getter costs a
				// decode per assertion and keeps exactly one string alive.
				get text() {
					return bytes.toString("utf8");
				},
			});
		}
	}
	if (unreadable.length > 0) {
		fail(
			`${unreadable.length} scannable entr(y/ies) inside ${scope} could not be read — a scan that silently skips entries proves nothing:\n    ${unreadable.join("\n    ")}`,
		);
	}

	// Path-scoped mirrors of the dist/main and dist/renderer scans. Inside the
	// asar the app tree keeps its `dist/` prefix (the electron-builder `files`
	// filter copies dist/**/* with no `to`).
	//
	// Scoping is why these read asar ENTRIES instead of byte-grepping the
	// archive as one blob: `superset-sh/superset/releases` is legitimately
	// present in the bundled CLI binary (packages/cli/src/commands/update
	// downloads its own releases from there), so an archive-wide scan for it
	// could never pass. Confirmed: 2 occurrences in dist/resources/bin.
	const mainArtifacts = artifacts.filter((a) =>
		/(^|\/)dist\/main\//.test(a.rel),
	);
	const rendererHtml = artifacts.filter(
		(a) => /(^|\/)dist\/renderer\//.test(a.rel) && a.rel.endsWith(".html"),
	);

	assertAbsent(
		`outlit.ai absent from ${scope}`,
		artifacts,
		/outlit\.ai/,
		"the CORS shim entry for it must stay deleted in the SHIPPED bytes, not just in dist/",
	);
	assertAbsent(
		`upstream releases URL absent from ${scope} main bundle`,
		mainArtifacts,
		/superset-sh\/superset\/releases/,
		"the auto-updater feed must never point at upstream's releases in the SHIPPED bytes",
	);
	assertAbsent(
		`PostHog project key absent from ${scope}`,
		artifacts,
		/phc_[A-Za-z0-9]{20,}/,
		"a PostHog project key is baked into the SHIPPED bytes",
	);
	assertAbsent(
		`Sentry DSN absent from ${scope}`,
		artifacts,
		/https:\/\/[0-9a-f]{16,}@[A-Za-z0-9.-]*ingest\.[A-Za-z0-9.-]*sentry\.io/,
		"a Sentry DSN is baked into the SHIPPED bytes",
	);
	assertAbsent(
		`CSP in ${scope} grants no PostHog/Sentry origin`,
		rendererHtml,
		/posthog\.com|sentry\.io|sentry-ipc:/,
		"the SHIPPED index.html's Content-Security-Policy still allows a telemetry host",
	);
	assertAbsent(
		`CORS shim in ${scope} carries no telemetry URL patterns`,
		mainArtifacts,
		/\*\.posthog\.com\/\*|\*\.sentry\.io\/\*|app\.outlit\.ai/,
		"the SHIPPED Windows CORS shim still smooths the way for a telemetry host",
	);
	assertAbsent(
		`desktop-notices endpoint absent from ${scope}`,
		artifacts,
		/\/api\/desktop\/version/,
		"the SHIPPED bytes fetch the desktop-notices endpoint again — the phase-1 poll-off has regressed",
	);

	// The bundled CLI is a compiled bun binary, so the text scans above skip it
	// (same reason assertion 8 exists for dist/). Scan the copy inside the
	// archive.
	const packagedCli = [];
	for (const archive of archives) {
		for (const entry of archive.entries) {
			if (/(^|\/)dist\/resources\/bin\//.test(entry.rel)) {
				packagedCli.push({ archive, entry });
			}
		}
	}
	if (packagedCli.length === 0) {
		fail(
			`no bundled CLI binary found inside ${scope} (expected entries under dist/resources/bin/) — the CLI analytics scan would pass vacuously. Refusing to pass.`,
		);
	} else {
		const needles = [
			"analytics.captureEvent",
			"cli_command_invoked",
			"api.superset.sh",
			"relay.superset.sh",
		];
		const hits = [];
		for (const { archive, entry } of packagedCli) {
			const bytes = asarEntryBytes(archive, entry);
			if (bytes === null) {
				hits.push(`${entry.rel} (UNREADABLE inside the archive)`);
				continue;
			}
			for (const needle of needles) {
				if (bytes.includes(Buffer.from(needle, "utf8"))) {
					hits.push(`${entry.rel} (${needle})`);
				}
			}
		}
		if (hits.length > 0) {
			fail(
				`CLI inside ${scope} still carries analytics call sites:\n    ${hits.join("\n    ")}`,
			);
		} else {
			ok(
				`CLI inside ${scope} carries no analytics route (${packagedCli.length} archive entry/entries scanned)`,
			);
		}
	}
}

/**
 * Locate a usable 7-Zip. Resolved by absolute path first: the enforcing step
 * pins PATH, and a gate that silently used whatever `7z` an earlier repairable
 * step put on the PATH would be extracting the installer with an
 * attacker-supplied extractor.
 */
function resolveSevenZip() {
	const candidates = [
		"C:/Program Files/7-Zip/7z.exe",
		"C:/Program Files (x86)/7-Zip/7z.exe",
		"/usr/bin/7z",
		"/usr/local/bin/7z",
		"/usr/bin/7zz",
		"7z",
		"7za",
	];
	for (const candidate of candidates) {
		try {
			execFileSync(candidate, ["i"], { stdio: "ignore" });
			return candidate;
		} catch {
			// not this one
		}
	}
	return null;
}

/** `7z l -slt` entry paths, in archive order. */
function sevenZipList(sevenZip, archive) {
	const out = execFileSync(sevenZip, ["l", "-slt", "-ba", archive], {
		encoding: "utf8",
		maxBuffer: 1 << 28,
	});
	return out
		.split(/\r?\n/)
		.filter((line) => line.startsWith("Path = "))
		.map((line) => line.slice("Path = ".length).trim())
		.filter(Boolean);
}

/**
 * @param label human name of the assertion
 * @param artifacts artifact set to scan (must be non-empty)
 * @param pattern RegExp to search for
 * @param why what a hit means
 */
function assertAbsent(label, artifacts, pattern, why) {
	if (artifacts.length === 0) {
		fail(
			`${label}: artifact set is EMPTY — the scan would pass vacuously. Refusing to pass.`,
		);
		return;
	}
	const hits = artifacts
		.filter((artifact) => pattern.test(artifact.text))
		.map((artifact) => artifact.rel);
	if (hits.length > 0) {
		fail(
			`${label}: found in ${hits.length} artifact(s) — ${why}\n    ${hits.join("\n    ")}`,
		);
		return;
	}
	ok(`${label} (${artifacts.length} artifact(s) scanned)`);
}

// --- phase 1 assertions --------------------------------------------------

console.log(`(CLOUD-SEVERANCE-P${PHASE}) gate`);

// 1. Build-time telemetry env vars must be unset. This mirrors the throw in
//    apps/desktop/vite/telemetry-key-ban.ts; having it here too means a build
//    that somehow skipped the vite config still cannot ship armed.
const BANNED_ENV = [
	"NEXT_PUBLIC_POSTHOG_KEY",
	"SENTRY_DSN_DESKTOP",
	"SENTRY_DSN_HOST_SERVICE",
	"SENTRY_AUTH_TOKEN",
];
const setEnv = BANNED_ENV.filter(
	(key) => (process.env[key] ?? "").trim() !== "",
);
if (setEnv.length > 0) {
	fail(
		`telemetry env var(s) set at build time: ${setEnv.join(", ")} — this fork bakes no telemetry key or DSN`,
	);
} else {
	ok(`telemetry env vars unset (${BANNED_ENV.join(", ")})`);
}

// 2. Allowlist: must exist, parse, contain the entries the companion needs, and
//    must not have been widened to re-permit a cloud/telemetry host.
if (!existsSync(allowlistPath)) {
	fail(`allowlist missing at ${relative(repoRoot, allowlistPath)}`);
} else {
	const allowlist = [];
	const lines = readFileSync(allowlistPath, "utf8").split(/\r?\n/);
	for (const [index, raw] of lines.entries()) {
		const line = raw.trimEnd();
		if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
		const tab = line.indexOf("\t");
		if (tab === -1) {
			fail(`allowlist line ${index + 1} has no tab separator: '${line}'`);
			continue;
		}
		const host = line.slice(0, tab).trim();
		const justification = line.slice(tab + 1).trim();
		if (!host || !justification) {
			fail(`allowlist line ${index + 1} has an empty host or justification`);
			continue;
		}
		allowlist.push(host);
	}
	const REQUIRED = [
		"127.0.0.1",
		"localhost",
		"0.0.0.0",
		"fcm.googleapis.com",
		"oauth2.googleapis.com",
	];
	const missing = REQUIRED.filter((host) => !allowlist.includes(host));
	if (missing.length > 0) {
		fail(`allowlist is missing required entries: ${missing.join(", ")}`);
	}
	// The allowlist must never become the escape hatch that re-permits what
	// this gate exists to remove.
	const forbidden = allowlist.filter((host) =>
		/posthog\.com$|sentry\.io$|outlit\.ai$/.test(host),
	);
	if (forbidden.length > 0) {
		fail(`allowlist contains telemetry host(s): ${forbidden.join(", ")}`);
	}
	if (missing.length === 0 && forbidden.length === 0) {
		ok(`allowlist parsed (${allowlist.length} host(s))`);
	}
}

if (noArtifacts) {
	console.log(
		"\n  SKIPPED (--no-artifacts): every artifact assertion below. This mode is for source-only local runs; CI must run the gate WITHOUT this flag, after the build.",
	);
	console.log(
		"  Skipped: outlit.ai absence, upstream releases URL absence, app-update.yml, telemetry secret shapes, CSP contents, CORS shim contents, and every packaged-app.asar assertion.",
	);
} else {
	if (!existsSync(distRoot)) {
		fail(
			`built artifacts not found at ${relative(repoRoot, distRoot)} — run the build first, or pass --no-artifacts to run only the source/env checks. Refusing to pass without seeing the artifacts.`,
		);
	}

	const mainArtifacts = readArtifacts(join(distRoot, "main"));
	const rendererArtifacts = readArtifacts(join(distRoot, "renderer"));
	const preloadArtifacts = readArtifacts(join(distRoot, "preload"));
	const allArtifacts = [
		...mainArtifacts,
		...rendererArtifacts,
		...preloadArtifacts,
	];

	// 3. outlit.ai: its only source was the Windows CORS shim, which is gone.
	assertAbsent(
		"outlit.ai absent from all artifacts",
		allArtifacts,
		/outlit\.ai/,
		"the CORS shim entry for it must stay deleted",
	);

	// 4. Upstream's releases URL must not survive in the main bundle. This
	//    catches an upstream platform flip even if FORK_AUTO_UPDATE_DISABLED
	//    gets mangled by a merge: the feed constant is the payload that matters.
	assertAbsent(
		"upstream releases URL absent from main bundle",
		mainArtifacts,
		/superset-sh\/superset\/releases/,
		"the auto-updater feed must never point at upstream's releases",
	);

	// 5. Telemetry SECRET shapes. An SDK with no key and no DSN is inert; a baked
	//    key or DSN is what actually arms it.
	assertAbsent(
		"PostHog project key absent from all artifacts",
		allArtifacts,
		/phc_[A-Za-z0-9]{20,}/,
		"a PostHog project key is baked into the build",
	);
	assertAbsent(
		"Sentry DSN absent from all artifacts",
		allArtifacts,
		/https:\/\/[0-9a-f]{16,}@[A-Za-z0-9.-]*ingest\.[A-Za-z0-9.-]*sentry\.io/,
		"a Sentry DSN is baked into the build",
	);

	// 6. CSP: the shipped renderer HTML must not permit telemetry hosts.
	const rendererHtml = rendererArtifacts.filter((a) => a.rel.endsWith(".html"));
	assertAbsent(
		"CSP grants no PostHog/Sentry origin",
		rendererHtml,
		/posthog\.com|sentry\.io|sentry-ipc:/,
		"index.html's Content-Security-Policy still allows a telemetry host",
	);

	// 7. CORS shim: the Windows header shim must cover api.superset.sh only.
	assertAbsent(
		"CORS shim carries no telemetry URL patterns",
		mainArtifacts,
		/\*\.posthog\.com\/\*|\*\.sentry\.io\/\*|app\.outlit\.ai/,
		"the Windows CORS shim still smooths the way for a telemetry host",
	);

	// 7b. The desktop-notices poll must stay off. This is the ONLY phase-1
	//     behaviour with no other artifact-level backstop: the severance markers
	//     in useDesktopNotices.ts live in COMMENTS, so an upstream merge that
	//     restores the `GET /api/desktop/version` fetch would keep every marker
	//     and pass every other gate — api.superset.sh is legitimately baked in
	//     phase 1, so no hostname check can catch it. The endpoint PATH is the
	//     only distinguishing string, so assert on that, over the whole artifact
	//     set rather than a named chunk. Zero occurrences today; if a later phase
	//     ever needs this endpoint from a fork-owned server, this assertion is
	//     the thing to revisit deliberately.
	assertAbsent(
		"desktop-notices endpoint absent from all artifacts (poll stays off)",
		allArtifacts,
		/\/api\/desktop\/version/,
		"something fetches the desktop-notices endpoint again — the phase-1 poll-off has regressed",
	);

	// 8. The BUNDLED CLI is a compiled bun binary, not a .js chunk, so the
	//    artifact scans above cannot see it — and it is a phone-home channel in
	//    its own right (upstream posted api.analytics.captureEvent to
	//    SUPERSET_API_URL on EVERY command). Scan the binary's raw bytes for the
	//    analytics route name instead, so the CLI channel is artifact-enforced
	//    rather than only source-enforced.
	//
	//    Phase 2 widens this: `api.superset.sh` was legitimate in this binary
	//    while the CLI's auth chain targeted it, and is not any more — the CLI
	//    resolves a local identity and its API client is severed. The binary is
	//    the only place that can be proven, since the bundle scans cannot see
	//    inside it.
	const cliBinaries = existsSync(bundledCliPath)
		? readdirSync(bundledCliPath)
				.map((name) => join(bundledCliPath, name))
				.filter((p) => statSync(p).isFile())
		: [];
	if (cliBinaries.length === 0) {
		fail(
			`bundled CLI binary not found under ${relative(repoRoot, bundledCliPath).replace(/\\/g, "/")} — the CLI analytics scan would pass vacuously. Refusing to pass.`,
		);
	} else {
		const needles = [
			"analytics.captureEvent",
			"cli_command_invoked",
			"api.superset.sh",
			"relay.superset.sh",
		];
		const cliHits = [];
		for (const binary of cliBinaries) {
			const bytes = readFileSync(binary);
			for (const needle of needles) {
				if (bytes.includes(Buffer.from(needle, "utf8"))) {
					cliHits.push(
						`${relative(repoRoot, binary).replace(/\\/g, "/")} (${needle})`,
					);
				}
			}
		}
		if (cliHits.length > 0) {
			fail(
				`bundled CLI still carries analytics call sites:\n    ${cliHits.join("\n    ")}`,
			);
		} else {
			ok(
				`bundled CLI carries no analytics route (${cliBinaries.length} binary/binaries scanned)`,
			);
		}
	}

	// --- (CLOUD-SEVERANCE-P2): the cloud itself ------------------------
	//
	// Phase 1 cut telemetry, updates and notices while api/relay/electric
	// stayed legitimately baked. Phase 2 cuts those too, so the assertions
	// below are what stop them coming back.
	//
	// EVERY ONE OF THESE IS AN ORIGIN, NEVER A WORD. `electric` appears in
	// live fork identifiers (`clearElectricCache` is an IPC procedure name)
	// and in dozens of comments; asserting the word would be a gate that can
	// never go green, and this file is frozen against (BUILD-REPAIR) edits —
	// a false positive here blocks nightlies until a human fixes it by hand.

	// 10. No cloud origin may survive in any artifact. Six hosts, because the
	//     app talked to more of them than "the API": the data plane, two relay
	//     failover targets, the relay itself, the Electric proxy and the
	//     streams endpoints.
	const CLOUD_ORIGINS = [
		["api.superset.sh", "the cloud data plane"],
		["relay.superset.sh", "the relay"],
		["relay-backup.superset.sh", "the relay's failover target"],
		["superset-relay2.avi-6ac.workers.dev", "the v2 relay worker"],
		["electric-proxy.avi-6ac.workers.dev", "the Electric sync proxy"],
		["streams.superset.sh", "the streams endpoint"],
		["superset-stream.fly.dev", "the streams fallback endpoint"],
		// Added by upstream v1.23.0's cloud workspace sandboxes, which a browser
		// reaches directly at the provider's preview domain. Listed here because
		// upstream re-adds it to the CSP on every release that touches it.
		["preview.bl.run", "the cloud sandbox preview domain"],
	];
	for (const [host, what] of CLOUD_ORIGINS) {
		assertAbsent(
			`${host} absent from all artifacts`,
			allArtifacts,
			new RegExp(host.replace(/\./g, "\\.")),
			`${what} is severed in phase 2 — something baked its hostname back in`,
		);
	}

	// 11. better-auth's HTTP surface must be gone from the renderer. The
	//     session client is a Proxy shim now; if this path reappears, some
	//     call is talking to an auth server again.
	assertAbsent(
		"better-auth HTTP routes absent from all artifacts",
		allArtifacts,
		/\/api\/auth\/(desktop\/connect|sign-in|sign-up|get-session)/,
		"the sign-in flow is deleted — a route like this means it came back",
	);

	// 12. POSITIVE assertion, and the only one of its kind in this gate.
	//
	//     Absence proves nothing about the fence: a fence reverted to log-only
	//     ships bytes that differ from a blocking one only in what the callback
	//     does with the decision. So this asserts the WIRING — that the request
	//     callback still consults the decision function and still hands the
	//     result to Electron's cancel callback.
	//
	//     An earlier version of this assertion looked for the `(FENCE-BLOCK)`
	//     marker instead. That was worthless twice over: the main bundle is not
	//     minified, so the marker matched the SOURCE COMMENT explaining it, and
	//     even the two log strings would have survived changing `cancel =
	//     shouldBlockEgress(...)` to `cancel = false`. A string in a log line is
	//     not a behaviour. These two patterns are still only structural — no
	//     artifact scan can prove semantics — but they are properties of the
	//     code path rather than of its documentation, and the decision function
	//     itself is covered by its unit tests and frozen in ci-repair.sh.
	const fenceCallSites = mainArtifacts.filter((artifact) =>
		/shouldBlockEgress\(/.test(artifact.text),
	);
	const fenceCancelSites = mainArtifacts.filter((artifact) =>
		/callback\(\{\s*cancel/.test(artifact.text),
	);
	if (mainArtifacts.length === 0) {
		fail(
			"egress-fence wiring: main artifact set is EMPTY — the check would pass vacuously. Refusing to pass.",
		);
	} else if (fenceCallSites.length === 0 || fenceCancelSites.length === 0) {
		fail(
			`egress-fence wiring is ABSENT from the main bundle (shouldBlockEgress call: ${fenceCallSites.length}, cancel callback: ${fenceCancelSites.length}) — the fence has been reverted to log-only or its decision function was unhooked. Refusing to pass.`,
		);
	} else {
		ok(
			`egress-fence decision is wired into the request callback (${fenceCallSites.length} artifact(s))`,
		);
	}

	// 13. The CSP must not carry a bare `ws:`/`wss:` token. Removing the named
	//     relay entries from connect-src is cosmetic while these remain: they
	//     permit a WebSocket to any host on the internet.
	const cspHtml = rendererArtifacts.filter((a) => a.rel.endsWith(".html"));
	if (cspHtml.length === 0) {
		fail(
			"CSP websocket scope: no renderer HTML found — the check would pass vacuously. Refusing to pass.",
		);
	} else {
		// The token can sit anywhere in the directive, INCLUDING last — `wss:;`
		// with no trailing space is the same wide-open grant as `wss: ` mid-list,
		// and a regex that only matched the mid-list form would wave it through.
		const wide = cspHtml.filter((a) =>
			/connect-src[^;]*\sws{1,2}:(\s|;|"|')/.test(a.text),
		);
		if (wide.length > 0) {
			fail(
				`CSP connect-src still allows unscoped websockets in: ${wide
					.map((a) => a.rel)
					.join(", ")} — narrow it to loopback`,
			);
		} else {
			ok(`CSP connect-src websockets are loopback-scoped (${cspHtml.length} document(s))`);
		}
	}

	// 9. No packaged app-update.yml may name upstream.
	//
	//    ZERO manifests is the CORRECT result for this fork, not a failure.
	//    app-builder-lib writes app-update.yml only when the resolved publish
	//    config is non-null (out/publish/PublishManager.js: `if (publishConfig
	//    != null)`), and electron-builder.ts sets `publish: null`. Failing on
	//    "none found" would therefore fail every healthy build.
	//
	//    The real risk is the other one: concluding "none found" WITHOUT having
	//    looked where the manifest would actually be. So the absence is only
	//    accepted once the packaged RESOURCES DIRECTORY has been located —
	//    `getResourcesDir(appOutDir)` is `<appOutDir>/resources` and appOutDir is
	//    `release/<platform><arch>-unpacked` (platformPackager.js), i.e. exactly
	//    `release/*-unpacked/resources`. If that directory cannot be found the
	//    layout changed and this assertion proves nothing, so it FAILS LOUD
	//    rather than reporting a clean zero. dist/ is swept too, so a manifest
	//    emitted outside the packaged tree is still caught.
	if (existsSync(releaseRoot)) {
		const findFiles = (dir, predicate, out = []) => {
			for (const entry of readdirSync(dir)) {
				const full = join(dir, entry);
				if (statSync(full).isDirectory()) findFiles(full, predicate, out);
				else if (predicate(entry)) out.push(full);
			}
			return out;
		};
		const findPackagedResourceDirs = (dir, out = []) => {
			for (const entry of readdirSync(dir)) {
				const full = join(dir, entry);
				if (!statSync(full).isDirectory()) continue;
				if (entry === "resources" && /-unpacked$/.test(basename(dir))) {
					out.push(full);
				}
				findPackagedResourceDirs(full, out);
			}
			return out;
		};

		// Positive control: prove we looked in the place the manifest would be.
		const resourceDirs = findPackagedResourceDirs(releaseRoot);
		if (resourceDirs.length === 0) {
			fail(
				`no packaged resources directory found under ${relative(repoRoot, releaseRoot).replace(/\\/g, "/")} (expected release/*-unpacked/resources, where electron-builder writes app-update.yml) — either packaging produced nothing or its layout changed, so "no app-update.yml found" would prove nothing. Refusing to pass vacuously.`,
			);
		} else {
			const manifests = [
				...findFiles(releaseRoot, (name) => name === "app-update.yml"),
				...(existsSync(distRoot)
					? findFiles(distRoot, (name) => name === "app-update.yml")
					: []),
			];
			const offenders = manifests.filter((path) =>
				readFileSync(path, "utf8").includes("superset-sh"),
			);
			if (offenders.length > 0) {
				fail(
					`packaged app-update.yml names superset-sh:\n    ${offenders
						.map((p) => relative(repoRoot, p).replace(/\\/g, "/"))
						.join("\n    ")}`,
				);
			} else {
				ok(
					`no app-update.yml names superset-sh (${manifests.length} found; looked inside ${resourceDirs.length} packaged resources dir(s): ${resourceDirs.map((d) => relative(repoRoot, d).replace(/\\/g, "/")).join(", ")}; publish:null means 0 is expected)`,
				);
			}

			// 10. (CLOUD-SEVERANCE-P1) Scan the PACKAGED archive, not just
			//     packaging's input.
			//
			//     Assertions 1-8 above all read apps/desktop/dist, which is
			//     electron-builder's INPUT. In
			//     .github/actions/arm64-build/action.yml the packaging step runs
			//     BEFORE this gate and every step between them is repairable, so
			//     a step inserted after packaging could scrub the offending
			//     strings out of dist/ (a sed over dist/**/*.js contains no
			//     reference to this script, so the freeze checks in
			//     scripts/ci-repair.sh never see it) and leave the packaged
			//     app.asar untouched.
			//
			//     SCREENREADER-GUARD-DRIFT rule still applies: nothing here names
			//     a chunk. The archives are discovered from the packaged
			//     resources dirs located above, and each assertion refuses to
			//     pass on an empty set.
			const asarPaths = resourceDirs.flatMap((dir) =>
				readdirSync(dir)
					.map((name) => join(dir, name))
					.filter((p) => p.endsWith(".asar") && statSync(p).isFile()),
			);
			if (asarPaths.length === 0) {
				fail(
					`no .asar archive found in the packaged resources dir(s) ${resourceDirs
						.map((d) => relative(repoRoot, d).replace(/\\/g, "/"))
						.join(", ")} — the packaged-artifact assertions would pass vacuously. Refusing to pass.`,
				);
			} else {
				assertAsarSetClean(
					openAsarsOrFail(asarPaths),
					"the packaged app.asar",
				);
			}

			// 11. (CLOUD-SEVERANCE-P1) THE PUBLISHED ARTIFACT.
			//
			//     This is the load-bearing scan and the others are corroboration.
			//     scripts/publish-arm64-release.sh uploads exactly one file — the
			//     NSIS installer from apps/desktop/release/*arm64*.exe — so the
			//     chain is dist/ -> app.asar -> installer .exe, and a repair can
			//     insert a scrub step after ANY link:
			//
			//       (a) scrub dist/ after packaging  -> asar and .exe stay dirty
			//           -> assertion 10 catches it.
			//       (b) scrub the unpacked app.asar after the .exe was built
			//           -> asar clean, .exe still dirty -> assertion 10 CANNOT
			//           see it, because the .exe already embedded the old bytes.
			//
			//     Only scanning the .exe closes (b). A raw byte scan of the .exe
			//     is useless — the NSIS payload is LZMA-compressed — so it is
			//     extracted: .exe -> $PLUGINSDIR/app-<arch>.7z -> resources/.
			//     The payload name is arch-specific (app-arm64.7z here, not
			//     app-64.7z; see app-builder-lib templates/nsis/include/
			//     extractAppPackage.nsh), so it is located by listing rather than
			//     guessed, and `store` compression yields .zip instead of .7z.
			const installers = readdirSync(releaseRoot)
				.filter(
					(name) =>
						name.toLowerCase().endsWith(".exe") &&
						!name.toLowerCase().includes("blockmap"),
				)
				.map((name) => join(releaseRoot, name))
				.filter((p) => statSync(p).isFile());
			const sevenZip = resolveSevenZip();
			if (installers.length === 0 && allowUnpackaged) {
				// release/ exists but packaging stopped after the unpacked dir —
				// the normal state of a local `compile + pack --dir` run. That is
				// exactly what --allow-unpackaged exists for, so skip rather than
				// fail; the run is still stamped mode=partial, which the build
				// workflow rejects, so this can never become a CI bypass.
				skippedAnAssertion = true;
				console.log(
					`  note  no installer .exe in ${relative(repoRoot, releaseRoot).replace(/\\/g, "/")} and --allow-unpackaged given — every published-installer assertion is SKIPPED. This run is stamped mode=partial and the build workflow will reject it.`,
				);
			} else if (installers.length === 0) {
				fail(
					`no installer .exe found in ${relative(repoRoot, releaseRoot).replace(/\\/g, "/")} — that file is the ONLY thing publish-arm64-release.sh uploads, so without it this gate cannot vouch for anything a user installs. Refusing to pass.`,
				);
			} else if (sevenZip === null) {
				fail(
					"no usable 7-Zip found (looked for C:/Program Files/7-Zip/7z.exe, the x86 path, /usr/bin/7z, /usr/local/bin/7z, /usr/bin/7zz, then 7z/7za on PATH) — the installer payload is LZMA-compressed and cannot be scanned without it. Refusing to pass rather than skipping the only assertion that covers the published artifact.",
				);
			} else {
				const scratch = mkdtempSync(join(tmpdir(), "cloud-severance-"));
				try {
					const extractedAsars = [];
					const updateManifests = [];
					for (const installer of installers) {
						const installerRel = relative(repoRoot, installer).replace(
							/\\/g,
							"/",
						);
						const stage = join(scratch, basename(installer));
						mkdirSync(stage, { recursive: true });

						let payloadNames;
						try {
							payloadNames = sevenZipList(sevenZip, installer).filter((entry) =>
								/(^|[\\/])app-[^\\/]*\.(7z|zip)$/i.test(entry),
							);
						} catch (error) {
							fail(
								`could not list ${installerRel} with 7-Zip: ${error.message} — refusing to conclude anything about the published installer.`,
							);
							continue;
						}
						if (payloadNames.length === 0) {
							fail(
								`${installerRel} contains no $PLUGINSDIR/app-<arch>.7z payload — either it is not an electron-builder NSIS installer or its layout changed, so scanning it would prove nothing. Refusing to pass.`,
							);
							continue;
						}

						for (const payloadName of payloadNames) {
							const payloadDir = join(stage, "payload");
							mkdirSync(payloadDir, { recursive: true });
							try {
								execFileSync(
									sevenZip,
									["e", "-y", `-o${payloadDir}`, installer, payloadName],
									{ stdio: "ignore" },
								);
							} catch (error) {
								fail(
									`could not extract ${payloadName} from ${installerRel}: ${error.message}. Refusing to pass.`,
								);
								continue;
							}
							const payloadPath = join(payloadDir, basename(payloadName));
							if (!existsSync(payloadPath) || statSync(payloadPath).size === 0) {
								fail(
									`extracting ${payloadName} from ${installerRel} produced nothing — refusing to conclude the installer is clean from an empty extraction.`,
								);
								continue;
							}

							let inner;
							try {
								inner = sevenZipList(sevenZip, payloadPath);
							} catch (error) {
								fail(
									`could not list the payload ${payloadName} of ${installerRel}: ${error.message}. Refusing to pass.`,
								);
								continue;
							}
							const asarEntries = inner.filter((entry) =>
								/(^|[\\/])app\.asar$/i.test(entry),
							);
							const manifestEntries = inner.filter((entry) =>
								/(^|[\\/])app-update\.yml$/i.test(entry),
							);
							// The asar is NOT the whole app. `asarUnpack` lifts
							// entries out of the archive onto disk beside it, and
							// this fork ships hundreds of scannable files that way
							// (native-module JS: better-sqlite3, node-pty, koffi,
							// agent-browser, …). readAsar reports them as `unpacked`
							// and asarEntryBytes resolves them from
							// <archive>.unpacked, so extracting app.asar ALONE puts
							// every one of them into assertAsarSetClean's
							// `unreadable` list and the scan fails as unproven.
							// That failure is correct — a partial extraction proves
							// nothing — so the extraction is completed here rather
							// than the check relaxed.
							//
							// Filtered by the SAME SCANNABLE regex the scan applies,
							// so the two cannot drift, and the native binaries (the
							// bulk of that tree) stay on the shelf. Anything this
							// filter misses is still caught: it becomes an unreadable
							// entry, not a silently skipped one.
							const unpackedEntries = inner.filter(
								(entry) =>
									/(^|[\\/])app\.asar\.unpacked[\\/]/i.test(entry) &&
									SCANNABLE.test(entry) &&
									!entry.endsWith(".map"),
							);
							if (asarEntries.length === 0) {
								fail(
									`the payload of ${installerRel} contains no resources/app.asar — the installer scan would pass vacuously. Refusing to pass.`,
								);
								continue;
							}
							const outDir = join(stage, "app");
							mkdirSync(outDir, { recursive: true });
							// Passed as a 7-Zip list file: hundreds of entries go
							// straight past the Windows command-line length limit,
							// and a silently truncated extraction is precisely the
							// failure this block exists to avoid.
							const listPath = join(stage, "extract-list.txt");
							const wanted = [
								...asarEntries,
								...manifestEntries,
								...unpackedEntries,
							];
							writeFileSync(listPath, `${wanted.join("\n")}\n`, "utf8");
							try {
								execFileSync(
									sevenZip,
									[
										"x",
										"-y",
										"-scsUTF-8",
										`-o${outDir}`,
										payloadPath,
										`@${listPath}`,
									],
									{ stdio: "ignore" },
								);
							} catch (error) {
								fail(
									`could not extract the app payload of ${installerRel}: ${error.message}. Refusing to pass.`,
								);
								continue;
							}
							for (const entry of asarEntries) {
								const onDisk = join(outDir, ...entry.split(/[\\/]/));
								if (!existsSync(onDisk)) {
									fail(
										`${entry} is listed in the payload of ${installerRel} but the extraction did not produce it — refusing to conclude anything from a partial extraction.`,
									);
									continue;
								}
								if (statSync(onDisk).size === 0) {
									fail(
										`app.asar extracted from ${installerRel} is empty — refusing to conclude anything from it.`,
									);
									continue;
								}
								extractedAsars.push(onDisk);
							}
							for (const entry of manifestEntries) {
								const onDisk = join(outDir, ...entry.split(/[\\/]/));
								if (existsSync(onDisk)) {
									updateManifests.push({ path: onDisk, from: installerRel });
								}
							}
						}
					}

					if (extractedAsars.length === 0) {
						fail(
							"no app.asar could be extracted from any installer — the published-artifact assertions would pass vacuously. Refusing to pass.",
						);
					} else {
						assertAsarSetClean(
							openAsarsOrFail(extractedAsars),
							"the extracted installer payload",
						);
					}

					// Mirror of assertion 9 over the artifact that ships. Zero
					// manifests is the expected result (publish: null), and it is
					// only meaningful because the payload listing above proved we
					// looked inside a real installer.
					const offenders = updateManifests.filter((manifest) =>
						readFileSync(manifest.path, "utf8").includes("superset-sh"),
					);
					if (offenders.length > 0) {
						fail(
							`app-update.yml inside the published installer names superset-sh:\n    ${offenders
								.map((manifest) => manifest.from)
								.join("\n    ")}`,
						);
					} else {
						ok(
							`no app-update.yml inside the published installer names superset-sh (${updateManifests.length} found across ${installers.length} installer(s); publish:null means 0 is expected)`,
						);
					}
				} finally {
					rmSync(scratch, { recursive: true, force: true });
				}
			}
		}
	} else if (allowUnpackaged) {
		skippedAnAssertion = true;
		console.log(
			"  note  apps/desktop/release absent and --allow-unpackaged given — the app-update.yml assertion AND every packaged-app.asar assertion are SKIPPED. This run is stamped mode=partial and the build workflow will reject it.",
		);
	} else {
		// Same fail-vacuously rule as every other assertion here. A missing
		// release/ means electron-builder never ran (or wrote elsewhere), so this
		// assertion inspected nothing — and a floor of "at least N assertions"
		// that a skipped packaging step can still satisfy is not a floor.
		fail(
			`packaging output not found at ${relative(repoRoot, releaseRoot).replace(/\\/g, "/")} — the app-update.yml assertion would be vacuous. Run the packaging step first, or pass --allow-unpackaged for a local post-compile check (which stamps mode=partial and cannot satisfy CI). Refusing to pass.`,
		);
	}
}

// --- deliberately NOT asserted in phase 1 --------------------------------
//
// A blanket "no posthog.com / sentry.io anywhere in the artifact set" scan is
// the obvious next assertion and it is NOT here, because it cannot pass today
// and a gate that cannot pass gets disabled. Those hostnames are compiled into
// the SDKs themselves, not into our configuration:
//
//   - posthog-js is statically imported by apps/desktop/src/renderer/lib/posthog.ts
//     and used by 8 renderer modules (PostHogUserIdentifier, PostHogSurfaceTagger,
//     TelemetrySync, HiringBanner's useFeatureFlagEnabled, useSignOut, …); its
//     bundle carries a hardcoded host table (us.i.posthog.com, eu.i.posthog.com, …).
//   - posthog-node is imported by apps/desktop/src/main/lib/analytics/index.ts.
//   - @sentry/electron is imported by main/lib/sentry.ts, main/lib/auto-updater.ts,
//     lib/trpc/index.ts, main/lib/host-service-coordinator.ts and preload/index.ts;
//     @sentry/node by three host-service modules. Their bundles carry
//     `.ingest.sentry.io`.
//
// Both SDKs are INERT after phase 1, but NOT because they are unreachable —
// be precise about the mechanism, because a later phase that "cleans up" the
// wrong thing would re-arm them:
//
//   - posthog-js IS initialised on every boot. PostHogProvider.tsx calls
//     initPostHog() from a useEffect (mounted via routes/-layout.tsx). What
//     makes it inert is the KEY GATE at the top of renderer/lib/posthog.ts,
//     which returns before posthog.init() when NEXT_PUBLIC_POSTHOG_KEY is
//     empty — combined with the fact that the key CANNOT be non-empty: the
//     vite `define` block bakes it at build time (so no runtime env can arm
//     it) and the build-time ban makes baking a value impossible.
//   - @sentry/electron is likewise reached: initSentry() runs in both main and
//     renderer. Its guard is the same shape — it returns unless
//     SENTRY_DSN_DESKTOP is set AND NODE_ENV is production — and the DSN is
//     baked and banned identically.
//
// So the key gate and the DSN gate are LOAD-BEARING. Do not delete either on
// the assumption that init is unreachable; it is not. What ships is a live SDK
// that is never handed credentials.
//
// Removing the imports outright is a ~20-file change that touches React
// components and a feature flag, which is a scope decision for a later phase,
// not something to slip into a telemetry-keys phase. When it happens, add the
// blanket scan here and bump PHASE.

if (failures > 0) {
	console.error(
		`::error::(CLOUD-SEVERANCE-P${PHASE}) ${failures} assertion(s) failed — refusing to pass.`,
	);
	process.exit(1);
}

// STAMP. The enforcing caller is `.github/workflows/build-arm64.yml`, which is
// frozen for the whole run and therefore cannot be edited by a mid-run
// (BUILD-REPAIR) agent. It deletes any stamp, runs this gate, then requires a
// stamp whose sha matches the sha it actually built and whose assertion count
// is at or above its own hard-coded minimum. That turns "the gate ran" from a
// text match on an editable step into a fact this script has to produce.
//
// The sha is derived HERE from the working tree, not taken from the caller's
// environment: the point is to record which tree this gate actually validated,
// so the workflow's independent comparison means something.
let validatedSha = "unknown";
try {
	validatedSha = execFileSync("git", ["rev-parse", "HEAD"], {
		cwd: repoRoot,
		encoding: "utf8",
	}).trim();
} catch {
	// Not a git checkout (or git unavailable): leave "unknown" so a caller that
	// compares against a real sha fails loud rather than silently accepting.
}
mkdirSync(dirname(stampPath), { recursive: true });
writeFileSync(
	stampPath,
	`${JSON.stringify(
		{
			phase: PHASE,
			sha: validatedSha,
			assertionsPassed,
			artifactsScanned: noArtifacts ? 0 : undefined,
			// The build workflow requires exactly "full". "partial" means an
			// artifact assertion was skipped; "no-artifacts" means all were.
			mode: noArtifacts
				? "no-artifacts"
				: skippedAnAssertion
					? "partial"
					: "full",
			generatedAt: new Date().toISOString(),
		},
		null,
		2,
	)}\n`,
);

console.log(
	`\n(CLOUD-SEVERANCE-P${PHASE}) all assertions passed (${assertionsPassed} executed). Stamp: ${relative(repoRoot, stampPath).replace(/\\/g, "/")} sha=${validatedSha}`,
);
