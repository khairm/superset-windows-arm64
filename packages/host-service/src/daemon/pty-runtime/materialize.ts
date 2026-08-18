// (PTY-RUNTIME-SIDECAR) — materialise the pty-daemon's runtime outside the
// install directory, and reclaim the ones nothing is using.
//
// All IO goes through the injected `RuntimeIo` so every decision below is
// exercisable on any platform. The real implementation lives in `index.ts`.

import * as path from "node:path";
import {
	CHUNKS_DIR_NAME,
	DAEMON_SCRIPT_NAME,
	type DirEntryInfo,
	NODE_MODULES_DIR_NAME,
	type PtyRuntimeLayout,
	parseRuntimeRef,
	ptyRuntimeKey,
	ptyRuntimeLayout,
	READY_MARKER_NAME,
	REFS_DIR_NAME,
	RUNTIME_APP_DIR,
	type RuntimeDirEntry,
	type RuntimeRef,
	requiredDaemonPackages,
	runtimeRefFileName,
	SIDECAR_EXE_NAME,
	scratchDirName,
	selectElectronRuntimeEntries,
	selectRuntimeDirsToRemove,
	serializeRuntimeRef,
} from "./plan.ts";

export interface SmokeResult {
	ok: boolean;
	reason?: string;
}

export interface RuntimeIo {
	exists(target: string): Promise<boolean>;
	readdir(dir: string): Promise<DirEntryInfo[]>;
	mtimeMs(target: string): Promise<number>;
	readFile(target: string): Promise<Buffer>;
	writeFile(target: string, data: Buffer | string): Promise<void>;
	mkdirp(dir: string): Promise<void>;
	/** Real-filesystem copy. Never used for paths inside an asar archive. */
	copyRealFile(from: string, to: string): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	removeRecursive(target: string): Promise<void>;
	/** Run the copied binary for real; the only honest proof it works. */
	smokeTest(exePath: string, cwd: string): Promise<SmokeResult>;
	isProcessAlive(pid: number): boolean;
	now(): number;
	nonce(): string;
	log(level: "info" | "warn" | "error", message: string): void;
}

export type SidecarResult =
	| {
			ok: true;
			key: string;
			root: string;
			exePath: string;
			scriptPath: string;
			/** False when this call did the copying. */
			reused: boolean;
	  }
	| { ok: false; reason: string };

export interface MaterializeInput {
	io: RuntimeIo;
	/** Directory holding every versioned runtime, e.g. %LOCALAPPDATA%\... */
	base: string;
	/** Directory containing the Electron runtime files (the install root). */
	installRoot: string;
	/** File name of the Electron binary inside `installRoot`. */
	exeName: string;
	/** Source `pty-daemon.js`; normally inside `resources\app.asar`. */
	daemonScriptPath: string;
	daemonVersion: string;
	electronVersion: string;
	platform: string;
	arch: string;
}

const MAX_NODE_MODULES_LOOKUP_DEPTH = 8;

function isSourceMap(name: string): boolean {
	return name.toLowerCase().endsWith(".map");
}

/**
 * Copy a real-filesystem tree. `copyRealFile` per file so a partially copied
 * tree is never mistaken for a complete one — nothing reads the staging dir
 * until the ready marker lands in it.
 */
async function copyRealTree(
	io: RuntimeIo,
	from: string,
	to: string,
): Promise<void> {
	await io.mkdirp(to);
	for (const entry of await io.readdir(from)) {
		const src = path.join(from, entry.name);
		const dest = path.join(to, entry.name);
		if (entry.isDirectory) {
			await copyRealTree(io, src, dest);
		} else {
			await io.copyRealFile(src, dest);
		}
	}
}

/**
 * Copy a tree that may live inside `app.asar`. Read-then-write rather than
 * `copyFile`: Electron's asar shim is what makes a read of an in-archive path
 * work at all, and read/write is the pair the app itself depends on to load
 * its own bundles. `copyFile` on an archive path is a coin flip.
 *
 * Returns the number of files written so callers can fail loud on an empty
 * source they expected to be populated.
 */
async function copyArchiveTree(
	io: RuntimeIo,
	from: string,
	to: string,
	skip?: (name: string) => boolean,
): Promise<number> {
	await io.mkdirp(to);
	let written = 0;
	for (const entry of await io.readdir(from)) {
		const src = path.join(from, entry.name);
		const dest = path.join(to, entry.name);
		if (entry.isDirectory) {
			written += await copyArchiveTree(io, src, dest, skip);
			continue;
		}
		if (skip?.(entry.name)) continue;
		await io.writeFile(dest, await io.readFile(src));
		written += 1;
	}
	return written;
}

/**
 * Walk up from the daemon script looking for the `node_modules` that its
 * `require("node-pty")` would resolve to. Never hardcodes the packaged layout:
 * the same walk finds `app.asar/node_modules` in production and the workspace
 * root in a source checkout.
 */
async function findDaemonNodeModules(
	io: RuntimeIo,
	startDir: string,
): Promise<string> {
	let dir = startDir;
	for (let depth = 0; depth < MAX_NODE_MODULES_LOOKUP_DEPTH; depth += 1) {
		const candidate = path.join(dir, NODE_MODULES_DIR_NAME);
		if (await io.exists(path.join(candidate, "node-pty"))) return candidate;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	throw new Error(
		`(PTY-RUNTIME-SIDECAR) no node_modules/node-pty found above ${startDir}`,
	);
}

/**
 * Remove a runtime directory through a rename.
 *
 * The rename is the liveness gate, not a tidiness measure: Windows refuses to
 * rename a directory that is a running process's working directory or that
 * contains a mapped image, so a directory a daemon is still using simply
 * cannot be discarded here. A straight recursive delete has no such property —
 * it would unlink the plain `.js` files first and corrupt a live runtime
 * before failing on the exe.
 */
async function discardRuntimeDir(
	io: RuntimeIo,
	base: string,
	dirName: string,
): Promise<void> {
	const pending = path.join(base, scratchDirName(dirName, "gc", io.nonce()));
	await io.rename(path.join(base, dirName), pending);
	await io.removeRecursive(pending);
}

/**
 * Is the runtime at `layout` actually usable, or only marked as such?
 *
 * The `.ready` marker on its own is not evidence. It is an ordinary file in an
 * ordinary user-writable directory, and the two things a spawn cannot do
 * without — the renamed Electron binary and the daemon entry script — can go
 * missing underneath it. Antivirus quarantining `superset-ptyd.exe` is the
 * realistic case: it is unsigned, freshly written and freshly RENAMED, which
 * is a heuristic bullseye, and this fork is already SmartScreen-flagged.
 *
 * Trusting the marker there is how the user ends up with NO terminals at all:
 * every call reports `reused`, every spawn ENOENTs, the crash circuit opens,
 * and the loud install-directory fallback — which only ever fired on a
 * MATERIALISATION failure — never gets a turn. Two stats on a path that
 * otherwise costs one, and both outside any asar.
 */
async function isRuntimeUsable(
	io: RuntimeIo,
	layout: PtyRuntimeLayout,
): Promise<boolean> {
	return (
		(await io.exists(layout.readyMarker)) &&
		(await io.exists(layout.exePath)) &&
		(await io.exists(layout.scriptPath))
	);
}

function succeed(layout: PtyRuntimeLayout, reused: boolean): SidecarResult {
	return {
		ok: true,
		key: layout.key,
		root: layout.root,
		exePath: layout.exePath,
		scriptPath: layout.scriptPath,
		reused,
	};
}

/**
 * Ensure a ready runtime exists for the current daemon build and return where
 * it is. Never throws: the caller's fallback is to spawn out of the install
 * directory (today's behaviour), which works but forfeits install survival, so
 * a failure has to be reportable rather than fatal.
 */
export async function materializePtyRuntime(
	input: MaterializeInput,
): Promise<SidecarResult> {
	const { io } = input;
	let staging: string | null = null;
	try {
		const scriptBytes = await io.readFile(input.daemonScriptPath);
		const key = ptyRuntimeKey({
			daemonVersion: input.daemonVersion,
			electronVersion: input.electronVersion,
			scriptBytes,
		});
		const layout = ptyRuntimeLayout(input.base, key);
		if (await isRuntimeUsable(io, layout)) return succeed(layout, true);

		await io.mkdirp(input.base);
		staging = path.join(input.base, scratchDirName(key, "tmp", io.nonce()));
		await io.removeRecursive(staging);
		await io.mkdirp(staging);

		const selection = selectElectronRuntimeEntries(
			await io.readdir(input.installRoot),
			input.exeName,
		);
		for (const name of selection.files) {
			const destName = name === input.exeName ? SIDECAR_EXE_NAME : name;
			await io.copyRealFile(
				path.join(input.installRoot, name),
				path.join(staging, destName),
			);
		}
		for (const name of selection.dirs) {
			await copyRealTree(
				io,
				path.join(input.installRoot, name),
				path.join(staging, name),
			);
		}

		const appDir = path.join(staging, RUNTIME_APP_DIR);
		await io.mkdirp(appDir);
		await io.writeFile(path.join(appDir, DAEMON_SCRIPT_NAME), scriptBytes);

		const sourceDir = path.dirname(input.daemonScriptPath);
		const chunkCount = await copyArchiveTree(
			io,
			path.join(sourceDir, CHUNKS_DIR_NAME),
			path.join(appDir, CHUNKS_DIR_NAME),
			isSourceMap,
		);
		if (chunkCount === 0) {
			throw new Error(
				`(PTY-RUNTIME-SIDECAR) no chunks copied from ${path.join(sourceDir, CHUNKS_DIR_NAME)} — the daemon entry requires ./chunks/*`,
			);
		}

		const nodeModules = await findDaemonNodeModules(io, sourceDir);
		const stagedNodeModules = path.join(staging, NODE_MODULES_DIR_NAME);
		for (const pkg of requiredDaemonPackages(input.platform, input.arch)) {
			const copied = await copyArchiveTree(
				io,
				path.join(nodeModules, pkg),
				path.join(stagedNodeModules, pkg),
			);
			if (copied === 0) {
				throw new Error(
					`(PTY-RUNTIME-SIDECAR) copied no files for ${pkg} from ${nodeModules}`,
				);
			}
		}

		const smoke = await io.smokeTest(
			path.join(staging, SIDECAR_EXE_NAME),
			staging,
		);
		if (!smoke.ok) {
			throw new Error(
				`(PTY-RUNTIME-SIDECAR) staged runtime failed its smoke test: ${smoke.reason ?? "unknown"}`,
			);
		}

		// Ready marker inside the staging dir, so the rename below is the single
		// atomic commit. A crash at any earlier point leaves only scratch.
		await io.writeFile(path.join(staging, READY_MARKER_NAME), key);

		if (await io.exists(layout.root)) {
			if (await isRuntimeUsable(io, layout)) {
				// Another process finished the same key while we were copying.
				await io.removeRecursive(staging);
				staging = null;
				return succeed(layout, true);
			}
			await discardRuntimeDir(io, input.base, key);
		}
		try {
			await io.rename(staging, layout.root);
		} catch (err) {
			if (await isRuntimeUsable(io, layout)) {
				await io.removeRecursive(staging);
				staging = null;
				return succeed(layout, true);
			}
			throw err;
		}
		staging = null;
		io.log("info", `(PTY-RUNTIME-SIDECAR) materialised runtime ${key}`);
		return succeed(layout, false);
	} catch (err) {
		if (staging) {
			try {
				await io.removeRecursive(staging);
			} catch {
				// The GC sweep reclaims abandoned staging dirs by age.
			}
		}
		return { ok: false, reason: (err as Error).message };
	}
}

/**
 * Mark a runtime unusable so the next materialisation rebuilds it.
 *
 * The caller is a spawn that just failed out of this runtime, which means the
 * copy is not trustworthy however well it stat-checks — the smoke test passed
 * once, so whatever broke happened afterwards. Removing the marker is enough:
 * a directory without `.ready` is already "not ready" everywhere.
 *
 * Deliberately NOT `discardRuntimeDir`. Another org's daemon may be running out
 * of this very key, and unlinking its plain `.js` conout worker underneath it
 * is exactly the corruption the rename gate exists to prevent. Losing 350 MB
 * to the next GC sweep is the cheap half of this trade.
 */
export async function invalidateRuntime(
	io: RuntimeIo,
	base: string,
	key: string,
): Promise<void> {
	await io.removeRecursive(ptyRuntimeLayout(base, key).readyMarker);
}

/** Record that `pid` is running out of `key`, so GC leaves that runtime alone. */
export async function writeRuntimeRef(
	io: RuntimeIo,
	base: string,
	ref: RuntimeRef,
): Promise<void> {
	const dir = path.join(base, REFS_DIR_NAME);
	await io.mkdirp(dir);
	await io.writeFile(
		path.join(dir, runtimeRefFileName(ref.pid)),
		serializeRuntimeRef(ref),
	);
}

/**
 * Keys claimed by a still-running daemon. Dead pids' records are dropped as we
 * go. A recycled pid can only ever over-protect a runtime, never condemn one.
 */
export async function collectLiveRuntimeKeys(
	io: RuntimeIo,
	base: string,
): Promise<Set<string>> {
	const dir = path.join(base, REFS_DIR_NAME);
	const live = new Set<string>();
	if (!(await io.exists(dir))) return live;
	for (const entry of await io.readdir(dir)) {
		if (entry.isDirectory) continue;
		const file = path.join(dir, entry.name);
		let ref: RuntimeRef | null = null;
		try {
			ref = parseRuntimeRef((await io.readFile(file)).toString("utf-8"));
		} catch {
			ref = null;
		}
		if (ref && io.isProcessAlive(ref.pid)) {
			live.add(ref.key);
			continue;
		}
		try {
			await io.removeRecursive(file);
		} catch {
			// best-effort; a stale ref only costs us a delayed reclaim
		}
	}
	return live;
}

export interface GcOutcome {
	removed: string[];
	/** Present but not reclaimable right now — retried on the next spawn. */
	skipped: string[];
}

export async function gcPtyRuntimes(input: {
	io: RuntimeIo;
	base: string;
	currentKey: string;
	scratchMaxAgeMs?: number;
}): Promise<GcOutcome> {
	const { io, base } = input;
	const outcome: GcOutcome = { removed: [], skipped: [] };
	if (!(await io.exists(base))) return outcome;

	const liveKeys = await collectLiveRuntimeKeys(io, base);
	const entries: RuntimeDirEntry[] = [];
	for (const entry of await io.readdir(base)) {
		if (!entry.isDirectory) continue;
		entries.push({
			name: entry.name,
			mtimeMs: await io.mtimeMs(path.join(base, entry.name)),
		});
	}

	for (const name of selectRuntimeDirsToRemove({
		entries,
		currentKey: input.currentKey,
		liveKeys,
		now: io.now(),
		scratchMaxAgeMs: input.scratchMaxAgeMs,
	})) {
		try {
			await discardRuntimeDir(io, base, name);
			outcome.removed.push(name);
		} catch {
			// A rename failure means something still holds the directory.
			outcome.skipped.push(name);
		}
	}
	if (outcome.removed.length > 0 || outcome.skipped.length > 0) {
		io.log(
			"info",
			`(PTY-RUNTIME-SIDECAR) gc removed=[${outcome.removed.join(",")}] skipped=[${outcome.skipped.join(",")}]`,
		);
	}
	return outcome;
}
