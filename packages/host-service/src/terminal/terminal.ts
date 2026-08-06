import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { NodeWebSocket } from "@hono/node-ws";
import { hasRunningForegroundProcess } from "@superset/pty-daemon/process-tree";
import {
	createOsc133CdScanState,
	type Osc133CdScanState,
	scanForOsc133Cd,
} from "@superset/shared/shell-osc133-cd-scanner";
import {
	createScanState,
	SHELLS_WITH_READY_MARKER,
	type ShellReadyScanState,
	scanForShellReady,
} from "@superset/shared/shell-ready-scanner";
import {
	createTerminalTitleScanState,
	scanForTerminalTitle,
	type TerminalTitleScanState,
} from "@superset/shared/terminal-title-scanner";
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import type { Hono } from "hono";
import { stampHumanInput } from "../companion/human-input.ts";
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
	shellLaunchExpectsReadyMarker,
	waitForTerminalBaseEnv,
} from "./env.ts";
import { listTerminalResourceSessions } from "./resource-sessions.ts";
import {
	createModeTracker,
	type ModeTracker,
	type TerminalSnapshot,
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
	| {
			type: "input";
			data: string;
			/**
			 * (PUSH-PRESENCE) (HUMAN-INPUT-TAGGED) The renderer's claim that a PERSON produced these
			 * bytes — a key press, a paste, or an IME composition within the last
			 * moment — rather than the terminal answering a program's query.
			 *
			 * Optional, and its absence is never read as `true`: an older renderer
			 * does not send it, and a renderer that cannot prove a human simply
			 * omits it. Both then contribute nothing to presence, which is the safe
			 * direction (no keystroke evidence means the decision falls back to the
			 * desktop's beacon, and the fallback errs toward AWAY, i.e. toward
			 * buzzing).
			 */
			human?: boolean;
	  }
	| { type: "resize"; cols: number; rows: number }
	| { type: "dispose" };

// PTY output bytes travel as binary WebSocket frames — the renderer pipes
// the ArrayBuffer straight into xterm.write(Uint8Array) without any UTF-8
// decoding. Control messages stay JSON. Replay (the buffered prefix sent
// on attach) is a binary frame too; the renderer doesn't distinguish it
// from live data.
type TerminalServerMessage =
	| { type: "attached"; terminalId: string }
	// `code: "session-gone"` marks the session as permanently destroyed (not
	// found / disposed / exited) so the renderer can drop persisted scrollback;
	// plain errors leave it unset and the renderer keeps its snapshot.
	| { type: "error"; message: string; code?: "session-gone" }
	| { type: "exit"; exitCode: number; signal: number }
	| { type: "title"; title: string | null };

const MAX_BUFFER_BYTES = 64 * 1024;
// Dim separator delivered ahead of a respawned shell's output so users can
// tell restored scrollback from the fresh session (cf. VS Code's "History
// restored" line).
const SESSION_RESTORED_NOTICE = new TextEncoder().encode(
	"\r\n\x1b[90m─── Session Contents Restored ───\x1b[0m\r\n\r\n",
);
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

/**
 * Upper bound on the OSC 133;A wait before queued automation runs anyway.
 * Wrapper files on disk don't guarantee the marker reaches the scanner —
 * a user rc can exec another process or re-point ZDOTDIR so our .zlogin
 * never runs — and an unbounded wait silently drops preset/agent commands
 * (#4963, regressed by #5774). 15s covers heavy setups like Nix devenv
 * via direnv; same budget as the v1 stack.
 */
const SHELL_READY_TIMEOUT_MS = 15_000;

/**
 * Gap between writing the initialCommand text and the Enter (`\r`) that runs
 * it. The shell-ready marker fires from precmd, before the line editor reads
 * input — plugin init in that window can flush the PTY input queue, eating a
 * newline bundled with the command while the text itself survives in the edit
 * buffer (typed-but-never-run). A separated, delayed Enter lands after that
 * init storm.
 */
const INITIAL_COMMAND_ENTER_DELAY_MS = 500;

/**
 * Shell readiness lifecycle:
 * - `pending`     — shell initialising; scanner active
 * - `ready`       — OSC 133;A detected; scanner off
 * - `timed_out`   — marker never arrived in time; queued automation runs anyway
 * - `unsupported` — launch config has no marker; scanner never started
 * - `cancelled`   — session ended before readiness; queued automation cancelled
 */
type ShellReadyState =
	| "pending"
	| "ready"
	| "timed_out"
	| "unsupported"
	| "cancelled";

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
	/**
	 * Deliver SESSION_RESTORED_NOTICE ahead of the next replay. Kept out of
	 * the FIFO so MAX_BUFFER_BYTES eviction can't drop it before a client
	 * attaches. Cleared on first replay.
	 */
	restoredNoticePending: boolean;
	createdAt: number;
	exited: boolean;
	exitCode: number;
	exitSignal: number;
	listed: boolean;
	title: string | null;
	titleScanState: TerminalTitleScanState;
	/**
	 * Bus for lifecycle broadcasts. Kept on the session so dispose (which
	 * unsubscribes daemon callbacks before the pty dies, muting onExit) can
	 * still announce the exit to renderers.
	 */
	eventBus: EventBus | undefined;

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

function cleanupDetachedSession(
	session: TerminalSession,
	reason: string,
): void {
	if (sessions.get(session.terminalId) === session) return;
	if (session.sockets.size > 0) return;

	cancelShellReady(session);
	if (session.unsubscribeDaemon) {
		try {
			session.unsubscribeDaemon();
		} catch (error) {
			console.error(
				"[terminal] failed to cleanup detached daemon subscription",
				{
					terminalId: session.terminalId,
					reason,
					error,
				},
			);
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
}): Promise<TerminalSession | { error: string; code?: "session-gone" }> {
	const existing = sessions.get(terminalId);
	if (existing) return existing;

	const inFlight = attachResolutions.get(terminalId);
	if (inFlight) return inFlight;

	const resolution = (async (): Promise<
		TerminalSession | { error: string; code?: "session-gone" }
	> => {
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

		// (DISPOSE-LIMBO) Re-read the row immediately before respawning. The
		// respawn below is unconditional on "adopt found no live PTY" — which is
		// ALSO what a dispose that already killed the PTY looks like. A dispose
		// whose row-write hasn't finished (or whose daemon close failed, leaving
		// the row `active` and stamped) would therefore be undone here: the
		// attach would mint a fresh PTY for a terminal the user just killed, and
		// the reaper would kill that one too. `disposeRequestedAt` is the durable
		// intent-to-kill, so its presence forbids respawn outright; only an
		// explicit create clears it (see the upsert in
		// createTerminalSessionInternal).
		const row = db.query.terminalSessions
			.findFirst({
				where: eq(terminalSessions.id, terminalId),
				columns: { disposeRequestedAt: true },
			})
			.sync();
		if (row?.disposeRequestedAt != null) {
			console.warn(
				"[terminal] refusing to respawn a terminal with a pending dispose",
				{ terminalId, disposeRequestedAt: row.disposeRequestedAt },
			);
			return {
				error: `Terminal session "${terminalId}" is being disposed.`,
				code: "session-gone",
			};
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
		cancelShellReady(session);
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
		cancelShellReady(session);
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

/**
 * Whether a terminal id has a live in-memory session on this host-service
 * process. Such sessions already drive their own port scanning and unregister
 * themselves via the daemon exit subscription, so the port-scan sync must leave
 * them alone. Returns false for sessions the daemon still owns but that this
 * process hasn't re-created since its last restart.
 */
export function isLiveTerminalSession(terminalId: string): boolean {
	const session = sessions.get(terminalId);
	return session !== undefined && !session.exited;
}

/**
 * Whether a live session has a foreground command running (vs. sitting at an
 * idle shell prompt). Drives the "close anyway?" confirm on pane close. Unknown
 * sessions, idle prompts, and sessions owned by another workspace return false.
 */
export function sessionHasRunningProcess(
	terminalId: string,
	workspaceId: string,
): boolean {
	const session = sessions.get(terminalId);
	if (!session || session.exited) return false;
	// Ownership gate: don't let one workspace probe another's terminals.
	if (session.workspaceId !== workspaceId) return false;
	return hasRunningForegroundProcess(session.pty.pid);
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

/**
 * Workspace session list sourced from truth, not from this process's memory.
 *
 * The in-memory map is attachment plumbing: it empties on every host-service
 * restart while the detached pty-daemon keeps PTYs alive, and it only
 * repopulates when a renderer attaches. Reading it alone made every pane-less
 * session (background agents) invisible to the session dropdown, the
 * background-terminals dropdown, and pane auto-adoption after a restart.
 *
 * So: in-memory sessions first (they carry liveness, titles, attachment, and
 * respect `listed` for hidden internal sessions), then every other alive
 * daemon session joined to an active workspace-owned row. Dispose-stamped
 * rows are scheduled kills awaiting the reaper — never resurfaced. A session
 * only the daemon knows has never been attached in this process's lifetime,
 * hence `attached: false, title: null`.
 */
export async function listWorkspaceTerminalSessions(
	db: HostDb,
	workspaceId: string,
): Promise<TerminalSessionSummary[]> {
	// `getDaemonClient` gates on the daemon bootstrap (waitForDaemonReady +
	// supervisor.ensure), so a query racing a host-service restart blocks
	// until the daemon is adopted instead of observing it as unreachable.
	let daemonAliveIds: string[] | null;
	try {
		const daemon = await getDaemonClient();
		daemonAliveIds = (await daemon.list())
			.filter((session) => session.alive)
			.map((session) => session.id);
	} catch (error) {
		// Daemon genuinely down — its PTYs died with it, so the in-memory
		// view is the whole truth. The dropdowns' polls re-query, so a
		// transient connection failure self-heals.
		console.warn(
			"[terminal] listWorkspaceTerminalSessions: daemon unreachable, serving in-memory view",
			{ workspaceId, error },
		);
		daemonAliveIds = null;
	}

	// Snapshot memory AFTER the daemon await so a session disposed while the
	// lookup was in flight can't be returned with stale live state.
	const known = listTerminalSessions({ workspaceId, includeExited: false });
	if (daemonAliveIds === null) return known;

	const daemonSessionIds = daemonAliveIds.filter((id) => !sessions.has(id));
	if (daemonSessionIds.length === 0) return known;

	const rows = db
		.select({
			id: terminalSessions.id,
			originWorkspaceId: terminalSessions.originWorkspaceId,
			status: terminalSessions.status,
			createdAt: terminalSessions.createdAt,
			disposeRequestedAt: terminalSessions.disposeRequestedAt,
		})
		.from(terminalSessions)
		.where(inArray(terminalSessions.id, daemonSessionIds))
		.all();

	const merged = [...known];
	for (const row of rows) {
		if (row.originWorkspaceId !== workspaceId) continue;
		if (row.status !== "active") continue;
		if (row.disposeRequestedAt != null) continue;
		merged.push({
			terminalId: row.id,
			workspaceId,
			createdAt: row.createdAt,
			exited: false,
			exitCode: 0,
			attached: false,
			title: null,
		});
	}
	return merged;
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

// (AUTO-RESUME) Fire-time preflight write. Appends the platform EOL so the prompt is
// submitted. NOTE: it deliberately does NOT gate on OSC-133 `commandRunning` — the agent
// CLI (Claude) is itself the long-running foreground shell command, so commandRunning is
// true for the entire agent session; gating on it would block every send. "Agent idle at
// its prompt" is instead proven UPSTREAM by the desktop scheduler's transcript-finality
// gate (the API-error is still the last meaningful record), and the agent-session-id
// binding check is done by the caller (router) via the TerminalAgentStore. Returns a
// structured skip reason rather than throwing so the scheduler can decide retry-vs-give-up.
export type WriteIfIdleResult =
	| { sent: true }
	| {
			sent: false;
			reason: "not_found" | "wrong_workspace" | "exited";
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

	session.pty.write(`${data}${TERMINAL_COMMAND_EOL}`);
	return { sent: true };
}

// Ring-buffer replay after adoption arrives asynchronously over the daemon
// socket, and it is what rebuilds the mode tracker (bracketed paste, screen
// content). Protocol v2 has no replay-complete signal, so watch the replayed
// bytes accumulate — they land in session.buffer, since no renderer is
// attached right after adoption — and return once they quiesce.
const ADOPTION_REPLAY_WAIT_MS = 500;

async function waitForAdoptionReplay(session: TerminalSession): Promise<void> {
	const deadline = Date.now() + ADOPTION_REPLAY_WAIT_MS;
	let seen = -1;
	while (Date.now() < deadline) {
		const count = session.bufferBytes;
		if (count > 0 && count === seen) return;
		seen = count;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

/**
 * Resolve a session for headless IO. The in-memory map empties on every
 * host-service restart while the detached daemon keeps PTYs alive, so a
 * miss is not "gone" — recover it the same way pane auto-adoption does.
 */
async function getOrAdoptSession({
	terminalId,
	workspaceId,
	db,
	eventBus,
}: {
	terminalId: string;
	workspaceId: string;
	db: HostDb;
	eventBus?: EventBus;
}): Promise<TerminalSession | { error: string }> {
	const existing = sessions.get(terminalId);
	if (existing) {
		if (existing.workspaceId !== workspaceId) {
			return { error: "Terminal session does not belong to this workspace" };
		}
		return existing;
	}

	const adopted = await createTerminalSessionInternal({
		terminalId,
		workspaceId,
		db,
		eventBus,
		adoptOnly: true,
	});
	if ("error" in adopted) return adopted;

	await waitForAdoptionReplay(adopted);
	return adopted;
}

/**
 * Public "send a follow-up to whatever runs in this terminal" path. Frames
 * the text as a bracketed paste when the running program has that mode on,
 * so embedded newlines reach a TUI agent (claude/codex) as literal newlines
 * rather than premature Enter presses.
 */
export async function writeFramedInputToSession({
	terminalId,
	workspaceId,
	text,
	submit,
	db,
	eventBus,
}: {
	terminalId: string;
	workspaceId: string;
	text: string;
	submit: boolean;
	db: HostDb;
	eventBus?: EventBus;
}): Promise<{ success: true } | { error: string }> {
	const session = await getOrAdoptSession({
		terminalId,
		workspaceId,
		db,
		eventBus,
	});
	if ("error" in session) return session;
	if (session.exited) {
		return { error: "Terminal session has exited" };
	}

	const framed = session.modeTracker.isBracketedPasteActive()
		? `\x1b[200~${text}\x1b[201~`
		: text;
	session.pty.write(submit ? `${framed}\r` : framed);
	return { success: true };
}

/**
 * Non-destructive read of the terminal's current screen (and recent
 * scrollback) off the per-session headless emulator. For TUI agents this is
 * the alt-screen the agent renders to — i.e. its visible output.
 */
export async function snapshotSession({
	terminalId,
	workspaceId,
	maxLines,
	db,
	eventBus,
}: {
	terminalId: string;
	workspaceId: string;
	maxLines?: number;
	db: HostDb;
	eventBus?: EventBus;
}): Promise<({ success: true } & TerminalSnapshot) | { error: string }> {
	const session = await getOrAdoptSession({
		terminalId,
		workspaceId,
		db,
		eventBus,
	});
	if ("error" in session) return session;
	return { success: true, ...session.modeTracker.snapshot(maxLines) };
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

export function replayBuffer(session: TerminalSession, socket: TerminalSocket) {
	// sendBytes below no-ops on a non-open socket — bail before clearing the
	// buffer/notice so the next attach can still replay them.
	if (socket.readyState !== SOCKET_OPEN) return;
	// Preamble first, then the restored notice, then FIFO. Mode-setting
	// escapes (kitty keyboard, bracketed paste, focus, …) are typically
	// emitted once at startup and broadcast away rather than buffered, so a
	// fresh xterm needs them re-asserted on every attach — even when the
	// FIFO is empty.
	const preamble = session.modeTracker.buildPreamble();
	const notice = session.restoredNoticePending ? SESSION_RESTORED_NOTICE : null;
	let bufferTotal = 0;
	for (const b of session.buffer) bufferTotal += b.byteLength;
	const preambleLen = preamble?.byteLength ?? 0;
	const noticeLen = notice?.byteLength ?? 0;
	if (preambleLen === 0 && noticeLen === 0 && bufferTotal === 0) return;

	const combined = new Uint8Array(preambleLen + noticeLen + bufferTotal);
	let offset = 0;
	if (preamble) {
		combined.set(preamble, offset);
		offset += preamble.byteLength;
	}
	if (notice) {
		combined.set(notice, offset);
		offset += notice.byteLength;
	}
	for (const b of session.buffer) {
		combined.set(b, offset);
		offset += b.byteLength;
	}
	session.restoredNoticePending = false;
	session.buffer.length = 0;
	session.bufferBytes = 0;
	sendBytes(socket, combined);
}

function clearShellReadyTimeout(session: TerminalSession): void {
	if (session.shellReadyTimeoutId) {
		clearTimeout(session.shellReadyTimeoutId);
		session.shellReadyTimeoutId = null;
	}
}

/** Transition out of `pending` on marker match or timeout expiry. */
function resolveShellReady(
	session: TerminalSession,
	state: "ready" | "timed_out",
): void {
	if (session.shellReadyState !== "pending") return;
	session.shellReadyState = state;
	clearShellReadyTimeout(session);
	// On timeout the scanner may be withholding a partial marker prefix that
	// never completed — those bytes are real output and must be released.
	if (session.scanState.heldBytes.length > 0) {
		const heldBytes = Uint8Array.from(session.scanState.heldBytes);
		session.scanState.heldBytes.length = 0;
		session.scanState.matchPos = 0;
		session.modeTracker.feed(heldBytes);
		if (broadcastBytes(session, heldBytes) === 0) {
			bufferOutput(session, heldBytes);
		}
	}
	if (session.shellReadyResolve) {
		session.shellReadyResolve();
		session.shellReadyResolve = null;
	}
}

/** Release pending readiness waiters without allowing queued input to run. */
function cancelShellReady(session: TerminalSession): void {
	if (session.shellReadyState !== "pending") return;
	session.shellReadyState = "cancelled";
	clearShellReadyTimeout(session);
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
	const commandText = initialCommand.replace(/[\r\n]+$/, "");
	// Marker-backed shells can run interactive startup hooks that read or flush
	// PTY input before the first prompt (direnv/devenv is one example). Wait for
	// that prompt so the command cannot be consumed as startup input. Launches
	// without a verified marker resolve this promise immediately, and a missing
	// marker resolves it via SHELL_READY_TIMEOUT_MS — the command must
	// eventually run; only session teardown may cancel it.
	void session.shellReadyPromise.then(() => {
		if (session.exited || session.shellReadyState === "cancelled") return;
		// The OSC 133;A marker fires from precmd, which runs BEFORE the line
		// editor starts reading input. Plugin init in that gap (vi-mode,
		// syntax-highlighting) can flush the PTY input queue mid-read, eating a
		// trailing newline sent in the same write: the command text survives in
		// the editor's buffer but never executes. Send Enter as its own delayed
		// write — and as `\r`, what a real Enter key sends, bound to accept-line
		// in every keymap — so it lands after the init storm. One Enter total,
		// so a double-run is impossible.
		session.pty.write(commandText);
		setTimeout(() => {
			if (session.exited || session.shellReadyState === "cancelled") return;
			session.pty.write("\r");
		}, INITIAL_COMMAND_ENTER_DELAY_MS);
	});
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
	/**
	 * (DISPOSE-LIMBO) Why the daemon close did not confirm. Present iff
	 * `daemonCloseSucceeded` is false, so a caller cannot report "disposed"
	 * without having a reason to hand instead.
	 */
	daemonCloseError?: string;
}

/** (DISPOSE-LIMBO) Render an unknown thrown value as one loggable line. */
function describeDaemonCloseError(error: unknown): string {
	if (error === undefined) return "daemon close did not confirm";
	if (error instanceof Error) return error.message;
	return String(error);
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

	// Durable intent-to-kill: if this attempt fails (daemon hiccup, host
	// restart mid-kill), the reaper retries any stamped row — a one-shot
	// renderer broadcast must not be the only chance to kill a session.
	// First request time wins so retries don't look like fresh requests.
	db.update(terminalSessions)
		.set({ disposeRequestedAt: Date.now() })
		.where(
			and(
				eq(terminalSessions.id, terminalId),
				isNull(terminalSessions.disposeRequestedAt),
			),
		)
		.run();
	const session = sessions.get(terminalId);
	let closePromise: Promise<DaemonCloseResult> | null = null;

	if (session) {
		cancelShellReady(session);
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
		const endedAt = Date.now();
		db.update(terminalSessions)
			.set({ status: "disposed", endedAt })
			.where(eq(terminalSessions.id, terminalId))
			.run();

		// Dispose unsubscribed the daemon callbacks above, so onExit will
		// never fire for this session — announce the exit here (after the
		// row flips to disposed, so refetching readers see it dead). Skip
		// sessions whose pty already exited: onExit broadcast that one.
		if (session && !session.exited) {
			session.eventBus?.broadcastTerminalLifecycle({
				workspaceId: session.workspaceId,
				terminalId,
				eventType: "exit",
				exitCode: 0,
				signal: 0,
				occurredAt: endedAt,
			});
		}
	} else {
		// (DISPOSE-LIMBO) The daemon never confirmed the close. Before this
		// branch existed the function simply fell through: the row stayed
		// `active` with only `disposeRequestedAt` stamped, NOTHING was
		// broadcast, and the renderer was never told anything at all. Its
		// socket had already been closed above, its re-dial was refused, and
		// the transport latched `_terminated` — a red "Disconnected" pane that
		// could not self-heal until the reaper's next pass (up to
		// REAP_INTERVAL_MS later; observed at 21 minutes).
		//
		// The terminal is unusable from here: the sockets are closed, the row
		// carries the intent-to-kill stamp, and attach now refuses to respawn a
		// stamped row (see resolveAttachSessionOnce). So tell the renderer what
		// it needs to act on — this terminal is finished — using the same
		// lifecycle exit event the confirmed path emits. The row is
		// deliberately left `active` for the reaper to retry; "the renderer
		// gives up on the pane" and "the host stops trying to kill the PTY" are
		// different questions and only the first is answered here.
		console.error("[terminal] dispose did not confirm; terminal is in limbo", {
			terminalId,
			workspaceId: session?.workspaceId,
			daemonCloseAttempted: closeResult.attempted,
			error: closeResult.error,
		});
		if (session) {
			session.eventBus?.broadcastTerminalLifecycle({
				workspaceId: session.workspaceId,
				terminalId,
				eventType: "exit",
				exitCode: 0,
				signal: 0,
				occurredAt: Date.now(),
			});
		}
	}

	return {
		terminalId,
		daemonCloseAttempted: closeResult.attempted,
		daemonCloseSucceeded: closeResult.succeeded,
		...(closeResult.succeeded
			? {}
			: { daemonCloseError: describeDaemonCloseError(closeResult.error) }),
	};
}

/**
 * Dispose every active session belonging to the given workspace, then drop the
 * confirmed-dead rows so the workspace's session index dies with it rather than
 * lingering as `set null` orphans. A still-`active` row is a failed kill we keep
 * reachable for the reaper. Returns counts so callers (e.g.
 * workspaceCleanup.destroy) can surface warnings.
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

	db.delete(terminalSessions)
		.where(
			and(
				eq(terminalSessions.originWorkspaceId, workspaceId),
				ne(terminalSessions.status, "active"),
			),
		)
		.run();

	return { terminated, failed };
}

/**
 * Dispose every active session for any workspace mapped to the given worktree
 * path. Deleting a closed worktree has no workspace id, so we join through the
 * workspaces table on the shared worktree path.
 */
export async function disposeSessionsByWorktreePath(
	worktreePath: string,
	db: HostDb,
): Promise<{ terminated: number; failed: number }> {
	const workspaceRows = db
		.select({ id: workspaces.id })
		.from(workspaces)
		.where(eq(workspaces.worktreePath, worktreePath))
		.all();

	let terminated = 0;
	let failed = 0;
	for (const { id } of workspaceRows) {
		const result = await disposeSessionsByWorkspaceId(id, db);
		terminated += result.terminated;
		failed += result.failed;
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
	/**
	 * Deliver a "session restored" separator ahead of the first replay. Set on
	 * the cold-restore respawn path, where the renderer paints stale scrollback
	 * above a brand-new shell.
	 */
	restoredNotice?: boolean;
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
	restoredNotice = false,
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

	// Use the preserved shell snapshot — never live process.env. Resolution
	// runs in the background at startup so the server can listen immediately;
	// wait for it here before the first PTY needs the snapshot.
	await waitForTerminalBaseEnv();
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

	// (DISPOSE-LIMBO) Everything from here to the row insert is the second half
	// of an atomic create: the PTY is LIVE but nothing durable references it yet.
	// A throw in this window (the insert's SQLITE_BUSY is live — busy_timeout is
	// 5s, not infinite) used to escape with the PTY still running and no row, so
	// the reaper killed it under a user who thought they had a terminal and
	// persistence's deleteDefunct dropped the agent binding. Kill what we opened
	// before rethrowing, so failure leaves nothing behind.
	//
	// This is a SEPARATE try from the open/adopt block above on purpose. That
	// block converts failure to `{ error }`, which resolveAttachSessionOnce reads
	// as "adopt found nothing, respawn it" — routing a transient DB error into
	// that path would respawn a PTY instead of reporting the fault. A throw here
	// keeps the pre-existing caller contract (both statements already sat outside
	// every try, so they always threw) while adding the cleanup.
	let pty: DaemonPty;
	const createdAt = Date.now();
	try {
		pty = makeDaemonPty(daemon, terminalId, openResult.pid);

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
					// (DISPOSE-LIMBO) An explicit create is the ONLY thing that
					// clears the durable intent-to-kill stamp. Without this a
					// respawned row inherited the old `disposeRequestedAt`, so
					// shouldReapRow reaped a brand-new healthy terminal and the
					// session dropdown hid it — the terminal died minutes after
					// being created, for no reason the user could see.
					disposeRequestedAt: null,
				},
			})
			.run();
	} catch (error) {
		console.error(
			"[terminal] create failed after the daemon PTY was open; closing it",
			{ terminalId, workspaceId, isAdopted, error },
		);
		if (!isAdopted) {
			// Only close what THIS call opened. An adopted PTY pre-dates us and
			// may still be legitimately owned by an existing row.
			try {
				await closeDaemonSessionById(terminalId, "SIGHUP");
			} catch (closeError) {
				console.error("[terminal] failed to close the orphaned daemon PTY", {
					terminalId,
					closeError,
				});
			}
		}
		throw error;
	}

	// Determine shell readiness support. Adopted sessions are already past
	// shell startup, so treat them as immediately ready — the OSC 133;A
	// marker has already flown by and we don't want to gate writes on it.
	// Normalize the basename across separators and a Windows `.exe` suffix so
	// `C:\...\pwsh.exe` / `/usr/bin/zsh` both resolve to a plain shell name.
	const shellName = (shell.split(/[\\/]/).pop() || shell).replace(
		/\.exe$/i,
		"",
	);
	// PowerShell emits its OSC 133 markers via superset-pwsh-integration.ps1,
	// which upstream's wrapper-file check does not model — keep pwsh/powershell
	// name-based so the A-scan (and the blue-dot C/D scanner handoff) still
	// engage on Windows. zsh/bash/fish go through the wrapper-precise check so a
	// stale or missing wrapper resolves as unsupported instead of stalling the
	// initial-command gate (which no longer has a timeout backstop).
	const isPowerShellReady = shellName === "pwsh" || shellName === "powershell";
	const shellSupportsReady =
		!isAdopted &&
		(isPowerShellReady ||
			shellLaunchExpectsReadyMarker({ shell, supersetHomeDir }));
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
		// Adopted sessions kept a live shell — nothing was restored.
		restoredNoticePending: restoredNotice && !isAdopted,
		createdAt,
		exited: false,
		exitCode: 0,
		exitSignal: 0,
		listed,
		title: null,
		titleScanState: createTerminalTitleScanState(),
		eventBus,
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
					// Runs even when the decoder buffers a partial codepoint into ""
					// — the chunk is still output and must refresh the idle clock.
					portManager.checkOutputForHint(terminalId, hintText);

					// Feed the tracker on every byte — broadcast skips the FIFO,
					// so this is the only path that catches startup mode escapes.
					session.modeTracker.feed(bytes);

					if (broadcastBytes(session, bytes) === 0) {
						bufferOutput(session, bytes);
					}
				},
				onExit({ code, signal }) {
					session.exited = true;
					cancelShellReady(session);
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
				TerminalSession | { error: string; code?: "session-gone" }
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
						code: "session-gone",
					};
				}
				if (record.status === "disposed") {
					return {
						error: `Terminal session "${terminalId}" is disposed.`,
						code: "session-gone",
					};
				}
				if (record.status === "exited") {
					return {
						error: `Terminal session "${terminalId}" has exited.`,
						code: "session-gone",
					};
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
							// (DISPOSE-LIMBO) A refused attach used to travel ONLY
							// down the socket: host-service.log carried no trace of
							// it, so a pane stuck on "Disconnected" left nothing to
							// diagnose from on the host side. It is the host's own
							// decision — log it where the host's other terminal
							// lifecycle decisions are logged.
							console.warn("[terminal] attach refused", {
								terminalId,
								requestedWorkspaceId,
								code: session.code,
								error: session.error,
							});
							sendMessage(ws, {
								type: "error",
								message: session.error,
								code: session.code,
							});
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
						// (PUSH-PRESENCE) THE ONE PLACE A HUMAN KEYSTROKE IS RECORDED.
						//
						// Gated on `human === true`, which is the renderer's explicit
						// claim that a PERSON produced these bytes. Reaching this branch
						// is not by itself that evidence, and the gap is not theoretical:
						// xterm fires `onData` for terminal PROTOCOL REPLIES too — a
						// Device Attributes, cursor-position or XTGETTCAP answer to a
						// query the program on the other end sent — and those arrived
						// here as ordinary `{type:"input"}` frames. A TUI that polls the
						// cursor position therefore stamped presence several times a
						// second with nobody in the room, and every companion push stayed
						// held for as long as it ran. xterm knows the difference
						// (`wasUserInput`) and does not expose it on `onData`, so the
						// renderer witnesses the key/paste/composition events itself and
						// tags the frame.
						//
						// VALIDATED AT THE BOUNDARY: anything that is not literally `true`
						// — absent, null, a string, an older renderer that never heard of
						// the field — is NOT human. Presence then rests on the desktop's
						// 15 s beacon alone, which errs toward AWAY, i.e. toward buzzing.
						// Reading absence as human is the failure that silences a blocked
						// agent.
						//
						// `writeInputToSession` / `writeFramedInputToSession` MUST NOT
						// stamp, and the reason is not stylistic: they are the pty
						// writers the COMPANION'S OWN answer path uses, plus every
						// programmatic sender (auto-resume, `terminal.send`). Stamping
						// there would make an answer typed from the phone read as the
						// user being at their desk, and the next question would be held
						// back from the very device that just answered one.
						if (message.human === true) stampHumanInput();
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
