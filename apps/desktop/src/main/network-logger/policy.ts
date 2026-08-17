/**
 * (NETLOG-OFF) network-logger policy — pure logic, no electron import, so it is
 * unit-testable.
 *
 * WHY THIS EXISTS: upstream starts `netLog.startLogging` unconditionally at boot
 * with `captureMode: "includeSensitive"` and a 1 GB cap, retaining 3 sessions.
 * That records the app's FULL network traffic — URLs with query strings and
 * fragments, request/response headers, cookies — as plain JSON under
 * `%APPDATA%/Superset/network-logs`. On one machine a single session file
 * reached 1,014 MB, holding bearer tokens, the Cloudflare Access cookie and
 * potentially the companion pairing code (which travels in a URL FRAGMENT) in
 * cleartext. That directly contradicts (EGRESS-FENCE), which logs ORIGIN ONLY
 * for exactly this reason.
 *
 * THE RULE: OFF unless the maintainer explicitly asks for it, and even then
 * never in the sensitive mode. `includeSensitive` is deliberately NOT reachable
 * by any environment variable — re-enabling it must be a code change someone
 * reviews, not a variable someone exports and forgets.
 */

/** Set to "1" or "true" to record network logs. Anything else = off. */
export const NETWORK_LOG_ENV = "SUPERSET_NETWORK_LOG";

/**
 * `default` excludes cookies, authorization headers and bodies. Even so the log
 * still carries full URLs, which is why this whole thing is opt-in.
 */
export const CAPTURE_MODE = "default" as const;

/** 64 MB, down from upstream's 1 GB. A debug aid, not an archive. */
export const MAX_FILE_BYTES = 64 * 1024 * 1024;

export const MAX_RETAINED_SESSIONS = 3;

export const CURRENT_FILE = "current.json";
export const SESSION_PREFIX = "session-";
export const SESSION_SUFFIX = ".json";

export function isNetworkLoggingEnabled(
	env: Record<string, string | undefined>,
): boolean {
	const raw = env[NETWORK_LOG_ENV];
	if (raw === undefined) return false;
	const value = raw.trim().toLowerCase();
	return value === "1" || value === "true";
}

/** The one line printed when logging is off, so the capability stays findable. */
export const DISABLED_MESSAGE = `[network-logger] OFF (records full URLs, headers and cookies to disk). Set ${NETWORK_LOG_ENV}=1 to enable for a debugging session.`;

/**
 * Only the two filenames this module itself writes. A stray file a human put in
 * the directory is left alone — this purge deletes our own sensitive output, it
 * is not a directory cleaner.
 */
export function isPurgeableLogFile(name: string): boolean {
	if (name === CURRENT_FILE) return true;
	return name.startsWith(SESSION_PREFIX) && name.endsWith(SESSION_SUFFIX);
}

export interface PurgeIO {
	exists(dir: string): boolean;
	readdir(dir: string): string[];
	unlink(filePath: string): void;
	join(dir: string, name: string): string;
}

export interface PurgeResult {
	removed: number;
	failed: number;
}

/**
 * Deletes logs written before this gate existed — they are all in the sensitive
 * mode. Fail-soft on purpose: this runs at boot, and a locked or vanished file
 * must never stop the app from starting. The directory itself is never removed
 * (the logger mkdir's it on demand and callers assume it can exist).
 */
export function purgeNetworkLogs(dir: string, io: PurgeIO): PurgeResult {
	const result: PurgeResult = { removed: 0, failed: 0 };
	let names: string[];
	try {
		if (!io.exists(dir)) return result;
		names = io.readdir(dir);
	} catch {
		return result;
	}
	for (const name of names) {
		if (!isPurgeableLogFile(name)) continue;
		try {
			io.unlink(io.join(dir, name));
			result.removed++;
		} catch {
			result.failed++;
		}
	}
	return result;
}
