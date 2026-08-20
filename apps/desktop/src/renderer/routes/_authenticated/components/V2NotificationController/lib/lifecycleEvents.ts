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
import { reportTerminalSeen } from "./companionAlertSync";
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
	updatePaneStatus({
		workspaceId,
		payload,
		paneLayout,
		target,
		// News, not history — so the visible-clear hop is allowed to fire.
		fromReplay: false,
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
	fromReplay,
}: {
	workspaceId: string;
	payload: AgentLifecyclePayload;
	paneLayout: WorkspaceState<PaneViewerData> | null | undefined;
	/**
	 * (ALERT-RETIRE-ON-EXIT) Is this a RE-DERIVATION of history rather than news?
	 *
	 * The bus-resync replays each host binding through this same helper, so
	 * without the flag the visible-clear hop below fires for events that already
	 * happened — see the hop's own comment for what that costs. REQUIRED, not
	 * defaulted: a new caller has to say which side of that line it is on.
	 */
	fromReplay: boolean;
}): void {
	const target = resolveV2NotificationTarget({
		workspaceId,
		payload,
		paneLayout,
	});
	updatePaneStatus({
		workspaceId,
		payload,
		paneLayout,
		target,
		fromReplay,
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
	// (MASTER-PLUS-LAUNCH) A session opening is not a dot event. It MUST be
	// handled explicitly: the tail of this function is the `exit` teardown and
	// it is reached by fallthrough, so a "created" event left unnamed here
	// would clear the agent source and prune the terminal registry for a
	// terminal that just came up.
	if (payload.eventType === "created") return;
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
	//
	// (DISPOSE-LIMBO) Only for a CONFIRMED exit. An unconfirmed one is a dispose
	// the daemon never answered: the process may still be running, still hooking,
	// and about to POST the next status for this very terminal. Wiping the seen
	// record and the agent-terminal registry on that guess would drop a live
	// red and demote a live agent tab to a plain shell, and nothing would put
	// either back — the row stays `active` and the reaper's eventual success
	// emits a real exit that runs this teardown for real. Informational only:
	// the pane keeps whatever disconnected state it already shows.
	if (payload.confirmed === false) {
		console.warn(
			"[v2-notifications] UNCONFIRMED terminal exit — leaving dot state alone",
			{ terminalId: payload.terminalId, workspaceId },
		);
		return;
	}
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

function updatePaneStatus({
	workspaceId,
	payload,
	paneLayout,
	target,
	fromReplay,
}: {
	workspaceId: string;
	payload: AgentLifecyclePayload;
	paneLayout: WorkspaceState<PaneViewerData> | null | undefined;
	target: V2NotificationTarget;
	fromReplay: boolean;
}): void {
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

	// (ALERT-RETIRE-ON-EXIT) THE VISIBLE-CLEAR HOP. A turn that ends while the
	// user is LOOKING AT the pane never raises a green — `resolveV2AgentStatusTransition`
	// answers `axes: null` and clears the source instead — so nothing downstream
	// ever calls the mark-read helper, and the phone alert the host minted for
	// that same finish stood until its six-hour TTL. Watching the agent finish
	// on screen is the strongest evidence of a read there is.
	//
	// `payload.occurredAt` IS THE ALERT'S SUBJECT. The host hashes its alert id
	// from the outcome event's own instant (notifications.ts computes it once
	// and every frame about the alert carries it), so this is the one value that
	// names the finish being cancelled. The binding's `lastEventAt` would not:
	// it advances for events that raise no alert at all.
	//
	// MARKED SEEN LOCALLY TOO, not only reported. Without the local mark the
	// next resync compares the binding against an absent seen record and
	// re-raises the very green this cleared.
	//
	// NOT `markTerminalSeenAndReportRead`. Its guard refuses exactly this case —
	// no review entry was ever created, so it has nothing it recognises as
	// evidence and returns before reporting.
	//
	// NO DEBOUNCE. Idempotence is structural: the host keeps a retracted row per
	// alert id until the TTL and a repeat is inert, and the local seen mark is
	// monotonic.
	//
	// STOP AND FAILED ONLY. Those are the two outcomes that mint an alert;
	// BackgroundRunning shares their transition but mints nothing, so reporting
	// it would broadcast a retraction for a finish that never happened.
	//
	// LIVE EVENTS ONLY. The bus-resync replays every host binding through this
	// same function with the binding's `lastEventAt` as `occurredAt`, and a
	// replay is not a read: (a) `lastEventAt` advances for events that mint no
	// alert, so the hop would broadcast a retraction naming an instant no alert
	// id was ever hashed from — a blind claim that can evict a real one from the
	// phone's fixed-size window; and (b) a relaunch replays `lastEventType:
	// "Failed"` on every open agent tab, and error cards are meant to SURVIVE a
	// relaunch until the user looks. The repair path in `resyncAgentStatus` is
	// where a replay may report a read, off durable seen marks and never off the
	// mere fact that the pane is on screen.
	//
	// PRESENCE, NOT LAYOUT. `targetVisible` only says the pane occupies the
	// active tab; it is equally true with the screen locked, the window behind
	// the browser, or the user out of the room — which is the feature's PRIMARY
	// scenario (a turn finishing on the active pane while they are away) and the
	// one where retracting the alert is both wrong and irreversible. The same
	// predicate `shouldSuppress` uses for the chime is the presence test here.
	if (
		!fromReplay &&
		(payload.eventType === "Stop" || payload.eventType === "Failed") &&
		transition.axes === null &&
		target.terminalId.length > 0 &&
		targetVisible &&
		// LAST, because it is the only one that costs anything: `document.hidden`
		// and `hasFocus()` are DOM reads, and every predicate above is a field
		// comparison that rules this event out for free.
		isUserPresent()
	) {
		store.markTerminalSeen(target.terminalId, payload.occurredAt);
		void reportTerminalSeen({
			workspaceId,
			terminalId: target.terminalId,
			seenThroughAt: payload.occurredAt,
		});
	}

	// (AGENT-SHELL-BLUE) EVERY agent lifecycle payload that resolves to a
	// terminal proves an agent runs there — including axes-null events like
	// Attached/SessionStart, which are precisely the first (and while the agent
	// idles at its initial prompt, the only) signal. The axis funnel also
	// stamps this, but it never runs when transition.axes is null.
	if (target.terminalId) {
		store.markAgentTerminal(target.terminalId);
	}
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
	// (WATCHER-BLUE-STOMP) The notify hook is the ONLY source of
	// "BackgroundRunning" — the main-process JSONL watcher deliberately cannot
	// emit it. That matters because this else-branch clears the blue axis on
	// every other agent event, and the watcher's own turn-end (a user interrupt,
	// the one turn-end Claude Code fires no hook for) bypasses the hook
	// entirely: a watcher `Stop` replayed off a re-presented transcript line
	// used to wipe the blue the hook had just restored. Watcher-sourced events
	// are NOT distinguishable here (the Electron payload is only {eventType,
	// terminalId, occurredAt}), so the fix lives at the watcher's emit site —
	// it replay-gates each matched turn-end entry by uuid and timestamp age and
	// stays SILENT on a replay, instead of this branch trying to guess which
	// Stop to spectate.
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

function getCurrentWorkspaceId(): string | null {
	try {
		// Matches both `/workspace/<id>` and `/v2-workspace/<id>` route shapes.
		const match = window.location.hash.match(/\/(?:v2-)?workspace\/([^/?#]+)/);
		return match ? decodeURIComponent(match[1] ?? "") : null;
	} catch {
		return null;
	}
}

/**
 * Is the user actually AT the machine — window shown and focused?
 *
 * The chime's suppression test and the visible-clear hop ask the same question
 * for opposite reasons (do not ring at someone who is watching; do not retract
 * a phone alert for someone who is not), so they share one predicate rather
 * than growing two that can drift apart.
 */
function isUserPresent(): boolean {
	if (typeof document !== "undefined" && document.hidden) return false;
	if (typeof window !== "undefined" && !document.hasFocus()) return false;
	return true;
}

function shouldSuppress(
	target: V2NotificationTarget,
	paneLayout: WorkspaceState<PaneViewerData> | null | undefined,
): boolean {
	if (!isUserPresent()) return false;

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
