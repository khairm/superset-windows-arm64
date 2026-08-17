import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	CAPTURE_MODE,
	CURRENT_FILE,
	isNetworkLoggingEnabled,
	isPurgeableLogFile,
	MAX_FILE_BYTES,
	NETWORK_LOG_ENV,
	type PurgeIO,
	purgeNetworkLogs,
} from "./policy";

describe("(NETLOG-OFF) opt-in", () => {
	test("disabled when the variable is absent — the default is OFF", () => {
		expect(isNetworkLoggingEnabled({})).toBe(false);
	});

	test("enabled only by an explicit affirmative value", () => {
		expect(isNetworkLoggingEnabled({ [NETWORK_LOG_ENV]: "1" })).toBe(true);
		expect(isNetworkLoggingEnabled({ [NETWORK_LOG_ENV]: "true" })).toBe(true);
		expect(isNetworkLoggingEnabled({ [NETWORK_LOG_ENV]: " TRUE " })).toBe(true);
	});

	test("an empty or negative value stays off rather than counting as 'set'", () => {
		expect(isNetworkLoggingEnabled({ [NETWORK_LOG_ENV]: "" })).toBe(false);
		expect(isNetworkLoggingEnabled({ [NETWORK_LOG_ENV]: "0" })).toBe(false);
		expect(isNetworkLoggingEnabled({ [NETWORK_LOG_ENV]: "false" })).toBe(false);
	});
});

describe("(NETLOG-OFF) capture mode", () => {
	test("never records cookies, auth headers or bodies", () => {
		expect(CAPTURE_MODE).not.toBe("includeSensitive");
		expect(CAPTURE_MODE).toBe("default");
	});

	test("the cap is far below upstream's 1 GB", () => {
		expect(MAX_FILE_BYTES).toBeLessThan(128 * 1024 * 1024);
	});

	test("no environment variable can reach includeSensitive", () => {
		const source = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
		const modes = [...source.matchAll(/captureMode:\s*"?([A-Za-z_]+)"?/g)].map(
			(m) => m[1],
		);
		expect(modes.length).toBeGreaterThan(0);
		for (const mode of modes) expect(mode).not.toBe("includeSensitive");
	});
});

describe("(NETLOG-OFF) purge", () => {
	function io(dir: string, names: string[], locked: string[] = []) {
		const unlinked: string[] = [];
		const impl: PurgeIO = {
			exists: (d) => d === dir,
			readdir: () => names,
			unlink: (filePath) => {
				const name = filePath.slice(dir.length + 1);
				if (locked.includes(name)) throw new Error("EBUSY");
				unlinked.push(name);
			},
			join: (d, name) => `${d}/${name}`,
		};
		return { impl, unlinked };
	}

	test("removes current.json and every session file", () => {
		const { impl, unlinked } = io("/logs", [
			CURRENT_FILE,
			"session-2026-08-17T00-00-00-000Z.json",
			"session-2026-08-16T00-00-00-000Z.json",
		]);
		expect(purgeNetworkLogs("/logs", impl)).toEqual({ removed: 3, failed: 0 });
		expect(unlinked).toHaveLength(3);
	});

	test("leaves files this module did not write", () => {
		const { impl, unlinked } = io("/logs", ["notes.txt", "session-x.log"]);
		expect(purgeNetworkLogs("/logs", impl)).toEqual({ removed: 0, failed: 0 });
		expect(unlinked).toEqual([]);
	});

	test("a locked file is counted, not thrown — this runs at boot", () => {
		const { impl } = io(
			"/logs",
			[CURRENT_FILE, "session-a.json"],
			[CURRENT_FILE],
		);
		expect(purgeNetworkLogs("/logs", impl)).toEqual({ removed: 1, failed: 1 });
	});

	test("an absent directory is not created and reports nothing", () => {
		const { impl } = io("/logs", []);
		expect(purgeNetworkLogs("/other", impl)).toEqual({ removed: 0, failed: 0 });
	});

	test("matcher accepts only the two known names", () => {
		expect(isPurgeableLogFile(CURRENT_FILE)).toBe(true);
		expect(isPurgeableLogFile("session-1.json")).toBe(true);
		expect(isPurgeableLogFile("current.json.bak")).toBe(false);
		expect(isPurgeableLogFile("../secrets.json")).toBe(false);
	});
});
