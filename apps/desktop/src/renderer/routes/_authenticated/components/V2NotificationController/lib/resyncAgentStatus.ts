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
 */
interface ResyncResult {
	applied: number;
	pendingPermission: number;
	cleared: number;
	skippedUnknownWorkspace: number;
	skippedAlreadySeen: number;
}

type AgentStatusSnapshotRow =
	inferRouterOutputs<AppRouter>["notifications"]["agentStatusSnapshot"]["rows"][number];

function log(record: Record<string, unknown>): void {
	try {
		console.info(
			`[bus-resync] ${JSON.stringify({ ts: new Date().toISOString(), ...record })}`,
		);
	} catch {
		// never let logging break a reconnect
	}
}

/**
 * Fetch the host snapshot and reconcile every terminal source this host owns.
 * Returns null when the snapshot could not be fetched — the caller must treat
 * that as "truth unknown" and change nothing, since clearing dots on a failed
 * read would destroy exactly the state this exists to protect.
 */
export async function resyncAgentStatusFromHost({
	hostUrl,
	workspaces,
}: {
	hostUrl: string;
	workspaces: Map<string, HostNotificationWorkspaceState>;
}): Promise<ResyncResult | null> {
	let rows: AgentStatusSnapshotRow[];
	try {
		({ rows } =
			await getHostServiceClientByUrl(
				hostUrl,
			).notifications.agentStatusSnapshot.query());
	} catch (error) {
		// Loud and distinct: a bus that reconnected but could not resync is a
		// window whose dots may be lying, and nothing else reports it.
		console.error("[bus-resync] snapshot fetch FAILED — dots not reconciled", {
			hostUrl,
			error,
		});
		return null;
	}

	const result: ResyncResult = {
		applied: 0,
		pendingPermission: 0,
		cleared: 0,
		skippedUnknownWorkspace: 0,
		skippedAlreadySeen: 0,
	};
	const liveTerminalIds = new Set<string>();

	for (const row of rows) {
		liveTerminalIds.add(row.terminalId);
		const workspace = workspaces.get(row.originWorkspaceId);
		if (!workspace) {
			// Another host's workspace, or one this window has not hydrated yet.
			result.skippedUnknownWorkspace++;
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

		const source = getV2TerminalNotificationSource(row.terminalId);
		const sourceKey = getV2NotificationSourceKey(source);
		const state = useV2NotificationStore.getState();

		// Monotonic seen-marks: replaying a turn-end the user already looked at
		// must not resurrect its green. `terminalSeenAt` is on the host clock,
		// the same clock `lastEventAt` uses, so they are directly comparable.
		const seenAt = state.terminalSeenAt[row.terminalId];
		if (
			seenAt !== undefined &&
			seenAt >= row.lastEventAt &&
			state.sources[sourceKey]?.status === "review"
		) {
			state.clearSourceAttention(source, row.originWorkspaceId);
			result.skippedAlreadySeen++;
		}

		// The permission axis is asserted LAST and from the marker, not from
		// `lastEventType`: while a question is pending the Python hook rewrites
		// red-clearing events to SubagentActive, so the binding's last event
		// commonly reads yellow for a terminal that is actually blocked on the
		// user. The marker is the durable record of the red.
		if (row.pendingPermission) {
			apply({
				eventType: "PermissionRequest",
				terminalId: row.terminalId,
				occurredAt: row.lastEventAt,
			});
			result.pendingPermission++;
		}
	}

	// Terminals this window still shows a dot for that the host has no live
	// binding for: the agent exited (or the whole host restarted) while we were
	// disconnected, so the working/permission latches are stale. Review (green)
	// is deliberately left alone — it is unread state the user has not seen yet,
	// owned by the seen-mark path, and losing it silently drops a completion.
	const store = useV2NotificationStore.getState();
	for (const entry of Object.values(store.sources)) {
		if (entry.source.type !== "terminal") continue;
		if (liveTerminalIds.has(entry.source.id)) continue;
		if (!workspaces.has(entry.workspaceId)) continue;
		if (
			entry.axes.permission === undefined &&
			entry.axes.working === undefined
		) {
			continue;
		}
		store.applySourceAxes(entry.source, entry.workspaceId, {
			set: [],
			clear: ["permission", "working"],
		});
		result.cleared++;
	}

	log({ event: "resync_complete", hostUrl, rows: rows.length, ...result });
	return result;
}
