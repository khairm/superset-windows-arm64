import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { FsWatcherManager } from "../watch";
import { nativeIgnoreForWindows } from "./native-ignore-split";
import type { NativeWatchBackend } from "./types";

const CHILD_KILL_MS = 30_000;
const TEST_TIMEOUT_MS = 60_000;
const nativeFixture = path.join(
	import.meta.dir,
	"long-path-native.fixture.cjs",
);
const managerFixture = path.join(
	import.meta.dir,
	"long-path-manager.fixture.ts",
);

interface ChildResult {
	lines: string[];
	stderr: string;
	code: number | null;
	killed: boolean;
}

type Verdict =
	| "setup failure"
	| "fixture error"
	| "survived"
	| "timeout"
	| "crash"
	| "hang";

function verdictOf(result: ChildResult): Verdict {
	if (result.killed) return "hang";
	if (result.lines.includes("fixture-error")) return "fixture error";
	if (!result.lines.includes("ready")) return "setup failure";
	if (result.lines.includes("survived") && result.code === 0) return "survived";
	if (result.lines.includes("timeout")) return "timeout";
	return "crash";
}

function describeResult(result: ChildResult): string {
	const code =
		result.code === null ? "none" : `0x${(result.code >>> 0).toString(16)}`;
	return `exit ${code}, killed ${result.killed}\nstdout:\n${result.lines.join("\n")}\nstderr:\n${result.stderr}`;
}

function expectVerdict(result: ChildResult, expected: Verdict): void {
	const verdict = verdictOf(result);
	if (verdict !== expected) {
		throw new Error(
			`child ${verdict}, expected ${expected}: ${describeResult(result)}`,
		);
	}
}

function runChild(
	command: string,
	args: string[],
	env: NodeJS.ProcessEnv,
): Promise<ChildResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			env,
			shell: false,
			windowsHide: true,
		});
		let stdout = "";
		let stderr = "";
		let killed = false;
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		const timer = setTimeout(() => {
			killed = true;
			child.kill();
		}, CHILD_KILL_MS);
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({
				lines: stdout.split(/\r?\n/).filter((line) => line !== ""),
				stderr,
				code,
				killed,
			});
		});
	});
}

async function withRoot<T>(run: (root: string) => Promise<T>): Promise<T> {
	const root = await realpath(await mkdtemp(path.join(tmpdir(), "lp-")));
	try {
		return await run(root);
	} finally {
		await rm(path.toNamespacedPath(root), { recursive: true, force: true });
	}
}

function shippedElectron(): string {
	const desktopDir = path.resolve(import.meta.dir, "../../../../apps/desktop");
	const require = createRequire(import.meta.url);
	const executable = require(
		require.resolve("electron", { paths: [desktopDir] }),
	) as string;
	if (!existsSync(executable)) {
		throw new Error(`shipped Electron runtime missing: ${executable}`);
	}
	return executable;
}

/** The static ignore list host-service's FsWatcherManager hands its backend. */
async function hostIgnoreList(): Promise<string[]> {
	return withRoot(async (root) => {
		let ignore: string[] | undefined;
		const backend: NativeWatchBackend = {
			name: "capture",
			async subscribe(request) {
				ignore = request.ignore;
				return { unsubscribe: async () => {} };
			},
		};
		const manager = new FsWatcherManager({
			backend,
			useDefaultIgnores: false,
		});
		await manager.subscribe({ absolutePath: root }, () => {});
		await manager.close();
		if (!ignore) throw new Error("backend never subscribed");
		return ignore;
	});
}

function runNativeLeg(ignore: string[]): Promise<ChildResult> {
	const electron = shippedElectron();
	return withRoot((root) =>
		runChild(electron, [nativeFixture, root, JSON.stringify(ignore)], {
			...process.env,
			ELECTRON_RUN_AS_NODE: "1",
		}),
	);
}

describe.skipIf(process.platform !== "win32")(
	"long watch paths on Windows",
	() => {
		test(
			"native leg: plain-only ignores survive a 320-char path",
			async () => {
				const { nativeDirs } = nativeIgnoreForWindows(
					await hostIgnoreList(),
					2,
					tmpdir(),
				);
				expectVerdict(await runNativeLeg(nativeDirs), "survived");
			},
			TEST_TIMEOUT_MS,
		);

		test(
			"manager leg: pruned dirs stay quiet and a 320-char path survives",
			async () => {
				await withRoot(async (root) => {
					const result = await runChild(
						process.execPath,
						[managerFixture, root],
						process.env,
					);
					expectVerdict(result, "survived");
					const eventsLine = result.lines.find((line) =>
						line.startsWith("events "),
					);
					if (!eventsLine) throw new Error(describeResult(result));
					const events = JSON.parse(
						eventsLine.slice("events ".length),
					) as Array<{
						absolutePath: string;
					}>;
					const under = (...segments: string[]) => {
						const dir = path.join(root, ...segments);
						return events.filter(
							(event) =>
								event.absolutePath === dir ||
								event.absolutePath.startsWith(`${dir}${path.sep}`),
						);
					};
					expect(under("node_modules")).toEqual([]);
					expect(under(".claude", "worktrees")).toEqual([]);
					expect(under("a", "b")).toEqual([]);
					expect(under("x", ".worktrees")).toEqual([]);
					expect(under("normal").length).toBeGreaterThan(0);
				});
			},
			TEST_TIMEOUT_MS,
		);

		test(
			"positive control: the old glob list still crashes native",
			async () => {
				const oldList = [
					...(await hostIgnoreList()),
					"**/.superset-watch-generation-2/**",
				];
				const result = await runNativeLeg(oldList);
				console.log(`positive control: ${describeResult(result)}`);
				if (verdictOf(result) === "survived") {
					throw new Error("control no longer crashes: re-evaluate workaround");
				}
				expectVerdict(result, "crash");
				// Bun keeps only the low byte of the 0xC0000409 fail-fast status.
				expect(result.code).toBe(0x09);
			},
			TEST_TIMEOUT_MS,
		);
	},
);
