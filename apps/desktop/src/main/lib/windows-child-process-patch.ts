/**
 * Monkey-patches node:child_process on Windows so every spawn variant
 * defaults to windowsHide: true, preventing console-window flashes from
 * third-party libraries (pidusage, @sentry/electron, etc.).
 *
 * Callers that explicitly pass windowsHide: false are still respected.
 * Enabled on Windows only; no-op on macOS/Linux.
 */

import * as cp from "node:child_process";

const TRACE = process.env.SUPERSET_TRACE_SPAWN === "1" ||
	(process.env.NODE_ENV === "development" && process.env.SUPERSET_TRACE_SPAWN !== "0");

function traceSpawn(cmd: string, args?: string[]): void {
	if (!TRACE) return;
	const display = args?.length ? `${cmd} ${args.slice(0, 3).join(" ")}` : cmd;
	console.log(`[spawn-trace] ${display}`);
}

export function installWindowsChildProcessPatch(): void {
	if (process.platform !== "win32") return;

	const origSpawn = cp.spawn.bind(cp);
	// @ts-ignore - monkey-patch
	cp.spawn = function patchedSpawn(command: string, args?: any, options?: any) {
		if (Array.isArray(args)) {
			traceSpawn(command, args);
			options = { windowsHide: true, ...(options ?? {}) };
		} else {
			traceSpawn(command);
			options = { windowsHide: true, ...(args ?? {}) };
			args = options;
		}
		if (typeof options === "object" && options !== null && options.windowsHide === false) {
			// Caller explicitly opted out
		} else if (typeof options === "object" && options !== null) {
			options.windowsHide = true;
		}
		return Array.isArray(args) ? origSpawn(command, args, options) : origSpawn(command, options);
	};

	const origExec = cp.exec.bind(cp);
	// @ts-ignore
	cp.exec = function patchedExec(command: string, optionsOrCallback?: any, callback?: any) {
		traceSpawn(command);
		if (typeof optionsOrCallback === "function") {
			return origExec(command, { windowsHide: true }, optionsOrCallback);
		}
		const opts = { windowsHide: true, ...(optionsOrCallback ?? {}) };
		return origExec(command, opts, callback);
	};

	const origExecFile = cp.execFile.bind(cp);
	// @ts-ignore
	cp.execFile = function patchedExecFile(file: string, args?: any, options?: any, callback?: any) {
		traceSpawn(file, Array.isArray(args) ? args : undefined);
		if (Array.isArray(args)) {
			if (typeof options === "function") {
				return origExecFile(file, args, { windowsHide: true }, options);
			}
			const opts = { windowsHide: true, ...(options ?? {}) };
			return origExecFile(file, args, opts, callback);
		}
		if (typeof args === "function") {
			return origExecFile(file, [], { windowsHide: true }, args);
		}
		const opts = { windowsHide: true, ...(args ?? {}) };
		return origExecFile(file, [], opts, options);
	};

	const origSpawnSync = cp.spawnSync.bind(cp);
	// @ts-ignore
	cp.spawnSync = function patchedSpawnSync(command: string, args?: any, options?: any) {
		if (Array.isArray(args)) {
			traceSpawn(command, args);
			options = { windowsHide: true, ...(options ?? {}) };
		} else {
			traceSpawn(command);
			options = { windowsHide: true, ...(args ?? {}) };
			args = undefined;
		}
		return Array.isArray(args) ? origSpawnSync(command, args, options) : origSpawnSync(command, options);
	};

	const origExecSync = cp.execSync.bind(cp);
	// @ts-ignore
	cp.execSync = function patchedExecSync(command: string, options?: any) {
		traceSpawn(command);
		return origExecSync(command, { windowsHide: true, ...(options ?? {}) });
	};

	const origExecFileSync = cp.execFileSync.bind(cp);
	// @ts-ignore
	cp.execFileSync = function patchedExecFileSync(file: string, args?: any, options?: any) {
		traceSpawn(file, Array.isArray(args) ? args : undefined);
		if (Array.isArray(args)) {
			return origExecFileSync(file, args, { windowsHide: true, ...(options ?? {}) });
		}
		return origExecFileSync(file, { windowsHide: true, ...(args ?? {}) });
	};
}
