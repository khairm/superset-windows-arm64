/**
 * (DAEMON-UNCAUGHT-GUARD) Blast-radius containment for the daemon process.
 *
 * This process owns every live PTY on the machine. Node's default for an
 * uncaught exception (and, since Node 15, for an unhandled rejection) is to
 * print and exit — which here means EVERY terminal in EVERY workspace dies,
 * including all the ones that had nothing to do with the fault. That is not
 * theoretical: node-pty's Windows `kill(signal)` threw
 * `Signals not supported on windows.` from a conpty socket callback and took
 * the owner's whole daemon down twice in one log (see
 * (WIN-PTY-KILL-NOSIGNAL), which fixes that specific throw).
 *
 * DECISION: log the full stack loudly and KEEP RUNNING.
 *
 * The reasoning, stated plainly because "fail fast and loud" normally argues
 * the other way: exiting is the right default for a process whose state is
 * suspect and whose restart is cheap. This daemon is neither. Its entire
 * purpose is to be the durable owner of PTY master fds, and a restart cannot
 * recover them — the shells die with it, taking unsaved work in every
 * unrelated session. The realistic fault population here is per-session
 * (one adapter, one socket callback, one child process), so surviving costs
 * at most the one broken session, while exiting costs all of them. Loud is
 * preserved by the log line, not by the exit: every event is written to the
 * daemon log with its full stack under a greppable marker.
 *
 * The exception to the exception: a process that is throwing REPEATEDLY is no
 * longer suffering a per-session fault — it is in a state we cannot reason
 * about, and staying up burns CPU while faithfully doing nothing. Past
 * CRASH_BURST_LIMIT events inside CRASH_BURST_WINDOW_MS it exits non-zero and
 * lets the supervisor rebuild it.
 */

export const CRASH_BURST_LIMIT = 5;
export const CRASH_BURST_WINDOW_MS = 60_000;

export interface CrashGuardHooks {
	write?: (line: string) => void;
	exit?: (code: number) => void;
	/** Injectable clock so the burst window is testable without waiting. */
	now?: () => number;
}

function describe(error: unknown): string {
	if (error instanceof Error)
		return error.stack ?? `${error.name}: ${error.message}`;
	return String(error);
}

/**
 * The guard's decision function, with its own state so tests (and any future
 * second guard) don't share a counter with the installed one.
 */
export function createCrashRecorder(
	hooks: CrashGuardHooks = {},
): (kind: string, error: unknown) => void {
	const write = hooks.write ?? ((line: string) => process.stderr.write(line));
	const exit = hooks.exit ?? ((code: number) => process.exit(code));
	const now = hooks.now ?? (() => Date.now());
	const recent: number[] = [];

	return (kind, error) => {
		const at = now();
		while (
			recent.length > 0 &&
			at - (recent[0] as number) > CRASH_BURST_WINDOW_MS
		) {
			recent.shift();
		}
		recent.push(at);

		write(
			`[pty-daemon] UNCAUGHT ${kind} (${recent.length} in the last ` +
				`${CRASH_BURST_WINDOW_MS / 1000}s) — sessions kept alive: ${describe(error)}\n`,
		);

		if (recent.length > CRASH_BURST_LIMIT) {
			write(
				`[pty-daemon] UNCAUGHT ${kind} burst exceeded ${CRASH_BURST_LIMIT} in ` +
					`${CRASH_BURST_WINDOW_MS / 1000}s — daemon state is not trustworthy, exiting for a clean restart\n`,
			);
			exit(1);
		}
	};
}

/**
 * Install the guard. Call this FIRST in the daemon entry, before the server
 * binds, so a fault during startup is reported rather than silently fatal.
 */
export function installCrashGuard(hooks: CrashGuardHooks = {}): void {
	const record = createCrashRecorder(hooks);
	process.on("uncaughtException", (error) => {
		record("exception", error);
	});
	process.on("unhandledRejection", (reason) => {
		record("rejection", reason);
	});
}
