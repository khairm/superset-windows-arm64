import fs from "node:fs";
import path from "node:path";
import { SUPERSET_MANAGED_BINARIES } from "./agent-setup-targets";
import { NOTIFY_SCRIPT_NAME } from "./notify-hook";
import { getBinDir } from "./paths";

export const WRAPPER_MARKER = "# Superset agent-wrapper v4";
export { SUPERSET_MANAGED_BINARIES };

/** Path (under SUPERSET_HOME_DIR) of the runtime notify hook script. */
export const MANAGED_NOTIFY_RELATIVE_PATH = `hooks/${NOTIFY_SCRIPT_NAME}`;

/**
 * Literal substring every guarded managed command contains. Managed-command
 * predicates must match it: the guarded form carries neither an absolute
 * notify path nor a `/.superset/` segment, so without this check a re-merge
 * would fail to recognize its own entries and append duplicates.
 */
export const DYNAMIC_NOTIFY_PATH_MARKER = `$SUPERSET_HOME_DIR/${MANAGED_NOTIFY_RELATIVE_PATH}`;

/**
 * Shell command written into an agent's global hook config. The notify path is
 * resolved at runtime from SUPERSET_HOME_DIR so one shared config works for both
 * dev and prod installs, and `SUPERSET_AGENT_ID` is inlined so the v2 hook
 * payload carries wrapper-level identity even when the agent is launched outside
 * the Superset wrapper (system PATH resolves the real binary directly).
 */
export function getManagedNotifyHookCommand(agentId: string): string {
	return `[ -n "$SUPERSET_HOME_DIR" ] && [ -x "$SUPERSET_HOME_DIR/${MANAGED_NOTIFY_RELATIVE_PATH}" ] && SUPERSET_AGENT_ID=${agentId} "$SUPERSET_HOME_DIR/${MANAGED_NOTIFY_RELATIVE_PATH}" || true`;
}

// Dev setup (.superset/lib/setup/steps.sh) points SUPERSET_HOME_DIR at
// $PWD/superset-dev-data — without a leading dot — so we must recognize that
// variant to reap stale notify.sh paths from deleted worktrees.
const SUPERSET_MANAGED_HOOK_PATH_PATTERN =
	/\/(?:\.superset(?:-[^/'"\s\\]+)?|superset-dev-data)\//;

import { writeFileIfChanged } from "./write-file-if-changed";

export { writeFileIfChanged };

/**
 * Deletes a wholly Superset-owned file, gated on its content signature so a
 * user file at the same path is never removed.
 */
export function removeOwnedFileIfMarked(
	filePath: string,
	signature: string,
	label: string,
): void {
	try {
		if (!fs.existsSync(filePath)) return;
		const content = fs.readFileSync(filePath, "utf-8");
		if (!content.includes(signature)) return;
		fs.unlinkSync(filePath);
		console.log(`[agent-setup] Removed ${label}`);
	} catch (error) {
		console.warn(`[agent-setup] Failed to remove ${label}:`, error);
	}
}

export function isSupersetManagedHookCommand(
	command: string | undefined,
	scriptName: string,
): boolean {
	if (!command) return false;
	const normalized = command.replaceAll("\\", "/");
	if (!normalized.includes(`/hooks/${scriptName}`)) return false;
	return SUPERSET_MANAGED_HOOK_PATH_PATTERN.test(normalized);
}

/**
 * Resolve Git-for-Windows `bin/bash.exe`. That specific binary sets up the MSYS
 * environment, so a hook script's grep/sed/curl resolve even when an agent CLI
 * launches the command from cmd.exe. NEVER return System32\bash.exe (the WSL
 * launcher): it cannot read `C:/` paths and fails silently. Returns null when no
 * Git bash is found.
 */
function findWindowsGitBash(): string | null {
	const bases = [
		process.env.PROGRAMFILES,
		process.env.ProgramW6432,
		process.env["ProgramFiles(x86)"],
		process.env.LOCALAPPDATA
			? path.join(process.env.LOCALAPPDATA, "Programs")
			: undefined,
	];
	const candidates = bases
		.filter((base): base is string => Boolean(base))
		.map((base) => path.join(base, "Git", "bin", "bash.exe"));
	for (const candidate of candidates) {
		if (fs.existsSync(candidate)) return candidate;
	}
	return null;
}

/**
 * Prefer the 8.3 short name for a `Program Files` path so the emitted command can
 * leave the bash exe unquoted — a leading quote can be eaten by cmd.exe `/s /c`.
 * The short form is verified with existsSync; falls back to the original path
 * (the caller quotes it) when 8.3 names are disabled.
 */
function toWindowsShortPathIfAvailable(p: string): string {
	const short = p
		.replace(/^([A-Za-z]:\\)Program Files \(x86\)(?=\\)/, "$1PROGRA~2")
		.replace(/^([A-Za-z]:\\)Program Files(?=\\)/, "$1PROGRA~1");
	if (short !== p && !short.includes(" ") && fs.existsSync(short)) {
		return short;
	}
	return p;
}

/**
 * Build the `command` string written into an agent's hook config.
 *
 * POSIX: the bare script path plus optional args — identical to upstream. Windows:
 * a bare `.sh` path is ShellExecuted by the agent CLI and opens in the user's
 * default `.sh` editor instead of running (the "random text file pops open" bug),
 * so wrap it in Git-for-Windows bash with a forward-slash path. Returns null on
 * Windows when no Git bash is installed, so callers skip writing a hook that could
 * only pop the editor (and reconcile drops any stale raw-.sh entry).
 */
export function buildAgentHookCommand(
	hookScriptPath: string,
	args?: string,
): string | null {
	const suffix = args ? ` ${args}` : "";
	if (process.platform !== "win32") {
		return `${hookScriptPath}${suffix}`;
	}
	const bash = findWindowsGitBash();
	if (!bash) return null;
	const exe = toWindowsShortPathIfAvailable(bash).replaceAll("\\", "/");
	// Short name needs no quoting; the quoted long-path fallback is still safe
	// because agent CLIs spawn this via Node-style `cmd /d /s /c "<cmd>"`, whose
	// `/s` strips Node's outer wrapper quotes, not ours.
	const exeToken = exe.includes(" ") ? `"${exe}"` : exe;
	const scriptUnix = hookScriptPath.replaceAll("\\", "/");
	return `${exeToken} "${scriptUnix}"${suffix}`;
}

/**
 * Recognizes every form of Superset's notify hook command: the current
 * guarded form (dynamic marker), a current absolute notify path, and stale
 * absolute paths from other installs/worktrees.
 */
export function isManagedNotifyCommand(
	command: string | undefined,
	notifyScriptPath: string,
): boolean {
	return Boolean(
		command?.includes(notifyScriptPath) ||
			command?.includes(DYNAMIC_NOTIFY_PATH_MARKER) ||
			isSupersetManagedHookCommand(command, NOTIFY_SCRIPT_NAME),
	);
}

function buildRealBinaryResolver(): string {
	return `find_real_binary() {
  local name="$1"
  local IFS=:
  for dir in $PATH; do
    [ -z "$dir" ] && continue
    dir="\${dir%/}"
    case "$dir" in
      "${getBinDir()}"|"$HOME"/.superset/bin|"$HOME"/.superset-*/bin) continue ;;
    esac
    if [ -x "$dir/$name" ] && [ ! -d "$dir/$name" ]; then
      printf "%s\\n" "$dir/$name"
      return 0
    fi
  done
  return 1
}
`;
}

/**
 * Shell block that re-resolves the Usage-tab default account at launch.
 * The PTY env is frozen at terminal spawn, so an account switch would
 * otherwise reach only brand-new terminals; this re-reads the host's
 * pointer file every time the agent starts instead. Superset terminals
 * only, and a value the user exported by hand — one that differs from what
 * Superset injected at spawn — always wins. A missing pointer file (older
 * host build) changes nothing; an empty one means the system default.
 */
export function buildDefaultAccountResolver(
	envVar: string,
	pointerName: string,
	ambientEnvVar?: string,
): string {
	const pointer = `"$SUPERSET_HOME_DIR/state/${pointerName}"`;
	const restoreSystemDefault = ambientEnvVar
		? `if [ -n "\${${ambientEnvVar}}" ]; then
    export ${envVar}="\${${ambientEnvVar}}"
    export SUPERSET_DEFAULT_${envVar}="\${${ambientEnvVar}}"
  else
    unset ${envVar}
    unset SUPERSET_DEFAULT_${envVar}
  fi`
		: `unset ${envVar}
  unset SUPERSET_DEFAULT_${envVar}`;
	return `if [ -n "$SUPERSET_TERMINAL_ID" ] && [ -n "$SUPERSET_HOME_DIR" ] \\
  && { [ -z "\${${envVar}}" ] || [ "\${${envVar}}" = "\${SUPERSET_DEFAULT_${envVar}}" ]; } \\
  && [ -f ${pointer} ]; then
  superset_default_account="$(cat ${pointer} 2>/dev/null)"
  if [ -n "$superset_default_account" ] && [ -d "$superset_default_account" ]; then
    export ${envVar}="$superset_default_account"
    export SUPERSET_DEFAULT_${envVar}="$superset_default_account"
  else
    ${restoreSystemDefault}
  fi
fi

`;
}

function getMissingBinaryMessage(name: string): string {
	return `Superset: ${name} not found in PATH. Install it and ensure it is on PATH, then retry.`;
}

export function getWrapperPath(binaryName: string): string {
	return path.join(getBinDir(), binaryName);
}

export interface BuildWrapperScriptOptions {
	/**
	 * `BuiltinAgentId` for the wrapped binary (e.g. "claude", "codex"). When
	 * set, the wrapper exports `SUPERSET_AGENT_ID` so the agent process and
	 * any hook subprocess it spawns inherit the wrapper-level identity. The
	 * notify-hook script forwards this into the v2 hook payload.
	 */
	agentId?: string;
}

/**
 * Shell block that reports the agent launch to the host so the terminal gets
 * an agent binding the moment a harness starts — not on its first native hook.
 * Some harnesses defer their SessionStart hook until the first turn (Codex
 * creates its rollout lazily, so an idle or resumed TUI fires nothing) and
 * some have no session hooks at all (vibe); the wrapper is the one launch-time
 * signal every harness shares. The report is delayed and liveness-gated so
 * `--help`-style probes that exit right away never bind a pane, and the
 * subshell survives `exec` — after it, the captured pid IS the agent process.
 * Harnesses with working native SessionStart hooks fire too; the host upsert
 * makes the duplicate harmless and lets them attach the real session id.
 */
function buildLaunchReportBlock(): string {
	return `_superset_skip_launch_report=""
for _superset_arg in "$@"; do
  # Tokens past \`--\` are prompt text, never flags.
  [ "$_superset_arg" = "--" ] && break
  case "$_superset_arg" in
    --help|-h|--version|-V|-v)
      _superset_skip_launch_report="1"
      break
      ;;
  esac
done
if [ -z "$_superset_skip_launch_report" ] && [ -n "$SUPERSET_TERMINAL_ID" ] \\
  && [ -n "$SUPERSET_HOME_DIR" ] && [ -x "$SUPERSET_HOME_DIR/${MANAGED_NOTIFY_RELATIVE_PATH}" ]; then
  _superset_launch_pid=$$
  (
    sleep 2
    kill -0 "$_superset_launch_pid" 2>/dev/null || exit 0
    exec "$SUPERSET_HOME_DIR/${MANAGED_NOTIFY_RELATIVE_PATH}" '{"hook_event_name":"SessionStart"}'
  ) >/dev/null 2>&1 </dev/null &
fi

`;
}

export function buildWrapperScript(
	binaryName: string,
	execLine: string,
	options: BuildWrapperScriptOptions = {},
): string {
	const exportAgentId = options.agentId
		? `export SUPERSET_AGENT_ID="${options.agentId}"\n\n`
		: "";
	const launchReport = options.agentId ? buildLaunchReportBlock() : "";
	return `#!/bin/bash
${WRAPPER_MARKER}
# Superset wrapper for ${binaryName}

${buildRealBinaryResolver()}
REAL_BIN="$(find_real_binary "${binaryName}")"
if [ -z "$REAL_BIN" ]; then
  echo "${getMissingBinaryMessage(binaryName)}" >&2
  exit 127
fi

${exportAgentId}${launchReport}${execLine}
`;
}

export function createWrapper(binaryName: string, script: string): void {
	const changed = writeFileIfChanged(getWrapperPath(binaryName), script, 0o755);
	console.log(
		`[agent-setup] ${changed ? "Updated" : "Verified"} ${binaryName} wrapper`,
	);
}
