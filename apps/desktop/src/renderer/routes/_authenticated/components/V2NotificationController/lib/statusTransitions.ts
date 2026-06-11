import type { AgentLifecyclePayload } from "@superset/workspace-client";
import {
	getV2NotificationSourceKey,
	getV2TerminalNotificationSource,
	type V2AgentStatusAxisOps,
	type V2NotificationSource,
	type V2NotificationSourceInput,
} from "renderer/stores/v2-notifications";
import type { PaneStatus } from "shared/tabs-types";

interface StatusEntry {
	workspaceId: string;
	status: PaneStatus;
}

/**
 * (DOT-AXES) Each lifecycle event maps to SET/CLEAR operations on the
 * source's independent status axes (permission/working/review) instead of
 * overwriting a single status slot. The store derives the rendered status as
 * the highest-precedence active axis, so events are free to assert what they
 * actually know ("agents are busy") without stomping a higher-ranking state
 * they know nothing about (a pending red). An axis is only CLEARED by an
 * event that is evidence the state ended: main-loop progress (Start) proves
 * a pending question/permission was answered; a turn-end proves working is
 * over.
 */
export interface V2AgentStatusTransition {
	clearSources: V2NotificationSourceInput[];
	axes: (V2AgentStatusAxisOps & { source: V2NotificationSource }) | null;
}

export function resolveV2AgentStatusTransition({
	workspaceId,
	payload,
	statuses,
	targetVisible,
}: {
	workspaceId: string;
	payload: AgentLifecyclePayload;
	statuses: Record<string, StatusEntry | undefined>;
	targetVisible: boolean;
}): V2AgentStatusTransition {
	const terminalSource = getV2TerminalNotificationSource(payload.terminalId);
	const terminalSourceKey = getV2NotificationSourceKey(terminalSource);

	// Attach is an idle signal — it binds the pane icon (handled in
	// HostNotificationSubscriber) but must not flip the pane to "working".
	if (payload.eventType === "Attached") {
		return { clearSources: [], axes: null };
	}
	if (payload.eventType === "Detached") {
		// The agent went away mid-flight: the transient axes die with it. A
		// review green (the turn already ended, results unseen) survives.
		return {
			clearSources: [],
			axes: {
				source: terminalSource,
				set: [],
				clear: ["permission", "working"],
			},
		};
	}

	if (payload.eventType === "SubagentActive") {
		// Red-respecting working assert: delegated agent work (subagents,
		// teammates, workflows, codex, a subagent's tool completions) proves
		// agents are busy — NOT that a pending question/permission was
		// answered. Only the working axis is raised; an active permission axis
		// keeps the dot red through the fold (red > yellow).
		return {
			clearSources: [],
			axes: { source: terminalSource, set: ["working"], clear: [] },
		};
	}

	if (payload.eventType === "Start") {
		// Main-loop progress: the turn is running, which is also proof that a
		// pending question/permission was answered and any earlier review
		// green is stale.
		return {
			clearSources: [],
			axes: {
				source: terminalSource,
				set: ["working"],
				clear: ["permission", "review"],
			},
		};
	}

	if (payload.eventType === "PermissionRequest") {
		return {
			clearSources: [],
			axes: { source: terminalSource, set: ["permission"], clear: [] },
		};
	}

	// Turn-end (Stop / BackgroundRunning / any unknown event).
	const entry = statuses[terminalSourceKey];
	const wasAwaitingPermission =
		entry?.workspaceId === workspaceId && entry.status === "permission";
	if (wasAwaitingPermission || targetVisible) {
		return { clearSources: [terminalSource], axes: null };
	}

	return {
		clearSources: [],
		axes: {
			source: terminalSource,
			set: ["review"],
			clear: ["permission", "working"],
		},
	};
}
