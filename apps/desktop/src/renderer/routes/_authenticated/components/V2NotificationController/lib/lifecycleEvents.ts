import type { WorkspaceState } from "@superset/panes";
import type {
	AgentLifecyclePayload,
	TerminalLifecyclePayload,
} from "@superset/workspace-client";
import { playRingtone } from "renderer/lib/ringtones/play";
import { electronTrpcClient } from "renderer/lib/trpc-client";
import type { PaneViewerData } from "renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/types";
import { useRingtoneStore } from "renderer/stores/ringtone";
import {
	getV2NotificationSourceKey,
	getV2TerminalNotificationSource,
	useV2NotificationStore,
	type V2NotificationSourceInput,
} from "renderer/stores/v2-notifications";
import { getV2NativeNotificationContent } from "./notificationContent";
import {
	isV2NotificationTargetVisible,
	resolveV2NotificationTarget,
	type V2NotificationTarget,
} from "./resolveV2NotificationTarget";
import { resolveV2AgentStatusTransition } from "./statusTransitions";

// Diagnostic logging for the agent-status-dots pipeline. Emitted via
// console.info("[agent-dots] ...") so the main process forwarder persists
// it to electron-log (main.log). Logging-only; flip NLOG to silence. See
// patches/notification-logging.patch.
const NLOG = true;
function ndots(record: Record<string, unknown>): void {
	if (!NLOG) return;
	try {
		console.info(
			`[agent-dots] ${JSON.stringify({ ts: new Date().toISOString(), ...record })}`,
		);
	} catch {
		// never let logging crash the renderer
	}
}

/**
 * Updates pane status indicators (working/review/permission/idle) and plays
 * the completion chime client-side, so the playback path works when
 * host-service runs off-machine. The chime is suppressed when the target
 * pane is visible and the window is focused.
 */
export function handleV2AgentLifecycleEvent({
	workspaceId,
	workspaceName,
	payload,
	paneLayout,
	volume,
	muted,
}: {
	workspaceId: string;
	workspaceName: string;
	payload: AgentLifecyclePayload;
	paneLayout: WorkspaceState<PaneViewerData> | null | undefined;
	volume: number;
	muted: boolean;
}): void {
	const target = resolveV2NotificationTarget({
		workspaceId,
		payload,
		paneLayout,
	});
	updateV2AgentLifecycleStatus({
		workspaceId,
		payload,
		paneLayout,
		target,
	});

	// Only Stop and PermissionRequest deserve sound. Start fires per-prompt
	// (the working spinner is feedback enough); Attached/Detached fire on
	// agent boot and clean exit, neither of which is a "your agent finished"
	// moment.
	if (
		payload.eventType === "Start" ||
		payload.eventType === "Attached" ||
		payload.eventType === "Detached" ||
		// (BA) cloud/background-running is a quiet blue-dot signal, not a
		// "your agent finished" moment — no chime, no native notification.
		payload.eventType === "BackgroundRunning" ||
		// (TEAM-YELLOW) turn-end working-hold (agent-type background work still
		// running) — the turn is NOT finished, so it must stay silent too.
		payload.eventType === "SubagentActive"
	) {
		return;
	}
	if (shouldSuppress(target, paneLayout)) return;

	const ringtoneId = useRingtoneStore.getState().selectedRingtoneId;
	void playRingtone({ ringtoneId, volume, muted });

	showNativeNotification({
		payload,
		workspaceId,
		workspaceName,
		target,
	});
}

// Seen-marking / status half of `handleV2AgentLifecycleEvent`, for event paths
// that must not chime (the Electron fallback for adopted shells). Named to match
// the V2NotificationController import; keeps the fork axis-store update (upstream
// renamed this to a bindings-only "mark seen", but the fork dots derive from the
// store, so this still drives the store status).
export function markV2AgentLifecycleTargetSeen({
	workspaceId,
	payload,
	paneLayout,
}: {
	workspaceId: string;
	payload: AgentLifecyclePayload;
	paneLayout: WorkspaceState<PaneViewerData> | null | undefined;
}): void {
	const target = resolveV2NotificationTarget({
		workspaceId,
		payload,
		paneLayout,
	});
	updateV2AgentLifecycleStatus({
		workspaceId,
		payload,
		paneLayout,
		target,
	});
}

// Upstream 1.13.1's terminal lifecycle event no longer carries a workspaceId
// (HostNotificationSubscriber now calls `{ payload }`), so resolve the owning
// workspace from any existing store entry for the terminal. The blue-axis
// display is gated by the open-terminal set (see store.ts), so an empty
// workspaceId here is harmless.
function resolveTerminalWorkspaceId(terminalId: string): string {
	const store = useV2NotificationStore.getState();
	const sourceKey = getV2NotificationSourceKey(
		getV2TerminalNotificationSource(terminalId),
	);
	return (
		store.sources[sourceKey]?.workspaceId ??
		store.shellRunningTerminals[terminalId]?.workspaceId ??
		store.backgroundRunningTerminals[terminalId]?.workspaceId ??
		""
	);
}

export function handleV2TerminalLifecycleEvent({
	payload,
}: {
	payload: TerminalLifecyclePayload;
}): void {
	const store = useV2NotificationStore.getState();
	const workspaceId = resolveTerminalWorkspaceId(payload.terminalId);
	// (AY) Command lifecycle drives the shell-running blue dot on a SEPARATE
	// axis — no sound, no native notification, no agent-status mutation.
	if (payload.eventType === "command-start") {
		store.setTerminalShellRunning(
			payload.terminalId,
			workspaceId,
			payload.occurredAt,
		);
		return;
	}
	if (payload.eventType === "command-end") {
		store.clearTerminalShellRunning(payload.terminalId);
		return;
	}
	// exit: clear the agent source AND any lingering shell-running / (BA)
	// background-running entry (the cloud-blue axis has no OSC self-clear), and
	// prune the host-binding seen record for the now-dead terminal.
	store.clearTerminalShellRunning(payload.terminalId);
	store.clearTerminalBackgroundRunning(payload.terminalId);
	store.pruneTerminalSeen(payload.terminalId);
	// (AGENT-SHELL-BLUE) the pty died — the terminal is no longer an agent
	// terminal; a future terminal reusing panes starts as a plain shell.
	store.pruneAgentTerminal(payload.terminalId);
	clearSources(workspaceId, [
		getV2TerminalNotificationSource(payload.terminalId),
	]);
}

function updatePaneStatus(
	workspaceId: string,
	payload: AgentLifecyclePayload,
	target: V2NotificationTarget,
	paneLayout: WorkspaceState<PaneViewerData> | null | undefined,
): void {
	const store = useV2NotificationStore.getState();
	const targetVisible = isV2NotificationTargetVisible({
		currentWorkspaceId: getCurrentWorkspaceId(),
		paneLayout,
		target,
	});
	const transition = resolveV2AgentStatusTransition({
		workspaceId,
		payload,
		statuses: store.sources,
		targetVisible,
	});

	// (RED-CLEAR diagnostic) Name the EXACT event that clears a still-active
	// permission (AskUser/permission red) axis. A pending red must only clear on
	// a genuine user answer (UserPromptSubmit -> Start). The open suspect: a
	// background fork's PostToolUse (no agent_id) ALSO maps to Start and would
	// prematurely flip a pending red -> yellow while the question is still open.
	// `byEvent` + `sessionId` here cross-reference agent-notify-hook.log's new
	// `agentId` field: a Start with agentId="" and a fork's sessionId clearing
	// the terminal's red is the smoking gun. Logging-only; no behaviour change.
	{
		const sourceKey = getV2NotificationSourceKey(
			getV2TerminalNotificationSource(target.terminalId),
		);
		const prevEntry = store.sources[sourceKey];
		const wasRed = prevEntry?.axes.permission !== undefined;
		if (wasRed) {
			const clearsViaAxes =
				transition.axes?.clear.includes("permission") ?? false;
			const clearsViaRemove = transition.clearSources.some(
				(source) => getV2NotificationSourceKey(source) === sourceKey,
			);
			if (clearsViaAxes || clearsViaRemove) {
				ndots({
					event: "red_cleared",
					byEvent: payload.eventType,
					via: clearsViaAxes ? "axis-clear" : "source-remove",
					terminalId: target.terminalId,
					workspaceId,
					sessionId:
						(payload as { agent?: { sessionId?: string }; sessionId?: string })
							.agent?.sessionId ??
						(payload as { sessionId?: string }).sessionId ??
						null,
					targetVisible,
					permissionSetAt: prevEntry?.axes.permission ?? null,
					occurredAt: payload.occurredAt,
				});
			}
		}
	}

	ndots({
		event: "status_transition_computed",
		// (BA diagnostic) carry the raw eventType — without it Stop and
		// BackgroundRunning produce an identical transition log, hiding whether
		// BackgroundRunning ever reaches the renderer at all.
		eventType: payload.eventType,
		targetVisible,
		workspaceId,
		terminalId: target.terminalId,
		target,
		clearSources: transition.clearSources,
		axes: transition.axes,
	});

	clearSources(workspaceId, transition.clearSources);
	if (transition.axes) {
		// (DOT-AXES) axis-level apply: the store latches/unlatches the named
		// axes and re-derives the rendered status as the highest active one.
		store.applySourceAxes(
			transition.axes.source,
			workspaceId,
			{ set: transition.axes.set, clear: transition.axes.clear },
			payload.occurredAt,
		);
	}

	// (BA) Cloud/background-running blue axis. The notify hook emits
	// "BackgroundRunning" when the turn ended but a Claude cloud/background
	// session is still running. Its agent-status transition (above) is the SAME
	// as a normal turn-end (review-or-clear). With precedence red > yellow > blue
	// > green (see useV2WorkspaceDisplayStatus), this blue now outranks a fresh
	// review green, so it shows as soon as the turn ends with a task running —
	// no longer dependent on the green first clearing to idle. Any OTHER agent
	// event re-derives state, so clear the axis — the next Stop re-sets it from
	// the live background_tasks. NEVER touches the OSC shell-running axis.
	if (payload.eventType === "BackgroundRunning") {
		ndots({
			event: "bg_axis_set",
			workspaceId,
			terminalId: payload.terminalId,
		});
		store.setTerminalBackgroundRunning(
			payload.terminalId,
			workspaceId,
			payload.occurredAt,
		);
	} else if (payload.eventType === "Attached") {
		// (BLUE-SPECTATOR) Attached is the JSONL watcher (re)binding to the
		// transcript — an idle signal whose status transition is a no-op (see
		// statusTransitions.ts). It fires ~1s after a compaction rewrites the
		// JSONL, so letting it fall into the catch-all clear below wiped the
		// blue restored at compact-end out from under a still-running
		// background shell (live repro 2026-06-11). It asserts nothing about
		// turn state, so it must spectate the blue axis too.
	} else {
		// (BA diagnostic) log when a NON-BackgroundRunning event wipes a live blue
		// entry — names the culprit event (e.g. SubagentActive / Start) that
		// clears the blue dot out from under a still-running background task.
		if (store.backgroundRunningTerminals[payload.terminalId]) {
			ndots({
				event: "bg_axis_cleared",
				workspaceId,
				terminalId: payload.terminalId,
				byEvent: payload.eventType,
			});
		}
		store.clearTerminalBackgroundRunning(payload.terminalId);
	}
}

function updateV2AgentLifecycleStatus({
	workspaceId,
	payload,
	paneLayout,
	target,
}: {
	workspaceId: string;
	payload: AgentLifecyclePayload;
	paneLayout: WorkspaceState<PaneViewerData> | null | undefined;
	target: V2NotificationTarget;
}): void {
	updatePaneStatus(workspaceId, payload, target, paneLayout);
}

function getCurrentWorkspaceId(): string | null {
	try {
		// Matches both `/workspace/<id>` and `/v2-workspace/<id>` route shapes.
		const match = window.location.hash.match(/\/(?:v2-)?workspace\/([^/?#]+)/);
		return match ? decodeURIComponent(match[1] ?? "") : null;
	} catch {
		return null;
	}
}

function shouldSuppress(
	target: V2NotificationTarget,
	paneLayout: WorkspaceState<PaneViewerData> | null | undefined,
): boolean {
	if (typeof document !== "undefined" && document.hidden) return false;
	if (typeof window !== "undefined" && !document.hasFocus()) return false;

	return isV2NotificationTargetVisible({
		currentWorkspaceId: getCurrentWorkspaceId(),
		paneLayout,
		target,
	});
}

function showNativeNotification({
	payload,
	workspaceId,
	workspaceName,
	target,
}: {
	payload: AgentLifecyclePayload;
	workspaceId: string;
	workspaceName: string;
	target: V2NotificationTarget;
}): void {
	const { title, body } = getV2NativeNotificationContent({
		workspaceName,
		payload,
	});

	void electronTrpcClient.notifications.showNative
		.mutate({
			title,
			body,
			silent: true,
			clickTarget: {
				workspaceId,
				source: { type: "terminal", id: target.terminalId },
			},
		})
		.catch((error) => {
			console.warn(
				"[notifications] failed to show native notification:",
				error,
			);
		});
}

function clearSources(
	workspaceId: string,
	sources: Array<V2NotificationSourceInput | null | undefined>,
): void {
	const store = useV2NotificationStore.getState();
	store.clearSourceStatuses(
		sources.filter((source): source is V2NotificationSourceInput =>
			Boolean(source),
		),
		workspaceId,
	);
}
