import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
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
 */
export interface AgentStatusSnapshot {
	rows: AgentStatusSnapshotRow[];
	knownTerminalIds: string[];
}

/**
 * (ASKQ-MARKER-READ) The same path segment guard the marker writers and the
 * companion reader apply before building a marker path — an id that fails it
 * could otherwise become a traversal.
 */
const SAFE_MARKER_SEGMENT = /^[A-Za-z0-9_-]+$/;

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
 * Async throughout: this runs inside a tRPC query on the host-service event
 * loop, never on the desktop main thread.
 */
async function hasPendingQuestionMarker(
	terminalId: string,
): Promise<boolean | null> {
	// An id we would never have written a marker for is definitively absent.
	if (!SAFE_MARKER_SEGMENT.test(terminalId)) return false;
	const dir = join(
		homedir(),
		".superset",
		"agent-subagent-running",
		`${terminalId}.askq`,
	);
	try {
		return (await readdir(dir)).length > 0;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		console.error(
			"[notifications] askq marker read FAILED — pending-question state unknown",
			{ terminalId, error },
		);
		return null;
	}
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
): Promise<AgentStatusSnapshot> {
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
				pendingPermission: await hasPendingQuestionMarker(binding.terminalId),
			};
			return row;
		}),
	);
	// One covering read of the primary key. DELIBERATELY unfiltered by status:
	// the question this answers is "has this host ever minted this terminal",
	// and an ended or disposing session is still a terminal the host owns and
	// may legitimately disown. Filtering by `active` here would reclassify every
	// finished terminal as a ghost and freeze its dots forever.
	const knownTerminalIds = db
		.select({ id: terminalSessions.id })
		.from(terminalSessions)
		.all()
		.map((session) => session.id);
	return {
		rows: rows.filter((row): row is AgentStatusSnapshotRow => row !== null),
		knownTerminalIds,
	};
}
