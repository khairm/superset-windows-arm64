/**
 * Shell launch configuration for v2 terminals.
 *
 * Behavioral reference: apps/desktop/src/main/lib/agent-setup/shell-wrappers.ts
 *
 * Upstream patterns:
 * - VS Code: ZDOTDIR for zsh, --init-file for bash, --init-command for fish
 * - Kitty: KITTY_ORIG_ZDOTDIR for zsh, ENV for bash, XDG_DATA_DIRS for fish
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import path from "node:path";
import {
	type ResolveConfiguredShellOptions,
	resolveConfiguredShell,
} from "./user-shell.ts";

// Cached Windows shell path — resolved once per process lifetime.
let _cachedWindowsShell: string | null | undefined = undefined;

function getEnvCaseInsensitive(
	env: Record<string, string>,
	key: string,
): string | undefined {
	const upper = key.toUpperCase();
	for (const [k, v] of Object.entries(env)) {
		if (k.toUpperCase() === upper) return v;
	}
	return undefined;
}

function probePwshVersion(pwshPath: string): boolean {
	try {
		const result = execFileSync(
			pwshPath,
			["-NoLogo", "-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"],
			{ timeout: 3000, encoding: "utf8", windowsHide: true },
		);
		const major = Number.parseInt(result.trim(), 10);
		return Number.isInteger(major) && major >= 7;
	} catch {
		return false;
	}
}

function resolveWindowsShell(baseEnv: Record<string, string>): string {
	if (_cachedWindowsShell !== undefined) {
		return _cachedWindowsShell ?? (getEnvCaseInsensitive(baseEnv, "COMSPEC") || "cmd.exe");
	}

	// Explicit override — honor any shell the user asked for (including powershell.exe).
	const override = process.env.SUPERSET_TERMINAL_SHELL;
	if (override && existsSync(override)) {
		_cachedWindowsShell = override;
		return override;
	}

	const programFiles = getEnvCaseInsensitive(baseEnv, "ProgramFiles") || process.env.ProgramFiles || "C:\\Program Files";
	const systemRoot = getEnvCaseInsensitive(baseEnv, "SystemRoot") || process.env.SystemRoot || "C:\\Windows";

	// Known real pwsh.exe install paths (prefer over PATH aliases).
	const directCandidates: string[] = [
		path.join(programFiles, "PowerShell", "7", "pwsh.exe"),
		path.join(programFiles, "PowerShell", "7-preview", "pwsh.exe"),
	];

	// Windows Store (WindowsApps) installs.
	const windowsAppsDir = path.join(programFiles, "WindowsApps");
	try {
		const entries = readdirSync(windowsAppsDir).filter(
			(e) => e.startsWith("Microsoft.PowerShell_") && e.endsWith("8wekyb3d8bbwe"),
		);
		for (const entry of entries.sort().reverse()) {
			directCandidates.push(path.join(windowsAppsDir, entry, "pwsh.exe"));
		}
	} catch {
		// EPERM or missing — try via PowerShell probe below
		try {
			const result = execFileSync(
				path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
				[
					"-NoProfile",
					"-NonInteractive",
					"-Command",
					"Get-AppxPackage Microsoft.PowerShell | Sort-Object Version -Descending | ForEach-Object { Join-Path $_.InstallLocation 'pwsh.exe' } | Select-Object -First 1",
				],
				{ timeout: 5000, encoding: "utf8", windowsHide: true },
			);
			const candidate = result.trim();
			if (candidate) directCandidates.push(candidate);
		} catch {
			// PowerShell not available or failed
		}
	}

	// Search PATH for pwsh (only accept pwsh.exe, never powershell.exe).
	const pathEnv = getEnvCaseInsensitive(baseEnv, "PATH") || process.env.PATH || "";
	const pathExt = (getEnvCaseInsensitive(baseEnv, "PATHEXT") || ".COM;.EXE;.BAT").split(";");
	for (const dir of pathEnv.split(path.delimiter)) {
		if (!dir) continue;
		for (const ext of pathExt) {
			const candidate = path.join(dir, `pwsh${ext}`);
			if (existsSync(candidate)) {
				const base = path.basename(candidate).toLowerCase();
				// Skip app-execution-alias (LocalAppData\Microsoft\WindowsApps\pwsh.exe) — last resort.
				const localAppData = process.env.LOCALAPPDATA || "";
				const isAlias = localAppData && candidate.startsWith(path.join(localAppData, "Microsoft", "WindowsApps"));
				if (!isAlias && (base === "pwsh.exe" || base === "pwsh")) {
					directCandidates.push(candidate);
				}
			}
		}
	}

	// Try each candidate in order, validate with version probe.
	for (const candidate of directCandidates) {
		if (!existsSync(candidate)) continue;
		// Reject any candidate that resolves to powershell.exe (legacy Windows PowerShell).
		const base = path.basename(candidate).toLowerCase();
		if (base === "powershell.exe" || base === "powershell") continue;
		if (probePwshVersion(candidate)) {
			_cachedWindowsShell = candidate;
			return candidate;
		}
	}

	// No pwsh found — fall back to COMSPEC (cmd.exe). Do NOT use powershell.exe.
	_cachedWindowsShell = null;
	return getEnvCaseInsensitive(baseEnv, "COMSPEC") || "cmd.exe";
}

/** Does not default to /bin/zsh — falls back to /bin/sh (POSIX-guaranteed). */
export function resolveLaunchShell(
	baseEnv: Record<string, string>,
	options?: ResolveConfiguredShellOptions,
): string {
	if (process.platform === "win32") {
		return resolveWindowsShell(baseEnv);
	}
	return resolveConfiguredShell(baseEnv, options);
}

export function getSupersetShellPaths(supersetHomeDir: string): {
	BIN_DIR: string;
	ZSH_DIR: string;
	BASH_DIR: string;
} {
	return {
		BIN_DIR: path.join(supersetHomeDir, "bin"),
		ZSH_DIR: path.join(supersetHomeDir, "zsh"),
		BASH_DIR: path.join(supersetHomeDir, "bash"),
	};
}

function getShellName(shell: string): string {
	// Normalize across separators (`/` and Windows `\`) and strip a `.exe`
	// suffix so `C:\...\pwsh.exe` and `/usr/bin/pwsh` both resolve to `pwsh`.
	// path.basename only handles the platform's own separator; do both
	// explicitly so a Windows path resolved on a POSIX dev box still matches.
	const base = shell.split(/[\\/]/).pop() || shell;
	return base.replace(/\.exe$/i, "");
}

/**
 * Matches desktop shell-wrappers.ts fish init: idempotent PATH prepend +
 * OSC 133;A prompt marker (FinalTerm standard) for shell readiness.
 *
 * Protocol ref: https://gitlab.freedesktop.org/Per_Bothner/specifications/blob/master/proposals/semantic-prompts.md
 */
function buildFishInitCommand(binDir: string): string {
	const escaped = binDir
		.replaceAll("\\", "\\\\")
		.replaceAll('"', '\\"')
		.replaceAll("$", "\\$");
	return [
		`set -l _superset_bin "${escaped}"`,
		`contains -- "$_superset_bin" $PATH`,
		`or set -gx PATH "$_superset_bin" $PATH`,
		// (AY) Command start: fish_preexec fires after a command line is read,
		// just before it runs -> OSC 133;C (command-running blue dot).
		`function _superset_cmd_start --on-event fish_preexec`,
		`printf '\\033]133;C\\007'`,
		`end`,
		// (AY) Command end + prompt start: fish_prompt fires before drawing the
		// prompt. $status is the previous command's exit. Emit 133;D;<exit> then
		// the existing 133;A. Capture $status FIRST so the D printf doesn't clobber
		// it for downstream prompt logic.
		`function _superset_prompt_mark --on-event fish_prompt`,
		`set -l _superset_ec $status`,
		`printf '\\033]133;D;%s\\007\\033]133;A\\007' $_superset_ec`,
		`end`,
	].join("; ");
}

/**
 * (AY) PowerShell single-quoted literal: a `'` inside is escaped by doubling it
 * (`''`). A Windows username/path CAN legitimately contain an apostrophe
 * (e.g. `C:\Users\O'Brien\...`), so escape it rather than assume it's absent.
 */
function quotePwshSingleQuoted(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

/**
 * (AY) PowerShell launch args. Dot-source the integration profile (written by
 * createPwshWrapper to BIN_DIR/superset-pwsh-integration.ps1) so it runs in the
 * interactive session WITHOUT replacing the user's own profile. -NoExit keeps
 * the session interactive; -ExecutionPolicy Bypass lets the dot-source run even
 * under a restrictive machine policy. The script path is a single-quoted pwsh
 * literal (spaces safe; `'` doubled) — see quotePwshSingleQuoted.
 */
function buildPwshInitCommand(binDir: string): string {
	const ps1Path = path.join(binDir, "superset-pwsh-integration.ps1");
	return `. ${quotePwshSingleQuoted(ps1Path)}`;
}

export interface ShellBootstrapParams {
	shell: string;
	baseEnv: Record<string, string>;
	supersetHomeDir: string;
}

/**
 * Private bootstrap env for shell startup redirection.
 * Only zsh needs env vars (ZDOTDIR). Bash/fish use args only.
 */
export function getShellBootstrapEnv(
	params: ShellBootstrapParams,
): Record<string, string> {
	const { shell, baseEnv, supersetHomeDir } = params;
	const shellName = getShellName(shell);
	const paths = getSupersetShellPaths(supersetHomeDir);

	if (shellName === "zsh") {
		const zshrc = path.join(paths.ZSH_DIR, ".zshrc");
		if (existsSync(zshrc)) {
			return {
				SUPERSET_ORIG_ZDOTDIR: baseEnv.ZDOTDIR || baseEnv.HOME || homedir(),
				ZDOTDIR: paths.ZSH_DIR,
			};
		}
	}

	return {};
}

export interface ShellLaunchParams {
	shell: string;
	supersetHomeDir: string;
}

export function getShellLaunchArgs(params: ShellLaunchParams): string[] {
	const { shell, supersetHomeDir } = params;
	const shellName = getShellName(shell);
	const paths = getSupersetShellPaths(supersetHomeDir);

	if (shellName === "zsh") {
		return ["-l"];
	}

	if (shellName === "bash") {
		const rcfile = path.join(paths.BASH_DIR, "rcfile");
		if (existsSync(rcfile)) {
			return ["--rcfile", rcfile];
		}
		return ["-l"];
	}

	if (shellName === "fish") {
		return ["-l", "--init-command", buildFishInitCommand(paths.BIN_DIR)];
	}

	if (shellName === "pwsh" || shellName === "powershell") {
		return [
			"-NoExit",
			"-ExecutionPolicy",
			"Bypass",
			"-Command",
			buildPwshInitCommand(paths.BIN_DIR),
		];
	}

	if (shellName === "sh" || shellName === "ksh") {
		return ["-l"];
	}

	return [];
}
