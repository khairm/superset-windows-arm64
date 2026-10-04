import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	escapeGlobMagic,
	FsWatcherManager,
	type FsWatcherManagerOptions,
} from "../watch";
import { createIgnoreMatcher } from "./ignore-matcher";
import {
	assertNativeIgnoreSafe,
	NativeIgnoreTripwireError,
	nativeIgnoreForWindows,
	splitIgnoreForNative,
} from "./native-ignore-split";
import type { NativeWatchBackend } from "./types";

interface NativeOptions {
	ignoreGlobs?: string[];
	ignorePaths?: string[];
}

const { createWrapper } = createRequire(import.meta.url)(
	"@parcel/watcher/wrapper.js",
) as {
	createWrapper(binding: {
		subscribe(dir: string, fn: unknown, opts: NativeOptions): Promise<void>;
	}): {
		subscribe(
			dir: string,
			fn: () => void,
			opts: { ignore: string[] },
		): Promise<unknown>;
	};
};

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function makeRoot(): Promise<string> {
	const root = await realpath(await mkdtemp(path.join(tmpdir(), "nis-")));
	cleanups.push(() => rm(root, { recursive: true, force: true }));
	return root;
}

/** What parcel's own wrapper hands the native binding for `ignore`. */
async function nativeOptionsFor(
	root: string,
	ignore: string[],
): Promise<NativeOptions> {
	let captured: NativeOptions | undefined;
	const wrapper = createWrapper({
		subscribe: async (_dir, _fn, opts) => {
			captured = opts;
		},
	});
	await wrapper.subscribe(root, () => {}, { ignore });
	if (!captured) throw new Error("fake binding never saw subscribe");
	return captured;
}

/** The static ignore list a real FsWatcherManager hands its backend. */
async function managerIgnore(
	options: FsWatcherManagerOptions,
): Promise<string[]> {
	const root = await makeRoot();
	let ignore: string[] | undefined;
	const backend: NativeWatchBackend = {
		name: "capture",
		async subscribe(request) {
			ignore = request.ignore;
			return { unsubscribe: async () => {} };
		},
	};
	const manager = new FsWatcherManager({ ...options, backend });
	await manager.subscribe({ absolutePath: root }, () => {});
	await manager.close();
	if (!ignore) throw new Error("backend never subscribed");
	return ignore;
}

const asDirIgnore = (dir: string) => `${escapeGlobMagic(dir)}/**`;

describe("nativeIgnoreForWindows", () => {
	test("hands parcel no glob for the host and Electron main lists", async () => {
		const dynamic = [
			"packages\\sub-repo",
			"a/dist",
			"packages/x/.worktrees",
			"app/[id]",
			"foo (copy)",
			"a^b",
			"a$b",
		].map(asDirIgnore);
		const root = await makeRoot();
		for (const base of [
			await managerIgnore({ useDefaultIgnores: false }),
			await managerIgnore({}),
		]) {
			const { nativeDirs } = nativeIgnoreForWindows(
				[...base, ...dynamic],
				2,
				root,
			);
			const options = await nativeOptionsFor(root, nativeDirs);
			expect(options.ignoreGlobs).toBeUndefined();
			expect(options.ignorePaths?.length).toBe(nativeDirs.length);
		}
	});

	test("splits each entry by rule", () => {
		const cases: Array<[string, string[], string[]]> = [
			["**/.git/**", [".git"], ["**/.git/**"]],
			[
				"**/.claude/worktrees/**",
				[".claude/worktrees"],
				["**/.claude/worktrees/**"],
			],
			["**/*.tsbuildinfo", [], ["**/*.tsbuildinfo"]],
			["**/$x/**", [], ["**/$x/**"]],
			[asDirIgnore("packages\\sub-repo"), ["packages/sub-repo"], []],
			[asDirIgnore("a/dist"), ["a/dist"], []],
			[asDirIgnore("app\\[id]\\nested"), [], ["app/\\[id\\]/nested/**"]],
			["app/\\[id\\]/**", [], ["app/\\[id\\]/**"]],
			["a\\\\*/**", [], ["a\\\\*/**"]],
			["vendor/cache", [], ["vendor/cache"]],
		];
		for (const [entry, nativeDirs, jsGlobs] of cases) {
			expect({ entry, ...splitIgnoreForNative([entry]) }).toEqual({
				entry,
				nativeDirs,
				jsGlobs,
			});
		}
	});

	test("round-trips escapeGlobMagic output", () => {
		for (const dir of ["a^b$c", "x\\y^z", "foo bar", "dots.in.name"]) {
			expect(splitIgnoreForNative([asDirIgnore(dir)])).toEqual({
				nativeDirs: [dir.replaceAll("\\", "/")],
				jsGlobs: [],
			});
		}
		for (const dir of ["app/[id]", "foo (copy)", "a+b", "a@b", "a!b", "a{b}"]) {
			expect(splitIgnoreForNative([asDirIgnore(dir)])).toEqual({
				nativeDirs: [],
				jsGlobs: [asDirIgnore(dir)],
			});
		}
	});

	test("adds the generation marker as a plain dir only", () => {
		expect(nativeIgnoreForWindows(["**/.git/**"], 1, "C:\\repo")).toEqual({
			nativeDirs: [".git"],
			jsGlobs: ["**/.git/**"],
		});
		expect(nativeIgnoreForWindows(["**/.git/**"], 3, "C:\\repo")).toEqual({
			nativeDirs: [".git", ".superset-watch-generation-3"],
			jsGlobs: ["**/.git/**"],
		});
	});

	test("filters plain dirs in JS too under a root ending in a separator", () => {
		for (const root of ["D:\\", "\\\\server\\share"]) {
			expect(nativeIgnoreForWindows([asDirIgnore("a/dist")], 2, root)).toEqual({
				nativeDirs: ["a/dist", ".superset-watch-generation-2"],
				jsGlobs: ["a/dist/**", ".superset-watch-generation-2/**"],
			});
		}
	});

	test("the tripwire rejects anything native could misread", () => {
		for (const dir of [
			"",
			".",
			"./.",
			"./",
			"..",
			"a/../b",
			"C:",
			"C:foo",
			"C:/x",
			"/x",
			"a\\b",
			"a*",
		]) {
			expect(() => assertNativeIgnoreSafe([dir])).toThrow(
				NativeIgnoreTripwireError,
			);
		}
		expect(() =>
			assertNativeIgnoreSafe([".git", "a/dist", ".claude/worktrees", "a^b"]),
		).not.toThrow();
		for (const entry of ["../x/**", "././**"]) {
			expect(() => nativeIgnoreForWindows([entry], 1, "C:\\repo")).toThrow(
				NativeIgnoreTripwireError,
			);
		}
	});

	test.skipIf(process.platform !== "win32")(
		"matches parcel's old native regex on every parity row",
		async () => {
			const root = await makeRoot();
			const prunedDirIgnores = [
				"packages\\sub-repo",
				"sub",
				"a/dist",
				"web/[slug]",
				"app\\[id]\\vendored",
			].map(asDirIgnore);
			const nameHitIgnores = ["packages/x/.worktrees"].map(asDirIgnore);
			const rows = [
				".claude\\worktrees",
				".claude\\worktrees\\agent-1\\src\\a.ts",
				".Claude\\Worktrees\\x",
				".git",
				".git\\HEAD",
				".gitignore",
				".git2\\x",
				"packages\\sub-repo",
				"packages\\sub-repo\\x.ts",
				"packages\\sub-repo-2\\x.ts",
				"sub\\x.ts",
				"a\\dist\\x.js",
				"a\\distance\\x.js",
				"packages\\x\\.worktrees\\a\\f",
				"x\\.worktrees",
				"y\\.worktrees\\w\\f",
				"..x\\.git\\HEAD",
				"..x\\.git\\config",
				"..x\\src\\a.ts",
				"web\\[slug]\\x",
				"app\\[id]\\vendored\\x.ts",
				"app\\[id]\\page.tsx",
				"app\\other.ts",
				"x\\tsconfig.tsbuildinfo",
				"node_modules\\x",
				"a\\node_modules\\x\\index.js",
				".superset-watch-generation-2\\x",
				`src\\${"deep\\".repeat(70)}a.ts`,
				`packages\\sub-repo\\${"deep\\".repeat(70)}a.ts`,
			];
			for (const base of [
				await managerIgnore({ useDefaultIgnores: false }),
				await managerIgnore({}),
			]) {
				const before = await nativeOptionsFor(root, [
					...base,
					...prunedDirIgnores,
					"**/.superset-watch-generation-2/**",
				]);
				expect(before.ignorePaths).toBeUndefined();
				const oracle = (before.ignoreGlobs ?? []).map(
					(source) => new RegExp(source),
				);
				const { nativeDirs, jsGlobs } = nativeIgnoreForWindows(
					[...base, ...prunedDirIgnores, ...nameHitIgnores],
					2,
					root,
				);
				const nativePaths =
					(await nativeOptionsFor(root, nativeDirs)).ignorePaths ?? [];
				const nativePrefixHit = (absolutePath: string) =>
					nativePaths.some(
						(dir) =>
							absolutePath === dir ||
							absolutePath.startsWith(`${dir}${path.win32.sep}`),
					);
				const jsFilter = createIgnoreMatcher(root, jsGlobs);
				for (const rel of rows) {
					const absolutePath = path.win32.join(root, rel);
					expect({
						rel,
						ignored:
							nativePrefixHit(absolutePath) || jsFilter(absolutePath, false),
					}).toEqual({ rel, ignored: oracle.some((re) => re.test(rel)) });
				}
			}
		},
	);
});
