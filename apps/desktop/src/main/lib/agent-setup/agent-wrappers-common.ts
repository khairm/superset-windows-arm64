import fs from "node:fs";
import path from "node:path";
import { SUPERSET_MANAGED_BINARIES } from "./desktop-agent-capabilities";
import { BIN_DIR } from "./paths";

export const WRAPPER_MARKER = "# Superset agent-wrapper v3";
export { SUPERSET_MANAGED_BINARIES };

// Dev setup (.superset/lib/setup/steps.sh) points SUPERSET_HOME_DIR at
// $PWD/superset-dev-data — without a leading dot — so we must recognize that
// variant to reap stale notify.sh paths from deleted worktrees.
const SUPERSET_MANAGED_HOOK_PATH_PATTERN =
	/\/(?:\.superset(?:-[^/'"\s\\]+)?|superset-dev-data)\//;

export function writeFileIfChanged(
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
	return true;
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

interface ReconcileManagedEntriesOptions<T> {
	current: T[] | undefined;
	desired: T[];
	isManaged: (entry: T) => boolean;
	isEquivalent: (entry: T, desiredEntry: T) => boolean;
}

interface ReconcileManagedEntriesResult<T> {
	entries: T[];
	replacedManagedEntries: T[];
}

export function reconcileManagedEntries<T>({
	current,
	desired,
	isManaged,
	isEquivalent,
}: ReconcileManagedEntriesOptions<T>): ReconcileManagedEntriesResult<T> {
	const existing = Array.isArray(current) ? current : [];
	const entries: T[] = [];
	const replacedManagedEntries: T[] = [];

	for (const entry of existing) {
		if (!isManaged(entry)) {
			entries.push(entry);
			continue;
		}

		if (!desired.some((desiredEntry) => isEquivalent(entry, desiredEntry))) {
			replacedManagedEntries.push(entry);
		}
	}

	entries.push(...desired);

	return { entries, replacedManagedEntries };
}

function buildRealBinaryResolver(): string {
	return `find_real_binary() {
  local name="$1"
  local IFS=:
  for dir in $PATH; do
    [ -z "$dir" ] && continue
    dir="\${dir%/}"
    case "$dir" in
      "${BIN_DIR}"|"$HOME"/.superset/bin|"$HOME"/.superset-*/bin) continue ;;
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

function getMissingBinaryMessage(name: string): string {
	return `Superset: ${name} not found in PATH. Install it and ensure it is on PATH, then retry.`;
}

export function getWrapperPath(binaryName: string): string {
	return path.join(BIN_DIR, binaryName);
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

export function buildWrapperScript(
	binaryName: string,
	execLine: string,
	options: BuildWrapperScriptOptions = {},
): string {
	const exportAgentId = options.agentId
		? `export SUPERSET_AGENT_ID="${options.agentId}"\n\n`
		: "";
	return `#!/bin/bash
${WRAPPER_MARKER}
# Superset wrapper for ${binaryName}

${buildRealBinaryResolver()}
REAL_BIN="$(find_real_binary "${binaryName}")"
if [ -z "$REAL_BIN" ]; then
  echo "${getMissingBinaryMessage(binaryName)}" >&2
  exit 127
fi

${exportAgentId}${execLine}
`;
}

export function createWrapper(binaryName: string, script: string): void {
	const changed = writeFileIfChanged(getWrapperPath(binaryName), script, 0o755);
	console.log(
		`[agent-setup] ${changed ? "Updated" : "Verified"} ${binaryName} wrapper`,
	);
}
