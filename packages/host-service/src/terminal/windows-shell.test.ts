import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolveLaunchShell } from "./shell-launch.ts";
import {
	buildCmdFallbackLaunch,
	resolveWindowsShell,
	ShellUnresolvedError,
	type WindowsShellFs,
} from "./windows-shell.ts";

const LOCAL = "C:\\Users\\me\\AppData\\Local";
const USER_APPS = `${LOCAL}\\Microsoft\\WindowsApps`;
const ROOT_ALIAS = `${USER_APPS}\\pwsh.exe`;
const ALIAS_TARGET =
	"C:\\Program Files\\WindowsApps\\Microsoft.PowerShell_7.6.6.0_arm64__8wekyb3d8bbwe\\pwsh.exe";
const INSTALL_7 = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
const COMSPEC = "C:\\Windows\\system32\\cmd.exe";

const BASE_ENV: Record<string, string> = {
	Path: `C:\\Windows\\system32;${USER_APPS}`,
	ProgramFiles: "C:\\Program Files",
	LOCALAPPDATA: LOCAL,
	ComSpec: COMSPEC,
};

interface FakeEntry {
	stat?: "file" | "dir" | string;
	lstat?: "symlink" | "file" | string;
	readlink?: string;
}

function errno(code: string): NodeJS.ErrnoException {
	const error = new Error(code) as NodeJS.ErrnoException;
	error.code = code;
	return error;
}

function fakeFs(entries: Record<string, FakeEntry>) {
	const byPath = new Map(
		Object.entries(entries).map(([p, entry]) => [p.toLowerCase(), entry]),
	);
	const statCalls: string[] = [];
	const fs: WindowsShellFs = {
		stat: async (p) => {
			statCalls.push(p);
			const entry = byPath.get(p.toLowerCase());
			if (!entry?.stat) throw errno("ENOENT");
			if (entry.stat === "file") return { isFile: () => true };
			if (entry.stat === "dir") return { isFile: () => false };
			throw errno(entry.stat);
		},
		lstat: async (p) => {
			const entry = byPath.get(p.toLowerCase());
			if (!entry?.lstat) throw errno("ENOENT");
			if (entry.lstat === "symlink") return { isSymbolicLink: () => true };
			if (entry.lstat === "file") return { isSymbolicLink: () => false };
			throw errno(entry.lstat);
		},
		readlink: async (p) => {
			const entry = byPath.get(p.toLowerCase());
			if (!entry?.readlink) throw errno("EINVAL");
			return entry.readlink;
		},
	};
	return { fs, statCalls };
}

const rootAlias: Record<string, FakeEntry> = {
	[ROOT_ALIAS]: { stat: "EACCES", lstat: "symlink", readlink: ALIAS_TARGET },
	[ALIAS_TARGET]: { lstat: "file" },
};

describe("resolveWindowsShell", () => {
	test("the root Store alias on PATH is found by its alias path", async () => {
		const { fs } = fakeFs(rootAlias);
		expect(await resolveWindowsShell(BASE_ENV, undefined, fs)).toEqual({
			kind: "found",
			shell: ROOT_ALIAS,
			source: "path",
		});
	});

	test("an alias whose target is gone is refused, not absent", async () => {
		const { fs } = fakeFs({
			[ROOT_ALIAS]: {
				stat: "EACCES",
				lstat: "symlink",
				readlink: ALIAS_TARGET,
			},
		});
		expect(await resolveWindowsShell(BASE_ENV, undefined, fs)).toMatchObject({
			kind: "refused",
			code: "shell-unresolved",
		});
	});

	test("an unclear install check does not stop a later alias from being found", async () => {
		const { fs } = fakeFs({ ...rootAlias, [INSTALL_7]: { stat: "UNKNOWN" } });
		expect(await resolveWindowsShell(BASE_ENV, undefined, fs)).toMatchObject({
			kind: "found",
			shell: ROOT_ALIAS,
		});
	});

	test("EACCES on a symlink outside WindowsApps is refused, never COMSPEC", async () => {
		const { fs } = fakeFs({
			"C:\\tools\\pwsh.exe": {
				stat: "EACCES",
				lstat: "symlink",
				readlink: "C:\\elsewhere\\pwsh.exe",
			},
			"C:\\elsewhere\\pwsh.exe": { lstat: "file" },
		});
		const result = await resolveWindowsShell(
			{ ...BASE_ENV, Path: "C:\\tools" },
			undefined,
			fs,
		);
		expect(result.kind).toBe("refused");
	});

	test("PATH entries off the Program Files drive, UNC or relative are skipped unchecked", async () => {
		const { fs, statCalls } = fakeFs({});
		const result = await resolveWindowsShell(
			{
				...BASE_ENV,
				Path: 'H:\\tools;\\\\srv\\x; "relative\\bin" ;C:\\Windows\\system32;C:\\WINDOWS\\System32',
			},
			undefined,
			fs,
		);
		const lowered = statCalls.map((p) => p.toLowerCase());
		expect(lowered.some((p) => p.startsWith("h:"))).toBe(false);
		expect(lowered.some((p) => p.startsWith("\\\\srv"))).toBe(false);
		expect(lowered.some((p) => p.startsWith("relative"))).toBe(false);
		expect(result).toEqual({
			kind: "absent",
			shell: COMSPEC,
			checked: [
				INSTALL_7,
				"C:\\Program Files\\PowerShell\\7-preview\\pwsh.exe",
				"C:\\Windows\\system32\\pwsh.exe",
				`${USER_APPS}\\Microsoft.PowerShell_8wekyb3d8bbwe\\pwsh.exe`,
				`${USER_APPS}\\Microsoft.PowerShellPreview_8wekyb3d8bbwe\\pwsh.exe`,
			],
			skipped: ["H:\\tools", "\\\\srv\\x", "relative\\bin"],
		});
	});

	test("an override that is a full path to the alias is found", async () => {
		const { fs } = fakeFs(rootAlias);
		expect(await resolveWindowsShell(BASE_ENV, ROOT_ALIAS, fs)).toEqual({
			kind: "found",
			shell: ROOT_ALIAS,
			source: "override",
		});
	});

	test("an override to cmd.exe is found", async () => {
		const { fs } = fakeFs({ [COMSPEC]: { stat: "file" } });
		expect(await resolveWindowsShell(BASE_ENV, COMSPEC, fs)).toEqual({
			kind: "found",
			shell: COMSPEC,
			source: "override",
		});
	});

	for (const override of ["pwsh", "C:pwsh.exe", "\\x"]) {
		test(`an override of ${override} is refused as not a full path`, async () => {
			const { fs, statCalls } = fakeFs(rootAlias);
			const result = await resolveWindowsShell(BASE_ENV, override, fs);
			expect(result).toMatchObject({ kind: "refused" });
			expect(result.kind === "refused" && result.message).toContain(
				"must be a full path",
			);
			expect(statCalls).toEqual([]);
		});
	}

	test("an override to a missing file is refused", async () => {
		const { fs } = fakeFs(rootAlias);
		const result = await resolveWindowsShell(
			BASE_ENV,
			"C:\\missing\\pwsh.exe",
			fs,
		);
		expect(result.kind === "refused" && result.message).toContain(
			"points to a missing file",
		);
	});

	for (const name of ["Path", "ProgramFiles", "LOCALAPPDATA"]) {
		test(`a missing ${name} is refused`, async () => {
			const { fs } = fakeFs(rootAlias);
			const env = { ...BASE_ENV };
			delete env[name];
			expect(await resolveWindowsShell(env, undefined, fs)).toMatchObject({
				kind: "refused",
			});
		});
	}

	test("a missing COMSPEC is refused when PowerShell 7 is absent", async () => {
		const { fs } = fakeFs({});
		const env = { ...BASE_ENV };
		delete env.ComSpec;
		expect(await resolveWindowsShell(env, undefined, fs)).toMatchObject({
			kind: "refused",
		});
	});
});

describe("resolveLaunchShell", () => {
	test("throws ShellUnresolvedError on win32", () => {
		expect(() =>
			resolveLaunchShell(BASE_ENV, { platform: "win32", accountShell: null }),
		).toThrow(ShellUnresolvedError);
	});

	test("is unchanged on darwin", () => {
		expect(
			resolveLaunchShell(
				{ SHELL: "/usr/local/bin/fish" },
				{ platform: "darwin", accountShell: null },
			),
		).toBe("/usr/local/bin/fish");
	});
});

describe("buildCmdFallbackLaunch", () => {
	test("cmd.exe echoes a dim notice, then clears its variable", () => {
		const launch = buildCmdFallbackLaunch([
			"D:\\a & b",
			"C:\\Program Files (x86)\\x",
		]);
		expect(launch.argv).toEqual([
			"/K",
			"echo(%SUPERSET_SHELL_FALLBACK_NOTICE%&set SUPERSET_SHELL_FALLBACK_NOTICE=",
		]);
		expect(launch.env.SUPERSET_SHELL_FALLBACK_NOTICE).toBe(
			"\x1b[90mPowerShell 7 not found, using cmd.exe. Skipped PATH entries: D:\\a ? b; C:\\Program Files (x86)\\x. Install PowerShell 7, or set SUPERSET_TERMINAL_SHELL and restart the app.\x1b[0m",
		);
	});

	test("hostile PATH entries reach cmd.exe only as allow-listed text under the length cap", () => {
		const hostile = [
			"H:\\!X!",
			"H:\\%X%",
			"H:\\a\r\nset X=1",
			"H:\\c^d & calc",
			`H:\\${"x".repeat(5000)}`,
		];
		const skipped = [
			...hostile,
			...Array.from({ length: 20 - hostile.length }, (_, i) => `H:\\e${i}`),
		];

		const notice = buildCmdFallbackLaunch(skipped).env
			.SUPERSET_SHELL_FALLBACK_NOTICE as string;

		expect(notice.length).toBeLessThanOrEqual(1000);
		expect(notice.startsWith("\x1b[90m")).toBe(true);
		expect(notice.endsWith("\x1b[0m")).toBe(true);
		const body = notice.slice("\x1b[90m".length, -"\x1b[0m".length);
		expect(body).toMatch(/^[A-Za-z0-9 :\\/._()\-?,;]+$/);
		expect(body).toContain(
			`Skipped PATH entries: H:\\?X?; H:\\?X?; H:\\a??set X?1; H:\\c?d ? calc; H:\\${"x".repeat(114)}... and 15 more.`,
		);
	});

	test.skipIf(process.platform !== "win32")(
		"real cmd.exe prints the notice without expanding PATH, then clears its variable",
		() => {
			const comspec = process.env.ComSpec;
			if (!comspec) throw new Error("ComSpec is not set");
			const launch = buildCmdFallbackLaunch([
				"H:\\!PATH!",
				"H:\\%PATH%",
				"H:\\a\r\necho %PATH%",
				"H:\\c^ & set PATH",
				"H:\\d))(",
				...Array.from({ length: 20 }, (_, i) => `H:\\${"x".repeat(300)}${i}`),
			]);

			const result = spawnSync(
				comspec,
				[
					"/D",
					"/V:ON",
					"/C",
					`"${launch.argv[1]}&set SUPERSET_SHELL_FALLBACK_NOTICE"`,
				],
				{
					env: { PATH: "C:\\superset-path-sentinel", ...launch.env },
					encoding: "utf8",
					windowsVerbatimArguments: true,
				},
			);

			expect(result.stdout).toBe(
				`${launch.env.SUPERSET_SHELL_FALLBACK_NOTICE}\r\n`,
			);
			expect(`${result.stdout}${result.stderr}`).not.toContain(
				"superset-path-sentinel",
			);
			expect(result.stderr).toContain(
				"Environment variable SUPERSET_SHELL_FALLBACK_NOTICE not defined",
			);
		},
	);
});
