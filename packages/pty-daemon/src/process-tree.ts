import { execFile, spawnSync } from "node:child_process";

export const IS_WINDOWS = process.platform === "win32";

/** Name of the enumerator behind readProcessTable*, for accurate log lines. */
export const PROCESS_TABLE_READER_NAME = IS_WINDOWS
	? "process enumeration"
	: "ps";

export interface ProcessInfo {
	pid: number;
	ppid: number;
	pgid: number;
	/** Controlling terminal name as ps reports it (e.g. "ttys012"), or null for none ("??"). */
	tty: string | null;
	/**
	 * (WIN-PROCESS-TREE) Process start time as UTC `yyyyMMddHHmmss` (second
	 * resolution, numeric so it compares directly). Windows rows carry it —
	 * it is the only thing that makes a ppid walk pid-reuse-safe there. POSIX
	 * rows leave it null; POSIX gets its safety from process groups + tty.
	 */
	startedAt?: number | null;
}

export interface ProcessSignalError {
	target: "pid" | "pgid";
	id: number;
	signal: NodeJS.Signals;
	error: unknown;
}

export interface ProcessSignalTarget {
	target: "pid" | "pgid";
	id: number;
}

export interface SignalProcessTreeAndGroupsOptions {
	/**
	 * When false, skip the root pid and its process group. node-pty will
	 * deliver the signal to its own child separately; we only need to handle
	 * descendants and any detached process groups they spawned.
	 */
	includeRoot?: boolean;
	signalGroups?: boolean;
	signalPids?: boolean;
	excludeCurrentProcessGroup?: boolean;
	/**
	 * Also target live processes whose controlling terminal matches — catches
	 * descendants that reparented to pid 1 in a new process group but kept
	 * the session's tty.
	 */
	ttyName?: string | null;
	/**
	 * Also target live members of these process groups — groups recorded on
	 * earlier kill passes. A ppid walk can't rediscover a group once its
	 * last tree-reachable member died, but reparented stragglers keep it.
	 */
	knownPgids?: ReadonlySet<number>;
	/**
	 * Pre-read process table. Pass one (from readProcessTableAsync) when
	 * calling from the daemon's async paths — the sync fallback blocks the
	 * event loop for the duration of a ps spawn.
	 */
	table?: ProcessInfo[];
	onSignalError?: (error: ProcessSignalError) => void;
}

export function signalProcessTreeAndGroups(
	rootPid: number,
	signal: NodeJS.Signals,
	options: SignalProcessTreeAndGroupsOptions = {},
): ProcessSignalTarget[] {
	const targets = collectProcessSignalTargets(rootPid, options);
	signalProcessTargets(targets, signal, options.onSignalError);
	return targets;
}

export function collectProcessSignalTargets(
	rootPid: number,
	options: SignalProcessTreeAndGroupsOptions = {},
): ProcessSignalTarget[] {
	if (!isPositiveInteger(rootPid)) return [];

	// (WIN-PROCESS-TREE) Everything below this line is POSIX: process groups,
	// controlling terminals and pgid signalling do not exist on Windows, so a
	// Windows caller is routed to the ppid walk that does.
	//
	// The empty-table fallback is NOT a detail: this function's synchronous
	// callers get an empty table on Windows (readProcessTable has no sync
	// implementation there), and at HEAD that empty table still produced one
	// target — the root pid, which `process.kill` terminates perfectly well on
	// Windows. Returning nothing instead would have turned "kills at least the
	// root" into "kills nothing", silently breaking every synchronous caller
	// (the daemon supervisor's terminate path, clean-shell-env's timeout).
	// Degenerate is acceptable; a no-op is not.
	if (IS_WINDOWS) {
		const includeWindowsRoot = options.includeRoot ?? true;
		const table = options.table ?? readProcessTable();
		if (table.length === 0) {
			// signalPids is honoured here for the same reason includeRoot is: at
			// HEAD a caller passing signalPids:false got NOTHING from an empty
			// table (the pid loop was gated on it), and the only such caller is
			// the v1 terminal-host stack, where node-pty's own kill is meant to
			// be the sole path to the root. Emitting a pid target regardless
			// would hard-kill a root that HEAD deliberately left alone.
			const signalPids = options.signalPids ?? true;
			return includeWindowsRoot && signalPids
				? [{ target: "pid", id: rootPid }]
				: [];
		}
		return collectWindowsSignalTargets(rootPid, {
			table,
			includeRoot: includeWindowsRoot,
		});
	}

	const includeRoot = options.includeRoot ?? true;
	const signalGroups = options.signalGroups ?? true;
	const signalPids = options.signalPids ?? true;
	const excludeCurrentProcessGroup = options.excludeCurrentProcessGroup ?? true;
	const table = options.table ?? readProcessTable();
	// Protected set: our own process group AND every ancestor's pid + group.
	// A kill target's tree never legitimately contains the caller's shell,
	// terminal, test runner, or CI job — but group collisions (a tree member
	// that never called setsid) can put them in a target pgid, and one killpg
	// then takes out the invoking session. This has SIGKILLed developer
	// shells; treat the ancestor chain as untouchable.
	const protectedPids = new Set<number>();
	const protectedPgids = new Set<number>();
	if (excludeCurrentProcessGroup) {
		const infoByPidForAncestors = new Map(table.map((row) => [row.pid, row]));
		let cursor: number | undefined = process.pid;
		while (cursor !== undefined && cursor > 1 && !protectedPids.has(cursor)) {
			protectedPids.add(cursor);
			const row = infoByPidForAncestors.get(cursor);
			if (!row) break;
			if (row.pgid > 1) protectedPgids.add(row.pgid);
			cursor = row.ppid;
		}
	}
	const rootPgid = getProcessGroupId(rootPid, table);
	const pids = collectProcessTree(rootPid, table);
	for (const pid of protectedPids) pids.delete(pid);
	for (const row of table) {
		if (pids.has(row.pid)) continue;
		if (row.pid === process.pid) continue;
		if (protectedPids.has(row.pid)) continue;
		if (protectedPgids.has(row.pgid)) continue;
		const onSessionTty = options.ttyName != null && row.tty === options.ttyName;
		const inKnownGroup = options.knownPgids?.has(row.pgid) ?? false;
		if (onSessionTty || inKnownGroup) pids.add(row.pid);
	}
	const infoByPid = new Map(table.map((row) => [row.pid, row]));
	const pgids = new Set<number>();
	const targets: ProcessSignalTarget[] = [];

	for (const pid of pids) {
		if (!includeRoot && pid === rootPid) continue;
		const info = infoByPid.get(pid);
		if (!info) continue;
		if (info.pgid <= 1) continue;
		if (protectedPgids.has(info.pgid)) continue;
		if (!includeRoot && rootPgid !== null && info.pgid === rootPgid) {
			continue;
		}
		pgids.add(info.pgid);
	}

	if (signalGroups) {
		for (const pgid of pgids) {
			targets.push({ target: "pgid", id: pgid });
		}
	}

	if (signalPids) {
		for (const pid of pids) {
			if (!includeRoot && pid === rootPid) continue;
			targets.push({ target: "pid", id: pid });
		}
	}

	return targets;
}

export function signalProcessTargets(
	targets: ProcessSignalTarget[],
	signal: NodeJS.Signals,
	onSignalError?: (error: ProcessSignalError) => void,
): void {
	for (const { target, id } of targets) {
		signalTarget(target, id, signal, onSignalError);
	}
}

const PS_TABLE_ARGS = ["-axo", "pid=,ppid=,pgid=,tty=,stat="];
// Bound every ps: a hung ps (stale NFS mount, kernel proc stalls) must fail
// the read, not wedge the kill chain or the daemon shutdown drain.
const PS_TIMEOUT_MS = 5_000;

// =============================================================================
// (WIN-PROCESS-TREE) Windows process enumeration
//
// Windows has no `ps`, no process groups and no controlling terminal, so every
// POSIX mechanism this module is built on is unavailable: killing a session
// signalled only the root pid and orphaned its whole subtree (measured on the
// owner's machine: 287 "final ps failed, survivor state unknown" lines in one
// pty-daemon.log — every one of them a leaked subtree the daemon could not
// even see). The replacement is a ppid walk over a CIM snapshot, made
// pid-reuse-safe by process start times.
//
// Why PowerShell/CIM and not `taskkill /PID <pid> /T /F`: taskkill resolves
// the tree from the same ppid field but does no creation-time check, so a
// recycled pid whose stale ParentProcessId happens to name our root is killed
// as if it were ours — with no way for us to see or report it. Enumerating
// ourselves costs one spawn and buys the reuse guard plus an accurate survivor
// report. `wmic` (the cheaper enumerator) is removed from current Windows 11
// builds, so Windows PowerShell 5.1 + Get-CimInstance is the portable choice.
// =============================================================================

/** Windows rows have no process group; 0 is rejected by the POSIX pgid logic. */
const WINDOWS_NO_PGID = 0;
// PowerShell startup dominates this; it is generously bounded rather than
// tuned, and every caller treats a timeout as "unknown", never as "empty".
const WINDOWS_ENUM_TIMEOUT_MS = 10_000;
const WINDOWS_ENUM_MAX_BUFFER = 4 * 1024 * 1024;
const WINDOWS_ROW_EXPR =
	"$s = if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('yyyyMMddHHmmss') } else { '' }; " +
	"'{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $s";

function windowsEnumScript(pid?: number): string {
	const filter =
		pid === undefined ? "" : ` -Filter "ProcessId=${Math.trunc(pid)}"`;
	return `Get-CimInstance Win32_Process${filter} | ForEach-Object { ${WINDOWS_ROW_EXPR} }`;
}

function windowsPowerShellPath(): string {
	const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
	return systemRoot
		? `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
		: "powershell.exe";
}

function readWindowsRows(pid?: number): Promise<ProcessInfo[] | null> {
	return new Promise((resolve) => {
		execFile(
			windowsPowerShellPath(),
			["-NoProfile", "-NonInteractive", "-Command", windowsEnumScript(pid)],
			{
				encoding: "utf8",
				timeout: WINDOWS_ENUM_TIMEOUT_MS,
				maxBuffer: WINDOWS_ENUM_MAX_BUFFER,
				windowsHide: true,
			},
			(error, stdout) => {
				resolve(error ? null : parseWindowsProcessTable(stdout));
			},
		);
	});
}

export function parseWindowsProcessTable(stdout: string): ProcessInfo[] {
	return stdout
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.flatMap((line) => {
			const [pidText, ppidText, startedText] = line.split(/\s+/);
			const pid = Number(pidText);
			const ppid = Number(ppidText);
			if (!isPositiveInteger(pid)) return [];
			if (!Number.isInteger(ppid) || ppid < 0) return [];
			const started =
				startedText === undefined || startedText === ""
					? Number.NaN
					: Number(startedText);
			return [
				{
					pid,
					ppid,
					pgid: WINDOWS_NO_PGID,
					tty: null,
					startedAt: isPositiveInteger(started) ? started : null,
				},
			];
		});
}

/**
 * Start time of a live process, or null if it cannot be read. Windows only —
 * this is the anchor a later tree walk checks the root pid against.
 */
export function getProcessStartTime(pid: number): Promise<number | null> {
	if (!IS_WINDOWS || !isPositiveInteger(pid)) return Promise.resolve(null);
	return readWindowsRows(pid).then(
		(rows) => rows?.find((row) => row.pid === pid)?.startedAt ?? null,
	);
}

export interface WindowsSignalTargetOptions {
	/** Snapshot from readProcessTableAsync. */
	table: ProcessInfo[];
	/**
	 * The root's start time, captured while the session was provably alive.
	 * Omit it only when no capture ever succeeded — the walk is then still
	 * ppid-correct but cannot prove the root pid is still OUR root.
	 */
	rootStartedAt?: number | null;
	includeRoot?: boolean;
}

/**
 * Descendants of `rootPid` on Windows, guarded against pid reuse.
 *
 * Windows never reparents: a child keeps its ParentProcessId after its parent
 * dies, and that pid is immediately available for reuse. Two rules keep this
 * walk from terminating a stranger:
 *
 *  1. the root row must still carry the start time captured when the session
 *     opened. A different stamp means our shell is gone and this pid belongs
 *     to someone else, so NOTHING is targeted;
 *  2. a candidate child must have started at or after its parent. A process
 *     that predates its "parent" cannot be its child — it is an orphan whose
 *     real parent died and whose pid was recycled.
 *
 * A candidate whose start time is unreadable is not targeted at all: the tree
 * kill fails safe (leaks a process, which is visible in the survivor report)
 * rather than killing an unrelated one.
 */
export function collectWindowsSignalTargets(
	rootPid: number,
	options: WindowsSignalTargetOptions,
): ProcessSignalTarget[] {
	if (!isPositiveInteger(rootPid)) return [];
	const rootRow = options.table.find((row) => row.pid === rootPid);
	if (!rootRow) return [];

	const anchor = options.rootStartedAt ?? null;
	// Unknown-vs-known mismatch is as disqualifying as a wrong stamp: without
	// proof of identity we must not walk a pid that may have been recycled.
	if (anchor !== null && rootRow.startedAt !== anchor) return [];

	const childrenByParent = new Map<number, ProcessInfo[]>();
	for (const row of options.table) {
		const children = childrenByParent.get(row.ppid) ?? [];
		children.push(row);
		childrenByParent.set(row.ppid, children);
	}

	const seen = new Set<number>([rootPid]);
	const descendants: number[] = [];
	const queue: ProcessInfo[] = [rootRow];
	for (const parent of queue) {
		if (parent.startedAt == null) continue;
		for (const child of childrenByParent.get(parent.pid) ?? []) {
			if (seen.has(child.pid)) continue;
			if (child.pid === process.pid) continue;
			if (child.startedAt == null) continue;
			if (child.startedAt < parent.startedAt) continue;
			seen.add(child.pid);
			descendants.push(child.pid);
			queue.push(child);
		}
	}

	const pids = options.includeRoot ? [rootPid, ...descendants] : descendants;
	return pids.map((id) => ({ target: "pid" as const, id }));
}

/**
 * Re-target descendants a previous pass already identified.
 *
 * The ppid walk starts at the root, so the moment the root row leaves the
 * snapshot it can see nothing — and a detached descendant, or one that opened
 * its own console (so it is not in the conpty's console process list either),
 * outlives the root routinely. Without this the escalation chain would report
 * a clean kill over a live subtree. POSIX has no equivalent hole because it
 * re-finds those stragglers by known pgid or controlling tty.
 *
 * Each latched entry is re-checked against its recorded start time, so a
 * recycled pid is dropped rather than terminated.
 */
export function collectWindowsLatchedTargets(
	latched: ReadonlyMap<number, number>,
	table: ProcessInfo[],
): ProcessSignalTarget[] {
	const byPid = new Map(table.map((row) => [row.pid, row]));
	const targets: ProcessSignalTarget[] = [];
	for (const [pid, startedAt] of latched) {
		if (pid === process.pid) continue;
		const row = byPid.get(pid);
		if (!row) continue;
		if (row.startedAt !== startedAt) continue;
		targets.push({ target: "pid", id: pid });
	}
	return targets;
}

/**
 * Warn once, not per call: the sync path is hit on every kill and the log this
 * feature exists to clean up already carried 287 lines of exactly one message.
 */
let warnedSyncTableUnavailable = false;
export function readProcessTable(): ProcessInfo[] {
	if (IS_WINDOWS) {
		// (WIN-PROCESS-TREE) There is no sync enumerator we may use here: a
		// synchronous PowerShell spawn freezes the daemon's only event loop
		// for ~half a second, stalling every session in the org (see
		// no-daemon-loop-blocking.test.ts). Windows callers that want the real
		// tree must go through readProcessTableAsync +
		// collectWindowsSignalTargets; an empty table from here means UNKNOWN
		// and must never be read as "nothing is running".
		if (!warnedSyncTableUnavailable) {
			warnedSyncTableUnavailable = true;
			process.stderr.write(
				"[pty-daemon] readProcessTable() has no synchronous Windows implementation — " +
					"callers fall back to signalling the root pid alone (descendants are not reaped); " +
					"use readProcessTableAsync() for the real tree\n",
			);
		}
		return [];
	}
	const result = spawnSync("ps", PS_TABLE_ARGS, {
		encoding: "utf8",
		timeout: PS_TIMEOUT_MS,
	});
	if (result.error || result.status !== 0) return [];
	return parseProcessTable(result.stdout);
}

/**
 * (WIN-PROCESS-TREE) In-flight coalescing for the Windows enumerator.
 *
 * Each enumeration spawns Windows PowerShell and costs ~590ms, and every
 * session's kill chain enumerates independently — six times per session (five
 * escalation rounds plus the final survivor check). Closing a workspace with
 * ten terminals therefore spawned sixty PowerShell processes. Callers that ask
 * while a read is already running now JOIN it instead of starting another.
 *
 * This is single-flight, deliberately NOT a time-to-live cache: joiners get a
 * snapshot taken at the same moment they asked, which is exactly what an
 * independent read would have given them, so it cannot serve anyone a staler
 * view than before. A TTL could hand a caller a table predating a process it
 * just signalled, which is precisely the "concluded the kill was complete"
 * mistake the null-means-unknown rule elsewhere in this file exists to prevent.
 */
let inFlightWindowsRead: Promise<ProcessInfo[] | null> | null = null;

/**
 * Resolves null when ps itself fails — callers making liveness decisions
 * (e.g. "no survivors, stop escalating") must treat null as unknown, never
 * as an empty table.
 */
export function readProcessTableAsync(): Promise<ProcessInfo[] | null> {
	if (IS_WINDOWS) {
		if (inFlightWindowsRead) return inFlightWindowsRead;
		// An enumeration that succeeds and lists zero processes is impossible
		// on a running machine, so it is a failed read (UNKNOWN) — never an
		// empty table a caller could read as "nothing survived".
		const read = readWindowsRows()
			.then((rows) => (rows && rows.length > 0 ? rows : null))
			.finally(() => {
				inFlightWindowsRead = null;
			});
		inFlightWindowsRead = read;
		return read;
	}
	return new Promise((resolve) => {
		execFile(
			"ps",
			PS_TABLE_ARGS,
			{ encoding: "utf8", timeout: PS_TIMEOUT_MS },
			(error, stdout) => {
				resolve(error ? null : parseProcessTable(stdout));
			},
		);
	});
}

export function parseProcessTable(stdout: string): ProcessInfo[] {
	return stdout
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.flatMap((line) => {
			const [pidText, ppidText, pgidText, ttyText, statText] =
				line.split(/\s+/);
			if (
				pidText === undefined ||
				ppidText === undefined ||
				pgidText === undefined
			) {
				return [];
			}
			// Zombies are unkillable and childless (their children already
			// reparented); including them would make verify passes see
			// permanent "survivors".
			if (statText?.startsWith("Z")) return [];
			const pid = Number(pidText);
			const ppid = Number(ppidText);
			const pgid = Number(pgidText);
			if (!isPositiveInteger(pid) || !Number.isInteger(ppid) || ppid < 0) {
				return [];
			}
			if (!isPositiveInteger(pgid)) return [];
			return [{ pid, ppid, pgid, tty: normalizeTtyName(ttyText) }];
		});
}

/**
 * Process group + controlling terminal of a process (tty e.g. "ttys012",
 * null if none). Captured at session spawn so later kill passes can target
 * stragglers by group membership or tty after the ppid tree is gone.
 * Async on purpose: this runs on the daemon's session-open path, where a
 * spawnSync would stall every session's output for the ps duration.
 */
export function getProcessGroupAndTty(
	pid: number,
): Promise<{ pgid: number | null; tty: string | null }> {
	if (!isPositiveInteger(pid))
		return Promise.resolve({ pgid: null, tty: null });
	// (WIN-PROCESS-TREE) Windows has neither coordinate, and spawning a `ps`
	// that cannot exist on every session open is pure cost. The Windows
	// equivalent anchor is getProcessStartTime.
	if (IS_WINDOWS) return Promise.resolve({ pgid: null, tty: null });
	return new Promise((resolve) => {
		execFile(
			"ps",
			["-o", "pgid=,tty=", "-p", String(pid)],
			{ encoding: "utf8", timeout: PS_TIMEOUT_MS },
			(error, stdout) => {
				if (error) return resolve({ pgid: null, tty: null });
				const [pgidText, ttyText] = stdout.trim().split(/\s+/);
				const pgid = Number(pgidText);
				resolve({
					pgid: isPositiveInteger(pgid) ? pgid : null,
					tty: normalizeTtyName(ttyText),
				});
			},
		);
	});
}

function normalizeTtyName(raw: string | undefined): string | null {
	if (!raw) return null;
	// ps prints "??" (macOS) or "?" (Linux) for processes with no
	// controlling terminal; "-" shows up in some BSD ps variants.
	if (raw === "??" || raw === "?" || raw === "-") return null;
	return raw;
}

/**
 * Whether a foreground command (something other than the shell's own prompt) is
 * currently running in the shell's controlling terminal.
 *
 * Uses the tty's foreground process group (`tpgid`): at an idle prompt it equals
 * the shell's own process group; while a command runs in the foreground the
 * shell has handed the terminal to the command's group, so they differ. This is
 * precise — unlike a "shell has descendants" check it does not false-positive on
 * suspended or background jobs. Fails closed (returns false) on any ps error.
 */
export function hasRunningForegroundProcess(shellPid: number): boolean {
	if (!isPositiveInteger(shellPid)) return false;
	// (WIN-PROCESS-TREE) Known Windows gap, unchanged in effect: there is no
	// tty foreground process group to compare against, so this already
	// answered false (via a `ps` that cannot run). Returning early only drops
	// the doomed synchronous spawn from every caller.
	if (IS_WINDOWS) return false;

	const result = spawnSync(
		"ps",
		["-o", "tpgid=", "-o", "pgid=", "-p", String(shellPid)],
		{ encoding: "utf8" },
	);
	if (result.error || result.status !== 0) return false;

	const [tpgidText, pgidText] = result.stdout.trim().split(/\s+/);
	const tpgid = Number(tpgidText);
	const pgid = Number(pgidText);
	if (!isPositiveInteger(tpgid) || !isPositiveInteger(pgid)) return false;

	return tpgid !== pgid;
}

export function collectProcessTree(
	rootPid: number,
	table: ProcessInfo[],
): Set<number> {
	const pids = new Set<number>([rootPid]);
	const childrenByParent = new Map<number, ProcessInfo[]>();
	for (const row of table) {
		const children = childrenByParent.get(row.ppid) ?? [];
		children.push(row);
		childrenByParent.set(row.ppid, children);
	}

	const queue = [rootPid];
	for (const pid of queue) {
		for (const child of childrenByParent.get(pid) ?? []) {
			if (pids.has(child.pid)) continue;
			pids.add(child.pid);
			queue.push(child.pid);
		}
	}

	return pids;
}

export function getProcessGroupId(
	pid: number,
	table: ProcessInfo[],
): number | null {
	return table.find((row) => row.pid === pid)?.pgid ?? null;
}

export function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function signalTarget(
	target: "pid" | "pgid",
	id: number,
	signal: NodeJS.Signals,
	onSignalError: SignalProcessTreeAndGroupsOptions["onSignalError"],
): void {
	try {
		process.kill(target === "pgid" ? -id : id, signal);
	} catch (error) {
		onSignalError?.({ target, id, signal, error });
	}
}
