import type { AppRouter } from "@superset/host-service";
import type { AgentLifecyclePayload } from "@superset/workspace-client";
import type { inferRouterOutputs } from "@trpc/server";
import { getHostServiceClientByUrl } from "renderer/lib/host-service-client";
import {
	getV2NotificationSourceKey,
	getV2TerminalNotificationSource,
	useV2NotificationStore,
} from "renderer/stores/v2-notifications";
import type { HostNotificationWorkspaceState } from "../components/HostNotificationSubscriber";
import { markV2AgentLifecycleTargetSeen } from "./lifecycleEvents";

/**
 * (BUS-RESYNC) Reconcile the agent-status dots against the host's durable
 * truth after the WS event bus (re)connects.
 *
 * The bus is fire-and-forget on both ends: `EventBus.broadcast` writes to the
 * sockets that happen to be connected and keeps no queue, and the client
 * replays only its `fs:watch` commands on open. So every agent-lifecycle event
 * emitted while the renderer was disconnected — a host-service restart, a
 * suspended machine, a socket that died quietly — is destroyed. Working and
 * permission states cannot self-heal from that: an agent blocked on a question
 * emits no further hook events, so its red dot never arrives and never will
 * (live incident: a bus dead for 7h43m after a host restart swallowed a pending
 * AskUserQuestion).
 *
 * This is the repair. It is status-only by construction — it routes through
 * `markV2AgentLifecycleTargetSeen`, the same store path the live listener uses
 * MINUS the chime and native-notification path, because replaying hours of
 * history must never ring.
 *
 * The snapshot is OLDER TRUTH than anything the (now open) bus delivers while
 * it is in flight, so every write below is fenced against live events: a row is
 * skipped when the store already holds a newer event for that terminal, and a
 * stale-clear only fires when the store entry is byte-for-byte the object that
 * was there before the request went out. A clear additionally requires that the
 * host POSITIVELY DISOWN the terminal (GHOST-TERMINAL) — "not in the live
 * bindings" is not the same claim as "not mine".
 */
interface ResyncResult {
	applied: number;
	pendingPermission: number;
	unknownPermission: number;
	cleared: number;
	seededSeen: number;
	/**
	 * (GHOST-TERMINAL) Terminals the host has no session row for at all. Their
	 * axes are left untouched — see the sweep.
	 */
	ghostsSkipped: number;
	skippedUnknownWorkspace: number;
	skippedAlreadySeen: number;
	skippedNewerLocal: number;
	/** The result arrived after its connection epoch ended; nothing was applied. */
	discarded: boolean;
}

type AgentStatusSnapshotRow =
	inferRouterOutputs<AppRouter>["notifications"]["agentStatusSnapshot"]["rows"][number];

function log(record: Record<string, unknown>): void {
	try {
		console.info(
			`[bus-resync] ${JSON.stringify({ ts: new Date().toISOString(), ...record })}`,
		);
	} catch {
		// never let logging break a reconcile
	}
}

/**
 * Fetch the host snapshot and reconcile every terminal source this host owns.
 * Returns null when the snapshot could not be fetched — the caller must treat
 * that as "truth unknown" and change nothing, since clearing dots on a failed
 * read would destroy exactly the state this exists to protect.
 *
 * `isCurrent` is the caller's epoch/mount guard: a snapshot that lands after
 * its socket closed (or after the subscriber unmounted) describes a connection
 * that no longer exists, and the epoch that replaced it runs its own resync.
 */
export async function resyncAgentStatusFromHost({
	hostUrl,
	workspaces,
	isCurrent,
}: {
	hostUrl: string;
	workspaces: Map<string, HostNotificationWorkspaceState>;
	isCurrent?: () => boolean;
}): Promise<ResyncResult | null> {
	// The fence. Zustand replaces an entry OBJECT on every write, so comparing
	// identity after the await proves whether a live event touched that terminal
	// while the snapshot was in flight. Only an untouched entry may be
	// stale-cleared — and a terminal created after the host copied its bindings
	// has no entry here at all, so it fails the same check instead of being
	// cleared as "absent".
	const before = useV2NotificationStore.getState();
	const beforeSources = before.sources;
	const beforeBackground = before.backgroundRunningTerminals;
	const beforeShell = before.shellRunningTerminals;

	let rows: AgentStatusSnapshotRow[];
	let knownTerminalIds: string[];
	try {
		({ rows, knownTerminalIds } =
			await getHostServiceClientByUrl(
				hostUrl,
			).notifications.agentStatusSnapshot.query());
	} catch (error) {
		console.error("[bus-resync] snapshot fetch FAILED — dots not reconciled", {
			hostUrl,
			error,
		});
		return null;
	}

	const result: ResyncResult = {
		applied: 0,
		pendingPermission: 0,
		unknownPermission: 0,
		cleared: 0,
		seededSeen: 0,
		ghostsSkipped: 0,
		skippedUnknownWorkspace: 0,
		skippedAlreadySeen: 0,
		skippedNewerLocal: 0,
		discarded: false,
	};

	if (isCurrent && !isCurrent()) {
		result.discarded = true;
		log({ event: "resync_discarded", hostUrl, rows: rows.length });
		return result;
	}

	const liveTerminalIds = new Set<string>();

	for (const row of rows) {
		liveTerminalIds.add(row.terminalId);
		const workspace = workspaces.get(row.originWorkspaceId);
		if (!workspace) {
			result.skippedUnknownWorkspace++;
			continue;
		}

		const source = getV2TerminalNotificationSource(row.terminalId);
		const sourceKey = getV2NotificationSourceKey(source);
		const preState = useV2NotificationStore.getState();
		const preEntry = preState.sources[sourceKey];
		const preSeenAt = preState.terminalSeenAt[row.terminalId];

		// A live event that landed while the snapshot was in flight — the user
		// answering the question this row still calls pending, or a fresh
		// PermissionRequest — is NEWER truth than the row. Replaying the row over
		// it would re-assert a red the user just cleared, or clear one that just
		// arrived. Both timestamps are the host's clock (`payload.occurredAt` on
		// the lifecycle path, `binding.lastEventAt` in the snapshot).
		if (preEntry !== undefined && preEntry.occurredAt > row.lastEventAt) {
			result.skippedNewerLocal++;
			continue;
		}

		const apply = (payload: AgentLifecyclePayload) => {
			markV2AgentLifecycleTargetSeen({
				workspaceId: row.originWorkspaceId,
				payload,
				paneLayout: workspace.paneLayout,
			});
		};

		apply({
			eventType: row.lastEventType,
			terminalId: row.terminalId,
			occurredAt: row.lastEventAt,
		});
		result.applied++;

		// (DOT-PERSIST) The dot store and `terminalSeenAt` both live in
		// sessionStorage, so a REAL app restart starts with both empty — and the
		// resting `lastEventType` of every idle agent tab is a turn-end. Replaying
		// those unchanged would paint review-green on every open agent tab at every
		// launch, for completions reviewed days ago, which is precisely the state
		// (DOT-PERSIST) promises a restart clears. A row landing on a terminal the
		// store has never heard of is therefore marked seen AT the replayed event:
		// working and permission still paint (they are re-derived below and from
		// the marker), a stale green does not.
		if (preEntry === undefined && preSeenAt === undefined) {
			useV2NotificationStore
				.getState()
				.markTerminalSeen(row.terminalId, row.lastEventAt);
			result.seededSeen++;
		}

		const state = useV2NotificationStore.getState();
		const seenAt = state.terminalSeenAt[row.terminalId];
		if (
			seenAt !== undefined &&
			seenAt >= row.lastEventAt &&
			state.sources[sourceKey]?.status === "review"
		) {
			state.clearSourceAttention(source, row.originWorkspaceId);
			result.skippedAlreadySeen++;
		}

		if (row.pendingPermission === null) {
			// The host could not read the marker directory. Unknown is not "no
			// question": leave the permission axis exactly as it was, including
			// re-latching a red the replayed `lastEventType` just cleared.
			if (
				preEntry?.axes.permission !== undefined &&
				preEntry.workspaceId === row.originWorkspaceId
			) {
				useV2NotificationStore
					.getState()
					.applySourceAxes(
						source,
						row.originWorkspaceId,
						{ set: ["permission"], clear: [] },
						preEntry.axes.permission,
					);
			}
			result.unknownPermission++;
		} else if (row.pendingPermission) {
			apply({
				eventType: "PermissionRequest",
				terminalId: row.terminalId,
				occurredAt: row.lastEventAt,
			});
			result.pendingPermission++;
		}
	}

	// Terminals the host POSITIVELY DISOWNS — it has a session row for them but
	// no live binding — have lost every latched axis riding the same
	// fire-and-forget bus. Review is deliberately preserved (a finished turn
	// nobody has looked at is still unread), but permission/working and the
	// background-running blue have no other way back to false once their
	// clearing event was destroyed. Terminals the host has never heard of are a
	// different animal entirely and are skipped below.
	const store = useV2NotificationStore.getState();
	const knownIds = new Set(knownTerminalIds);
	const ghostTerminalIds: string[] = [];
	const ownedTerminals = new Map<string, string>();
	for (const entry of Object.values(store.sources)) {
		if (entry.source.type !== "terminal") continue;
		ownedTerminals.set(entry.source.id, entry.workspaceId);
	}
	// Blue-axis-only terminals have no `sources` entry to iterate. Every
	// background-running entry is agent-driven by construction (only the
	// `BackgroundRunning` lifecycle event writes that map), so absence from an
	// agent snapshot is evidence about it.
	for (const [terminalId, entry] of Object.entries(
		store.backgroundRunningTerminals,
	)) {
		if (!ownedTerminals.has(terminalId)) {
			ownedTerminals.set(terminalId, entry.workspaceId);
		}
	}
	for (const [terminalId, workspaceId] of ownedTerminals) {
		if (liveTerminalIds.has(terminalId)) continue;
		if (!workspaces.has(workspaceId)) continue;
		// (GHOST-TERMINAL) Absent from the live bindings is only evidence when the
		// host knows the terminal at all. A pane can hold a re-minted terminalId
		// with no `terminal_sessions` row — every hook POST for it comes back
		// `ignored: true`, and its dot is painted locally by the desktop's
		// Electron fallback. Clearing on "absent" would destroy exactly that dot,
		// on every reconnect, for a terminal that is genuinely working. Only a
		// terminal the host POSITIVELY DISOWNS (known, not live) may be swept.
		if (!knownIds.has(terminalId)) {
			ghostTerminalIds.push(terminalId);
			continue;
		}
		const source = getV2TerminalNotificationSource(terminalId);
		const sourceKey = getV2NotificationSourceKey(source);
		const entry = store.sources[sourceKey];
		let touched = false;

		if (
			entry !== undefined &&
			entry === beforeSources[sourceKey] &&
			(entry.axes.permission !== undefined || entry.axes.working !== undefined)
		) {
			store.applySourceAxes(entry.source, entry.workspaceId, {
				set: [],
				clear: ["permission", "working"],
			});
			touched = true;
		}

		const background = store.backgroundRunningTerminals[terminalId];
		if (
			background !== undefined &&
			background === beforeBackground[terminalId]
		) {
			store.clearTerminalBackgroundRunning(terminalId);
			touched = true;
		}

		// (AGENT-SHELL-BLUE) The OSC-133 latch is only clearable here for a
		// terminal the durable registry says ran an agent: a PLAIN shell has no
		// agent binding to begin with, so it is absent from every snapshot and
		// clearing it would extinguish a live `npm run dev` blue on every
		// reconnect. The snapshot carries no command state, so that half stays
		// unprovable and untouched.
		const shell = store.shellRunningTerminals[terminalId];
		if (
			shell !== undefined &&
			shell === beforeShell[terminalId] &&
			store.agentTerminals[terminalId]
		) {
			store.clearTerminalShellRunning(terminalId);
			touched = true;
		}

		if (touched) result.cleared++;
	}

	result.ghostsSkipped = ghostTerminalIds.length;
	if (ghostTerminalIds.length > 0) {
		// Loud on purpose: a pane holding a terminalId the host never minted is a
		// broken binding, not a dot problem, and it is invisible from the UI —
		// every hook POST for it silently returns `ignored: true`.
		console.warn(
			`[bus-resync] (GHOST-TERMINAL) ${ghostTerminalIds.length} terminal(s) unknown to host ${hostUrl} — axes left untouched: ${ghostTerminalIds.join(", ")}`,
		);
	}

	log({ event: "resync_complete", hostUrl, rows: rows.length, ...result });
	return result;
}
