import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
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
	pendingPermission: boolean;
}

/**
 * (ASKQ-MARKER-READ) The same path segment guard the marker writers and the
 * companion reader apply before building a marker path — an id that fails it
 * could otherwise become a traversal.
 */
const SAFE_MARKER_SEGMENT = /^[A-Za-z0-9_-]+$/;

/**
 * Mirrors `_MARKER_STALE_SECONDS` (12h) in the Python hook: a marker older than
 * this is treated as leaked, not pending. Without the cap, one marker the hook
 * failed to reap would re-assert a red dot on EVERY reconnect, forever. Erring
 * toward green is the direction the hook's own reaper documents.
 */
const ASKQ_MARKER_STALE_MS = 43_200_000;

/**
 * (ASKQ-MARKER-READ) Is a question currently pending on this terminal? True
 * when `~/.superset/agent-subagent-running/<terminalId>.askq/` holds at least
 * one non-stale owner file (`_main` for a main-loop question, a sanitized
 * subagent id otherwise — the companion's `askqMarkerExists` reads the same
 * directory one owner at a time; the resync cares only that SOMEONE is asking).
 *
 * Async throughout: this runs inside a tRPC query on the host-service event
 * loop, never on the desktop main thread.
 */
async function hasPendingQuestionMarker(terminalId: string): Promise<boolean> {
	if (!SAFE_MARKER_SEGMENT.test(terminalId)) return false;
	const dir = join(
		homedir(),
		".superset",
		"agent-subagent-running",
		`${terminalId}.askq`,
	);
	let owners: string[];
	try {
		owners = await readdir(dir);
	} catch {
		// No directory = no question. Any other read failure is indistinguishable
		// from that here and means the same thing for the caller: nothing to
		// assert. A genuinely unreadable home directory surfaces on every other
		// marker path too.
		return false;
	}
	const cutoff = Date.now() - ASKQ_MARKER_STALE_MS;
	for (const owner of owners) {
		try {
			const stats = await stat(join(dir, owner));
			if (stats.mtimeMs >= cutoff) return true;
		} catch {
			// Reaped between the readdir and the stat — not pending.
		}
	}
	return false;
}

/**
 * (BUS-RESYNC) Every live terminal-agent binding plus its marker-derived
 * pending-question state. Bindings come from the liveness-joined store read, so
 * a terminal that has exited is already unrepresentable; the renderer treats
 * anything absent from this list as "no live agent" and clears its stale axes.
 */
export async function buildAgentStatusSnapshot(
	store: TerminalAgentStore,
): Promise<AgentStatusSnapshotRow[]> {
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
	return rows.filter((row): row is AgentStatusSnapshotRow => row !== null);
}
