/**
 * Patches node:child_process on Windows so every spawn variant defaults to
 * windowsHide: true, preventing console-window flashes from background
 * commands and third-party libraries (pidusage, @sentry/electron, etc.).
 *
 * Callers that explicitly pass windowsHide: false are still respected.
 * Enabled on Windows only; no-op on macOS/Linux.
 *
 * (WIN-HIDE-FIRST-IMPORT) Applied by ./windows-child-process-patch-install,
 * the first import of every process entry. It must receive the real CommonJS
 * exports object: the bundler compiles `import * as cp` to a frozen namespace
 * copy, where assignments silently do nothing.
 */

import { promisify } from "node:util";

type ChildProcessModule = typeof import("node:child_process");
type Args = unknown[];
type Launcher = ((...args: Args) => unknown) & {
	[promisify.custom]?: (...args: Args) => unknown;
};

const PATCHED = Symbol.for("superset.windowsChildProcessPatch");

/** Method name only: commands and args can carry credentials (https://user:token@host). */
function traceSpawn(method: string): void {
	const flag = process.env.SUPERSET_TRACE_SPAWN;
	if (flag === "1" || (process.env.NODE_ENV === "development" && flag !== "0"))
		console.log(`[spawn-trace] ${method}`);
}

/**
 * null/undefined mean no options, or no windowsHide. Anything else, including
 * a non-boolean windowsHide, passes through untouched, so Node handles it
 * exactly as it would unpatched.
 */
function withHide(options: unknown): unknown {
	if (options == null) return { windowsHide: true };
	if (typeof options !== "object" || Array.isArray(options)) return options;
	const { windowsHide } = options as { windowsHide?: unknown };
	if (windowsHide != null) return options;
	return { ...options, windowsHide: true };
}

/** Slots skipped past the end become holes, which apply() passes as undefined. */
function setAt(args: Args, index: number, value: unknown): Args {
	const copy = [...args];
	copy[index] = value;
	return copy;
}

/** A callback sitting in the options slot: Node shifts it, so we insert. */
function insertHideAt(args: Args, index: number): Args {
	return [...args.slice(0, index), { windowsHide: true }, ...args.slice(index)];
}

// The normalizers mirror Node's own overload resolution for each family.

/** spawn/spawnSync(file, args?, options?) */
function spawnArgs(args: Args): Args {
	const second = args[1];
	if (Array.isArray(second) || second == null) {
		// Node rejects null spawn options, unlike exec/execFile, so keep the null.
		if (args[2] === null) return args;
		return setAt(args, 2, withHide(args[2]));
	}
	if (typeof second === "object") return setAt(args, 1, withHide(second));
	return args;
}

/** exec/execFile options slot, which may instead hold the callback. */
function optionsAt(args: Args, index: number): Args {
	if (typeof args[index] === "function") return insertHideAt(args, index);
	return setAt(args, index, withHide(args[index]));
}

/** exec(command, options?, callback?) and its sync twin. */
function execArgs(args: Args): Args {
	return optionsAt(args, 1);
}

/** execFile(file, args?, options?, callback?) and its sync twin. */
function execFileArgs(args: Args): Args {
	const second = args[1];
	if (Array.isArray(second) || second == null) return optionsAt(args, 2);
	if (typeof second === "function" || typeof second === "object")
		return optionsAt(args, 1);
	return args;
}

const NORMALIZERS: Record<string, (args: Args) => Args> = {
	spawn: spawnArgs,
	spawnSync: spawnArgs,
	exec: execArgs,
	execSync: execArgs,
	execFile: execFileArgs,
	execFileSync: execFileArgs,
};

export function applyWindowsChildProcessPatch(
	target: ChildProcessModule,
	platform: NodeJS.Platform,
): void {
	if (platform !== "win32") return;
	const methods = target as unknown as Record<string | symbol, Launcher>;
	if (methods[PATCHED]) return;

	for (const [name, normalize] of Object.entries(NORMALIZERS)) {
		const original = methods[name];
		if (typeof original !== "function") {
			throw new Error(
				`windows-child-process-patch: child_process.${name} is not a function`,
			);
		}
		const wrap = (fn: (...args: Args) => unknown) =>
			function (this: unknown, ...args: Args) {
				traceSpawn(name);
				return fn.apply(this, normalize(args));
			};
		const patched: Launcher = wrap(original);
		// exec/execFile's promisify hook closes over the unpatched function,
		// so copying it would skip the hide. Wrap it with the same
		// normalization; Node still builds {stdout, stderr} and promise.child.
		const nativePromisified = original[promisify.custom];
		if (nativePromisified) {
			Object.defineProperty(patched, promisify.custom, {
				value: wrap(nativePromisified),
			});
		}
		methods[name] = patched;
		if (methods[name] !== patched) {
			throw new Error(
				`windows-child-process-patch: child_process.${name} did not accept the patch`,
			);
		}
	}
	Object.defineProperty(target, PATCHED, { value: true });
}
