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
 * .github/workflows/build-arm64.yml requires mode=full and a minimum assertion
 * count, so neither convenience flag can stand in for a real gate run.
 *
 * With artifacts missing and no --no-artifacts flag, this FAILS LOUD rather
 * than skipping: a gate that silently passes when it cannot see the thing it
 * guards is worse than no gate.
 */

import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Bump when a later phase widens the assertions below. */
const PHASE = 1;

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
		"  Skipped: outlit.ai absence, upstream releases URL absence, app-update.yml, telemetry secret shapes, CSP contents, CORS shim contents.",
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
	//    `api.superset.sh` IS still present in this binary and that is correct:
	//    the CLI's auth/resolveAuth chain legitimately targets it in phase 1.
	//    Only the analytics route is asserted absent.
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
		const needles = ["analytics.captureEvent", "cli_command_invoked"];
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

	// 9. No packaged app-update.yml may name upstream.
	//
	//    With `publish: null` in electron-builder.ts the CORRECT result is ZERO
	//    manifests: app-builder-lib writes app-update.yml only when the resolved
	//    publish config is non-null (out/publish/PublishManager.js — `if
	//    (publishConfig != null)` guards the write). So "0 found" is the expected
	//    healthy state and must NOT be treated as a failure.
	//
	//    But "found nothing" must still not be able to pass VACUOUSLY, which it
	//    would if release/ existed while containing no packaging output at all
	//    (a packaging step that silently produced nothing, or wrote elsewhere).
	//    Two guards close that without inverting the invariant: the packaged
	//    output must actually exist, and the manifest search covers dist/ as well
	//    as release/, so a manifest that moved out of the packaged tree is still
	//    caught rather than quietly missed.
	if (existsSync(releaseRoot)) {
		const findFiles = (dir, predicate, out = []) => {
			for (const entry of readdirSync(dir)) {
				const full = join(dir, entry);
				if (statSync(full).isDirectory()) findFiles(full, predicate, out);
				else if (predicate(entry)) out.push(full);
			}
			return out;
		};

		// Positive control: prove we scanned a real package before concluding
		// anything from an absence.
		const packagedFiles = findFiles(releaseRoot, () => true);
		if (packagedFiles.length === 0) {
			fail(
				`packaging output directory ${relative(repoRoot, releaseRoot).replace(/\\/g, "/")} exists but is EMPTY — the app-update.yml scan would conclude "none found" without having inspected a package. Refusing to pass vacuously.`,
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
					`no app-update.yml names superset-sh (${manifests.length} manifest(s) across ${packagedFiles.length} packaged file(s); publish:null means 0 is expected)`,
				);
			}
		}
	} else if (allowUnpackaged) {
		skippedAnAssertion = true;
		console.log(
			"  note  apps/desktop/release absent and --allow-unpackaged given — app-update.yml assertion SKIPPED. This run is stamped mode=partial and the build workflow will reject it.",
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
