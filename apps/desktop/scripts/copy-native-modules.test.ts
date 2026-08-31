import { afterEach, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	inspectInstalledModule,
	planPlatformModuleCopy,
	readPeMachine,
	replaceDirectoryAtomically,
	selectBunStoreEntry,
	swapScratchPaths,
} from "./copy-native-modules";

/**
 * Temp roots made by this file, deleted after the test that made them.
 *
 * Registered at creation rather than removed at the end of each test: a failing
 * expect() throws past everything after it, so a cleanup tail is skipped by
 * exactly the runs that leave a directory behind. Each test still gets its own
 * fresh mkdtemp root, so isolation is unchanged.
 */
const tempRoots: string[] = [];

function makeTempRoot(prefix: string): string {
	const root = mkdtempSync(join(tmpdir(), prefix));
	tempRoots.push(root);
	return root;
}

afterEach(() => {
	for (const root of tempRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("selectBunStoreEntry exact versions", () => {
	it("does not prefix-match 2.5.1 onto 2.5.10", () => {
		const entries = ["@parcel+watcher@2.5.10", "@parcel+watcher@2.5.1"];

		expect(selectBunStoreEntry(entries, "@parcel/watcher", "2.5.1")).toBe(
			"@parcel+watcher@2.5.1",
		);
		expect(
			selectBunStoreEntry([...entries].reverse(), "@parcel/watcher", "2.5.1"),
		).toBe("@parcel+watcher@2.5.1");
	});

	it("selects a dedupe-suffixed entry when it is the only one", () => {
		expect(
			selectBunStoreEntry(
				["@libsql+client@0.15.15+84634d09670b738c"],
				"@libsql/client",
				"0.15.15",
			),
		).toBe("@libsql+client@0.15.15+84634d09670b738c");
	});

	it("returns null when the exact version is absent", () => {
		expect(
			selectBunStoreEntry(
				["@ast-grep+napi-win32-arm64-msvc@0.41.1"],
				"@ast-grep/napi-win32-arm64-msvc",
				"0.42.3",
			),
		).toBeNull();
	});

	it("never resolves a stable spec to a prerelease", () => {
		expect(
			selectBunStoreEntry(
				["@duckdb+node-bindings@1.5.2-r.1", "@duckdb+node-bindings@1.5.2-r.2"],
				"@duckdb/node-bindings",
				"1.5.2",
			),
		).toBeNull();
		expect(
			selectBunStoreEntry(
				["@duckdb+node-bindings@1.5.2-r.1", "@duckdb+node-bindings@1.5.2-r.2"],
				"@duckdb/node-bindings",
				"1.5.2-r.2",
			),
		).toBe("@duckdb+node-bindings@1.5.2-r.2");
	});

	it("maps a scoped package name onto its + separated store key", () => {
		expect(
			selectBunStoreEntry(
				["@lydell+node-pty-win32-arm64@1.1.0"],
				"@lydell/node-pty-win32-arm64",
				"1.1.0",
			),
		).toBe("@lydell+node-pty-win32-arm64@1.1.0");
	});

	it("tells 1.1.9 and 1.1.10 apart instead of matching lexically", () => {
		const entries = [
			"@lydell+node-pty-win32-arm64@1.1.9",
			"@lydell+node-pty-win32-arm64@1.1.10",
		];

		expect(
			selectBunStoreEntry(entries, "@lydell/node-pty-win32-arm64", "1.1.10"),
		).toBe("@lydell+node-pty-win32-arm64@1.1.10");
		expect(
			selectBunStoreEntry(entries, "@lydell/node-pty-win32-arm64", "1.1.9"),
		).toBe("@lydell+node-pty-win32-arm64@1.1.9");
	});
});

describe("selectBunStoreEntry ranges", () => {
	it("resolves libsql's live ^0.0.4 dependency range", () => {
		expect(
			selectBunStoreEntry(["@neon-rs+load@0.0.4"], "@neon-rs/load", "^0.0.4"),
		).toBe("@neon-rs+load@0.0.4");
	});

	it("refuses to elect among several cached versions satisfying a range", () => {
		expect(() =>
			selectBunStoreEntry(
				["detect-libc@2.0.2", "detect-libc@2.1.2", "detect-libc@2.0.4"],
				"detect-libc",
				"^2.0.3",
			),
		).toThrow(/Ambiguous Bun store versions/);
	});

	it("returns null when no version satisfies the range", () => {
		expect(
			selectBunStoreEntry(
				["detect-libc@2.0.2", "detect-libc@2.0.4"],
				"detect-libc",
				"^3.0.0",
			),
		).toBeNull();
	});
});

describe("selectBunStoreEntry fail-loud cases", () => {
	it("rejects an entry whose suffix is neither a version nor a dedupe hash", () => {
		expect(() =>
			selectBunStoreEntry(["libsql@0.5.22+notahash"], "libsql", "0.5.22"),
		).toThrow(/Unparsable Bun store entry/);
		expect(() =>
			selectBunStoreEntry(["libsql@nightly"], "libsql", "0.5.22"),
		).toThrow(/Unparsable Bun store entry/);
	});

	it("rejects a version spec that is neither a version nor a range", () => {
		expect(() =>
			selectBunStoreEntry(["libsql@0.5.22"], "libsql", "not-a-range"),
		).toThrow(/Unparsable version spec/);
	});

	it("refuses to guess between two entries claiming the same version", () => {
		expect(() =>
			selectBunStoreEntry(
				[
					"@agentclientprotocol+sdk@1.2.0+3c5d820c62823f0b",
					"@agentclientprotocol+sdk@1.2.0+68a1e3a0c4588df3",
				],
				"@agentclientprotocol/sdk",
				"1.2.0",
			),
		).toThrow(/Ambiguous Bun store entries/);
	});

	it("refuses to prefer the plain entry over its dedupe twin", () => {
		const entries = [
			"@lydell+node-pty-win32-arm64@1.1.0",
			"@lydell+node-pty-win32-arm64@1.1.0+84634d09670b738c",
		];

		expect(() =>
			selectBunStoreEntry(entries, "@lydell/node-pty-win32-arm64", "1.1.0"),
		).toThrow(/Ambiguous Bun store entries/);
		expect(() =>
			selectBunStoreEntry(
				[...entries].reverse(),
				"@lydell/node-pty-win32-arm64",
				"1.1.0",
			),
		).toThrow(/Ambiguous Bun store entries/);
	});

	it("ignores entries for a package whose name extends the requested one", () => {
		const entries = [
			"@ast-grep+napi-win32-arm64-msvc@0.42.3",
			"@ast-grep+napi@0.41.1",
		];

		expect(selectBunStoreEntry(entries, "@ast-grep/napi", "0.41.1")).toBe(
			"@ast-grep+napi@0.41.1",
		);
		expect(selectBunStoreEntry(entries, "@ast-grep/napi", "0.42.3")).toBeNull();
	});
});

describe("planPlatformModuleCopy", () => {
	const moduleName = "@lydell/node-pty-win32-arm64";
	/** PE machine values: what a win-arm64 build carries, and a win-x64 one. */
	const ARM64 = 0xaa64;
	const X64 = 0x8664;
	const bothArm64 = {
		"conpty.node": ARM64,
		"conpty_console_list.node": ARM64,
	};

	it("creates the destination when nothing is there", () => {
		expect(planPlatformModuleCopy(moduleName, "1.1.0", null).action).toBe(
			"create",
		);
	});

	it("skips a real directory holding the pinned version and both ARM64 binaries", () => {
		expect(
			planPlatformModuleCopy(moduleName, "1.1.0", {
				isSymbolicLink: false,
				name: moduleName,
				version: "1.1.0",
				nativeMachines: bothArm64,
			}).action,
		).toBe("skip");
	});

	it("replaces a symlink, which electron-builder cannot follow", () => {
		expect(
			planPlatformModuleCopy(moduleName, "1.1.0", {
				isSymbolicLink: true,
				name: null,
				version: null,
				nativeMachines: {},
			}).action,
		).toBe("replace");
	});

	it("replaces a real directory holding another version", () => {
		const plan = planPlatformModuleCopy(moduleName, "1.1.0", {
			isSymbolicLink: false,
			name: moduleName,
			version: "1.0.9",
			nativeMachines: bothArm64,
		});

		expect(plan.action).toBe("replace");
		expect(plan.reason).toContain("1.0.9");
	});

	it("replaces a directory whose package.json is missing or nameless", () => {
		expect(
			planPlatformModuleCopy(moduleName, "1.1.0", {
				isSymbolicLink: false,
				name: null,
				version: null,
				nativeMachines: bothArm64,
			}).action,
		).toBe("replace");
		expect(
			planPlatformModuleCopy(moduleName, "1.1.0", {
				isSymbolicLink: false,
				name: "@lydell/node-pty-win32-x64",
				version: "1.1.0",
				nativeMachines: bothArm64,
			}).action,
		).toBe("replace");
	});

	it("replaces a right-version directory that is missing a conpty binary", () => {
		for (const missing of ["conpty.node", "conpty_console_list.node"]) {
			const plan = planPlatformModuleCopy(moduleName, "1.1.0", {
				isSymbolicLink: false,
				name: moduleName,
				version: "1.1.0",
				nativeMachines: { ...bothArm64, [missing]: null },
			});

			expect(plan.action).toBe("replace");
			expect(plan.reason).toContain(missing);
		}
	});

	it("replaces a right-version directory whose binaries are absent entirely", () => {
		const plan = planPlatformModuleCopy(moduleName, "1.1.0", {
			isSymbolicLink: false,
			name: moduleName,
			version: "1.1.0",
			nativeMachines: {},
		});

		expect(plan.action).toBe("replace");
		expect(plan.reason).toContain("conpty.node");
	});

	it("replaces a right-version directory holding an x64 conpty binary", () => {
		for (const wrongArch of ["conpty.node", "conpty_console_list.node"]) {
			const plan = planPlatformModuleCopy(moduleName, "1.1.0", {
				isSymbolicLink: false,
				name: moduleName,
				version: "1.1.0",
				nativeMachines: { ...bothArm64, [wrongArch]: X64 },
			});

			expect(plan.action).toBe("replace");
			expect(plan.reason).toContain(wrongArch);
			expect(plan.reason).toContain("8664");
		}
	});

	it("rejects a version spec semver cannot parse, before comparing", () => {
		expect(() =>
			planPlatformModuleCopy(moduleName, "not-a-range", {
				isSymbolicLink: false,
				name: moduleName,
				version: "1.1.0",
				nativeMachines: bothArm64,
			}),
		).toThrow(/Unparsable version spec "not-a-range"/);
		expect(() =>
			planPlatformModuleCopy(moduleName, "not-a-range", null),
		).toThrow(/Unparsable version spec "not-a-range"/);
	});

	it("asserts nothing about a platform package with no required files", () => {
		expect(
			planPlatformModuleCopy("@lydell/node-pty-linux-x64", "1.1.0", {
				isSymbolicLink: false,
				name: "@lydell/node-pty-linux-x64",
				version: "1.1.0",
				nativeMachines: {},
			}).action,
		).toBe("skip");
	});
});

describe("readPeMachine", () => {
	type PeShape = {
		mz?: string;
		peOffset?: number;
		signature?: string;
		machine?: number;
	};

	/**
	 * A PE file shaped exactly where `readPeMachine` reads: "MZ" at 0, e_lfanew
	 * at 0x3c, the signature at the offset it names, and the 2-byte machine
	 * field after that. Every field is overridable so a test can break exactly
	 * one of them; an e_lfanew pointing past the end is left dangling rather
	 * than growing the file to meet it.
	 */
	function writePe(filePath: string, shape: PeShape = {}): void {
		const {
			mz = "MZ",
			peOffset = 0x40,
			signature = "PE\0\0",
			machine = 0xaa64,
		} = shape;
		const buffer = Buffer.alloc(0x46);
		buffer.write(mz, 0, "latin1");
		buffer.writeUInt32LE(peOffset, 0x3c);
		if (peOffset + 6 <= buffer.length) {
			buffer.write(signature, peOffset, "latin1");
			buffer.writeUInt16LE(machine, peOffset + 4);
		}
		writeFileSync(filePath, buffer);
	}

	it("reads the machine of an ARM64 and an x64 binary", () => {
		const root = makeTempRoot("copy-native-modules-pe-");
		writePe(join(root, "arm64.node"), { machine: 0xaa64 });
		writePe(join(root, "x64.node"), { machine: 0x8664 });

		expect(readPeMachine(join(root, "arm64.node"))).toBe(0xaa64);
		expect(readPeMachine(join(root, "x64.node"))).toBe(0x8664);
	});

	it("returns null for a missing file and for one with no room for a DOS header", () => {
		const root = makeTempRoot("copy-native-modules-pe-");
		const short = Buffer.alloc(0x3f);
		short.write("MZ", 0, "latin1");
		writeFileSync(join(root, "empty.node"), "");
		writeFileSync(join(root, "short.node"), short);

		expect(readPeMachine(join(root, "absent.node"))).toBeNull();
		expect(readPeMachine(join(root, "empty.node"))).toBeNull();
		expect(readPeMachine(join(root, "short.node"))).toBeNull();
	});

	it("rejects a file that does not open with MZ", () => {
		// The decoy this closes: any file carrying 0xaa64 where the machine field
		// would sit reads as a valid ARM64 native without the DOS header check.
		const root = makeTempRoot("copy-native-modules-pe-");
		writePe(join(root, "decoy.node"), { mz: "\0\0" });
		writePe(join(root, "backwards.node"), { mz: "ZM" });

		expect(readPeMachine(join(root, "decoy.node"))).toBeNull();
		expect(readPeMachine(join(root, "backwards.node"))).toBeNull();
	});

	it("rejects a signature at e_lfanew that is not PE\\0\\0", () => {
		const root = makeTempRoot("copy-native-modules-pe-");
		writePe(join(root, "not-pe.node"), { signature: "XX\0\0" });

		expect(readPeMachine(join(root, "not-pe.node"))).toBeNull();
	});

	it("rejects an e_lfanew pointing outside the headers it may point at", () => {
		const root = makeTempRoot("copy-native-modules-pe-");
		// Back into the DOS header it lives in, with a real signature and machine
		// field written right there, and past the end of the file. Only the
		// bounds check tells either of them apart from a PE image.
		writePe(join(root, "inside-dos.node"), { peOffset: 0x10 });
		writePe(join(root, "past-eof.node"), { peOffset: 0x9999 });

		expect(readPeMachine(join(root, "inside-dos.node"))).toBeNull();
		expect(readPeMachine(join(root, "past-eof.node"))).toBeNull();
	});
});

describe("inspectInstalledModule", () => {
	const moduleName = "@lydell/node-pty-win32-arm64";

	it("returns null when nothing is at the destination", () => {
		const root = makeTempRoot("copy-native-modules-pkg-");

		expect(inspectInstalledModule(join(root, "absent"), moduleName)).toBeNull();
	});

	it("reads a manifest that is absent, corrupt or not an object as nameless", () => {
		const root = makeTempRoot("copy-native-modules-pkg-");
		const bodies: Record<string, string | null> = {
			absent: null,
			truncated: '{"name":"@lydell/node-pty-win32-arm',
			"json-null": "null",
			"json-number": "7",
		};
		for (const [name, body] of Object.entries(bodies)) {
			mkdirSync(join(root, name), { recursive: true });
			if (body !== null) writeFileSync(join(root, name, "package.json"), body);
		}
		// A directory where the manifest should be: readFileSync throws EISDIR.
		// That is the same fact as a truncated manifest — this destination does
		// not say what it holds — and must replace the copy, not kill the build.
		mkdirSync(join(root, "unreadable", "package.json"), { recursive: true });

		for (const name of [...Object.keys(bodies), "unreadable"]) {
			const installed = inspectInstalledModule(join(root, name), moduleName);

			expect(installed).not.toBeNull();
			expect(installed?.name).toBeNull();
			expect(installed?.version).toBeNull();
			expect(planPlatformModuleCopy(moduleName, "1.1.0", installed).action).toBe(
				"replace",
			);
		}
	});

	it("reads name and version from a manifest that parses", () => {
		const root = makeTempRoot("copy-native-modules-pkg-");
		const modulePath = join(root, "pkg");
		mkdirSync(modulePath, { recursive: true });
		writeFileSync(
			join(modulePath, "package.json"),
			JSON.stringify({ name: moduleName, version: "1.1.0" }),
		);

		const installed = inspectInstalledModule(modulePath, moduleName);

		expect(installed?.name).toBe(moduleName);
		expect(installed?.version).toBe("1.1.0");
		// Nothing beside it, so every required binary reads as absent.
		expect(installed?.nativeMachines).toEqual({
			"conpty.node": null,
			"conpty_console_list.node": null,
		});
	});
});

describe("replaceDirectoryAtomically", () => {
	function makeDirs(): {
		source: string;
		dest: string;
		scratch: string;
	} {
		const root = makeTempRoot("copy-native-modules-");
		const source = join(root, "store", "payload");
		mkdirSync(source, { recursive: true });
		writeFileSync(join(source, "package.json"), '{"version":"1.1.0"}');
		writeFileSync(join(source, "pty.node"), "new");
		return {
			source,
			dest: join(root, "node_modules", "@lydell", "pkg"),
			scratch: join(root, "tmp"),
		};
	}

	/** Staging/rollback siblings the swap must never leave in the packaged tree. */
	function leftovers(dest: string): string[] {
		return readdirSync(join(dest, "..")).filter((name) => name !== "pkg");
	}

	/** What the swap left in its scratch directory (nothing, once it is done). */
	function scratchEntries(scratch: string): string[] {
		return existsSync(scratch) ? readdirSync(scratch) : [];
	}

	it("keeps both scratch paths out of the destination's directory", () => {
		const { dest, scratch } = makeDirs();
		const { stagingPath, previousPath } = swapScratchPaths(dest, scratch);

		for (const path of [stagingPath, previousPath]) {
			expect(dirname(path)).toBe(scratch);
			expect(dirname(path)).not.toBe(dirname(dest));
		}
		expect(stagingPath).not.toBe(previousPath);
	});

	it("creates a destination that does not exist yet", () => {
		const { source, dest, scratch } = makeDirs();

		replaceDirectoryAtomically(source, dest, scratch);

		expect(readFileSync(join(dest, "pty.node"), "utf8")).toBe("new");
		expect(leftovers(dest)).toEqual([]);
		expect(scratchEntries(scratch)).toEqual([]);
	});

	it("leaves no stale content from the directory it replaced", () => {
		const { source, dest, scratch } = makeDirs();
		mkdirSync(dest, { recursive: true });
		writeFileSync(join(dest, "pty.node"), "old");
		writeFileSync(join(dest, "only-in-old.txt"), "old");

		replaceDirectoryAtomically(source, dest, scratch);

		expect(readFileSync(join(dest, "pty.node"), "utf8")).toBe("new");
		expect(existsSync(join(dest, "only-in-old.txt"))).toBe(false);
		expect(leftovers(dest)).toEqual([]);
		expect(scratchEntries(scratch)).toEqual([]);
	});

	it("keeps the previous directory when the copy fails", () => {
		const { source, dest, scratch } = makeDirs();
		mkdirSync(dest, { recursive: true });
		writeFileSync(join(dest, "pty.node"), "old");
		rmSync(source, { recursive: true, force: true });

		expect(() => replaceDirectoryAtomically(source, dest, scratch)).toThrow();

		expect(readFileSync(join(dest, "pty.node"), "utf8")).toBe("old");
		expect(leftovers(dest)).toEqual([]);
		expect(scratchEntries(scratch)).toEqual([]);
	});

	it("reuses its scratch paths after an earlier run left them behind", () => {
		const { source, dest, scratch } = makeDirs();
		const { stagingPath, previousPath } = swapScratchPaths(dest, scratch);
		mkdirSync(stagingPath, { recursive: true });
		mkdirSync(previousPath, { recursive: true });
		writeFileSync(join(stagingPath, "stale.txt"), "stale");
		writeFileSync(join(previousPath, "stale.txt"), "stale");

		replaceDirectoryAtomically(source, dest, scratch);

		expect(readFileSync(join(dest, "pty.node"), "utf8")).toBe("new");
		expect(existsSync(join(dest, "stale.txt"))).toBe(false);
		expect(leftovers(dest)).toEqual([]);
		expect(scratchEntries(scratch)).toEqual([]);
	});
});
