import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	SUPERSET_MANAGED_BINARIES,
	type SupersetManagedBinary,
} from "./desktop-agent-capabilities";
import { BASH_DIR, BIN_DIR, ZSH_DIR } from "./paths";

export interface ShellWrapperPaths {
	BIN_DIR: string;
	ZSH_DIR: string;
	BASH_DIR: string;
}

const DEFAULT_PATHS: ShellWrapperPaths = {
	BIN_DIR,
	ZSH_DIR,
	BASH_DIR,
};

const modeDiagnosticsLogged = new Set<string>();

function getShellName(shell: string): string {
	// (AY) Normalize across separators and a Windows `.exe` suffix so a
	// `C:\...\pwsh.exe` path matches the "pwsh" branch.
	const base = shell.split(/[\\/]/).pop() || shell;
	return base.replace(/\.exe$/i, "");
}

/**
 * Shell snippet to save all SUPERSET_* env vars before sourcing user RC files.
 * Used in tandem with {@link SUPERSET_ENV_RESTORE} to prevent user shell
 * configs from overriding Superset-managed environment variables (e.g.
 * SUPERSET_WORKSPACE_NAME).
 *
 * @see https://github.com/AidenIO/superset/issues/2386
 */
const SUPERSET_ENV_SAVE = `_superset_saved_env="$(export -p 2>/dev/null | grep ' SUPERSET_')"`;

/**
 * Shell snippet to restore previously saved SUPERSET_* env vars after
 * sourcing user RC files.
 */
const SUPERSET_ENV_RESTORE = `eval "$_superset_saved_env" 2>/dev/null || true`;

function quoteShellLiteral(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

// (AY) PowerShell single-quoted literal: a `'` inside is escaped by doubling it
// (`''`). A Windows username/path CAN legitimately contain an apostrophe
// (e.g. C:\Users\O'Brien\...), so escape rather than assume it's absent.
function quotePwshSingleQuoted(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

function logModeDiagnostics(shellName: string): void {
	const key = `${shellName}:native`;
	if (modeDiagnosticsLogged.has(key)) return;
	modeDiagnosticsLogged.add(key);
	console.debug(
		`[agent-setup] shell integration mode=native shell=${shellName}`,
	);
}

function writeFileIfChanged(
	filePath: string,
	content: string,
	mode: number,
): boolean {
	const existing = fs.existsSync(filePath)
		? fs.readFileSync(filePath, "utf-8")
		: null;
	if (existing === content) {
		try {
			fs.chmodSync(filePath, mode);
		} catch {
			// Best effort.
		}
		return false;
	}

	fs.writeFileSync(filePath, content, { mode });
	try {
		fs.chmodSync(filePath, mode);
	} catch {
		// Best effort.
	}
	return true;
}

/**
 * Build shell function wrappers for managed binaries (claude, codex, etc.)
 * that prefer BIN_DIR executables over system-installed ones.
 */
function buildManagedCommandPrelude(shellName: string, binDir: string): string {
	if (shellName === "fish") {
		const escapedBinDir = escapeFishDoubleQuoted(binDir);
		return SUPERSET_MANAGED_BINARIES.map(
			(name: SupersetManagedBinary) =>
				`functions -q ${name}; and functions -e ${name}
function ${name}
  set -l _superset_wrapper "${escapedBinDir}/${name}"
  if test -x "$_superset_wrapper"; and not test -d "$_superset_wrapper"
    "$_superset_wrapper" $argv
  else
    command ${name} $argv
  end
end`,
		).join("\n");
	}

	return SUPERSET_MANAGED_BINARIES.map(
		(name: SupersetManagedBinary) =>
			`unalias ${name} 2>/dev/null || true
${name}() {
  _superset_wrapper=${quoteShellLiteral(`${binDir}/${name}`)}
  if [ -x "$_superset_wrapper" ] && [ ! -d "$_superset_wrapper" ]; then
    "$_superset_wrapper" "$@"
  else
    command ${name} "$@"
  fi
}`,
	).join("\n");
}

/** Build a shell snippet that idempotently prepends BIN_DIR to PATH. */
function buildPathPrependFunction(binDir: string): string {
	return `_superset_prepend_bin() {
  case ":$PATH:" in
    *:${quoteShellLiteral(binDir)}:*) ;;
    *) export PATH=${quoteShellLiteral(binDir)}:"$PATH" ;;
  esac
}
_superset_prepend_bin`;
}

/**
 * Build a zsh precmd hook that re-asserts BIN_DIR in PATH.
 * Tools like mise/asdf register precmd hooks that reconstruct PATH,
 * which can remove our BIN_DIR. This is intentionally best-effort so
 * unusual user zsh configs don't break shell startup.
 */
function buildZshPrecmdHook(binDir: string): string {
	return `typeset -ga precmd_functions 2>/dev/null || true
_superset_ensure_path() {
  case ":$PATH:" in
    *:${quoteShellLiteral(binDir)}:*) ;;
    *) PATH=${quoteShellLiteral(binDir)}:"$PATH" ;;
  esac
}
{
  # Keep our hook last so it wins over other PATH-mutating precmd hooks.
  precmd_functions=(\${precmd_functions:#_superset_ensure_path} _superset_ensure_path)
} 2>/dev/null || true`;
}

function escapeFishDoubleQuoted(value: string): string {
	return value
		.replaceAll("\\", "\\\\")
		.replaceAll('"', '\\"')
		.replaceAll("$", "\\$");
}

export function createZshWrapper(
	paths: ShellWrapperPaths = DEFAULT_PATHS,
): void {
	logModeDiagnostics("zsh");
	const quotedZshDir = quoteShellLiteral(paths.ZSH_DIR);

	// .zshenv is always sourced first by zsh (interactive + non-interactive).
	// Temporarily restore the user's ZDOTDIR while sourcing user config, then
	// switch back so zsh continues through our wrapper chain.
	const zshenvPath = path.join(paths.ZSH_DIR, ".zshenv");
	const zshenvScript = `# Superset zsh env wrapper
${SUPERSET_ENV_SAVE}
_superset_home="\${SUPERSET_ORIG_ZDOTDIR:-$HOME}"
export ZDOTDIR="$_superset_home"
[[ -f "$_superset_home/.zshenv" ]] && source "$_superset_home/.zshenv"
${SUPERSET_ENV_RESTORE}
export ZDOTDIR=${quotedZshDir}
`;
	const wroteZshenv = writeFileIfChanged(zshenvPath, zshenvScript, 0o644);

	// Source user .zprofile with their ZDOTDIR, then restore wrapper ZDOTDIR
	// so startup continues into our .zshrc wrapper.
	const zprofilePath = path.join(paths.ZSH_DIR, ".zprofile");
	const zprofileScript = `# Superset zsh profile wrapper
${SUPERSET_ENV_SAVE}
_superset_home="\${SUPERSET_ORIG_ZDOTDIR:-$HOME}"
export ZDOTDIR="$_superset_home"
[[ -f "$_superset_home/.zprofile" ]] && source "$_superset_home/.zprofile"
${SUPERSET_ENV_RESTORE}
export ZDOTDIR=${quotedZshDir}
`;
	const wroteZprofile = writeFileIfChanged(zprofilePath, zprofileScript, 0o644);

	// Reset ZDOTDIR before sourcing so Oh My Zsh works correctly
	const zshrcPath = path.join(paths.ZSH_DIR, ".zshrc");
	const zshrcScript = `# Superset zsh rc wrapper
${SUPERSET_ENV_SAVE}
_superset_home="\${SUPERSET_ORIG_ZDOTDIR:-$HOME}"
export ZDOTDIR="$_superset_home"
[[ -f "$_superset_home/.zshrc" ]] && source "$_superset_home/.zshrc"
${SUPERSET_ENV_RESTORE}
${buildPathPrependFunction(paths.BIN_DIR)}
${buildZshPrecmdHook(paths.BIN_DIR)}
rehash 2>/dev/null || true
# Restore ZDOTDIR so our .zlogin runs after user's .zlogin
export ZDOTDIR=${quotedZshDir}
`;
	const wroteZshrc = writeFileIfChanged(zshrcPath, zshrcScript, 0o644);

	// .zlogin runs AFTER .zshrc in login shells. By restoring ZDOTDIR above,
	// zsh sources our .zlogin instead of the user's directly. We source the
	// user's .zlogin only for interactive shells, then re-assert Superset's
	// PATH prepend after user startup hooks run.
	const zloginPath = path.join(paths.ZSH_DIR, ".zlogin");
	const zloginScript = `# Superset zsh login wrapper
${SUPERSET_ENV_SAVE}
_superset_home="\${SUPERSET_ORIG_ZDOTDIR:-$HOME}"
export ZDOTDIR="$_superset_home"
if [[ -o interactive ]]; then
  [[ -f "$_superset_home/.zlogin" ]] && source "$_superset_home/.zlogin"
fi
${SUPERSET_ENV_RESTORE}
${buildZshPrecmdHook(paths.BIN_DIR)}
${buildPathPrependFunction(paths.BIN_DIR)}
rehash 2>/dev/null || true
# Shell readiness markers. Emitting both keeps us compatible across daemon
# versions: the legacy v1 daemon scans for OSC 777, the current scanner (v1
# post-refactor + v2 host-service) scans for OSC 133;A (FinalTerm standard).
# Wrappers are rewritten on every app launch, so main always ships the
# superset of markers; daemons that only get restarted on protocol bumps
# still match against their own scanner.
# Protocol ref: https://gitlab.freedesktop.org/Per_Bothner/specifications/blob/master/proposals/semantic-prompts.md
# (AY) Emit OSC 133;D;<exit> (command end) before A so the host-service C/D
# scanner can clear the shell-running blue dot. \$? must be captured FIRST.
__superset_prompt_mark() {
  local ec=$?
  printf "\\033]133;D;%s\\007\\033]777;superset-shell-ready\\007\\033]133;A\\007" "$ec"
}
# (AY) Command start (OSC 133;C) via zsh's preexec hook, which fires right
# before each entered command line runs.
_superset_cmd_start() {
  printf "\\033]133;C\\007"
}
typeset -ga preexec_functions 2>/dev/null || true
# Keep our hooks LAST so they fire after direnv and other hooks complete.
precmd_functions=(\${precmd_functions[@]} __superset_prompt_mark)
preexec_functions=(\${preexec_functions[@]} _superset_cmd_start)
export ZDOTDIR="$_superset_home"
`;
	const wroteZlogin = writeFileIfChanged(zloginPath, zloginScript, 0o644);
	const changed = wroteZshenv || wroteZprofile || wroteZshrc || wroteZlogin;
	console.log(
		`[agent-setup] ${changed ? "Updated" : "Verified"} zsh wrapper files`,
	);
}

export function createBashWrapper(
	paths: ShellWrapperPaths = DEFAULT_PATHS,
): void {
	logModeDiagnostics("bash");

	const rcfilePath = path.join(paths.BASH_DIR, "rcfile");
	const script = `# Superset bash rcfile wrapper

# Save Superset env vars before sourcing user config
${SUPERSET_ENV_SAVE}

# Source system profile
[[ -f /etc/profile ]] && source /etc/profile

# Source user's login profile
if [[ -f "$HOME/.bash_profile" ]]; then
  source "$HOME/.bash_profile"
elif [[ -f "$HOME/.bash_login" ]]; then
  source "$HOME/.bash_login"
elif [[ -f "$HOME/.profile" ]]; then
  source "$HOME/.profile"
fi

# Source bashrc if separate
[[ -f "$HOME/.bashrc" ]] && source "$HOME/.bashrc"

# Restore Superset env vars that user config may have overridden
${SUPERSET_ENV_RESTORE}

# Keep superset bin first without duplicating entries
${buildPathPrependFunction(paths.BIN_DIR)}
hash -r 2>/dev/null || true
# Minimal prompt (path/env shown in toolbar) - emerald to match app theme
export PS1=$'\\[\\e[1;38;2;52;211;153m\\]❯\\[\\e[0m\\] '
# Shell readiness markers — see zsh wrapper for rationale on emitting both.
# (AY) Also emit OSC 133;D;<exit> (command end) before A so the host-service
# C/D scanner can clear the shell-running blue dot. \$? must be captured FIRST,
# before any other command runs, so it reflects the user's last command. Reset
# the command-start latch so the NEXT entered command re-arms a single C.
# Protocol ref: https://gitlab.freedesktop.org/Per_Bothner/specifications/blob/master/proposals/semantic-prompts.md
__superset_prompt_mark() {
  local ec=$?
  _superset_cmd_started=
  printf "\\033]133;D;%s\\007\\033]777;superset-shell-ready\\007\\033]133;A\\007" "$ec"
}
# (AY) Command start (OSC 133;C) via the DEBUG trap (fires before each simple
# command). The DEBUG trap fires many times per command line and also for our
# own prompt machinery, so: (1) skip our helpers / PROMPT_COMMAND via
# \$BASH_COMMAND, and (2) latch _superset_cmd_started so C is emitted at most
# once per entered line; __superset_prompt_mark clears the latch at the next
# prompt. \$BASH_COMMAND names the about-to-run command.
__superset_cmd_start() {
  case "\${BASH_COMMAND:-}" in
    __superset_*|_superset_*|*PROMPT_COMMAND*) return ;;
  esac
  if [ -n "\${_superset_cmd_started:-}" ]; then return; fi
  _superset_cmd_started=1
  printf "\\033]133;C\\007"
}
trap '__superset_cmd_start' DEBUG
# Hook via PROMPT_COMMAND. Supports both scalar and array forms (Bash 5.1+).
if [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then
  PROMPT_COMMAND=("\${PROMPT_COMMAND[@]}" "__superset_prompt_mark")
else
  _superset_orig_prompt_cmd="\${PROMPT_COMMAND}"
  if [[ -n "\${_superset_orig_prompt_cmd}" ]]; then
    PROMPT_COMMAND="\${_superset_orig_prompt_cmd};__superset_prompt_mark"
  else
    PROMPT_COMMAND="__superset_prompt_mark"
  fi
fi
`;
	const changed = writeFileIfChanged(rcfilePath, script, 0o644);
	console.log(`[agent-setup] ${changed ? "Updated" : "Verified"} bash wrapper`);
}

/**
 * (AY) PowerShell integration profile content.
 *
 * Written verbatim to BIN_DIR/superset-pwsh-integration.ps1 by
 * {@link createPwshWrapper} and dot-sourced by the pwsh launch args
 * (shell-launch.ts buildPwshInitCommand). It emits OSC 133 markers so the
 * host-service C/D scanner can drive the shell-running blue dot AND the
 * existing shell-ready (133;A) detection.
 *
 * CRITICAL: this is built from an array of SINGLE-QUOTED JS strings joined by
 * "\n" — NEVER a template literal (backticks). pwsh's `$LASTEXITCODE` and
 * `$(...)`/`${}` syntax would either break a JS template literal at esbuild
 * time or be wrongly interpolated; single-quoted JS strings pass them through
 * byte-for-byte. Keep every line single-quoted and free of backticks.
 *
 * - Wrap (don't replace) the user's prompt: save $function:prompt, then a new
 *   global:prompt emits 133;D;<exit> + 133;A and appends the original prompt's
 *   output. $LASTEXITCODE is captured FIRST (a null on a fresh session -> 0).
 * - Command start (133;C) is emitted from a PSReadLine key handler on the
 *   Enter chords, just before AcceptLine submits the line. The handler FIRST
 *   asks PSReadLine for the buffer's parse state (GetBufferState) and emits C
 *   ONLY when the buffer is a complete, executable statement — i.e. there are
 *   no `IncompleteInput` parse errors. On incomplete multi-line input (an open
 *   brace, pipe, quote, etc.) Enter just continues the line, so we emit NOTHING
 *   and let PSReadLine insert the newline — no false-blue mid-edit. Wrapped in
 *   try/catch so Windows PowerShell 5.1 without PSReadLine still loads the
 *   profile (it just won't show blue — D+A still fire, safe degrade).
 */
const PWSH_INTEGRATION_SCRIPT = [
	"# Superset PowerShell integration (OSC 133 shell-running markers).",
	"# Auto-generated by Superset; dot-sourced into interactive pwsh sessions.",
	"$global:__supersetOriginalPrompt = $function:prompt",
	"function global:prompt {",
	"  $ec = $LASTEXITCODE",
	"  if ($null -eq $ec) { $ec = 0 }",
	"  $m = \"$([char]0x1b)]133;D;$ec$([char]0x07)$([char]0x1b)]133;A$([char]0x07)\"",
	"  $u = ''",
	"  if ($global:__supersetOriginalPrompt) {",
	"    $u = & $global:__supersetOriginalPrompt",
	"  }",
	"  # Restore $LASTEXITCODE for any user prompt logic that reads it.",
	"  $global:LASTEXITCODE = $ec",
	"  return \"$m$u\"",
	"}",
	"if (Get-Module -ListAvailable PSReadLine) {",
	"  Import-Module PSReadLine -ErrorAction SilentlyContinue",
	"  # Returns $true only when the current buffer parses as a COMPLETE statement",
	"  # (Enter will actually run it). Any IncompleteInput parse error means Enter",
	"  # continues a multi-line edit, so we must NOT emit 133;C yet.",
	"  function global:__SupersetBufferIsComplete {",
	"    $tokens = $null",
	"    $perrors = $null",
	"    $ast = $null",
	"    $cursor = 0",
	"    try {",
	"      [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$ast, [ref]$tokens, [ref]$perrors, [ref]$cursor)",
	"    } catch {",
	"      # If we cannot inspect the buffer, assume complete (fail toward emitting",
	"      # C so a real command still lights up; worst case a rare false-blue).",
	"      return $true",
	"    }",
	"    if ($null -eq $perrors) { return $true }",
	"    foreach ($e in $perrors) {",
	"      if ($e.IncompleteInput) { return $false }",
	"    }",
	"    return $true",
	"  }",
	"  $supersetCmdStart = {",
	"    if (__SupersetBufferIsComplete) {",
	"      [Console]::Write(\"$([char]0x1b)]133;C$([char]0x07)\")",
	"    }",
	"    [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()",
	"  }",
	"  foreach ($chord in 'Enter','Ctrl+m','Ctrl+j') {",
	"    try {",
	"      Set-PSReadLineKeyHandler -Chord $chord -ScriptBlock $supersetCmdStart",
	"    } catch {}",
	"  }",
	"}",
	"",
].join("\n");

/**
 * (AY) Write the PowerShell integration profile into BIN_DIR. pwsh launch args
 * dot-source it. No-op rewrite when unchanged (writeFileIfChanged). Mode 0o644
 * mirrors the other wrappers (ignored on Windows but harmless).
 */
export function createPwshWrapper(
	paths: ShellWrapperPaths = DEFAULT_PATHS,
): void {
	logModeDiagnostics("pwsh");
	const ps1Path = path.join(paths.BIN_DIR, "superset-pwsh-integration.ps1");
	const changed = writeFileIfChanged(ps1Path, PWSH_INTEGRATION_SCRIPT, 0o644);
	console.log(
		`[agent-setup] ${changed ? "Updated" : "Verified"} pwsh wrapper`,
	);
}

export function getShellEnv(
	shell: string,
	paths: ShellWrapperPaths = DEFAULT_PATHS,
): Record<string, string> {
	const shellName = getShellName(shell);
	if (shellName === "zsh") {
		return {
			SUPERSET_ORIG_ZDOTDIR: process.env.ZDOTDIR || os.homedir(),
			ZDOTDIR: paths.ZSH_DIR,
		};
	}
	return {};
}

export function getShellArgs(
	shell: string,
	paths: ShellWrapperPaths = DEFAULT_PATHS,
): string[] {
	const shellName = getShellName(shell);
	logModeDiagnostics(shellName);
	if (shellName === "bash") {
		return ["--rcfile", path.join(paths.BASH_DIR, "rcfile")];
	}
	if (shellName === "fish") {
		// Use --init-command to prepend BIN_DIR to PATH after config is loaded.
		// Use fish list-aware checks to avoid duplicate PATH entries across nested shells.
		// Emit both OSC 777 (legacy v1 daemon) and OSC 133;A (current scanner)
		// on fish_prompt. See zsh wrapper for rationale.
		const escapedBinDir = escapeFishDoubleQuoted(paths.BIN_DIR);
		return [
			"-l",
			"--init-command",
			[
				`set -l _superset_bin "${escapedBinDir}"`,
				`contains -- "$_superset_bin" $PATH`,
				`or set -gx PATH "$_superset_bin" $PATH`,
				// (AY) Command start: fish_preexec -> OSC 133;C (blue dot).
				`function _superset_cmd_start --on-event fish_preexec`,
				`printf '\\033]133;C\\007'`,
				`end`,
				// (AY) Command end + prompt: capture $status FIRST, emit
				// 133;D;<exit> then the existing 777 + 133;A markers.
				`function _superset_prompt_mark --on-event fish_prompt`,
				`set -l _superset_ec $status`,
				`printf '\\033]133;D;%s\\007\\033]777;superset-shell-ready\\007\\033]133;A\\007' $_superset_ec`,
				`end`,
			].join("; "),
		];
	}
	if (shellName === "pwsh" || shellName === "powershell") {
		// (AY) Dot-source the integration profile (written by createPwshWrapper)
		// into the interactive session for OSC 133 C/D/A markers. -NoExit keeps
		// it interactive; Bypass survives a restrictive machine policy.
		return [
			"-NoExit",
			"-ExecutionPolicy",
			"Bypass",
			"-Command",
			`. ${quotePwshSingleQuoted(path.join(paths.BIN_DIR, "superset-pwsh-integration.ps1"))}`,
		];
	}
	if (["zsh", "sh", "ksh"].includes(shellName)) {
		return ["-l"];
	}
	return [];
}

/**
 * Shell args for non-interactive command execution (`-c`) that sources
 * user profiles via wrappers. Falls back to login shell if wrappers
 * don't exist yet (e.g. before setupAgentHooks runs).
 *
 * Unlike getShellArgs (interactive), we must source profiles inline because:
 * - zsh skips .zshrc for non-interactive shells
 * - bash ignores --rcfile when -c is present
 * - managed binary prelude enforces wrapper paths for app-owned commands
 */
export function getCommandShellArgs(
	shell: string,
	command: string,
	paths: ShellWrapperPaths = DEFAULT_PATHS,
): string[] {
	const shellName = getShellName(shell);
	logModeDiagnostics(shellName);
	// (AY) pwsh/powershell take POSIX prelude/`-c` syntax poorly; run the
	// command directly with -Command. No prompt markers here — this is a
	// one-shot non-interactive invocation, not an interactive session, so the
	// shell-running dot does not apply.
	if (shellName === "pwsh" || shellName === "powershell") {
		return ["-NoProfile", "-Command", command];
	}
	const zshRc = path.join(paths.ZSH_DIR, ".zshrc");
	const bashRcfile = path.join(paths.BASH_DIR, "rcfile");
	const commandWithManagedPrelude = `${buildManagedCommandPrelude(shellName, paths.BIN_DIR)}\n${command}`;
	if (shellName === "zsh" && fs.existsSync(zshRc)) {
		return [
			"-lc",
			`source ${quoteShellLiteral(zshRc)} &&\n${commandWithManagedPrelude}`,
		];
	}
	if (shellName === "bash" && fs.existsSync(bashRcfile)) {
		return [
			"-c",
			`source ${quoteShellLiteral(bashRcfile)} &&\n${commandWithManagedPrelude}`,
		];
	}
	return ["-lc", commandWithManagedPrelude];
}
