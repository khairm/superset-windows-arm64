/**
 * Shell launch configuration for v2 terminals.
 *
 * Behavioral reference: packages/agent-setup/src/shell-wrappers.ts
 *
 * Upstream patterns:
 * - VS Code: ZDOTDIR for zsh, --init-file for bash, --init-command for fish
 * - Kitty: KITTY_ORIG_ZDOTDIR for zsh, ENV for bash, XDG_DATA_DIRS for fish
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
	type ResolveConfiguredShellOptions,
	resolveConfiguredShell,
} from "./user-shell.ts";
import {
	resolveWindowsShell,
	type ShellResolution,
	ShellUnresolvedError,
} from "./windows-shell.ts";

export interface SessionShellResolverForTesting {
	resolve: (baseEnv: Record<string, string>) => Promise<ShellResolution>;
	adoptedShell: (baseEnv: Record<string, string>) => string | null;
}

let sessionShellResolverForTesting: SessionShellResolverForTesting | undefined;

export function __setSessionShellResolverForTesting(
	resolver: SessionShellResolverForTesting | undefined,
): SessionShellResolverForTesting | undefined {
	const previous = sessionShellResolverForTesting;
	sessionShellResolverForTesting = resolver;
	return previous;
}

// (PWSH-RESOLVE-WIRED)
export async function resolveSessionShell(
	baseEnv: Record<string, string>,
	options?: ResolveConfiguredShellOptions,
): Promise<ShellResolution> {
	if (sessionShellResolverForTesting) {
		return sessionShellResolverForTesting.resolve(baseEnv);
	}
	if ((options?.platform ?? process.platform) === "win32") {
		return resolveWindowsShell(baseEnv, process.env.SUPERSET_TERMINAL_SHELL);
	}
	return {
		kind: "found",
		shell: resolveConfiguredShell(baseEnv, options),
		source: "configured",
	};
}

export function adoptedSessionShell(
	baseEnv: Record<string, string>,
	options?: ResolveConfiguredShellOptions,
): string | null {
	if (sessionShellResolverForTesting) {
		return sessionShellResolverForTesting.adoptedShell(baseEnv);
	}
	if ((options?.platform ?? process.platform) === "win32") return null;
	return resolveLaunchShell(baseEnv, options);
}

/** Does not default to /bin/zsh — falls back to /bin/sh (POSIX-guaranteed). */
export function resolveLaunchShell(
	baseEnv: Record<string, string>,
	options?: ResolveConfiguredShellOptions,
): string {
	if ((options?.platform ?? process.platform) === "win32") {
		throw new ShellUnresolvedError("use resolveSessionShell");
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

const SHELL_READY_MARKER_SCRIPT = "\\033]133;A\\007";

function fileContainsShellReadyMarker(filePath: string): boolean {
	try {
		return readFileSync(filePath, "utf8").includes(SHELL_READY_MARKER_SCRIPT);
	} catch {
		return false;
	}
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

/**
 * Whether this exact launch configuration installs Superset's prompt marker.
 *
 * Shell name alone is not enough: stale or missing wrapper files mean zsh and
 * bash never emit OSC 133;A. Callers use this capability check to decide
 * whether automation can safely wait for the first prompt without risking an
 * indefinite stall on an unwrapped shell.
 */
export function shellLaunchExpectsReadyMarker(
	params: ShellLaunchParams,
): boolean {
	const { shell, supersetHomeDir } = params;
	const shellName = getShellName(shell);
	const paths = getSupersetShellPaths(supersetHomeDir);

	if (shellName === "zsh") {
		return (
			existsSync(path.join(paths.ZSH_DIR, ".zshrc")) &&
			fileContainsShellReadyMarker(path.join(paths.ZSH_DIR, ".zlogin"))
		);
	}

	if (shellName === "bash") {
		return fileContainsShellReadyMarker(path.join(paths.BASH_DIR, "rcfile"));
	}

	// Fish receives the marker hook directly in --init-command, so it does not
	// depend on wrapper files on disk.
	return shellName === "fish";
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
