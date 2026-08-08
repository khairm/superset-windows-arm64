/**
 * (PROVEN-VERSION-DRIFT) Is the Claude Code we are driving the one the picker
 * contract was proven against?
 *
 * `keystrokes.PROVEN_AGAINST` records a fact about a SPECIFIC Claude Code build:
 * which bytes drive its AskUserQuestion picker, and what that picker renders.
 * Claude Code auto-updates. Twice now the fork learned the build had moved only
 * because a user was refused — the free-text row's label changed from "Other" to
 * "Type something." and a new "Chat about this" row appeared — and in both cases
 * the evidence was sitting in the installed package all along.
 *
 * WHAT THIS DELIBERATELY IS NOT:
 *
 *   - not a build gate. The fork does not add build-time gates, and a version
 *     read on the machine that runs the bridge cannot be checked on a CI box
 *     anyway.
 *   - not a refusal. Drift is a prompt to re-prove the contract, NOT evidence
 *     that any particular answer is unsafe. A bridge that refused every answer
 *     the morning after an auto-update would be a worse outage than the drift it
 *     was warning about, and the guards already fail closed on the specific
 *     things drift breaks (unknown free-text copy, an unproven prompt shape).
 *   - not a clock. It is read once, when the bridge starts, and reported.
 *
 * Read once per process (memoised).
 *
 * UNKNOWN IS NOT MISMATCH. If the CLI cannot be located — a bun-compiled binary
 * somewhere unusual, a user who installs it another way — `installed` is `null`
 * and `mismatch` is FALSE. Reporting a scary mismatch on the strength of a failed
 * file read would train the reader to ignore the real ones.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PROVEN_AGAINST } from "./keystrokes";

export interface ProvenVersionStatus {
	/** `claude-code@<version>` as installed, or `null` if it could not be read. */
	installed: string | null;
	/** The build the picker contract was proven against. */
	proven: string;
	/** true ONLY when both are known AND they differ. */
	mismatch: boolean;
}

/**
 * Where a `@anthropic-ai/claude-code` install puts its `package.json`.
 *
 * An explicit list rather than a filesystem walk: this runs at bridge start, and
 * the one thing it must never do is turn startup into a directory crawl — the
 * renderer's loader starves behind blocking startup work on this platform.
 * `SUPERSET_CLAUDE_CODE_PACKAGE_JSON` overrides everything for an unusual layout
 * or for a test.
 */
function candidatePaths(): string[] {
	const override = process.env.SUPERSET_CLAUDE_CODE_PACKAGE_JSON;
	if (override !== undefined && override.length > 0) return [override];
	const home = os.homedir();
	const appData = process.env.APPDATA;
	const paths: string[] = [];
	if (appData !== undefined && appData.length > 0) {
		paths.push(
			path.join(
				appData,
				"npm",
				"node_modules",
				"@anthropic-ai",
				"claude-code",
				"package.json",
			),
		);
	}
	paths.push(
		path.join(
			home,
			".claude",
			"local",
			"node_modules",
			"@anthropic-ai",
			"claude-code",
			"package.json",
		),
		path.join(
			home,
			".npm-global",
			"lib",
			"node_modules",
			"@anthropic-ai",
			"claude-code",
			"package.json",
		),
		path.join(
			"/usr",
			"local",
			"lib",
			"node_modules",
			"@anthropic-ai",
			"claude-code",
			"package.json",
		),
	);
	return paths;
}

/**
 * Best effort, and every failure is `null` rather than a throw: this is a
 * diagnostic, and a diagnostic that can break the thing it reports on is worse
 * than no diagnostic.
 */
export async function readInstalledClaudeCodeVersion(): Promise<string | null> {
	for (const candidate of candidatePaths()) {
		try {
			const raw = await fs.readFile(candidate, "utf8");
			const parsed: unknown = JSON.parse(raw);
			if (
				typeof parsed === "object" &&
				parsed !== null &&
				"version" in parsed &&
				typeof (parsed as { version: unknown }).version === "string"
			) {
				const version = (parsed as { version: string }).version;
				if (version.length > 0) return `claude-code@${version}`;
			}
		} catch {
			// Not here, unreadable, or not JSON. Try the next candidate; an install
			// this code cannot see is reported as unknown, never as a mismatch.
		}
	}
	return null;
}

/**
 * Memoised, but ONLY ON SUCCESS. The header calls this a once-at-start read, and
 * it was — until `companion.gate` began reporting it, at which point the
 * keep-awake poll called it every 15 seconds, up to four `readFile` attempts a
 * tick, forever. The installed version cannot change under a running process, so
 * one successful read is not just an optimisation, it is the honest cardinality.
 *
 * A FAILED read is deliberately not retained. Every failure here resolves to
 * `installed: null`, which is indistinguishable from "no install found" — and a
 * transient miss is entirely possible at bridge start, when the process is
 * competing for disk with everything else coming up. Caching that would pin the
 * bridge to "unknown version" for its whole lifetime on the strength of one bad
 * moment, and unknown suppresses the drift warning, so the failure mode is a
 * diagnostic that goes quiet exactly when it might have had something to say.
 * Retrying costs at most a few `readFile` calls on a poll that was already
 * running.
 */
let cached: Promise<ProvenVersionStatus> | null = null;

export function resolveProvenVersionStatus(): Promise<ProvenVersionStatus> {
	if (cached !== null) return cached;
	const attempt = computeProvenVersionStatus();
	cached = attempt;
	// Drop the cache unless the read actually found something. The identity check
	// matters: a later call may already have replaced `cached` with its own
	// attempt, and clearing that one would throw away a good result.
	attempt.then(
		(status) => {
			if (status.installed === null && cached === attempt) cached = null;
		},
		() => {
			if (cached === attempt) cached = null;
		},
	);
	return attempt;
}

async function computeProvenVersionStatus(): Promise<ProvenVersionStatus> {
	const installed = await readInstalledClaudeCodeVersion();
	return {
		installed,
		proven: PROVEN_AGAINST,
		mismatch: installed !== null && installed !== PROVEN_AGAINST,
	};
}

/**
 * Log the mismatch loudly, ONCE, at bridge start — and say nothing at all when
 * the versions agree or the install could not be found, so the line means
 * something when it does appear.
 */
export function logProvenVersionStatus(
	status: ProvenVersionStatus,
	log: (event: Record<string, unknown>) => void,
): void {
	if (!status.mismatch) return;
	log({
		event: "companion.picker_contract.version_drift",
		installed: status.installed,
		proven: status.proven,
		note: "the AskUserQuestion picker contract (keystrokes.ts) was proven against a different Claude Code build; re-prove it in a pty and update PROVEN_AGAINST. Answers are NOT being refused for this.",
	});
}
