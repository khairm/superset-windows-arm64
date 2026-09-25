// Ratchet: keeps blocking work off the Electron main process. Every
// electronTrpc call is served by this one event loop — an in-process git
// spawn or sync fs walk stalls all of them. Git reads belong in the changes
// git worker (src/lib/trpc/routers/changes/workers/).
//
// Counts are per-file matching-line counts, not a file allowlist, so an
// already-listed file cannot silently grow new call sites. Patterns match
// bare identifiers (not just calls) so renamed imports and passed-around
// references count too. Two failure modes, both intentional:
//  - a file exceeds its count → new blocking call site; add a worker task
//    type instead of bumping the number.
//  - a file drops below its count → it was partially or fully fixed;
//    LOWER or DELETE its entry so the ratchet only ever tightens.
//
// (BLOCKING-FS-RATCHET) — fork rule "sync fs read/stat/append" below. The
// footgun it guards is measured, not theoretical: synchronous fs on the main
// thread at startup starves the renderer's superset-app:// loader and the
// window stays blank for minutes (AGENTS.md, Live footguns).

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const SRC_DIR = path.resolve(import.meta.dirname);
const SELF = path.resolve(
	import.meta.dirname,
	"no-main-process-blocking.test.ts",
);

// Main-process code only: lib/trpc routers and main/. The renderer has its
// own thread and the worker dir owns the git primitives.
const SCANNED_DIRS = ["lib", "main"];

interface Rule {
	name: string;
	pattern: RegExp;
	/** Repo-relative (from src/) file → exact matching-line count allowed. */
	allowedCounts: Record<string, number>;
	/**
	 * Optional narrowing: only files whose repo-relative path starts with one
	 * of these prefixes are counted. Omitted = every scanned file.
	 */
	restrictTo?: string[];
	advice: string;
}

const RULES: Rule[] = [
	{
		name: "sync subprocess (execSync/spawnSync/execFileSync)",
		pattern: /\b(execSync|spawnSync|execFileSync)\b/,
		allowedCounts: {
			// Cold daemon-recovery path only (connect failure / respawn).
			"main/lib/terminal-host/client.ts": 2,
			// (BLOCKING-FS-RATCHET) pre-existing fork debt at bdc2422944, inherited
			// rather than written here: this file is byte-identical to upstream
			// desktop-v1.30.2. The six matches are not call sites either — it
			// monkey-patches node:child_process so every spawn variant defaults to
			// windowsHide, so these lines bind and reassign the three sync
			// variants and the blocking stays with whoever calls them. Delete this
			// entry when upstream drops the patch, and never raise it.
			"main/lib/windows-child-process-patch.ts": 6,
		},
		advice:
			"Sync subprocesses freeze the Electron main process until the child exits — every electronTrpc response and IPC event queues behind it, so the whole app feels hung. Prefer async spawn/execFile: the caller awaits the same result, but main keeps serving while the child runs.",
	},
	{
		name: "sync recursive fs (rmSync/cpSync)",
		pattern: /\b(rmSync|cpSync)\b/,
		allowedCounts: {
			// Workspace-setup copy, cold path.
			"lib/trpc/routers/workspaces/utils/setup.ts": 2,
			// (BLOCKING-FS-RATCHET) pre-existing fork debt at bdc2422944, inherited
			// rather than written here: this file is byte-identical to upstream
			// desktop-v1.30.2. The one match is the bare name in its node:fs import
			// list, with no call anywhere in the file. Delete this entry when
			// upstream drops the import, and never raise it.
			"main/lib/local-identity/local-org.ts": 1,
		},
		advice:
			"rmSync/cpSync walk the whole tree on the Electron main process — a large copy or delete stalls every electronTrpc response for seconds. Prefer `await rm/cp` from node:fs/promises: same result, but the walk runs on libuv's thread pool while main keeps serving.",
	},
	{
		name: "in-process git client construction",
		pattern: /\b(simpleGit|getSimpleGitWithShellPath)\b/,
		allowedCounts: {
			// The factory module itself — permanent entry.
			"lib/trpc/routers/workspaces/utils/git-client.ts": 4,
			// Legacy on-main git spawners — shrink these counts by porting reads
			// to worker task types (changes/workers/git-task-types.ts).
			"lib/trpc/routers/changes/git-operations.ts": 2,
			"lib/trpc/routers/changes/security/git-commands.ts": 2,
			"lib/trpc/routers/changes/staging.ts": 2,
			"lib/trpc/routers/projects/projects.ts": 6,
			"lib/trpc/routers/workspaces/utils/base-branch-config.ts": 4,
			"lib/trpc/routers/workspaces/utils/git.ts": 21,
		},
		advice:
			"simple-git is async, but a client constructed here still pays the spawn syscall + stdout drain on the Electron main process — cost scales linearly with call volume (branch polls, sidebar rows). Async isn't enough for git; route it off-process: add a task type to changes/workers/git-task-types.ts and run it via runGitTask.",
	},
	{
		// (BLOCKING-FS-RATCHET). Scoped to main/ — the Electron main entry point
		// and everything it pulls in during boot. lib/trpc is request-time code
		// already covered by the three rules above and carries a far larger sync
		// fs inventory; widening this rule to it would need its own baseline.
		//
		// No worker exemption is listed because none is needed: the only worker
		// entry point under main/ is main/git-task-worker.ts (it is the sole
		// importer of node:worker_threads' parentPort there) and it contains zero
		// matches, so exempting it would change nothing.
		name: "sync fs read/stat/append (blocking main-thread fs)",
		restrictTo: ["main/"],
		pattern:
			/\b(statSync|readFileSync|readSync|openSync|appendFileSync|renameSync|existsSync)\b/,
		allowedCounts: {
			"main/lib/agent-jsonl-watcher/agent-jsonl-watcher.ts": 4,
			// Two script-write reads on the install path, plus the read and the
			// atomic-swap rename of the ONE synchronous hook rewrite left, which
			// the process `exit` handler alone reaches — it has no tick to await,
			// and a torn ~/.claude/settings.json would cost the user every hook
			// they have. The boot path itself is now free of blocking fs here: the
			// perf-ui-choking branch moved the shared-file merge and both
			// directory probes to node:fs/promises and dropped the per-profile
			// settings.json probe (its cost scaled with the number of Claude
			// profile folders).
			"main/lib/agent-jsonl-watcher/pane-map-hook.ts": 4,
			"main/lib/app-environment.ts": 2,
			"main/lib/app-state/index.ts": 2,
			"main/lib/auto-resume/config/config.ts": 1,
			"main/lib/auto-resume/registry/registry.ts": 1,
			"main/lib/browser/chrome-cookie-import.ts": 3,
			"main/lib/browser/chrome-history-import.ts": 3,
			"main/lib/browser/chromium-profiles.ts": 5,
			"main/lib/browser/download-manager.ts": 3,
			"main/lib/bundled-cli.ts": 9,
			"main/lib/custom-ringtones.ts": 13,
			"main/lib/dev-workspace-name.ts": 2,
			"main/lib/dock-icon.ts": 3,
			"main/lib/extensions/index.ts": 7,
			"main/lib/host-db-workspace-name.ts": 3,
			"main/lib/host-service-coordinator.ts": 3,
			"main/lib/host-service-lock.ts": 5,
			"main/lib/host-service-manifest.ts": 8,
			"main/lib/local-db/index.ts": 4,
			"main/lib/local-identity/local-org.ts": 9,
			"main/lib/play-sound.ts": 2,
			"main/lib/project-icons.ts": 3,
			"main/lib/sound-paths.ts": 3,
			"main/lib/static-ports/loader.ts": 4,
			"main/lib/terminal-host/client.ts": 34,
			"main/lib/terminal/env.ts": 4,
			"main/lib/tray/index.ts": 4,
			"main/lib/window-state/window-state.ts": 9,
			"main/network-logger/index.ts": 7,
			"main/terminal-host/index.ts": 10,
		},
		advice:
			"Synchronous fs blocks the Electron main process for the whole syscall, and on the boot path that is what leaves the window blank: the renderer's superset-app:// loader is served from this same event loop, so every stat and read at startup delays first paint. Use node:fs/promises (await stat/readFile/rename/appendFile) and probe with a caught ENOENT instead of existsSync, which is a second syscall that races the open that follows it.",
	},
];

// Prefix, not dirname-suffix: nested subdirectories of the worker dir are
// worker code too.
const EXEMPT_DIR_PREFIXES = ["lib/trpc/routers/changes/workers/"];
const EXEMPT_FILE_PATTERNS = [/\.test\.tsx?$/, /(^|\/)test-helpers\.ts$/];

/**
 * Matching lines after comment stripping — prose mentions don't count.
 * Line-comment stripping is naive (`//` inside a string truncates the rest
 * of that line), which can only under-count, never false-positive.
 */
function countMatchingLines(contents: string, pattern: RegExp): number {
	const stripped = contents.replace(/\/\*[\s\S]*?\*\//g, "");
	let count = 0;
	for (const line of stripped.split("\n")) {
		if (pattern.test(line.replace(/\/\/.*$/, ""))) count++;
	}
	return count;
}

function* walk(dir: string): Generator<string> {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules" || entry.name === "dist") continue;
			yield* walk(full);
			continue;
		}
		if (!entry.isFile()) continue;
		if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) continue;
		if (full === SELF) continue;
		yield full;
	}
}

function relevantFiles(): string[] {
	const files: string[] = [];
	for (const scanned of SCANNED_DIRS) {
		const root = path.join(SRC_DIR, scanned);
		if (!fs.existsSync(root)) continue;
		for (const file of walk(root)) {
			// Forward slashes so allowlists match on Windows too.
			const rel = path.relative(SRC_DIR, file).split(path.sep).join("/");
			if (EXEMPT_DIR_PREFIXES.some((prefix) => rel.startsWith(prefix)))
				continue;
			if (EXEMPT_FILE_PATTERNS.some((pattern) => pattern.test(rel))) continue;
			files.push(rel);
		}
	}
	return files;
}

describe("no new main-process blocking call sites", () => {
	const files = relevantFiles();

	for (const rule of RULES) {
		test(rule.name, () => {
			const counts = new Map<string, number>();
			const scoped = rule.restrictTo
				? files.filter((rel) =>
						rule.restrictTo?.some((prefix) => rel.startsWith(prefix)),
					)
				: files;
			for (const rel of scoped) {
				const contents = fs.readFileSync(path.join(SRC_DIR, rel), "utf-8");
				const count = countMatchingLines(contents, rule.pattern);
				if (count > 0) counts.set(rel, count);
			}

			const offenders = [...counts]
				.filter(([rel, count]) => count > (rule.allowedCounts[rel] ?? 0))
				.map(
					([rel, count]) =>
						`${rel} (${count} > ${rule.allowedCounts[rel] ?? 0})`,
				)
				.sort();
			expect(offenders, `New blocking call site(s). ${rule.advice}`).toEqual(
				[],
			);

			const stale = Object.entries(rule.allowedCounts)
				.filter(([rel, allowed]) => (counts.get(rel) ?? 0) < allowed)
				.map(
					([rel, allowed]) => `${rel} (${counts.get(rel) ?? 0} < ${allowed})`,
				)
				.sort();
			expect(
				stale,
				"Allowlisted count(s) too high — lower or delete them in allowedCounts so the ratchet tightens.",
			).toEqual([]);
		});
	}
});
