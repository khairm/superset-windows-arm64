import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { NodeWebSocket } from "@hono/node-ws";
import { resolveSupersetHomeDir } from "@superset/agent-setup/paths";
import { hasRunningForegroundProcess } from "@superset/pty-daemon/process-tree";
import { CURRENT_PROTOCOL_VERSION } from "@superset/pty-daemon/protocol";
import {
	buildFishPromptCommandString,
	type ParsedPromptHeredocCommand,
	parsePromptHeredocCommand,
} from "@superset/shared/agent-prompt-launch";
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
import type { ClaudeAccountsService } from "../claude-accounts";
import { getManagedClaudeAccountsForLaunch } from "../claude-accounts-runtime";
import { stampHumanInput } from "../companion/human-input.ts";
import { getSupervisor } from "../daemon/index.ts";
import { isProcessAlive, readPtyDaemonManifest } from "../daemon/manifest.ts";
import type { HostDb } from "../db/index.ts";
import { projects, terminalSessions, workspaces } from "../db/schema.ts";
import type { EventBus } from "../events/index.ts";
import { portManager } from "../ports/port-manager.ts";
import { sweepAgentBindingsAfterDaemonLoss } from "../terminal-agents/daemon-loss-sweep.ts";
import { markTerminalAgentBindingEnded } from "../terminal-agents/persistence.ts";
import { resolveDefaultAccountTerminalEnv } from "../trpc/router/usage/default-account.ts";
import {
	AcknowledgedInputError,
	type AcknowledgedInputFailureKind,
	DaemonClient,
	type Signal as DaemonSignal,
	DaemonUnavailableError,
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
	getShellReadyMarkerEvidence,
	recordShellReadyMarkerEvidence,
} from "./shell-ready-evidence.ts";
import {
	createModeTracker,
	type ModeTracker,
	type TerminalSnapshot,
} from "./terminal-mode-tracker.ts";
import {
	isWorkspaceLaunchFenced,
	isWorkspaceRetirementActive,
	readWorkspaceLaunchEpoch,
} from "./workspace-launch-fence.ts";
import { toWsCloseReason } from "./ws-close-reason.ts";

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
	acknowledgedInputSupported: boolean;
	write(data: string): void;
	writeAcknowledged(data: string): Promise<void>;
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
		acknowledgedInputSupported: daemon.protocol === CURRENT_PROTOCOL_VERSION,
		write(data) {
			try {
				daemon.input(sessionId, Buffer.from(data, "utf8"));
			} catch {
				// Daemon socket died before the disconnect sweep ran; a throw
				// here would escape the WS input handler uncaught.
			}
		},
		writeAcknowledged(data) {
			return daemon.inputAcknowledged(sessionId, Buffer.from(data, "utf8"));
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
	// The client's current keyboard-focus state, sent on every attach. A
	// reattaching client may hold focus the program last heard it lost (or
	// vice versa) — a fresh xterm can't self-report because focus-reporting
	// mode only reaches it via the preamble after its focus already settled.
	// The host forwards it as \x1b[I / \x1b[O only when the program actually
	// enabled focus reporting (mode 1004), which the tracker knows.
	| { type: "focus"; focused: boolean }
	// Whether this client is actually showing the terminal right now — its pane
	// is on screen and its app is foregrounded. Distinct from keyboard focus: a
	// visible unfocused pane still has to render at the right size. Only visible
	// clients constrain the PTY size. A client that never sends this counts as
	// visible, so builds predating the message keep their existing sizing.
	| { type: "visible"; visible: boolean }
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
	// `code: "attach-retryable"` marks a transient host-side failure (pty-daemon
	// stalled/restarting) — the renderer keeps its reconnect loop alive instead
	// of parking the pane dead. Plain errors leave it unset and the renderer
	// keeps its snapshot but stops retrying.
	| {
			type: "error";
			message: string;
			code?: "session-gone" | "attach-retryable";
	  }
	| { type: "exit"; exitCode: number; signal: number }
	| { type: "title"; title: string | null }
	// Sequence anchor for seq-aware clients (`?seq=` on the attach URL). Sent
	// once per attach, AFTER any host-synthesized bytes (mode preamble,
	// restored notice) and BEFORE catch-up/live PTY bytes. The client sets its
	// byte counter to `seq` and counts every subsequent binary frame, so both
	// sides agree on stream position without per-frame headers.
	// - `exact`:    client's anchor was inside the catch-up ring — the binary
	//               bytes that follow are exactly the missed suffix.
	// - `tail`:     client attached empty — whatever ring content exists
	//               follows as a best-effort scrollback restore.
	// - `reanchor`: the client's position is unknown or unrecoverable (epoch
	//               mismatch after a host restart, gap beyond the ring). No
	//               content bytes are sent — the client's screen is presumed
	//               better than anything we could synthesize (see #6290) — and
	//               a repaint nudge asks the running program to redraw itself.
	| { type: "synced"; epoch: string; seq: number; mode: SyncedMode };

type SyncedMode = "exact" | "tail" | "reanchor";

/**
 * Parsed `?seq=` attach param.
 * - absent  → legacy client: byte-identical pre-seq behavior (preamble + FIFO).
 * - "new"   → seq-aware client with a virgin xterm: wants the ring tail.
 * - "none"  → seq-aware client with restored content but no trustworthy
 *             anchor (persisted by an older build, multi-instance seed):
 *             reanchor without dumping bytes into its existing screen.
 * - "<epoch>:<n>" → anchored client: exact catch-up when possible.
 */
type SeqAttachRequest =
	| { kind: "legacy" }
	| { kind: "new" }
	| { kind: "none" }
	| { kind: "anchor"; epoch: string; seq: number };

function parseSeqAttachParam(
	value: string | null | undefined,
): SeqAttachRequest {
	// Absent means a pre-seq client; an explicitly empty value is a malformed
	// seq-aware dial and falls through to the safe reanchor below.
	if (value === null || value === undefined) return { kind: "legacy" };
	if (value === "new") return { kind: "new" };
	if (value === "none") return { kind: "none" };
	const sep = value.indexOf(":");
	if (sep > 0) {
		const epoch = value.slice(0, sep);
		const seq = Number(value.slice(sep + 1));
		if (epoch && Number.isSafeInteger(seq) && seq >= 0) {
			return { kind: "anchor", epoch, seq };
		}
	}
	// Malformed → safest degraded mode: reanchor, never dump bytes.
	return { kind: "none" };
}

const MAX_BUFFER_BYTES = 64 * 1024;
/**
 * Catch-up ring cap per session. Sized so that a renderer that missed output
 * (laptop sleep, back-pressure drop, parked-runtime eviction) can almost
 * always be caught up with the exact missed bytes instead of a lossy
 * reanchor — the deterministic ghost repro from #6279 was ~105 KB of missed
 * TUI repaints; 2 MiB gives ~20x margin while staying far under the 8 MiB
 * per-socket send cap. Memory is bounded per session and only holds bytes
 * actually emitted.
 */
const CATCHUP_RING_CAP_BYTES = 2 * 1024 * 1024;
/**
 * How long after a reanchor attach to wait for the renderer's own resize
 * (which fires a natural SIGWINCH when dims changed) before forcing the
 * repaint nudge anyway.
 */
const REPAINT_NUDGE_FALLBACK_MS = 2_000;
/** Gap between the nudge's shrink and restore resizes. */
const REPAINT_NUDGE_RESTORE_MS = 60;
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
 * Wait budget when learned evidence says this machine's profile never
 * delivers the marker (see shell-ready-evidence.ts): the full 15s wait would
 * be the *normal* path there — every preset launch stalled exactly 15s
 * (SUPER-1103). A short grace still covers the init window where startup
 * hooks can read or flush PTY input, without pretending a marker is coming.
 * A marker observed within this grace flips the evidence back to
 * `delivered`, restoring the full wait for later launches.
 */
const SHELL_READY_MISSING_MARKER_GRACE_MS = 2_000;

/**
 * How long after creation a session whose marker wait timed out keeps
 * watching the stream for a late OSC 133;A. A marker that lands after the
 * grace window (a slow-init profile branded `missing`) is still proof this
 * profile delivers — record it so the evidence self-heals in both directions
 * instead of `missing` being a one-way brand. Evidence-only: nothing is
 * withheld from the output stream. Bounded to the full marker budget so the
 * scan can't run for the session's whole life.
 */
const LATE_MARKER_OBSERVATION_MS = SHELL_READY_TIMEOUT_MS;

/**
 * How long a grace-window launch watches the PTY stream for its own command
 * echoing back before concluding a startup stdin reader ate it. The grace
 * fires on learned evidence, not an observed prompt, so an oh-my-zsh-style
 * `read` can still be consuming the TTY when we type (the #3941 eater class
 * combined with a marker-less profile). Echo is the same kind of evidence the
 * marker was: proof of what the shell actually received.
 */
const GRACE_ECHO_WINDOW_MS = 1_200;

/**
 * Output silence required after an intact-looking echo before trusting it.
 * The kernel echoes typed bytes at input time, before any reader consumes
 * them, so an intact echo alone can't prove the line editor holds the text —
 * a raw-mode `read -k` steals the first byte(s) anyway and the surviving
 * suffix re-echoes moments later when the editor drains the queue. The quiet
 * window gives that mangle signature time to arrive.
 */
const GRACE_ECHO_QUIET_MS = 250;

/**
 * Retype attempts (Ctrl-U + text) after a missed or mangled echo before
 * falling back to typing blind, exactly like the marker-timeout path always
 * has. Each cycle costs at most one echo window, so this also bounds added
 * latency when echo detection false-negatives (a TUI repainting instead of
 * echoing).
 */
const GRACE_ECHO_MAX_RETYPES = 2;

/**
 * Output silence required before an ungated launch (no marker expected at
 * all: unwrapped bash, sh/ksh, nushell) types its initialCommand. Typing
 * while startup output is still streaming is how reedline-class editors
 * (nushell) lose the command outright: they enable raw mode after init and
 * flush pending typeahead — the kernel-echoed command looks delivered but the
 * editor never held it (#6024). Quiescence alone is not enough (a silent
 * startup `read -t` window looks quiescent, #3941/#5712) — that's what the
 * echo verification below catches.
 */
const UNGATED_QUIESCENT_MS = 500;

/**
 * Cap on each quiescence wait so a busy startup (spinners, streaming MOTD)
 * can only delay an ungated launch, never park it. After the cap the launch
 * proceeds to the echo-verified type, whose retype loop is the real guard.
 */
const UNGATED_QUIESCENCE_CAP_MS = 8_000;

/**
 * Echo window for ungated launches. Must cover the post-echo quiet
 * requirement (INITIAL_COMMAND_ENTER_DELAY_MS, doing double duty as the
 * text→Enter separation) plus echo latency.
 */
const UNGATED_ECHO_WINDOW_MS = 1_800;

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
 * Gap between a follow-up send's text and the Enter that submits it. TUI
 * agents treat bytes arriving together as one paste burst, so an Enter
 * bundled with the text can be swallowed into the draft instead of
 * submitting it when the session is busy or slow (#6243). The delay puts
 * the Enter in its own read, where it can only be a keypress.
 */
const FOLLOW_UP_ENTER_DELAY_MS = 500;

/**
 * Byte ceiling for typing an initialCommand directly into the PTY. The
 * shell-ready marker fires from precmd, before the line editor switches the
 * TTY to raw mode; input written in that gap queues under the kernel's
 * canonical-mode line discipline, which silently drops every byte past
 * MAX_CANON (1024 on macOS). Long agent launches lost their closing quote
 * and wedged the shell at `quote>` (#5092). Commands over this limit are
 * staged as a temp script and only a short source line is typed; 512 leaves
 * margin for platforms with tighter line-discipline limits.
 */
const MAX_TYPED_INITIAL_COMMAND_BYTES = 512;

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
	/** Handle for db writes from module-scope handlers (daemon disconnect). */
	db: HostDb;
	pty: DaemonPty;
	cols: number;
	rows: number;
	/** Unsubscribe from the daemon's output/exit stream when disposed. */
	unsubscribeDaemon: (() => void) | null;
	sockets: Set<TerminalSocket>;
	/**
	 * Legacy replay FIFO for clients that attach without `?seq=` (pre-seq
	 * renderers, raw WS consumers): fills only while zero sockets are
	 * attached, drained by replayBuffer(). Seq-aware clients are served from
	 * the `retained` catch-up ring instead. Delete once the renderer floor
	 * speaks seq. Bytes, not strings — byte-aligned with the wire so
	 * per-chunk UTF-8 decoding can't mangle TUIs.
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
	/**
	 * True when this launch's readiness timeout was the short learned grace
	 * rather than the full fallback. A grace timeout types while startup may
	 * still be consuming stdin, so that path must echo-verify what it typed.
	 */
	usedMissingMarkerGrace: boolean;
	/**
	 * True once a post-timeout OSC 133;A was seen and recorded as `delivered`
	 * evidence, ending the late-marker scan for this session.
	 */
	lateMarkerRecorded: boolean;
	/**
	 * Active echo watcher for a grace-window initialCommand: fed every output
	 * chunk so typeInitialCommandVerifyingEcho can see its text echo back.
	 */
	echoProbe: ((bytes: Uint8Array) => void) | null;
	/**
	 * Trailing bytes of the previous output chunk (up to 3), so a DSR cursor
	 * query (`ESC[6n`) straddling a chunk boundary is still recognized.
	 */
	dsrCarry: Uint8Array;
	initialCommandQueued: boolean;
	/**
	 * Basename of the launch shell. Picks the source keyword when a long
	 * initialCommand is staged as a script (fish 4 removed `.`; sh/ksh
	 * have no `source`).
	 */
	launchShellName: string;

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

	/**
	 * Resolves once the daemon's post-adoption ring-buffer replay has
	 * quiesced (immediately for non-adopted sessions). Attach paths await it
	 * before delivering to a socket, so the mode preamble is built from a
	 * tracker that has actually seen the program's mode bytes and replayed
	 * bytes never broadcast to a just-attached client.
	 */
	adoptionReplaySettled: Promise<void>;

	/**
	 * Stream identity for seq-aware clients. Fresh per TerminalSession object
	 * (create, adopt, respawn) — a client anchored to a different epoch has an
	 * unknowable position (the byte counter restarted) and gets a reanchor.
	 */
	epoch: string;
	/** Absolute count of PTY output bytes emitted since this session object was created. */
	outputSeq: number;
	/**
	 * Catch-up ring: the retained tail of the output stream, so a reattaching
	 * seq-aware client receives exactly the bytes it missed (exactly-once
	 * delivery, Eternal-Terminal style) instead of a lossy tail dump. Unlike
	 * the legacy FIFO (`buffer`), this retains regardless of attached sockets.
	 */
	retained: Uint8Array[];
	retainedBytes: number;
	/** Absolute seq of the first byte still in `retained`. */
	retainedStartSeq: number;
	/**
	 * Armed on a reanchor attach: the client may have missed output we can't
	 * re-deliver, so once its resize arrives (or the fallback timer fires),
	 * force a SIGWINCH repaint so the running program redraws itself — the
	 * only party that always knows the full screen truth.
	 */
	pendingRepaintNudge: ReturnType<typeof setTimeout> | null;
	/** Bumped on every client resize; guards the nudge's delayed restore. */
	resizeGeneration: number;
	/**
	 * Sockets whose client currently holds keyboard focus. The PTY receives
	 * the AGGREGATE (any focused socket) — so an unfocused duplicate pane
	 * attaching can't tell the program the focused pane lost focus (tmux's
	 * client-focus ownership model).
	 */
	focusedSockets: Set<TerminalSocket>;
	/**
	 * Last dims each attached client reported. The PTY runs at the smallest box
	 * across the visible ones (tmux's rule) rather than at whatever client
	 * resized last — last-writer-wins left every other client rendering output
	 * laid out for a width it doesn't have, and the wide-into-narrow direction
	 * (desktop's 120 columns replayed into a phone's 45) is unreadable.
	 */
	clientDims: Map<TerminalSocket, { cols: number; rows: number }>;
	/**
	 * Sockets whose client said it is off screen. Absence means visible, so a
	 * client that never sends the message keeps constraining the size as it
	 * always has. Hidden clients are excluded from the minimum: a backgrounded
	 * phone must not hold the PTY narrow for whoever is actually looking.
	 */
	hiddenSockets: Set<TerminalSocket>;

	/**
	 * Tail of the in-flight follow-up send (writeFramedInputToSession).
	 * Serializes text + delayed-Enter sequences so concurrent sends can't
	 * interleave inside another send's Enter window.
	 */
	followUpWriteChain?: Promise<void>;
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
}: {
	terminalId: string;
	workspaceId: string;
	themeType?: "dark" | "light";
	db: HostDb;
	eventBus?: EventBus;
}): Promise<
	| TerminalSession
	| { error: string; code?: "session-gone"; transient?: boolean }
> {
	const existing = sessions.get(terminalId);
	if (existing) return existing;

	const inFlight = attachResolutions.get(terminalId);
	if (inFlight) return inFlight;

	const resolution = (async (): Promise<
		| TerminalSession
		| { error: string; code?: "session-gone"; transient?: boolean }
	> => {
		const current = sessions.get(terminalId);
		if (current) return current;

		// (DISPOSE-LIMBO) Read the durable intent-to-kill BEFORE the adopt, not
		// after it. The check used to sit below, guarding only the respawn — but
		// a successful ADOPT reaches neither the check nor the respawn, and the
		// create it runs through clears `disposeRequestedAt` on its way past. So
		// attaching to a killed-but-still-breathing terminal (exactly the
		// dispose-limbo case: close unconfirmed, pty alive, row stamped) erased
		// the kill intent, disarmed the reaper, and resurrected the terminal
		// permanently. The stamp forbids BOTH recovery paths; only an explicit
		// create clears it (see the upsert in createTerminalSessionInternal).
		const stampedRow = db.query.terminalSessions
			.findFirst({
				where: eq(terminalSessions.id, terminalId),
				columns: { disposeRequestedAt: true },
			})
			.sync();
		if (stampedRow?.disposeRequestedAt != null) {
			console.warn(
				"[terminal] refusing to attach a terminal with a pending dispose",
				{
					terminalId,
					disposeRequestedAt: stampedRow.disposeRequestedAt,
				},
			);
			return {
				error: `Terminal session "${terminalId}" is being disposed.`,
				code: "session-gone",
			};
		}

		const adopted = await createTerminalSessionInternal({
			terminalId,
			workspaceId,
			themeType,
			db,
			eventBus,
			adoptOnly: true,
		});
		if (!("error" in adopted)) {
			const live = sessions.get(terminalId);
			if (live && live !== adopted) {
				cleanupDetachedSession(adopted, "attach-resolution-overwritten");
				return live;
			}
			return adopted;
		}

		// Daemon unreachable ≠ PTY lost: the shell may still be alive behind the
		// stall, so don't end agent bindings or respawn — let the renderer retry
		// until the daemon answers.
		if (adopted.transient) return adopted;

		// (DISPOSE-LIMBO) Re-read the stamp immediately before respawning. The
		// respawn below is unconditional on "adopt found no live PTY" — which is
		// ALSO what a dispose that already killed the PTY looks like. A dispose
		// that landed DURING the adopt above (the pre-adopt check passed, then
		// the stamp was written) would therefore be undone here: the attach
		// would mint a fresh PTY for a terminal the user just killed, and the
		// reaper would kill that one too.
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
		// Any agent bound to the old PTY died with it without a goodbye;
		// mark its binding ended so it surfaces as a resume candidate.
		console.log(`[terminal] respawning lost session ${terminalId}`);
		try {
			markTerminalAgentBindingEnded(db, terminalId, "terminal-exited");
		} catch (error) {
			console.warn(
				`[terminal] failed to mark agent binding ended for ${terminalId}`,
				error,
			);
		}
		const created = await createTerminalSessionInternal({
			terminalId,
			workspaceId,
			themeType,
			db,
			eventBus,
			restoredNotice: true,
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
/**
 * Session ids a live daemon currently owns, or null when no daemon answers
 * (still respawning, or gone for good). Read via the supervisor rather than
 * the client singleton so a rebuilt connection isn't required.
 */
async function listDaemonAliveSessionIds(): Promise<Set<string> | null> {
	const organizationId = process.env.ORGANIZATION_ID;
	if (!organizationId) return null;
	const list = await getSupervisor().listSessions(organizationId);
	if (list === null) return null;
	return new Set(list.filter((info) => info.alive).map((info) => info.id));
}

onDaemonDisconnect((err) => {
	const sessionCount = sessions.size;
	if (sessionCount === 0) return;
	console.warn(
		`[terminal] pty-daemon disconnected (${err?.message ?? "no message"}); closing ${sessionCount} terminal WS socket(s) to trigger renderer reconnect`,
	);
	// If the ptys died with the daemon, their agent bindings become resume
	// candidates — but a disconnect can also be an upgrade handoff or socket
	// blip with sessions surviving for adoption, so the sweep verifies
	// against a live daemon before marking anything.
	void sweepAgentBindingsAfterDaemonLoss({
		candidates: [...sessions.values()].map((session) => ({
			terminalId: session.terminalId,
			db: session.db,
		})),
		listAliveSessionIds: listDaemonAliveSessionIds,
	});
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

/**
 * Why this session operation failed, as a value rather than as prose.
 *
 * Every session producer in this module returns one of these, and each
 * consumer (tRPC, the HTTP attach route, the websocket) decides its own
 * mapping by switching on `kind`. `error` stays the human-readable string
 * those consumers already surface, so it can be reworded freely without
 * changing anyone's behaviour.
 */
export type TerminalSessionErrorKind =
	/** No session with this id, in memory or on the daemon. */
	| "SESSION_NOT_FOUND"
	/** The session exists but is owned by a different workspace. */
	| "SESSION_WRONG_WORKSPACE"
	/** The session existed and its process has already ended. */
	| "SESSION_EXITED"
	/** Adoption was requested but the daemon has no live session by that id. */
	| "SESSION_NOT_ACTIVE"
	/** No workspace row for the requested workspace id. */
	| "WORKSPACE_NOT_FOUND"
	/** The workspace row exists but its worktree is gone from disk. */
	| "WORKTREE_GONE"
	/**
	 * (WORKTREE-EXIT-CLEANUP) The user exited the workspace while this launch
	 * was starting, so the terminal was refused. Any PTY it had opened is
	 * closed and no session row was written.
	 */
	| "WORKSPACE_RETIRED"
	/**
	 * The daemon could not be reached (stalled, restarting, bootstrap
	 * pending). The supervisor heals these and the session may still come up
	 * under the same id, so callers should retry rather than go dead.
	 */
	| "DAEMON_UNAVAILABLE"
	/**
	 * Bootstrap failed permanently (missing daemon binary, no socket path,
	 * crash circuit open, handshake rejected) or the PTY would not open.
	 * Retrying will fail the same way; this is the only kind that means "we
	 * have a bug or a broken install".
	 */
	| "TERMINAL_START_FAILED";

export type TerminalSessionError = {
	kind: TerminalSessionErrorKind;
	error: string;
	/** Retained for the attach route and websocket, which branch on it. */
	transient?: boolean;
};

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
 * Live session list sourced from truth, not from this process's memory —
 * host-wide by default, narrowed to one workspace when `workspaceId` is set.
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
export async function listLiveTerminalSessions(
	db: HostDb,
	options: { workspaceId?: string } = {},
): Promise<TerminalSessionSummary[]> {
	const { workspaceId } = options;
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
			"[terminal] listLiveTerminalSessions: daemon unreachable, serving in-memory view",
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
		// Orphaned rows (workspace deleted → origin nulled) have no home in a
		// grouped listing and can't be attached through workspace-scoped IO.
		if (row.originWorkspaceId == null) continue;
		if (workspaceId !== undefined && row.originWorkspaceId !== workspaceId) {
			continue;
		}
		if (row.status !== "active") continue;
		if (row.disposeRequestedAt != null) continue;
		merged.push({
			terminalId: row.id,
			workspaceId: row.originWorkspaceId,
			createdAt: row.createdAt,
			exited: false,
			exitCode: 0,
			attached: false,
			title: null,
		});
	}
	return merged;
}

/**
 * The three checks every write path owes a caller before it touches a pty: the
 * session is process-local, it belongs to the workspace the caller named, and it
 * has not exited.
 *
 * `absentError` is the caller's, because the two paths mean different things by
 * a missing session: an ordinary write simply did not find one, while an
 * acknowledged write is reporting that `prepareAcknowledgedInputSession` did not
 * stick — and the companion answer path surfaces that text to a phone.
 */
function writableSession(
	terminalId: string,
	workspaceId: string,
	absentError = "Terminal session not found",
): TerminalSession | TerminalSessionError {
	const session = sessions.get(terminalId);
	if (!session) return { kind: "SESSION_NOT_FOUND", error: absentError };
	if (session.workspaceId !== workspaceId) {
		return {
			kind: "SESSION_WRONG_WORKSPACE",
			error: "Terminal session does not belong to this workspace",
		};
	}
	if (session.exited) {
		return { kind: "SESSION_EXITED", error: "Terminal session has exited" };
	}
	return session;
}

export function writeInputToSession({
	terminalId,
	workspaceId,
	data,
}: {
	terminalId: string;
	workspaceId: string;
	data: string;
}): { success: true } | TerminalSessionError {
	const session = writableSession(terminalId, workspaceId);
	if ("error" in session) return session;

	session.pty.write(data);
	return { success: true };
}

/**
 * Ensure a companion answer's target session is process-local before the answer
 * lease and terminal lock are acquired. Adoption can perform host.db, daemon-list
 * and replay I/O, so it must not sit between the final question check and input.
 * No input frame is sent here; every failure is definitively zero-write.
 */
export async function prepareAcknowledgedInputSession({
	terminalId,
	workspaceId,
	db,
}: {
	terminalId: string;
	workspaceId: string;
	db: HostDb;
}): Promise<
	{ success: true; acknowledgedInputSupported: boolean } | { error: string }
> {
	try {
		const session = await getOrAdoptSession({
			terminalId,
			workspaceId,
			db,
		});
		if ("error" in session) return session;
		if (session.exited) return { error: "Terminal session has exited" };
		return {
			success: true,
			acknowledgedInputSupported: session.pty.acknowledgedInputSupported,
		};
	} catch (error) {
		return {
			error:
				error instanceof Error
					? error.message
					: "Terminal session adoption failed",
		};
	}
}

/**
 * Companion-only raw write against a session prepared above. Resolves success
 * only after the daemon confirms that its `pty.write` returned; ordinary terminal
 * input keeps the lower-latency fire-and-forget function above.
 */
export async function writeAcknowledgedInputToSession({
	terminalId,
	workspaceId,
	data,
}: {
	terminalId: string;
	workspaceId: string;
	data: string;
}): Promise<
	| { success: true }
	| { error: string; writeOutcome: AcknowledgedInputFailureKind }
> {
	const session = writableSession(
		terminalId,
		workspaceId,
		"Terminal session not prepared",
	);
	if ("error" in session) {
		return { error: session.error, writeOutcome: "not_written" };
	}

	try {
		await session.pty.writeAcknowledged(data);
		return { success: true };
	} catch (error) {
		return {
			error:
				error instanceof Error
					? error.message
					: "Daemon acknowledged-input outcome is unknown",
			writeOutcome:
				error instanceof AcknowledgedInputError
					? error.writeOutcome
					: "unknown",
		};
	}
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
 * In-flight headless adoptions by terminal id. Concurrent callers racing an
 * adoption would each build their own TerminalSession (independent
 * followUpWriteChain, duplicate daemon subscriptions) — sharing the leader's
 * attempt keeps session identity unique per terminal.
 */
const adoptionsInFlight = new Map<string, Promise<unknown>>();

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
}): Promise<TerminalSession | TerminalSessionError> {
	for (;;) {
		const existing = sessions.get(terminalId);
		if (existing) {
			if (existing.workspaceId !== workspaceId) {
				return {
					kind: "SESSION_WRONG_WORKSPACE",
					error: "Terminal session does not belong to this workspace",
				};
			}
			return existing;
		}

		// Another caller is mid-adoption: wait it out, then re-resolve so
		// this caller runs its own workspace check (or leads a fresh attempt
		// if the leader failed).
		const pending = adoptionsInFlight.get(terminalId);
		if (pending) {
			await pending.catch(() => {});
			continue;
		}

		const attempt = (async () => {
			const adopted = await createTerminalSessionInternal({
				terminalId,
				workspaceId,
				db,
				eventBus,
				adoptOnly: true,
			});
			if ("error" in adopted) return adopted;

			await adopted.adoptionReplaySettled;
			return adopted;
		})();
		adoptionsInFlight.set(terminalId, attempt);
		try {
			return await attempt;
		} finally {
			adoptionsInFlight.delete(terminalId);
		}
	}
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
}): Promise<{ success: true } | TerminalSessionError> {
	const session = await getOrAdoptSession({
		terminalId,
		workspaceId,
		db,
		eventBus,
	});
	if ("error" in session) return session;
	if (session.exited) {
		return { kind: "SESSION_EXITED", error: "Terminal session has exited" };
	}

	// Serialize sends per session: the delayed Enter opens a window where a
	// concurrent send's text (even a submit: false draft) would land between
	// this text and its Enter and get submitted by it.
	const previous = session.followUpWriteChain ?? Promise.resolve();
	const task = previous.then(
		async (): Promise<{ success: true } | TerminalSessionError> => {
			if (session.exited) {
				return { kind: "SESSION_EXITED", error: "Terminal session has exited" };
			}
			const framed = session.modeTracker.isBracketedPasteActive()
				? `\x1b[200~${text}\x1b[201~`
				: text;
			if (!submit) {
				session.pty.write(framed);
				return { success: true };
			}
			if (text.length > 0) {
				session.pty.write(framed);
				await new Promise((r) => setTimeout(r, FOLLOW_UP_ENTER_DELAY_MS));
				if (session.exited) {
					return {
						kind: "SESSION_EXITED",
						error: "Terminal session has exited",
					};
				}
			}
			session.pty.write("\r");
			return { success: true };
		},
	);
	session.followUpWriteChain = task.then(
		() => undefined,
		() => undefined,
	);
	return task;
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
}): Promise<({ success: true } & TerminalSnapshot) | TerminalSessionError> {
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

function retainOutput(session: TerminalSession, data: Uint8Array) {
	session.retained.push(data);
	session.retainedBytes += data.byteLength;
	session.outputSeq += data.byteLength;
	while (
		session.retainedBytes > CATCHUP_RING_CAP_BYTES &&
		session.retained.length > 1
	) {
		const removed = session.retained.shift();
		if (removed) {
			session.retainedBytes -= removed.byteLength;
			session.retainedStartSeq += removed.byteLength;
		}
	}
}

/** Concatenate the retained stream from absolute seq `from` to the present. */
function readRetainedFrom(session: TerminalSession, from: number): Uint8Array {
	let skip = from - session.retainedStartSeq;
	const parts: Uint8Array[] = [];
	let total = 0;
	for (const chunk of session.retained) {
		if (skip >= chunk.byteLength) {
			skip -= chunk.byteLength;
			continue;
		}
		const part = skip > 0 ? chunk.subarray(skip) : chunk;
		skip = 0;
		parts.push(part);
		total += part.byteLength;
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.byteLength;
	}
	return out;
}

/**
 * Single choke point for PTY output: mode tracker, catch-up ring, then
 * broadcast (falling back to the legacy zero-socket FIFO). Every byte that
 * counts toward `outputSeq` MUST flow through here and nowhere else, or
 * seq-aware clients drift out of sync.
 */
/** ESC [ 6 n — DSR cursor position report request. */
const DSR_CURSOR_QUERY = new Uint8Array([0x1b, 0x5b, 0x36, 0x6e]);

/**
 * Count DSR cursor queries in this chunk (joined with the previous chunk's
 * tail so boundary-straddling sequences still match) and update the carry.
 */
function scanForDsrCursorQueries(
	session: TerminalSession,
	chunk: Uint8Array,
): number {
	const joined = new Uint8Array(session.dsrCarry.length + chunk.length);
	joined.set(session.dsrCarry, 0);
	joined.set(chunk, session.dsrCarry.length);
	let count = 0;
	// Start where a match could involve carried bytes; matches wholly inside
	// the carry were already counted last chunk.
	for (
		let i = Math.max(
			0,
			session.dsrCarry.length - (DSR_CURSOR_QUERY.length - 1),
		);
		i + DSR_CURSOR_QUERY.length <= joined.length;
		i++
	) {
		let matched = true;
		for (let j = 0; j < DSR_CURSOR_QUERY.length; j++) {
			if (joined[i + j] !== DSR_CURSOR_QUERY[j]) {
				matched = false;
				break;
			}
		}
		if (matched) count++;
	}
	session.dsrCarry = joined.slice(
		Math.max(0, joined.length - (DSR_CURSOR_QUERY.length - 1)),
	);
	return count;
}

/**
 * Answer a program's DSR cursor query when no renderer is attached to do it.
 * reedline (nushell) asks `ESC[6n` after init and will not paint its prompt —
 * or accept input — until the terminal answers; a preset launch into an
 * unattached session therefore wedged forever (#6024). An attached renderer's
 * xterm answers by itself (so we stay silent then, like tmux does for
 * attached clients); for unattached sessions the mirrored headless screen is
 * the truth and answers with the real cursor position.
 */
function answerDsrCursorQueries(session: TerminalSession, count: number) {
	if (count === 0 || session.exited) return;
	if (pruneAndCountOpenSockets(session) > 0) return;
	const { x, y } = session.modeTracker.cursorPosition();
	for (let i = 0; i < count; i++) {
		session.pty.write(`\x1b[${y + 1};${x + 1}R`);
	}
}

function deliverOutput(session: TerminalSession, bytes: Uint8Array) {
	session.modeTracker.feed(bytes);
	retainOutput(session, bytes);
	if (broadcastBytes(session, bytes) === 0) {
		bufferOutput(session, bytes);
	}
}

/**
 * Force the running program to repaint by toggling the PTY one row smaller
 * and back — two real SIGWINCHes (a same-dims resize emits none). Used after
 * a reanchor attach, where the renderer may hold a stale frame that only the
 * program itself can faithfully redraw (the v1 terminal-host's proven
 * recipe; never synthesize screen content the tracker may not have — #6290).
 */
function nudgeRepaint(
	session: TerminalSession,
): { success: true } | { error: string } {
	if (!isCurrentLiveSession(session)) {
		return { error: "Terminal session is not live" };
	}
	const { cols, rows } = session;
	// Shrink by a row, growing instead when already at the minimum.
	const toggledRows = rows > MIN_TERMINAL_ROWS ? rows - 1 : rows + 1;
	const generation = session.resizeGeneration;
	try {
		session.pty.resize(cols, toggledRows);
	} catch (error) {
		return {
			error:
				error instanceof Error
					? error.message
					: "Terminal repaint nudge failed",
		};
	}
	setTimeout(() => {
		// A real client resize landed mid-nudge; it owns the dims now.
		if (!isCurrentLiveSession(session)) return;
		if (session.resizeGeneration !== generation) return;
		try {
			session.pty.resize(cols, rows);
		} catch (error) {
			console.warn(
				"[terminal] failed to restore PTY dimensions after repaint nudge",
				{
					terminalId: session.terminalId,
					error,
				},
			);
		}
	}, REPAINT_NUDGE_RESTORE_MS);
	return { success: true };
}

/**
 * Best-effort repaint for a live companion answer target.
 *
 * A daemon-side input acknowledgement proves that the bytes reached the PTY,
 * but a renderer can still hold the frame from before Claude consumed them.
 * Toggling the PTY dimensions asks the running program to redraw from its own
 * state. Failure is diagnostic only: input has already landed and callers must
 * never turn a repaint problem into an answer refusal or downgrade.
 */
export function nudgeTerminalSessionRepaint({
	terminalId,
	workspaceId,
}: {
	terminalId: string;
	workspaceId: string;
}): { success: true } | { error: string } {
	const session = writableSession(terminalId, workspaceId);
	if ("error" in session) return session;
	return nudgeRepaint(session);
}

/** False once the session exited or was disposed/replaced in the map —
 * lets delayed nudge timers no-op instead of poking a dead PTY. */
function isCurrentLiveSession(session: TerminalSession): boolean {
	return !session.exited && sessions.get(session.terminalId) === session;
}

/**
 * Write the aggregate client focus state to the PTY when the program asked
 * for focus reports (mode 1004). Written unconditionally rather than
 * edge-triggered: the program's belief can drift via in-band reports from
 * individual xterms, so every focus event re-asserts the aggregate truth —
 * a redundant \x1b[I is idempotent to the program.
 */
function syncPtyFocus(session: TerminalSession) {
	if (session.exited) return;
	if (!session.modeTracker.isFocusReportingActive()) return;
	const aggregate = session.focusedSockets.size > 0;
	session.pty.write(aggregate ? "\x1b[I" : "\x1b[O");
}

/**
 * Smallest box across the clients currently showing this terminal. Null when
 * no visible client has reported dims — nothing attached, or everything
 * attached is off screen — in which case the PTY keeps the size it has rather
 * than being reshaped for an audience of nobody.
 */
function effectiveDims(
	session: TerminalSession,
): { cols: number; rows: number } | null {
	let cols = Number.POSITIVE_INFINITY;
	let rows = Number.POSITIVE_INFINITY;
	for (const [socket, dims] of session.clientDims) {
		if (session.hiddenSockets.has(socket)) continue;
		if (dims.cols < cols) cols = dims.cols;
		if (dims.rows < rows) rows = dims.rows;
	}
	if (!Number.isFinite(cols) || !Number.isFinite(rows)) return null;
	return { cols, rows };
}

/**
 * Push the visible clients' smallest box to the PTY. `force` re-sends dims the
 * session already holds, which the resize path wants so a same-dims client
 * resize still reaches the kernel; the visibility and detach paths resize only
 * when the minimum actually moved.
 */
function applyEffectiveDims(
	session: TerminalSession,
	options: { force?: boolean } = {},
) {
	if (session.exited) return;
	const next = effectiveDims(session);
	if (!next) return;
	const changed = next.cols !== session.cols || next.rows !== session.rows;
	if (!changed && !options.force) return;
	session.resizeGeneration += 1;
	session.pty.resize(next.cols, next.rows);
	session.modeTracker.resize(next.cols, next.rows);
	session.cols = next.cols;
	session.rows = next.rows;
}

/**
 * Drop a departing client's size constraint. The PTY grows back to whatever
 * the remaining viewers can show — closing the phone hands the desktop its
 * full width back without anyone touching a pane.
 */
function releaseSocketDims(session: TerminalSession, ws: TerminalSocket) {
	const hadDims = session.clientDims.delete(ws);
	const wasHidden = session.hiddenSockets.delete(ws);
	// A hidden client was already outside the minimum, so nothing moved.
	if (hadDims && !wasHidden) applyEffectiveDims(session);
}

/**
 * Arm the nudge after a reanchor attach. Wait for the client's own resize
 * first: if its dims differ from the PTY's, that resize already delivers a
 * natural SIGWINCH and the nudge is unnecessary; if they match, nudge. The
 * fallback timer covers clients that never send a resize.
 */
function schedulePendingRepaintNudge(session: TerminalSession) {
	if (session.pendingRepaintNudge !== null) return;
	session.pendingRepaintNudge = setTimeout(() => {
		session.pendingRepaintNudge = null;
		nudgeRepaint(session);
	}, REPAINT_NUDGE_FALLBACK_MS);
}

function clearPendingRepaintNudge(session: TerminalSession) {
	if (session.pendingRepaintNudge === null) return;
	clearTimeout(session.pendingRepaintNudge);
	session.pendingRepaintNudge = null;
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

/**
 * Host-synthesized attach bytes: the mode preamble plus (at most once) the
 * restored notice. Mode-setting escapes (kitty keyboard, bracketed paste,
 * focus, …) are typically emitted once at program startup and broadcast away
 * rather than buffered, so a fresh xterm needs them re-asserted on every
 * attach. Consumes the pending notice — only call when actually delivering
 * to an open socket. Returns null when there is nothing to synthesize.
 */
function takeSynthesizedAttachBytes(
	session: TerminalSession,
): Uint8Array | null {
	const preamble = session.modeTracker.buildPreamble();
	const notice = session.restoredNoticePending ? SESSION_RESTORED_NOTICE : null;
	session.restoredNoticePending = false;
	if (!preamble && !notice) return null;
	const combined = new Uint8Array(
		(preamble?.byteLength ?? 0) + (notice?.byteLength ?? 0),
	);
	if (preamble) combined.set(preamble, 0);
	if (notice) combined.set(notice, preamble?.byteLength ?? 0);
	return combined;
}

export function replayBuffer(session: TerminalSession, socket: TerminalSocket) {
	// Bail before consuming the notice/FIFO on a non-open socket so the next
	// attach can still replay them.
	if (socket.readyState !== SOCKET_OPEN) return;
	const synthesized = takeSynthesizedAttachBytes(session);
	if (synthesized) sendBytes(socket, synthesized);
	if (session.bufferBytes > 0) {
		const fifo = new Uint8Array(session.bufferBytes);
		let offset = 0;
		for (const b of session.buffer) {
			fifo.set(b, offset);
			offset += b.byteLength;
		}
		sendBytes(socket, fifo);
	}
	session.buffer.length = 0;
	session.bufferBytes = 0;
}

/**
 * Attach delivery for seq-aware clients. Wire order matters:
 *   1. binary: host-synthesized bytes (mode preamble, restored notice) —
 *      NOT part of the PTY stream, so they go out before the anchor and the
 *      client does not count them;
 *   2. json `synced`: sets the client's counter and arms counting;
 *   3. binary: catch-up bytes — pure PTY-stream bytes the client counts.
 * After this returns, live output broadcast keeps both counters in step.
 */
function sendSeqAttach(
	session: TerminalSession,
	socket: TerminalSocket,
	request: Exclude<SeqAttachRequest, { kind: "legacy" }>,
) {
	if (socket.readyState !== SOCKET_OPEN) return;

	const synthesized = takeSynthesizedAttachBytes(session);
	if (synthesized) sendBytes(socket, synthesized);

	const exact =
		request.kind === "anchor" &&
		request.epoch === session.epoch &&
		request.seq >= session.retainedStartSeq &&
		request.seq <= session.outputSeq;

	if (exact) {
		sendMessage(socket, {
			type: "synced",
			epoch: session.epoch,
			seq: request.seq,
			mode: "exact",
		});
		if (request.seq < session.outputSeq) {
			sendBytes(socket, readRetainedFrom(session, request.seq));
		}
		return;
	}

	if (request.kind === "new") {
		// Virgin client: best-effort scrollback restore from the ring tail.
		sendMessage(socket, {
			type: "synced",
			epoch: session.epoch,
			seq: session.retainedStartSeq,
			mode: "tail",
		});
		if (session.retainedBytes > 0) {
			sendBytes(socket, readRetainedFrom(session, session.retainedStartSeq));
		}
		return;
	}

	// Unknown/unrecoverable position ("none", epoch mismatch, gap beyond the
	// ring). The client's existing screen beats anything we could synthesize —
	// never overwrite it (#6290). Re-anchor at the live head and ask the
	// program to repaint itself.
	sendMessage(socket, {
		type: "synced",
		epoch: session.epoch,
		seq: session.outputSeq,
		mode: "reanchor",
	});
	if (!session.exited) {
		schedulePendingRepaintNudge(session);
	}
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
		deliverOutput(session, heldBytes);
	}
	if (state === "ready") {
		recordShellReadyMarkerEvidence(session.launchShellName, "delivered");
	} else if (session.outputSeq > 0) {
		// The shell painted output but the marker never came — this machine's
		// profile diverts it (exec tmux/another shell, cleared precmd hooks).
		// Zero output means the shell may not have started at all (wedged
		// daemon); that says nothing about the profile, so record nothing.
		recordShellReadyMarkerEvidence(session.launchShellName, "missing");
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

/**
 * A staged launch script normally lives well under a second (self-deletes on
 * execution; unlinked on pre-Enter teardown), but a host-service crash inside
 * that window skips both paths and leaves the prompt-bearing file behind.
 * Sweep stale ones at boot — age-gated so a concurrently-running instance's
 * just-staged script is never touched.
 */
const LAUNCH_SCRIPT_STALE_MS = 60 * 60 * 1000;
void (async () => {
	try {
		const dir = tmpdir();
		for (const name of await readdir(dir)) {
			if (!name.startsWith("superset-launch-")) continue;
			const scriptPath = join(dir, name);
			try {
				const { mtimeMs } = await stat(scriptPath);
				if (Date.now() - mtimeMs > LAUNCH_SCRIPT_STALE_MS) {
					await rm(scriptPath, { force: true });
				}
			} catch {
				// raced another instance's sweep — skip
			}
		}
	} catch (error) {
		// Non-fatal, but this sweep is the only cleanup for crash-stranded
		// prompt-bearing scripts — surface the miss instead of hiding it.
		console.warn("[terminal] stale launch-script sweep failed", { error });
	}
})();

/**
 * Stage an oversized initialCommand as a temp script and return the short
 * source line to type instead, keeping the typed input under MAX_CANON.
 * Sourcing (not `sh <path>`) preserves the interactive shell context, so the
 * command behaves exactly as if typed. The script deletes itself on its first
 * line — the shell keeps reading from the already-open fd — so cleanup never
 * waits on a long-running agent process. Returns null when the write fails;
 * the caller falls back to typing the full text.
 */
function stageInitialCommandScript(
	session: TerminalSession,
	commandText: string,
): { typedLine: string; scriptPath: string } | null {
	const safeId = session.terminalId.replace(/[^\w-]/g, "_").slice(0, 60);
	const scriptPath = join(
		tmpdir(),
		`superset-launch-${safeId}-${randomBytes(4).toString("hex")}.sh`,
	);
	// tmpdir paths never contain quotes, so this quoting is identical in
	// POSIX shells and fish.
	const quotedPath = `'${scriptPath.replaceAll("'", "'\\''")}'`;
	const sourceKeyword = session.launchShellName === "fish" ? "source" : ".";
	try {
		writeFileSync(
			scriptPath,
			`command rm -f -- ${quotedPath}\n${commandText}\n`,
			{ mode: 0o600, flag: "wx" },
		);
	} catch (error) {
		console.warn("[terminal] failed to stage long initial command; typing it", {
			terminalId: session.terminalId,
			error,
		});
		return null;
	}
	return { typedLine: `${sourceKeyword} ${quotedPath}`, scriptPath };
}

/**
 * Longest leading run of printable ASCII from the typed line, capped so the
 * probe fits on one terminal row even after a prompt. The prefix is what a
 * stdin eater mangles (it consumes from the front), so it's both the match
 * target and the mangle detector (see judgeCommandEcho). Returns null when
 * the command starts with bytes a terminal won't echo verbatim — those
 * launches type blind, exactly as before.
 */
function commandEchoProbe(typedText: string): string | null {
	let end = 0;
	while (end < typedText.length && end < 32) {
		const code = typedText.charCodeAt(end);
		if (code < 0x20 || code > 0x7e) break;
		end++;
	}
	const probe = typedText.slice(0, end);
	return probe.length >= 6 ? probe : null;
}

/**
 * Strip escape sequences and control bytes so echoed text can be matched
 * regardless of prompt colors, syntax-highlight repaints, or line wraps
 * (which only insert controls/CSI between the printable characters).
 */
function stripEchoDecorations(raw: string): string {
	return (
		raw
			// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping OSC sequences intentionally
			.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, "")
			// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping DCS/SOS/PM/APC sequences intentionally
			.replace(/\x1b[PX^_][\s\S]*?(?:\x1b\\|\x07|$)/g, "")
			// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping CSI sequences intentionally
			.replace(/\x1b\[[0-9;:?<=>]*[ -/]*[@-~]/g, "")
			// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping two-byte escapes intentionally
			.replace(/\x1b./g, "")
			// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars intentionally
			.replace(/[\x00-\x1f\x7f]/g, "")
	);
}

/**
 * Judge the echoed stream against the typed probe. `intact` needs the full
 * probe present with no orphan suffix after its last occurrence: a startup
 * reader that stole leading byte(s) leaves the intact kernel echo in place
 * and then re-echoes the surviving tail when the line editor drains the
 * queue (`date +%s …` followed by `ate +%s …`), so a reappearing proper
 * suffix means the editor holds a mangled copy. `mangled` is definitive —
 * the caller retypes immediately instead of waiting out the window.
 */
function judgeCommandEcho(
	cleaned: string,
	probe: string,
): "absent" | "intact" | "mangled" {
	const lastFull = cleaned.lastIndexOf(probe);
	if (lastFull === -1) return "absent";
	const tail = cleaned.slice(lastFull + probe.length);
	// Suffixes shorter than 3 chars collide with prompts/status text too easily.
	for (let cut = 1; cut <= probe.length - 3; cut++) {
		if (tail.includes(probe.slice(cut))) return "mangled";
	}
	return "intact";
}

/**
 * The part of the echoed stream after the last full probe occurrence that the
 * typed command itself cannot explain. The echo of a command longer than its
 * probe legitimately continues past it, so the tail is only unexpected once
 * it diverges from (or extends beyond) that remainder. Whitespace is ignored
 * on both sides — editor repaints and line wraps shuffle it freely. A
 * non-empty result after an intact echo is the reedline-flush signature: the
 * kernel echoed the bytes at input time, the editor then finished starting
 * up (painting a banner or prompt AFTER the echo) and flushed the typeahead,
 * so the intact-looking command was never held by the line editor.
 */
function unexpectedEchoTail(tail: string, expectedRemainder: string): string {
	const seen = tail.replace(/\s+/g, "");
	const expected = expectedRemainder.replace(/\s+/g, "");
	if (expected.startsWith(seen)) return "";
	if (seen.startsWith(expected)) return seen.slice(expected.length);
	return seen;
}

/**
 * Resolve true once `probe` echoes back intact and the stream then stays
 * quiet long enough for a mangle signature to have shown up; false on a
 * detected mangle or when the window closes without an intact echo.
 * `expectedRemainder` (ungated launches) additionally fails the wait when
 * output after an intact echo isn't the typed command's own continuation —
 * the flush signature described at unexpectedEchoTail.
 */
function waitForCommandEcho(
	session: TerminalSession,
	probe: string,
	windowMs: number,
	opts?: { quietMs?: number; expectedRemainder?: string },
): Promise<boolean> {
	const quietMs = opts?.quietMs ?? GRACE_ECHO_QUIET_MS;
	return new Promise((resolve) => {
		let raw = "";
		let quietTimer: ReturnType<typeof setTimeout> | null = null;
		const finish = (ok: boolean) => {
			session.echoProbe = null;
			clearTimeout(windowTimer);
			if (quietTimer) clearTimeout(quietTimer);
			resolve(ok);
		};
		const windowTimer = setTimeout(() => finish(false), windowMs);
		session.echoProbe = (bytes) => {
			raw += Buffer.from(
				bytes.buffer,
				bytes.byteOffset,
				bytes.byteLength,
			).toString("latin1");
			// Keep the tail bounded; far more than enough overlap for the probe.
			if (raw.length > 65_536) raw = raw.slice(-32_768);
			// Every chunk re-opens the quiet window — whatever painted may have
			// been the start of a mangle signature.
			if (quietTimer) {
				clearTimeout(quietTimer);
				quietTimer = null;
			}
			const cleaned = stripEchoDecorations(raw);
			const verdict = judgeCommandEcho(cleaned, probe);
			if (verdict === "mangled") {
				finish(false);
			} else if (verdict === "intact") {
				if (opts?.expectedRemainder !== undefined) {
					const tail = cleaned.slice(cleaned.lastIndexOf(probe) + probe.length);
					if (unexpectedEchoTail(tail, opts.expectedRemainder) !== "") {
						finish(false);
						return;
					}
				}
				quietTimer = setTimeout(() => finish(true), quietMs);
			}
		};
	});
}

/**
 * Resolve once the PTY stream has been silent for `quietMs` (capped at
 * `capMs` so streaming startups can't park the launch). Uses the same
 * single-slot echoProbe channel as waitForCommandEcho — the two never run
 * concurrently for a session.
 */
function waitForOutputQuiescence(
	session: TerminalSession,
	quietMs: number,
	capMs: number,
): Promise<void> {
	return new Promise((resolve) => {
		const finish = () => {
			session.echoProbe = null;
			clearTimeout(quietTimer);
			clearTimeout(capTimer);
			resolve();
		};
		let quietTimer = setTimeout(finish, quietMs);
		const capTimer = setTimeout(finish, capMs);
		session.echoProbe = () => {
			clearTimeout(quietTimer);
			quietTimer = setTimeout(finish, quietMs);
		};
	});
}

/**
 * Deferred launch typing races session teardown: the daemon socket can drop
 * before `isDefunct()` (registry/exited checks) observes the disposal, so a
 * write can throw "socket not connected" from inside a floating promise or
 * timer. A failed write means the session is gone — treat it as defunct and
 * abort the launch quietly.
 */
function tryTypeToPty(session: TerminalSession, data: string): boolean {
	try {
		session.pty.write(data);
		return true;
	} catch {
		return false;
	}
}

/**
 * Grace-window typing (learned `missing` evidence, no observed prompt): a
 * startup stdin reader can still be consuming the TTY when the grace fires —
 * the oh-my-zsh-updater `read` of #3941 on a profile that also never delivers
 * the marker — and a blindly typed command loses its leading byte(s) to it
 * (`claude` runs as `laude`). So watch the stream for the command echoing
 * back intact; when the echo doesn't appear, clear the line and retype.
 * Ctrl-U is safe in every mode the TTY can be in here — kill-line for a live
 * line editor, the canonical kill character for kernel-queued input, and a
 * literal 0x15 the editor will treat as kill when it drains a raw queue — so
 * a false-negative echo costs a retype, never a corrupted command. After the
 * retry budget the command is typed blind, matching the old fallback path:
 * it must eventually run.
 */
async function typeInitialCommandVerifyingEcho(
	session: TerminalSession,
	typedText: string,
	probe: string,
	dropStagedFiles: () => void,
	isDefunct: () => boolean,
): Promise<void> {
	for (let attempt = 0; attempt <= GRACE_ECHO_MAX_RETYPES; attempt++) {
		if (isDefunct()) return dropStagedFiles();
		if (attempt > 0 && !tryTypeToPty(session, "\x15")) {
			return dropStagedFiles();
		}
		if (!tryTypeToPty(session, typedText)) return dropStagedFiles();
		if (await waitForCommandEcho(session, probe, GRACE_ECHO_WINDOW_MS)) break;
	}
	await new Promise((r) => setTimeout(r, INITIAL_COMMAND_ENTER_DELAY_MS));
	if (isDefunct()) return dropStagedFiles();
	if (!tryTypeToPty(session, "\r")) dropStagedFiles();
}

/**
 * Ungated typing (shellLaunchExpectsReadyMarker() false — unwrapped bash,
 * sh/ksh, nushell): there is no marker and never will be, so before this the
 * command was typed the instant the PTY opened. Two startup classes ate it:
 * a profile `read` steals the leading byte(s) (#3941/#5712), and reedline
 * (nushell) flushes ALL pending typeahead when it enables raw mode after
 * init — the command vanishes with an intact-looking kernel echo (#6024).
 *
 * So: wait for the startup output to go quiet (a shell at prompt is quiet; a
 * banner-printing one isn't), type, then verify the echo. Quiescence can't
 * see a silent `read -t` window — the echo mangle signature catches that —
 * and the echo can't distinguish kernel echo from editor echo — the
 * unexpected-tail rule (output after the echo that isn't the command's own
 * continuation) catches the flush class. Failures re-quiesce before the
 * Ctrl-U retype so the retry lands on the now-live editor instead of inside
 * the same init storm. The accept path requires a full Enter-delay of
 * post-echo quiet, which already provides the text→Enter separation, so
 * Enter goes out immediately on acceptance. After the retry budget the
 * command falls back to a blind Enter, exactly like the gated paths.
 *
 * A null `probe` (command too short or non-ASCII start — commandEchoProbe)
 * only disables the echo verification: the quiescence wait still applies, so
 * short commands like `ls` don't regress into the blind-write reedline-flush
 * loss (#6024). Those launches type once and send the delayed Enter.
 */
async function typeInitialCommandUngated(
	session: TerminalSession,
	typedText: string,
	probe: string | null,
	dropStagedFiles: () => void,
	isDefunct: () => boolean,
): Promise<void> {
	const expectedRemainder = probe
		? Buffer.from(typedText, "utf8").toString("latin1").slice(probe.length)
		: "";
	const maxRetypes = probe ? GRACE_ECHO_MAX_RETYPES : 0;
	for (let attempt = 0; attempt <= maxRetypes; attempt++) {
		await waitForOutputQuiescence(
			session,
			UNGATED_QUIESCENT_MS,
			UNGATED_QUIESCENCE_CAP_MS,
		);
		if (isDefunct()) return dropStagedFiles();
		// Ctrl-U after the re-quiesce, not before it — sent earlier, the same
		// startup reader that ate the command swallows the kill char too and
		// the retype appends to the leftover line.
		if (attempt > 0 && !tryTypeToPty(session, "\x15")) {
			return dropStagedFiles();
		}
		if (!tryTypeToPty(session, typedText)) return dropStagedFiles();
		if (!probe) break;
		const verified = await waitForCommandEcho(
			session,
			probe,
			UNGATED_ECHO_WINDOW_MS,
			{
				quietMs: INITIAL_COMMAND_ENTER_DELAY_MS,
				expectedRemainder,
			},
		);
		if (verified) {
			if (isDefunct()) return dropStagedFiles();
			if (!tryTypeToPty(session, "\r")) dropStagedFiles();
			return;
		}
	}
	await new Promise((r) => setTimeout(r, INITIAL_COMMAND_ENTER_DELAY_MS));
	if (isDefunct()) return dropStagedFiles();
	if (!tryTypeToPty(session, "\r")) dropStagedFiles();
}

/**
 * Rewrite a bash-only heredoc prompt transport for a fish launch shell. fish
 * has no heredocs, so the shared "$(cat <<'SUPERSET_PROMPT_…')" transport
 * dies at parse and the agent never starts (#4705). The prompt bytes go to a
 * staged temp file (the `superset-launch-` prefix keeps it under the boot
 * sweep's crash cleanup) and the typed command becomes the fish equivalent,
 * which deletes the file as soon as it's consumed. POSIX shells keep today's
 * heredoc byte-for-byte — this runs only when the launch shell is fish.
 * Returns null when staging fails; the caller must NOT fall back to typing
 * the heredoc (fish dies parsing it — the very failure this rewrite exists
 * to prevent) and surfaces a launch error instead.
 */
function stageFishPromptTransport(
	session: TerminalSession,
	parsed: ParsedPromptHeredocCommand,
): { commandText: string; promptPath: string } | null {
	const safeId = session.terminalId.replace(/[^\w-]/g, "_").slice(0, 60);
	const promptPath = join(
		tmpdir(),
		`superset-launch-prompt-${safeId}-${randomBytes(4).toString("hex")}.txt`,
	);
	try {
		// Trailing newline matches the heredoc body (`…\n` before the tag);
		// both bash "$()" and fish `string collect` trim it back off.
		writeFileSync(promptPath, `${parsed.prompt}\n`, {
			mode: 0o600,
			flag: "wx",
		});
	} catch (error) {
		console.error(
			"[terminal] failed to stage fish prompt file; aborting agent launch",
			{ terminalId: session.terminalId, error },
		);
		return null;
	}
	return {
		commandText: buildFishPromptCommandString({
			command: parsed.command,
			suffix: parsed.suffix,
			transport: parsed.transport,
			promptFilePath: promptPath,
		}),
		promptPath,
	};
}

// Shown in the terminal when a fish prompt launch can't be staged — the
// alternative (typing the bash heredoc into fish) is guaranteed garbage.
const FISH_PROMPT_STAGE_FAILED_NOTICE = new TextEncoder().encode(
	"\r\n\x1b[31m[superset] Failed to stage the agent prompt for fish — the agent was not started. Retry the launch; see host-service logs for the cause.\x1b[0m\r\n",
);

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
	// Dispose paths that never see onExit (daemon callbacks are unsubscribed
	// first) leave `exited` false and a non-pending readyState untouched —
	// only the registry reliably says the session is gone.
	const isDefunct = () =>
		session.exited ||
		session.shellReadyState === "cancelled" ||
		sessions.get(session.terminalId) !== session;
	void session.shellReadyPromise.then(() => {
		if (isDefunct()) return;
		const stagedPaths: string[] = [];
		// Enter never sent — a staged script/prompt file won't run or be
		// consumed, so it can't self-delete.
		const dropStagedFiles = () => {
			for (const staged of stagedPaths) {
				void rm(staged, { force: true }).catch(() => {});
			}
		};
		// fish can't parse the heredoc prompt transport — swap it for the
		// staged-file equivalent before any typing decisions are made. When
		// staging fails there is no fish-parseable fallback; typing the bash
		// heredoc guarantees a parse error, so surface the failure and stop.
		let effectiveCommand = commandText;
		if (session.launchShellName === "fish") {
			const parsedTransport = parsePromptHeredocCommand(commandText);
			if (parsedTransport) {
				const fishStaged = stageFishPromptTransport(session, parsedTransport);
				if (!fishStaged) {
					deliverOutput(session, FISH_PROMPT_STAGE_FAILED_NOTICE);
					return;
				}
				effectiveCommand = fishStaged.commandText;
				stagedPaths.push(fishStaged.promptPath);
			}
		}
		// Even after the marker, the TTY is still in canonical mode (the marker
		// fires from precmd, before the line editor takes over), so whatever we
		// type here rides the kernel's MAX_CANON line limit. Long commands go
		// to disk; only a short source line is typed.
		let typedText = effectiveCommand;
		if (
			Buffer.byteLength(effectiveCommand, "utf8") >
			MAX_TYPED_INITIAL_COMMAND_BYTES
		) {
			const staged = stageInitialCommandScript(session, effectiveCommand);
			if (staged) {
				typedText = staged.typedLine;
				stagedPaths.push(staged.scriptPath);
			}
		}
		// A grace-window timeout typed on learned evidence alone — no marker, no
		// observed prompt — so startup may still be reading stdin. That path
		// must verify its own echo instead of trusting the write.
		if (
			session.shellReadyState === "timed_out" &&
			session.usedMissingMarkerGrace
		) {
			const probe = commandEchoProbe(typedText);
			if (probe) {
				void typeInitialCommandVerifyingEcho(
					session,
					typedText,
					probe,
					dropStagedFiles,
					isDefunct,
				);
				return;
			}
		}
		// No marker was ever expected for this launch (unwrapped bash, sh/ksh,
		// nushell): quiesce, type, and echo-verify instead of typing blind into
		// whatever the startup is doing to stdin. A null probe only skips the
		// echo verification — the quiescence wait still applies.
		if (session.shellReadyState === "unsupported") {
			void typeInitialCommandUngated(
				session,
				typedText,
				commandEchoProbe(typedText),
				dropStagedFiles,
				isDefunct,
			);
			return;
		}
		// The OSC 133;A marker fires from precmd, which runs BEFORE the line
		// editor starts reading input. Plugin init in that gap (vi-mode,
		// syntax-highlighting) can flush the PTY input queue mid-read, eating a
		// trailing newline sent in the same write: the command text survives in
		// the editor's buffer but never executes. Send Enter as its own delayed
		// write — and as `\r`, what a real Enter key sends, bound to accept-line
		// in every keymap — so it lands after the init storm. One Enter total,
		// so a double-run is impossible.
		if (!tryTypeToPty(session, typedText)) {
			dropStagedFiles();
			return;
		}
		setTimeout(() => {
			if (isDefunct() || !tryTypeToPty(session, "\r")) {
				dropStagedFiles();
			}
		}, INITIAL_COMMAND_ENTER_DELAY_MS);
	});
}

interface DaemonCloseResult {
	attempted: boolean;
	succeeded: boolean;
	error?: unknown;
}

/**
 * (DISPOSE-LIMBO) What the fenced DB write actually did — the half of the
 * outcome `daemonCloseSucceeded` cannot express.
 *
 * A close that resolves proves a PTY died; it does NOT prove that THIS
 * terminal's generation is the one now recorded dead. A create or adopt landing
 * mid-kill clears the stamp and re-upserts the row `active` for a brand new
 * live PTY, and the fence then (correctly) refuses to write — leaving the
 * caller holding a successful close for an id that names somebody else's live
 * terminal. Callers that take durable action on a dispose (deleting the agent
 * binding, telling a user or an agent the terminal is gone) must branch on
 * THIS, not on the close alone.
 *
 * - `disposed`   — the fenced update flipped this generation's row to
 *                  `disposed`. The only value that licenses durable teardown.
 * - `superseded` — the stamp is gone or no longer matches: the id now names a
 *                  replacement terminal. Nothing was written and nothing may be
 *                  torn down; the binding belongs to the replacement.
 * - `no-row`     — there is no `terminal_sessions` row for this id at all. The
 *                  expected shape of the reaper's rowless-orphan pass: a live
 *                  daemon PTY nothing durable references.
 * - `pending`    — the close never confirmed, so nothing was written. The row
 *                  keeps its stamp and the reaper retries.
 */
export type DisposeDbDisposition =
	| "disposed"
	| "superseded"
	| "no-row"
	| "pending";

export interface DisposeSessionResult {
	terminalId: string;
	daemonCloseAttempted: boolean;
	daemonCloseSucceeded: boolean;
	/** (DISPOSE-LIMBO) See {@link DisposeDbDisposition}. */
	dbDisposition: DisposeDbDisposition;
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
export function disposeSession(
	terminalId: string,
	db: HostDb,
	eventBus?: EventBus,
) {
	void disposeSessionAndWait(terminalId, db, eventBus)
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

/**
 * (DISPOSE-LIMBO) One owner per terminal id, for as long as a dispose is in
 * flight.
 *
 * Two concurrent disposes used to BOTH proceed: the second one's conditional
 * stamp write was a no-op (first request wins) but it then read the first's
 * stamp back and issued its OWN daemon close. Those two closes are not
 * interchangeable — the second can be delayed past the point where the first
 * completed and a same-id REPLACEMENT terminal was created, at which point it
 * kills the replacement's PTY, its fence correctly refuses to write, and the
 * suppressed exit leaves an `active` row in front of a dead process: a pane
 * that looks alive and answers nothing.
 *
 * So the caller that creates the entry owns the whole sequence — stamp, close,
 * fenced write, broadcast — and everybody else awaits its result rather than
 * running a second one. The entry is removed when it settles, which is what
 * keeps the reaper's RETRY possible: retrying a finished dispose is the point,
 * running a second one alongside it is the bug.
 */
const disposeResolutions = new Map<string, Promise<DisposeSessionResult>>();

/**
 * Coalescing front door for {@link runDisposeSession}. Deliberately NOT async:
 * the map lookup and insert must both happen in the caller's synchronous turn,
 * or two callers can each miss the entry before either writes it.
 */
export function disposeSessionAndWait(
	terminalId: string,
	db: HostDb,
	eventBus?: EventBus,
): Promise<DisposeSessionResult> {
	const inFlight = disposeResolutions.get(terminalId);
	if (inFlight) return inFlight;

	// The owner's `eventBus` is the one the whole sequence uses; a later caller
	// joining with a different one gets the owner's broadcasts. Every caller
	// that matters here shares one bus per host process, and the in-memory
	// session carries its own regardless.
	const resolution = runDisposeSession(terminalId, db, eventBus).finally(() => {
		if (disposeResolutions.get(terminalId) === resolution) {
			disposeResolutions.delete(terminalId);
		}
	});
	disposeResolutions.set(terminalId, resolution);
	return resolution;
}

export function isDisposalComplete(result: DisposeSessionResult): boolean {
	return (
		result.daemonCloseSucceeded &&
		(result.dbDisposition === "disposed" || result.dbDisposition === "no-row")
	);
}

async function runDisposeSession(
	terminalId: string,
	db: HostDb,
	eventBus?: EventBus,
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
	// (DISPOSE-LIMBO) Read the stamp BACK rather than assuming the value we just
	// wrote: "first request wins" means a concurrent dispose may own it. This
	// exact value is the fence for the `disposed` write below — a create or
	// adopt landing between here and the kill resolving clears the stamp and
	// upserts `active` over a LIVE pty, and an unfenced write by id would then
	// mark that live terminal disposed (the reaper kills it, the list hides it).
	const stampedRow = db.query.terminalSessions
		.findFirst({
			where: eq(terminalSessions.id, terminalId),
			columns: {
				disposeRequestedAt: true,
				// (DISPOSE-LIMBO) Read alongside the stamp so the fenced write below
				// can tell "this row FLIPPED active -> disposed" from "it was already
				// disposed and the update rewrote endedAt". Only the flip may
				// broadcast an exit, and only the flip is news to anybody.
				status: true,
				// The limbo broadcast has no in-memory session to take a workspace id
				// from — the first dispose pass deleted it. The row is the only place
				// left that knows where the terminal lived.
				originWorkspaceId: true,
			},
		})
		.sync();
	const stampedAt = stampedRow?.disposeRequestedAt ?? null;
	const rowWasActive = stampedRow?.status === "active";
	const rowWorkspaceId = stampedRow?.originWorkspaceId ?? null;
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

	let dbDisposition: DisposeDbDisposition = "pending";

	if (closeResult.succeeded) {
		const endedAt = Date.now();
		// (DISPOSE-LIMBO) Fenced on the stamp we read at the top. If a create or
		// adopt ran while the kill was in flight it cleared `disposeRequestedAt`
		// and re-upserted the row `active` for a BRAND NEW live pty; this update
		// must not touch that row, and an unfenced write by id marked that live
		// terminal disposed (the reaper kills it, the list hides it).
		// (resolveAttachSessionOnce refusing to attach a stamped row shrinks the
		// window; only the fence closes it.)
		//
		// A null `stampedAt` is NOT a licence to write with `IS NULL`: it means
		// either there is no row for this id at all, or a racing create already
		// cleared the stamp — and in the second case `IS NULL` would match that
		// racing create's row and disposes it. Neither warrants a write.
		if (stampedRow === undefined) {
			// No row at all. This is the reaper's rowless-orphan pass doing exactly
			// what it exists to do — kill a live daemon PTY nothing durable
			// references — so it is a warning, not an invariant violation. It used
			// to log at error level, which taught readers to scroll past the one
			// line that DOES mean something (below).
			dbDisposition = "no-row";
			console.warn(
				"[terminal] dispose found no session row; nothing to mark disposed",
				{ terminalId, workspaceId: session?.workspaceId },
			);
		} else if (stampedAt === null) {
			// A row exists but the stamp we wrote at the top of this function is
			// gone: only an explicit create clears it, so the id already names a
			// different generation. Loud — this is the race, not the routine case.
			dbDisposition = "superseded";
			console.error(
				"[terminal] dispose found a row whose stamp was cleared; NOT marking anything disposed",
				{ terminalId, workspaceId: session?.workspaceId },
			);
		} else {
			const disposedRow = db
				.update(terminalSessions)
				.set({ status: "disposed", endedAt })
				.where(
					and(
						eq(terminalSessions.id, terminalId),
						eq(terminalSessions.disposeRequestedAt, stampedAt),
					),
				)
				.returning({ id: terminalSessions.id })
				.get();
			if (disposedRow) {
				dbDisposition = "disposed";
			} else {
				dbDisposition = "superseded";
				console.error(
					"[terminal] dispose raced a create/adopt; NOT marking the row disposed",
					{ terminalId, stampedAt, workspaceId: session?.workspaceId },
				);
			}
		}

		// Dispose unsubscribed the daemon callbacks above, so onExit will
		// never fire for this session — announce the exit here (after the
		// row flips to disposed, so refetching readers see it dead). Skip
		// sessions whose pty already exited: onExit broadcast that one, and
		// skip a superseded id: it now names somebody else's live terminal,
		// so an exit for it would be misattributed to the newcomer.
		if (session && !session.exited && dbDisposition !== "superseded") {
			session.eventBus?.broadcastTerminalLifecycle({
				workspaceId: session.workspaceId,
				terminalId,
				eventType: "exit",
				exitCode: 0,
				signal: 0,
				occurredAt: endedAt,
			});
		} else if (!session && dbDisposition === "disposed" && rowWasActive) {
			// (DISPOSE-LIMBO) THE CONFIRMING EXIT FOR A LIMBO TERMINAL.
			//
			// The first dispose pass ran `unsubscribeDaemon` and `sessions.delete`
			// BEFORE awaiting a close that then failed, so the daemon's own
			// `onExit` can never fire for this id and there is no in-memory session
			// left for the branch above to broadcast from. Every later pass — the
			// reaper's retry, a second explicit kill — therefore flipped the row
			// `active -> disposed` in silence: the renderer kept the pane's dots,
			// including a red AskUserQuestion latched at dispose time, for the rest
			// of the session. `lifecycleEvents` justifies ignoring the earlier
			// UNCONFIRMED exit with "the reaper emits the real one"; this is what
			// makes that true.
			//
			// Gated on the row having been `active`: a row already `disposed` has
			// had its exit announced once, and a second one would re-run teardown
			// for a terminal nobody is watching. `eventBus` is the caller's (the
			// reaper's), since this path by definition has no session to take one
			// from.
			if (rowWorkspaceId) {
				eventBus?.broadcastTerminalLifecycle({
					workspaceId: rowWorkspaceId,
					terminalId,
					eventType: "exit",
					exitCode: 0,
					signal: 0,
					occurredAt: endedAt,
				});
			} else {
				console.warn(
					"[terminal] disposed a sessionless row with no workspace; renderer not notified",
					{ terminalId },
				);
			}
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
		// lifecycle exit event the confirmed path emits, but flagged
		// `confirmed: false`. The row is deliberately left `active` for the
		// reaper to retry; "the renderer gives up on the pane" and "the host
		// stops trying to kill the PTY" are different questions and only the
		// first is answered here.
		//
		// The flag is load-bearing, not decorative: without it this broadcast is
		// byte-identical to a real exit, so `useV2WorkspaceRun` marked the run
		// stopped (offering a second run beside a process that may still be
		// live) and the dot path cleared latched agent state — both irreversible
		// acts founded on an `exitCode: 0` nobody observed.
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
				confirmed: false,
				occurredAt: Date.now(),
			});
		}
	}

	return {
		terminalId,
		daemonCloseAttempted: closeResult.attempted,
		daemonCloseSucceeded: closeResult.succeeded,
		dbDisposition,
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
export function listUndisposedTerminalIdsByWorkspaceId(
	workspaceId: string,
	db: HostDb,
): string[] {
	return (
		listUndisposedTerminalIdsByWorkspaceIds([workspaceId], db).get(
			workspaceId,
		) ?? []
	);
}

export function listUndisposedTerminalIdsByWorkspaceIds(
	workspaceIds: readonly string[],
	db: HostDb,
): Map<string, string[]> {
	const terminalIdsByWorkspace = new Map(
		workspaceIds.map((workspaceId) => [workspaceId, [] as string[]]),
	);
	if (workspaceIds.length === 0) return terminalIdsByWorkspace;

	const rows = db
		.select({
			id: terminalSessions.id,
			workspaceId: terminalSessions.originWorkspaceId,
		})
		.from(terminalSessions)
		.where(
			and(
				inArray(terminalSessions.originWorkspaceId, [...workspaceIds]),
				ne(terminalSessions.status, "disposed"),
			),
		)
		.all();
	for (const row of rows) {
		if (row.workspaceId === null) continue;
		terminalIdsByWorkspace.get(row.workspaceId)?.push(row.id);
	}
	return terminalIdsByWorkspace;
}

export async function disposeSessionsByWorkspaceId(
	workspaceId: string,
	db: HostDb,
	eventBus?: EventBus,
): Promise<{ terminated: number; failed: number }> {
	const terminalIds = listUndisposedTerminalIdsByWorkspaceId(workspaceId, db);

	let terminated = 0;
	let failed = 0;
	for (const terminalId of terminalIds) {
		try {
			const result = await disposeSessionAndWait(terminalId, db, eventBus);
			// (DISPOSE-LIMBO) Teardown needs both a confirmed daemon close and
			// a durable disposition for this terminal generation.
			if (isDisposalComplete(result)) {
				terminated += 1;
			} else {
				failed += 1;
			}
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
	eventBus?: EventBus,
): Promise<{ terminated: number; failed: number }> {
	const workspaceRows = db
		.select({ id: workspaces.id })
		.from(workspaces)
		.where(eq(workspaces.worktreePath, worktreePath))
		.all();

	let terminated = 0;
	let failed = 0;
	for (const { id } of workspaceRows) {
		const result = await disposeSessionsByWorkspaceId(id, db, eventBus);
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

type CreateSessionError = TerminalSessionError;
// (DISPOSE-LIMBO) `code: "session-gone"` marks an id permanently spoken for
// instead of retrying a request that can only fail.
type CreateSessionResult =
	| TerminalSession
	| (CreateSessionError & { code?: "session-gone" });

export async function createTerminalSessionInternal(
	options: CreateTerminalSessionOptions,
): Promise<CreateSessionResult> {
	const claudeAccounts = getManagedClaudeAccountsForLaunch(options.db);
	if (!claudeAccounts) return createTerminalSessionUnlocked(options);
	if (options.adoptOnly === true) {
		// (DISPOSE-LIMBO) Adoption never spawns or changes a live PTY's environment.
		// It must stay outside the workspace lock because disposal holds that lock
		// while awaiting an in-flight attach; locking adoption would make them wait
		// on each other. The unlocked path rejects disposeRequestedAt rows, so a
		// pending deletion cannot reactivate the terminal. Pre-upgrade PTYs keep
		// their existing environment until their next managed spawn.
		return createTerminalSessionUnlocked(options);
	}
	// (WORKTREE-EXIT-CLEANUP) Refused BEFORE the lock, not inside it. A
	// retirement holds this workspace's lock for its whole run — every terminal
	// disposed, then the pinned account released — so a launch that queued would
	// sit there for the length of that operation only to be refused at the front
	// of the queue. Asking the flag first answers it now.
	//
	// The two checks below still earn their place: the in-lock one catches a
	// launch that queued BEFORE the flag went up, and the one at the row insert
	// is the authoritative check every path reaches — including unmanaged hosts,
	// which take no lock here at all.
	if (isWorkspaceRetirementActive(options.workspaceId)) {
		return {
			kind: "WORKSPACE_RETIRED",
			error: workspaceRetiredError(options.workspaceId, options.terminalId),
		};
	}
	const retirementEpoch = readWorkspaceLaunchEpoch(options.workspaceId);
	return claudeAccounts.withWorkspaceLock(options.workspaceId, () => {
		if (isWorkspaceLaunchFenced(options.workspaceId, retirementEpoch)) {
			return Promise.resolve<CreateSessionResult>({
				kind: "WORKSPACE_RETIRED",
				error: workspaceRetiredError(options.workspaceId, options.terminalId),
			});
		}
		return createTerminalSessionUnlocked(options, claudeAccounts);
	});
}

function workspaceRetiredError(
	workspaceId: string,
	terminalId: string,
): string {
	return `Workspace "${workspaceId}" was exited while terminal "${terminalId}" was starting.`;
}

/** (WORKTREE-EXIT-CLEANUP) Thrown at the row insert, so the PTY this call
 * opened is closed by the cleanup that already guards that step. */
class WorkspaceRetiredDuringLaunchError extends Error {}

async function createTerminalSessionUnlocked(
	{
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
		restoredNotice = false,
	}: CreateTerminalSessionOptions,
	claudeAccounts?: ClaudeAccountsService,
): Promise<CreateSessionResult> {
	// (WORKTREE-EXIT-CLEANUP) The moment this launch began, re-read at the row
	// insert below. A launch that BEGINS inside the retirement window is
	// refused here, before a PTY exists — the unmanaged path arrives straight
	// at this function with no lock and no earlier check.
	const launchEpoch = readWorkspaceLaunchEpoch(workspaceId);
	if (isWorkspaceLaunchFenced(workspaceId, launchEpoch)) {
		return {
			kind: "WORKSPACE_RETIRED",
			error: workspaceRetiredError(workspaceId, terminalId),
		};
	}
	const existing = sessions.get(terminalId);
	if (existing) {
		const mismatchError = getTerminalWorkspaceMismatchError({
			terminalId,
			ownerWorkspaceId: existing.workspaceId,
			requestedWorkspaceId: workspaceId,
		});
		if (mismatchError)
			return { kind: "SESSION_WRONG_WORKSPACE", error: mismatchError };

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
	if (recordMismatchError)
		return { kind: "SESSION_WRONG_WORKSPACE", error: recordMismatchError };

	// (DISPOSE-LIMBO) An adopt must never recover a terminal someone asked to
	// kill. This is the choke point for EVERY adopt caller (the attach
	// resolution and `getOrAdoptSession`), checked here on the row we already
	// read rather than at each call site, because adopting a stamped row is
	// what erases the kill intent: the upsert below runs on the adopt path too.
	// A plain create is exempt on purpose — it is the one explicit instruction
	// to have a terminal with this id, and clearing the stamp is its job.
	if (adoptOnly && existingRecord?.disposeRequestedAt != null) {
		console.warn(
			"[terminal] refusing to adopt a terminal with a pending dispose",
			{
				terminalId,
				workspaceId,
				disposeRequestedAt: existingRecord.disposeRequestedAt,
			},
		);
		return {
			kind: "SESSION_EXITED",
			error: `Terminal session "${terminalId}" is being disposed.`,
		};
	}

	const workspace = db.query.workspaces
		.findFirst({ where: eq(workspaces.id, workspaceId) })
		.sync();

	if (!workspace) {
		return { kind: "WORKSPACE_NOT_FOUND", error: "Workspace not found" };
	}
	if (!existsSync(workspace.worktreePath)) {
		return {
			kind: "WORKTREE_GONE",
			error: `Workspace worktree no longer exists: ${workspace.worktreePath}`,
		};
	}

	// Derive root path from the workspace's project. Session workspaces
	// (null projectId) have no main repo; the session dir is the only root.
	let rootPath = "";
	const project = workspace.projectId
		? db.query.projects
				.findFirst({ where: eq(projects.id, workspace.projectId) })
				.sync()
		: undefined;
	if (project?.repoPath) {
		rootPath = project.repoPath;
	}

	const cwd = resolveTerminalCwd(cwdOverride, workspace.worktreePath);
	// Adoption overrides these with the PTY's live dims below: the session's
	// belief must match the kernel's, or the reanchor repaint logic misjudges
	// whether a client resize will deliver a real SIGWINCH.
	let cols = normalizeTerminalDimension(
		requestedCols,
		MIN_TERMINAL_COLS,
		DEFAULT_TERMINAL_COLS,
	);
	let rows = normalizeTerminalDimension(
		requestedRows,
		MIN_TERMINAL_ROWS,
		DEFAULT_TERMINAL_ROWS,
	);

	// Use the preserved shell snapshot — never live process.env. Resolution
	// runs in the background at startup so the server can listen immediately;
	// wait for it here before the first PTY needs the snapshot.
	const [claudeProfileDir] = await Promise.all([
		claudeAccounts
			? claudeAccounts.ensureProfileForLaunch(workspaceId)
			: Promise.resolve(null),
		waitForTerminalBaseEnv(),
	]);
	const baseEnv = getTerminalBaseEnv();
	// Fallback matters for hosts not spawned by the desktop (CLI/systemd):
	// without it the wrapper paths, hook guard env, and shell bootstrap all
	// silently disable (#6254).
	const supersetHomeDir = resolveSupersetHomeDir();
	const shell = resolveLaunchShell(baseEnv);
	const shellArgs = getShellLaunchArgs({ shell, supersetHomeDir });
	const ptyEnv = {
		...buildV2TerminalEnv({
			baseEnv,
			shell,
			supersetHomeDir,
			organizationId: process.env.ORGANIZATION_ID || "",
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
		}),
		// Usage-tab default account: provider CLIs typed or preset-launched in
		// this terminal run on the selected login. Baked at spawn as the fast
		// path; the agent wrappers re-resolve later switches at launch time.
		...resolveDefaultAccountTerminalEnv(db),
		...(claudeProfileDir ? { CLAUDE_CONFIG_DIR: claudeProfileDir } : {}),
	};

	let daemon: DaemonClient;
	try {
		daemon = await getDaemonClient();
	} catch (error) {
		// Transient only for connection-level failures (DaemonClient's typed
		// taxonomy): the supervisor heals those. Bootstrap failures (missing
		// daemon binary, no socket path, crash circuit open, handshake
		// rejection) are permanent — surfacing them beats silently retrying
		// a bootstrap that will fail the same way forever.
		const unreachable = error instanceof DaemonUnavailableError;
		return {
			kind: unreachable ? "DAEMON_UNAVAILABLE" : "TERMINAL_START_FAILED",
			error:
				error instanceof Error ? error.message : "Failed to start terminal",
			transient: unreachable,
		};
	}
	let openResult: { pid: number };
	let isAdopted = false;
	try {
		if (adoptOnly) {
			const found = (await daemon.list()).find(
				(s) => s.id === terminalId && s.alive,
			);
			if (!found) {
				return {
					kind: "SESSION_NOT_ACTIVE",
					error: `Terminal session "${terminalId}" is not active; create it before connecting.`,
				};
			}
			openResult = { pid: found.pid };
			isAdopted = true;
			cols = normalizeTerminalDimension(found.cols, MIN_TERMINAL_COLS, cols);
			rows = normalizeTerminalDimension(found.rows, MIN_TERMINAL_ROWS, rows);
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
					// (DISPOSE-LIMBO) This fallback is an ADOPT wearing a create's
					// clothes, and it must refuse a stamped row for the same reason
					// the `adoptOnly` check above does. It used to adopt happily: the
					// upsert below keeps the stamp (correct — `isAdopted`), so the
					// call returned SUCCESS with a row that `shouldReapRow` marks for
					// death and `listWorkspaceTerminalSessions` hides. The renderer
					// painted a live pane over a process the reaper killed inside one
					// interval, for a terminal it had just been told was created.
					//
					// Re-read rather than reusing `existingRecord`: that read happened
					// before an `await`-heavy stretch (env resolution, shell probe,
					// daemon connect), which is exactly long enough for a dispose to
					// land in between.
					const pendingDisposeRow = db.query.terminalSessions
						.findFirst({
							where: eq(terminalSessions.id, terminalId),
							columns: { disposeRequestedAt: true },
						})
						.sync();
					if (pendingDisposeRow?.disposeRequestedAt != null) {
						console.warn(
							"[terminal] refusing to adopt an existing daemon session with a pending dispose",
							{
								terminalId,
								workspaceId,
								disposeRequestedAt: pendingDisposeRow.disposeRequestedAt,
							},
						);
						// Returned SHAPED rather than thrown: the enclosing catch keeps
						// only the message, and this refusal must carry
						// `code: "session-gone"` like its two siblings in
						// resolveAttachSessionOnce — without it the renderer transport
						// does not mark the session ended and burns an extra reconnect
						// cycle re-asking for a terminal the host already refused.
						// The message matches the other two refusals verbatim.
						return {
							kind: "SESSION_EXITED",
							error: `Terminal session "${terminalId}" is being disposed.`,
							code: "session-gone",
						};
					}
					openResult = { pid: found.pid };
					isAdopted = true;
					cols = normalizeTerminalDimension(
						found.cols,
						MIN_TERMINAL_COLS,
						cols,
					);
					rows = normalizeTerminalDimension(
						found.rows,
						MIN_TERMINAL_ROWS,
						rows,
					);
					console.log(
						`[terminal] adopted existing daemon session ${terminalId} pid=${found.pid}`,
					);
				} else {
					throw err;
				}
			}
		}
	} catch (error) {
		const unreachable = error instanceof DaemonUnavailableError;
		return {
			kind: unreachable ? "DAEMON_UNAVAILABLE" : "TERMINAL_START_FAILED",
			error:
				error instanceof Error ? error.message : "Failed to start terminal",
			transient: unreachable,
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

		// (WORKTREE-EXIT-CLEANUP) The row insert is the moment this terminal
		// starts existing for everyone else, so it is where the launch fence
		// has to sit. No `await` separates this check from the insert, and
		// retirement opens its window in the same synchronous step that lists
		// the rows it disposes — so a launch either lands in that list or is
		// refused here, on managed and unmanaged hosts alike. The epoch catches
		// the launch that straddles a retirement that has already finished.
		if (isWorkspaceLaunchFenced(workspaceId, launchEpoch)) {
			throw new WorkspaceRetiredDuringLaunchError(
				workspaceRetiredError(workspaceId, terminalId),
			);
		}

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
					//
					// "Explicit create" means a PTY this call opened. An ADOPT —
					// `adoptOnly`, or the "session already exists" fallback below
					// the open — attaches to a pre-existing process, so clearing
					// the stamp there would silently retract a kill nobody
					// cancelled and disarm the reaper that was still chasing it.
					// The stamp survives, and the reaper finishes the job.
					...(isAdopted ? {} : { disposeRequestedAt: null }),
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
			//
			// (DISPOSE-LIMBO) closeDaemonSessionById RESOLVES with
			// `{ succeeded: false }` rather than throwing, so awaiting it without
			// reading the result is indistinguishable from a clean close — the
			// exact silent leak this cleanup exists to prevent, now with a
			// reassuring `await` in front of it. A live PTY with no row is
			// invisible to every consumer and unkillable by the reaper.
			try {
				const closeResult = await closeDaemonSessionById(terminalId, "SIGHUP");
				if (!closeResult.succeeded) {
					console.error(
						"[terminal] FAILED to close the orphaned daemon PTY; a live PTY now has no row",
						{
							terminalId,
							workspaceId,
							createError: error,
							closeAttempted: closeResult.attempted,
							closeError: closeResult.error,
						},
					);
				}
			} catch (closeError) {
				console.error("[terminal] failed to close the orphaned daemon PTY", {
					terminalId,
					closeError,
				});
			}
		}
		// (WORKTREE-EXIT-CLEANUP) A fenced launch is a refusal, not a fault: the
		// PTY it opened is closed above, and nothing durable was written.
		if (error instanceof WorkspaceRetiredDuringLaunchError) {
			return { kind: "WORKSPACE_RETIRED", error: error.message };
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

	// The tracker's leaked-mode reclaim needs the session to broadcast disarm
	// bytes, but the session literal below needs the tracker — close over a
	// ref assigned right after construction.
	let reclaimSession: TerminalSession | null = null;
	const modeTracker = createModeTracker(cols, rows, {
		onLeakedInputModeDisarm(bytes) {
			const s = reclaimSession;
			if (!s || !isCurrentLiveSession(s)) return;
			// deliverOutput feeds the tracker too, so its modes (and the next
			// attach preamble) converge with what clients were just told.
			deliverOutput(s, bytes);
		},
	});

	const session: TerminalSession = {
		terminalId,
		workspaceId,
		db,
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
		usedMissingMarkerGrace: false,
		lateMarkerRecorded: false,
		echoProbe: null,
		dsrCarry: new Uint8Array(0),
		// Adopted sessions have already run their initialCommand in the prior
		// host-service lifetime — flag it as queued so we don't double-fire it.
		initialCommandQueued: isAdopted,
		launchShellName: basename(shell),
		portHintDecoder: new StringDecoder("utf8"),
		modeTracker,
		adoptionReplaySettled: Promise.resolve(),
		epoch: randomBytes(8).toString("hex"),
		outputSeq: 0,
		retained: [],
		retainedBytes: 0,
		retainedStartSeq: 0,
		pendingRepaintNudge: null,
		resizeGeneration: 0,
		focusedSockets: new Set(),
		clientDims: new Map(),
		hiddenSockets: new Set(),
	};
	reclaimSession = session;
	const overwrittenSession = sessions.get(terminalId);
	sessions.set(terminalId, session);
	portManager.upsertSession(terminalId, workspaceId, pty.pid);

	if (session.shellReadyState === "pending") {
		// Size the wait to observed reality: on machines whose profile never
		// delivers the marker, the full wait *is* the launch latency.
		const missingEvidence =
			getShellReadyMarkerEvidence(session.launchShellName) === "missing";
		session.usedMissingMarkerGrace = missingEvidence;
		session.shellReadyTimeoutId = setTimeout(
			() => {
				resolveShellReady(session, "timed_out");
			},
			missingEvidence
				? SHELL_READY_MISSING_MARKER_GRACE_MS
				: SHELL_READY_TIMEOUT_MS,
		);
	}

	// daemon.subscribe warns (and joins the live stream) on a second
	// replay-subscribe for an id another (unserialized) creator just subscribed
	// — e.g. POST /terminal/sessions racing a WS respawn. Should it ever throw
	// again, rollback keeps THIS half-built session (unsubscribeDaemon still
	// null) out of the map: attaches would otherwise bind sockets to it and the
	// pane would be permanently output-dead. Restore the overwritten winner (or
	// clear the entry) and rethrow. The daemon PTY is intentionally NOT killed —
	// the racing winner shares it.
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
		// Always request the daemon's ring on subscribe: it is the only way to
		// rebuild the mode tracker after adoption (a tracker that never sees the
		// program's `?25l`/`?1004h`/kitty bytes builds wrong preambles and
		// disables host-side focus forwarding). Whether the replayed BYTES reach
		// any client is decided per-attach: seq clients are protected by
		// reanchor/anchor accounting, legacy `?replay=0` clients get the FIFO
		// dropped at attach. Fresh (non-adopted) sessions have an empty ring, so
		// replay is a no-op there.
		return daemon.subscribe(
			terminalId,
			{ replay: true },
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
					} else if (
						session.shellReadyState === "timed_out" &&
						!session.lateMarkerRecorded &&
						Date.now() - session.createdAt < LATE_MARKER_OBSERVATION_MS
					) {
						// Evidence-only scan for a marker arriving after the (grace)
						// timeout — output passes through untouched; a match flips a
						// `missing` brand back to `delivered` (self-healing evidence).
						const result = scanForShellReady(session.scanState, chunk);
						if (result.matched) {
							session.lateMarkerRecorded = true;
							recordShellReadyMarkerEvidence(
								session.launchShellName,
								"delivered",
							);
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

					session.echoProbe?.(bytes);

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

					const dsrQueries = scanForDsrCursorQueries(session, bytes);
					deliverOutput(session, bytes);
					// After deliverOutput so the mirror has consumed this chunk and
					// the reported cursor position is current.
					answerDsrCursorQueries(session, dsrQueries);
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

					// The agent died with the pty; unless its SessionEnd hook already
					// marked a clean detach, keep the binding as a resume candidate.
					try {
						markTerminalAgentBindingEnded(
							db,
							terminalId,
							"terminal-exited",
							occurredAt,
						);
					} catch (error) {
						console.warn(
							`[terminal] failed to mark agent binding ended for ${terminalId}`,
							error,
						);
					}

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

	// The ring replay lands asynchronously after subscribe; attach paths
	// await this so the first preamble reflects the rebuilt tracker.
	if (isAdopted) {
		session.adoptionReplaySettled = waitForAdoptionReplay(session);
	}

	if (initialCommand) {
		queueInitialCommand(session, initialCommand);
	}

	// (MASTER-PLUS-LAUNCH) Announce the session. Emitted HERE — last, after the
	// `active` row is committed, the session is in the map and the daemon
	// subscription is live — so every consumer that reacts by re-reading the
	// terminal list finds it. Emitting it beside the row insert would announce a
	// session that the subscribe rollback further up can still un-make.
	//
	// A create is otherwise SILENT on this channel: the OSC 133 scanner that
	// produces command-start/command-end is never instrumented for cmd.exe (the
	// fork's Windows fallback shell), so a session made after a workspace was
	// already open — `agents.run`, the CLI — emitted nothing until it exited.
	// Consumers of this channel are invalidate-only or eventType-guarded, so an
	// extra event is cheap; the missing one was not.
	eventBus?.broadcastTerminalLifecycle({
		workspaceId,
		terminalId,
		eventType: "created",
		adopted: isAdopted,
		occurredAt: createdAt,
	});

	return session;
}

// Concurrent create-on-attach dials for the same brand-new terminalId must
// share one spawn instead of racing createTerminalSessionInternal.
const inflightCreates = new Map<
	string,
	Promise<TerminalSession | CreateSessionError>
>();

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
			// (DISPOSE-LIMBO) A refusal to adopt or respawn a terminal with a
			// pending dispose is a lifecycle conflict, not a host fault: the id is
			// spoken for and will never come back. Answering 500 invited the caller
			// to retry a request that can only fail again, so it gets a 409 and the
			// `code` the WS attach path already uses for the same refusal.
			if (result.code === "session-gone") {
				return c.json({ error: result.error, code: result.code }, 409);
			}
			// 503 = daemon unreachable right now; callers may retry the same id.
			return c.json({ error: result.error }, result.transient ? 503 : 500);
		}

		return c.json({ terminalId: result.terminalId, status: "active" });
	});

	// REST dispose — does not require an open WebSocket
	app.delete("/terminal/sessions/:terminalId", async (c) => {
		const terminalId = c.req.param("terminalId");
		if (!terminalId) {
			return c.json({ error: "Missing terminalId" }, 400);
		}

		const session = sessions.get(terminalId);
		if (!session) {
			return c.json({ error: "Session not found" }, 404);
		}

		// (DISPOSE-LIMBO) Await the real outcome. This used to fire-and-forget
		// `disposeSession` and answer `status: "disposed"` before the daemon had
		// been asked anything at all — the same lie removed from
		// `terminal.killSession`, left behind here because only a profiling
		// script calls this route.
		const result = await disposeSessionAndWait(terminalId, db, eventBus);
		// (DISPOSE-LIMBO) A resolved close is not proof this terminal's generation
		// died. `superseded` means a create/adopt took the id mid-kill, so the
		// live thing behind it now is somebody else's — answering "disposed" here
		// would report the replacement dead.
		if (result.dbDisposition === "superseded") {
			return c.json({
				terminalId,
				status: "superseded",
				reason:
					"A newer terminal now owns this id; the old one was closed, this one was not.",
			});
		}
		if (!result.daemonCloseSucceeded) {
			return c.json({
				terminalId,
				status: "dispose-pending",
				reason: result.daemonCloseError ?? "daemon close did not confirm",
			});
		}
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
			const seqRequest = parseSeqAttachParam(c.req.query("seq"));
			// Optimistic pane creation: the renderer inserts the pane first and
			// lets this attach create the session, so plain terminal creation
			// never queues behind Chromium's 6-per-origin HTTP socket pool.
			const createRequested = c.req.query("create") === "1";
			const requestedThemeType = parseThemeType(c.req.query("themeType"));
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
				if (seqRequest.kind === "legacy") {
					// Pre-seq contract: `?replay=0` means "my xterm already has
					// the scrollback". Adoption now always pulls the daemon ring
					// (the mode tracker needs it), so drop the FIFO here instead
					// of double-painting this client.
					if (c.req.query("replay") === "0") {
						session.buffer.length = 0;
						session.bufferBytes = 0;
					}
					replayBuffer(session, ws);
				} else {
					sendSeqAttach(session, ws, seqRequest);
				}
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
				| TerminalSession
				| { error: string; code?: "session-gone"; transient?: boolean }
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
					// Only ids with no session row at all qualify for create-on-attach
					// — exited/disposed records below keep their session-gone answer.
					if (createRequested && requestedWorkspaceId) {
						const inflight = inflightCreates.get(terminalId);
						if (inflight) {
							const shared = await inflight;
							if ("error" in shared) return shared;
							// The shared spawn was created for the FIRST dial's workspace —
							// validate ownership like every other attach path.
							const mismatchError = getTerminalWorkspaceMismatchError({
								terminalId,
								ownerWorkspaceId: shared.workspaceId,
								requestedWorkspaceId,
							});
							if (mismatchError) return { error: mismatchError };
							return shared;
						}
						const createPromise = createTerminalSessionInternal({
							terminalId,
							workspaceId: requestedWorkspaceId,
							themeType: requestedThemeType,
							db,
							eventBus,
						});
						inflightCreates.set(terminalId, createPromise);
						try {
							return await createPromise;
						} finally {
							inflightCreates.delete(terminalId);
						}
					}
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
				// no re-check needed here. The adopt/respawn pair lives inside
				// resolveAttachSessionOnce so concurrent attaches share one
				// resolution and the (DISPOSE-LIMBO) stamp is re-checked around it.
				return resolveAttachSessionOnce({
					terminalId,
					workspaceId: record.originWorkspaceId,
					themeType: requestedThemeType,
					db,
					eventBus,
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
							const transient = !session.code && session.transient;
							sendMessage(ws, {
								type: "error",
								message: session.error,
								code:
									session.code ?? (transient ? "attach-retryable" : undefined),
							});
							// 1013 "try again later" for transient failures; the renderer
							// keys off the JSON code, the close code is for log readers.
							ws.close(transient ? 1013 : 1011, toWsCloseReason(session.error));
							return;
						}
						// A just-adopted session may still be receiving the daemon's
						// ring replay: wait for it to quiesce so the mode preamble
						// reflects the program's real state and the replayed bytes
						// don't broadcast to this socket. Resolved immediately in
						// every other case.
						await session.adoptionReplaySettled;
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
						disposeSession(terminalId ?? "", db, eventBus);
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

					if (message.type === "focus") {
						if (message.focused) {
							session.focusedSockets.add(ws);
						} else {
							session.focusedSockets.delete(ws);
						}
						syncPtyFocus(session);
						return;
					}

					if (message.type === "visible") {
						if (message.visible) {
							session.hiddenSockets.delete(ws);
						} else {
							session.hiddenSockets.add(ws);
						}
						// Going hidden releases this client's size constraint;
						// coming back re-imposes it.
						applyEffectiveDims(session);
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
						session.clientDims.set(ws, { cols, rows });
						// A reanchor attach waits for this first client resize:
						// changed dims deliver the repaint SIGWINCH naturally;
						// unchanged dims need the forced nudge. What matters is
						// the size the PTY ends up at, which is the minimum across
						// visible clients — not the dims this one asked for.
						const next = effectiveDims(session);
						const dimsUnchanged =
							next === null ||
							(next.cols === session.cols && next.rows === session.rows);
						const needsForcedNudge =
							session.pendingRepaintNudge !== null && dimsUnchanged;
						clearPendingRepaintNudge(session);
						applyEffectiveDims(session, { force: true });
						if (needsForcedNudge) nudgeRepaint(session);
					}
				},

				onClose: (_event, ws) => {
					// (DISPOSE-LIMBO) The socket's OWN session wins over a lookup by
					// terminalId, which can resolve to a different session after a
					// re-attach. Either way the departing client's size constraint has
					// to be released off the session it was actually applied to, or the
					// PTY stays clamped to a viewer that is gone.
					const owner = socketOwners.get(ws);
					if (owner) {
						owner.sockets.delete(ws);
						socketOwners.delete(ws);
						// A departing focused client may hand focus-out to the program
						// (unless another attached client still holds focus).
						if (owner.focusedSockets.delete(ws)) syncPtyFocus(owner);
						releaseSocketDims(owner, ws);
						cleanupDetachedSession(owner, "socket-close");
					} else {
						const session = sessions.get(terminalId ?? "");
						if (!session) return;
						session.sockets.delete(ws);
						if (session.focusedSockets.delete(ws)) syncPtyFocus(session);
						releaseSocketDims(session, ws);
					}
				},

				onError: (_event, ws) => {
					const owner = socketOwners.get(ws);
					if (owner) {
						owner.sockets.delete(ws);
						socketOwners.delete(ws);
						if (owner.focusedSockets.delete(ws)) syncPtyFocus(owner);
						releaseSocketDims(owner, ws);
						cleanupDetachedSession(owner, "socket-error");
					} else {
						const session = sessions.get(terminalId ?? "");
						if (!session) return;
						session.sockets.delete(ws);
						if (session.focusedSockets.delete(ws)) syncPtyFocus(session);
						releaseSocketDims(session, ws);
					}
				},
			};
		}),
	);
}
