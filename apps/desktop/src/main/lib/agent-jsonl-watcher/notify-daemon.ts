import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import log from "electron-log/main";
import {
	SUPERSET_HOME_DIR,
	SUPERSET_SENSITIVE_FILE_MODE,
} from "../app-environment";

// (HOOK-HTTP-DAEMON) Supervisor for the long-lived `superset-notify.py` that
// serves Claude's lifecycle hooks over loopback HTTP.

export const NOTIFY_DAEMON_PORT = 46817;
export const NOTIFY_HOOK_URL_PATH = "/superset-notify/hook";
const NOTIFY_HEALTH_URL_PATH = "/superset-notify/health";
export const NOTIFY_SECRET_HEADER = "X-Superset-Notify-Secret";
export const NOTIFY_HOOK_TIMEOUT_SECONDS = 15;

const HEALTH_ATTEMPT_TIMEOUT_MS = 750;
const HEALTH_DEADLINE_MS = 15_000;
const HEALTH_RETRY_DELAY_MS = 150;
const RESTART_BACKOFF_MS = [500, 1_000, 2_000, 5_000, 10_000] as const;
const RESTART_BUDGET_RESET_MS = 300_000;
const EXIT_CODE_BIND_FAILED = 3;
const MAX_DAEMON_LOG_BYTES = 2_000_000;
const MAX_PENDING_LOG_CHUNKS = 64;
export const TRAFFIC_GRACE_MS = 20_000;
const TRAFFIC_POLL_MS = 5_000;
const SILENT_HEALTH_POLLS = 3;
// Claude re-reads settings.json through its own file watcher.
export const SETTINGS_RELOAD_MS = 60_000;
const TRAFFIC_UNPROVEN_LOG_MS = 600_000;
// Nothing has written a transcript in ten minutes: keep the watch armed for a
// session that starts later, at a tick the machine does not feel.
const TRAFFIC_IDLE_POLL_MS = 60_000;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{32,512}$/;
const SECRET_FILENAME = "notify-daemon.secret";
const STATE_FILENAME = "notify-daemon.json";

export interface NotifyDaemonInfo {
	readonly port: number;
	readonly secret: string;
	readonly pid: number;
}

interface NotifyDaemonHealth {
	readonly pid: number;
	readonly served: number;
}

export interface NotifyDaemonConfig {
	readonly pythonPath: string;
	readonly scriptPath: string;
	readonly hooksDir: string;
	readonly port: number;
	readonly secret: string;
	readonly onPermanentFailure?: () => void;
}

export function notifyHookUrl(port: number): string {
	return `http://127.0.0.1:${port}${NOTIFY_HOOK_URL_PATH}`;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms).unref?.();
	});
}

async function* pythonCandidatePaths(): AsyncGenerator<string> {
	const separator = process.platform === "win32" ? ";" : ":";
	const names =
		process.platform === "win32"
			? ["python.exe", "python3.exe"]
			: ["python3", "python"];
	for (const entry of (process.env.PATH ?? "").split(separator)) {
		const dir = entry.trim().replace(/^"(.*)"$/, "$1");
		if (!dir) continue;
		for (const name of names) {
			const candidate = path.join(dir, name);
			// A zero-byte match is Windows' Store "app execution alias" stub,
			// which opens the Microsoft Store instead of running anything.
			const stat = await fs.promises.stat(candidate).catch(() => null);
			if (stat?.isFile() && stat.size > 0) yield candidate;
		}
	}
}

function runPythonProbe(candidate: string): Promise<string | null> {
	return new Promise((resolve) => {
		const child = childProcess.spawn(
			candidate,
			["-I", "-S", "-c", "import sys;sys.stdout.write(sys.version.split()[0])"],
			{ stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
		);
		let out = "";
		const timer = setTimeout(() => child.kill(), 5_000);
		child.stdout?.on("error", () => {});
		child.stdout?.on("data", (chunk: Buffer) => {
			out = (out + chunk.toString("utf8")).slice(0, 64);
		});
		child.on("error", () => {
			clearTimeout(timer);
			resolve(null);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve(code === 0 && /^3\.\d+/.test(out.trim()) ? out.trim() : null);
		});
	});
}

let pythonPathPromise: Promise<string | null> | null = null;

export function resolvePythonPath(): Promise<string | null> {
	pythonPathPromise ??= (async () => {
		for await (const candidate of pythonCandidatePaths()) {
			const version = await runPythonProbe(candidate);
			if (version) {
				log.info(`[notify-daemon] using python ${version} at ${candidate}`);
				return candidate;
			}
		}
		return null;
	})();
	return pythonPathPromise;
}

function requestNotifyDaemonHealth(
	port: number,
	secret: string,
): Promise<NotifyDaemonHealth | null> {
	return new Promise((resolve) => {
		let settled = false;
		let bound: NodeJS.Timeout | null = null;
		const settle = (health: NotifyDaemonHealth | null): void => {
			if (settled) return;
			settled = true;
			if (bound) clearTimeout(bound);
			resolve(health);
		};
		const request = http.request(
			{
				host: "127.0.0.1",
				port,
				path: NOTIFY_HEALTH_URL_PATH,
				method: "GET",
				headers: { [NOTIFY_SECRET_HEADER]: secret },
				timeout: HEALTH_ATTEMPT_TIMEOUT_MS,
			},
			(response) => {
				let body = "";
				response.on("data", (chunk) => {
					body = (body + String(chunk)).slice(0, 512);
				});
				response.on("end", () => {
					if (response.statusCode !== 200) {
						settle(null);
						return;
					}
					try {
						const parsed = JSON.parse(body) as {
							ok?: unknown;
							pid?: unknown;
							served?: unknown;
						};
						settle(
							parsed.ok === true &&
								typeof parsed.pid === "number" &&
								typeof parsed.served === "number"
								? { pid: parsed.pid, served: parsed.served }
								: null,
						);
					} catch {
						settle(null);
					}
				});
			},
		);
		// (HOOK-HTTP-DAEMON) `destroy()` is not guaranteed to emit `error` — under
		// Bun it emits nothing at all against a peer that accepts and never
		// answers — so the deadline settles the promise itself.
		bound = setTimeout(() => {
			request.destroy();
			settle(null);
		}, HEALTH_ATTEMPT_TIMEOUT_MS);
		bound.unref?.();
		request.on("timeout", () => request.destroy());
		request.on("error", () => settle(null));
		request.end();
	});
}

class RotatingLog {
	private stream: fs.WriteStream | null = null;
	private bytes = 0;
	private pending: Buffer[] = [];
	private work: Promise<void> = Promise.resolve();
	private closed = false;
	private toAppLog = false;

	constructor(
		private readonly file: string,
		private readonly maxBytes: number,
	) {}

	open(): Promise<void> {
		this.work = this.work.then(() => this.reopen());
		return this.work;
	}

	write(chunk: Buffer): void {
		if (this.closed) return;
		if (this.toAppLog) {
			log.warn(`[notify-daemon] ${chunk.toString("utf8").trimEnd()}`);
			return;
		}
		this.bytes += chunk.length;
		if (this.stream) this.stream.write(chunk);
		else {
			this.pending.push(chunk);
			if (this.pending.length > MAX_PENDING_LOG_CHUNKS) this.pending.shift();
		}
		if (this.bytes > this.maxBytes) {
			this.bytes = 0;
			this.work = this.work.then(() => this.rotate());
		}
	}

	close(): void {
		this.closed = true;
		this.stream?.end();
		this.stream = null;
		this.pending = [];
	}

	private async rotate(): Promise<void> {
		if (this.closed) return;
		const stream = this.stream;
		this.stream = null;
		if (stream) await new Promise<void>((resolve) => stream.end(resolve));
		await this.reopen();
	}

	private async reopen(): Promise<void> {
		if (this.closed) return;
		try {
			const size = await fs.promises
				.stat(this.file)
				.then((entry) => entry.size)
				.catch((error: NodeJS.ErrnoException) => {
					if (error.code === "ENOENT") return 0;
					throw error;
				});
			if (size > this.maxBytes) {
				await fs.promises.rename(this.file, `${this.file}.1`);
				this.bytes = 0;
			} else {
				this.bytes = size;
			}
			const stream = fs.createWriteStream(this.file, { flags: "a" });
			stream.on("error", (error) =>
				log.warn(`[notify-daemon] writing ${this.file} failed`, error),
			);
			this.stream = stream;
			for (const chunk of this.pending.splice(0)) stream.write(chunk);
		} catch (error) {
			this.toAppLog = true;
			log.error(
				`[notify-daemon] cannot keep ${this.file}; daemon output goes to the app log instead`,
				error,
			);
			for (const chunk of this.pending.splice(0)) {
				log.warn(`[notify-daemon] ${chunk.toString("utf8").trimEnd()}`);
			}
		}
	}
}

/**
 * (HOOK-HTTP-DAEMON) Bumped when supervision ends for good and the hooks go
 * back to the command transport. That ends the traffic watch with it: a watch
 * that outlived the hand-back would keep polling a port nothing registers and
 * judge hook entries this instance has already replaced.
 */
let handBackToken = 0;

/**
 * (HOOK-HTTP-DAEMON) Sampled by a caller BEFORE the daemon it is about to
 * register exists, so a hand-back that lands while it is still mirroring the
 * http entries is visible to everything it arms afterwards.
 */
export function notifyHandBackToken(): number {
	return handBackToken;
}

export class NotifyDaemon {
	private child: childProcess.ChildProcess | null = null;
	private restarts = 0;
	private restartPending = false;
	private stopping = false;
	private gaveUp = false;
	private healthyAt = 0;
	private attemptStartedAt = 0;
	private servedSince = 0;
	private daemonLog: RotatingLog | null = null;
	private stateFileWritten = false;
	private secretFileWritten = false;

	constructor(private readonly config: NotifyDaemonConfig) {}

	get restartCount(): number {
		return this.restarts;
	}

	get servedSinceMs(): number {
		return this.servedSince;
	}

	async start(): Promise<NotifyDaemonInfo> {
		const pid = await this.spawnAndWaitForHealth();
		await this.writeStateFile(pid);
		return { port: this.config.port, secret: this.config.secret, pid };
	}

	async stop(): Promise<void> {
		this.stopping = true;
		this.child?.kill();
		this.child = null;
		this.closeDaemonLog();
		await this.removeFilesThisDaemonWrote();
	}

	private closeDaemonLog(): void {
		this.daemonLog?.close();
		this.daemonLog = null;
	}

	private async removeFilesThisDaemonWrote(): Promise<void> {
		const files: string[] = [];
		if (this.stateFileWritten) files.push(this.stateFile);
		if (this.secretFileWritten && !(await this.someoneElseServesOurSecret())) {
			files.push(this.secretFile);
		}
		this.stateFileWritten = false;
		this.secretFileWritten = false;
		await Promise.all(
			files.map((file) => fs.promises.rm(file, { force: true })),
		).catch((error) =>
			log.warn("[notify-daemon] could not remove daemon state", error),
		);
	}

	// (HOOK-HTTP-DAEMON) A daemon that never owned the port may have written the
	// secret file the daemon that DID own it is serving with, and deleting that
	// leaves a live daemon nothing on disk advertises.
	private async someoneElseServesOurSecret(): Promise<boolean> {
		if (this.healthyAt > 0) return false;
		const health = await requestNotifyDaemonHealth(
			this.config.port,
			this.config.secret,
		);
		return health !== null;
	}

	private get secretFile(): string {
		return path.join(this.config.hooksDir, SECRET_FILENAME);
	}

	private get stateFile(): string {
		return path.join(this.config.hooksDir, STATE_FILENAME);
	}

	private async writeStateFile(pid: number): Promise<void> {
		await writeOwnerOnly(
			this.stateFile,
			JSON.stringify({
				port: this.config.port,
				pid,
				secret: this.config.secret,
			}),
		);
		this.stateFileWritten = true;
	}

	// (HOOK-HTTP-DAEMON) A second Superset instance sharing this home carries
	// the same secret, and only a file it wrote itself is a file it may delete.
	private async writeSecretFileIfStale(): Promise<void> {
		const onDisk = await fs.promises
			.readFile(this.secretFile, "utf8")
			.catch((error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT") return null;
				throw error;
			});
		if (onDisk?.trim() === this.config.secret) return;
		await writeOwnerOnly(this.secretFile, this.config.secret);
		this.secretFileWritten = true;
	}

	private async spawnAndWaitForHealth(): Promise<number> {
		this.attemptStartedAt = Date.now();
		this.servedSince = this.attemptStartedAt;
		await fs.promises.mkdir(this.config.hooksDir, { recursive: true });
		await this.writeSecretFileIfStale();
		this.daemonLog = new RotatingLog(
			path.join(this.config.hooksDir, "notify-daemon.log"),
			MAX_DAEMON_LOG_BYTES,
		);
		await this.daemonLog.open();
		const daemonLog = this.daemonLog;
		const child = childProcess.spawn(
			this.config.pythonPath,
			[
				"-I",
				"-S",
				this.config.scriptPath,
				"--serve",
				String(this.config.port),
				"--secret-file",
				this.secretFile,
			],
			{
				detached: false,
				// The daemon exits on stdin EOF, so a force-killed Electron takes it.
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
			},
		);
		let launchError: Error | null = null;
		child.on("error", (error) => {
			launchError = error;
			log.error("[notify-daemon] failed to launch", error);
		});
		for (const source of [child.stdout, child.stderr]) {
			source?.on("error", () => {});
			source?.on("data", (chunk: Buffer) => daemonLog.write(chunk));
		}
		child.on("exit", (code, signal) => this.handleExit(child, code, signal));
		child.on("close", (code, signal) => this.handleExit(child, code, signal));
		// (HOOK-HTTP-DAEMON) A spawn that produced no process emits `error` and
		// `close` but never `exit`.
		if (!child.pid) {
			this.closeDaemonLog();
			throw new Error(`notify daemon did not spawn: ${this.config.pythonPath}`);
		}
		this.child = child;

		const deadline = Date.now() + HEALTH_DEADLINE_MS;
		while (Date.now() < deadline) {
			if (launchError) throw launchError;
			if (child.exitCode !== null || child.signalCode !== null) {
				throw new Error(
					`notify daemon exited during startup (code ${String(child.exitCode)})`,
				);
			}
			const health = await requestNotifyDaemonHealth(
				this.config.port,
				this.config.secret,
			);
			// Another instance's daemon carrying the same secret answers this too.
			if (health?.pid === child.pid) {
				this.healthyAt = Date.now();
				return health.pid;
			}
			await sleep(HEALTH_RETRY_DELAY_MS);
		}
		child.kill();
		throw new Error(
			`notify daemon did not answer ${NOTIFY_HEALTH_URL_PATH} on 127.0.0.1:${this.config.port}`,
		);
	}

	private handleExit(
		child: childProcess.ChildProcess,
		code: number | null,
		signal: NodeJS.Signals | null,
	): void {
		if (this.child !== child) return;
		this.child = null;
		this.closeDaemonLog();
		if (this.stopping) return;
		if (code === EXIT_CODE_BIND_FAILED) {
			log.error(
				`[notify-daemon] 127.0.0.1:${this.config.port} is already in use; Claude hooks go back to the per-event command path until that port is free`,
			);
			this.giveUp();
			return;
		}
		this.scheduleRestart(
			`exited (code ${String(code)}, signal ${String(signal)})`,
		);
	}

	// (HOOK-HTTP-DAEMON) Handing the hooks back is irreversible, so it also ends
	// supervision: a ladder that kept spawning past it could leave a healthy
	// daemon with no hook entry pointing at it for the rest of the run.
	private giveUp(): void {
		if (this.gaveUp) return;
		this.gaveUp = true;
		this.stopping = true;
		this.child?.kill();
		this.child = null;
		this.closeDaemonLog();
		void this.removeFilesThisDaemonWrote();
		handBackToken += 1;
		this.config.onPermanentFailure?.();
	}

	private scheduleRestart(cause: string): void {
		if (this.stopping || this.restartPending || this.child) return;
		if (
			this.healthyAt > this.attemptStartedAt &&
			Date.now() - this.healthyAt > RESTART_BUDGET_RESET_MS
		) {
			this.restarts = 0;
		}
		const backoff = RESTART_BACKOFF_MS[this.restarts];
		if (backoff === undefined) {
			log.error(
				`[notify-daemon] gave up after ${this.restarts} restarts (last: ${cause}); Claude hooks go back to the per-event command path`,
			);
			this.giveUp();
			return;
		}
		this.restarts += 1;
		this.restartPending = true;
		log.warn(
			`[notify-daemon] ${cause}; restart ${this.restarts} in ${backoff}ms`,
		);
		setTimeout(() => {
			this.restartPending = false;
			if (this.stopping) return;
			void this.start().catch((error: unknown) => {
				log.error("[notify-daemon] restart failed", error);
				this.scheduleRestart(`restart failed (${String(error)})`);
			});
		}, backoff).unref?.();
	}
}

async function writeOwnerOnly(file: string, contents: string): Promise<void> {
	const pending = `${file}.pending`;
	await fs.promises.rm(pending, { force: true });
	await fs.promises.writeFile(pending, contents, {
		mode: SUPERSET_SENSITIVE_FILE_MODE,
	});
	await fs.promises.rename(pending, file);
}

export type NotifyTrafficVerdict = "waiting" | "confirmed" | "unused";

// Claude writes its transcript on every session event that owes the daemon a
// POST, and no other agent writes one at all.
export function notifyTrafficVerdict(input: {
	served: number | null;
	silentHealthPolls: number;
	claudeActivityAtMs: number | null;
	upgradedAtMs: number;
	servedSinceMs: number;
	nowMs: number;
}): NotifyTrafficVerdict {
	// (HOOK-HTTP-DAEMON) A health GET nothing answered is a request that timed
	// out under load, not a daemon serving nothing. Read as zero served it would
	// condemn a daemon that had just served a whole turn, so only a run of them
	// counts as one.
	if (input.served === null) {
		if (input.silentHealthPolls < SILENT_HEALTH_POLLS) return "waiting";
	} else if (input.served > 0) {
		return "confirmed";
	}
	const armedAtMs = Math.max(input.upgradedAtMs, input.servedSinceMs);
	const activityAtMs = input.claudeActivityAtMs;
	if (
		activityAtMs !== null &&
		activityAtMs > armedAtMs + SETTINGS_RELOAD_MS &&
		input.nowMs - activityAtMs > TRAFFIC_GRACE_MS
	) {
		return "unused";
	}
	return "waiting";
}

export interface ClaudeActivity {
	lastAtMs(): number | null;
	close(): void;
	readonly watchedRoots: number;
}

/**
 * (HOOK-HTTP-DAEMON) Where Claude keeps its transcripts. A Superset terminal
 * on a Pi-capable host launches Claude with `CLAUDE_CONFIG_DIR` pointing at
 * `<db-dir>/claude-profiles/<uuid>` (packages/host-service/src/terminal/
 * terminal.ts), so `~/.claude/projects` alone sees none of those sessions.
 * One recursive watch per org covers every profile under it, and `profiles`
 * names the ones whose own settings.json carries the http entries — a session
 * still reading command entries can neither prove nor disprove the transport.
 */
export interface ClaudeTranscriptRoot {
	readonly dir: string;
	readonly profileTree: boolean;
	readonly profiles?: ReadonlySet<string>;
}

/**
 * (HOOK-HTTP-DAEMON) Every `<db-dir>/claude-profiles/<uuid>` on this machine.
 * The host root is SUPERSET_HOME_DIR-scoped (a dev instance runs with its own),
 * unlike the cross-instance rendezvous in notifyHooksDir. The sync form is for
 * the process `exit` handler alone, which has no tick left to await anything.
 */
export async function claudeProfileDirsAsync(
	hostRoot: string = path.join(SUPERSET_HOME_DIR, "host"),
): Promise<string[]> {
	const dirs: string[] = [];
	for (const org of await readdirOrNone(hostRoot)) {
		if (!org.isDirectory()) continue;
		const profilesRoot = path.join(hostRoot, org.name, "claude-profiles");
		for (const profile of await readdirOrNone(profilesRoot)) {
			if (profile.isDirectory())
				dirs.push(path.join(profilesRoot, profile.name));
		}
	}
	return dirs;
}

export function claudeProfileDirs(
	hostRoot: string = path.join(SUPERSET_HOME_DIR, "host"),
): string[] {
	const dirs: string[] = [];
	for (const org of readdirOrNoneSync(hostRoot)) {
		if (!org.isDirectory()) continue;
		const profilesRoot = path.join(hostRoot, org.name, "claude-profiles");
		for (const profile of readdirOrNoneSync(profilesRoot)) {
			if (profile.isDirectory())
				dirs.push(path.join(profilesRoot, profile.name));
		}
	}
	return dirs;
}

function reportUnreadableProfileTree(dir: string, error: unknown): void {
	if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
	log.warn(
		`[notify-daemon] cannot list ${dir}; the Claude profile copies under it keep the hook entries they have`,
		error,
	);
}

async function readdirOrNone(dir: string): Promise<fs.Dirent[]> {
	return await fs.promises
		.readdir(dir, { withFileTypes: true })
		.catch((error: unknown) => {
			reportUnreadableProfileTree(dir, error);
			return [];
		});
}

function readdirOrNoneSync(dir: string): fs.Dirent[] {
	try {
		return fs.readdirSync(dir, { withFileTypes: true });
	} catch (error) {
		reportUnreadableProfileTree(dir, error);
		return [];
	}
}

export function claudeTranscriptRoots(
	upgradedProfileDirs: readonly string[],
): ClaudeTranscriptRoot[] {
	const byProfilesRoot = new Map<string, Set<string>>();
	for (const dir of upgradedProfileDirs) {
		const profilesRoot = path.dirname(dir);
		const profiles = byProfilesRoot.get(profilesRoot) ?? new Set<string>();
		profiles.add(path.basename(dir));
		byProfilesRoot.set(profilesRoot, profiles);
	}
	return [
		{ dir: path.join(os.homedir(), ".claude", "projects"), profileTree: false },
		...[...byProfilesRoot].map(([dir, profiles]) => ({
			dir,
			profileTree: true,
			profiles,
		})),
	];
}

function isClaudeTranscript(
	root: ClaudeTranscriptRoot,
	filename: unknown,
): boolean {
	if (typeof filename !== "string" || !filename.endsWith(".jsonl"))
		return false;
	if (!root.profileTree) return true;
	const relative = filename.replaceAll("\\", "/");
	if (!relative.includes("/projects/")) return false;
	const profile = relative.slice(0, relative.indexOf("/"));
	return root.profiles?.has(profile) === true;
}

export async function watchClaudeActivity(
	roots: readonly ClaudeTranscriptRoot[],
): Promise<ClaudeActivity> {
	let lastAtMs: number | null = null;
	const watchers: fs.FSWatcher[] = [];
	const close = () => {
		for (const watcher of watchers) watcher.close();
	};
	for (const root of roots) {
		try {
			if (!root.profileTree) {
				await fs.promises.mkdir(root.dir, { recursive: true });
			}
			const watcher = fs.watch(
				root.dir,
				{ recursive: true },
				(_event, filename) => {
					if (isClaudeTranscript(root, filename)) lastAtMs = Date.now();
				},
			);
			watcher.on("error", (error) =>
				log.warn(`[notify-daemon] cannot watch ${root.dir}`, error),
			);
			watchers.push(watcher);
		} catch (error) {
			log.error(
				`[notify-daemon] cannot watch ${root.dir}; the traffic gate runs on the remaining transcript roots`,
				error,
			);
		}
	}
	return { lastAtMs: () => lastAtMs, close, watchedRoots: watchers.length };
}

let daemon: NotifyDaemon | null = null;
let daemonPromise: Promise<NotifyDaemonInfo | null> | null = null;
let exitHookInstalled = false;
let runToken = 0;

/**
 * (HOOK-HTTP-DAEMON) Invalidates every in-flight start, adoption wait and
 * traffic watch of this registration run. A quit lands while the handshake is
 * still going: the token is what stops the hook registration being rewritten to
 * a port this process is about to close, after cleanup already reported done.
 */
export function cancelNotifyDaemonRun(): void {
	runToken += 1;
}

export function notifyDaemonRunToken(): number {
	return runToken;
}

// A Claude session outlives Electron holding the secret this file carried when
// it read settings.json, so the next launch answers to that one.
async function carriedSecret(secretFile: string): Promise<string | null> {
	const carried = await fs.promises
		.readFile(secretFile, "utf8")
		.then((contents) => contents.trim())
		.catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") {
				log.warn(`[notify-daemon] cannot read ${secretFile}`, error);
			}
			return "";
		});
	if (SECRET_PATTERN.test(carried)) return carried;
	if (carried) {
		log.warn(`[notify-daemon] ${secretFile} holds no usable secret`);
	}
	return null;
}

/**
 * (HOOK-HTTP-DAEMON) The secret every instance sharing this home answers to.
 * Two instances starting in the same millisecond both find the file missing, so
 * the exclusive create is the serialization point: the loser reads the winner's
 * secret back rather than overwriting a file a live daemon is serving with.
 */
export async function carriedOrMintedSecret(
	secretFile: string,
): Promise<string> {
	const carried = await carriedSecret(secretFile);
	if (carried) return carried;
	const minted = crypto.randomBytes(32).toString("base64url");
	try {
		await fs.promises.mkdir(path.dirname(secretFile), { recursive: true });
		await fs.promises.writeFile(secretFile, minted, {
			flag: "wx",
			mode: SUPERSET_SENSITIVE_FILE_MODE,
		});
		return minted;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		return (await carriedSecret(secretFile)) ?? minted;
	}
}

export function notifyHooksDir(): string {
	return path.join(os.homedir(), ".superset", "hooks");
}

/**
 * (HOOK-HTTP-DAEMON) The daemon of ANOTHER Superset instance sharing this home
 * (a dev profile beside the installed app), proven by a health answer to the
 * secret both instances carry. This instance owns neither that process nor the
 * files describing it, so it leaves its hook registration alone rather than
 * rewriting the transport out from under it.
 */
export async function adoptRunningNotifyDaemon(
	hooksDir: string = notifyHooksDir(),
	port: number = NOTIFY_DAEMON_PORT,
): Promise<NotifyDaemonInfo | null> {
	const secret = await carriedSecret(path.join(hooksDir, SECRET_FILENAME));
	if (!secret) return null;
	const health = await requestNotifyDaemonHealth(port, secret);
	return health ? { pid: health.pid, port, secret } : null;
}

/**
 * (HOOK-HTTP-DAEMON) Resolves true once the adopted daemon stops answering,
 * which is what the owning instance quitting looks like from here: its hook
 * entries go back to the command transport and the port is free for this
 * instance to take. A single missed poll is a timed-out request, not a dead
 * daemon. Resolves FALSE when this instance is the one shutting down — the
 * owner is still serving, so its registration must be left exactly as it is.
 */
export async function awaitAdoptedNotifyDaemonExit(
	info: NotifyDaemonInfo,
): Promise<boolean> {
	const token = runToken;
	let silentPolls = 0;
	while (silentPolls < SILENT_HEALTH_POLLS) {
		await sleep(TRAFFIC_POLL_MS);
		if (token !== runToken) return false;
		const health = await requestNotifyDaemonHealth(info.port, info.secret);
		if (token !== runToken) return false;
		silentPolls = health === null ? silentPolls + 1 : 0;
	}
	return true;
}

export function ensureNotifyDaemon(
	scriptPath: string,
	onPermanentFailure: () => void,
	port: number = NOTIFY_DAEMON_PORT,
	hooksDir: string = notifyHooksDir(),
): Promise<NotifyDaemonInfo | null> {
	daemonPromise ??= (async () => {
		const token = runToken;
		const pythonPath = await resolvePythonPath();
		if (!pythonPath) {
			log.error(
				"[notify-daemon] no working python on PATH; Claude hooks stay on the per-event command path",
			);
			return null;
		}
		const started = new NotifyDaemon({
			pythonPath,
			scriptPath,
			hooksDir,
			port,
			secret: await carriedOrMintedSecret(path.join(hooksDir, SECRET_FILENAME)),
			onPermanentFailure,
		});
		try {
			const info = await started.start();
			if (token !== runToken) {
				await started.stop();
				return null;
			}
			daemon = started;
			if (!exitHookInstalled) {
				exitHookInstalled = true;
				process.once("exit", () => void stopNotifyDaemon());
			}
			log.info(
				`[notify-daemon] pid ${info.pid} serving 127.0.0.1:${info.port}`,
			);
			return info;
		} catch (error) {
			daemonPromise = null;
			await started.stop();
			log.error(
				"[notify-daemon] could not start; Claude hooks stay on the per-event command path",
				error,
			);
			return null;
		}
	})();
	return daemonPromise;
}

export async function watchNotifyDaemonTraffic(
	info: NotifyDaemonInfo,
	claudeTranscripts: readonly ClaudeTranscriptRoot[],
	onUnused: () => void,
	handBack: number = handBackToken,
): Promise<void> {
	const token = runToken;
	const abandoned = (): boolean =>
		token !== runToken || handBack !== handBackToken;
	if (abandoned()) return;
	const upgradedAtMs = Date.now();
	const activity = await watchClaudeActivity(claudeTranscripts);
	if (activity.watchedRoots === 0) {
		activity.close();
		log.error(
			"[notify-daemon] no Claude transcript root can be watched, so http hook entries could never be proven; Claude hooks go back to the per-event command path",
		);
		onUnused();
		await stopNotifyDaemon();
		return;
	}
	let reportedUnproven = false;
	let silentHealthPolls = 0;
	try {
		for (;;) {
			await sleep(
				reportedUnproven && activity.lastAtMs() === null
					? TRAFFIC_IDLE_POLL_MS
					: TRAFFIC_POLL_MS,
			);
			if (abandoned()) return;
			const claudeActivityAtMs = activity.lastAtMs();
			if (claudeActivityAtMs === null) {
				if (
					!reportedUnproven &&
					Date.now() - upgradedAtMs > TRAFFIC_UNPROVEN_LOG_MS
				) {
					reportedUnproven = true;
					log.warn(
						`[notify-daemon] nothing has written a transcript under ${claudeTranscripts
							.map((root) => root.dir)
							.join(
								", ",
							)} since the hooks moved to http, so the transport is still unproven; watching on at one poll every ${TRAFFIC_IDLE_POLL_MS}ms`,
					);
				}
				continue;
			}
			const health = await requestNotifyDaemonHealth(info.port, info.secret);
			if (abandoned()) return;
			silentHealthPolls = health === null ? silentHealthPolls + 1 : 0;
			const verdict = notifyTrafficVerdict({
				claudeActivityAtMs,
				servedSinceMs: daemon?.servedSinceMs ?? 0,
				nowMs: Date.now(),
				served: health?.served ?? null,
				silentHealthPolls,
				upgradedAtMs,
			});
			if (verdict === "confirmed") {
				log.info(
					`[notify-daemon] Claude is POSTing hooks (${health?.served ?? 0} served)`,
				);
				return;
			}
			if (verdict === "unused") {
				log.error(
					"[notify-daemon] Claude ran a whole turn without POSTing the daemon; Claude hooks go back to the per-event command path",
				);
				onUnused();
				await stopNotifyDaemon();
				return;
			}
		}
	} finally {
		activity.close();
	}
}

export async function stopNotifyDaemon(): Promise<void> {
	cancelNotifyDaemonRun();
	const stopping = daemon;
	daemon = null;
	daemonPromise = null;
	await stopping?.stop();
}
