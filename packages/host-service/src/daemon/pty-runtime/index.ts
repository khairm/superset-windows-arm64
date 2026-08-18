// (PTY-RUNTIME-SIDECAR) — the real IO behind `materialize.ts`, plus the entry
// point `DaemonSupervisor` calls before spawning the pty-daemon on Windows.

import * as childProcess from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { EXPECTED_DAEMON_VERSION } from "../expected-version.ts";
import { isProcessAlive } from "../manifest.ts";
import {
	gcPtyRuntimes,
	invalidateRuntime,
	materializePtyRuntime,
	type RuntimeIo,
	type SidecarResult,
	writeRuntimeRef,
} from "./materialize.ts";
import { type DirEntryInfo, ptyRuntimeBaseDir } from "./plan.ts";

export type { SidecarResult } from "./materialize.ts";

/** A runtime `ensurePtyRuntimeSidecar` actually built or found. */
export type ReadyPtyRuntime = Extract<SidecarResult, { ok: true }>;

/**
 * Exit code the smoke child reports on success. A specific value, not 0:
 * an Electron that refuses to run as node also exits 0 in some paths.
 */
const SMOKE_EXIT_CODE = 42;
/**
 * What the copied binary has to prove before we commit the runtime.
 *
 * `require("node-pty")` ALONE proves nothing about the native addon. @lydell's
 * `WindowsPtyAgent` loads `conpty.node` lazily, in its CONSTRUCTOR — module
 * load only pulls in JS — so a runtime whose prebuild is missing, quarantined
 * or built for the wrong arch imports perfectly cleanly and then fails at the
 * first terminal the user opens, possibly after the previous runtime has been
 * reclaimed. Measured on the shipped Electron against a copy of the packaged
 * `node_modules` with `conpty.node` deleted: `require("node-pty")` still
 * exits 42; the line below exits 1.
 *
 * The load goes through node-pty's OWN resolver rather than a path we build,
 * so the platform/arch formula stays @lydell's business and nothing here
 * hardcodes win32-arm64. The package ships no `exports` map, so the deep
 * require is reachable.
 */
const SMOKE_SCRIPT =
	'require("node-pty");' +
	'require("node-pty/requireBinary").requireBinary("conpty.node");' +
	`process.exit(${SMOKE_EXIT_CODE});`;
const SMOKE_TIMEOUT_MS = 60_000;
const SMOKE_OUTPUT_TAIL = 600;

/**
 * Existence check that also works INSIDE `app.asar`, which is where the daemon
 * script, its chunks and its node_modules actually live.
 *
 * `fs.access` is not usable here. Measured under the shipped Electron 41.10.3
 * with `ELECTRON_RUN_AS_NODE=1`, on `resources/app.asar`:
 *
 *   dir  node_modules/node-pty     access=ENOENT  stat=OK(dir=true)
 *   dir  dist/main/chunks          access=ENOENT  stat=OK(dir=true)
 *   file dist/main/pty-daemon.js   access=OK      stat=OK(dir=false)
 *   missing entries                access=ENOENT  stat=ENOENT
 *
 * Electron's asar shim answers `access` for archived FILES only, so an
 * `access`-based probe reports every in-archive DIRECTORY as absent — which
 * would make the node_modules lookup below fail on every packaged install
 * while passing every test that runs against a real filesystem.
 */
async function pathExists(target: string): Promise<boolean> {
	try {
		await fs.stat(target);
		return true;
	} catch {
		return false;
	}
}

/**
 * Copy a real-filesystem file. Falls back to read+write because the source can
 * turn out to be an asar-backed path whose `copyFile` is not shimmed, and a
 * hard failure there would cost the user install survival for no reason.
 */
async function copyFileWithFallback(from: string, to: string): Promise<void> {
	try {
		await fs.copyFile(from, to);
	} catch {
		await fs.writeFile(to, await fs.readFile(from));
	}
}

function smokeTest(
	exePath: string,
	cwd: string,
): Promise<{
	ok: boolean;
	reason?: string;
}> {
	return new Promise((resolve) => {
		let settled = false;
		let output = "";
		const finish = (ok: boolean, reason?: string) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			try {
				child.kill("SIGKILL");
			} catch {
				// already gone
			}
			resolve(ok ? { ok } : { ok, reason });
		};

		const child = childProcess.spawn(exePath, ["-e", SMOKE_SCRIPT], {
			cwd,
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
		});
		const timer = setTimeout(
			() => finish(false, `no exit within ${SMOKE_TIMEOUT_MS}ms`),
			SMOKE_TIMEOUT_MS,
		);
		for (const stream of [child.stdout, child.stderr]) {
			stream?.on("error", () => {});
			stream?.on("data", (chunk: Buffer) => {
				output = (output + chunk.toString("utf8")).slice(-SMOKE_OUTPUT_TAIL);
			});
		}
		child.once("error", (err) => finish(false, `spawn failed: ${err.message}`));
		child.once("exit", (code, signal) => {
			if (code === SMOKE_EXIT_CODE) {
				finish(true);
				return;
			}
			finish(
				false,
				`exit=${code ?? signal ?? "unknown"} output=${output.trim() || "(none)"}`,
			);
		});
	});
}

export const nodeRuntimeIo: RuntimeIo = {
	exists: pathExists,
	async readdir(dir: string): Promise<DirEntryInfo[]> {
		const entries = await fs.readdir(dir, { withFileTypes: true });
		return entries.map((entry) => ({
			name: entry.name,
			isDirectory: entry.isDirectory(),
		}));
	},
	async mtimeMs(target: string): Promise<number> {
		return (await fs.stat(target)).mtimeMs;
	},
	async readFile(target: string): Promise<Buffer> {
		return fs.readFile(target);
	},
	async writeFile(target: string, data: Buffer | string): Promise<void> {
		await fs.writeFile(target, data);
	},
	async mkdirp(dir: string): Promise<void> {
		await fs.mkdir(dir, { recursive: true });
	},
	copyRealFile: copyFileWithFallback,
	async rename(from: string, to: string): Promise<void> {
		await fs.rename(from, to);
	},
	async removeRecursive(target: string): Promise<void> {
		await fs.rm(target, { recursive: true, force: true });
	},
	smokeTest,
	isProcessAlive,
	now: () => Date.now(),
	nonce: () => randomBytes(6).toString("hex"),
	log(level, message) {
		if (level === "error") console.error(message);
		else if (level === "warn") console.warn(message);
		else console.log(message);
	},
};

/**
 * Only meaningful when we are running under an Electron binary on Windows:
 * `process.execPath` has to BE the runtime we are relocating. Under bun (dev)
 * or plain node there is nothing to copy and nothing to survive.
 */
export function isPtyRuntimeSidecarSupported(
	platform: string = process.platform,
	electronVersion: string | undefined = process.versions.electron,
): boolean {
	return platform === "win32" && Boolean(electronVersion);
}

const inFlight = new Map<string, Promise<SidecarResult>>();

/**
 * Ensure a relocated runtime exists for the daemon build at `daemonScriptPath`
 * and return where to spawn it from. Concurrent callers (one per org) share a
 * single copy. Never throws; a failure is reported so the supervisor can fall
 * back loudly to the install-directory spawn.
 */
export function ensurePtyRuntimeSidecar(
	daemonScriptPath: string,
	io: RuntimeIo = nodeRuntimeIo,
): Promise<SidecarResult> {
	const existing = inFlight.get(daemonScriptPath);
	if (existing) return existing;

	const promise = (async (): Promise<SidecarResult> => {
		let base: string;
		try {
			base = ptyRuntimeBaseDir(process.env);
		} catch (err) {
			return { ok: false, reason: (err as Error).message };
		}
		return materializePtyRuntime({
			io,
			base,
			installRoot: path.dirname(process.execPath),
			exeName: path.basename(process.execPath),
			daemonScriptPath,
			daemonVersion: EXPECTED_DAEMON_VERSION,
			electronVersion: process.versions.electron ?? process.versions.node,
			platform: process.platform,
			arch: process.arch,
		});
	})().finally(() => {
		inFlight.delete(daemonScriptPath);
	});
	inFlight.set(daemonScriptPath, promise);
	return promise;
}

/**
 * Discard a runtime that could not actually start a daemon, so the next spawn
 * rebuilds it from the install directory instead of retrying the same corpse.
 *
 * Awaited, not fire-and-forget: the caller is about to fall back, and the
 * whole point is that the NEXT `ensurePtyRuntimeSidecar` must not hand back
 * the runtime we just condemned.
 */
export async function invalidatePtyRuntimeSidecar(
	key: string,
	io: RuntimeIo = nodeRuntimeIo,
): Promise<void> {
	try {
		await invalidateRuntime(io, ptyRuntimeBaseDir(process.env), key);
		io.log(
			"warn",
			`(PTY-RUNTIME-SIDECAR) discarded runtime ${key}; the next spawn rebuilds it`,
		);
	} catch (err) {
		io.log(
			"warn",
			`(PTY-RUNTIME-SIDECAR) could not discard runtime ${key}: ${(err as Error).message}`,
		);
	}
}

/**
 * Claim `key` for a freshly spawned daemon pid so the GC sweep cannot reclaim
 * the runtime it is executing. Best-effort by design: the rename gate in
 * `discardRuntimeDir` is the guarantee, this is what stops GC from even trying.
 */
export function recordPtyRuntimeDaemon(
	key: string,
	pid: number,
	io: RuntimeIo = nodeRuntimeIo,
): void {
	void (async () => {
		try {
			await writeRuntimeRef(io, ptyRuntimeBaseDir(process.env), {
				pid,
				key,
				startedAt: io.now(),
			});
		} catch (err) {
			io.log(
				"warn",
				`(PTY-RUNTIME-SIDECAR) could not record runtime ref for pid ${pid}: ${(err as Error).message}`,
			);
		}
	})();
}

/** Reclaim runtimes no live daemon is using. Fire-and-forget after a spawn. */
export function schedulePtyRuntimeGc(
	currentKey: string,
	io: RuntimeIo = nodeRuntimeIo,
): void {
	void (async () => {
		try {
			await gcPtyRuntimes({
				io,
				base: ptyRuntimeBaseDir(process.env),
				currentKey,
			});
		} catch (err) {
			io.log(
				"warn",
				`(PTY-RUNTIME-SIDECAR) runtime gc failed: ${(err as Error).message}`,
			);
		}
	})();
}
