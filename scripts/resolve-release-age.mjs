/**
 * Dynamic resolver for Bun's `minimum-release-age` install guard.
 *
 * Upstream Superset's `bunfig.toml` sets `minimumReleaseAge` (currently
 * 72h). When upstream cuts a release that pins a dependency to a version
 * published inside that window, `bun install` fails loud with one line
 * per blocked package, e.g.:
 *
 *   error: No version matching "expo-constants" found for specifier
 *   "56.0.14" (blocked by minimum-release-age: 259200 seconds)
 *
 * This is a timing race, not a real breakage — an older version of the
 * same package is already aged past the gate. Rather than wait a night
 * (or hand-pin like the Mastra step), this script reads the failed
 * install log, and for every blocked package picks the newest version
 * that is BOTH (a) older than the age gate and (b) not greater than the
 * version upstream asked for — i.e. the latest safe version that stays
 * within upstream's intent — then writes it as a root `overrides` entry
 * and rewrites any direct dependency pins. The caller re-runs
 * `bun install` afterwards.
 *
 * Generalises the hardcoded "Pin Mastra dependencies" step to any
 * package, dynamically, so the nightly build never fails for this
 * reason. Fails loud (exit 1) only if a blocked package has NO aged-safe
 * version at or below the requested pin — that is a genuine problem the
 * build should not paper over.
 *
 * Usage: node resolve-release-age.mjs <path-to-bun-install-log>
 * Run with cwd = the upstream clone root (where the root package.json
 * and bunfig.toml live).
 *
 * Dependency-free: uses Node 22's global fetch + a minimal semver
 * comparator (the requested specifiers in practice are exact pins).
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const REGISTRY = "https://registry.npmjs.org";
// Pick versions comfortably past the gate so the boundary version isn't
// re-blocked between resolve and the install retry. The retry runs in
// seconds, so a few minutes of margin is plenty and keeps us close to
// upstream's requested version.
const SAFETY_MARGIN_MS = 5 * 60 * 1000;

const BLOCK_RE =
	/No version matching "([^"]+)" found for specifier "([^"]+)" \(blocked by minimum-release-age: (\d+) seconds\)/g;

const EXACT_RE = /^\d+\.\d+\.\d+(?:[-+].*)?$/;

/** Parse `x.y.z` (ignoring build metadata) into a numeric tuple. */
function parseCore(v) {
	const core = String(v).split("+")[0].split("-")[0];
	return core.split(".").map((n) => Number.parseInt(n, 10) || 0);
}

/** Compare two clean semver cores. <0 if a<b, 0 if equal, >0 if a>b. */
function cmpCore(a, b) {
	const A = parseCore(a);
	const B = parseCore(b);
	for (let i = 0; i < 3; i++) {
		if ((A[i] || 0) !== (B[i] || 0)) return (A[i] || 0) - (B[i] || 0);
	}
	return 0;
}

function isPrerelease(v) {
	return String(v).includes("-");
}

async function fetchRegistry(name) {
	const url = `${REGISTRY}/${name.replace("/", "%2F")}`;
	let lastErr;
	for (let attempt = 1; attempt <= 3; attempt++) {
		try {
			const ac = new AbortController();
			const t = setTimeout(() => ac.abort(), 20_000);
			const res = await fetch(url, {
				signal: ac.signal,
				headers: { accept: "application/json" },
			});
			clearTimeout(t);
			if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
			return await res.json();
		} catch (err) {
			lastErr = err;
			if (attempt < 3) await new Promise((r) => setTimeout(r, 1000 * attempt));
		}
	}
	throw lastErr;
}

/**
 * Pick the newest version of `name` that is older than `ageSeconds` and
 * (for an exact requested pin) not greater than `requested`. Returns the
 * chosen version string or null if none qualifies.
 */
function pickSafeVersion(meta, requested, ageSeconds) {
	const time = meta?.time;
	if (!time || typeof time !== "object") return null;
	const cutoff = Date.now() - ageSeconds * 1000 - SAFETY_MARGIN_MS;
	const requestedIsExact = EXACT_RE.test(requested);
	const requestedIsPre = isPrerelease(requested);

	const candidates = [];
	for (const [version, iso] of Object.entries(time)) {
		if (version === "created" || version === "modified") continue;
		if (!EXACT_RE.test(version)) continue;
		// Skip prereleases unless upstream explicitly asked for one.
		if (isPrerelease(version) && !requestedIsPre) continue;
		const published = Date.parse(iso);
		if (!Number.isFinite(published) || published > cutoff) continue;
		// Never upgrade past upstream's exact pin.
		if (requestedIsExact && cmpCore(version, requested) > 0) continue;
		candidates.push(version);
	}
	if (candidates.length === 0) return null;
	candidates.sort(cmpCore);
	return candidates[candidates.length - 1];
}

const dependencySections = [
	"dependencies",
	"devDependencies",
	"optionalDependencies",
];
const searchRoots = ["apps", "packages", "tooling"];

function collectPackageJsonFiles(directory, out) {
	if (!existsSync(directory)) return;
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const entryPath = join(directory, entry.name);
		if (entry.isDirectory()) {
			if ([".git", ".bun", "dist", "node_modules", "release"].includes(entry.name))
				continue;
			collectPackageJsonFiles(entryPath, out);
			continue;
		}
		if (entry.name === "package.json") out.push(entryPath);
	}
}

function applyPins(pins) {
	const files = ["package.json"];
	for (const root of searchRoots) collectPackageJsonFiles(root, files);

	const changes = [];
	for (const file of files) {
		const pkg = JSON.parse(readFileSync(file, "utf8"));
		let changed = false;

		if (file === "package.json") {
			pkg.overrides ??= {};
			for (const [name, version] of Object.entries(pins)) {
				if (pkg.overrides[name] !== version) {
					pkg.overrides[name] = version;
					changes.push(`${relative(process.cwd(), file)} overrides.${name}=${version}`);
					changed = true;
				}
			}
		}

		for (const section of dependencySections) {
			const deps = pkg[section];
			if (!deps) continue;
			for (const [name, version] of Object.entries(pins)) {
				if (deps[name] && deps[name] !== version) {
					deps[name] = version;
					changes.push(`${relative(process.cwd(), file)} ${section}.${name}=${version}`);
					changed = true;
				}
			}
		}

		if (changed) writeFileSync(file, `${JSON.stringify(pkg, null, "\t")}\n`);
	}
	return changes;
}

async function main() {
	const logPath = process.argv[2];
	if (!logPath || !existsSync(logPath)) {
		console.error(`resolve-release-age: log file not found: ${logPath}`);
		process.exit(2);
	}
	const log = readFileSync(logPath, "utf8");

	// Collect unique blocked packages (keep the strictest age seen).
	const blocks = new Map();
	for (const m of log.matchAll(BLOCK_RE)) {
		const [, name, specifier, seconds] = m;
		const ageSeconds = Number.parseInt(seconds, 10);
		const prev = blocks.get(name);
		if (!prev || ageSeconds > prev.ageSeconds) {
			blocks.set(name, { specifier, ageSeconds });
		}
	}

	if (blocks.size === 0) {
		console.error(
			"resolve-release-age: no minimum-release-age blocks found in log; nothing to resolve.",
		);
		// Signal "not my failure" so the caller fails with the original error.
		process.exit(3);
	}

	console.log(`Resolving ${blocks.size} package(s) blocked by minimum-release-age:`);

	const pins = {};
	const unresolved = [];
	for (const [name, { specifier, ageSeconds }] of blocks) {
		let meta;
		try {
			meta = await fetchRegistry(name);
		} catch (err) {
			unresolved.push(`${name} (registry fetch failed: ${err.message})`);
			continue;
		}
		const safe = pickSafeVersion(meta, specifier, ageSeconds);
		if (!safe) {
			unresolved.push(
				`${name} (no aged-safe version <= requested "${specifier}")`,
			);
			continue;
		}
		pins[name] = safe;
		console.log(`  ${name}: ${specifier} (too new) -> ${safe} (aged-safe)`);
	}

	if (unresolved.length > 0) {
		console.error("resolve-release-age: could not resolve:");
		for (const u of unresolved) console.error(`  - ${u}`);
		process.exit(1);
	}

	const changes = applyPins(pins);
	if (changes.length === 0) {
		console.log(
			"resolve-release-age: resolved versions already applied (no file changes).",
		);
	} else {
		console.log(`Applied pins:\n${changes.map((c) => `  ${c}`).join("\n")}`);
	}
}

main().catch((err) => {
	console.error(`resolve-release-age: unexpected error: ${err?.stack || err}`);
	process.exit(1);
});
