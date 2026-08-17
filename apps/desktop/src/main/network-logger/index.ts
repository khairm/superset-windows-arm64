import fs from "node:fs";
import path from "node:path";
import { app, session } from "electron";
import {
	CAPTURE_MODE,
	CURRENT_FILE,
	DISABLED_MESSAGE,
	isNetworkLoggingEnabled,
	MAX_FILE_BYTES,
	MAX_RETAINED_SESSIONS,
	NETWORK_LOG_ENV,
	purgeNetworkLogs,
	SESSION_PREFIX,
	SESSION_SUFFIX,
} from "./policy";

const PARTITION = "persist:superset";

let started = false;
let purged = false;

function logsDir(): string {
	const dir = path.join(app.getPath("userData"), "network-logs");
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

/**
 * (NETLOG-OFF) Everything already on disk was written in the `includeSensitive`
 * mode, so it is deleted at boot whether or not logging is enabled this run.
 * Never creates the directory — if it is absent there is nothing to purge.
 */
function purgeSensitiveLogsOnce(): void {
	if (purged) return;
	purged = true;
	const dir = path.join(app.getPath("userData"), "network-logs");
	const { removed, failed } = purgeNetworkLogs(dir, {
		exists: (d) => fs.existsSync(d),
		readdir: (d) => fs.readdirSync(d),
		unlink: (f) => fs.unlinkSync(f),
		join: (d, name) => path.join(d, name),
	});
	if (removed > 0 || failed > 0) {
		console.log(
			`[network-logger] purged ${removed} pre-existing log file(s)${failed > 0 ? `, ${failed} could not be removed (in use)` : ""}`,
		);
	}
}

function archivePreviousSession(): void {
	const dir = logsDir();
	const currentPath = path.join(dir, CURRENT_FILE);
	if (!fs.existsSync(currentPath)) return;
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const archivedPath = path.join(
		dir,
		`${SESSION_PREFIX}${stamp}${SESSION_SUFFIX}`,
	);
	fs.renameSync(currentPath, archivedPath);
	finalizeIfNeeded(archivedPath);
}

const EVENT_ARRAY_MARKER = Buffer.from('"events":[');
const EVENT_BOUNDARY = Buffer.from("},\n");
const CLOSING = Buffer.from("\n]}");

function finalizeIfNeeded(filePath: string): void {
	const stats = fs.statSync(filePath);
	if (stats.size < 4) return;
	const tailWindow = Math.min(stats.size, 8 * 1024);
	const buffer = Buffer.alloc(tailWindow);
	const fd = fs.openSync(filePath, "r+");
	try {
		fs.readSync(fd, buffer, 0, tailWindow, stats.size - tailWindow);
		if (buffer.toString("utf8").trimEnd().endsWith("]}")) return;
		const lastBoundary = buffer.lastIndexOf(EVENT_BOUNDARY);
		if (lastBoundary === -1) return;
		const eventsMarker = buffer.indexOf(EVENT_ARRAY_MARKER);
		if (eventsMarker !== -1 && lastBoundary < eventsMarker) return;
		const truncateAt = stats.size - tailWindow + lastBoundary + 1;
		fs.ftruncateSync(fd, truncateAt);
		fs.writeSync(fd, CLOSING, 0, CLOSING.length, truncateAt);
	} finally {
		fs.closeSync(fd);
	}
}

function pruneOldSessions(): void {
	const dir = logsDir();
	const files = fs
		.readdirSync(dir)
		.filter(
			(name) =>
				name.startsWith(SESSION_PREFIX) && name.endsWith(SESSION_SUFFIX),
		)
		.map((name) => ({
			name,
			mtimeMs: fs.statSync(path.join(dir, name)).mtimeMs,
		}))
		.sort((a, b) => b.mtimeMs - a.mtimeMs);
	for (const stale of files.slice(MAX_RETAINED_SESSIONS)) {
		try {
			fs.unlinkSync(path.join(dir, stale.name));
		} catch {
			// Best-effort
		}
	}
}

/**
 * (NETLOG-OFF) The gate lives HERE rather than at the call site in main/index.ts:
 * that boot sequence churns on every upstream merge, so a kill placed there is
 * one conflict resolution away from disappearing. Same reasoning as
 * FORK_AUTO_UPDATE_DISABLED inside auto-updater.ts.
 */
export async function startNetworkLogger(): Promise<void> {
	if (started) return;
	purgeSensitiveLogsOnce();
	if (!isNetworkLoggingEnabled(process.env)) {
		console.log(DISABLED_MESSAGE);
		return;
	}
	archivePreviousSession();
	pruneOldSessions();
	const logPath = path.join(logsDir(), CURRENT_FILE);
	await session.fromPartition(PARTITION).netLog.startLogging(logPath, {
		captureMode: CAPTURE_MODE,
		maxFileSize: MAX_FILE_BYTES,
	});
	started = true;
	console.log(
		`[network-logger] recording to ${logPath} (captureMode=${CAPTURE_MODE}, enabled by ${NETWORK_LOG_ENV}). This file contains full request URLs — delete it when you are done.`,
	);
}

export async function stopNetworkLogger(): Promise<void> {
	if (!started) return;
	try {
		await session.fromPartition(PARTITION).netLog.stopLogging();
		started = false;
	} catch (error) {
		console.warn("[network-logger] stopLogging failed:", error);
	}
}
