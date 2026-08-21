import { describe, expect, it } from "bun:test";
import {
	applyWindowsUserEnvToProcess,
	expandWindowsEnvRefs,
	mergeWindowsUserEnv,
	parseUserEnvJson,
	READ_USER_ENV_SCRIPT,
	readWindowsUserEnv,
	resetWindowsUserEnvCacheForTests,
	WINDOWS_USER_ENV_KEY,
	type WindowsUserEnv,
} from "./windows-user-env";

const isWindows = process.platform === "win32";

/**
 * The three payloads that defeated the previous `reg query` text parser, plus
 * the ambiguous-separator decoy. All four are now inert because the reader
 * returns structured JSON — these fixtures pin that.
 */
const UNICODE_VALUE =
	"C:\\Users\\Jos\u00e9\\Acme\u2122\u00a9\u2014\u65e5\u672c";
const MULTILINE_VALUE =
	"line-one\n    NODE_OPTIONS    REG_SZ    --require C:\\evil.js";
const DECOY_VALUE = "SAFE    REG_SZ    DECOY";
const SECRET_VALUE = "napi_thisisasecretapikeyvalue0000";

function readerOutput(userEnv: {
	s?: Record<string, unknown>;
	e?: Record<string, unknown>;
}): string {
	return JSON.stringify({ s: userEnv.s ?? {}, e: userEnv.e ?? {} });
}

const FULL_FIXTURE = readerOutput({
	s: {
		SUPERSET_COMPANION_BRIDGE: "1",
		WINENV_UNICODE: UNICODE_VALUE,
		WINENV_MULTILINE: MULTILINE_VALUE,
		WINENV_DECOY: DECOY_VALUE,
		WINENV_LITERAL_PCT: "pa%TEMP%ss",
		WINENV_ZBASE: "C:\\zbase",
		" SUPERSET_COMPANION_BRIDGE": "1",
		WINENV_EMPTY: "",
		WINENV_NUMBER: 7,
		WINENV_ARRAY: ["a", "b"],
		Path: "C:\\registry\\path",
	},
	e: {
		WINENV_EXPANDED: "%WINENV_ZBASE%\\sub",
		WINENV_UNRESOLVABLE: "%WINENV_NOT_A_VAR%\\x",
	},
});

function parseFixture(): WindowsUserEnv {
	return parseUserEnvJson(FULL_FIXTURE);
}

/** Capture console output for the duration of `run`. */
async function captureConsole(
	channel: "log" | "error",
	run: () => Promise<void>,
): Promise<string[]> {
	const original = console[channel];
	const lines: string[] = [];
	console[channel] = (...args: unknown[]) => {
		lines.push(args.map(String).join(" "));
	};
	try {
		await run();
	} finally {
		console[channel] = original;
	}
	return lines;
}

describe("parseUserEnvJson", () => {
	it("splits REG_SZ from REG_EXPAND_SZ", () => {
		const parsed = parseFixture();

		expect(parsed.plain.SUPERSET_COMPANION_BRIDGE).toBe("1");
		expect(parsed.expandable.WINENV_EXPANDED).toBe("%WINENV_ZBASE%\\sub");
		expect(parsed.plain.WINENV_EXPANDED).toBeUndefined();
	});

	it("round-trips non-ASCII exactly", () => {
		expect(parseFixture().plain.WINENV_UNICODE).toBe(UNICODE_VALUE);
	});

	it("keeps a multiline value whole and injects no key from its second line", () => {
		const parsed = parseFixture();

		expect(parsed.plain.WINENV_MULTILINE).toBe(MULTILINE_VALUE);
		expect(parsed.plain.NODE_OPTIONS).toBeUndefined();
		expect(parsed.expandable.NODE_OPTIONS).toBeUndefined();
	});

	it("keeps a value that looks like a name/type/value row intact", () => {
		const parsed = parseFixture();

		expect(parsed.plain.WINENV_DECOY).toBe(DECOY_VALUE);
		expect(parsed.plain.SAFE).toBeUndefined();
	});

	it("preserves names byte-for-byte, so a leading space stays a different variable", () => {
		const parsed = parseFixture();

		expect(parsed.plain[" SUPERSET_COMPANION_BRIDGE"]).toBe("1");
		expect(Object.keys(parsed.plain)).toContain(" SUPERSET_COMPANION_BRIDGE");
	});

	it("skips non-string values and empty values", () => {
		const names = Object.keys(parseFixture().plain);

		expect(names).not.toContain("WINENV_NUMBER");
		expect(names).not.toContain("WINENV_ARRAY");
		expect(names).not.toContain("WINENV_EMPTY");
	});

	it("accepts an empty hive", () => {
		expect(parseUserEnvJson('{"s":{},"e":{}}')).toEqual({
			plain: {},
			expandable: {},
		});
	});

	it("accepts a single entry, which the reader still emits as an object", () => {
		expect(parseUserEnvJson('{"s":{"ONE":"1"},"e":{}}').plain).toEqual({
			ONE: "1",
		});
	});

	it("throws on empty output rather than reading it as an empty environment", () => {
		expect(() => parseUserEnvJson("   ")).toThrow("produced no output");
	});

	it("throws on non-JSON output", () => {
		expect(() => parseUserEnvJson("powershell is not recognized")).toThrow(
			"not valid JSON",
		);
	});

	it("throws when the top level is not an object", () => {
		expect(() => parseUserEnvJson("[1,2]")).toThrow("expected a JSON object");
	});

	it("throws when a section is the wrong shape", () => {
		expect(() => parseUserEnvJson('{"s":["a"],"e":{}}')).toThrow(
			"'s' is not an object",
		);
	});
});

/**
 * The reader script's two `exit 1` guards are the difference between "this
 * machine has no user environment" and "this machine would not let me look".
 * Under Constrained Language Mode the `[Microsoft.Win32.Registry]` access fails
 * but the `;`-joined statements keep going, so without the guard the script
 * emits `{}` and exits 0 and the merge becomes a silent no-op. Verified against
 * a real ConstrainedLanguage session: exit 1, no stdout.
 */
describe("READ_USER_ENV_SCRIPT", () => {
	it("refuses to run outside FullLanguage", () => {
		expect(READ_USER_ENV_SCRIPT).toContain(
			"if($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage'){exit 1}",
		);
	});

	it("refuses to report an empty hive when the key could not be opened", () => {
		expect(READ_USER_ENV_SCRIPT).toContain("if($null -eq $k){exit 1}");
	});

	it("contains no double quote, so it needs no Windows arg escaping", () => {
		expect(READ_USER_ENV_SCRIPT).not.toContain('"');
	});
});

describe("expandWindowsEnvRefs", () => {
	it("expands a known reference", () => {
		expect(
			expandWindowsEnvRefs("%USERPROFILE%\\AppData", (n) =>
				n === "USERPROFILE" ? "C:\\Users\\khair" : undefined,
			),
		).toBe("C:\\Users\\khair\\AppData");
	});

	it("leaves an unresolvable reference literal instead of blanking it", () => {
		expect(expandWindowsEnvRefs("%NOPE%\\x", () => undefined)).toBe(
			"%NOPE%\\x",
		);
	});

	it("does not re-expand what an expansion produced", () => {
		expect(
			expandWindowsEnvRefs("%A%", (n) => (n === "A" ? "%B%" : "unreachable")),
		).toBe("%B%");
	});
});

describe("mergeWindowsUserEnv", () => {
	it("fills a variable the process env is missing", () => {
		const target: NodeJS.ProcessEnv = { PATH: "C:\\Windows" };
		const applied = mergeWindowsUserEnv(target, parseFixture());

		expect(target.SUPERSET_COMPANION_BRIDGE).toBe("1");
		expect(applied).toContain("SUPERSET_COMPANION_BRIDGE");
	});

	it("never overwrites a value the process env already has", () => {
		const target: NodeJS.ProcessEnv = { SUPERSET_COMPANION_BRIDGE: "0" };
		const applied = mergeWindowsUserEnv(target, parseFixture());

		expect(target.SUPERSET_COMPANION_BRIDGE).toBe("0");
		expect(applied).not.toContain("SUPERSET_COMPANION_BRIDGE");
	});

	it("treats env names case-insensitively, as Windows does", () => {
		const target: NodeJS.ProcessEnv = { PATH: "C:\\Windows" };
		mergeWindowsUserEnv(target, parseFixture());

		expect(target.Path).toBeUndefined();
		expect(target.PATH).toBe("C:\\Windows");
	});

	it("expands a REG_EXPAND_SZ against a REG_SZ from the same hive", () => {
		const target: NodeJS.ProcessEnv = {};
		mergeWindowsUserEnv(target, parseFixture());

		expect(target.WINENV_EXPANDED).toBe("C:\\zbase\\sub");
	});

	it("expands a same-hive reference regardless of the order the two arrive in", () => {
		// The reader's key order is whatever the registry hands back; the base
		// value must resolve even when it is enumerated last.
		const reversed = readerOutput({
			s: { ZZ_BASE: "C:\\base" },
			e: { AA_DERIVED: "%ZZ_BASE%\\sub" },
		});
		const target: NodeJS.ProcessEnv = {};
		mergeWindowsUserEnv(target, parseUserEnvJson(reversed));

		expect(target.AA_DERIVED).toBe("C:\\base\\sub");
	});

	it("leaves an unresolvable reference literal", () => {
		const target: NodeJS.ProcessEnv = {};
		mergeWindowsUserEnv(target, parseFixture());

		expect(target.WINENV_UNRESOLVABLE).toBe("%WINENV_NOT_A_VAR%\\x");
	});

	it("never expands a REG_SZ value, so a literal %% stays literal", () => {
		const target: NodeJS.ProcessEnv = { TEMP: "C:\\Temp" };
		mergeWindowsUserEnv(target, parseFixture());

		expect(target.WINENV_LITERAL_PCT).toBe("pa%TEMP%ss");
	});

	it("carries a multiline value across without splitting it", () => {
		const target: NodeJS.ProcessEnv = {};
		mergeWindowsUserEnv(target, parseFixture());

		expect(target.WINENV_MULTILINE).toBe(MULTILINE_VALUE);
		expect(target.NODE_OPTIONS).toBeUndefined();
	});
});

describe("readWindowsUserEnv", () => {
	it("wraps a reader failure with the key it was reading", async () => {
		await expect(
			readWindowsUserEnv(async () => {
				throw new Error("spawn powershell.exe ENOENT");
			}),
		).rejects.toThrow(`reading ${WINDOWS_USER_ENV_KEY} failed`);
	});

	it("does not cache an injected reader into the production path", async () => {
		let calls = 0;
		const read = async () => {
			calls++;
			return FULL_FIXTURE;
		};

		await readWindowsUserEnv(read);
		await readWindowsUserEnv(read);

		expect(calls).toBe(2);
	});
});

describe("applyWindowsUserEnvToProcess", () => {
	it("is a no-op off win32 and never spawns a reader", async () => {
		let ran = false;
		const target: NodeJS.ProcessEnv = {};
		const result = await applyWindowsUserEnvToProcess({
			targetEnv: target,
			platform: "darwin",
			read: async () => {
				ran = true;
				return FULL_FIXTURE;
			},
		});

		expect(ran).toBe(false);
		expect(result).toEqual({ ok: true, applied: [] });
		expect(target).toEqual({});
	});

	it("reports a read failure loudly on console.error instead of throwing", async () => {
		let result: Awaited<
			ReturnType<typeof applyWindowsUserEnvToProcess>
		> | null = null;
		const errors = await captureConsole("error", async () => {
			result = await applyWindowsUserEnvToProcess({
				targetEnv: {},
				platform: "win32",
				read: async () => {
					throw new Error("ENOENT");
				},
			});
		});

		expect(result).toMatchObject({ ok: false });
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("FAILED to read the Windows user environment");
	});

	it("refuses to resolve powershell through PATH when SystemRoot is unset", async () => {
		const saved = {
			SystemRoot: process.env.SystemRoot,
			SYSTEMROOT: process.env.SYSTEMROOT,
		};
		resetWindowsUserEnvCacheForTests();
		delete process.env.SystemRoot;
		delete process.env.SYSTEMROOT;

		try {
			const result = await applyWindowsUserEnvToProcess({
				targetEnv: {},
				platform: "win32",
			});

			expect(result.ok).toBe(false);
			expect(result.ok === false && result.error).toContain("SystemRoot");
		} finally {
			if (saved.SystemRoot !== undefined)
				process.env.SystemRoot = saved.SystemRoot;
			if (saved.SYSTEMROOT !== undefined)
				process.env.SYSTEMROOT = saved.SYSTEMROOT;
			resetWindowsUserEnvCacheForTests();
		}
	});

	/**
	 * TRIPWIRE. `HKCU\Environment` is where users keep API keys, so the log line
	 * must name variables and never quote them. A comment cannot enforce that;
	 * this can.
	 */
	it("logs variable names and never a single variable VALUE", async () => {
		const target: NodeJS.ProcessEnv = {};
		const logs = await captureConsole("log", async () => {
			await applyWindowsUserEnvToProcess({
				targetEnv: target,
				platform: "win32",
				read: async () =>
					readerOutput({
						s: { NEON_API_KEY: SECRET_VALUE, WINENV_ZBASE: "C:\\zbase" },
						e: { WINENV_EXPANDED: "%WINENV_ZBASE%\\sub" },
					}),
			});
		});

		const logged = logs.join("\n");
		expect(logged).toContain("NEON_API_KEY");
		for (const value of [SECRET_VALUE, "C:\\zbase", "C:\\zbase\\sub"]) {
			expect(logged).not.toContain(value);
		}
		// The values did reach the env — it is only the log that omits them.
		expect(target.NEON_API_KEY).toBe(SECRET_VALUE);
	});

	it("fills a flag the parent env lacked, from the registry", async () => {
		const parentEnv: NodeJS.ProcessEnv = {
			PATH: "C:\\Windows",
			SystemRoot: "C:\\Windows",
		};

		const result = await applyWindowsUserEnvToProcess({
			targetEnv: parentEnv,
			platform: "win32",
			read: async () => FULL_FIXTURE,
		});

		expect(result.ok).toBe(true);
		expect(parentEnv.SUPERSET_COMPANION_BRIDGE).toBe("1");
	});
});

/**
 * Exercises the REAL PowerShell reader against the machine's own hive.
 *
 * Read-only on purpose. Proving the write half — that a `José™` or a multiline
 * value survives a registry round-trip — needs values written into
 * `HKCU\Environment`, and a unit suite must not mutate a developer's actual
 * user environment. That half was verified manually against this machine
 * (byte-exact UTF-8, no key injection, names untrimmed) before the reader
 * shipped; what remains worth automating is that the production path spawns,
 * parses and returns a sane structure.
 */
describe("(WIN-USER-ENV) live reader", () => {
	it.skipIf(!isWindows)("reads the real hive and parses it", async () => {
		resetWindowsUserEnvCacheForTests();
		try {
			const userEnv = await readWindowsUserEnv();

			const names = [
				...Object.keys(userEnv.plain),
				...Object.keys(userEnv.expandable),
			];
			expect(names.length).toBeGreaterThan(0);
			for (const value of [
				...Object.values(userEnv.plain),
				...Object.values(userEnv.expandable),
			]) {
				expect(typeof value).toBe("string");
				// A value mangled into the OEM codepage, or a JSON object leaking
				// through, would show up here.
				expect(value).not.toContain("\uFFFD");
				expect(value).not.toBe("System.String[]");
			}
		} finally {
			resetWindowsUserEnvCacheForTests();
		}
	});

	it.skipIf(!isWindows)("spawns the reader only once per process", async () => {
		resetWindowsUserEnvCacheForTests();
		try {
			const first = await readWindowsUserEnv();
			const second = await readWindowsUserEnv();

			// Same resolved object identity — the second call never spawned.
			expect(second).toBe(first);
		} finally {
			resetWindowsUserEnvCacheForTests();
		}
	});
});
