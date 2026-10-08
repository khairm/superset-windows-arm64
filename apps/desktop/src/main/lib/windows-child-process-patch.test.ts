import { describe, expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { applyWindowsChildProcessPatch } from "./windows-child-process-patch";

type ChildProcessModule = typeof import("node:child_process");
type Call = { method: string; args: unknown[] };
type Methods = Record<string, (...args: unknown[]) => unknown>;

const HIDE = { windowsHide: true };
const METHODS = [
	"spawn",
	"spawnSync",
	"exec",
	"execSync",
	"execFile",
	"execFileSync",
];

/**
 * Records every call. Like Node, exec/execFile carry a promisify hook that
 * closes over the unpatched function.
 */
function fakeChildProcess() {
	const calls: Call[] = [];
	const methods: Methods = {};
	for (const method of METHODS) {
		methods[method] = (...args) => {
			calls.push({ method, args });
			return method;
		};
	}
	for (const method of ["exec", "execFile"]) {
		Object.defineProperty(methods[method], promisify.custom, {
			value: (...args: unknown[]) => {
				calls.push({ method: `${method}[promisify.custom]`, args });
				return Promise.resolve({ stdout: "native", stderr: "" });
			},
		});
	}
	return { cp: methods as unknown as ChildProcessModule, methods, calls };
}

/** Rollup's `import * as cp` output: a frozen copy with live getters. */
function rollupNamespace(mod: object): ChildProcessModule {
	const ns = Object.create(null);
	for (const key in mod) {
		Object.defineProperty(ns, key, {
			enumerable: true,
			get: () => (mod as Record<string, unknown>)[key],
		});
	}
	return Object.freeze(ns);
}

describe("applyWindowsChildProcessPatch", () => {
	const cb = () => {};
	const opts = { cwd: "C:/repo" };
	const hidden = { ...opts, ...HIDE };

	const cases: [string, unknown[], unknown[]][] = [
		["spawn", ["git"], ["git", undefined, HIDE]],
		["spawn", ["git", ["status"], opts], ["git", ["status"], hidden]],
		["spawn", ["git", opts], ["git", hidden]],
		["spawn", ["git", undefined, opts], ["git", undefined, hidden]],
		["spawn", ["git", null, opts], ["git", null, hidden]],
		// Node rejects null spawn options; it must still see the null.
		["spawn", ["git", [], null], ["git", [], null]],
		["spawnSync", ["git", undefined, opts], ["git", undefined, hidden]],
		["exec", ["dir"], ["dir", HIDE]],
		["exec", ["dir", cb], ["dir", HIDE, cb]],
		["exec", ["dir", opts, cb], ["dir", hidden, cb]],
		["exec", ["dir", null, cb], ["dir", HIDE, cb]],
		["execSync", ["dir", opts], ["dir", hidden]],
		["execFile", ["git"], ["git", undefined, HIDE]],
		["execFile", ["git", cb], ["git", HIDE, cb]],
		["execFile", ["git", ["status"], cb], ["git", ["status"], HIDE, cb]],
		[
			"execFile",
			["git", ["status"], opts, cb],
			["git", ["status"], hidden, cb],
		],
		["execFile", ["git", opts, cb], ["git", hidden, cb]],
		["execFile", ["git", undefined, opts, cb], ["git", undefined, hidden, cb]],
		["execFile", ["git", null, null, cb], ["git", null, HIDE, cb]],
		["execFileSync", ["git", ["status"], opts], ["git", ["status"], hidden]],
		["execFileSync", ["git", opts], ["git", hidden]],
	];

	test.each(cases)("%s(%j) defaults windowsHide", (method, args, expected) => {
		const { cp, methods, calls } = fakeChildProcess();
		applyWindowsChildProcessPatch(cp, "win32");
		expect(methods[method](...args)).toBe(method);
		expect(calls).toEqual([{ method, args: expected }]);
	});

	test("explicit windowsHide: false is kept; undefined does not cancel", () => {
		const { cp, calls } = fakeChildProcess();
		applyWindowsChildProcessPatch(cp, "win32");
		const visible = { windowsHide: false };
		cp.spawn("cmd.exe", [], visible);
		cp.exec("dir", { windowsHide: undefined, ...opts });
		expect(calls[0].args[2]).toBe(visible);
		expect(calls[1].args[1]).toEqual(hidden);
	});

	test("a non-boolean windowsHide reaches Node unchanged", () => {
		// An isolated copy; these validate before starting any process.
		const native = { ...childProcess } as ChildProcessModule;
		applyWindowsChildProcessPatch(native, "win32");
		// Node's async exec/execFile coerce it instead, so check forwarding.
		const { cp, calls } = fakeChildProcess();
		applyWindowsChildProcessPatch(cp, "win32");
		const node = process.execPath;
		const args = ["-e", ""];
		for (const windowsHide of ["yes", 0, 1] as unknown as boolean[]) {
			const bad = { windowsHide };
			for (const run of [
				() => native.spawn(node, args, bad),
				() => native.spawnSync(node, args, bad),
				() => native.execSync(`"${node}" -e ""`, bad),
				() => native.execFileSync(node, args, bad),
			]) {
				expect(run).toThrow(
					'"options.windowsHide" property must be of type boolean',
				);
			}
			cp.exec("dir", bad, cb);
			cp.execFile("git", args, bad, cb);
			expect(calls.splice(0).map((call) => call.args)).toEqual([
				["dir", bad, cb],
				["git", args, bad, cb],
			]);
		}
	});

	test("never mutates the caller's options", () => {
		const { cp } = fakeChildProcess();
		applyWindowsChildProcessPatch(cp, "win32");
		const callerOpts = { cwd: "C:/repo" };
		cp.execFile("git", ["status"], callerOpts, cb);
		expect(callerOpts).toEqual({ cwd: "C:/repo" });
	});

	test("trace logs the method name only, never a credential-bearing command", async () => {
		const { cp } = fakeChildProcess();
		applyWindowsChildProcessPatch(cp, "win32");
		const url = "https://user:TOKEN@host/repo.git";
		const previous = process.env.SUPERSET_TRACE_SPAWN;
		const log = spyOn(console, "log").mockImplementation(() => {});
		process.env.SUPERSET_TRACE_SPAWN = "1";
		try {
			cp.exec(`git clone ${url}`, cb);
			await promisify(cp.execFile)("git", ["clone", url]);
			expect(log.mock.calls).toEqual([
				["[spawn-trace] exec"],
				["[spawn-trace] execFile"],
			]);
		} finally {
			if (previous === undefined) delete process.env.SUPERSET_TRACE_SPAWN;
			else process.env.SUPERSET_TRACE_SPAWN = previous;
			log.mockRestore();
		}
	});

	test("does nothing off Windows", () => {
		const { cp, methods } = fakeChildProcess();
		const originals = { ...methods };
		applyWindowsChildProcessPatch(cp, "linux");
		for (const method of METHODS) {
			expect(methods[method]).toBe(originals[method]);
		}
	});

	test("is idempotent per module", () => {
		const { cp, calls } = fakeChildProcess();
		applyWindowsChildProcessPatch(cp, "win32");
		const once = cp.spawn;
		applyWindowsChildProcessPatch(cp, "win32");
		expect(cp.spawn).toBe(once);
		cp.spawn("git");
		expect(calls).toHaveLength(1);
	});

	test("a bundler namespace copy sees the patch through its live getters", () => {
		const { cp, calls } = fakeChildProcess();
		const ns = rollupNamespace(cp);
		applyWindowsChildProcessPatch(cp, "win32");
		expect(ns.execFile).toBe(cp.execFile);
		ns.execFile("git", ["status"], cb);
		expect(calls).toEqual([
			{ method: "execFile", args: ["git", ["status"], HIDE, cb] },
		]);
	});

	test("patching a frozen namespace fails loudly", () => {
		const { cp } = fakeChildProcess();
		expect(() =>
			applyWindowsChildProcessPatch(rollupNamespace(cp), "win32"),
		).toThrow();
	});

	test("promisify(exec/execFile) runs the native hook with windowsHide", async () => {
		const { cp, calls } = fakeChildProcess();
		applyWindowsChildProcessPatch(cp, "win32");
		const result = await promisify(cp.execFile)("git", ["status"], opts);
		await promisify(cp.exec)("dir");
		expect(result).toEqual({ stdout: "native", stderr: "" });
		expect(calls).toEqual([
			{
				method: "execFile[promisify.custom]",
				args: ["git", ["status"], hidden],
			},
			{ method: "exec[promisify.custom]", args: ["dir", HIDE] },
		]);
	});

	test("promisified execFile keeps Node's result shape and promise.child", async () => {
		// An isolated copy: the process-wide child_process stays untouched.
		const cp = { ...childProcess } as ChildProcessModule;
		applyWindowsChildProcessPatch(cp, "win32");
		const run = promisify(cp.execFile);

		const ok = run(process.execPath, ["-e", "process.stdout.write('out')"]);
		expect(ok.child.pid).toBeGreaterThan(0);
		expect(await ok).toEqual({ stdout: "out", stderr: "" });

		const failed = run(process.execPath, [
			"-e",
			"process.stderr.write('err'); process.exitCode = 3",
		]);
		expect(failed.child.pid).toBeGreaterThan(0);
		const error = await failed.then(
			() => null,
			(err: unknown) => err,
		);
		expect(error).toMatchObject({ code: 3, stdout: "", stderr: "err" });
	});
});

describe("windows-child-process-patch-install", () => {
	test("each process entry imports the installer first", () => {
		const mainDir = resolve(import.meta.dirname, "..");
		for (const entry of [
			"index.ts",
			"host-service/index.ts",
			"host-worker/index.ts",
			"git-task-worker.ts",
		]) {
			const firstImport = readFileSync(join(mainDir, entry), "utf8")
				.split(/\r?\n/)
				.find((line) => line.startsWith("import "));
			expect(firstImport, entry).toMatch(
				/^import "(\.|main)\/lib\/windows-child-process-patch-install";$/,
			);
		}
	});

	test("a first import patches before a bundled sibling captures promisify(execFile)", async () => {
		const { build } = await import("vite");
		const dir = mkdtempSync(join(tmpdir(), "win-hide-bundle-"));
		try {
			const installer = join(
				import.meta.dirname,
				"windows-child-process-patch-install.ts",
			).replaceAll("\\", "/");
			writeFileSync(
				join(dir, "consumer.ts"),
				'import { execFile } from "node:child_process";\nimport { promisify } from "node:util";\nexport const execFileAsync = promisify(execFile);\n',
			);
			// Two entries share the installer and the consumer, so both land in
			// a split chunk, as in the real multi-entry main build.
			for (const entry of ["a", "b"]) {
				writeFileSync(
					join(dir, `${entry}.ts`),
					`import ${JSON.stringify(installer)};\nexport { execFileAsync } from "./consumer";\n`,
				);
			}
			// electron-vite's main preset: SSR build, CommonJS, builtins external.
			await build({
				configFile: false,
				logLevel: "silent",
				root: dir,
				ssr: { noExternal: true },
				build: {
					ssr: true,
					minify: false,
					outDir: join(dir, "out"),
					rollupOptions: {
						input: { a: join(dir, "a.ts"), b: join(dir, "b.ts") },
						external: [/^node:/],
						output: { format: "cjs", entryFileNames: "[name].js" },
					},
				},
			});

			const { cp, calls } = fakeChildProcess();
			const { execFileAsync } = loadBundle(join(dir, "out", "a.js"), {
				childProcess: cp,
				process: Object.create(process, { platform: { value: "win32" } }),
			}) as { execFileAsync: (...args: unknown[]) => Promise<unknown> };

			await execFileAsync("git", ["status"]);
			expect(calls).toEqual([
				{
					method: "execFile[promisify.custom]",
					args: ["git", ["status"], HIDE],
				},
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

/**
 * Evaluates a CommonJS bundle with its own require, so the fake
 * child_process and the win32 `process` never touch this test process.
 */
function loadBundle(
	file: string,
	sandbox: { childProcess: unknown; process: NodeJS.Process },
): Record<string, unknown> {
	const realRequire = createRequire(import.meta.url);
	const loaded = new Map<string, Record<string, unknown>>();
	const load = (path: string): Record<string, unknown> => {
		const cached = loaded.get(path);
		if (cached) return cached;
		const mod = { exports: {} as Record<string, unknown> };
		loaded.set(path, mod.exports);
		const sandboxRequire = (id: string): unknown => {
			if (id === "node:child_process") return sandbox.childProcess;
			if (id === "node:module") return { createRequire: () => sandboxRequire };
			if (id.startsWith(".")) return load(resolve(dirname(path), id));
			return realRequire(id);
		};
		new Function(
			"require",
			"module",
			"exports",
			"__filename",
			"__dirname",
			"process",
			"document",
			readFileSync(path, "utf8"),
		)(
			sandboxRequire,
			mod,
			mod.exports,
			path,
			dirname(path),
			sandbox.process,
			undefined,
		);
		return mod.exports;
	};
	return load(file);
}
