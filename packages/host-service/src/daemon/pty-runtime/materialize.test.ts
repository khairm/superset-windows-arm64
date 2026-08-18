import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import {
	collectLiveRuntimeKeys,
	gcPtyRuntimes,
	invalidateRuntime,
	type MaterializeInput,
	materializePtyRuntime,
	type RuntimeIo,
	type SmokeResult,
	writeRuntimeRef,
} from "./materialize.ts";
import { ptyRuntimeKey, ptyRuntimeLayout } from "./plan.ts";

const INSTALL_ROOT = path.resolve("/fake/install");
const ASAR = path.join(INSTALL_ROOT, "resources", "app.asar");
const SCRIPT_PATH = path.join(ASAR, "dist", "main", "pty-daemon.js");
const BASE = path.resolve("/fake/runtime");
const SCRIPT_BODY = 'require("./chunks/package-abc.js");';

interface FakeOptions {
	smoke?: (exePath: string, cwd: string) => SmokeResult;
	alivePids?: ReadonlySet<number>;
	failRename?: boolean;
}

interface Fake {
	io: RuntimeIo;
	files: Map<string, string>;
	dirs: Set<string>;
	mtimes: Map<string, number>;
	/** Directories that refuse to be renamed — stands in for a live daemon. */
	locked: Set<string>;
	copies: number;
	nonces: number;
	smokeCalls: { exePath: string; cwd: string }[];
	logs: string[];
	seedDir(dir: string): void;
	seedFile(file: string, body?: string): void;
	entriesUnder(dir: string): string[];
}

function createFake(options: FakeOptions = {}): Fake {
	const files = new Map<string, string>();
	const dirs = new Set<string>();
	const mtimes = new Map<string, number>();
	const locked = new Set<string>();
	const smokeCalls: { exePath: string; cwd: string }[] = [];
	const logs: string[] = [];
	const clock = 1_000_000;

	const norm = (target: string) => path.resolve(target);
	const exists = (target: string) =>
		files.has(norm(target)) || dirs.has(norm(target));

	const fake: Fake = {
		files,
		dirs,
		mtimes,
		locked,
		copies: 0,
		nonces: 0,
		smokeCalls,
		logs,
		seedDir(dir: string) {
			let current = norm(dir);
			while (!dirs.has(current)) {
				dirs.add(current);
				mtimes.set(current, clock);
				const parent = path.dirname(current);
				if (parent === current) break;
				current = parent;
			}
		},
		seedFile(file: string, body = "x") {
			fake.seedDir(path.dirname(file));
			files.set(norm(file), body);
			mtimes.set(norm(file), clock);
		},
		entriesUnder(dir: string): string[] {
			const prefix = norm(dir);
			const out: string[] = [];
			for (const key of [...files.keys(), ...dirs.keys()]) {
				if (path.dirname(key) === prefix) out.push(path.basename(key));
			}
			return out.sort();
		},
		io: {
			async exists(target) {
				return exists(target);
			},
			async readdir(dir) {
				const prefix = norm(dir);
				if (!dirs.has(prefix)) {
					throw new Error(`ENOENT: no such directory ${prefix}`);
				}
				const out: { name: string; isDirectory: boolean }[] = [];
				for (const key of dirs) {
					if (key !== prefix && path.dirname(key) === prefix) {
						out.push({ name: path.basename(key), isDirectory: true });
					}
				}
				for (const key of files.keys()) {
					if (path.dirname(key) === prefix) {
						out.push({ name: path.basename(key), isDirectory: false });
					}
				}
				return out.sort((a, b) => a.name.localeCompare(b.name));
			},
			async mtimeMs(target) {
				const key = norm(target);
				if (!exists(key)) throw new Error(`ENOENT: ${key}`);
				return mtimes.get(key) ?? 0;
			},
			async readFile(target) {
				const body = files.get(norm(target));
				if (body === undefined) throw new Error(`ENOENT: ${norm(target)}`);
				return Buffer.from(body);
			},
			async writeFile(target, data) {
				const key = norm(target);
				if (!dirs.has(path.dirname(key))) {
					throw new Error(`ENOENT: missing parent for ${key}`);
				}
				files.set(key, data.toString());
				mtimes.set(key, clock);
			},
			async mkdirp(dir) {
				fake.seedDir(dir);
			},
			async copyRealFile(from, to) {
				const body = files.get(norm(from));
				if (body === undefined) throw new Error(`ENOENT: ${norm(from)}`);
				if (!dirs.has(path.dirname(norm(to)))) {
					throw new Error(`ENOENT: missing parent for ${norm(to)}`);
				}
				files.set(norm(to), body);
				mtimes.set(norm(to), clock);
				fake.copies += 1;
			},
			async rename(from, to) {
				if (options.failRename) throw new Error("EPERM: rename refused");
				const src = norm(from);
				const dest = norm(to);
				if (!exists(src)) throw new Error(`ENOENT: ${src}`);
				if (locked.has(src)) {
					throw new Error(`EPERM: ${src} is in use by a running process`);
				}
				const move = (key: string) =>
					key === src ? dest : dest + key.slice(src.length);
				for (const key of [...dirs]) {
					if (key === src || key.startsWith(src + path.sep)) {
						dirs.delete(key);
						dirs.add(move(key));
						const stamp = mtimes.get(key);
						mtimes.delete(key);
						if (stamp !== undefined) mtimes.set(move(key), stamp);
					}
				}
				for (const [key, body] of [...files]) {
					if (key === src || key.startsWith(src + path.sep)) {
						files.delete(key);
						files.set(move(key), body);
					}
				}
			},
			async removeRecursive(target) {
				const key = norm(target);
				for (const dir of [...dirs]) {
					if (dir === key || dir.startsWith(key + path.sep)) dirs.delete(dir);
				}
				for (const file of [...files.keys()]) {
					if (file === key || file.startsWith(key + path.sep)) {
						files.delete(file);
					}
				}
			},
			async smokeTest(exePath, cwd) {
				smokeCalls.push({ exePath, cwd });
				return options.smoke?.(exePath, cwd) ?? { ok: true };
			},
			isProcessAlive(pid) {
				return options.alivePids?.has(pid) ?? false;
			},
			now() {
				return clock;
			},
			nonce() {
				fake.nonces += 1;
				return `n${fake.nonces}`;
			},
			log(level, message) {
				logs.push(`${level}:${message}`);
			},
		},
	};
	return fake;
}

function seedPackagedApp(fake: Fake): void {
	fake.seedFile(path.join(INSTALL_ROOT, "Superset.exe"), "ELECTRON");
	fake.seedFile(path.join(INSTALL_ROOT, "ffmpeg.dll"));
	fake.seedFile(path.join(INSTALL_ROOT, "icudtl.dat"));
	fake.seedFile(path.join(INSTALL_ROOT, "debug.log"));
	fake.seedFile(path.join(INSTALL_ROOT, "Uninstall Superset.exe"));
	fake.seedFile(path.join(INSTALL_ROOT, "locales", "en-US.pak"));
	fake.seedFile(path.join(INSTALL_ROOT, "resources", "huge-blob.bin"));

	const main = path.join(ASAR, "dist", "main");
	fake.seedFile(SCRIPT_PATH, SCRIPT_BODY);
	fake.seedFile(path.join(main, "host-service.js"));
	fake.seedFile(path.join(main, "chunks", "package-abc.js"));
	fake.seedFile(path.join(main, "chunks", "package-abc.js.map"));
	fake.seedFile(path.join(main, "chunks", "process-tree-def.js"));

	const nm = path.join(ASAR, "node_modules");
	fake.seedFile(path.join(nm, "node-pty", "index.js"));
	fake.seedFile(path.join(nm, "node-pty", "worker", "conoutSocketWorker.js"));
	fake.seedFile(
		path.join(nm, "@lydell", "node-pty-win32-arm64", "conpty.node"),
		"NATIVE",
	);
}

function input(fake: Fake): MaterializeInput {
	return {
		io: fake.io,
		base: BASE,
		installRoot: INSTALL_ROOT,
		exeName: "Superset.exe",
		daemonScriptPath: SCRIPT_PATH,
		daemonVersion: "0.4.0",
		electronVersion: "40.0.0",
		platform: "win32",
		arch: "arm64",
	};
}

const EXPECTED_KEY = ptyRuntimeKey({
	daemonVersion: "0.4.0",
	electronVersion: "40.0.0",
	scriptBytes: Buffer.from(SCRIPT_BODY),
});
const LAYOUT = ptyRuntimeLayout(BASE, EXPECTED_KEY);

describe("materializePtyRuntime", () => {
	test("builds a runnable runtime outside the install directory", async () => {
		const fake = createFake();
		seedPackagedApp(fake);

		const result = await materializePtyRuntime(input(fake));

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.reused).toBe(false);
		expect(result.key).toBe(EXPECTED_KEY);
		expect(result.root).toBe(LAYOUT.root);
		expect(result.exePath).toBe(LAYOUT.exePath);
		expect(result.scriptPath).toBe(LAYOUT.scriptPath);
		// Nothing lives under the install directory any more.
		expect(result.root.startsWith(INSTALL_ROOT)).toBe(false);
	});

	test("renames the binary so a name-matching installer kill misses it", async () => {
		const fake = createFake();
		seedPackagedApp(fake);
		await materializePtyRuntime(input(fake));

		expect(fake.files.has(LAYOUT.exePath)).toBe(true);
		expect(fake.files.get(LAYOUT.exePath)).toBe("ELECTRON");
		expect(fake.files.has(path.join(LAYOUT.root, "Superset.exe"))).toBe(false);
	});

	test("copies the Electron runtime but never resources/", async () => {
		const fake = createFake();
		seedPackagedApp(fake);
		await materializePtyRuntime(input(fake));

		expect(fake.files.has(path.join(LAYOUT.root, "ffmpeg.dll"))).toBe(true);
		expect(fake.files.has(path.join(LAYOUT.root, "icudtl.dat"))).toBe(true);
		expect(fake.files.has(path.join(LAYOUT.root, "locales", "en-US.pak"))).toBe(
			true,
		);
		expect(fake.dirs.has(path.join(LAYOUT.root, "resources"))).toBe(false);
		expect(fake.files.has(path.join(LAYOUT.root, "debug.log"))).toBe(false);
		expect(
			fake.files.has(path.join(LAYOUT.root, "Uninstall Superset.exe")),
		).toBe(false);
	});

	test("copies the daemon entry, every chunk and the native packages", async () => {
		const fake = createFake();
		seedPackagedApp(fake);
		await materializePtyRuntime(input(fake));

		expect(fake.files.get(LAYOUT.scriptPath)).toBe(SCRIPT_BODY);
		const chunks = path.join(LAYOUT.appDir, "chunks");
		expect(fake.files.has(path.join(chunks, "package-abc.js"))).toBe(true);
		expect(fake.files.has(path.join(chunks, "process-tree-def.js"))).toBe(true);
		expect(fake.files.has(path.join(chunks, "package-abc.js.map"))).toBe(false);

		const nm = LAYOUT.nodeModulesDir;
		expect(fake.files.has(path.join(nm, "node-pty", "index.js"))).toBe(true);
		expect(
			fake.files.has(
				path.join(nm, "node-pty", "worker", "conoutSocketWorker.js"),
			),
		).toBe(true);
		expect(
			fake.files.get(
				path.join(nm, "@lydell", "node-pty-win32-arm64", "conpty.node"),
			),
		).toBe("NATIVE");
		// host-service.js is not the daemon's business.
		expect(fake.files.has(path.join(LAYOUT.appDir, "host-service.js"))).toBe(
			false,
		);
	});

	test("smoke-tests the copied binary before committing it", async () => {
		const fake = createFake();
		seedPackagedApp(fake);
		await materializePtyRuntime(input(fake));

		expect(fake.smokeCalls).toHaveLength(1);
		const call = fake.smokeCalls[0];
		expect(call?.exePath).toBe(path.join(call?.cwd ?? "", "superset-ptyd.exe"));
		// It runs against the staging directory, not the committed one.
		expect(call?.cwd).not.toBe(LAYOUT.root);
	});

	test("the ready marker is not present while the runtime is being proved", async () => {
		let readyDuringSmoke: boolean | null = null;
		const fake = createFake({
			smoke: (_exe, cwd) => {
				readyDuringSmoke = fake.files.has(path.join(cwd, ".ready"));
				return { ok: true };
			},
		});
		seedPackagedApp(fake);
		await materializePtyRuntime(input(fake));

		expect(readyDuringSmoke).toBe(false);
		expect(fake.files.get(LAYOUT.readyMarker)).toBe(EXPECTED_KEY);
	});

	test("a second call reuses the runtime and copies nothing", async () => {
		const fake = createFake();
		seedPackagedApp(fake);
		await materializePtyRuntime(input(fake));
		const copiesAfterFirst = fake.copies;

		const again = await materializePtyRuntime(input(fake));

		expect(again.ok).toBe(true);
		if (!again.ok) return;
		expect(again.reused).toBe(true);
		expect(again.root).toBe(LAYOUT.root);
		expect(fake.copies).toBe(copiesAfterFirst);
		expect(fake.smokeCalls).toHaveLength(1);
	});

	test("a ready marker whose exe has vanished is not reusable", async () => {
		const fake = createFake();
		seedPackagedApp(fake);
		await materializePtyRuntime(input(fake));
		const copiesAfterFirst = fake.copies;

		// Antivirus quarantines the unsigned, freshly RENAMED binary — the
		// realistic way a committed runtime rots. `.ready` survives it, and
		// believing the marker means every spawn ENOENTs forever.
		fake.files.delete(LAYOUT.exePath);

		const again = await materializePtyRuntime(input(fake));

		expect(again.ok).toBe(true);
		if (!again.ok) return;
		expect(again.reused).toBe(false);
		expect(fake.copies).toBeGreaterThan(copiesAfterFirst);
		expect(fake.files.get(LAYOUT.exePath)).toBe("ELECTRON");
		// Rebuilding means re-proving: the new copy ran the smoke test too.
		expect(fake.smokeCalls).toHaveLength(2);
	});

	test("a ready marker whose daemon script has vanished is not reusable", async () => {
		const fake = createFake();
		seedPackagedApp(fake);
		await materializePtyRuntime(input(fake));

		fake.files.delete(LAYOUT.scriptPath);

		const again = await materializePtyRuntime(input(fake));

		expect(again.ok).toBe(true);
		if (!again.ok) return;
		expect(again.reused).toBe(false);
		expect(fake.files.get(LAYOUT.scriptPath)).toBe(SCRIPT_BODY);
	});

	test("a directory without a ready marker is treated as not ready and rebuilt", async () => {
		const fake = createFake();
		seedPackagedApp(fake);
		// A previous run died between rename and marker, or mid-delete.
		fake.seedFile(path.join(LAYOUT.root, "half-copied.dll"));

		const result = await materializePtyRuntime(input(fake));

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.reused).toBe(false);
		expect(fake.files.has(path.join(LAYOUT.root, "half-copied.dll"))).toBe(
			false,
		);
		expect(fake.files.has(LAYOUT.readyMarker)).toBe(true);
	});

	test("a failing smoke test commits nothing and leaves no scratch behind", async () => {
		const fake = createFake({
			smoke: () => ({ ok: false, reason: "conpty.node is x64" }),
		});
		seedPackagedApp(fake);

		const result = await materializePtyRuntime(input(fake));

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toContain("conpty.node is x64");
		expect(fake.dirs.has(LAYOUT.root)).toBe(false);
		expect(fake.entriesUnder(BASE)).toEqual([]);
	});

	test("a failed commit never leaves a half-built runtime at the real path", async () => {
		const fake = createFake({ failRename: true });
		seedPackagedApp(fake);

		const result = await materializePtyRuntime(input(fake));

		expect(result.ok).toBe(false);
		expect(fake.dirs.has(LAYOUT.root)).toBe(false);
		expect(fake.entriesUnder(BASE)).toEqual([]);
	});

	test("fails loud when the daemon's chunks are missing", async () => {
		const fake = createFake();
		seedPackagedApp(fake);
		const chunks = path.join(ASAR, "dist", "main", "chunks");
		fake.files.delete(path.join(chunks, "package-abc.js"));
		fake.files.delete(path.join(chunks, "process-tree-def.js"));

		const result = await materializePtyRuntime(input(fake));

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toContain("chunks");
	});

	test("fails loud when node-pty cannot be found above the daemon script", async () => {
		const fake = createFake();
		seedPackagedApp(fake);
		await fake.io.removeRecursive(path.join(ASAR, "node_modules"));

		const result = await materializePtyRuntime(input(fake));

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toContain("node_modules/node-pty");
	});

	test("fails loud when the install root has no binary to copy", async () => {
		const fake = createFake();
		seedPackagedApp(fake);
		fake.files.delete(path.join(INSTALL_ROOT, "Superset.exe"));

		const result = await materializePtyRuntime(input(fake));

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toContain("Superset.exe");
	});
});

describe("invalidateRuntime", () => {
	test("a discarded runtime is rebuilt, and nothing is unlinked under a daemon", async () => {
		const fake = createFake();
		seedPackagedApp(fake);
		await materializePtyRuntime(input(fake));

		await invalidateRuntime(fake.io, BASE, EXPECTED_KEY);

		// Only the marker goes. Another org's daemon may still be executing out
		// of this key, and unlinking its plain-.js conout worker underneath it
		// is the corruption the rename gate exists to prevent.
		expect(fake.files.has(LAYOUT.readyMarker)).toBe(false);
		expect(fake.files.get(LAYOUT.exePath)).toBe("ELECTRON");
		expect(fake.files.get(LAYOUT.scriptPath)).toBe(SCRIPT_BODY);

		const again = await materializePtyRuntime(input(fake));

		expect(again.ok).toBe(true);
		if (!again.ok) return;
		expect(again.reused).toBe(false);
		expect(fake.files.get(LAYOUT.readyMarker)).toBe(EXPECTED_KEY);
	});
});

describe("runtime refs", () => {
	test("a live daemon's key is reported, a dead one's record is dropped", async () => {
		const fake = createFake({ alivePids: new Set([111]) });
		await writeRuntimeRef(fake.io, BASE, {
			pid: 111,
			key: "live-key",
			startedAt: 1,
		});
		await writeRuntimeRef(fake.io, BASE, {
			pid: 222,
			key: "dead-key",
			startedAt: 1,
		});

		const live = await collectLiveRuntimeKeys(fake.io, BASE);

		expect([...live]).toEqual(["live-key"]);
		expect(fake.files.has(path.join(BASE, ".refs", "111.json"))).toBe(true);
		expect(fake.files.has(path.join(BASE, ".refs", "222.json"))).toBe(false);
	});

	test("an unparsable ref neither protects nor survives", async () => {
		const fake = createFake({ alivePids: new Set([111]) });
		fake.seedFile(path.join(BASE, ".refs", "111.json"), "{ not json");

		expect([...(await collectLiveRuntimeKeys(fake.io, BASE))]).toEqual([]);
	});
});

describe("gcPtyRuntimes", () => {
	/** Past the post-commit grace period: a runtime from an earlier boot. */
	const SETTLED_AGE_MS = 24 * 60 * 60 * 1000;

	function seedRuntimes(
		fake: Fake,
		names: string[],
		ageMs = SETTLED_AGE_MS,
	): void {
		for (const name of names) {
			fake.seedFile(path.join(BASE, name, ".ready"), name);
			fake.seedFile(path.join(BASE, name, "superset-ptyd.exe"));
			fake.mtimes.set(path.join(BASE, name), fake.io.now() - ageMs);
		}
	}

	test("leaves a just-committed runtime alone until its daemon can claim it", async () => {
		const fake = createFake();
		seedRuntimes(fake, ["current"]);
		// Committed seconds ago by another host-service, which has not reached
		// its post-spawn ref write yet.
		seedRuntimes(fake, ["just-committed"], 2_000);

		const outcome = await gcPtyRuntimes({
			io: fake.io,
			base: BASE,
			currentKey: "current",
		});

		expect(outcome.removed).toEqual([]);
		expect(fake.files.has(path.join(BASE, "just-committed", ".ready"))).toBe(
			true,
		);
	});

	test("reclaims runtimes nothing is using", async () => {
		const fake = createFake();
		seedRuntimes(fake, ["current", "old-1", "old-2"]);

		const outcome = await gcPtyRuntimes({
			io: fake.io,
			base: BASE,
			currentKey: "current",
		});

		expect(outcome.removed.sort()).toEqual(["old-1", "old-2"]);
		expect(fake.dirs.has(path.join(BASE, "current"))).toBe(true);
		expect(fake.dirs.has(path.join(BASE, "old-1"))).toBe(false);
	});

	test("refuses to delete a runtime a live daemon is executing", async () => {
		const fake = createFake({ alivePids: new Set([777]) });
		seedRuntimes(fake, ["current", "old-1"]);
		await writeRuntimeRef(fake.io, BASE, {
			pid: 777,
			key: "old-1",
			startedAt: 1,
		});

		const outcome = await gcPtyRuntimes({
			io: fake.io,
			base: BASE,
			currentKey: "current",
		});

		expect(outcome.removed).toEqual([]);
		expect(fake.files.has(path.join(BASE, "old-1", ".ready"))).toBe(true);
		expect(fake.files.has(path.join(BASE, "old-1", "superset-ptyd.exe"))).toBe(
			true,
		);
	});

	test("reclaims a runtime whose claiming daemon is gone", async () => {
		const fake = createFake({ alivePids: new Set() });
		seedRuntimes(fake, ["current", "old-1"]);
		await writeRuntimeRef(fake.io, BASE, {
			pid: 777,
			key: "old-1",
			startedAt: 1,
		});

		const outcome = await gcPtyRuntimes({
			io: fake.io,
			base: BASE,
			currentKey: "current",
		});

		expect(outcome.removed).toEqual(["old-1"]);
	});

	test("a directory that will not rename is skipped intact, not half-deleted", async () => {
		const fake = createFake();
		seedRuntimes(fake, ["current", "old-1"]);
		fake.locked.add(path.join(BASE, "old-1"));

		const outcome = await gcPtyRuntimes({
			io: fake.io,
			base: BASE,
			currentKey: "current",
		});

		expect(outcome.removed).toEqual([]);
		expect(outcome.skipped).toEqual(["old-1"]);
		// Every file still there — the rename gate ran before any unlink.
		expect(fake.files.has(path.join(BASE, "old-1", ".ready"))).toBe(true);
		expect(fake.files.has(path.join(BASE, "old-1", "superset-ptyd.exe"))).toBe(
			true,
		);
	});

	test("leaves a staging directory that may still be mid-copy", async () => {
		const fake = createFake();
		seedRuntimes(fake, ["current"]);
		fake.seedFile(path.join(BASE, "current.tmp-abc", "partial.dll"));

		const outcome = await gcPtyRuntimes({
			io: fake.io,
			base: BASE,
			currentKey: "current",
		});

		expect(outcome.removed).toEqual([]);
	});

	test("reclaims an abandoned staging directory", async () => {
		const fake = createFake();
		seedRuntimes(fake, ["current"]);
		fake.seedFile(path.join(BASE, "current.tmp-abc", "partial.dll"));
		fake.mtimes.set(
			path.join(BASE, "current.tmp-abc"),
			fake.io.now() - 8 * 60 * 60 * 1000,
		);

		const outcome = await gcPtyRuntimes({
			io: fake.io,
			base: BASE,
			currentKey: "current",
		});

		expect(outcome.removed).toEqual(["current.tmp-abc"]);
	});

	test("is a no-op when no runtime base exists yet", async () => {
		const fake = createFake();

		expect(
			await gcPtyRuntimes({ io: fake.io, base: BASE, currentKey: "current" }),
		).toEqual({ removed: [], skipped: [] });
	});
});
