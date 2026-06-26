import type EventEmitter from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NOTIFICATION_EVENTS } from "shared/constants";
import type { AgentLifecycleEvent } from "shared/notification-types";
import { installPaneMapHook } from "./pane-map-hook";

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

// Diagnostic log. Set SUPERSET_AGENT_WATCHER_DEBUG=0 to disable. Logs
// every line classification, state transition, and emit (with mapping)
// so the user can share the file when debugging "wrong-colour-dot"
// issues. Auto-rotates when the file exceeds ~2 MB.
const DEBUG_LOG_PATH = path.join(
	os.homedir(),
	".superset",
	"agent-watcher-debug.log",
);
const DEBUG_MAX_BYTES = 2 * 1024 * 1024;
const DEBUG_ENABLED = process.env.SUPERSET_AGENT_WATCHER_DEBUG !== "0";
function dbg(kind: string, fields: Record<string, unknown>): void {
	if (!DEBUG_ENABLED) return;
	try {
		try {
			const st = fs.statSync(DEBUG_LOG_PATH);
			if (st.size > DEBUG_MAX_BYTES) {
				fs.renameSync(DEBUG_LOG_PATH, DEBUG_LOG_PATH + ".prev");
			}
		} catch {}
		const line = `${new Date().toISOString()} ${kind} ${JSON.stringify(fields)}\n`;
		fs.appendFileSync(DEBUG_LOG_PATH, line, "utf8");
	} catch {
		// never let logging crash the watcher
	}
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
	leftover: string;
	cwd: string | null;
	sessionId: string | null;
	parser: AgentParser;
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
	notificationsEmitter: EventEmitter;
	// (AUTO-RESUME) Forwarded when a Claude main session appends an API-error record.
	// The auto-resume manager debounces + re-reads the transcript tail to confirm the
	// failure is genuinely turn-ending before classifying — so passing a possibly-
	// transient mid-turn error here is safe.
	onClaudeApiError?: (info: {
		sessionId: string;
		cwd: string;
		paneId?: string;
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
let deps: WatcherDeps | null = null;

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
function loadPaneMapping(sessionId: string): PaneMapping | undefined {
	const file = path.join(SUPERSET_PANE_MAP_DIR, `${sessionId}.json`);
	// Diagnostic-only state captured for the mapping_load dbg below. Never
	// changes the return value or control flow.
	let exists = false;
	let mtimeMs: number | null = null;
	let parseOk = false;
	let result: PaneMapping | undefined;
	try {
		try {
			const st = fs.statSync(file);
			exists = true;
			mtimeMs = st.mtimeMs;
		} catch {
			// missing or unstatable — leave diagnostic fields at defaults
		}
		const raw = fs.readFileSync(file, "utf8");
		const parsed = JSON.parse(raw);
		parseOk = true;
		if (typeof parsed !== "object" || parsed === null) {
			result = undefined;
		} else {
			result = {
				paneId: typeof parsed.paneId === "string" ? parsed.paneId : undefined,
				tabId: typeof parsed.tabId === "string" ? parsed.tabId : undefined,
				terminalId:
					typeof parsed.terminalId === "string" ? parsed.terminalId : undefined,
				workspaceId:
					typeof parsed.workspaceId === "string"
						? parsed.workspaceId
						: undefined,
			};
		}
	} catch {
		result = undefined;
	}
	const missingFields: string[] = [];
	if (!result?.paneId) missingFields.push("paneId");
	if (!result?.terminalId) missingFields.push("terminalId");
	if (!result?.workspaceId) missingFields.push("workspaceId");
	dbg("mapping_load", {
		sessionId,
		mappingPath: file,
		exists,
		mtimeMs,
		parseOk,
		mapping: result ?? null,
		missingFields,
	});
	return result;
}

const SUBAGENT_RUNNING_DIR = path.join(
	os.homedir(),
	".superset",
	"agent-subagent-running",
);

/**
 * (API-ABORT-RELEASE) Reap the run-dir subagent markers for a terminal when the
 * main Claude session's stream aborts. superset-notify.py creates one marker per
 * SubagentStart under agent-subagent-running/<terminalId>/ and removes it only on
 * SubagentStop; a stream-idle-timeout / API error ("API Error: Stream idle
 * timeout - partial response received", an isApiErrorMessage assistant line) ends
 * the turn and ORPHANS any in-flight subagent WITHOUT firing its SubagentStop, so
 * the marker leaks and the POST hook re-asserts yellow from it indefinitely. No
 * hook fires on the abort, so the POST hook can't self-heal — but the watcher
 * reads the transcript, so it reaps the orphaned per-subagent markers here. A
 * subagent that genuinely SURVIVES the abort is not under-held: mirrorSubagentToParent
 * re-asserts SubagentActive (yellow) on its NEXT transcript write, so it errs
 * green for one beat and self-heals back to yellow on the subagent's next
 * activity. Best-effort; never throws. The terminalId comes from the pane-map
 * JSON, so it's validated as a safe single path segment and the resolved dir is
 * confirmed to be a DIRECT CHILD of SUBAGENT_RUNNING_DIR before anything is
 * unlinked (path-injection guard). The sibling sentinel files
 * (<terminalId>.mainstopped/.agentbg/.bgactive…) live OUTSIDE this dir and are
 * cleared separately by the caller.
 */
function reapOrphanedSubagentMarkers(terminalId: string): number {
	if (!/^[A-Za-z0-9_-]+$/.test(terminalId)) return 0;
	const dir = path.join(SUBAGENT_RUNNING_DIR, terminalId);
	if (path.dirname(path.resolve(dir)) !== path.resolve(SUBAGENT_RUNNING_DIR))
		return 0;
	try {
		let reaped = 0;
		for (const name of fs.readdirSync(dir)) {
			try {
				fs.unlinkSync(path.join(dir, name));
				reaped += 1;
			} catch {}
		}
		return reaped;
	} catch {
		return 0;
	}
}

/**
 * (API-ABORT-RELEASE / FIX 7) A turn-killing API abort is StopFailure-equivalent:
 * also clear the sibling sentinel files in SUBAGENT_RUNNING_DIR so a zombie
 * background_tasks set can't immediately re-hold yellow via a fresh .bgactive.
 * These siblings live OUTSIDE the <terminalId>/ dir, so reapOrphanedSubagentMarkers'
 * child-of guard does not cover them — clean them explicitly. Best-effort; the
 * terminalId is validated the same way as the reap guard. Never throws.
 */
function clearAbortSiblingSentinels(terminalId: string): void {
	if (!/^[A-Za-z0-9_-]+$/.test(terminalId)) return;
	for (const suffix of [
		".agentbg",
		".bgactive",
		".shellbg",
		".mainstopped",
		".compacting",
	]) {
		try {
			fs.unlinkSync(path.join(SUBAGENT_RUNNING_DIR, terminalId + suffix));
		} catch {}
	}
}

function emit(
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
): void {
	const { key, state: s } = getState(sessionId, cwd);
	cancelIdleTimer(s);
	s.idleTimer = setTimeout(() => {
		const current = lifecycleStates.get(key);
		if (!current) return;
		current.idleTimer = null;
		// Only transition working → review on idle; if we ended on
		// permission, the agent is genuinely blocked waiting on the user
		// and the indicator should stay red.
		if (current.lastStatus === "working") {
			// Reload mapping — the Python SessionStart hook may have
			// written the mapping file between schedule and fire. Using
			// the closure's stale mapping would emit Stop with the wrong
			// (or missing) paneId.
			const freshMapping = sessionId ? loadPaneMapping(sessionId) : mapping;
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
	}, IDLE_TIMEOUT_MS);
}

function processFile(
	filePath: string,
	source: AgentSource,
	seedOnly: boolean,
): void {
	let state = fileStates.get(filePath);
	const isFirstSeen = !state;
	if (!state) {
		state = {
			offset: 0,
			leftover: "",
			cwd: null,
			sessionId: extractSessionIdFromFilename(filePath),
			parser: source.parser,
		};
		fileStates.set(filePath, state);
	}
	if (isFirstSeen)
		dbg("file-first-seen", { filePath, sessionId: state.sessionId, seedOnly });

	let stat: fs.Stats;
	try {
		stat = fs.statSync(filePath);
	} catch {
		return;
	}

	// Background-subagent transcript (Task or workflow/TeamCreate)? It never
	// drives its own dot; its activity is mirrored to the parent terminal.
	const subagentParent = getSubagentParentSessionId(filePath);
	// First sight of ANY subagent file (detected by the agent-* name, even if
	// the parent session id can't be derived from a deeper-nested path): skip
	// history unconditionally. Only FUTURE activity matters, and a discover-
	// poll first-sight would otherwise read the whole file on the main thread
	// — the (AN) big-read trap, which workflow subagent files (hundreds, up to
	// ~600 KB each) would re-introduce.
	if (isFirstSeen && isSubagentFile(filePath)) {
		dbg("subagent-seed-skip", {
			filePath,
			parentSessionId: subagentParent,
			size: stat.size,
		});
		state.offset = stat.size;
		return;
	}

	// First time we've seen this file during a seed pass: skip its history
	// (the user already saw those state transitions) and start tailing from
	// the current end-of-file. Before jumping, read enough of the header to
	// cache cwd — for Codex the cwd lives only in the first session_meta
	// entry, so we'd otherwise never see it once we'd skipped past.
	if (isFirstSeen && seedOnly) {
		try {
			const headerBytes = Math.min(8192, stat.size);
			if (headerBytes > 0) {
				const fd = fs.openSync(filePath, "r");
				const buf = Buffer.allocUnsafe(headerBytes);
				fs.readSync(fd, buf, 0, headerBytes, 0);
				fs.closeSync(fd);
				for (const line of buf.toString("utf8").split("\n")) {
					const cwd = extractCwd(line);
					if (cwd) {
						state.cwd = cwd;
						break;
					}
				}
			}
		} catch {
			// Header read is best-effort; the regular processing path will
			// retry cwd discovery on the next append.
		}
		dbg("seed-skip", {
			filePath,
			sessionId: state.sessionId,
			size: stat.size,
			cwdFound: !!state.cwd,
		});
		state.offset = stat.size;
		return;
	}

	// Truncation/rotation: reset offset and re-read from the start. Fall
	// through (don't return early) so replacement content isn't skipped
	// until the next append.
	// (FIX 6) Record that this pass is a from-offset-0 re-read of the whole
	// transcript: the Claude api-abort line is permanent, so re-reading from 0
	// would re-fire the DESTRUCTIVE marker reap against LIVE markers from later
	// turns. The Claude block skips ONLY the reap in that case (the benign emit
	// Stop still runs).
	let truncatedReset = false;
	if (stat.size < state.offset) {
		dbg("file-truncated", {
			filePath,
			sessionId: state.sessionId,
			oldOffset: state.offset,
			newSize: stat.size,
		});
		state.offset = 0;
		state.leftover = "";
		truncatedReset = true;
	}
	if (stat.size === state.offset) return;

	const newOffset = stat.size;
	let chunk: string;
	try {
		const fd = fs.openSync(filePath, "r");
		const buf = Buffer.allocUnsafe(newOffset - state.offset);
		fs.readSync(fd, buf, 0, buf.length, state.offset);
		fs.closeSync(fd);
		chunk = state.leftover + buf.toString("utf8");
	} catch {
		return;
	}

	const allLines = chunk.split("\n");
	const newLeftover = allLines.pop() ?? "";
	const lines = allLines;

	// Subagent transcript: mirror activity to the parent terminal (so it shows
	// yellow while the subagent runs) and stop here — these files carry no cwd
	// of their own, so they must bypass the own-cwd gate below.
	if (subagentParent) {
		state.offset = newOffset;
		state.leftover = newLeftover;
		mirrorSubagentToParent(subagentParent, lines, state.parser);
		return;
	}

	// Discover cwd from any line in this chunk. If no chunk line carries
	// cwd, leave state.offset / state.leftover untouched so the same bytes
	// are re-read on the next chunk — losing complete lines here would
	// silently drop activity transitions. ~75% of entries include cwd in
	// practice so this path is only exercised on metadata-only initial
	// chunks.
	if (!state.cwd) {
		for (const line of lines) {
			const cwd = extractCwd(line);
			if (cwd) {
				state.cwd = cwd;
				break;
			}
		}
		if (!state.cwd) {
			dbg("cwd-unknown-skip", {
				filePath,
				sessionId: state.sessionId,
				lineCount: lines.length,
			});
			return;
		}
	}

	const prevOffset = state.offset;
	state.offset = newOffset;
	state.leftover = newLeftover;
	const cwd = state.cwd;
	const mapping = state.sessionId
		? loadPaneMapping(state.sessionId)
		: undefined;
	const { parser } = state;

	// Claude dots are driven by the host-service POST hook (superset-notify.py);
	// System 1 only mirrors background-subagent activity for Claude (handled
	// above in the subagent branch of processFile). The JSONL lifecycle state
	// machine below is therefore Codex-only — gated here at the single
	// dispatch chokepoint so Claude main-agent lines never emit (which caused
	// the live "stuck working" split-brain against the POST hook). The banned
	// timing fallbacks (idle tool-tracking, ask tool_use_id release, ESC/user-
	// line handling, generation-gap defer) were removed entirely with this gate.
	if (parser.id === "claude") {
		// Claude main-agent lifecycle is owned by the host-service POST hook
		// (superset-notify.py). The ONLY thing the watcher still does for a Claude
		// main line is clear a stuck RED on a user interrupt/ESC (Claude Code fires
		// NO hook on interrupt, so the POST hook cannot release an AskUserQuestion
		// red) and self-heal an API-abort that orphaned in-flight subagent markers.
		// Event-driven, no timer. (Use state.sessionId — the block-scoped
		// `const { sessionId }` below is in the temporal dead zone here.)
		//
		// (FIX 6) Scan the WHOLE chunk once recording which signals appeared,
		// rather than break-ing on the first: an interrupt line BEFORE an api-abort
		// line in the same chunk must still trigger the abort reap. After the loop,
		// the destructive reap fires once for an api-abort — but NOT on a post-
		// truncation full re-read (truncatedReset), where the permanent api-error
		// line would re-reap LIVE markers from later turns.
		let sawInterrupt = false;
		let sawApiAbort = false;
		let sawAnyApiError = false;
		for (const line of lines) {
			if (!line) continue;
			if (
				line.includes('"type":"user"') &&
				(line.includes("Request interrupted by user") ||
					line.includes("Request cancelled by user"))
			) {
				sawInterrupt = true;
			}
			// (AUTO-RESUME) ANY api-error line (not just the half-stop signature) is a
			// candidate for auto-resume; the manager confirms turn-finality itself.
			if (line.includes('"isApiErrorMessage":true')) {
				sawAnyApiError = true;
			}
			// (API-ABORT-RELEASE) a stream-idle-timeout / API error on the MAIN
			// session ("API Error: Stream idle timeout - partial response received",
			// written as an isApiErrorMessage assistant line) ends the turn and
			// orphans any in-flight subagent without firing its SubagentStop —
			// leaking its run-dir marker so the POST hook re-asserts yellow forever.
			// No hook fires on the abort, so only the watcher (which reads the
			// transcript) can self-heal it. (FIX 1) Require the turn-ENDING
			// signature too — a bare isApiErrorMessage also matches TRANSIENT API
			// errors (overloaded 529 etc.) that Claude AUTO-RETRIES within the same
			// turn, which must NOT reap markers or green mid-turn.
			if (
				line.includes('"isApiErrorMessage":true') &&
				(line.includes("Stream idle timeout") ||
					line.includes("partial response received"))
			) {
				sawApiAbort = true;
			}
		}
		if (sawApiAbort && !truncatedReset) {
			// Destructive self-heal: reap the orphaned per-subagent markers + the
			// sibling sentinels (FIX 7), then emit review. Skipped on a post-
			// truncation re-read so we never reap live markers from later turns.
			const terminalId = mapping?.terminalId;
			const reaped = terminalId ? reapOrphanedSubagentMarkers(terminalId) : 0;
			if (terminalId) clearAbortSiblingSentinels(terminalId);
			dbg("claude-api-abort-release", {
				sessionId: state.sessionId,
				terminalId: terminalId ?? null,
				reapedMarkers: reaped,
				clearedSiblings: !!terminalId,
				filePath,
			});
			emit("Stop", state.sessionId, cwd, mapping);
		} else if (sawApiAbort || sawInterrupt) {
			// Benign turn-end emit. Allowed even on a post-truncation re-read (it
			// only re-asserts review/green — no destructive marker reap).
			dbg(
				sawInterrupt ? "claude-interrupt-release" : "claude-api-abort-release",
				{
					sessionId: state.sessionId,
					terminalId: mapping?.terminalId ?? null,
					reapSkipped:
						sawApiAbort && truncatedReset ? "truncation-reread" : null,
					filePath,
				},
			);
			emit("Stop", state.sessionId, cwd, mapping);
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
				paneId: mapping?.paneId,
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
	for (const line of lines) {
		if (!line) continue;
		if (parser.isPermissionRequest(line)) {
			dbg("line", {
				sessionId,
				kind: "permission",
				snippet: line.slice(0, 160),
			});
			const { state: s } = getState(sessionId, cwd);
			cancelIdleTimer(s);
			transitionTo("permission", sessionId, cwd, mapping);
		} else if (parser.isExplicitStop(line)) {
			dbg("line", {
				sessionId,
				kind: "explicit-stop",
				snippet: line.slice(0, 160),
			});
			const { state: s } = getState(sessionId, cwd);
			cancelIdleTimer(s);
			transitionTo("review", sessionId, cwd, mapping);
		} else if (parser.isActivity(line)) {
			dbg("line", { sessionId, kind: "activity", snippet: line.slice(0, 160) });
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
		newBytes: newOffset - prevOffset,
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
	const existing = pendingFiles.get(filePath);
	if (existing) clearTimeout(existing.timer);
	const timer = setTimeout(() => {
		pendingFiles.delete(filePath);
		processFile(filePath, source, false);
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
function pollKnownFilesForGrowth(): void {
	for (const [filePath, state] of fileStates) {
		let st: fs.Stats;
		try {
			st = fs.statSync(filePath);
		} catch {
			continue;
		}
		if (st.size > state.offset) {
			const source = sourceForParser(state.parser);
			if (source) {
				dbg("poll-grown", {
					filePath,
					sessionId: state.sessionId,
					delta: st.size - state.offset,
				});
				schedulePerFileProcess(filePath, source);
			}
		}
	}
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

// True once the initial seed has tailed every existing file to EOF. Until
// then the discover poll must not run — it would replay the full history.
let seedComplete = false;
// Prevents overlapping discover walks (a slow walk + the 12 s timer).
let discoverInFlight = false;

/**
 * Async recursive walk of a logs dir, invoking `onFile` for each `.jsonl`
 * and yielding to the event loop every SEED_SCAN_YIELD_EVERY files so even a
 * huge tree never blocks the main thread. `onFile` may be async (awaited).
 */
async function walkJsonlAsync(
	logsDir: string,
	onFile: (full: string) => void | Promise<void>,
): Promise<void> {
	const stack: string[] = [logsDir];
	let n = 0;
	while (stack.length > 0) {
		const dir = stack.pop();
		if (dir === undefined) break;
		let entries: fs.Dirent[];
		try {
			entries = await fs.promises.readdir(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				stack.push(full);
			} else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
				await onFile(full);
				n += 1;
				if (n % SEED_SCAN_YIELD_EVERY === 0) {
					await new Promise<void>((resolve) => {
						setImmediate(resolve);
					});
				}
			}
		}
	}
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
function mirrorSubagentToParent(
	parentSessionId: string,
	lines: string[],
	parser: AgentParser,
): void {
	let active = false;
	for (const line of lines) {
		if (line && parser.isActivity(line)) {
			active = true;
			break;
		}
	}
	if (!active) return;
	const cwd = cwdForSession(parentSessionId);
	if (!cwd) return; // parent not tracked yet — nothing to keep alive
	const { state: s } = getState(parentSessionId, cwd);
	if (s.lastStatus === "permission") return; // best-effort: don't stomp a watcher-known red
	// The Claude parent dot is owned by the host-service POST hook; this watcher
	// CANNOT observe POST-driven greens, so we must NOT dedup on our own stale
	// lastStatus. FORCE-assert working on every subagent-activity chunk (calling
	// emit directly, bypassing transitionTo's same-status suppression) so a POST
	// Stop that greened the dot while a background subagent is still running is
	// overridden back to yellow. We NEVER green from here — the parent greens on
	// the main agent's next POST Stop (it may linger yellow until the next turn;
	// the safe direction, and never a timer).
	const mapping = loadPaneMapping(parentSessionId);
	s.lastStatus = "working";
	s.lastEmittedHadMapping = !!(mapping?.paneId || mapping?.terminalId);
	dbg("subagent-activity", { parentSessionId, cwd });
	emit("SubagentActive", parentSessionId, cwd, mapping);
}

/**
 * Async, non-blocking equivalent of processFile(seedOnly=true) for a
 * first-seen file: stat + read only the 8 KB header (to cache cwd — Codex
 * stamps it only in the first session_meta entry) via fs.promises, then
 * start tailing from EOF so the file's history is never replayed. All I/O is
 * async, so the main thread is never blocked during the seed.
 */
async function seedFileAsync(
	filePath: string,
	source: AgentSource,
): Promise<void> {
	if (fileStates.has(filePath)) return;
	let stat: fs.Stats;
	try {
		stat = await fs.promises.stat(filePath);
	} catch {
		return;
	}
	const state: FileState = {
		offset: 0,
		leftover: "",
		cwd: null,
		sessionId: extractSessionIdFromFilename(filePath),
		parser: source.parser,
	};
	try {
		const headerBytes = Math.min(8192, stat.size);
		if (headerBytes > 0) {
			const fh = await fs.promises.open(filePath, "r");
			try {
				const buf = Buffer.allocUnsafe(headerBytes);
				await fh.read(buf, 0, headerBytes, 0);
				for (const line of buf.toString("utf8").split("\n")) {
					const cwd = extractCwd(line);
					if (cwd) {
						state.cwd = cwd;
						break;
					}
				}
			} finally {
				await fh.close();
			}
		}
	} catch {
		// Header read is best-effort; the steady-state path retries cwd.
	}
	state.offset = stat.size;
	fileStates.set(filePath, state);
	dbg("seed-skip", {
		filePath,
		sessionId: state.sessionId,
		size: stat.size,
		cwdFound: !!state.cwd,
	});
}

async function seedScanAllAsync(): Promise<void> {
	for (const source of SOURCES) {
		if (!fs.existsSync(source.logsDir)) {
			dbg("watch-start", { logsDir: source.logsDir, exists: false });
			continue;
		}
		let seeded = 0;
		await walkJsonlAsync(source.logsDir, async (full) => {
			await seedFileAsync(full, source);
			seeded += 1;
		});
		dbg("watch-start", { logsDir: source.logsDir, exists: true, seeded });
	}
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
	if (!seedComplete || discoverInFlight) return;
	discoverInFlight = true;
	try {
		for (const source of SOURCES) {
			if (!fs.existsSync(source.logsDir)) continue;
			await walkJsonlAsync(source.logsDir, (full) => {
				if (!fileStates.has(full)) processFile(full, source, false);
			});
		}
	} finally {
		discoverInFlight = false;
	}
}

/**
 * Start watching ~/.claude/projects/ and ~/.codex/sessions/ for JSONL
 * session updates and forward derived agent lifecycle events into
 * notificationsEmitter.
 */
export function startAgentJsonlWatcher(d: WatcherDeps): void {
	deps = d;

	// Side-channel: write the SessionStart hook that maps each new agent
	// session id → Superset pane identity. Without this, the watcher can
	// only resolve panes by cwd, which is ambiguous when two terminals
	// in the same workspace cwd are running concurrent sessions.
	installPaneMapHook();

	for (const source of SOURCES) {
		if (!fs.existsSync(source.logsDir)) {
			try {
				fs.mkdirSync(source.logsDir, { recursive: true });
			} catch {
				// Agent may not be installed; that's fine — source idles.
			}
		}
		try {
			const w = fs.watch(
				source.logsDir,
				{ recursive: true },
				(_eventType, filename) => {
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
						scanTimer = null;
						void discoverNewFilesAsync();
					}, POLL_DEBOUNCE_MS);
				},
			);
			watchers.set(source.logsDir, w);
		} catch (error) {
			dbg("watch-fail", { logsDir: source.logsDir, error: String(error) });
		}
	}

	// (AN) pollKnown re-stats only ALREADY-tracked files and reads their
	// (small) growth delta, so it is safe to run from t=0 and preserves the
	// (AK) trailing-append safety net for any session the user starts at once.
	pollKnownTimer = setInterval(pollKnownFilesForGrowth, POLL_KNOWN_MS);

	// (AN) Seed deferred + fully async so it never blocks window startup, and
	// the discover poll is started ONLY after the seed has tailed every
	// existing file to EOF. Otherwise the discover poll races the seed and
	// synchronously replays the entire multi-GB history (the real cause of the
	// multi-minute blank-window cold start). Once seeded, pollDiscover only
	// ever sees genuinely-new files.
	setImmediate(() => {
		void seedScanAllAsync().finally(() => {
			seedComplete = true;
			pollDiscoverTimer = setInterval(() => {
				void discoverNewFilesAsync();
			}, POLL_DISCOVER_MS);
		});
	});
}

export function stopAgentJsonlWatcher(): void {
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
	// (AN) Reset the seed gate so a stop -> start cycle re-seeds before the
	// discover poll runs again (fileStates was just cleared; a stale
	// seedComplete would let discover replay the whole history).
	seedComplete = false;
	discoverInFlight = false;
	deps = null;
}
