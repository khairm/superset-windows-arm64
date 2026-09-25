import type EventEmitter from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import { NOTIFICATION_EVENTS } from "shared/constants";
import type { AgentLifecycleEvent } from "shared/notification-types";
import { installPaneMapHook } from "./pane-map-hook";
import {
	isSyntheticInterruptRecord,
	judgeTurnEndRecord,
	mayBeTurnEndLine,
	parseTranscriptRecord,
	recordPredatesFence,
	resetTurnEndGate,
	TURN_END_MAX_AGE_MS,
	type TurnEndVerdict,
} from "./turn-end-gate";

/**
 * Windows fallback for Claude/Codex agent lifecycle: tail per-session JSONL
 * transcripts and forward state transitions into notificationsEmitter as if
 * they came from the v1/v2 hook server.
 *
 * Sidesteps the bash-only hook chain (settings.json command, notify.sh,
 * notification server, claude wrapper) which is broken on Windows. See
 * AGENTS.md and the project memory `superset-windows-hook-chain-broken`.
 *
 * Claude dots are driven by the host-service POST hook (superset-notify.py,
 * installed by pane-map-hook.ts); this watcher only MIRRORS background-subagent
 * activity for Claude (so the parent terminal stays yellow while subagents run
 * even after the main agent Stops). All other Claude lifecycle transitions are
 * suppressed here — the POST hook owns working/review/permission, so the JSONL
 * idle-timer/tool-tracking heuristics were removed for Claude. Codex still uses
 * the JSONL state machine below (no host-service hook on Windows yet).
 *
 * Sources:
 *   - Claude: ~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl
 *   - Codex:  ~/.codex/sessions/**\/rollout-<ts>-<uuid>.jsonl
 *
 * State derived per-agent (see CLAUDE_PARSER / CODEX_PARSER) and
 * deduplicated per **session id** (from the JSONL filename) so each
 * session has its own independent lastStatus + idle timer — sibling
 * sessions in the same workspace cwd never suppress each other.
 *
 * Pane resolution is deferred to the renderer (live Zustand store) via the
 * `cwd` field on the emitted event. The companion `pane-map-hook.ts`
 * installs a small Python SessionStart hook that writes a {sessionId →
 * paneId/tabId/workspaceId} mapping file; when present, those IDs are
 * attached to emitted events for precise per-pane resolution (the
 * renderer prefers them over cwd-based lookup).
 */

interface AgentParser {
	readonly id: "claude" | "codex";
	isActivity(line: string): boolean;
	isExplicitStop(line: string): boolean;
	isPermissionRequest(line: string): boolean;
}

interface AgentSource {
	readonly logsDir: string;
	readonly parser: AgentParser;
}

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");
const CODEX_SESSIONS_DIR = path.join(os.homedir(), ".codex", "sessions");
const SUPERSET_PANE_MAP_DIR = path.join(
	os.homedir(),
	".superset",
	"session-pane-map",
);

// (WATCHER-ASYNC-IO)
const DEBUG_LOG_PATH = path.join(
	os.homedir(),
	".superset",
	"agent-watcher-debug.log",
);
const DEBUG_MAX_BYTES = 2 * 1024 * 1024;
const DEBUG_ENABLED = process.env.SUPERSET_AGENT_WATCHER_DEBUG === "1";
const DEBUG_QUEUE_LIMIT = 256;
const debugQueue: string[] = [];
let debugWriting = false;
let debugFailed = false;

function isFileMissing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function flushDebugQueue(): Promise<void> {
	debugWriting = true;
	try {
		while (debugQueue.length > 0) {
			let size = 0;
			try {
				size = (await fs.promises.stat(DEBUG_LOG_PATH)).size;
			} catch (error) {
				if (!isFileMissing(error)) throw error;
			}
			if (size > DEBUG_MAX_BYTES) {
				await fs.promises.rename(DEBUG_LOG_PATH, `${DEBUG_LOG_PATH}.prev`);
			}
			await fs.promises.appendFile(
				DEBUG_LOG_PATH,
				debugQueue.splice(0).join(""),
				"utf8",
			);
		}
	} catch (error) {
		debugFailed = true;
		debugQueue.length = 0;
		console.error("[agent-watcher] Debug log writer failed", error);
	} finally {
		debugWriting = false;
	}
}

function dbg(kind: string, fields: Record<string, unknown>): void {
	if (!DEBUG_ENABLED || debugFailed) return;
	if (debugQueue.length === DEBUG_QUEUE_LIMIT) debugQueue.shift();
	debugQueue.push(
		`${new Date().toISOString()} ${kind} ${JSON.stringify(fields)}\n`,
	);
	if (!debugWriting) void flushDebugQueue();
}

function dbgLine(sessionId: string | null, kind: string, line: string): void {
	if (!DEBUG_ENABLED) return;
	dbg("line", { sessionId, kind, snippet: line.slice(0, 160) });
}

// Monotonic event id for joining a watcher emit to the renderer-side
// console line it produces. Format: agent-lifecycle:<pid>:<seq>. The seq
// resets per process; the pid keeps it unique across reloads in a shared
// main.log. Logging-only — not attached to the emitted event payload.
let eventIdSeq = 0;
function nextEventId(): string {
	eventIdSeq += 1;
	return `agent-lifecycle:${process.pid}:${eventIdSeq}`;
}

const POLL_DEBOUNCE_MS = 250;
// fs.watch (ReadDirectoryChangesW) on Windows does NOT reliably deliver an
// event for a transcript's LAST append before the writer goes idle — exactly
// the AskUserQuestion case (agent writes the question line, then waits for the
// user). Without a fallback the watcher never reads that line, so the dot never
// turns red. POLL_KNOWN_MS re-stats already-tracked files for growth (fast, so
// red/working/answer land within a couple seconds even when fs.watch drops the
// event); POLL_DISCOVER_MS rescans for brand-new session files whose creation
// event was also missed.
const POLL_KNOWN_MS = 2500;
const POLL_DISCOVER_MS = 12000;
// (WATCHER-ASYNC-IO)
const COLD_FILE_AGE_MS = 24 * 60 * 60 * 1000;
const POLL_COLD_MS = 60_000;
// How long after the last JSONL activity to consider an agent "done" with
// the turn. End-of-turn isn't reliably marked in every session (only
// ~3 of 8 Claude turns in the test corpus carried stop_reason:"end_turn"),
// so an inactivity fallback is essential.
// Long enough that pauses between Claude tool calls within a single
// turn don't trigger a fake "review" transition (which plays the
// notification sound). The explicit-stop parsers (isExplicitStop) are
// the primary signal; this is only a fallback when the JSONL never
// writes a clean end-of-turn marker.
const IDLE_TIMEOUT_MS = 45000;

const CWD_REGEX = /"cwd":"((?:[^"\\]|\\.)+)"/;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

// ---------------------------------------------------------------------------
// Per-agent parsers
// ---------------------------------------------------------------------------

const CLAUDE_PARSER: AgentParser = {
	id: "claude",
	isActivity(line) {
		// "Activity" = Claude is working. Only Claude's own output counts:
		// assistant messages, tool calls, thinking. User-role lines never
		// indicate Claude is working — they are either prompts (the next
		// assistant line will flip to working naturally), tool_result
		// echoes (filtered), or interrupt markers like
		// "[Request interrupted by user]".
		if (line.includes('"type":"assistant"')) return true;
		if (line.includes('"type":"tool_use"')) return true;
		if (line.includes('"type":"thinking"')) return true;
		return false;
	},
	isExplicitStop(line) {
		if (line.includes('"stop_reason":"end_turn"')) return true;
		if (line.includes('"hookEvent":"Stop"')) return true;
		if (line.includes('"subtype":"stop_hook_summary"')) return true;
		if (line.includes('"subtype":"turn_duration"')) return true;
		return false;
	},
	isPermissionRequest(line) {
		// Three cases for Claude:
		// 1. Out-of-bypass mode: Claude fires a "PermissionRequest" hookEvent.
		//    Coded to the documented schema; activates when a non-bypass
		//    session runs.
		// 2. Built-in AskUserQuestion tool call: Claude blocks waiting for
		//    a user response via the Superset overlay. The JSONL writes a
		//    tool_use line for tool name "AskUserQuestion"; the tool_result
		//    comes back when the user answers (or ESCs out). Double-
		//    substring guard avoids matching the literal string in
		//    free-form text content.
		// 3. Legacy/custom ask_user tool name — kept for any agent that
		//    registers a tool with the snake_case identifier.
		if (line.includes('"hookEvent":"PermissionRequest"')) return true;
		if (line.includes('"type":"tool_use"')) {
			if (line.includes('"name":"AskUserQuestion"')) return true;
			if (line.includes('"name":"ask_user"')) return true;
		}
		return false;
	},
};

const CODEX_PARSER: AgentParser = {
	id: "codex",
	isActivity(line) {
		// Codex writes coarser events than Claude. `task_started` and any
		// `agent_message` / `user_message` / `token_count` event_msg
		// indicates the turn is alive.
		if (line.includes('"type":"event_msg"')) {
			if (line.includes('"type":"task_started"')) return true;
			if (line.includes('"type":"agent_message"')) return true;
			if (line.includes('"type":"user_message"')) return true;
			if (line.includes('"type":"token_count"')) return true;
		}
		// `response_item` covers tool calls and messages.
		if (line.includes('"type":"response_item"')) return true;
		return false;
	},
	isExplicitStop(line) {
		if (line.includes('"type":"task_complete"')) return true;
		if (line.includes('"type":"agent-turn-complete"')) return true;
		if (line.includes('"type":"turn_aborted"')) return true;
		return false;
	},
	isPermissionRequest(line) {
		if (line.includes('"type":"exec_approval_request"')) return true;
		if (line.includes('"type":"apply_patch_approval_request"')) return true;
		if (line.includes('"type":"request_user_input"')) return true;
		return false;
	},
};

const SOURCES: AgentSource[] = [
	{ logsDir: CLAUDE_PROJECTS_DIR, parser: CLAUDE_PARSER },
	{ logsDir: CODEX_SESSIONS_DIR, parser: CODEX_PARSER },
];

// ---------------------------------------------------------------------------
// Watcher state
// ---------------------------------------------------------------------------

interface FileState {
	offset: number;
	leftover: Buffer[];
	skipPartialLine: boolean;
	replayReset: boolean;
	inFlight: Promise<void> | null;
	trailingWork: boolean;
	initialized: boolean;
	identity: string | null;
	nextPollAt: number;
	cwd: string | null;
	sessionId: string | null;
	parser: AgentParser;
	/**
	 * (WATCHER-BLUE-STOMP) Watcher start time while a Claude startup-guard tail
	 * re-read of THIS file is still outstanding; null otherwise. Everything the
	 * tail contains that is stamped before it is pre-start history.
	 *
	 * It lives on the state rather than in a readFileStep local because arming the
	 * tail REWINDS `offset` before the read that consumes it: if that read throws
	 * (a Windows lock on a file Claude Code is writing is enough), the retry pass
	 * is no longer `isFirstSeen`, so a pass-local flag recomputes as false and the
	 * rewound offset would be re-read UNFENCED — arming auto-resume off an
	 * hours-old api-error. Cleared by the first pass that actually consumes the
	 * tail (i.e. advances the offset past it).
	 */
	preStartFenceMs: number | null;
}

// Dedup state is keyed per agent session (`session:<uuid>` from the
// filename) so each session has an independent lastStatus + idle timer.
// Sibling sessions in the same workspace cwd don't suppress each
// other's transitions; mapping appearing mid-session doesn't migrate
// keys. Falls back to `cwd:<normalized>` only for files without a
// derivable session id (shouldn't happen in practice — both Claude and
// Codex filenames are UUID-shaped).
type Status = "working" | "review" | "permission";
interface LifecycleState {
	lastStatus: Status | null;
	/**
	 * Whether the last emit for this session carried a paneId mapping.
	 * If a cwd-only Start fired before the Python hook wrote the mapping
	 * file, we need to re-emit the same status once the mapping appears
	 * so the renderer can rebind to the precise paneId.
	 */
	lastEmittedHadMapping: boolean;
	idleTimer: NodeJS.Timeout | null;
}

interface PaneMapping {
	paneId?: string;
	tabId?: string;
	terminalId?: string;
	workspaceId?: string;
}

interface WatcherDeps {
	installPaneMapHook?: () => void;
	notificationsEmitter: EventEmitter;
	// (AUTO-RESUME) Forwarded when a Claude main session appends an API-error record.
	// The auto-resume manager debounces + re-reads the transcript tail to confirm the
	// failure is genuinely turn-ending before classifying — so passing a possibly-
	// transient mid-turn error here is safe.
	onClaudeApiError?: (info: {
		sessionId: string;
		cwd: string;
		terminalId?: string;
		workspaceId?: string;
		transcriptPath: string;
	}) => void;
}

const fileStates = new Map<string, FileState>();
const lifecycleStates = new Map<string, LifecycleState>();
const watchers = new Map<string, fs.FSWatcher>();
let scanTimer: NodeJS.Timeout | null = null;
let pollKnownTimer: NodeJS.Timeout | null = null;
let pollDiscoverTimer: NodeJS.Timeout | null = null;
let seedRetryTimer: NodeJS.Timeout | null = null;
let deps: WatcherDeps | null = null;
// (WATCHER-ASYNC-IO)
let generation = 0;
let pollInFlight: Promise<void> | null = null;
const IO_CONCURRENCY = 32;
const READ_STEP_BYTES = 64 * 1024;
const READ_CONCURRENCY = 4;
interface ReadPool {
	active: number;
	waiting: Array<(acquired: boolean) => void>;
}
let readPool: ReadPool = { active: 0, waiting: [] };
const PARSE_YIELD_LINES = 128;

function isCurrent(run: number): boolean {
	return deps !== null && generation === run;
}

function ownsFile(filePath: string, state: FileState, run: number): boolean {
	return isCurrent(run) && fileStates.get(filePath) === state;
}

async function yieldAndOwns(
	filePath: string,
	state: FileState,
	run: number,
): Promise<boolean> {
	await yieldToLoop();
	return ownsFile(filePath, state, run);
}

function atYieldBoundary(lineIndex: number): boolean {
	return lineIndex > 0 && lineIndex % PARSE_YIELD_LINES === 0;
}

function fileIdentity(stat: fs.Stats): string {
	return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
}

async function withReadSlot(
	run: number,
	read: () => Promise<void>,
): Promise<void> {
	const pool = readPool;
	if (pool.active >= READ_CONCURRENCY) {
		const acquired = await new Promise<boolean>((resolve) =>
			pool.waiting.push(resolve),
		);
		if (!acquired) return;
	} else {
		pool.active++;
	}
	try {
		if (isCurrent(run)) await read();
	} finally {
		pool.active--;
		const next = pool.waiting.shift();
		if (next) {
			pool.active++;
			next(true);
		}
	}
}

function nextColdPollAt(mtimeMs: number, now = Date.now()): number {
	return now - mtimeMs > COLD_FILE_AGE_MS ? now + POLL_COLD_MS : 0;
}

function reportWatcherError(error: unknown): void {
	console.error("[agent-watcher] I/O failed", error);
}

function normalizeCwd(cwd: string): string {
	return cwd.replace(/\\/g, "/").toLowerCase();
}

/**
 * Recover the cwd from a JSONL entry. Both Claude and Codex stamp the
 * original cwd into nearly every entry. Sniffing the first chunk avoids
 * Windows directory-name decoding (drive colons are stripped, so
 * `C--Users-foo` and `Users-foo` would round-trip identically).
 */
function extractCwd(line: string): string | null {
	const m = line.match(CWD_REGEX);
	if (!m) return null;
	return m[1].replace(/\\\\/g, "\\").replace(/\\"/g, '"');
}

/**
 * Recover the agent session id from the filename:
 *   Claude: <session-uuid>.jsonl
 *   Codex:  rollout-<timestamp>-<session-uuid>.jsonl
 */
function extractSessionIdFromFilename(filePath: string): string | null {
	const base = path.basename(filePath, ".jsonl");
	if (base.startsWith("rollout-")) {
		const m = base.match(UUID_RE);
		return m ? m[0].toLowerCase() : null;
	}
	if (UUID_RE.test(base)) return base.toLowerCase();
	return null;
}

/**
 * Load a {sessionId → pane/tab/workspace} mapping written by the
 * Superset-managed SessionStart hook (`superset-pane-map.py`). Returns
 * undefined if absent — the renderer falls back to cwd-based resolution.
 */
// (WATCHER-ASYNC-IO)
const MAPPING_CACHE_LIMIT = 512;
const MAPPING_CACHE_TTL_MS = 60_000;
const mappingCache = new Map<
	string,
	{
		signature: string;
		mapping: PaneMapping;
		expiresAt: number;
	}
>();

async function loadPaneMapping(
	sessionId: string,
	run = generation,
): Promise<PaneMapping | undefined> {
	const file = path.join(SUPERSET_PANE_MAP_DIR, `${sessionId}.json`);
	try {
		const stat = await fs.promises.stat(file);
		if (!isCurrent(run)) return;
		const now = Date.now();
		for (const [key, entry] of mappingCache) {
			if (entry.expiresAt > now) break;
			mappingCache.delete(key);
		}
		const signature = `${fileIdentity(stat)}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
		const cached = mappingCache.get(file);
		if (cached?.signature === signature) return cached.mapping;
		const raw = await fs.promises.readFile(file, "utf8");
		if (!isCurrent(run)) return;
		const parsed = JSON.parse(raw);
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			Array.isArray(parsed)
		) {
			throw new Error(`Invalid pane mapping: ${file}`);
		}
		const mapping: PaneMapping = {};
		for (const key of [
			"paneId",
			"tabId",
			"terminalId",
			"workspaceId",
		] as const) {
			const value: unknown = parsed[key];
			if (value !== undefined && typeof value !== "string") {
				throw new Error(`Invalid ${key} in pane mapping: ${file}`);
			}
			mapping[key] = value;
		}
		mappingCache.delete(file);
		mappingCache.set(file, {
			signature,
			mapping,
			expiresAt: now + MAPPING_CACHE_TTL_MS,
		});
		if (mappingCache.size > MAPPING_CACHE_LIMIT) {
			const oldest = mappingCache.keys().next().value;
			if (oldest !== undefined) mappingCache.delete(oldest);
		}
		return mapping;
	} catch (error) {
		if (!isCurrent(run)) return;
		mappingCache.delete(file);
		if (isFileMissing(error)) return;
		throw error;
	}
}

const SUBAGENT_RUNNING_DIR = path.join(
	os.homedir(),
	".superset",
	"agent-subagent-running",
);

// (BF codex-companion parity) Mirror of the Python hook's _codex_job_active. The
// codex plugin dispatches work to a DETACHED worker (separate process, its OWN
// API) that is invisible to Claude's background_tasks[] and SURVIVES a Claude
// interrupt. Each job is a JSON file tagged with the Claude session_id. When the
// watcher emits its own interrupt turn-end it must NOT green the dot if such a
// job for this session is still active — emit SubagentActive (yellow) instead.
// "Active" = status queued|running AND (a live worker pid with a <6h-fresh
// record, OR a pid-less record younger than 10min = spawn in progress).
// Best-effort.
function listGlobFiles(
	base: string,
	tests: Array<(name: string) => boolean>,
): string[] {
	let dirs = [base];
	for (let i = 0; i < tests.length; i++) {
		const isLast = i === tests.length - 1;
		const test = tests[i];
		const next: string[] = [];
		for (const d of dirs) {
			let entries: fs.Dirent[];
			try {
				entries = fs.readdirSync(d, { withFileTypes: true });
			} catch {
				continue;
			}
			for (const e of entries) {
				if (!test(e.name)) continue;
				if (isLast) {
					if (e.isFile()) next.push(path.join(d, e.name));
				} else if (e.isDirectory()) {
					next.push(path.join(d, e.name));
				}
			}
		}
		dirs = next;
	}
	return dirs;
}

function codexJobActive(sessionId: string | null): boolean {
	if (!sessionId) return false;
	try {
		const home = os.homedir();
		const roots: Array<[string, Array<(n: string) => boolean>]> = [
			[
				path.join(home, ".claude", "plugins", "data"),
				[
					(n) => n.startsWith("codex"),
					(n) => n === "state",
					() => true,
					(n) => n === "jobs",
					(n) => n.endsWith(".json"),
				],
			],
			[
				path.join(os.tmpdir(), "codex-companion"),
				[() => true, (n) => n === "jobs", (n) => n.endsWith(".json")],
			],
		];
		const ACTIVE = new Set(["queued", "running"]);
		const now = Date.now();
		for (const [root, tests] of roots) {
			for (const jf of listGlobFiles(root, tests)) {
				let rec: Record<string, unknown> | null = null;
				for (let i = 0; i < 2; i++) {
					try {
						rec = JSON.parse(fs.readFileSync(jf, "utf8")) as Record<
							string,
							unknown
						>;
						break;
					} catch {
						rec = null;
					}
				}
				if (!rec || typeof rec !== "object") continue;
				if (rec.sessionId !== sessionId) continue;
				if (!ACTIVE.has(String(rec.status ?? ""))) continue;
				const pidNum = Number(rec.pid);
				const hasPid =
					rec.pid !== null &&
					rec.pid !== undefined &&
					rec.pid !== "" &&
					Number.isInteger(pidNum);
				if (hasPid) {
					let alive = false;
					if (pidNum > 0) {
						try {
							process.kill(pidNum, 0); // signal 0 = liveness probe (cross-platform)
							alive = true;
						} catch (e) {
							alive = (e as NodeJS.ErrnoException)?.code === "EPERM";
						}
					}
					if (!alive) continue;
					try {
						if ((now - fs.statSync(jf).mtimeMs) / 1000 < 21600) return true;
					} catch {
						return true;
					}
					continue;
				}
				try {
					if ((now - fs.statSync(jf).mtimeMs) / 1000 < 600) return true;
				} catch {
					return true;
				}
			}
		}
	} catch {}
	return false;
}

function askqHasOwner(terminalId: string, includeMain: boolean): boolean {
	// (UNTAGGED-BG-RED) does a still-open AskUserQuestion owner marker exist? The
	// watcher emits Stop DIRECTLY to the renderer on a main interrupt, bypassing
	// the Python central guard; if a live question remains, the renderer turn-end would
	// clear its permission red, so the caller emits SubagentActive instead. `includeMain`
	// false = only detached teammate/subagent owners (a genuine main interrupt aborts
	// the main's own question); true = any owner (a post-truncation re-read touched
	// nothing, so even `_main` must not be Stop-cleared).
	if (!/^[A-Za-z0-9_-]+$/.test(terminalId)) return false;
	try {
		return fs
			.readdirSync(path.join(SUBAGENT_RUNNING_DIR, `${terminalId}.askq`))
			.some((f) => includeMain || f !== "_main");
	} catch {
		return false;
	}
}

function stampMainStopped(terminalId: string): void {
	// (UNTAGGED-BG-RED) mark the main loop as stopped (the `.mainstopped` sentinel)
	// when the watcher holds the dot red-respecting (SubagentActive) for a surviving
	// teammate question on a main interrupt — so the eventual last SubagentStop can
	// still finalize to green once that question is answered. Mirrors the Python
	// central guard's stamp on a held turn-end.
	if (!/^[A-Za-z0-9_-]+$/.test(terminalId)) return;
	try {
		fs.writeFileSync(
			path.join(SUBAGENT_RUNNING_DIR, `${terminalId}.mainstopped`),
			"",
		);
	} catch {}
}

function clearAskqMainMarker(terminalId: string): void {
	// (UNTAGGED-BG-RED) remove ONLY the main-loop (`_main`) owner marker. Used on a
	// watcher-detected MAIN interrupt: it aborts the main loop's own question, but a
	// detached teammate keeps running on its own and its question marker must survive
	// (clearing the whole dir would drop a live teammate's red).
	if (!/^[A-Za-z0-9_-]+$/.test(terminalId)) return;
	try {
		fs.unlinkSync(
			path.join(SUBAGENT_RUNNING_DIR, `${terminalId}.askq`, "_main"),
		);
	} catch {}
}

// (WATCHER-BLUE-STOMP) Turn-end identification and the replay gate both live in
// ./turn-end-gate — see that module for the corpus evidence behind the exact
// synthetic-record predicates and the age bounds.

function emit(
	// (WATCHER-BLUE-STOMP) Deliberately NO `BackgroundRunning` here. The watcher
	// never asserts blue: it stays SILENT on a replayed turn-end, so the blue the
	// notify hook asserted is never stomped in the first place, and a genuine
	// turn-end still emits a bare `Stop` (which is how the (BA) blue latch is
	// meant to clear — blue has no self-clear — and what keeps the "Agent
	// Complete" chime and native notification firing).
	eventType: "Start" | "Stop" | "PermissionRequest" | "SubagentActive",
	sessionId: string | null,
	cwd: string,
	mapping: PaneMapping | undefined,
	// Logging-only join key. Defaults to a fresh id for emits that don't
	// originate from a transition (e.g. the idle timer). Not part of the
	// emitted event payload — only the dbg record below.
	eventId: string = nextEventId(),
): void {
	if (!deps) return;
	const event: AgentLifecycleEvent = {
		eventType,
		cwd,
		sessionId: sessionId ?? undefined,
		...(mapping ?? {}),
	};
	dbg("emit", {
		eventId,
		eventType,
		sessionId: sessionId ?? null,
		cwd,
		paneId: mapping?.paneId ?? null,
		terminalId: mapping?.terminalId ?? null,
		workspaceId: mapping?.workspaceId ?? null,
		hadFullV2Target: !!(mapping?.terminalId && mapping?.workspaceId),
	});
	deps.notificationsEmitter.emit(NOTIFICATION_EVENTS.AGENT_LIFECYCLE, event);
}

/**
 * Key for the dedup/timer state map. Prefer the agent session id (from
 * the JSONL filename — Claude `<uuid>.jsonl`, Codex `rollout-...<uuid>`)
 * so each session has its own independent state machine and sibling
 * sessions in the same workspace don't suppress each other's emits.
 * Falls back to normalized cwd only for files we couldn't extract a
 * session id from. Keying by paneId or cwd alone conflates concurrent
 * sessions in the same pane/dir; keying by session id matches the
 * lifecycle granularity the renderer's pane.status state machine
 * expects (one Start/Stop sequence per agent turn).
 */
function getStateKey(sessionId: string | null, cwd: string): string {
	if (sessionId) return `session:${sessionId}`;
	return `cwd:${normalizeCwd(cwd)}`;
}

function getState(
	sessionId: string | null,
	cwd: string,
): { key: string; state: LifecycleState } {
	const key = getStateKey(sessionId, cwd);
	let s = lifecycleStates.get(key);
	if (!s) {
		s = {
			lastStatus: null,
			lastEmittedHadMapping: false,
			idleTimer: null,
		};
		lifecycleStates.set(key, s);
	}
	return { key, state: s };
}

function cancelIdleTimer(s: LifecycleState): void {
	if (s.idleTimer) {
		clearTimeout(s.idleTimer);
		s.idleTimer = null;
	}
}

function transitionTo(
	target: Status,
	sessionId: string | null,
	cwd: string,
	mapping: PaneMapping | undefined,
): void {
	const { key: stateKey, state: s } = getState(sessionId, cwd);
	// "Refined" means we now have either paneId (v1) or terminalId (v2)
	// or both — either is sufficient to bypass cwd-based fallback in the
	// renderer's resolver and for V2NotificationController's bridge
	// (which requires terminalId for v2).
	const hasMapping = !!(mapping?.paneId || mapping?.terminalId);
	// Re-emit the same status when mapping has been refined (cwd-only
	// → ID-precise) so the renderer can rebind to the right pane.
	const mappingNewlyRefined = hasMapping && !s.lastEmittedHadMapping;
	if (s.lastStatus === target && !mappingNewlyRefined) {
		dbg("transition-suppressed", {
			sessionId,
			target,
			lastStatus: s.lastStatus,
			hasMapping,
			stateKey,
			lastEmittedHadMapping: s.lastEmittedHadMapping,
			hasTerminalId: !!mapping?.terminalId,
			hasWorkspaceId: !!mapping?.workspaceId,
		});
		return;
	}
	const eventId = nextEventId();
	dbg("transition", {
		eventId,
		sessionId,
		from: s.lastStatus,
		to: target,
		hasMapping,
		mappingNewlyRefined,
	});
	s.lastStatus = target;
	s.lastEmittedHadMapping = hasMapping;
	if (target === "working") emit("Start", sessionId, cwd, mapping, eventId);
	else if (target === "review") emit("Stop", sessionId, cwd, mapping, eventId);
	else if (target === "permission")
		emit("PermissionRequest", sessionId, cwd, mapping, eventId);
}

// Idle fallback. Used ONLY by the Codex JSONL state machine (no clean
// end-of-turn marker in every session). NOT used for Claude at all: the
// background-subagent mirror force-asserts working with no timer, and the
// Claude main agent is driven by the host-service POST hook
// (superset-notify.py), which owns Claude working/review/permission.
function scheduleIdleTimer(
	sessionId: string | null,
	cwd: string,
	mapping: PaneMapping | undefined,
	delayMs = IDLE_TIMEOUT_MS,
): void {
	const { key, state: s } = getState(sessionId, cwd);
	cancelIdleTimer(s);
	const run = generation;
	s.idleTimer = setTimeout(() => {
		void (async () => {
			const current = lifecycleStates.get(key);
			if (!isCurrent(run) || current !== s) return;
			current.idleTimer = null;
			// Only transition working → review on idle; if we ended on
			// permission, the agent is genuinely blocked waiting on the user
			// and the indicator should stay red.
			if (current.lastStatus === "working") {
				// Reload mapping — the Python SessionStart hook may have
				// written the mapping file between schedule and fire. Using
				// the closure's stale mapping would emit Stop with the wrong
				// (or missing) paneId.
				const freshMapping = sessionId
					? await loadPaneMapping(sessionId, run)
					: mapping;
				if (
					!isCurrent(run) ||
					lifecycleStates.get(key) !== s ||
					s.lastStatus !== "working" ||
					s.idleTimer !== null
				)
					return;
				current.lastStatus = "review";
				current.lastEmittedHadMapping = !!(
					freshMapping?.paneId || freshMapping?.terminalId
				);
				dbg("idle-timeout-fired", {
					sessionId,
					cwd,
					from: "working",
					to: "review",
					timeoutMs: IDLE_TIMEOUT_MS,
				});
				emit("Stop", sessionId, cwd, freshMapping);
			}
		})().catch((error) => {
			if (!isCurrent(run) || lifecycleStates.get(key) !== s) return;
			reportWatcherError(error);
			if (s.lastStatus === "working" && s.idleTimer === null) {
				scheduleIdleTimer(sessionId, cwd, mapping, POLL_KNOWN_MS);
			}
		});
	}, delayMs);
}

// (WATCHER-ASYNC-IO)
function processFile(
	filePath: string,
	source: AgentSource,
	seedOnly: boolean,
): Promise<void> {
	const run = generation;
	if (!isCurrent(run)) return Promise.resolve();
	let state = fileStates.get(filePath);
	if (!state) {
		state = {
			offset: 0,
			leftover: [],
			skipPartialLine: false,
			replayReset: false,
			cwd: null,
			sessionId: extractSessionIdFromFilename(filePath),
			parser: source.parser,
			preStartFenceMs: null,
			inFlight: null,
			trailingWork: false,
			initialized: false,
			identity: null,
			nextPollAt: 0,
		};
		fileStates.set(filePath, state);
	}
	if (state.inFlight) {
		if (!seedOnly) state.trailingWork = true;
		return state.inFlight;
	}
	const owned = state;
	// (WATCHER-ASYNC-IO)
	const requestedAtMs = Date.now();
	owned.inFlight = withReadSlot(run, async () => {
		let seed = seedOnly && !owned.trailingWork;
		do {
			const workPendingSinceMs = owned.trailingWork ? requestedAtMs : null;
			owned.trailingWork = false;
			try {
				await readFileStep(
					filePath,
					source,
					seed,
					owned,
					run,
					workPendingSinceMs,
				);
			} catch (error) {
				if (!ownsFile(filePath, owned, run)) return;
				if (isFileMissing(error)) {
					fileStates.delete(filePath);
					return;
				}
				throw error;
			}
			seed = false;
		} while (ownsFile(filePath, owned, run) && owned.trailingWork);
	}).finally(() => {
		if (ownsFile(filePath, owned, run)) owned.inFlight = null;
	});
	return owned.inFlight;
}

// (WATCHER-ASYNC-IO)
function lineWrittenAfterFence(line: string, fenceMs: number): boolean {
	const record = parseTranscriptRecord(line);
	if (!record || typeof record.timestamp !== "string") return false;
	const timestampMs = Date.parse(record.timestamp);
	return Number.isFinite(timestampMs) && timestampMs >= fenceMs;
}

function splitChunkIntoLines(
	chunk: Buffer,
	leftover: Buffer[],
): { lines: string[]; leftover: Buffer[] } {
	const lines: string[] = [];
	let pending = [...leftover];
	let start = 0;
	while (start < chunk.length) {
		const end = chunk.indexOf(10, start);
		if (end === -1) break;
		if (pending.length === 0) {
			lines.push(chunk.toString("utf8", start, end));
		} else {
			pending.push(chunk.subarray(start, end));
			lines.push(Buffer.concat(pending).toString("utf8"));
			pending = [];
		}
		start = end + 1;
	}
	if (start < chunk.length) pending.push(Buffer.from(chunk.subarray(start)));
	return { lines, leftover: pending };
}

async function readFileStep(
	filePath: string,
	source: AgentSource,
	seedOnly: boolean,
	state: FileState,
	run: number,
	/**
	 * (WATCHER-ASYNC-IO) When this pass was already carrying unread activity
	 * before it acquired its reader slot, the time that activity was asked for;
	 * null when nothing was pending. A first-seen subagent transcript that grew
	 * while queued must read that growth instead of seeding past it, and its
	 * fence has to predate the growth to admit it.
	 */
	workPendingSinceMs: number | null,
): Promise<void> {
	const readStartedAtMs = Date.now();
	const stat = await fs.promises.stat(filePath);
	if (!ownsFile(filePath, state, run)) return;
	const changedDuringStat = state.trailingWork || workPendingSinceMs !== null;
	const identity = fileIdentity(stat);
	const replaced = state.identity !== null && state.identity !== identity;
	const isFirstSeen = !state.initialized;
	state.identity = identity;

	// Background-subagent transcript (Task or workflow/TeamCreate)? It never
	// drives its own dot; its activity is mirrored to the parent terminal.
	const subagentParent = getSubagentParentSessionId(filePath);
	// (AN) (WATCHER-ASYNC-IO)
	const subagentChangedDuringStat =
		isFirstSeen && subagentParent !== null && changedDuringStat;
	if (isFirstSeen && isSubagentFile(filePath) && !subagentChangedDuringStat) {
		state.offset = stat.size;
		state.nextPollAt = nextColdPollAt(stat.mtimeMs);
		state.initialized = true;
		return;
	}

	// (WATCHER-BLUE-STOMP) Is this a pre-existing file that a write reached before
	// the deferred seed scan did? Blind-tailing such a file to EOF is what makes
	// the seed's own gap dangerous: an append that lands between fs.watch going
	// live and the seed reaching this file is skipped PAST, never judged, never
	// emitted. For Claude that can swallow a real interrupt, which has no hook
	// fallback at all, so the dot stays stuck. Instead the Claude path re-reads a
	// bounded tail under the pre-start fence (below) — recent enough to contain
	// anything written since we started, small enough never to stall the main
	// thread on a multi-megabyte transcript at startup.
	const startupGuard =
		isFirstSeen &&
		(!seedOnly || state.trailingWork || stat.mtimeMs >= watcherStartedAtMs) &&
		isUnseededPreexistingFile(stat);
	// (WATCHER-ASYNC-IO)
	let fencedTailRead = startupGuard || subagentChangedDuringStat;

	// First time we've seen this file, and it is one the seed owns. Skip its
	// history (the user already saw those state transitions) and start tailing
	// from the current end-of-file. Before jumping, read enough of the header to
	// cache cwd — for Codex the cwd lives only in the first session_meta entry, so
	// we'd otherwise never see it once we'd skipped past.
	const seedHistory =
		seedOnly && (seedComplete || stat.birthtimeMs < watcherStartedAtMs);
	if (
		isFirstSeen &&
		!subagentParent &&
		(!fencedTailRead || source.parser.id === "codex") &&
		(seedHistory || startupGuard)
	) {
		try {
			const header = await readHeader(filePath, stat.size, run);
			if (!ownsFile(filePath, state, run)) return;
			state.cwd = extractCwd(header);
		} catch (error) {
			if (!ownsFile(filePath, state, run)) return;
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "EBUSY" && code !== "EACCES" && code !== "EPERM")
				throw error;
			reportWatcherError(error);
		}
		if (
			fencedTailRead ||
			(state.trailingWork &&
				((source.parser.id === "codex" && changedDuringStat) ||
					isUnseededPreexistingFile(stat)))
		) {
			fencedTailRead = true;
		} else {
			state.offset = stat.size;
			state.nextPollAt = nextColdPollAt(stat.mtimeMs);
			state.initialized = true;
			return;
		}
	}

	if (fencedTailRead) {
		// Back the cut up one byte so the fragment-drop below is exact: if that
		// byte is a newline the cut was already on a record boundary and the drop
		// takes the empty string instead of a real record; if it is not, the drop
		// takes the genuine fragment. Either way nothing whole is lost.
		const tailStart = Math.max(0, stat.size - STARTUP_GUARD_TAIL_BYTES);
		state.offset = tailStart > 0 ? tailStart - 1 : 0;
		// Persisted, because the rewind above outlives this pass if the read fails
		// — see FileState.preStartFenceMs.
		state.skipPartialLine = state.offset > 0;
		state.preStartFenceMs =
			subagentChangedDuringStat ||
			(source.parser.id === "codex" && !startupGuard)
				? (workPendingSinceMs ?? readStartedAtMs)
				: watcherStartedAtMs;
		dbg("startup-guard-tail", {
			filePath,
			sessionId: state.sessionId,
			size: stat.size,
			fromOffset: state.offset,
			fenceMs: state.preStartFenceMs,
		});
	}

	// Truncation/rotation: reset offset and re-read from the start. Fall
	// through (don't return early) so replacement content isn't skipped
	// until the next append.
	// Record that this pass is a from-offset-0 re-read of the WHOLE transcript.
	// The Claude block still emits its (benign) interrupt Stop on such a pass,
	// but every side effect that touches marker files is skipped: a re-read
	// carries questions and errors from turns that may still be live, so
	// clearing `_main`, stamping `.mainstopped` or re-arming auto-resume off one
	// would act on a turn that never ended.
	if (replaced || stat.size < state.offset) {
		dbg("file-truncated", {
			filePath,
			sessionId: state.sessionId,
			oldOffset: state.offset,
			newSize: stat.size,
		});
		state.offset = 0;
		state.leftover = [];
		state.skipPartialLine = false;
		state.replayReset = true;
	}
	state.initialized = true;
	state.nextPollAt = 0;
	// (WATCHER-ASYNC-IO)
	if (stat.size === state.offset) {
		clearGuardsAtEof(state);
		return;
	}

	// (WATCHER-ASYNC-IO)
	let newOffset = state.offset;
	let newLeftover = state.leftover;
	let skipPartialLine = state.skipPartialLine;
	let skippedCompleteLines = false;
	const fh = await fs.promises.open(filePath, "r");
	try {
		if (!ownsFile(filePath, state, run)) return;
		const mapping =
			state.sessionId && !subagentParent
				? await loadPaneMapping(state.sessionId, run)
				: undefined;
		if (!ownsFile(filePath, state, run)) return;
		while (newOffset < stat.size) {
			const buf = Buffer.allocUnsafe(
				Math.min(READ_STEP_BYTES, stat.size - newOffset),
			);
			const { bytesRead } = await fh.read(buf, 0, buf.length, newOffset);
			if (!ownsFile(filePath, state, run)) return;
			if (bytesRead === 0) break;
			newOffset += bytesRead;
			const { lines, leftover } = splitChunkIntoLines(
				buf.subarray(0, bytesRead),
				newLeftover,
			);
			newLeftover = leftover;
			if (skipPartialLine && lines.length > 0) {
				lines.shift();
				skipPartialLine = false;
			}
			if (!subagentParent && !state.cwd) {
				for (let i = 0; i < lines.length; i++) {
					if (atYieldBoundary(i) && !(await yieldAndOwns(filePath, state, run)))
						return;
					const cwd = extractCwd(lines[i]);
					if (cwd) {
						state.cwd = cwd;
						break;
					}
				}
				if (state.cwd && skippedCompleteLines) {
					newOffset = state.offset;
					newLeftover = state.leftover;
					skipPartialLine = state.skipPartialLine;
					if (!(await yieldAndOwns(filePath, state, run))) return;
					continue;
				}
				skippedCompleteLines ||= lines.length > 0;
			}
			if (subagentParent || state.cwd) {
				if (subagentParent) {
					await mirrorSubagentToParent(
						subagentParent,
						lines,
						state.parser,
						filePath,
						state,
						run,
					);
				} else {
					await processLines(
						filePath,
						state,
						run,
						lines,
						mapping,
						newOffset - state.offset,
					);
				}
				if (!ownsFile(filePath, state, run)) return;
				// (WATCHER-ASYNC-IO)
				state.offset = newOffset;
				state.leftover = newLeftover;
				state.skipPartialLine = skipPartialLine;
			}
			if (newOffset < stat.size && !(await yieldAndOwns(filePath, state, run)))
				return;
		}
	} finally {
		await fh.close();
	}
	if (!ownsFile(filePath, state, run)) return;
	if (state.offset === stat.size) clearGuardsAtEof(state);
}

/**
 * (WATCHER-ASYNC-IO) Both guards describe content still waiting to be read, so
 * reaching EOF retires them — including a truncation to zero bytes, which
 * reaches EOF with nothing to read at all. Leaving the replay guard armed there
 * would gate the next LIVE append's api-error out of auto-resume.
 */
function clearGuardsAtEof(state: FileState): void {
	state.replayReset = false;
	state.preStartFenceMs = null;
}

// (WATCHER-ASYNC-IO)
async function processLines(
	filePath: string,
	state: FileState,
	run: number,
	lines: string[],
	mapping: PaneMapping | undefined,
	newBytes: number,
): Promise<void> {
	const truncatedReset = state.replayReset;
	const preStartFenceMs = state.preStartFenceMs;
	const cwd = state.cwd;
	if (!cwd) throw new Error("Transcript batch has no cwd");
	const { parser } = state;

	// Claude dots are driven by the host-service POST hook (superset-notify.py);
	// System 1 only mirrors background-subagent activity for Claude (handled
	// above in the subagent branch of readFileStep). The JSONL lifecycle state
	// machine below is therefore Codex-only — gated here at the single
	// dispatch chokepoint so Claude main-agent lines never emit (which caused
	// the live "stuck working" split-brain against the POST hook). The banned
	// timing fallbacks (idle tool-tracking, ask tool_use_id release, ESC/user-
	// line handling, generation-gap defer) were removed entirely with this gate.
	if (parser.id === "claude") {
		// Claude main-agent lifecycle is owned by the host-service POST hook
		// (superset-notify.py). The ONLY thing the watcher still does for a Claude
		// main line is release a turn-end the hook CANNOT see: a user interrupt/ESC,
		// for which Claude Code fires no hook at all, so nothing else can clear a
		// stuck AskUserQuestion red or the (BA) background-blue latch.
		// Event-driven, no timer. (Use state.sessionId — the block-scoped
		// `const { sessionId }` below is in the temporal dead zone here.)
		//
		// (WATCHER-BLUE-STOMP) There is deliberately NO api-error turn-end path here.
		// Claude Code runs its StopFailure hooks whenever a turn's last record is an
		// api-error, and superset-notify.py's StopFailure branch answers Stop — the
		// hook owns that class, which is the fork's whole dot design (hook-is-truth),
		// and the watcher's version of it was dead code for months: its legacy
		// signatures matched 0 of the 1317 real api-error records in the local corpus
		// (they were internal CLI Error strings, never transcript text) with zero
		// stuck-dot fallout, because the hook already covered the class. Reviving it
		// cost more than it bought. Admitting an abort needs the PRECEDING assistant
		// record to tell a real turn-end from a tool_use continuation, but real
		// write-time gaps (1.8-10.4s) against 250ms/2500ms polling put 8 of 9 real
		// aborts in a chunk that does NOT carry their predecessor — so the guard is
		// skipped, and on a live continuation the emit would fire a false Stop
		// mid-turn, reap LIVE subagents' run-dir markers, wipe a pending question's
		// `.askq` red, and double-ring the Agent-Complete chime against the hook's own
		// StopFailure Stop. The watcher's only remaining contribution for an api-error
		// is the auto-resume signal below, which asserts no dot state at all.
		//
		// Scan the WHOLE chunk once rather than break-ing on the first match, so a
		// chunk carrying an interrupt anywhere in it still resolves to one emit.
		let sawInterrupt = false;
		let sawAnyApiError = false;
		// (WATCHER-BLUE-STOMP) Per-entry replay gate — see judgeTurnEndRecord. A
		// matched line sets sawInterrupt only if it describes a turn that ended JUST
		// NOW; a re-presented one is recorded as suppressed and nothing is emitted.
		const nowMs = Date.now();
		const suppressed: Array<{
			reason: TurnEndVerdict["reason"];
			ageMs: number | null;
			uuid: string | null;
		}> = [];
		for (let i = 0; i < lines.length; i++) {
			if (atYieldBoundary(i) && !(await yieldAndOwns(filePath, state, run)))
				return;
			const line = lines[i];
			if (!line) continue;
			// (AUTO-RESUME) ANY api-error line is a candidate for auto-resume; the
			// manager confirms turn-finality itself. Deliberately NOT replay-gated: it
			// arms nothing by itself — the manager re-reads the transcript tail and
			// decides finality there. The one exception is a fenced re-read, where an
			// api-error stamped before the watcher started is history and would arm a
			// resume for a dead turn.
			if (line.includes('"isApiErrorMessage":true')) {
				if (preStartFenceMs === null) {
					sawAnyApiError = true;
				} else {
					const errRecord = parseTranscriptRecord(line);
					if (errRecord && !recordPredatesFence(errRecord, preStartFenceMs))
						sawAnyApiError = true;
				}
			}
			// (WATCHER-BLUE-STOMP) A turn-end must be Claude Code's EXACT synthetic
			// interrupt record, not a line that merely contains the phrase. The marker
			// is quoted constantly by this repo's own agent traffic (review reports,
			// teammate messages, tool_results that cat transcript lines), and a quote is
			// genuinely new content — unique uuid, current timestamp — so the replay
			// gate below certifies it as fresh and the false Stop fires MID-TURN.
			// Corpus evidence and the record shape are in ./turn-end-gate.
			if (!mayBeTurnEndLine(line)) continue;
			const record = parseTranscriptRecord(line);
			if (!record) continue;
			if (!isSyntheticInterruptRecord(record)) continue;
			const verdict = judgeTurnEndRecord(record, nowMs, preStartFenceMs);
			if (!verdict.fresh) {
				suppressed.push({
					reason: verdict.reason,
					ageMs: verdict.ageMs,
					uuid: verdict.uuid,
				});
				continue;
			}
			sawInterrupt = true;
		}
		if (suppressed.length > 0) {
			// (WATCHER-BLUE-STOMP) This channel is how the original stomp was found —
			// keep every gated match findable. Samples are capped so a whole-file
			// re-read cannot flood the log.
			dbg("turn-end-replay-suppressed", {
				sessionId: state.sessionId,
				terminalId: mapping?.terminalId ?? null,
				suppressedCount: suppressed.length,
				emittedAnyway: sawInterrupt,
				truncatedReset,
				startupFenced: preStartFenceMs !== null,
				maxAgeMs: TURN_END_MAX_AGE_MS,
				samples: suppressed.slice(0, 5),
				filePath,
			});
		}
		if (sawInterrupt) {
			// (UNTAGGED-BG-RED) a genuine MAIN interrupt clears the MAIN loop's own
			// question guard (no Stop hook fires on an interrupt to do it) but NOT a
			// detached teammate's — teammates survive a main interrupt, so clear only
			// `_main`. Skipped on a post-truncation re-read so a live later-turn
			// question is never dropped.
			if (!truncatedReset && mapping?.terminalId)
				clearAskqMainMarker(mapping.terminalId);
			// (UNTAGGED-BG-RED) this Stop goes STRAIGHT to the renderer, bypassing the
			// Python central guard; the renderer turn-end clears the single permission
			// axis. If a question is still live, emit the red-respecting SubagentActive
			// so a detached teammate's red survives. Genuine main interrupt: `_main` was
			// just cleared, so only a non-`_main` owner counts; truncation re-read: we
			// touched nothing, so any owner (incl `_main`) must not be Stop-cleared.
			const askqTid = mapping?.terminalId;
			const heldRed = !!askqTid && askqHasOwner(askqTid, truncatedReset);
			// (BF) a codex companion survives a Claude interrupt (own API) -> keep
			// working (yellow) too, not only for a held question.
			const hold = heldRed || codexJobActive(state.sessionId);
			// (SENTINEL-HOLD) EVERY hold on a genuine interrupt stamps .mainstopped
			// (held question OR codex-only): without it the eventual last
			// SubagentStop fails its sentinel check and no-ops — the yellow then
			// waits on the stale-working sweep instead of finalizing on time.
			if (hold && !truncatedReset && askqTid) stampMainStopped(askqTid);
			// (WATCHER-BLUE-STOMP) A bare `Stop` here is correct AND required. The
			// replay gate above means this only runs for a turn that ended just now,
			// so there is no stale-marker phantom to guard against — and the (BA)
			// background-blue latch has no self-clear, so a real interrupt is one of
			// the paths that MUST clear it. It also keeps the "Agent Complete" chime
			// and native notification (both Stop-only) firing on a real interrupt.
			const emitted = hold ? "SubagentActive" : "Stop";
			dbg("claude-interrupt-release", {
				sessionId: state.sessionId,
				terminalId: mapping?.terminalId ?? null,
				truncatedReset,
				heldRed,
				hold,
				emitted,
				filePath,
			});
			emit(emitted, state.sessionId, cwd, mapping);
		}
		// (AUTO-RESUME) Forward an api-error candidate. We do NOT veto the whole chunk on a
		// co-occurring interrupt — the manager re-reads the transcript tail and only arms
		// when the error is still the last MEANINGFUL line (an interrupt AFTER the error
		// makes that false; an interrupt BEFORE it is harmless). Skipped on a post-
		// truncation full re-read so a permanent error line from an earlier turn can't re-arm.
		if (sawAnyApiError && !truncatedReset && state.sessionId) {
			deps?.onClaudeApiError?.({
				sessionId: state.sessionId,
				cwd,
				terminalId: mapping?.terminalId,
				workspaceId: mapping?.workspaceId,
				transcriptPath: filePath,
			});
		}
		dbg("claude-gated", {
			sessionId: state.sessionId,
			filePath,
			lineCount: lines.length,
		});
		return;
	}

	// Process lines in arrival order so a Start in turn N+1 isn't masked
	// by a Stop from turn N within the same chunk.
	const { sessionId } = state;
	let unclassified = 0;
	let sampleUnclassified = "";
	for (let i = 0; i < lines.length; i++) {
		if (atYieldBoundary(i) && !(await yieldAndOwns(filePath, state, run)))
			return;
		const line = lines[i];
		if (!line) continue;
		if (
			preStartFenceMs !== null &&
			!lineWrittenAfterFence(line, preStartFenceMs)
		)
			continue;
		if (parser.isPermissionRequest(line)) {
			dbgLine(sessionId, "permission", line);
			const { state: s } = getState(sessionId, cwd);
			cancelIdleTimer(s);
			transitionTo("permission", sessionId, cwd, mapping);
		} else if (parser.isExplicitStop(line)) {
			dbgLine(sessionId, "explicit-stop", line);
			const { state: s } = getState(sessionId, cwd);
			cancelIdleTimer(s);
			transitionTo("review", sessionId, cwd, mapping);
		} else if (parser.isActivity(line)) {
			dbgLine(sessionId, "activity", line);
			transitionTo("working", sessionId, cwd, mapping);
			scheduleIdleTimer(sessionId, cwd, mapping);
		} else {
			unclassified++;
			if (!sampleUnclassified) sampleUnclassified = line.slice(0, 160);
		}
	}
	dbg("chunk", {
		sessionId,
		filePath,
		newBytes,
		lineCount: lines.length,
		cwdKnown: !!cwd,
		unclassified,
		sampleUnclassified,
	});
}

// Pending per-file processing keyed by absolute path. Debounce window
// coalesces tight bursts of write events on the same file.
const pendingFiles = new Map<
	string,
	{ source: AgentSource; timer: NodeJS.Timeout }
>();

function schedulePerFileProcess(filePath: string, source: AgentSource): void {
	if (!deps) return;
	const existing = pendingFiles.get(filePath);
	if (existing) {
		clearTimeout(existing.timer);
		pendingFiles.delete(filePath);
	}
	const state = fileStates.get(filePath);
	if (state?.inFlight) {
		state.trailingWork = true;
		return;
	}
	const run = generation;
	const timer = setTimeout(() => {
		if (!isCurrent(run)) return;
		pendingFiles.delete(filePath);
		void processFile(filePath, source, false).catch(reportWatcherError);
	}, POLL_DEBOUNCE_MS);
	pendingFiles.set(filePath, { source, timer });
}

function sourceForParser(parser: AgentParser): AgentSource | undefined {
	return SOURCES.find((s) => s.parser === parser);
}

/**
 * fs.watch fallback: re-stat every tracked transcript and process any that
 * grew since we last read it. Catches the missed-trailing-append case (e.g. a
 * pending AskUserQuestion, or the agent's first working line) that
 * ReadDirectoryChangesW drops on Windows. Routes through the same debounced
 * path as fs.watch so a real event + a poll for the same file coalesce.
 */
// (WATCHER-ASYNC-IO)
function pollKnownFilesForGrowth(): Promise<void> {
	if (pollInFlight) return pollInFlight;
	const run = generation;
	if (!isCurrent(run)) return Promise.resolve();
	pollInFlight = (async () => {
		const now = Date.now();
		const failures: unknown[] = [];
		const entries = [...fileStates].filter(
			([, state]) => now >= state.nextPollAt,
		);
		for (let i = 0; i < entries.length; i += IO_CONCURRENCY) {
			const results = await Promise.allSettled(
				entries.slice(i, i + IO_CONCURRENCY).map(async ([filePath, state]) => {
					if (!ownsFile(filePath, state, run)) return;
					try {
						const stat = await fs.promises.stat(filePath);
						if (!ownsFile(filePath, state, run)) return;
						if (
							stat.size !== state.offset ||
							fileIdentity(stat) !== state.identity
						) {
							state.nextPollAt = 0;
							const source = sourceForParser(state.parser);
							if (source) schedulePerFileProcess(filePath, source);
						} else {
							state.nextPollAt = nextColdPollAt(stat.mtimeMs, now);
						}
					} catch (error) {
						if (!ownsFile(filePath, state, run)) return;
						if (!isFileMissing(error)) throw error;
						fileStates.delete(filePath);
					}
				}),
			);
			for (const result of results) {
				if (result.status === "rejected") failures.push(result.reason);
			}
			await yieldToLoop();
			if (!isCurrent(run)) return;
		}
		if (failures.length)
			throw new AggregateError(failures, "Transcript stat sweep failed");
	})().finally(() => {
		if (isCurrent(run)) pollInFlight = null;
	});
	return pollInFlight;
}

// (AN) The startup seed scan and the discovery poll must never do BLOCKING
// fs work on the main thread. A large ~/.claude/projects + ~/.codex/sessions
// history (thousands of .jsonl, tens of GB) otherwise starves the renderer's
// superset-app:// protocol handler for minutes — the multi-minute blank-
// window cold start. Two distinct blockers are addressed here:
//   1. The header seed reads each file's first 8 KB. Done SYNCHRONOUSLY
//      (statSync + readSync) across ~11k files on cold storage it alone was
//      ~5 min. -> seedFileAsync uses fs.promises so the I/O runs off the main
//      thread, and walkJsonlAsync yields every SEED_SCAN_YIELD_EVERY files.
//   2. The 12 s discover poll replayed each first-seen file's ENTIRE body.
//      If it fired before the seed finished it synchronously read the whole
//      multi-GB history (~10 MB/s for ~9 min). -> the discover poll is held
//      until the seed has tailed every existing file to EOF, then only ever
//      touches genuinely-new files, and walks asynchronously.
const SEED_SCAN_YIELD_EVERY = 25;

/**
 * (WATCHER-BLUE-STOMP) How much of a pre-existing Claude transcript the startup
 * guard re-reads to find appends the deferred seed would have skipped past.
 *
 * The window it has to cover is the gap between fs.watch going live and the seed
 * reaching this file — ~1.2 s warm here — so a quarter megabyte is orders of
 * magnitude more than a session can write in it, while keeping each
 * read bounded. That bound is the point: an active transcript is routinely tens
 * of megabytes, and reading one whole on the main thread at startup is exactly
 * the blocking-I/O footgun that starved the renderer and left the window blank
 * for minutes. Same size as auto-resume's transcript tail, for the same reason.
 */
const STARTUP_GUARD_TAIL_BYTES = 256 * 1024;

// True once the initial seed has tailed every existing file to EOF. Until
// then the discover poll must not run — it would replay the full history.
let seedComplete = false;
// (WATCHER-BLUE-STOMP) When the watcher started, for the pre-seed race below.
// 0 while stopped.
let watcherStartedAtMs = 0;
// Prevents overlapping discover walks (a slow walk + the 12 s timer).
let discoverInFlight = false;

/**
 * (WATCHER-BLUE-STOMP) Is this first-seen file one the seed scan has simply not
 * reached yet?
 *
 * `fs.watch` is installed synchronously at startup, but the seed scan that tails
 * every existing transcript to EOF is deferred (setImmediate + an async walk of
 * a tree that is ~10k files here). A write to an ALREADY-ACTIVE transcript in
 * that gap arrives as a first-seen file and gets read from offset 0 — the whole
 * history, through a cold uuid layer. The age layer suppresses the bulk of it,
 * but a real interrupt sentinel younger than the window would still emit a Stop
 * on top of a live hook `Start`.
 *
 * A file created BEFORE the watcher started is by definition one the seed scan
 * owns. Codex seeds it (tail from EOF) instead of replaying it; Claude re-reads
 * a bounded tail under the pre-start fence, because tailing blind would swallow
 * the very append that woke us — see the startupGuard branch in
 * readFileStep. The seed walk's own `fileStates.has` check then skips the file
 * either way.
 * A genuinely NEW file — created after we started watching — still processes from
 * offset 0 immediately, which is both correct and what makes a new session's
 * first lines visible.
 *
 * Degrades safely: where birthtime is unavailable it reads 0, the guard declines,
 * and behaviour is exactly what it was before.
 */
function isUnseededPreexistingFile(stat: fs.Stats): boolean {
	if (seedComplete || watcherStartedAtMs === 0) return false;
	return stat.birthtimeMs > 0 && stat.birthtimeMs < watcherStartedAtMs;
}

/**
 * Async recursive walk of a logs dir, invoking `onFile` for each `.jsonl`
 * and yielding to the event loop every SEED_SCAN_YIELD_EVERY files so even a
 * huge tree never blocks the main thread. `onFile` may be async (awaited).
 */
async function walkJsonlAsync(
	logsDir: string,
	onFile: (full: string) => void | Promise<void>,
	run: number,
): Promise<void> {
	const stack: string[] = [logsDir];
	const failures: unknown[] = [];
	let n = 0;
	while (isCurrent(run) && stack.length > 0) {
		const dir = stack.pop();
		if (dir === undefined) break;
		let entries: fs.Dirent[];
		try {
			entries = await fs.promises.readdir(dir, { withFileTypes: true });
		} catch (error) {
			if (!isCurrent(run)) return;
			if (!isFileMissing(error)) failures.push(error);
			continue;
		}
		for (const entry of entries) {
			if (!isCurrent(run)) return;
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				stack.push(full);
			} else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
				try {
					await onFile(full);
				} catch (error) {
					if (!isCurrent(run)) return;
					failures.push(error);
				}
				n += 1;
				if (n % SEED_SCAN_YIELD_EVERY === 0) {
					await yieldToLoop();
				}
			}
		}
	}
	if (isCurrent(run) && failures.length)
		throw new AggregateError(failures, "Transcript scan failed");
}

function cwdForSession(sessionId: string): string | null {
	for (const st of fileStates.values()) {
		if (st.sessionId === sessionId && st.cwd) return st.cwd;
	}
	return null;
}

function isSubagentFile(filePath: string): boolean {
	// Claude names every subagent transcript `agent-<hex>.jsonl` (Task tool
	// subagents AND workflow/TeamCreate subagents). Used so the first-seen
	// history-skip always runs for a subagent even when its parent session id
	// can't be derived — never full-read a subagent body on the main thread.
	return path.basename(filePath).startsWith("agent-");
}

function getSubagentParentSessionId(filePath: string): string | null {
	// Claude background-subagent transcripts live UNDER a `subagents` dir:
	//   <cwd>/<parentSessionId>/subagents/agent-*.jsonl                (Task)
	//   <cwd>/<parentSessionId>/subagents/workflows/wf_*/agent-*.jsonl (workflow/TeamCreate)
	// So find the LAST `subagents` segment and take the nearest UUID-shaped
	// segment ABOVE it as the parent — handles both depths. Returns null for
	// normal transcripts (no `subagents` ancestor).
	const parts = path.dirname(filePath).split(/[\\/]/);
	const idx = parts.lastIndexOf("subagents");
	if (idx <= 0) return null;
	for (let i = idx - 1; i >= 0; i--) {
		if (UUID_RE.test(parts[i])) return parts[i];
	}
	return null;
}

/**
 * Keep the PARENT terminal yellow while a background subagent is working.
 * Subagent transcripts have no pane mapping and never drive their own dot.
 * The Claude parent dot is owned by the host-service POST hook, which this
 * watcher cannot observe, so each activity chunk FORCE-asserts working
 * (emit directly, bypassing transitionTo's same-status dedup) to override a
 * POST Stop that may have greened the dot while a subagent is still running.
 * NO timer and we NEVER green from here: the parent greens again only on the
 * main agent's next host-service POST Stop (it may linger yellow until then —
 * the safe direction). Leaves a watcher-known pending question (red) untouched.
 */
async function mirrorSubagentToParent(
	parentSessionId: string,
	lines: string[],
	parser: AgentParser,
	filePath: string,
	state: FileState,
	run: number,
): Promise<void> {
	let active = false;
	for (let i = 0; i < lines.length; i++) {
		if (atYieldBoundary(i) && !(await yieldAndOwns(filePath, state, run)))
			return;
		const line = lines[i];
		if (line && parser.isActivity(line)) {
			// (WATCHER-ASYNC-IO)
			if (state.preStartFenceMs !== null) {
				const record = parseTranscriptRecord(line);
				if (record && recordPredatesFence(record, state.preStartFenceMs))
					continue;
			}
			active = true;
			break;
		}
	}
	if (!active) return;
	const cwd = cwdForSession(parentSessionId);
	if (!cwd) return; // parent not tracked yet — nothing to keep alive
	const { key, state: s } = getState(parentSessionId, cwd);
	if (s.lastStatus === "permission") return; // best-effort: don't stomp a watcher-known red
	// The Claude parent dot is owned by the host-service POST hook; this watcher
	// CANNOT observe POST-driven greens, so we must NOT dedup on our own stale
	// lastStatus. FORCE-assert working on every subagent-activity chunk (calling
	// emit directly, bypassing transitionTo's same-status suppression) so a POST
	// Stop that greened the dot while a background subagent is still running is
	// overridden back to yellow. We NEVER green from here — the parent greens on
	// the main agent's next POST Stop (it may linger yellow until the next turn;
	// the safe direction, and never a timer).
	const mapping = await loadPaneMapping(parentSessionId, run);
	if (
		!ownsFile(filePath, state, run) ||
		lifecycleStates.get(key)?.lastStatus === "permission"
	)
		return;
	s.lastStatus = "working";
	s.lastEmittedHadMapping = !!(mapping?.paneId || mapping?.terminalId);
	dbg("subagent-activity", { parentSessionId, cwd });
	emit("SubagentActive", parentSessionId, cwd, mapping);
}

// (WATCHER-ASYNC-IO)
async function readHeader(
	filePath: string,
	size: number,
	run: number,
): Promise<string> {
	const fh = await fs.promises.open(filePath, "r");
	try {
		const buf = Buffer.allocUnsafe(Math.min(8192, size));
		let offset = 0;
		while (isCurrent(run) && offset < buf.length) {
			const { bytesRead } = await fh.read(
				buf,
				offset,
				buf.length - offset,
				offset,
			);
			if (!isCurrent(run)) return "";
			if (bytesRead === 0) break;
			offset += bytesRead;
		}
		return buf.toString("utf8", 0, offset);
	} finally {
		await fh.close();
	}
}

/**
 * Seed a first-seen file: cache its cwd from the 8 KB header (Codex stamps cwd
 * only in the first session_meta entry), then tail from EOF so the history is
 * never replayed. Files an earlier pass already tracks are left alone.
 */
async function seedFileAsync(
	filePath: string,
	source: AgentSource,
): Promise<void> {
	if (fileStates.get(filePath)?.initialized) return;
	await processFile(filePath, source, true);
}

async function walkAllSources(
	run: number,
	errorMessage: string,
	onFile: (filePath: string, source: AgentSource) => Promise<void>,
): Promise<void> {
	const failures: unknown[] = [];
	for (const source of SOURCES) {
		if (!isCurrent(run)) return;
		try {
			await walkJsonlAsync(source.logsDir, (full) => onFile(full, source), run);
		} catch (error) {
			if (!isCurrent(run)) return;
			if (error instanceof AggregateError) failures.push(...error.errors);
			else failures.push(error);
		}
	}
	if (failures.length) throw new AggregateError(failures, errorMessage);
}

function runSeedScan(run: number): void {
	if (!isCurrent(run)) return;
	void walkAllSources(run, "Transcript seed failed", seedFileAsync)
		.then(() => {
			if (!isCurrent(run)) return;
			seedComplete = true;
			pollDiscoverTimer = setInterval(() => {
				if (isCurrent(run))
					void discoverNewFilesAsync().catch(reportWatcherError);
			}, POLL_DISCOVER_MS);
		})
		.catch((error) => {
			if (!isCurrent(run)) return;
			reportWatcherError(error);
			seedRetryTimer = setTimeout(() => {
				if (!isCurrent(run)) return;
				seedRetryTimer = null;
				runSeedScan(run);
			}, POLL_KNOWN_MS);
		});
}

/**
 * Discover poll body. Picks up files created after the seed (whose fs.watch
 * create event Windows dropped) and reads their bodies to derive the new
 * session's current state. Runs ONLY after the seed completes — by then
 * every pre-existing file is already tracked, so the in-memory
 * `fileStates.has()` check skips the entire history with no I/O and only
 * genuinely-new (small, recent) files are read. The walk is async so even
 * the directory traversal never blocks the main thread.
 */
async function discoverNewFilesAsync(): Promise<void> {
	if (!deps || !seedComplete || discoverInFlight) return;
	const run = generation;
	discoverInFlight = true;
	try {
		await walkAllSources(
			run,
			"Transcript discovery failed",
			async (full, source) => {
				if (!fileStates.has(full)) await processFile(full, source, false);
			},
		);
	} finally {
		if (isCurrent(run)) discoverInFlight = false;
	}
}

/**
 * Start watching ~/.claude/projects/ and ~/.codex/sessions/ for JSONL
 * session updates and forward derived agent lifecycle events into
 * notificationsEmitter.
 */
export function startAgentJsonlWatcher(d: WatcherDeps): void {
	stopAgentJsonlWatcher();
	const run = generation;
	deps = d;
	watcherStartedAtMs = Date.now();

	// Side-channel: write the SessionStart hook that maps each new agent
	// session id → Superset pane identity. Without this, the watcher can
	// only resolve panes by cwd, which is ambiguous when two terminals
	// in the same workspace cwd are running concurrent sessions.
	(d.installPaneMapHook ?? installPaneMapHook)();

	// (WATCHER-ASYNC-IO)
	for (const source of SOURCES) {
		void (async () => {
			await fs.promises.mkdir(source.logsDir, { recursive: true });
			if (!isCurrent(run)) return;
			const w = fs.watch(
				source.logsDir,
				{ recursive: true },
				(_eventType, filename) => {
					if (!isCurrent(run)) return;
					// Steady-state: process only the changed .jsonl file. A
					// full recursive scan over every Codex year/month/day
					// archive on each append would block the main process
					// on large session histories.
					if (filename && typeof filename === "string") {
						if (!filename.endsWith(".jsonl")) return;
						schedulePerFileProcess(path.join(source.logsDir, filename), source);
						return;
					}
					// Fallback when the platform didn't give us a filename:
					// debounced async discovery (gated on seed completion, so it
					// never replays the existing history).
					if (scanTimer) return;
					scanTimer = setTimeout(() => {
						if (!isCurrent(run)) return;
						scanTimer = null;
						void discoverNewFilesAsync().catch(reportWatcherError);
					}, POLL_DEBOUNCE_MS);
				},
			);
			w.on("error", (error) => {
				if (isCurrent(run)) reportWatcherError(error);
			});
			watchers.set(source.logsDir, w);
		})().catch((error) => {
			if (isCurrent(run)) reportWatcherError(error);
		});
	}

	// (AN) pollKnown re-stats only ALREADY-tracked files and reads their
	// (small) growth delta, so it is safe to run from t=0 and preserves the
	// (AK) trailing-append safety net for any session the user starts at once.
	pollKnownTimer = setInterval(() => {
		if (isCurrent(run))
			void pollKnownFilesForGrowth().catch(reportWatcherError);
	}, POLL_KNOWN_MS);

	// (AN) Seed deferred + fully async so it never blocks window startup, and
	// the discover poll is started ONLY after the seed has tailed every
	// existing file to EOF. Otherwise the discover poll races the seed and
	// synchronously replays the entire multi-GB history (the real cause of the
	// multi-minute blank-window cold start). Once seeded, pollDiscover only
	// ever sees genuinely-new files.
	setImmediate(() => runSeedScan(run));
}

export function stopAgentJsonlWatcher(): void {
	// (WATCHER-ASYNC-IO)
	generation += 1;
	for (const cancel of readPool.waiting.splice(0)) cancel(false);
	readPool = { active: 0, waiting: [] };
	pollInFlight = null;
	if (seedRetryTimer) clearTimeout(seedRetryTimer);
	seedRetryTimer = null;
	mappingCache.clear();
	for (const w of watchers.values()) w.close();
	watchers.clear();
	if (scanTimer) {
		clearTimeout(scanTimer);
		scanTimer = null;
	}
	if (pollKnownTimer) {
		clearInterval(pollKnownTimer);
		pollKnownTimer = null;
	}
	if (pollDiscoverTimer) {
		clearInterval(pollDiscoverTimer);
		pollDiscoverTimer = null;
	}
	for (const { timer } of pendingFiles.values()) clearTimeout(timer);
	pendingFiles.clear();
	for (const s of lifecycleStates.values()) cancelIdleTimer(s);
	lifecycleStates.clear();
	fileStates.clear();
	// (WATCHER-BLUE-STOMP) Reset with the rest of the watcher state. Safe: a
	// restart re-seeds every existing transcript to EOF, so no history is replayed
	// through the empty uuid layer, and anything that does get re-read afterwards
	// is old enough for the age layer to catch.
	resetTurnEndGate();
	// (AN) Reset the seed gate so a stop -> start cycle re-seeds before the
	// discover poll runs again (fileStates was just cleared; a stale
	// seedComplete would let discover replay the whole history).
	seedComplete = false;
	watcherStartedAtMs = 0;
	discoverInFlight = false;
	deps = null;
}

// (WATCHER-ASYNC-IO)
export const agentJsonlWatcherTesting = {
	processFile,
	scheduleIdleTimer,
	seedFileAsync,
	pollKnownFilesForGrowth,
	discoverNewFilesAsync,
	loadPaneMapping,
	fileStates,
	mappingCache,
	sources: SOURCES,
	get seedComplete() {
		return seedComplete;
	},
	get discoverTimerArmed() {
		return pollDiscoverTimer !== null;
	},
};
