import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { NodeWebSocket } from "@hono/node-ws";
import {
	createScanState,
	SHELLS_WITH_READY_MARKER,
	type ShellReadyScanState,
	scanForShellReady,
} from "@superset/shared/shell-ready-scanner";
import {
	createOsc133CdScanState,
	type Osc133CdScanState,
	scanForOsc133Cd,
} from "@superset/shared/shell-osc133-cd-scanner";
import {
	createTerminalTitleScanState,
	scanForTerminalTitle,
	type TerminalTitleScanState,
} from "@superset/shared/terminal-title-scanner";
import { and, eq, ne } from "drizzle-orm";
import type { Hono } from "hono";
import { isProcessAlive, readPtyDaemonManifest } from "../daemon/manifest.ts";
import type { HostDb } from "../db/index.ts";
import { projects, terminalSessions, workspaces } from "../db/schema.ts";
import type { EventBus } from "../events/index.ts";
import { portManager } from "../ports/port-manager.ts";
import {
	DaemonClient,
	type Signal as DaemonSignal,
} from "./DaemonClient/index.ts";
import {
	getDaemonClient,
	onDaemonDisconnect,
} from "./daemon-client-singleton.ts";
import {
	buildV2TerminalEnv,
	getShellLaunchArgs,
	getTerminalBaseEnv,
	resolveLaunchShell,
} from "./env.ts";
import { listTerminalResourceSessions } from "./resource-sessions.ts";
import {
	createModeTracker,
	type ModeTracker,
} from "./terminal-mode-tracker.ts";

const TERMINAL_COMMAND_EOL = process.platform === "win32" ? "\r" : "\n";

/**
 * Thin adapter exposing approximately the IPty surface that the rest of
 * this file (and teardown.ts) was built against, so most of the call
 * sites stay unchanged after the daemon extraction. The PTY itself lives
 * in pty-daemon; this adapter forwards to it over the daemon socket.
 *
 * onData / onExit register additional subscribers on top of whatever the
 * session's primary subscription is doing — daemon supports multi-
 * subscriber fan-out per session, so layered observers work fine.
 */
interface PtyDataDisposer {
	dispose(): void;
}

interface DaemonPty {
	pid: number;
	write(data: string): void;
	resize(cols: number, rows: number): void;
	kill(signal?: NodeJS.Signals): Promise<void>;
	onData(cb: (data: string) => void): PtyDataDisposer;
	onExit(
		cb: (info: { exitCode: number; signal: number }) => void,
	): PtyDataDisposer;
}

function makeDaemonPty(
	daemon: DaemonClient,
	sessionId: string,
	pid: number,
): DaemonPty {
	return {
		pid,
		write(data) {
			daemon.input(sessionId, Buffer.from(data, "utf8"));
		},
		resize(cols, rows) {
			try {
				daemon.resize(sessionId, cols, rows);
			} catch {
				// Daemon may have disconnected; surface via the next op.
			}
		},
		kill(signal) {
			return daemon.close(sessionId, toDaemonSignal(signal));
		},
		onData(cb) {
			// StringDecoder buffers partial UTF-8 sequences across chunks.
			// Without it `chunk.toString("utf8")` per chunk replaces the trailing
			// 1–3 bytes of any codepoint that straddles a boundary with U+FFFD —
			// the same bug we ripped out of the primary data path.
			const decoder = new StringDecoder("utf8");
			const unsub = daemon.subscribe(
				sessionId,
				{ replay: false },
				{
					onOutput: (chunk) => {
						const out = decoder.write(chunk);
						if (out.length > 0) cb(out);
					},
					onExit: () => {},
				},
			);
			return { dispose: unsub };
		},
		onExit(cb) {
			const unsub = daemon.subscribe(
				sessionId,
				{ replay: false },
				{
					onOutput: () => {},
					onExit: ({ code, signal }) =>
						cb({ exitCode: code ?? 0, signal: signal ?? 0 }),
				},
			);
			return { dispose: unsub };
		},
	};
}

interface RegisterWorkspaceTerminalRouteOptions {
	app: Hono;
	db: HostDb;
	eventBus: EventBus;
	upgradeWebSocket: NodeWebSocket["upgradeWebSocket"];
}

export function parseThemeType(
	value: string | null | undefined,
): "dark" | "light" | undefined {
	return value === "dark" || value === "light" ? value : undefined;
}

/**
 * Build the host-service tRPC URL for the v2 agent hook. The agent shell
 * script POSTs to this; host-service fans out on the event bus so the
 * renderer (web or electron) can play the finish sound.
 */
function getHostAgentHookUrl(): string {
	const port = process.env.HOST_SERVICE_PORT || process.env.PORT;
	if (!port) return "";
	return `http://127.0.0.1:${port}/trpc/notifications.hook`;
}

type TerminalClientMessage =
	| { type: "input"; data: string }
	| { type: "resize"; cols: number; rows: number }
	| { type: "dispose" };

// PTY output bytes travel as binary WebSocket frames — the renderer pipes
// the ArrayBuffer straight into xterm.write(Uint8Array) without any UTF-8
// decoding. Control messages stay JSON. Replay (the buffered prefix sent
// on attach) is a binary frame too; the renderer doesn't distinguish it
// from live data.
type TerminalServerMessage =
	| { type: "attached"; terminalId: string }
	| { type: "error"; message: string }
	| { type: "exit"; exitCode: number; signal: number }
	| { type: "title"; title: string | null };

const MAX_BUFFER_BYTES = 64 * 1024;
// Cap on a single renderer socket's unflushed WebSocket send buffer. With no
// ACK flow control, a renderer that stops draining (slow paint, pinned main
// thread, dead tab) would let this buffer grow without bound → host OOM (the
// risk #4868 was about). Once a socket blows past this, we drop it; the
// renderer auto-reconnects and replays the bounded tail buffer. Crucially the
// PTY is never paused, so a stalled renderer can't wedge the shell. Matches the
// daemon's own 8 MB outbound socket cap.
const WS_SEND_BUFFER_CAP_BYTES = 8 * 1024 * 1024;
const SOCKET_OPEN = 1;
const SOCKET_CLOSING = 2;
const SOCKET_CLOSED = 3;
const DEFAULT_TERMINAL_COLS = 120;
const DEFAULT_TERMINAL_ROWS = 32;
const MIN_TERMINAL_COLS = 20;
const MIN_TERMINAL_ROWS = 5;

// `<ArrayBuffer>` narrowing matches hono/ws's WSContext.send signature.
// `raw` is the underlying `ws` WebSocket (present for node-ws); we read
// `bufferedAmount` off it to bound a slow renderer's send queue.
type TerminalSocket = {
	send: (data: string | Uint8Array<ArrayBuffer>) => void;
	close: (code?: number, reason?: string) => void;
	readyState: number;
	raw?: { readonly bufferedAmount?: number };
};

// ---------------------------------------------------------------------------
// OSC 133 shell readiness detection (FinalTerm semantic prompt standard).
// Scanner logic lives in @superset/shared/shell-ready-scanner.
// ---------------------------------------------------------------------------

/** Flush partial OSC 133;A prefix bytes the scanner is holding if a full marker never arrives. */
const SHELL_READY_TIMEOUT_MS = 3_000;

/**
 * Shell readiness lifecycle:
 * - `pending`     — shell initialising; scanner active
 * - `ready`       — OSC 133;A detected; scanner off
 * - `timed_out`   — marker never arrived within timeout; scanner off
 * - `unsupported` — shell has no marker (sh, ksh); scanner never started
 */
type ShellReadyState = "pending" | "ready" | "timed_out" | "unsupported";

interface TerminalSession {
	terminalId: string;
	workspaceId: string;
	pty: DaemonPty;
	cols: number;
	rows: number;
	/** Unsubscribe from the daemon's output/exit stream when disposed. */
	unsubscribeDaemon: (() => void) | null;
	sockets: Set<TerminalSocket>;
	/**
	 * Buffered PTY output retained for replay on (re)attach. Bytes, not
	 * strings — keeping this byte-aligned with the wire frees us from the
	 * per-chunk UTF-8 decoding that used to mangle TUIs.
	 */
	buffer: Uint8Array[];
	bufferBytes: number;
	createdAt: number;
	exited: boolean;
	exitCode: number;
	exitSignal: number;
	listed: boolean;
	title: string | null;
	titleScanState: TerminalTitleScanState;

	// Shell readiness (OSC 133)
	shellReadyState: ShellReadyState;
	shellReadyResolve: (() => void) | null;
	shellReadyPromise: Promise<void>;
	shellReadyTimeoutId: ReturnType<typeof setTimeout> | null;
	scanState: ShellReadyScanState;
	initialCommandQueued: boolean;

	// (AY) OSC 133 C/D command-running detection — drives the shell-running blue
	// dot. `cdScanState` is null for shells we don't instrument (sh/ksh, adopted
	// sessions). `commandRunning` tracks whether we've seen a `133;C` without a
	// matching `133;D` yet, so a stray `133;A` (prompt redraw) can synthesize a
	// command-end self-heal. A host-service restart adopts with a fresh state +
	// commandRunning=false: it misses an in-flight command's blue dot but
	// recovers on the next D/A (safe direction — never a stuck blue).
	cdScanState: Osc133CdScanState | null;
	commandRunning: boolean;

	/**
	 * Side-channel UTF-8 decoder. portManager.checkOutputForHint takes a
	 * string and does text-pattern matching for "Local: http://…" hints,
	 * so we keep a per-session StringDecoder that buffers partial codepoints
	 * across chunks — separate from the data path, never touching what we
	 * actually broadcast to the renderer.
	 */
	portHintDecoder: StringDecoder;

	/**
	 * Mirrors PTY output through a headless xterm so a reattaching renderer
	 * can be resynced via a mode preamble — covers kitty keyboard, bracketed
	 * paste, focus, mouse, etc. that the FIFO can't restore on its own.
	 */
	modeTracker: ModeTracker;
}

/** PTY lifetime is independent of socket lifetime — sockets detach/reattach freely. */
const sessions = new Map<string, TerminalSession>();
const attachResolutions = new Map<
	string,
	Promise<TerminalSession | { error: string }>
>();
const socketOwners = new WeakMap<TerminalSocket, TerminalSession>();

function cleanupDetachedSession(session: TerminalSession, reason: string): void {
	if (sessions.get(session.terminalId) === session) return;
	if (session.sockets.size > 0) return;

	if (session.shellReadyTimeoutId) {
		clearTimeout(session.shellReadyTimeoutId);
		session.shellReadyTimeoutId = null;
	}
	if (session.unsubscribeDaemon) {
		try {
			session.unsubscribeDaemon();
		} catch (error) {
			console.error("[terminal] failed to cleanup detached daemon subscription", {
				terminalId: session.terminalId,
				reason,
				error,
			});
		}
		session.unsubscribeDaemon = null;
	}
	try {
		session.modeTracker.dispose();
	} catch (error) {
		console.error("[terminal] failed to cleanup detached mode tracker", {
			terminalId: session.terminalId,
			reason,
			error,
		});
	}

	console.log("[terminal] cleaned detached session", {
		terminalId: session.terminalId,
		reason,
	});
}

async function resolveAttachSessionOnce({
	terminalId,
	workspaceId,
	themeType,
	db,
	eventBus,
	replayOnAdoption,
}: {
	terminalId: string;
	workspaceId: string;
	themeType?: "dark" | "light";
	db: HostDb;
	eventBus?: EventBus;
	replayOnAdoption: boolean;
}): Promise<TerminalSession | { error: string }> {
	const existing = sessions.get(terminalId);
	if (existing) return existing;

	const inFlight = attachResolutions.get(terminalId);
	if (inFlight) return inFlight;

	const resolution = (async (): Promise<TerminalSession | { error: string }> => {
		const current = sessions.get(terminalId);
		if (current) return current;

		const adopted = await createTerminalSessionInternal({
			terminalId,
			workspaceId,
			themeType,
			db,
			eventBus,
			adoptOnly: true,
			// Renderer passes `?replay=0` on reconnect; see replayOnAdoption.
			replayOnAdoption,
		});
		if (!("error" in adopted)) {
			const live = sessions.get(terminalId);
			if (live && live !== adopted) {
				cleanupDetachedSession(adopted, "attach-resolution-overwritten");
				return live;
			}
			return adopted;
		}

		// Active row but daemon no longer owns the PTY (laptop sleep,
		// daemon restart, machine reboot). Respawn rather than dead-end
		// the pane — the renderer's xterm scrollback stays painted above.
		console.log(`[terminal] respawning lost session ${terminalId}`);
		const created = await createTerminalSessionInternal({
			terminalId,
			workspaceId,
			themeType,
			db,
			eventBus,
		});
		if (!("error" in created)) {
			const live = sessions.get(terminalId);
			if (live && live !== created) {
				cleanupDetachedSession(created, "attach-resolution-overwritten");
				return live;
			}
		}
		return created;
	})();

	attachResolutions.set(terminalId, resolution);
	try {
		return await resolution;
	} finally {
		if (attachResolutions.get(terminalId) === resolution) {
			attachResolutions.delete(terminalId);
		}
	}
}

// When the daemon disconnects, close every WS socket so the renderer's
// existing exponential-backoff reconnect kicks in. On reconnect, host-service
// rebuilds the DaemonClient (next getDaemonClient() call), and the adoption-
// via-list path re-attaches to live sessions on the respawned daemon. Without
// this, sockets stay open and input/resize silently fail because the daemon
// reference is dead.
//
// We also clear the in-memory sessions map so a stale subscription closure
// doesn't keep firing for sessions that no longer match daemon state.
onDaemonDisconnect((err) => {
	const sessionCount = sessions.size;
	if (sessionCount === 0) return;
	console.warn(
		`[terminal] pty-daemon disconnected (${err?.message ?? "no message"}); closing ${sessionCount} terminal WS socket(s) to trigger renderer reconnect`,
	);
	for (const session of sessions.values()) {
		for (const socket of session.sockets) {
			// Drop ownership BEFORE close so onClose doesn't re-dispose this
			// session via cleanupDetachedSession after we tear it down here.
			socketOwners.delete(socket);
			try {
				socket.close(1011, "pty-daemon disconnected");
			} catch {
				// best-effort
			}
		}
		session.sockets.clear();
		if (session.unsubscribeDaemon) {
			try {
				session.unsubscribeDaemon();
			} catch {
				// best-effort
			}
			session.unsubscribeDaemon = null;
		}
		try {
			session.modeTracker.dispose();
		} catch {
			// best-effort
		}
	}
	sessions.clear();
});

/**
 * Test-only escape hatch: simulates a host-service process restart by clearing
 * the in-memory session map without touching the daemon. After calling this,
 * createTerminalSessionInternal() is forced down the adoption-on-EEXIST path
 * for any session id the daemon already owns.
 *
 * NEVER call this from production code paths.
 */
export function __resetSessionsForTesting(): void {
	for (const session of sessions.values()) {
		if (session.unsubscribeDaemon) {
			try {
				session.unsubscribeDaemon();
			} catch {
				// best-effort
			}
		}
		try {
			session.modeTracker.dispose();
		} catch {
			// best-effort
		}
	}
	sessions.clear();
}

function pruneAndCountOpenSockets(session: TerminalSession): number {
	let openSockets = 0;
	for (const socket of session.sockets) {
		if (socket.readyState === SOCKET_OPEN) {
			openSockets += 1;
		} else if (
			socket.readyState === SOCKET_CLOSING ||
			socket.readyState === SOCKET_CLOSED
		) {
			session.sockets.delete(socket);
		}
	}
	return openSockets;
}

export interface TerminalSessionSummary {
	terminalId: string;
	workspaceId: string;
	createdAt: number;
	exited: boolean;
	exitCode: number;
	attached: boolean;
	title: string | null;
}

export function listTerminalSessions(
	options: { workspaceId?: string; includeExited?: boolean } = {},
): TerminalSessionSummary[] {
	const includeExited = options.includeExited ?? true;

	return Array.from(sessions.values())
		.filter((session) => session.listed)
		.filter(
			(session) =>
				options.workspaceId === undefined ||
				session.workspaceId === options.workspaceId,
		)
		.filter((session) => includeExited || !session.exited)
		.map((session) => ({
			terminalId: session.terminalId,
			workspaceId: session.workspaceId,
			createdAt: session.createdAt,
			exited: session.exited,
			exitCode: session.exitCode,
			attached: pruneAndCountOpenSockets(session) > 0,
			title: session.title,
		}));
}

export function countTerminalSessions(
	options: {
		workspaceId?: string;
		includeExited?: boolean;
		excludeTerminalIds?: Iterable<string>;
	} = {},
): number {
	const includeExited = options.includeExited ?? true;
	const excludedTerminalIds = options.excludeTerminalIds
		? new Set(options.excludeTerminalIds)
		: null;
	let count = 0;

	for (const session of sessions.values()) {
		if (!session.listed) continue;
		if (
			options.workspaceId !== undefined &&
			session.workspaceId !== options.workspaceId
		) {
			continue;
		}
		if (!includeExited && session.exited) continue;
		if (excludedTerminalIds?.has(session.terminalId)) continue;
		count += 1;
	}

	return count;
}

export function writeInputToSession({
	terminalId,
	workspaceId,
	data,
}: {
	terminalId: string;
	workspaceId: string;
	data: string;
}): { success: true } | { error: string } {
	const session = sessions.get(terminalId);
	if (!session) {
		return { error: "Terminal session not found" };
	}
	if (session.workspaceId !== workspaceId) {
		return { error: "Terminal session does not belong to this workspace" };
	}
	if (session.exited) {
		return { error: "Terminal session has exited" };
	}

	session.pty.write(data);
	return { success: true };
}

// (AUTO-RESUME) Fire-time preflight write. Unlike writeInputToSession this also refuses
// to type while a foreground command is in flight (OSC 133 commandRunning) — i.e. only
// when the agent CLI is idle at its prompt — and appends the platform EOL so the prompt
// is submitted. The agent-session-id binding check is done by the caller (router), which
// has access to the TerminalAgentStore. Returns a structured skip reason rather than
// throwing so the scheduler can decide retry-vs-give-up.
export type WriteIfIdleResult =
	| { sent: true }
	| {
			sent: false;
			reason: "not_found" | "wrong_workspace" | "exited" | "busy";
	  };

export function writeInputIfIdleSession({
	terminalId,
	workspaceId,
	data,
}: {
	terminalId: string;
	workspaceId: string;
	data: string;
}): WriteIfIdleResult {
	const session = sessions.get(terminalId);
	if (!session) return { sent: false, reason: "not_found" };
	if (session.workspaceId !== workspaceId) {
		return { sent: false, reason: "wrong_workspace" };
	}
	if (session.exited) return { sent: false, reason: "exited" };
	// commandRunning is only ever true for OSC-133-instrumented shells; an
	// uninstrumented shell stays false, so we treat false as "idle or unknown".
	if (session.commandRunning) return { sent: false, reason: "busy" };

	session.pty.write(`${data}${TERMINAL_COMMAND_EOL}`);
	return { sent: true };
}

function sendMessage(
	socket: { send: (data: string) => void; readyState: number },
	message: TerminalServerMessage,
) {
	if (socket.readyState !== SOCKET_OPEN) return;
	socket.send(JSON.stringify(message));
}

function broadcastMessage(
	session: TerminalSession,
	message: TerminalServerMessage,
): number {
	let sent = 0;
	for (const socket of session.sockets) {
		if (socket.readyState !== SOCKET_OPEN) {
			if (
				socket.readyState === SOCKET_CLOSING ||
				socket.readyState === SOCKET_CLOSED
			) {
				session.sockets.delete(socket);
			}
			continue;
		}
		sendMessage(socket, message);
		sent += 1;
	}
	return sent;
}

function setSessionTitle(session: TerminalSession, title: string | null) {
	if (session.title === title) return;
	session.title = title;
	broadcastMessage(session, { type: "title", title });
}

function bufferOutput(session: TerminalSession, data: Uint8Array) {
	session.buffer.push(data);
	session.bufferBytes += data.byteLength;

	while (session.bufferBytes > MAX_BUFFER_BYTES && session.buffer.length > 1) {
		const removed = session.buffer.shift();
		if (removed) session.bufferBytes -= removed.byteLength;
	}
}

function normalizeTerminalDimension(
	value: number | null | undefined,
	min: number,
	fallback: number,
): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.max(min, Math.floor(value));
}

// All bytes we send here are ArrayBuffer-backed at runtime (node Buffers,
// scanner outputs); the cast just narrows the type-system's loose default.
function asArrayBufferBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
	return bytes as Uint8Array<ArrayBuffer>;
}

function sendBytes(socket: TerminalSocket, bytes: Uint8Array) {
	if (socket.readyState !== SOCKET_OPEN) return;
	socket.send(asArrayBufferBytes(bytes));
}

function socketBufferedAmount(socket: TerminalSocket): number {
	const amount = socket.raw?.bufferedAmount;
	return typeof amount === "number" ? amount : 0;
}

function broadcastBytes(session: TerminalSession, bytes: Uint8Array): number {
	let sent = 0;
	const tight = asArrayBufferBytes(bytes);
	for (const socket of session.sockets) {
		if (socket.readyState !== SOCKET_OPEN) {
			if (
				socket.readyState === SOCKET_CLOSING ||
				socket.readyState === SOCKET_CLOSED
			) {
				session.sockets.delete(socket);
			}
			continue;
		}
		// A renderer that can't keep up lets its send buffer grow without bound.
		// Drop it past the cap rather than buffer forever; it reconnects and
		// replays the tail. Returning this chunk as "not sent" routes it to the
		// bounded replay buffer via the caller's broadcast-or-buffer check.
		if (socketBufferedAmount(socket) > WS_SEND_BUFFER_CAP_BYTES) {
			session.sockets.delete(socket);
			try {
				socket.close(1013, "terminal output back-pressure");
			} catch {
				// best-effort; close may race an already-closing socket
			}
			continue;
		}
		socket.send(tight);
		sent += 1;
	}
	return sent;
}

function replayBuffer(session: TerminalSession, socket: TerminalSocket) {
	// Preamble first, then FIFO. Mode-setting escapes (kitty keyboard,
	// bracketed paste, focus, …) are typically emitted once at startup and
	// broadcast away rather than buffered, so a fresh xterm needs them
	// re-asserted on every attach — even when the FIFO is empty.
	const preamble = session.modeTracker.buildPreamble();
	let bufferTotal = 0;
	for (const b of session.buffer) bufferTotal += b.byteLength;
	const preambleLen = preamble?.byteLength ?? 0;
	if (preambleLen === 0 && bufferTotal === 0) return;

	const combined = new Uint8Array(preambleLen + bufferTotal);
	let offset = 0;
	if (preamble) {
		combined.set(preamble, offset);
		offset += preamble.byteLength;
	}
	for (const b of session.buffer) {
		combined.set(b, offset);
		offset += b.byteLength;
	}
	session.buffer.length = 0;
	session.bufferBytes = 0;
	sendBytes(socket, combined);
}

/**
 * Transition out of `pending`. Flushes any partially-matched marker
 * bytes as terminal output (they weren't a real marker). Idempotent.
 */
function resolveShellReady(
	session: TerminalSession,
	state: "ready" | "timed_out",
): void {
	if (session.shellReadyState !== "pending") return;
	session.shellReadyState = state;
	if (session.shellReadyTimeoutId) {
		clearTimeout(session.shellReadyTimeoutId);
		session.shellReadyTimeoutId = null;
	}
	// Flush held marker bytes — they weren't part of a full marker
	if (session.scanState.heldBytes.length > 0) {
		const heldBytes = Uint8Array.from(session.scanState.heldBytes);
		session.modeTracker.feed(heldBytes);
		bufferOutput(session, heldBytes);
		session.scanState.heldBytes.length = 0;
	}
	session.scanState.matchPos = 0;
	if (session.shellReadyResolve) {
		session.shellReadyResolve();
		session.shellReadyResolve = null;
	}
}

function queueInitialCommand(
	session: TerminalSession,
	initialCommand: string,
): void {
	if (session.initialCommandQueued || session.exited) return;
	session.initialCommandQueued = true;
	const cmd = initialCommand.endsWith("\n") || initialCommand.endsWith("\r")
		? initialCommand
		: `${initialCommand}${TERMINAL_COMMAND_EOL}`;
	// Don't gate on OSC 133;A: PTY stdin buffers until the shell reads it,
	// and gating turned broken/missing markers into a guaranteed stall.
	session.pty.write(cmd);
}

interface DaemonCloseResult {
	attempted: boolean;
	succeeded: boolean;
	error?: unknown;
}

export interface DisposeSessionResult {
	terminalId: string;
	daemonCloseAttempted: boolean;
	daemonCloseSucceeded: boolean;
}

function toDaemonSignal(signal?: NodeJS.Signals): DaemonSignal {
	switch (signal) {
		case "SIGINT":
		case "SIGTERM":
		case "SIGKILL":
		case "SIGHUP":
			return signal;
		default:
			return "SIGHUP";
	}
}

function isUnknownDaemonSessionError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	return error.message.includes("unknown session:");
}

function reachableDaemonSocketPath(): string | null {
	const explicitSocket = process.env.SUPERSET_PTY_DAEMON_SOCKET;
	if (explicitSocket) return explicitSocket;

	const organizationId = process.env.ORGANIZATION_ID;
	if (!organizationId) return null;

	const manifest = readPtyDaemonManifest(organizationId);
	if (!manifest || !isProcessAlive(manifest.pid)) return null;
	return manifest.socketPath;
}

async function closeDaemonSessionById(
	terminalId: string,
	signal: DaemonSignal = "SIGHUP",
): Promise<DaemonCloseResult> {
	const socketPath = reachableDaemonSocketPath();
	if (!socketPath) return { attempted: false, succeeded: true };

	const daemon = new DaemonClient({ socketPath, connectTimeoutMs: 1000 });
	try {
		await daemon.connect();
		await daemon.close(terminalId, signal);
		return { attempted: true, succeeded: true };
	} catch (error) {
		if (isUnknownDaemonSessionError(error)) {
			return { attempted: true, succeeded: true };
		}
		return { attempted: true, succeeded: false, error };
	} finally {
		await daemon.dispose().catch(() => {});
	}
}

/**
 * Kills the PTY (if live) and marks the DB row disposed. Safe to call even
 * when there's no in-memory session — e.g. for zombie `active` rows left
 * over from a prior crash. Exported so workspaceCleanup can dispose the
 * transient teardown session.
 */
export function disposeSession(terminalId: string, db: HostDb) {
	void disposeSessionAndWait(terminalId, db)
		.then((result) => {
			if (!result.daemonCloseSucceeded) {
				console.warn("[terminal] disposeSession daemon close failed", {
					terminalId,
				});
			}
		})
		.catch((error) => {
			console.warn("[terminal] disposeSession failed", { terminalId, error });
		});
}

export async function disposeSessionAndWait(
	terminalId: string,
	db: HostDb,
): Promise<DisposeSessionResult> {
	// Interlock with an in-flight attach: if resolveAttachSessionOnce is mid-
	// create for this terminalId, a kill racing it would tear down the daemon
	// PTY and DB row only for the create to resume, respawn, and sessions.set —
	// silently resurrecting a terminal the user just killed. Await the in-flight
	// resolution so dispose runs AFTER it and tears down whatever it produced.
	// No deadlock: nothing inside the attach resolution calls dispose.
	const inFlightAttach = attachResolutions.get(terminalId);
	if (inFlightAttach) {
		try {
			await inFlightAttach;
		} catch {
			// a failed attach left nothing extra to dispose
		}
	}

	const session = sessions.get(terminalId);
	let closePromise: Promise<DaemonCloseResult> | null = null;

	if (session) {
		if (session.shellReadyTimeoutId) {
			clearTimeout(session.shellReadyTimeoutId);
			session.shellReadyTimeoutId = null;
		}
		for (const socket of session.sockets) {
			// Drop ownership BEFORE close so the socket's onClose doesn't route
			// to cleanupDetachedSession and double-dispose what we tear down here.
			socketOwners.delete(socket);
			socket.close(1000, "Session disposed");
		}
		session.sockets.clear();
		if (!session.exited) {
			try {
				closePromise = session.pty.kill().then(
					() =>
						({ attempted: true, succeeded: true }) satisfies DaemonCloseResult,
					(error) => ({
						attempted: true,
						succeeded: isUnknownDaemonSessionError(error),
						error,
					}),
				);
			} catch (error) {
				closePromise = Promise.resolve({
					attempted: true,
					succeeded: isUnknownDaemonSessionError(error),
					error,
				});
			}
		}
		// Stop receiving daemon callbacks for this session.
		if (session.unsubscribeDaemon) {
			try {
				session.unsubscribeDaemon();
			} catch {
				// best-effort
			}
			session.unsubscribeDaemon = null;
		}
		try {
			session.modeTracker.dispose();
		} catch {
			// best-effort
		}
		sessions.delete(terminalId);
	} else {
		closePromise = closeDaemonSessionById(terminalId, "SIGHUP");
	}

	portManager.unregisterSession(terminalId);

	const closeResult = closePromise
		? await closePromise
		: { attempted: false, succeeded: true };

	if (closeResult.succeeded) {
		db.update(terminalSessions)
			.set({ status: "disposed", endedAt: Date.now() })
			.where(eq(terminalSessions.id, terminalId))
			.run();
	}

	return {
		terminalId,
		daemonCloseAttempted: closeResult.attempted,
		daemonCloseSucceeded: closeResult.succeeded,
	};
}

/**
 * Dispose every active session belonging to the given workspace.
 * Returns counts so callers (e.g. workspaceCleanup.destroy) can surface warnings.
 */
export async function disposeSessionsByWorkspaceId(
	workspaceId: string,
	db: HostDb,
): Promise<{ terminated: number; failed: number }> {
	const rows = db
		.select({ id: terminalSessions.id })
		.from(terminalSessions)
		.where(
			and(
				eq(terminalSessions.originWorkspaceId, workspaceId),
				ne(terminalSessions.status, "disposed"),
			),
		)
		.all();

	let terminated = 0;
	let failed = 0;
	for (const row of rows) {
		try {
			const result = await disposeSessionAndWait(row.id, db);
			if (!result.daemonCloseSucceeded) {
				failed += 1;
				continue;
			}
			terminated += 1;
		} catch {
			failed += 1;
		}
	}
	return { terminated, failed };
}

interface CreateTerminalSessionOptions {
	terminalId: string;
	workspaceId: string;
	themeType?: "dark" | "light";
	db: HostDb;
	eventBus?: EventBus;
	initialCommand?: string;
	cwd?: string;
	/** Hidden sessions are process-internal and should not appear in user pickers. */
	listed?: boolean;
	cols?: number;
	rows?: number;
	/** Only recover an already-live daemon session; never spawn a new PTY. */
	adoptOnly?: boolean;
	/**
	 * Replay the daemon's ring buffer on subscribe. Default true. Pass false
	 * when the renderer's xterm already has the scrollback — replaying then
	 * doubles the visible output. Tradeoff: bytes the PTY produced during
	 * the WS-down window are dropped (sub-second on a daemon swap).
	 */
	replayOnAdoption?: boolean;
}

function resolveTerminalCwd(
	cwdOverride: string | undefined,
	worktreePath: string,
): string {
	if (!cwdOverride) return worktreePath;
	if (isAbsolute(cwdOverride)) {
		return existsSync(cwdOverride) ? cwdOverride : worktreePath;
	}

	const relativePath = cwdOverride.startsWith("./")
		? cwdOverride.slice(2)
		: cwdOverride;
	const resolvedPath = join(worktreePath, relativePath);
	return existsSync(resolvedPath) ? resolvedPath : worktreePath;
}

function getTerminalWorkspaceMismatchError({
	terminalId,
	ownerWorkspaceId,
	requestedWorkspaceId,
}: {
	terminalId: string;
	ownerWorkspaceId: string | null | undefined;
	requestedWorkspaceId: string;
}): string | null {
	if (!ownerWorkspaceId || ownerWorkspaceId === requestedWorkspaceId) {
		return null;
	}

	return `Terminal session "${terminalId}" belongs to workspace "${ownerWorkspaceId}", not "${requestedWorkspaceId}".`;
}

export async function createTerminalSessionInternal({
	terminalId,
	workspaceId,
	themeType,
	db,
	eventBus,
	initialCommand,
	cwd: cwdOverride,
	listed = true,
	cols: requestedCols,
	rows: requestedRows,
	adoptOnly = false,
	replayOnAdoption = true,
}: CreateTerminalSessionOptions): Promise<TerminalSession | { error: string }> {
	const existing = sessions.get(terminalId);
	if (existing) {
		const mismatchError = getTerminalWorkspaceMismatchError({
			terminalId,
			ownerWorkspaceId: existing.workspaceId,
			requestedWorkspaceId: workspaceId,
		});
		if (mismatchError) return { error: mismatchError };

		if (listed) existing.listed = true;
		if (initialCommand) queueInitialCommand(existing, initialCommand);
		return existing;
	}

	const existingRecord = db.query.terminalSessions
		.findFirst({ where: eq(terminalSessions.id, terminalId) })
		.sync();
	const recordMismatchError = getTerminalWorkspaceMismatchError({
		terminalId,
		ownerWorkspaceId: existingRecord?.originWorkspaceId,
		requestedWorkspaceId: workspaceId,
	});
	if (recordMismatchError) return { error: recordMismatchError };

	const workspace = db.query.workspaces
		.findFirst({ where: eq(workspaces.id, workspaceId) })
		.sync();

	if (!workspace) {
		return { error: "Workspace not found" };
	}
	if (!existsSync(workspace.worktreePath)) {
		return {
			error: `Workspace worktree no longer exists: ${workspace.worktreePath}`,
		};
	}

	// Derive root path from the workspace's project
	let rootPath = "";
	const project = db.query.projects
		.findFirst({ where: eq(projects.id, workspace.projectId) })
		.sync();
	if (project?.repoPath) {
		rootPath = project.repoPath;
	}

	const cwd = resolveTerminalCwd(cwdOverride, workspace.worktreePath);
	const cols = normalizeTerminalDimension(
		requestedCols,
		MIN_TERMINAL_COLS,
		DEFAULT_TERMINAL_COLS,
	);
	const rows = normalizeTerminalDimension(
		requestedRows,
		MIN_TERMINAL_ROWS,
		DEFAULT_TERMINAL_ROWS,
	);

	// Use the preserved shell snapshot — never live process.env
	const baseEnv = getTerminalBaseEnv();
	const supersetHomeDir = process.env.SUPERSET_HOME_DIR || "";
	const shell = await resolveLaunchShell(baseEnv);
	const shellArgs = getShellLaunchArgs({ shell, supersetHomeDir });
	const ptyEnv = buildV2TerminalEnv({
		baseEnv,
		shell,
		supersetHomeDir,
		themeType,
		cwd,
		terminalId,
		workspaceId,
		workspacePath: workspace.worktreePath,
		rootPath,
		hostServiceVersion: process.env.HOST_SERVICE_VERSION || "unknown",
		supersetEnv:
			process.env.NODE_ENV === "development" ? "development" : "production",
		agentHookPort: process.env.SUPERSET_AGENT_HOOK_PORT || "",
		agentHookVersion: process.env.SUPERSET_AGENT_HOOK_VERSION || "",
		hostAgentHookUrl: getHostAgentHookUrl(),
	});

	let daemon: DaemonClient;
	let openResult: { pid: number };
	let isAdopted = false;
	try {
		daemon = await getDaemonClient();
		if (adoptOnly) {
			const found = (await daemon.list()).find(
				(s) => s.id === terminalId && s.alive,
			);
			if (!found) {
				return {
					error: `Terminal session "${terminalId}" is not active; create it before connecting.`,
				};
			}
			openResult = { pid: found.pid };
			isAdopted = true;
			console.log(
				`[terminal] adopted existing daemon session ${terminalId} pid=${found.pid}`,
			);
		} else {
			try {
				openResult = await daemon.open(terminalId, {
					shell,
					argv: shellArgs,
					cwd,
					cols,
					rows,
					env: ptyEnv,
				});
			} catch (err) {
				// After host-service restart the daemon may already own this
				// session. Adopt it instead of looping forever on "session already
				// exists". The daemon kept the buffer + the live shell; we just
				// need to stitch up a TerminalSession record on this side and
				// subscribe-with-replay below.
				const msg = err instanceof Error ? err.message : String(err);
				if (msg.includes("session already exists")) {
					const list = await daemon.list();
					const found = list.find((s) => s.id === terminalId && s.alive);
					if (!found) throw err;
					openResult = { pid: found.pid };
					isAdopted = true;
					console.log(
						`[terminal] adopted existing daemon session ${terminalId} pid=${found.pid}`,
					);
				} else {
					throw err;
				}
			}
		}
	} catch (error) {
		return {
			error:
				error instanceof Error ? error.message : "Failed to start terminal",
		};
	}
	const pty: DaemonPty = makeDaemonPty(daemon, terminalId, openResult.pid);

	const createdAt = Date.now();

	db.insert(terminalSessions)
		.values({
			id: terminalId,
			originWorkspaceId: workspaceId,
			status: "active",
			createdAt,
		})
		.onConflictDoUpdate({
			target: terminalSessions.id,
			set: {
				originWorkspaceId: workspaceId,
				status: "active",
				createdAt,
				endedAt: null,
			},
		})
		.run();

	// Determine shell readiness support. Adopted sessions are already past
	// shell startup, so treat them as immediately ready — the OSC 133;A
	// marker has already flown by and we don't want to gate writes on it.
	// Normalize the basename across separators and a Windows `.exe` suffix so
	// `C:\...\pwsh.exe` / `/usr/bin/zsh` both resolve to a plain shell name.
	const shellName = (shell.split(/[\\/]/).pop() || shell).replace(
		/\.exe$/i,
		"",
	);
	const shellSupportsReady =
		!isAdopted && SHELLS_WITH_READY_MARKER.has(shellName);
	// (AY) Instrument the OSC 133 C/D command scanner for the same marker-
	// emitting shells (zsh/bash/fish/pwsh/powershell) — sh/ksh are excluded
	// because their wrappers emit no markers. Adopted sessions get a fresh
	// scanner too (commandRunning starts false): they miss an in-flight
	// command's blue dot but self-heal on the next D/A.
	const cdScannerSupported = SHELLS_WITH_READY_MARKER.has(shellName);

	let shellReadyResolve: (() => void) | null = null;
	const shellReadyPromise = shellSupportsReady
		? new Promise<void>((resolve) => {
				shellReadyResolve = resolve;
			})
		: Promise.resolve();

	const session: TerminalSession = {
		terminalId,
		workspaceId,
		pty,
		cols,
		rows,
		unsubscribeDaemon: null,
		sockets: new Set(),
		buffer: [],
		bufferBytes: 0,
		createdAt,
		exited: false,
		exitCode: 0,
		exitSignal: 0,
		listed,
		title: null,
		titleScanState: createTerminalTitleScanState(),
		shellReadyState: shellSupportsReady
			? "pending"
			: isAdopted
				? "ready"
				: "unsupported",
		shellReadyResolve,
		shellReadyPromise,
		shellReadyTimeoutId: null,
		scanState: createScanState(),
		cdScanState: cdScannerSupported ? createOsc133CdScanState() : null,
		commandRunning: false,
		// Adopted sessions have already run their initialCommand in the prior
		// host-service lifetime — flag it as queued so we don't double-fire it.
		initialCommandQueued: isAdopted,
		portHintDecoder: new StringDecoder("utf8"),
		modeTracker: createModeTracker(cols, rows),
	};
	const overwrittenSession = sessions.get(terminalId);
	sessions.set(terminalId, session);
	portManager.upsertSession(terminalId, workspaceId, pty.pid);

	// If the marker never arrives (broken wrapper, unsupported config),
	// the timeout unblocks so the session degrades gracefully.
	if (session.shellReadyState === "pending") {
		session.shellReadyTimeoutId = setTimeout(() => {
			resolveShellReady(session, "timed_out");
		}, SHELL_READY_TIMEOUT_MS);
	}

	// daemon.subscribe throws on a second replay-subscribe for an id another
	// (unserialized) creator just subscribed — e.g. POST /terminal/sessions
	// racing a WS respawn. Without rollback the throw would strand THIS
	// half-built session (unsubscribeDaemon still null) in the map: attaches
	// would bind sockets to it and the pane would be permanently output-dead.
	// Restore the overwritten winner (or clear the entry) and rethrow. The
	// daemon PTY is intentionally NOT killed — the racing winner shares it.
	try {
		session.unsubscribeDaemon = subscribeSessionToDaemon();
	} catch (error) {
		if (session.shellReadyTimeoutId) {
			clearTimeout(session.shellReadyTimeoutId);
			session.shellReadyTimeoutId = null;
		}
		if (sessions.get(terminalId) === session) {
			if (overwrittenSession && overwrittenSession !== session) {
				sessions.set(terminalId, overwrittenSession);
			} else {
				sessions.delete(terminalId);
			}
		}
		throw error;
	}

	function subscribeSessionToDaemon() {
		return daemon.subscribe(
		terminalId,
		{ replay: replayOnAdoption },
		{
			onOutput(chunk) {
				// Bytes flow daemon → host → xterm without UTF-8 decoding;
				// per-chunk `.toString("utf8")` here would mangle codepoints
				// straddling chunk boundaries. (See no-encoding-hops.test.ts.)
				const titleUpdates = scanForTerminalTitle(
					session.titleScanState,
					chunk,
				);
				for (const title of titleUpdates.updates) {
					setSessionTitle(session, title);
				}

				let bytes: Uint8Array = chunk;
				if (session.shellReadyState === "pending") {
					const result = scanForShellReady(session.scanState, chunk);
					bytes = result.output;
					if (result.matched) {
						resolveShellReady(session, "ready");
					}
				}
				// (AY) CHAIN the C/D scanner on the OUTPUT of the shell-ready pass —
				// never behind an else-if. The wrappers emit `D;<exit>` (command end)
				// and then `A` (prompt start) together at the FIRST prompt; the A-scanner
				// (while pending) consumes only that first `A`, so the leading `D` (and
				// any `C`) would otherwise leak as a visible `]133;D;0` artifact at the
				// top of every new terminal. Running the C/D scanner on the already-A-
				// stripped bytes strips that D (a `command-end` with commandRunning=false
				// is a harmless no-op) plus all later C/D and subsequent A. The first `A`
				// is removed by the A-scanner before the C/D scanner sees it, so no A is
				// double-stripped — each `A` is handled by exactly one scanner.
				if (session.cdScanState) {
					const cdResult = scanForOsc133Cd(session.cdScanState, bytes);
					bytes = cdResult.output;
					for (const ev of cdResult.events) {
						if (ev.kind === "command-start") {
							session.commandRunning = true;
							eventBus?.broadcastTerminalLifecycle({
								workspaceId,
								terminalId,
								eventType: "command-start",
								occurredAt: Date.now(),
							});
						} else if (ev.kind === "command-end") {
							// Only broadcast a real end-of-command transition. A `D` with
							// no preceding `C` — notably the first prompt's `D;<exit>` that
							// fires before any command (now stripped here thanks to the
							// chained scanner) — is a no-op: strip the marker, emit nothing.
							if (session.commandRunning) {
								session.commandRunning = false;
								eventBus?.broadcastTerminalLifecycle({
									workspaceId,
									terminalId,
									eventType: "command-end",
									exitCode: ev.exitCode,
									occurredAt: Date.now(),
								});
							}
						} else if (ev.kind === "prompt-redraw") {
							// A prompt redraw while a command was running means we
							// missed (or never got) its `133;D`. Synthesize a
							// command-end with unknown exit so the blue dot self-heals.
							if (session.commandRunning) {
								session.commandRunning = false;
								eventBus?.broadcastTerminalLifecycle({
									workspaceId,
									terminalId,
									eventType: "command-end",
									exitCode: null,
									occurredAt: Date.now(),
								});
							}
						}
					}
				}
				if (bytes.byteLength === 0) return;

				// portManager.checkOutputForHint runs URL/port regexes on
				// strings; the per-session StringDecoder buffers partial
				// codepoints across chunks. This is a side branch — the
				// transport above stays on bytes.
				const hintText = session.portHintDecoder.write(
					bytes instanceof Buffer
						? bytes
						: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
				);
				if (hintText.length > 0) portManager.checkOutputForHint(hintText);

				// Feed the tracker on every byte — broadcast skips the FIFO,
				// so this is the only path that catches startup mode escapes.
				session.modeTracker.feed(bytes);

				if (broadcastBytes(session, bytes) === 0) {
					bufferOutput(session, bytes);
				}
			},
			onExit({ code, signal }) {
				session.exited = true;
				session.exitCode = code ?? 0;
				session.exitSignal = signal ?? 0;
				const occurredAt = Date.now();

				portManager.unregisterSession(terminalId);

				db.update(terminalSessions)
					.set({ status: "exited", endedAt: occurredAt })
					.where(eq(terminalSessions.id, terminalId))
					.run();

				broadcastMessage(session, {
					type: "exit",
					exitCode: session.exitCode,
					signal: session.exitSignal,
				});

				eventBus?.broadcastTerminalLifecycle({
					workspaceId,
					terminalId,
					eventType: "exit",
					exitCode: session.exitCode,
					signal: session.exitSignal,
					occurredAt,
				});
			},
		},
		);
	}

	if (initialCommand) {
		queueInitialCommand(session, initialCommand);
	}

	return session;
}

export function registerWorkspaceTerminalRoute({
	app,
	db,
	eventBus,
	upgradeWebSocket,
}: RegisterWorkspaceTerminalRouteOptions) {
	app.post("/terminal/sessions", async (c) => {
		const body = await c.req.json<{
			terminalId: string;
			workspaceId: string;
			themeType?: string;
			initialCommand?: string;
			cwd?: string;
			cols?: number;
			rows?: number;
		}>();

		if (!body.terminalId || !body.workspaceId) {
			return c.json({ error: "Missing terminalId or workspaceId" }, 400);
		}

		const result = await createTerminalSessionInternal({
			terminalId: body.terminalId,
			workspaceId: body.workspaceId,
			themeType: parseThemeType(body.themeType),
			db,
			eventBus,
			initialCommand: body.initialCommand,
			cwd: body.cwd,
			cols: body.cols,
			rows: body.rows,
		});

		if ("error" in result) {
			return c.json({ error: result.error }, 500);
		}

		return c.json({ terminalId: result.terminalId, status: "active" });
	});

	// REST dispose — does not require an open WebSocket
	app.delete("/terminal/sessions/:terminalId", (c) => {
		const terminalId = c.req.param("terminalId");
		if (!terminalId) {
			return c.json({ error: "Missing terminalId" }, 400);
		}

		const session = sessions.get(terminalId);
		if (!session) {
			return c.json({ error: "Session not found" }, 404);
		}

		disposeSession(terminalId, db);
		return c.json({ terminalId, status: "disposed" });
	});

	// REST list — enumerate live terminal sessions
	app.get("/terminal/sessions", (c) => {
		const workspaceId = c.req.query("workspaceId") || undefined;
		return c.json({
			sessions: listTerminalSessions({ workspaceId, includeExited: true }),
		});
	});

	app.get("/terminal/resource-sessions", async (c) => {
		try {
			const daemon = await getDaemonClient();
			const titlesByTerminalId = new Map(
				Array.from(sessions.values()).map((session) => [
					session.terminalId,
					session.title,
				]),
			);
			return c.json({
				sessions: listTerminalResourceSessions(
					db,
					await daemon.list(),
					titlesByTerminalId,
				),
			});
		} catch (error) {
			console.warn("[terminal] Failed to list resource sessions", error);
			return c.json({ sessions: [] });
		}
	});

	app.get(
		"/terminal/:terminalId",
		upgradeWebSocket((c) => {
			const terminalId = c.req.param("terminalId") ?? "";
			const requestedWorkspaceId = c.req.query("workspaceId") || null;
			const attachSocketToSession = (
				session: TerminalSession,
				ws: TerminalSocket,
			): boolean => {
				if (session.sockets.has(ws)) return false;
				session.sockets.add(ws);
				socketOwners.set(ws, session);
				sendMessage(ws, { type: "attached", terminalId });

				db.update(terminalSessions)
					.set({ lastAttachedAt: Date.now() })
					.where(eq(terminalSessions.id, terminalId))
					.run();

				sendMessage(ws, { type: "title", title: session.title });
				replayBuffer(session, ws);
				if (session.exited) {
					sendMessage(ws, {
						type: "exit",
						exitCode: session.exitCode,
						signal: session.exitSignal,
					});
				}
				return true;
			};
			const resolveSessionForAttach = async (): Promise<
				TerminalSession | { error: string }
			> => {
				const existing = sessions.get(terminalId);
				if (existing) {
					if (requestedWorkspaceId) {
						const mismatchError = getTerminalWorkspaceMismatchError({
							terminalId,
							ownerWorkspaceId: existing.workspaceId,
							requestedWorkspaceId,
						});
						if (mismatchError) return { error: mismatchError };
					}
					return existing;
				}

				const record = db.query.terminalSessions
					.findFirst({ where: eq(terminalSessions.id, terminalId) })
					.sync();
				if (!record) {
					return {
						error: `Terminal session "${terminalId}" not found; create it before connecting.`,
					};
				}
				if (record.status === "disposed") {
					return { error: `Terminal session "${terminalId}" is disposed.` };
				}
				if (record.status === "exited") {
					return { error: `Terminal session "${terminalId}" has exited.` };
				}
				if (!record.originWorkspaceId) {
					return {
						error: `Terminal session "${terminalId}" is missing a workspace.`,
					};
				}
				if (requestedWorkspaceId) {
					const mismatchError = getTerminalWorkspaceMismatchError({
						terminalId,
						ownerWorkspaceId: record.originWorkspaceId,
						requestedWorkspaceId,
					});
					if (mismatchError) return { error: mismatchError };
				}

				// The workspace mismatch was already validated against
				// record.originWorkspaceId above, and every session this resolves
				// (existing, adopted, or respawned) carries that same workspaceId —
				// no re-check needed here.
				return resolveAttachSessionOnce({
					terminalId,
					workspaceId: record.originWorkspaceId,
					themeType: parseThemeType(c.req.query("themeType")),
					db,
					eventBus,
					replayOnAdoption: c.req.query("replay") !== "0",
				});
			};

			return {
				onOpen: (_event, ws) => {
					if (!terminalId) {
						ws.close(1011, "Missing terminalId");
						return;
					}

					void (async () => {
						const session = await resolveSessionForAttach();
						if ("error" in session) {
							sendMessage(ws, { type: "error", message: session.error });
							ws.close(1011, session.error);
							return;
						}
						if (ws.readyState !== SOCKET_OPEN) return;
						attachSocketToSession(session, ws);
					})().catch((error) => {
						console.error("[terminal] unexpected error during attach", error);
						if (ws.readyState !== SOCKET_OPEN) return;
						sendMessage(ws, {
							type: "error",
							message: "Internal terminal attach error",
						});
						ws.close(1011, "Internal terminal attach error");
					});
				},

				onMessage: (event, ws) => {
					let message: TerminalClientMessage;
					try {
						message = JSON.parse(String(event.data)) as TerminalClientMessage;
					} catch {
						sendMessage(ws, {
							type: "error",
							message: "Invalid terminal message payload",
						});
						return;
					}

					const session = sessions.get(terminalId ?? "");
					if (!session) return;
					// (FORK FIX — terminal-input-orphan-heal) A socket whose client
					// message arrives here but that is NOT in the live session's socket
					// set lost an attach race: two concurrent connects for this
					// terminalId each resolved/created a session and the later one
					// replaced the entry in `sessions`, orphaning this socket on the
					// now-dangling object. Its input/resize were being SILENTLY DROPPED
					// (the renderer already received `attached` + the replay buffer from
					// the dangling session, so the pane LOOKS connected — keystrokes just
					// vanish). Re-register the socket on the live session so its input
					// reaches the live PTY and it receives broadcast output. The `attached`
					// handshake was already delivered, so we do not re-send it here.
					if (!session.sockets.has(ws)) {
						// Never re-admit a socket that is no longer OPEN: back-pressure
						// eviction (broadcastBytes) and prune both delete-and-close a
						// socket on purpose; healing it would replay a final keystroke
						// from a torn-down socket and defeat the send-buffer cap.
						if (ws.readyState !== SOCKET_OPEN) return;
						const priorOwner = socketOwners.get(ws);
						if (!priorOwner || priorOwner.terminalId !== terminalId) {
							return;
						}
						console.log(
							"[terminal] input-orphan-heal: re-attaching orphaned socket " +
								JSON.stringify({
									terminalId,
									sessionsSize: sessions.size,
									liveSocketCount: session.sockets.size,
									msgType: (message as { type?: string }).type ?? null,
								}),
						);
						priorOwner.sockets.delete(ws);
						session.sockets.add(ws);
						socketOwners.set(ws, session);
						cleanupDetachedSession(priorOwner, "input-orphan-heal");
					}

					if (message.type === "dispose") {
						disposeSession(terminalId ?? "", db);
						return;
					}

					if (session.exited) return;

					if (message.type === "input") {
						session.pty.write(message.data);
						return;
					}

					if (message.type === "resize") {
						const cols = normalizeTerminalDimension(
							message.cols,
							MIN_TERMINAL_COLS,
							DEFAULT_TERMINAL_COLS,
						);
						const rows = normalizeTerminalDimension(
							message.rows,
							MIN_TERMINAL_ROWS,
							DEFAULT_TERMINAL_ROWS,
						);
						session.pty.resize(cols, rows);
						session.modeTracker.resize(cols, rows);
						session.cols = cols;
						session.rows = rows;
					}
				},

				onClose: (_event, ws) => {
					const owner = socketOwners.get(ws);
					if (owner) {
						owner.sockets.delete(ws);
						socketOwners.delete(ws);
						cleanupDetachedSession(owner, "socket-close");
					} else {
						const session = sessions.get(terminalId ?? "");
						session?.sockets.delete(ws);
					}
				},

				onError: (_event, ws) => {
					const owner = socketOwners.get(ws);
					if (owner) {
						owner.sockets.delete(ws);
						socketOwners.delete(ws);
						cleanupDetachedSession(owner, "socket-error");
					} else {
						const session = sessions.get(terminalId ?? "");
						session?.sockets.delete(ws);
					}
				},
			};
		}),
	);
}
