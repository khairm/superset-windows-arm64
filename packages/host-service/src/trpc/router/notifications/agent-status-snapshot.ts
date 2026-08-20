import { readdir, rmdir, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { inArray } from "drizzle-orm";
import type { HostDb } from "../../../db";
import { terminalSessions } from "../../../db/schema";
import { type AgentLifecycleEventType, mapEventType } from "../../../events";
import type {
	TerminalAgentId,
	TerminalAgentStore,
} from "../../../terminal-agents";

/**
 * (BUS-RESYNC) One terminal's durable agent status, as the host knows it.
 * `pendingPermission` is deliberately separate from `lastEventType`: the Python
 * notify hook rewrites red-clearing events to `SubagentActive` while a question
 * marker is present, so the binding's `lastEventType` alone LOSES the permission
 * truth — a terminal blocked on an AskUserQuestion commonly reads
 * `SubagentActive` here. The marker is the only durable record of the red.
 */
export interface AgentStatusSnapshotRow {
	terminalId: string;
	originWorkspaceId: string;
	agentId: TerminalAgentId;
	lastEventType: AgentLifecycleEventType;
	lastEventAt: number;
	/**
	 * `true`/`false` are answers; `null` means the marker directory could not be
	 * READ (see `hasPendingQuestionMarker`) and the renderer must leave the
	 * permission axis exactly as it found it.
	 */
	pendingPermission: boolean | null;
}

/**
 * (BUS-RESYNC) (GHOST-TERMINAL) What the host can say about its terminals.
 *
 * `rows` is what it knows is LIVE. `knownTerminalIds` is every terminal id it
 * has a `terminal_sessions` row for AT ALL, whatever the status — the
 * difference between the two is the only thing that licenses the renderer to
 * clear a dot. A pane can hold a re-minted terminalId the host has never seen
 * (live case: pane terminal fc7ffd00 in workspace f85bc39c — every
 * `notifications.hook` POST for it returned `ignored: true`, and its only dot
 * came from the desktop's Electron fallback painting the store locally). Such a
 * ghost is absent from `rows` for a reason that has nothing to do with its
 * agent finishing, so "absent" alone would destroy a legitimate dot on every
 * reconnect. Present in `knownTerminalIds` but not in `rows` = positively
 * disowned; absent from both = never known, hands off.
 *
 * `knownTerminalIds` is INTERSECTED with the caller's `candidateTerminalIds`
 * when it sends them, so "absent from both" keeps its meaning for every
 * terminal the caller asked about and answers nothing about the rest.
 */
export interface AgentStatusSnapshot {
	rows: AgentStatusSnapshotRow[];
	knownTerminalIds: string[];
	/**
	 * (BUS-RESYNC) This host's wall clock when the snapshot was built, so the
	 * renderer can express its OWN session start in the clock that stamped
	 * `lastEventAt`. Every timestamp in `rows` is host-clock; the renderer's
	 * cold-start seed boundary is renderer-clock, and comparing the two across a
	 * relay (or a laptop that resumed with a corrected clock) misdates the
	 * boundary by the skew in either direction. Elapsed time measured inside one
	 * process is skew-free, so the renderer anchors to its process start and
	 * translates: `hostNow - (rendererNow - rendererProcessStart)`.
	 *
	 * Captured BEFORE the marker reads below rather than after: an earlier
	 * `hostNow` yields an earlier boundary, and an earlier boundary seeds fewer
	 * rows away — erring toward showing a green the user may have already seen
	 * rather than swallowing one they have not.
	 */
	hostNow: number;
}

/**
 * (ASKQ-MARKER-READ) The same path segment guard the marker writers and the
 * companion reader apply before building a marker path — an id that fails it
 * could otherwise become a traversal.
 */
const SAFE_MARKER_SEGMENT = /^[A-Za-z0-9_-]+$/;

/**
 * (ASKQ-MARKER-READ) (MANUAL-DISMISS) The askq marker directory for a terminal,
 * or `null` when the id could not have produced one.
 *
 * The `SAFE_MARKER_SEGMENT` test lives INSIDE this function rather than at each
 * call site so that no caller can hold a path built from an unvalidated id.
 * The reader's mistake would be a wrong dot; `clearPendingQuestionMarkers`
 * UNLINKS what it finds here, so a traversal would delete arbitrary files.
 * Returning `null` makes "we never wrote a marker for this id" the only value
 * an unsafe id can produce, and every caller has to decide what to do with it.
 */
export function askqMarkerDir(terminalId: string): string | null {
	if (!SAFE_MARKER_SEGMENT.test(terminalId)) return null;
	return join(
		homedir(),
		".superset",
		"agent-subagent-running",
		`${terminalId}.askq`,
	);
}

/**
 * (MANUAL-DISMISS) What one terminal's manual dismissal actually did to disk.
 *
 * `removed` and `survivors` are owner FILE NAMES (`_main`, a sanitized subagent
 * id). A non-empty `survivors` is the load-bearing half: an owner file is on
 * disk after the sweep — because it postdates the click, because it could not be
 * read, or because it appeared while the sweep ran — so a question the user has
 * not seen is pending and the red must stay up.
 */
export interface ClearedQuestionMarkers {
	removed: string[];
	survivors: string[];
}

/**
 * (MANUAL-DISMISS) The one filesystem call this fence's verdict turns on,
 * injectable so its ENOENT / unknown-error branches and the create race below
 * can be driven deterministically. Production passes nothing and gets
 * `node:fs/promises`.
 */
export interface ClearMarkersDeps {
	stat(path: string): Promise<{ mtimeMs: number }>;
}

/**
 * (MANUAL-DISMISS) Remove the askq owners that existed when the user clicked
 * "Clear Status", and only those.
 *
 * Manual dismissal is the one action licensed to drop a red the snapshot would
 * otherwise re-assert forever (`(LEAKED-ASKQ-OWNER)` explains why nothing
 * host-side can prove a leak, so the user is the evidence). But the click is not
 * licensed to drop a question the agent raised in the meantime, and the window
 * is real: the tRPC round trip plus the readdir is long enough for a hook to
 * land. `dismissStartedAtMs` is captured by the CALLER before any deletion and
 * fences every owner individually — the Python hook writes the owner file
 * synchronously before it returns the `PermissionRequest`, so an owner whose
 * mtime is not OLDER than the click is proof of a question the user has not
 * seen. The comparison is strict in one direction only: an owner written in the
 * SAME millisecond as the click cannot be shown to predate it, so it survives
 * (`mtimeMs >= dismissStartedAtMs`) and only a provably older owner is deleted.
 *
 * THE LISTING IS READ TWICE, and the second read is not a nicety. The fence can
 * judge only what the first `readdir` returned, while the stat/unlink loop is
 * awaited — long enough for a hook to create an owner the loop never sees. The
 * final re-`readdir` is therefore the authority on `survivors`: ANYTHING still
 * present when the loop ends is a survivor, whether it was created during the
 * loop or recreated after its unlink, because "there is an owner file on disk
 * right now" is exactly what the next snapshot read finds and re-asserts a red
 * for. Without it `pendingAfter: false` is a claim about a listing that is
 * already out of date.
 *
 * Failure directions, all chosen to keep a red rather than invent a dismissal:
 *
 *  - an id that fails the path guard removes NOTHING (we never wrote for it, and
 *    a path built from it would be a traversal);
 *  - `ENOENT` on the directory is a successful no-op — the markers are already
 *    gone, which is exactly the state the caller asked for;
 *  - any OTHER readdir error THROWS, on both reads. An unreadable filesystem is
 *    not a successful dismissal, and reporting one would leave the renderer
 *    clearing a dot that the next resync re-asserts;
 *  - `ENOENT` from a `stat` counts the owner as REMOVED. It is the one stat
 *    failure that is positive evidence — the file provably no longer exists
 *    (answered or reaped mid-operation), which is the very end state this
 *    function exists to reach — and reporting it as a survivor invented a
 *    `pendingAfter: true` for a marker nothing can read back;
 *  - any OTHER `stat` failure leaves the owner in place and reports it as a
 *    survivor. Unknown is not evidence, the same direction the reader takes at
 *    `findOwnersOlderThanSession`.
 *
 * Owners are unlinked one at a time (never a recursive directory remove) and the
 * directory itself is dropped only when the final read finds it empty, so a
 * surviving owner keeps both its file and the directory the next reader looks
 * in.
 */
export async function clearPendingQuestionMarkers(
	terminalId: string,
	dismissStartedAtMs: number,
	deps: ClearMarkersDeps = { stat },
): Promise<ClearedQuestionMarkers> {
	const dir = askqMarkerDir(terminalId);
	if (dir === null) {
		console.warn(
			"[notifications] refusing to clear askq markers for an unsafe terminal id",
			{ terminalId },
		);
		return { removed: [], survivors: [] };
	}

	let owners: string[];
	try {
		owners = await readdir(dir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { removed: [], survivors: [] };
		}
		throw error;
	}

	const removed: string[] = [];
	const survivors: string[] = [];
	for (const owner of owners) {
		const path = join(dir, owner);
		/** `null` = the file provably no longer exists, so there is no age to judge. */
		let mtimeMs: number | null;
		try {
			mtimeMs = (await deps.stat(path)).mtimeMs;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				// Unknown age: not evidence the user has seen it. Keep the red.
				console.warn(
					"[notifications] askq owner could not be stat'd during dismissal — keeping it",
					{ terminalId, owner, error },
				);
				survivors.push(owner);
				continue;
			}
			// Answered or reaped between the readdir and here: gone is the end state
			// this function is asking for, so it counts as removed rather than as an
			// invented pending question.
			mtimeMs = null;
		}
		if (mtimeMs !== null && mtimeMs >= dismissStartedAtMs) {
			// Not provably older than the click. The user has not seen this question.
			survivors.push(owner);
			continue;
		}
		try {
			await unlink(path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			// Answered or reaped between the stat and here — the dismissal's
			// intended end state, reached by somebody else.
		}
		removed.push(owner);
	}

	// The authority on what is pending NOW. Everything above judged one listing
	// taken before an awaited loop; an owner created during that loop is invisible
	// to it, and reporting `survivors` from it alone tells the renderer to clear a
	// dot that a marker on disk re-asserts on the next resync.
	let remaining: string[];
	try {
		remaining = await readdir(dir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		// Somebody removed the whole directory under us. Nothing is pending.
		remaining = [];
	}
	for (const owner of remaining) {
		if (!survivors.includes(owner)) survivors.push(owner);
	}

	if (remaining.length === 0) {
		// Best effort, and deliberately never fatal: the directory is a container,
		// not the truth. An empty one reads as "no question" either way, and a
		// racing hook may legitimately have just recreated an owner inside it.
		await rmdir(dir).catch(() => {});
	}

	return { removed, survivors };
}

/**
 * (ASKQ-MARKER-READ) Is a question currently pending on this terminal? True
 * when `~/.superset/agent-subagent-running/<terminalId>.askq/` holds at least
 * one owner file (`_main` for a main-loop question, a sanitized subagent id
 * otherwise — the companion's `askqMarkerExists` reads the same directory one
 * owner at a time; the resync cares only that SOMEONE is asking).
 *
 * DELIBERATELY un-aged. `_MARKER_STALE_SECONDS` (12h) in the Python hook
 * governs RUN-DIR markers, whose mtime is refreshed by every PostToolUse; an
 * askq owner is touched once at creation and removed only by an answer, an
 * exact SubagentStop, a turn boundary or SessionEnd, and the hook's reaper
 * explicitly refuses to age it out (pane-map-hook.ts `_reap_stale_markers`)
 * because a legitimately blocked agent produces no tool activity at all.
 * Capping by mtime here would therefore replay a question left pending
 * overnight as plain yellow — the exact swallowed red this snapshot exists to
 * restore.
 *
 * Returns `null` when the directory exists but cannot be read: an unknown
 * filesystem is not evidence of "no question", and reporting `false` there
 * would silently downgrade every pending red on the host.
 *
 * (LEAKED-ASKQ-OWNER) A leaked owner — the hook process killed between writing
 * the marker and the answer, a Claude session SIGKILLed with no SessionEnd —
 * re-asserts red on every reconnect for as long as the terminal lives. There is
 * deliberately NO reap here, because nothing host-side can prove a leak:
 *
 *  - the owner files are EMPTY, and their names are `_main` or a sanitized
 *    subagent id, so they carry no session identity to match `agentSessionId`
 *    against;
 *  - binding liveness is already enforced upstream (`store.list()` is the
 *    liveness-joined read), so a marker for a dead terminal never reaches here;
 *  - mtime-vs-`binding.startedAt` looks like a session-boundary fence, but the
 *    ONLY way a marker survives into a new session is the SessionStart hook not
 *    running (it calls `_clear_dir` on the askq dir). In that same scenario the
 *    binding's `startedAt` is pinned by whichever later event did post — which
 *    can be AFTER a genuinely-open question was marked — so the fence would
 *    drop live reds in exactly the case it was meant to clean up.
 *
 * So the ambiguity is LOGGED and the red is kept: a stale red is a question the
 * user dismisses, a dropped red is an agent blocked forever with a green dot.
 * The hook clears the directory on the next SessionStart, abort or SessionEnd.
 *
 * Async throughout: this runs inside a tRPC query on the host-service event
 * loop, never on the desktop main thread.
 */
async function hasPendingQuestionMarker(
	terminalId: string,
	sessionStartedAt: number,
): Promise<boolean | null> {
	// An id we would never have written a marker for is definitively absent.
	const dir = askqMarkerDir(terminalId);
	if (dir === null) return false;
	let owners: string[];
	try {
		owners = await readdir(dir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		console.error(
			"[notifications] askq marker read FAILED — pending-question state unknown",
			{ terminalId, error },
		);
		return null;
	}
	if (owners.length === 0) return false;

	// (LEAKED-ASKQ-OWNER) Diagnostic only — never a reap. See the note above for
	// why an owner older than the binding's session start is suspicious but not
	// provably dead.
	const suspect = await findOwnersOlderThanSession(
		dir,
		owners,
		sessionStartedAt,
	);
	if (suspect.length > 0) {
		console.warn(
			"[notifications] askq owner(s) predate this terminal's agent session — a LEAKED marker would pin red forever; keeping the red (see LEAKED-ASKQ-OWNER)",
			{ terminalId, sessionStartedAt, owners: suspect },
		);
	}
	return true;
}

/**
 * (LEAKED-ASKQ-OWNER) Owner files whose mtime predates the binding's session
 * start, described for the log. A failed stat is reported as unknown rather
 * than suspicious — an unreadable marker is not evidence of anything.
 */
async function findOwnersOlderThanSession(
	dir: string,
	owners: string[],
	sessionStartedAt: number,
): Promise<string[]> {
	const suspect: string[] = [];
	for (const owner of owners) {
		try {
			const stats = await stat(join(dir, owner));
			if (stats.mtimeMs < sessionStartedAt) {
				suspect.push(`${owner}@${Math.round(stats.mtimeMs)}`);
			}
		} catch {
			// Raced removal or an unreadable entry: says nothing either way.
		}
	}
	return suspect;
}

/**
 * (BUS-RESYNC) Every live terminal-agent binding plus its marker-derived
 * pending-question state, alongside every terminal id this host has a session
 * row for. Bindings come from the liveness-joined store read, so a terminal
 * that has exited is already unrepresentable; the renderer clears stale axes
 * only for terminals that are in `knownTerminalIds` and NOT in `rows` (see
 * `AgentStatusSnapshot`).
 */
export async function buildAgentStatusSnapshot(
	store: TerminalAgentStore,
	db: HostDb,
	candidateTerminalIds?: string[],
): Promise<AgentStatusSnapshot> {
	// Deliberately first: see `AgentStatusSnapshot.hostNow` for why the earliest
	// defensible reading is the conservative one.
	const hostNow = Date.now();
	const bindings = store.list();
	const rows = await Promise.all(
		bindings.map(async (binding) => {
			const lastEventType = mapEventType(binding.lastEventType);
			if (!lastEventType) {
				console.warn(
					"[notifications] agent status snapshot: unmappable lastEventType",
					{
						terminalId: binding.terminalId,
						lastEventType: binding.lastEventType,
					},
				);
				return null;
			}
			const row: AgentStatusSnapshotRow = {
				terminalId: binding.terminalId,
				originWorkspaceId: binding.workspaceId,
				agentId: binding.agentId,
				lastEventType,
				lastEventAt: binding.lastEventAt,
				pendingPermission: await hasPendingQuestionMarker(
					binding.terminalId,
					binding.startedAt,
				),
			};
			return row;
		}),
	);
	// DELIBERATELY unfiltered by status: the question this answers is "has this
	// host ever minted this terminal", and an ended or disposing session is
	// still a terminal the host owns and may legitimately disown. Filtering by
	// `active` here would reclassify every finished terminal as a ghost and
	// freeze its dots forever.
	//
	// Scoped to the caller's candidates when it supplies them. Rows are deleted
	// only when a workspace is destroyed, so the unscoped read grows without
	// bound and was shipped in full on every reconnect — while the only
	// question the renderer's sweep asks is "is THIS terminal known", over the
	// tens of terminals it holds state for. An absent input keeps the full list
	// for callers that have no candidate set.
	const knownTerminalIds = (
		candidateTerminalIds === undefined
			? db.select({ id: terminalSessions.id }).from(terminalSessions).all()
			: candidateTerminalIds.length === 0
				? []
				: db
						.select({ id: terminalSessions.id })
						.from(terminalSessions)
						.where(inArray(terminalSessions.id, candidateTerminalIds))
						.all()
	).map((session) => session.id);
	return {
		rows: rows.filter((row): row is AgentStatusSnapshotRow => row !== null),
		knownTerminalIds,
		hostNow,
	};
}
