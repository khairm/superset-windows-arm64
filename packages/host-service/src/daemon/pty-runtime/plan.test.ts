import { describe, expect, test } from "bun:test";
import {
	isScratchDirName,
	parseRuntimeRef,
	ptyRuntimeBaseDir,
	ptyRuntimeKey,
	ptyRuntimeLayout,
	requiredDaemonPackages,
	selectElectronRuntimeEntries,
	selectRuntimeDirsToRemove,
} from "./plan.ts";

const SCRIPT = Buffer.from("require('./chunks/package-CvNMt0Hj.js');");

function key(overrides: Partial<Parameters<typeof ptyRuntimeKey>[0]> = {}) {
	return ptyRuntimeKey({
		daemonVersion: "0.4.0",
		electronVersion: "40.1.2",
		scriptBytes: SCRIPT,
		...overrides,
	});
}

describe("ptyRuntimeKey", () => {
	test("is stable for identical inputs", () => {
		expect(key()).toBe(key());
	});

	test("changes when the daemon entry script changes", () => {
		expect(key({ scriptBytes: Buffer.from("other") })).not.toBe(key());
	});

	test("changes when the Electron runtime changes", () => {
		expect(key({ electronVersion: "41.0.0" })).not.toBe(key());
	});

	test("changes when the daemon package version changes", () => {
		expect(key({ daemonVersion: "0.5.0" })).not.toBe(key());
	});

	test("stays a safe directory name", () => {
		expect(key({ daemonVersion: "0.4.0+win/arm 64" })).toMatch(
			/^[A-Za-z0-9._-]+$/,
		);
	});

	test("refuses an empty script rather than keying on nothing", () => {
		expect(() => key({ scriptBytes: Buffer.alloc(0) })).toThrow(
			/daemon script is empty/,
		);
	});

	test("refuses an empty version component", () => {
		expect(() => key({ daemonVersion: "  " })).toThrow(
			/daemonVersion is empty/,
		);
	});
});

describe("ptyRuntimeBaseDir", () => {
	test("honours an explicit override", () => {
		expect(
			ptyRuntimeBaseDir({
				SUPERSET_PTY_RUNTIME_DIR: "/tmp/rt",
				LOCALAPPDATA: "/x",
			}),
		).toBe("/tmp/rt");
	});

	test("defaults under LOCALAPPDATA", () => {
		const base = ptyRuntimeBaseDir({ LOCALAPPDATA: "/local" });
		expect(base).toContain("Superset");
		expect(base).toContain("pty-runtime");
	});

	test("fails loud when there is nowhere machine-local to put it", () => {
		expect(() => ptyRuntimeBaseDir({})).toThrow(/LOCALAPPDATA is not set/);
	});
});

describe("selectElectronRuntimeEntries", () => {
	const installRoot = [
		{ name: "Superset.exe", isDirectory: false },
		{ name: "ffmpeg.dll", isDirectory: false },
		{ name: "libEGL.dll", isDirectory: false },
		{ name: "icudtl.dat", isDirectory: false },
		{ name: "resources.pak", isDirectory: false },
		{ name: "v8_context_snapshot.bin", isDirectory: false },
		{ name: "vk_swiftshader_icd.json", isDirectory: false },
		{ name: "LICENSE.electron.txt", isDirectory: false },
		{ name: "debug.log", isDirectory: false },
		{ name: "Uninstall Superset.exe", isDirectory: false },
		{ name: "uninstallerIcon.ico", isDirectory: false },
		{ name: "locales", isDirectory: true },
		{ name: "resources", isDirectory: true },
	];

	test("takes the Electron runtime and leaves the installer scaffolding", () => {
		const out = selectElectronRuntimeEntries(installRoot, "Superset.exe");
		expect(out.files).toContain("Superset.exe");
		expect(out.files).toContain("ffmpeg.dll");
		expect(out.files).toContain("icudtl.dat");
		expect(out.files).toContain("v8_context_snapshot.bin");
		expect(out.files).not.toContain("debug.log");
		expect(out.files).not.toContain("Uninstall Superset.exe");
		expect(out.files).not.toContain("uninstallerIcon.ico");
	});

	test("never copies resources/ — the 1.8 GB asar the daemon never reads", () => {
		const out = selectElectronRuntimeEntries(installRoot, "Superset.exe");
		expect(out.dirs).toEqual(["locales"]);
	});

	test("accepts an unknown new runtime file rather than asserting a name list", () => {
		const out = selectElectronRuntimeEntries(
			[...installRoot, { name: "brand_new_electron.dll", isDirectory: false }],
			"Superset.exe",
		);
		expect(out.files).toContain("brand_new_electron.dll");
	});

	test("fails loud when the binary it must copy is absent", () => {
		expect(() =>
			selectElectronRuntimeEntries(
				[{ name: "ffmpeg.dll", isDirectory: false }],
				"Superset.exe",
			),
		).toThrow(/no Superset\.exe to copy/);
	});
});

describe("requiredDaemonPackages", () => {
	test("derives the native package from platform and arch", () => {
		expect(requiredDaemonPackages("win32", "arm64")).toEqual([
			"node-pty",
			"@lydell/node-pty-win32-arm64",
		]);
		expect(requiredDaemonPackages("darwin", "x64")[1]).toBe(
			"@lydell/node-pty-darwin-x64",
		);
	});
});

describe("selectRuntimeDirsToRemove", () => {
	const now = 1_000_000_000;
	// Defaults to a runtime settled since some earlier boot; the post-commit
	// grace period gets its own case below.
	const entry = (name: string, ageMs = 24 * 60 * 60 * 1000) => ({
		name,
		mtimeMs: now - ageMs,
	});

	test("reclaims a runtime nothing is using", () => {
		expect(
			selectRuntimeDirsToRemove({
				entries: [entry("old-key"), entry("current")],
				currentKey: "current",
				liveKeys: new Set(),
				now,
			}),
		).toEqual(["old-key"]);
	});

	test("never reclaims the runtime in use right now", () => {
		expect(
			selectRuntimeDirsToRemove({
				entries: [entry("current")],
				currentKey: "current",
				liveKeys: new Set(),
				now,
			}),
		).toEqual([]);
	});

	test("never reclaims a runtime a live daemon is executing", () => {
		expect(
			selectRuntimeDirsToRemove({
				entries: [entry("old-key")],
				currentKey: "current",
				liveKeys: new Set(["old-key"]),
				now,
			}),
		).toEqual([]);
	});

	test("never reclaims a runtime committed moments ago", () => {
		// Committed, ready, claimed by nobody and running nothing — because the
		// host-service that built it has not reached its post-spawn ref write.
		expect(
			selectRuntimeDirsToRemove({
				entries: [entry("just-committed", 2_000)],
				currentKey: "current",
				liveKeys: new Set(),
				now,
			}),
		).toEqual([]);
	});

	test("leaves a staging directory that may still be mid-copy", () => {
		expect(
			selectRuntimeDirsToRemove({
				entries: [entry("current.tmp-abc", 5_000)],
				currentKey: "current",
				liveKeys: new Set(),
				now,
			}),
		).toEqual([]);
	});

	test("reclaims an abandoned staging directory", () => {
		expect(
			selectRuntimeDirsToRemove({
				entries: [entry("current.tmp-abc", 4 * 60 * 60 * 1000)],
				currentKey: "current",
				liveKeys: new Set(),
				now,
			}),
		).toEqual(["current.tmp-abc"]);
	});

	test("reclaims an abandoned pending-delete directory", () => {
		expect(
			selectRuntimeDirsToRemove({
				entries: [entry("old.gc-def", 4 * 60 * 60 * 1000)],
				currentKey: "current",
				liveKeys: new Set(),
				now,
			}),
		).toEqual(["old.gc-def"]);
	});

	test("leaves the refs directory alone", () => {
		expect(
			selectRuntimeDirsToRemove({
				entries: [entry(".refs")],
				currentKey: "current",
				liveKeys: new Set(),
				now,
			}),
		).toEqual([]);
	});
});

describe("isScratchDirName", () => {
	test("separates scratch from real runtime keys", () => {
		expect(isScratchDirName("0.4.0-e40.1.2-abc123")).toBe(false);
		expect(isScratchDirName("0.4.0-e40.1.2-abc123.tmp-ff00")).toBe(true);
		expect(isScratchDirName("0.4.0-e40.1.2-abc123.gc-ff00")).toBe(true);
	});
});

describe("ptyRuntimeLayout", () => {
	test("places the exe, entry script and node_modules where Node resolves them", () => {
		const layout = ptyRuntimeLayout("/base", "k1");
		expect(layout.exePath.endsWith("superset-ptyd.exe")).toBe(true);
		// `require("node-pty")` from app/pty-daemon.js walks up into <root>/node_modules.
		expect(layout.scriptPath.startsWith(layout.appDir)).toBe(true);
		expect(layout.appDir.startsWith(layout.root)).toBe(true);
		expect(layout.nodeModulesDir.startsWith(layout.root)).toBe(true);
		expect(layout.readyMarker.startsWith(layout.root)).toBe(true);
	});
});

describe("parseRuntimeRef", () => {
	test("round-trips a well-formed record", () => {
		expect(parseRuntimeRef('{"pid":42,"key":"k","startedAt":7}')).toEqual({
			pid: 42,
			key: "k",
			startedAt: 7,
		});
	});

	test("rejects anything it cannot trust", () => {
		expect(parseRuntimeRef("not json")).toBeNull();
		expect(parseRuntimeRef("null")).toBeNull();
		expect(parseRuntimeRef('{"pid":"42","key":"k","startedAt":7}')).toBeNull();
		expect(parseRuntimeRef('{"pid":0,"key":"k","startedAt":7}')).toBeNull();
		expect(parseRuntimeRef('{"pid":42,"key":"","startedAt":7}')).toBeNull();
		expect(parseRuntimeRef('{"pid":42,"key":"k"}')).toBeNull();
	});
});
