/**
 * (WIN-USER-ENV) fork-only: read the Windows USER environment from
 * `HKCU\Environment` and merge it UNDER a process env.
 *
 * WHY THIS EXISTS
 * ---------------
 * Everything Superset gates on an environment variable — `(COMPANION-BRIDGE)`'s
 * `SUPERSET_COMPANION_BRIDGE=1`, `WS_NO_BUFFER_UTIL`, proxy/CA settings, agent
 * tokens — reads it from `process.env`, i.e. from whatever env block this
 * process's PARENT happened to hold. On Windows that parent is frequently not
 * a shell the user configured: the NSIS installer relaunches the app, Explorer
 * relaunches from a pinned shortcut, an updater respawns it. A parent started
 * before the variable was set (or under a different broadcast of
 * `WM_SETTINGCHANGE`) hands down an env block that simply does not contain it,
 * and the feature is silently OFF while the registry says ON.
 *
 * That is not hypothetical: an installer-driven relaunch dropped
 * `SUPERSET_COMPANION_BRIDGE=1` — correct in `HKCU\Environment` the entire time
 * — the bridge never started, and the phone reported "Superset isn't running".
 *
 * The POSIX answer to this is the login-shell snapshot
 * (`packages/host-service/src/terminal/clean-shell-env.ts`), which re-derives
 * the user's env by running their login shell. Windows has no equivalent:
 * `cmd.exe` has no rc files, and that probe cannot even run there (see the
 * `(WIN-USER-ENV)` branch in that file). `HKCU\Environment` IS the Windows
 * equivalent — it is the authoritative record of the user environment that
 * `setx`, the System Properties dialog and every installer write to, and it is
 * readable without a shell, without native modules, and without depending on
 * the parent env we are trying to stop depending on.
 *
 * WHY NOT `reg query` — THIS WAS TRIED AND IT IS UNSALVAGEABLE
 * -----------------------------------------------------------
 * The first version of this module parsed `reg.exe query` console text. Three
 * defects, all reproduced on a real machine, none fixable by parsing harder:
 *
 *  1. ENCODING. reg.exe transcodes to the console OEM codepage with best-fit
 *     substitution BEFORE the bytes reach the pipe, so the loss happens inside
 *     reg.exe (WideCharToMultiByte) and no decoding choice on our side can undo
 *     it. Measured: `™` arrived as ASCII `T`, U+00A9 as ASCII `c`. A user
 *     called José gets a silently corrupted JAVA_HOME merged into every child
 *     process env.
 *  2. MULTILINE INJECTION. A REG_SZ value containing newlines prints raw across
 *     lines, and the output is byte-identical for "one two-line value" and "two
 *     separate values". A pasted PEM or JSON blob whose second line reads
 *     `    NODE_OPTIONS    REG_SZ    --require C:\evil.js` therefore parses as a
 *     REAL `NODE_OPTIONS` entry and is merged into the Electron main env and
 *     spread to the host-service child. That is arbitrary code execution from a
 *     value the user only ever pasted.
 *  3. AMBIGUOUS FIELD SEPARATOR. Fields are separated by four spaces, and a
 *     VALUE may contain four spaces (`SAFE    REG_SZ    DECOY`), so the name
 *     and value a regex recovers can both be wrong.
 *
 * So the reader below asks PowerShell for structured JSON instead. Verified on
 * a real hive: `C:\Users\José\Acme™©—日本` round-trips byte-exact, a multiline
 * value stays ONE value with no injected key, and a name is returned exactly as
 * stored.
 *
 * WHY THE KEY IS READ DIRECTLY AND NOT VIA `GetEnvironmentVariables('User')`
 * -------------------------------------------------------------------------
 * That API looks like the obvious call and is wrong twice, both measured:
 *  - it stringifies every value, so a REG_MULTI_SZ arrives as the literal
 *    `"System.String[]"` and a REG_DWORD as `"7"` — garbage that would be
 *    merged into real child environments;
 *  - it pre-expands REG_EXPAND_SZ, which erases the REG_SZ/REG_EXPAND_SZ
 *    distinction. A REG_SZ whose value legitimately contains `pa%TEMP%ss`
 *    (a password, say) would then be indistinguishable from a value Windows is
 *    supposed to expand, and we would expand it. Windows does not.
 * Reading the key and filtering on `GetValueKind` skips non-string types
 * cleanly and keeps the two kinds apart: REG_SZ verbatim, REG_EXPAND_SZ raw
 * (via `DoNotExpandEnvironmentNames`) for `mergeWindowsUserEnv` to expand.
 *
 * MERGE DIRECTION IS UNDER, NEVER OVER
 * ------------------------------------
 * `process.env` always wins. A launcher, unit file, coordinator or test that
 * deliberately set a value must keep it; the registry only fills keys this
 * process does not already have. So this can add `SUPERSET_COMPANION_BRIDGE`
 * to a process that lacked it, and can never change one that has it.
 *
 * NEVER LOG VALUES. `HKCU\Environment` is where users keep API keys. This
 * module logs variable NAMES and counts only, and a test pins that.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Set by the Electron main process in its OWN env once its merge succeeded, so
 * the host-service children it spawns — which inherit that env — skip a read
 * whose answer they already have. Never set on failure, so the child's own read
 * stays a genuine retry. The `SUPERSET_` rule in terminal/env-strip.ts keeps it
 * out of PTYs.
 */
export const WIN_USER_ENV_MERGED_BY_PARENT = "SUPERSET_WIN_USER_ENV_MERGED";

/** The Windows per-user environment key. Not redirected for WOW64. */
export const WINDOWS_USER_ENV_KEY = "HKCU\\Environment";

const LOG_PREFIX = "[win-user-env]";

/**
 * Bounds a wedged PowerShell, nothing more — a warm read is milliseconds.
 * Generous because a COLD PowerShell start behind on-access AV scanning can
 * take seconds on a machine that is otherwise fine, and a spurious timeout
 * here costs the whole user environment for that boot.
 */
const READ_TIMEOUT_MS = 15_000;

/** A user `Path` alone routinely runs to several KB. */
const READ_MAX_BUFFER = 4 * 1024 * 1024;

const POWERSHELL_SUBPATH = "System32\\WindowsPowerShell\\v1.0\\powershell.exe";

/**
 * Emits `{"s":{name:value},"e":{name:rawValue}}` — `s` is REG_SZ (verbatim),
 * `e` is REG_EXPAND_SZ with `%VAR%` references left RAW. Every other value kind
 * is skipped, exactly as Windows skips it when building an environment block.
 *
 * Deliberately contains NO double-quote character, so passing it as a single
 * `execFile` argument needs no escaping on Windows' quoting rules.
 *
 * THE TWO `exit 1` GUARDS ARE LOAD-BEARING, not defensive noise. Without them
 * this script reports a legitimately-empty user environment on a machine where
 * it in fact could not read one:
 *
 *  - Constrained Language Mode (an enterprise WDAC/AppLocker lockdown) forbids
 *    the `[Microsoft.Win32.Registry]` type access. That statement fails, the
 *    remaining `;`-joined statements keep running, `$k` stays null, and
 *    `ConvertTo-Json` cheerfully emits `{}` with exit code 0. The merge would
 *    then be a silent no-op — the exact fail-quiet this module exists to
 *    delete.
 *  - A null `$k` for any other reason is equally untrustworthy: the key exists
 *    on every real user hive, so failing to open it means something is wrong,
 *    not that the user has no variables.
 *
 * Exit 1 makes `execFile` reject, which routes to the loud `ok:false` path.
 */
export const READ_USER_ENV_SCRIPT = [
	"if($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage'){exit 1}",
	"[Console]::OutputEncoding=[System.Text.Encoding]::UTF8",
	"$k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')",
	"if($null -eq $k){exit 1}",
	"$s=@{}",
	"$e=@{}",
	"foreach($n in $k.GetValueNames()){$t=$k.GetValueKind($n);if($t -eq 'String'){$s[$n]=[string]$k.GetValue($n)}elseif($t -eq 'ExpandString'){$e[$n]=[string]$k.GetValue($n,'',[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)}}",
	"@{s=$s;e=$e}|ConvertTo-Json -Compress -Depth 3",
].join(";");

/** `%VAR%` reference inside a REG_EXPAND_SZ value. */
const ENV_REF_RE = /%([^%]+)%/g;

export interface WindowsUserEnv {
	/** REG_SZ values. Verbatim — a `%` in one of these is literal. */
	plain: Record<string, string>;
	/** REG_EXPAND_SZ values, still carrying unexpanded `%VAR%` references. */
	expandable: Record<string, string>;
}

function readStringMap(
	source: unknown,
	section: string,
): Record<string, string> {
	if (source === null || source === undefined) return {};
	if (typeof source !== "object" || Array.isArray(source)) {
		throw new Error(
			`${LOG_PREFIX} malformed reader output — '${section}' is not an object`,
		);
	}

	const out: Record<string, string> = {};
	for (const [name, value] of Object.entries(
		source as Record<string, unknown>,
	)) {
		// Names are taken EXACTLY as the registry stores them. Trimming here
		// would let a registry entry literally named " SUPERSET_COMPANION_BRIDGE"
		// (leading space — a different variable, which the registry permits and
		// Windows never puts in an env block under the trimmed name) become the
		// real opt-in and start an internet-reachable listener.
		if (!name) continue;
		if (typeof value !== "string") continue;
		// An empty value is how Windows represents "not set"; it never reaches a
		// process env block.
		if (!value) continue;
		out[name] = value;
	}
	return out;
}

/**
 * Parse the reader's JSON. Throws on anything unexpected — a reader that
 * answered something we do not understand must not be read as "the user has no
 * environment", which is the silent degradation this module exists to remove.
 */
export function parseUserEnvJson(stdout: string): WindowsUserEnv {
	const trimmed = stdout.trim();
	if (!trimmed) {
		throw new Error(`${LOG_PREFIX} reader produced no output`);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`${LOG_PREFIX} reader output is not valid JSON: ${message}`,
		);
	}

	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(
			`${LOG_PREFIX} malformed reader output — expected a JSON object`,
		);
	}

	const shape = parsed as { s?: unknown; e?: unknown };
	return {
		plain: readStringMap(shape.s, "s"),
		expandable: readStringMap(shape.e, "e"),
	};
}

/**
 * Expand `%VAR%` references against `lookup`, single-pass, as Windows expands a
 * REG_EXPAND_SZ value: an unresolvable reference is left literal rather than
 * blanked, and an expansion's own `%VAR%` is not re-expanded.
 */
export function expandWindowsEnvRefs(
	value: string,
	lookup: (name: string) => string | undefined,
): string {
	return value.replace(ENV_REF_RE, (whole, name: string) => {
		const resolved = lookup(name);
		return typeof resolved === "string" ? resolved : whole;
	});
}

/** Windows env names are case-insensitive: `Path` and `PATH` are one variable. */
function buildCaseInsensitiveIndex(
	env: NodeJS.ProcessEnv,
): Map<string, string> {
	const index = new Map<string, string>();
	for (const [key, value] of Object.entries(env)) {
		if (typeof value === "string") index.set(key.toUpperCase(), value);
	}
	return index;
}

/**
 * Merge the user environment UNDER `target`. Returns the names actually
 * applied, for logging. `target` is mutated.
 */
export function mergeWindowsUserEnv(
	target: NodeJS.ProcessEnv,
	userEnv: WindowsUserEnv,
): string[] {
	const index = buildCaseInsensitiveIndex(target);
	const applied: string[] = [];
	const needExpansion: string[] = [];

	const applyOne = (name: string, value: string, expandable: boolean): void => {
		// process.env wins, case-insensitively.
		if (index.has(name.toUpperCase())) return;
		target[name] = value;
		// Visible to later entries in this same pass, so two registry values
		// cannot both claim the same name under different casing.
		index.set(name.toUpperCase(), value);
		applied.push(name);
		if (expandable) needExpansion.push(name);
	};

	// REG_SZ first, so a plain value is already resolvable by name when the
	// expansion pass below runs — that is what makes `%ZBASE%` work regardless
	// of the order the two arrived in.
	for (const [name, value] of Object.entries(userEnv.plain)) {
		applyOne(name, value, false);
	}
	for (const [name, value] of Object.entries(userEnv.expandable)) {
		applyOne(name, value, true);
	}

	// Second pass, over REG_EXPAND_SZ values ONLY. It has to be a second pass:
	// PowerShell expands against the reader child's env, which is inherited
	// from ours, so a `%ZBASE%` that exists only in this hive would come back
	// unresolved — and resolving it during pass one would depend on whether
	// ZBASE happened to be visited first. REG_SZ values are never touched here,
	// so a literal `pa%TEMP%ss` password stays exactly as the user stored it.
	for (const name of needExpansion) {
		const raw = target[name];
		if (typeof raw !== "string") continue;
		const expanded = expandWindowsEnvRefs(raw, (ref) =>
			index.get(ref.toUpperCase()),
		);
		if (expanded === raw) continue;
		target[name] = expanded;
		index.set(name.toUpperCase(), expanded);
	}

	return applied;
}

/** Injected in tests; production always shells out to PowerShell. */
export type UserEnvReader = () => Promise<string>;

/**
 * Absolute path to Windows PowerShell.
 *
 * Throws when `SystemRoot` is absent rather than falling back to a bare
 * `powershell.exe`. A bare name resolves through `PATH` and the current
 * directory, and this module's entire premise is that the inherited env — PATH
 * included — cannot be trusted; resolving our own reader through it could run
 * an attacker's `powershell.exe` from the process cwd. An env with no
 * SystemRoot is broken far beyond what this module can repair, so it fails
 * loud.
 */
function resolvePowerShellPath(): string {
	const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
	if (!systemRoot) {
		throw new Error(
			`${LOG_PREFIX} SystemRoot is not set — refusing to resolve powershell.exe through PATH`,
		);
	}
	return `${systemRoot}\\${POWERSHELL_SUBPATH}`;
}

const defaultUserEnvReader: UserEnvReader = async () => {
	const { stdout } = await execFileAsync(
		resolvePowerShellPath(),
		[
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-Command",
			READ_USER_ENV_SCRIPT,
		],
		{
			timeout: READ_TIMEOUT_MS,
			maxBuffer: READ_MAX_BUFFER,
			windowsHide: true,
			encoding: "utf8",
		},
	);
	return stdout;
};

async function readUncached(read: UserEnvReader): Promise<WindowsUserEnv> {
	let stdout: string;
	try {
		stdout = await read();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`${LOG_PREFIX} reading ${WINDOWS_USER_ENV_KEY} failed: ${message}`,
		);
	}
	return parseUserEnvJson(stdout);
}

/**
 * Memoized for the process lifetime: host-service boot merges into
 * `process.env` in `main()` and the terminal snapshot
 * (`resolveWindowsShellEnv`) asks again a moment later, and the desktop's call
 * sits on the first-window critical path. The hive does not change during a
 * boot, so a second spawn would be a guaranteed no-op costing another
 * subprocess. A FAILED read is not cached, so a later caller can retry.
 */
let cachedRead: Promise<WindowsUserEnv> | null = null;

export async function readWindowsUserEnv(
	read?: UserEnvReader,
): Promise<WindowsUserEnv> {
	// An injected reader is a test's reader; never cache it, and never let it
	// populate the cache the production path shares.
	if (read) return readUncached(read);

	if (!cachedRead) {
		cachedRead = readUncached(defaultUserEnvReader).catch((error) => {
			cachedRead = null;
			throw error;
		});
	}
	return cachedRead;
}

export function resetWindowsUserEnvCacheForTests(): void {
	cachedRead = null;
}

export interface ApplyWindowsUserEnvOptions {
	targetEnv?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	read?: UserEnvReader;
}

export type ApplyWindowsUserEnvResult =
	| { ok: true; applied: string[] }
	| { ok: false; error: string };

/**
 * Merge the Windows user environment into `targetEnv` (default `process.env`).
 * No-op off win32.
 *
 * A read failure is reported LOUDLY (`console.error`) and returned as
 * `ok: false` rather than thrown. This runs during process boot in the desktop
 * main process and in both host-service entries; a missing or wedged
 * PowerShell must not brick the app, but it must never be invisible either — an
 * invisible env-resolution failure is precisely the bug that took the companion
 * bridge down while every log line said the app was healthy.
 *
 * KNOWN SCOPE: callers invoke this inside `main()`, so variables consumed by
 * an IMPORT-TIME env schema (`packages/host-service/src/env.ts`) are already
 * read by then and are NOT covered. Those are all coordinator-supplied
 * (`PORT`, `ORGANIZATION_ID`, `HOST_DB_PATH`, …) and never come from the user
 * registry, so the gap is real but empty in practice.
 */
export async function applyWindowsUserEnvToProcess(
	options: ApplyWindowsUserEnvOptions = {},
): Promise<ApplyWindowsUserEnvResult> {
	const platform = options.platform ?? process.platform;
	if (platform !== "win32") return { ok: true, applied: [] };

	const targetEnv = options.targetEnv ?? process.env;

	try {
		const userEnv = await readWindowsUserEnv(options.read);
		const applied = mergeWindowsUserEnv(targetEnv, userEnv);
		if (applied.length > 0) {
			// Names only — never values. This key holds users' API keys, and
			// `logs no values` in the test suite pins that.
			console.log(
				`${LOG_PREFIX} merged ${applied.length} user environment variable(s) from ${WINDOWS_USER_ENV_KEY}: ${applied.join(", ")}`,
			);
		}
		return { ok: true, applied };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(
			`${LOG_PREFIX} FAILED to read the Windows user environment — env-gated features (companion bridge, proxies, agent tokens) will see only the env this process's parent handed it: ${message}`,
		);
		return { ok: false, error: message };
	}
}
