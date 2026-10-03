// (PWSH-RESOLVE-NO-LAUNCH)
import fsPromises from "node:fs/promises";
import path from "node:path";

export type ShellSource =
	| "override"
	| "install"
	| "path"
	| "store"
	| "configured";

export type ShellResolution =
	| { kind: "found"; shell: string; source: ShellSource }
	| { kind: "absent"; shell: string; checked: string[]; skipped: string[] }
	| { kind: "refused"; message: string; code: "shell-unresolved" };

export class ShellUnresolvedError extends Error {
	readonly code = "shell-unresolved" as const;

	constructor(message: string) {
		super(message);
		this.name = "ShellUnresolvedError";
	}
}

export interface WindowsShellFs {
	stat: (p: string) => Promise<{ isFile(): boolean }>;
	lstat: (p: string) => Promise<{ isSymbolicLink(): boolean }>;
	readlink: (p: string) => Promise<string>;
}

const nodeFs: WindowsShellFs = {
	stat: (p) => fsPromises.stat(p),
	lstat: (p) => fsPromises.lstat(p),
	readlink: (p) => fsPromises.readlink(p),
};

type FileCheck =
	| { kind: "found" }
	| { kind: "absent" }
	| { kind: "unclear"; reason: string };

const RESTART_HINT = "Fix it and restart the app.";
const STORE_FAMILIES = [
	"Microsoft.PowerShell_8wekyb3d8bbwe",
	"Microsoft.PowerShellPreview_8wekyb3d8bbwe",
];

export function getEnvCaseInsensitive(
	env: Record<string, string>,
	key: string,
): string | undefined {
	const upper = key.toUpperCase();
	for (const [k, v] of Object.entries(env)) {
		if (k.toUpperCase() === upper) return v;
	}
	return undefined;
}

function errorCode(error: unknown): string {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	if (typeof code === "string") return code;
	return error instanceof Error ? error.message : String(error);
}

function isDrivePath(p: string): boolean {
	return path.win32.isAbsolute(p) && /^[A-Za-z]:[\\/]/.test(p);
}

function isFullPath(p: string): boolean {
	return isDrivePath(p) || (path.win32.isAbsolute(p) && p.startsWith("\\\\"));
}

function isInsideWindowsApps(p: string): boolean {
	return path.win32.normalize(p).toLowerCase().includes("\\windowsapps\\");
}

async function checkAccessDenied(
	candidate: string,
	fs: WindowsShellFs,
	statCode: string,
): Promise<FileCheck> {
	try {
		const link = await fs.lstat(candidate);
		if (!link.isSymbolicLink() || !isInsideWindowsApps(candidate)) {
			return {
				kind: "unclear",
				reason: `${statCode}, not a WindowsApps alias`,
			};
		}
		const target = await fs.readlink(candidate);
		await fs.lstat(path.win32.resolve(path.win32.dirname(candidate), target));
		return { kind: "found" };
	} catch (error) {
		return {
			kind: "unclear",
			reason: `${statCode}, alias check failed: ${errorCode(error)}`,
		};
	}
}

async function checkFileUncached(
	candidate: string,
	fs: WindowsShellFs,
): Promise<FileCheck> {
	let stats: { isFile(): boolean };
	try {
		stats = await fs.stat(candidate);
	} catch (error) {
		const code = errorCode(error);
		if (code === "ENOENT" || code === "ENOTDIR") return { kind: "absent" };
		if (code === "EACCES" || code === "EPERM") {
			return checkAccessDenied(candidate, fs, code);
		}
		return { kind: "unclear", reason: code };
	}
	if (stats.isFile()) return { kind: "found" };
	return { kind: "unclear", reason: "exists but is not a file" };
}

const inFlightChecks = new WeakMap<
	WindowsShellFs,
	Map<string, Promise<FileCheck>>
>();

function inFlightChecksFor(
	fs: WindowsShellFs,
): Map<string, Promise<FileCheck>> {
	const existing = inFlightChecks.get(fs);
	if (existing) return existing;
	const created = new Map<string, Promise<FileCheck>>();
	inFlightChecks.set(fs, created);
	return created;
}

function checkFile(candidate: string, fs: WindowsShellFs): Promise<FileCheck> {
	const checks = inFlightChecksFor(fs);
	const key = path.win32.normalize(candidate).toLowerCase();
	const pending = checks.get(key);
	if (pending) return pending;
	const check = checkFileUncached(candidate, fs).finally(() => {
		checks.delete(key);
	});
	checks.set(key, check);
	return check;
}

function refuse(message: string): ShellResolution {
	console.error(`[terminal] shell refused: ${message}`);
	return { kind: "refused", message, code: "shell-unresolved" };
}

function refuseMissingEnv(name: string): ShellResolution {
	return refuse(
		`Can't look for PowerShell 7: the ${name} environment variable is not set. Restart the app.`,
	);
}

const loggedFoundShells = new Set<string>();
let loggedAbsent = false;

function found(shell: string, source: ShellSource): ShellResolution {
	if (!loggedFoundShells.has(shell)) {
		loggedFoundShells.add(shell);
		console.log(`[terminal] shell found: ${shell} (${source})`);
	}
	return { kind: "found", shell, source };
}

async function resolveOverride(
	override: string,
	fs: WindowsShellFs,
): Promise<ShellResolution> {
	if (!isFullPath(override)) {
		return refuse(
			`SUPERSET_TERMINAL_SHELL must be a full path, got "${override}". ${RESTART_HINT}`,
		);
	}
	const check = await checkFile(override, fs);
	if (check.kind === "found") return found(override, "override");
	if (check.kind === "absent") {
		return refuse(
			`SUPERSET_TERMINAL_SHELL points to a missing file: ${override}. ${RESTART_HINT}`,
		);
	}
	return refuse(
		`SUPERSET_TERMINAL_SHELL could not be checked: ${override} (${check.reason}). ${RESTART_HINT}`,
	);
}

function splitPathEntries(
	pathValue: string,
	programFilesDrive: string,
): { kept: string[]; skipped: string[] } {
	const kept: string[] = [];
	const skipped: string[] = [];
	const seen = new Set<string>();
	for (const raw of pathValue.split(";")) {
		const entry = raw.trim().replaceAll('"', "");
		if (!entry) continue;
		const key = entry.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		if (
			isDrivePath(entry) &&
			entry.slice(0, 2).toLowerCase() === programFilesDrive
		) {
			kept.push(entry);
		} else {
			skipped.push(entry);
		}
	}
	return { kept, skipped };
}

export async function resolveWindowsShell(
	baseEnv: Record<string, string>,
	overrideShell: string | undefined,
	fs: WindowsShellFs = nodeFs,
): Promise<ShellResolution> {
	const pathValue = getEnvCaseInsensitive(baseEnv, "PATH");
	const programFiles = getEnvCaseInsensitive(baseEnv, "ProgramFiles");
	const localAppData = getEnvCaseInsensitive(baseEnv, "LOCALAPPDATA");
	if (!pathValue) return refuseMissingEnv("PATH");
	if (!programFiles) return refuseMissingEnv("ProgramFiles");
	if (!localAppData) return refuseMissingEnv("LOCALAPPDATA");

	if (overrideShell) return resolveOverride(overrideShell, fs);

	if (!isDrivePath(programFiles)) {
		return refuse(
			`Can't look for PowerShell 7: ProgramFiles is not a drive path (${programFiles}). Restart the app.`,
		);
	}
	const { kept, skipped } = splitPathEntries(
		pathValue,
		programFiles.slice(0, 2).toLowerCase(),
	);

	const candidates: Array<{ path: string; source: ShellSource }> = [
		{
			path: path.win32.join(programFiles, "PowerShell", "7", "pwsh.exe"),
			source: "install",
		},
		{
			path: path.win32.join(
				programFiles,
				"PowerShell",
				"7-preview",
				"pwsh.exe",
			),
			source: "install",
		},
		...kept.map((entry) => ({
			path: path.win32.join(entry, "pwsh.exe"),
			source: "path" as const,
		})),
		...STORE_FAMILIES.map((family) => ({
			path: path.win32.join(
				localAppData,
				"Microsoft",
				"WindowsApps",
				family,
				"pwsh.exe",
			),
			source: "store" as const,
		})),
	];

	const checked: string[] = [];
	const unclear: string[] = [];
	const seen = new Set<string>();
	for (const candidate of candidates) {
		const key = candidate.path.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		checked.push(candidate.path);
		const check = await checkFile(candidate.path, fs);
		if (check.kind === "found") return found(candidate.path, candidate.source);
		if (check.kind === "unclear") {
			console.warn(
				`[terminal] shell candidate unclear: ${candidate.path} (${check.reason})`,
			);
			unclear.push(`${candidate.path} (${check.reason})`);
		}
	}

	if (unclear.length > 0) {
		return refuse(
			`PowerShell 7 could not be checked, so this terminal was not started: ${unclear.join("; ")}. Fix the path or set SUPERSET_TERMINAL_SHELL, then restart the app.`,
		);
	}

	const comspec = getEnvCaseInsensitive(baseEnv, "COMSPEC");
	if (!comspec) {
		return refuse(
			"PowerShell 7 not found and the COMSPEC environment variable is not set. Restart the app.",
		);
	}
	if (!loggedAbsent) {
		loggedAbsent = true;
		console.warn("[terminal] PowerShell 7 not found; using COMSPEC", {
			shell: comspec,
			checked,
			skipped,
		});
	}
	return { kind: "absent", shell: comspec, checked, skipped };
}

const CMD_FALLBACK_NOTICE_ENV = "SUPERSET_SHELL_FALLBACK_NOTICE";

export function buildCmdFallbackLaunch(skipped: readonly string[]): {
	argv: string[];
	env: Record<string, string>;
} {
	const skippedText =
		skipped.length > 0 ? ` Skipped PATH entries: ${skipped.join("; ")}.` : "";
	const notice = `PowerShell 7 not found, using cmd.exe.${skippedText} Install PowerShell 7, or set SUPERSET_TERMINAL_SHELL and restart the app.`;
	return {
		argv: [
			"/K",
			`echo(%${CMD_FALLBACK_NOTICE_ENV}%&set ${CMD_FALLBACK_NOTICE_ENV}=`,
		],
		env: {
			[CMD_FALLBACK_NOTICE_ENV]: `\x1b[90m${notice.replace(/[\^&|<>"]/g, "^$&")}\x1b[0m`,
		},
	};
}
