// (PTY-RUNTIME-SIDECAR) — pure planning for the relocatable pty-daemon runtime.
//
// Fork-only. Windows cannot replace the file backing a running process image,
// so as long as the detached pty-daemon runs `Superset.exe` out of $INSTDIR
// (and maps `conpty.node` out of `resources\app.asar.unpacked`, and inherits a
// cwd inside $INSTDIR) the installer MUST kill it — taking every live shell
// with it. Relocating the daemon's whole runtime outside the install directory
// is what lets an install leave running terminals alone.
//
// Everything here is pure: no `fs`, no `child_process`, no `process` reads.
// The IO lives in `materialize.ts` behind an injected interface so the
// decisions that matter (what to copy, what is safe to delete) are testable on
// any platform.

import { createHash } from "node:crypto";
import * as path from "node:path";

/** Written LAST, inside the staging dir, before the atomic rename. */
export const READY_MARKER_NAME = ".ready";
/** Per-daemon-pid "this runtime is in use" records. */
export const REFS_DIR_NAME = ".refs";
/**
 * The daemon's copy of the Electron binary. Deliberately NOT the app's exe
 * name: electron-builder's one-click NSIS kills running processes by matching
 * `${APP_EXECUTABLE_FILENAME}`, so a differently-named image is not a target.
 */
export const SIDECAR_EXE_NAME = "superset-ptyd.exe";
/** Subdirectory holding the daemon's own JS, kept off the Electron file set. */
export const RUNTIME_APP_DIR = "app";
export const DAEMON_SCRIPT_NAME = "pty-daemon.js";
export const CHUNKS_DIR_NAME = "chunks";
export const NODE_MODULES_DIR_NAME = "node_modules";

const TEMP_INFIX = ".tmp-";
const GC_INFIX = ".gc-";

/**
 * How long an abandoned staging/GC directory must sit untouched before GC
 * reclaims it. A concurrent materialisation of the same key (two orgs, or two
 * host-services) is in flight for seconds, not an hour.
 */
export const SCRATCH_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * How long a freshly committed runtime is protected before GC will consider it.
 *
 * A runtime is committed by the rename, but its `.refs/<pid>.json` claim cannot
 * be written until the daemon it was built for HAS a pid. Between those two
 * points the directory is ready, claimed by nobody, and running nothing — which
 * is precisely the shape GC reclaims. A second host-service sweeping in that
 * window renames the runtime out from under the spawn that is about to use it.
 * It self-heals on the next spawn, but a grace period costs nothing and the
 * window it closes is otherwise unbounded by anything except luck.
 */
export const READY_RUNTIME_MIN_AGE_MS = 5 * 60 * 1000;

/** Directories at the install root that the daemon runtime needs. */
const RUNTIME_DIR_NAMES = new Set(["locales"]);

/**
 * Install-root files that are installer scaffolding rather than Electron
 * runtime. `resources/` is excluded structurally (only `RUNTIME_DIR_NAMES`
 * directories are ever copied), which is the whole point — it is 1.8 GB of
 * asar the daemon never reads.
 */
function isInstallerScaffolding(name: string): boolean {
	const lower = name.toLowerCase();
	return (
		lower.startsWith("uninstall") ||
		lower.endsWith(".log") ||
		lower.endsWith(".blockmap") ||
		lower.endsWith(".7z")
	);
}

export interface DirEntryInfo {
	name: string;
	isDirectory: boolean;
}

export interface RuntimeSourceSelection {
	/** Install-root files to copy, source names (the exe is renamed on write). */
	files: string[];
	/** Install-root directories to copy recursively. */
	dirs: string[];
}

/**
 * Choose the Electron runtime file set from a listing of the install root.
 *
 * Deliberately allow-by-default over the ROOT FILES rather than hardcoding a
 * DLL list: an Electron upgrade that adds `foo.dll` must not silently produce
 * a runtime that cannot start. Asserting a fixed name list is the
 * (SCREENREADER-GUARD-DRIFT) footgun in another costume. The only name this
 * function insists on is the exe the caller is already running from, and the
 * real correctness gate is the post-copy smoke test in `materialize.ts`, which
 * runs the copied binary for real.
 */
export function selectElectronRuntimeEntries(
	entries: readonly DirEntryInfo[],
	exeName: string,
): RuntimeSourceSelection {
	const files: string[] = [];
	const dirs: string[] = [];
	for (const entry of entries) {
		if (entry.isDirectory) {
			if (RUNTIME_DIR_NAMES.has(entry.name.toLowerCase()))
				dirs.push(entry.name);
			continue;
		}
		if (isInstallerScaffolding(entry.name)) continue;
		// Any other .exe at the root belongs to the installer, not the runtime.
		if (entry.name.toLowerCase().endsWith(".exe") && entry.name !== exeName) {
			continue;
		}
		files.push(entry.name);
	}
	if (!files.includes(exeName)) {
		throw new Error(
			`(PTY-RUNTIME-SIDECAR) install root has no ${exeName} to copy — refusing to build a runtime that cannot start`,
		);
	}
	return { files, dirs };
}

/** The node_modules the bundled daemon resolves at runtime. */
export function requiredDaemonPackages(
	platform: string,
	arch: string,
): string[] {
	// Mirrors @lydell/node-pty's own `requireBinary.js` formula rather than
	// hardcoding win32-arm64, so this stays correct if the fork ever builds
	// another arch.
	return [
		"node-pty",
		path.posix.join("@lydell", `node-pty-${platform}-${arch}`),
	];
}

export interface PtyRuntimeLayout {
	base: string;
	key: string;
	root: string;
	readyMarker: string;
	exePath: string;
	appDir: string;
	scriptPath: string;
	nodeModulesDir: string;
}

export function ptyRuntimeLayout(base: string, key: string): PtyRuntimeLayout {
	const root = path.join(base, key);
	const appDir = path.join(root, RUNTIME_APP_DIR);
	return {
		base,
		key,
		root,
		readyMarker: path.join(root, READY_MARKER_NAME),
		exePath: path.join(root, SIDECAR_EXE_NAME),
		appDir,
		scriptPath: path.join(appDir, DAEMON_SCRIPT_NAME),
		nodeModulesDir: path.join(root, NODE_MODULES_DIR_NAME),
	};
}

/**
 * Where every versioned runtime lives.
 *
 * `LOCALAPPDATA` rather than `~/.superset` on purpose: this is ~350 MB of
 * machine-local binaries, and `%APPDATA%`/home can be roaming- or
 * OneDrive-backed on a Windows profile. It is also outside `$INSTDIR`, which
 * is the entire point — the installer's uninstall pass wipes `$INSTDIR`.
 */
export function ptyRuntimeBaseDir(env: NodeJS.ProcessEnv): string {
	const override = env.SUPERSET_PTY_RUNTIME_DIR?.trim();
	if (override) return override;
	const localAppData = env.LOCALAPPDATA?.trim();
	if (!localAppData) {
		throw new Error(
			"(PTY-RUNTIME-SIDECAR) LOCALAPPDATA is not set — cannot place the daemon runtime outside the install directory",
		);
	}
	return path.join(localAppData, "Superset", "pty-runtime");
}

function sanitizeKeyPart(value: string, label: string): string {
	const trimmed = value.trim();
	if (!trimmed) {
		throw new Error(`(PTY-RUNTIME-SIDECAR) ${label} is empty`);
	}
	return trimmed.replace(/[^A-Za-z0-9._-]/g, "_");
}

/**
 * The runtime cache key.
 *
 * `daemonVersion` is `@superset/pty-daemon`'s package version — the SAME value
 * `EXPECTED_DAEMON_VERSION` uses to judge whether a running daemon is stale, so
 * keying on it introduces no new notion of "different daemon".
 *
 * `electronVersion` is included because the copied binary IS the Electron
 * runtime; an app update that bumps Electron must not keep serving the old one.
 *
 * The hash is over the daemon ENTRY SCRIPT ONLY, which transitively covers the
 * chunk set: the chunks are content-hash-named and referenced by name from the
 * entry, so any chunk change renames it and changes the entry's bytes. Hashing
 * 42 KB per boot instead of 10 MB is the point.
 *
 * KNOWN GAP, accepted: the key is blind to `node_modules` CONTENT. `node-pty`
 * is external to the daemon bundle, so a lockfile-only bump of
 * `@lydell/node-pty` (the dep pins `^1.0.1`; 1.1.0 already resolves) with an
 * unchanged daemon package version, unchanged Electron and byte-identical
 * entry reuses the old runtime's old native indefinitely. It is functional
 * today — same N-API ABI — but it is silent drift, and no gate would catch an
 * ABI break because nothing rebuilds and so nothing re-runs the smoke test.
 * Closing it means resolving `node_modules/node-pty`'s version BEFORE the key,
 * which moves the node_modules walk onto the reuse fast path and turns any
 * unreadable `package.json` into a lost install-survival guarantee — a worse
 * trade than the drift, so it is documented rather than fixed.
 */
export function ptyRuntimeKey(input: {
	daemonVersion: string;
	electronVersion: string;
	scriptBytes: Uint8Array;
}): string {
	if (input.scriptBytes.length === 0) {
		throw new Error(
			"(PTY-RUNTIME-SIDECAR) daemon script is empty — refusing to key a runtime on nothing",
		);
	}
	const daemonVersion = sanitizeKeyPart(input.daemonVersion, "daemonVersion");
	const electronVersion = sanitizeKeyPart(
		input.electronVersion,
		"electronVersion",
	);
	const digest = createHash("sha256")
		.update(input.scriptBytes)
		.digest("hex")
		.slice(0, 12);
	return `${daemonVersion}-e${electronVersion}-${digest}`;
}

/** Staging (`.tmp-`) and pending-delete (`.gc-`) directories, never runtimes. */
export function isScratchDirName(name: string): boolean {
	return name.includes(TEMP_INFIX) || name.includes(GC_INFIX);
}

export function scratchDirName(
	key: string,
	kind: "tmp" | "gc",
	nonce: string,
): string {
	return `${key}${kind === "tmp" ? TEMP_INFIX : GC_INFIX}${nonce}`;
}

export interface RuntimeDirEntry {
	name: string;
	mtimeMs: number;
}

/**
 * Which directories under the runtime base are safe to reclaim.
 *
 * Deleting a LIVE runtime is the severe failure mode here — a half-deleted
 * runtime under a running daemon breaks node-pty's console-list agent and its
 * conout worker, which are plain `.js` files Windows will happily unlink out
 * from under the process. So this refuses on any doubt:
 *
 *  - never the key in use right now,
 *  - never a key a live daemon pid has claimed,
 *  - never a runtime committed in the last `readyMinAgeMs`, whose owning
 *    daemon may not have a pid to claim it with yet,
 *  - scratch dirs only once they are older than `scratchMaxAgeMs`, because a
 *    concurrent materialisation of the same key is legitimately mid-copy.
 *
 * `materialize.ts` adds a second, independent gate: every removal renames the
 * directory first, and Windows refuses to rename a directory that is a live
 * process's cwd or that holds mapped images. Ref-file loss therefore degrades
 * to "we skip it and retry next boot", never to a corrupted live runtime.
 */
export function selectRuntimeDirsToRemove(input: {
	entries: readonly RuntimeDirEntry[];
	currentKey: string;
	liveKeys: ReadonlySet<string>;
	now: number;
	scratchMaxAgeMs?: number;
	readyMinAgeMs?: number;
}): string[] {
	const maxAge = input.scratchMaxAgeMs ?? SCRATCH_MAX_AGE_MS;
	const minAge = input.readyMinAgeMs ?? READY_RUNTIME_MIN_AGE_MS;
	const remove: string[] = [];
	for (const entry of input.entries) {
		if (entry.name === REFS_DIR_NAME) continue;
		if (isScratchDirName(entry.name)) {
			if (input.now - entry.mtimeMs > maxAge) remove.push(entry.name);
			continue;
		}
		if (entry.name === input.currentKey) continue;
		if (input.liveKeys.has(entry.name)) continue;
		if (input.now - entry.mtimeMs < minAge) continue;
		remove.push(entry.name);
	}
	return remove;
}

export interface RuntimeRef {
	pid: number;
	key: string;
	startedAt: number;
}

export function runtimeRefFileName(pid: number): string {
	return `${pid}.json`;
}

export function serializeRuntimeRef(ref: RuntimeRef): string {
	return JSON.stringify(ref);
}

/** Null on anything unparsable — a garbage ref must never protect or condemn. */
export function parseRuntimeRef(raw: string): RuntimeRef | null {
	try {
		const data: unknown = JSON.parse(raw);
		if (typeof data !== "object" || data === null) return null;
		const { pid, key, startedAt } = data as Record<string, unknown>;
		if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
			return null;
		}
		if (typeof key !== "string" || key.length === 0) return null;
		if (typeof startedAt !== "number") return null;
		return { pid, key, startedAt };
	} catch {
		return null;
	}
}
