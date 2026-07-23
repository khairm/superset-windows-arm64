import type { Pane, Tab, WorkspaceState } from "@superset/panes";
import { eq } from "@tanstack/db";
import { useLiveQuery } from "@tanstack/react-db";
import { useMemo } from "react";
import { useCollections } from "renderer/routes/_authenticated/providers/CollectionsProvider";
// (AY) DisplayStatus (ActivePaneStatus | "shell-running") is owned by the
// StatusIndicator that renders it; the store consumes it as the render type for
// the merged agent+shell-running dots. Single source of truth — no re-declare.
import type { DisplayStatus } from "renderer/screens/main/components/StatusIndicator";
import {
	type ActivePaneStatus,
	getHighestPriorityStatus,
} from "shared/tabs-types";
import { create } from "zustand";
import { createJSONStorage, devtools, persist } from "zustand/middleware";

// Diagnostic logging for the agent-status-dots pipeline. console.info with
// an "[agent-dots]" prefix so the main process forwarder persists it to
// electron-log (main.log). Logging-only; flip NLOG to silence. NOTE: only
// the mutators are instrumented — selectors (selectStatusForSourceKeys) are
// hot and intentionally left untouched. See patches/notification-logging.patch.
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

export type V2NotificationPaneLike = Pick<Pane<unknown>, "kind" | "data">;
export type V2NotificationTabLike = Pick<Tab<unknown>, "panes">;

export interface V2WorkspaceTabPaneDescriptor {
	id: string;
	kind: string;
	titleOverride?: string;
	terminalId?: string;
	chatSessionId?: string;
	filePath?: string;
	browserPageTitle?: string;
	browserUrl?: string;
	commentAuthorLogin?: string;
}

export interface V2WorkspaceTabChipData {
	tabId: string;
	titleOverride?: string;
	activePaneId: string | null;
	panes: V2WorkspaceTabPaneDescriptor[];
	status: DisplayStatus | null;
}

export type V2NotificationSource =
	| { type: "terminal"; id: string }
	| { type: "chat"; id: string }
	| { type: "manual"; id: string };

export type V2NotificationSourceType = V2NotificationSource["type"];
export type V2NotificationSourceKey = `${V2NotificationSourceType}:${string}`;
export type V2NotificationSourceInput =
	| V2NotificationSource
	| V2NotificationSourceKey;

/**
 * (DOT-AXES) The independent agent-status axes of ONE source. Each axis is a
 * separate "this state is currently active" latch (value = when it was last
 * asserted); events SET and CLEAR axes they have evidence about and never
 * touch the others, and the rendered `status` is DERIVED as the
 * highest-precedence active axis (permission > working > review — the same
 * red > yellow > green the display fold uses, with the blue axes already
 * living on their own maps below). A lower-ranking assert can therefore
 * never stomp a higher-ranking active state by construction: SubagentActive
 * raising `working` while `permission` is latched leaves the dot red until
 * an event with actual answer-evidence (Start) clears the permission axis.
 */
export type V2AgentStatusAxis = ActivePaneStatus;

export type V2AgentStatusAxes = Partial<Record<V2AgentStatusAxis, number>>;

export interface V2AgentStatusAxisOps {
	set: readonly V2AgentStatusAxis[];
	clear: readonly V2AgentStatusAxis[];
}

const AGENT_AXIS_PRIORITY: readonly V2AgentStatusAxis[] = [
	"permission",
	"working",
	"review",
];

function deriveAgentStatus(axes: V2AgentStatusAxes): ActivePaneStatus | null {
	for (const axis of AGENT_AXIS_PRIORITY) {
		if (axes[axis] !== undefined) return axis;
	}
	return null;
}

export interface V2NotificationStatusEntry {
	sourceKey: V2NotificationSourceKey;
	source: V2NotificationSource;
	workspaceId: string;
	/** Derived: the highest-precedence active axis (see V2AgentStatusAxes). */
	status: ActivePaneStatus;
	axes: V2AgentStatusAxes;
	occurredAt: number;
}

/**
 * (AY) A foreground command currently running in a terminal (OSC 133 C with no
 * matching D yet), keyed by terminalId. Separate axis from `sources`: it never
 * participates in agent-status aggregation; it only drives the blue dot when no
 * agent status outranks it. Cleared on command-end / exit / prompt-redraw-end.
 */
export interface V2ShellRunningEntry {
	workspaceId: string;
	occurredAt: number;
}

export interface V2NotificationState {
	sources: Record<string, V2NotificationStatusEntry>;
	// (HOST-BINDING BRIDGE) Upstream 1.13.1 derives terminal agent status from
	// host agent bindings via `renderer/hooks/host-service/useV2NotificationStatus`
	// (dock badge, per-pane focus-clear, running-agents list). Those consumers
	// read these two facts off the store, so they live here ALONGSIDE the fork's
	// axis machinery — the fork dots keep using `sources`; these serve the
	// binding-derived surfaces. `manualUnread` mirrors the fork manual source so
	// the two unread reads never disagree.
	manualUnread: Record<string, true>;
	// terminalId → last agent event the user has seen (HOST clock). Compared to
	// the host binding's lastEventAt to derive `review`.
	terminalSeenAt: Record<string, number>;
	clearManualUnread: (workspaceId: string) => void;
	// Marks a terminal seen (monotonic, host clock) AND clears the fork review
	// axis for that terminal, so the binding-model per-pane focus-clear also
	// clears the store's green dot.
	markTerminalSeen: (terminalId: string, at: number) => void;
	pruneTerminalSeen: (terminalId: string) => void;
	// (AY) Separate shell-running axis (see V2ShellRunningEntry). Keyed by
	// terminalId. Never merged into `sources`.
	shellRunningTerminals: Record<string, V2ShellRunningEntry>;
	setTerminalShellRunning: (
		terminalId: string,
		workspaceId: string,
		occurredAt?: number,
	) => void;
	clearTerminalShellRunning: (terminalId: string) => void;
	// (BA) Separate cloud/background-session axis: the agent's turn ended but a
	// Claude cloud/background task is still running. Same render colour as
	// shell-running (blue), distinct tooltip. Driven by the notify hook's
	// BackgroundRunning event; never merged into `sources`.
	backgroundRunningTerminals: Record<string, V2ShellRunningEntry>;
	setTerminalBackgroundRunning: (
		terminalId: string,
		workspaceId: string,
		occurredAt?: number,
	) => void;
	clearTerminalBackgroundRunning: (terminalId: string) => void;
	// (AGENT-SHELL-BLUE) Durable "an agent has run in this terminal" registry.
	// Stamped by every agent-axis write for a terminal source and kept even
	// after the transient sources entry clears (mark-seen / turn-end), because
	// the OSC-133 shell-running latch outlives both — the agent CLI is the
	// terminal's foreground command for its whole session. Gates shell-blue to
	// PLAIN shells only. Cleared when the terminal itself exits.
	agentTerminals: Record<string, true>;
	markAgentTerminal: (terminalId: string) => void;
	pruneAgentTerminal: (terminalId: string) => void;
	// (DOT-AXES) The axis-level mutator every status write funnels through:
	// applies set/clear latches to ONE source's axes and re-derives `status`
	// as the highest-precedence active axis. Removes the entry when no axis
	// remains active. Never touches another workspace's entry except to
	// replace it wholesale when this workspace asserts an axis (the terminal
	// was re-homed).
	applySourceAxes: (
		source: V2NotificationSource,
		workspaceId: string,
		ops: V2AgentStatusAxisOps,
		occurredAt?: number,
	) => void;
	setSourceStatus: (
		source: V2NotificationSource,
		workspaceId: string,
		status: ActivePaneStatus,
		occurredAt?: number,
	) => void;
	setTerminalStatus: (
		terminalId: string,
		workspaceId: string,
		status: ActivePaneStatus,
		occurredAt?: number,
	) => void;
	setChatStatus: (
		chatId: string,
		workspaceId: string,
		status: ActivePaneStatus,
		occurredAt?: number,
	) => void;
	setManualUnread: (workspaceId: string) => void;
	clearSourceStatus: (
		source: V2NotificationSourceInput,
		workspaceId?: string,
	) => void;
	clearSourceStatuses: (
		sources: Iterable<V2NotificationSourceInput>,
		workspaceId?: string,
	) => void;
	clearSourceAttention: (
		source: V2NotificationSourceInput,
		workspaceId?: string,
	) => void;
	clearWorkspaceStatuses: (workspaceId: string) => void;
	clearWorkspaceAttention: (workspaceId: string) => void;
}

// (DOT-PERSIST) The dot state lives in renderer memory, so an in-place window
// reload (Ctrl+R, error-boundary Reload, crash recovery) wiped EVERY dot.
// Working/permission re-assert within seconds from live hook events, but the
// (BA) background-running blue has NO self-heal: nothing re-emits
// "BackgroundRunning" until that session's NEXT turn end, so a reload left a
// running background task invisible for hours (live repro 2026-06-12 15:02).
// sessionStorage is deliberate: it survives in-place reloads — the exact
// failure — but clears on a real app restart, so dead terminals can't pin
// stale dots across launches (and an app UPDATE can never rehydrate an old
// schema). Only the three data maps persist; mutators come from the creator.
export const useV2NotificationStore = create<V2NotificationState>()(
	devtools(
		persist(
			(set) => ({
				sources: {},
				manualUnread: {},
				terminalSeenAt: {},
				clearManualUnread: (workspaceId) => {
					// Clear the binding-model record AND the fork manual source.
					useV2NotificationStore
						.getState()
						.clearSourceStatus(
							getV2ManualNotificationSource(workspaceId),
							workspaceId,
						);
					set((state) => {
						if (!(workspaceId in state.manualUnread)) return state;
						const { [workspaceId]: _removed, ...manualUnread } =
							state.manualUnread;
						return { manualUnread };
					});
				},
				markTerminalSeen: (terminalId, at) => {
					set((state) => {
						const prev = state.terminalSeenAt[terminalId];
						// Monotonic: a late event must not roll the seen mark back.
						const bumpSeen = prev === undefined || prev < at;
						// Bridge to the fork store: clearing "seen" also clears the
						// terminal's review (green) axis, matching clearSourceAttention.
						const sourceKey = getV2NotificationSourceKey(
							getV2TerminalNotificationSource(terminalId),
						);
						const entry = state.sources[sourceKey];
						let sources = state.sources;
						if (entry && entry.status === "review") {
							const { [sourceKey]: _removed, ...rest } = state.sources;
							sources = rest;
						}
						if (!bumpSeen && sources === state.sources) return state;
						const next: Partial<V2NotificationState> = {};
						if (bumpSeen)
							next.terminalSeenAt = {
								...state.terminalSeenAt,
								[terminalId]: at,
							};
						if (sources !== state.sources) next.sources = sources;
						return next;
					});
				},
				pruneTerminalSeen: (terminalId) => {
					set((state) => {
						if (!(terminalId in state.terminalSeenAt)) return state;
						const { [terminalId]: _removed, ...terminalSeenAt } =
							state.terminalSeenAt;
						return { terminalSeenAt };
					});
				},
				shellRunningTerminals: {},
				setTerminalShellRunning: (
					terminalId,
					workspaceId,
					occurredAt = Date.now(),
				) => {
					set((state) => {
						const prev = state.shellRunningTerminals[terminalId];
						if (prev && prev.workspaceId === workspaceId) return state;
						return {
							shellRunningTerminals: {
								...state.shellRunningTerminals,
								[terminalId]: { workspaceId, occurredAt },
							},
						};
					});
				},
				clearTerminalShellRunning: (terminalId) => {
					set((state) => {
						if (!state.shellRunningTerminals[terminalId]) return state;
						const { [terminalId]: _removed, ...shellRunningTerminals } =
							state.shellRunningTerminals;
						return { shellRunningTerminals };
					});
				},
				backgroundRunningTerminals: {},
				setTerminalBackgroundRunning: (
					terminalId,
					workspaceId,
					occurredAt = Date.now(),
				) => {
					set((state) => {
						const prev = state.backgroundRunningTerminals[terminalId];
						if (prev && prev.workspaceId === workspaceId) return state;
						return {
							backgroundRunningTerminals: {
								...state.backgroundRunningTerminals,
								[terminalId]: { workspaceId, occurredAt },
							},
						};
					});
				},
				clearTerminalBackgroundRunning: (terminalId) => {
					set((state) => {
						if (!state.backgroundRunningTerminals[terminalId]) return state;
						const { [terminalId]: _removed, ...backgroundRunningTerminals } =
							state.backgroundRunningTerminals;
						return { backgroundRunningTerminals };
					});
				},
				agentTerminals: {},
				markAgentTerminal: (terminalId) => {
					set((state) =>
						state.agentTerminals[terminalId]
							? state
							: {
									agentTerminals: {
										...state.agentTerminals,
										[terminalId]: true as const,
									},
								},
					);
				},
				pruneAgentTerminal: (terminalId) => {
					set((state) => {
						if (!state.agentTerminals[terminalId]) return state;
						const { [terminalId]: _removed, ...agentTerminals } =
							state.agentTerminals;
						return { agentTerminals };
					});
				},
				applySourceAxes: (
					source,
					workspaceId,
					ops,
					occurredAt = Date.now(),
				) => {
					const sourceKey = getV2NotificationSourceKey(source);
					const prev = useV2NotificationStore.getState().sources[sourceKey];
					// (DOT-AXES) A different workspace's entry is only replaced when this
					// workspace actually asserts an axis (the terminal was re-homed);
					// clear-only ops must not reach across workspaces.
					const foreign =
						prev !== undefined && prev.workspaceId !== workspaceId;
					if (foreign && ops.set.length === 0) return;
					const axes: V2AgentStatusAxes =
						prev && !foreign ? { ...prev.axes } : {};
					for (const axis of ops.clear) delete axes[axis];
					for (const axis of ops.set) axes[axis] = occurredAt;
					const status = deriveAgentStatus(axes);
					ndots({
						event: "store_mutation",
						mutation: "applySourceAxes",
						sourceKey,
						workspaceId,
						setAxes: ops.set,
						clearAxes: ops.clear,
						from: prev?.status ?? null,
						to: status,
						occurredAt,
					});
					set((state) => {
						// (AGENT-SHELL-BLUE) Any agent-axis write for a terminal source —
						// including a clear-to-null — proves an agent runs here.
						const agentTerminals =
							sourceKey.startsWith(TERMINAL_SOURCE_PREFIX) &&
							!state.agentTerminals[
								sourceKey.slice(TERMINAL_SOURCE_PREFIX.length)
							]
								? {
										...state.agentTerminals,
										[sourceKey.slice(TERMINAL_SOURCE_PREFIX.length)]:
											true as const,
									}
								: state.agentTerminals;
						if (status === null) {
							if (!state.sources[sourceKey]) {
								return agentTerminals === state.agentTerminals
									? state
									: { agentTerminals };
							}
							const { [sourceKey]: _removed, ...sources } = state.sources;
							return { sources, agentTerminals };
						}
						return {
							agentTerminals,
							sources: {
								...state.sources,
								[sourceKey]: {
									sourceKey,
									source,
									workspaceId,
									status,
									axes,
									occurredAt,
								},
							},
						};
					});
				},
				// Back-compat single-status setter for sequential writers (chat sources,
				// manual unread). Translated to axis ops with the status's evidence
				// semantics: "working" means a turn is running (a pending red was answered,
				// a stale green is void); "review" means the turn ended (red/working over);
				// "permission" asserts red on top of whatever else is latched.
				setSourceStatus: (
					source,
					workspaceId,
					status,
					occurredAt = Date.now(),
				) => {
					const ops: V2AgentStatusAxisOps =
						status === "permission"
							? { set: ["permission"], clear: [] }
							: status === "working"
								? { set: ["working"], clear: ["permission", "review"] }
								: { set: ["review"], clear: ["permission", "working"] };
					useV2NotificationStore
						.getState()
						.applySourceAxes(source, workspaceId, ops, occurredAt);
				},
				setTerminalStatus: (terminalId, workspaceId, status, occurredAt) => {
					useV2NotificationStore
						.getState()
						.setSourceStatus(
							getV2TerminalNotificationSource(terminalId),
							workspaceId,
							status,
							occurredAt,
						);
				},
				setChatStatus: (chatId, workspaceId, status, occurredAt) => {
					useV2NotificationStore
						.getState()
						.setSourceStatus(
							getV2ChatNotificationSource(chatId),
							workspaceId,
							status,
							occurredAt,
						);
				},
				setManualUnread: (workspaceId) => {
					set((state) => ({
						manualUnread: { ...state.manualUnread, [workspaceId]: true },
					}));
					useV2NotificationStore
						.getState()
						.setSourceStatus(
							getV2ManualNotificationSource(workspaceId),
							workspaceId,
							"review",
						);
				},
				clearSourceStatus: (source, workspaceId) => {
					const sourceKey = getV2NotificationSourceKey(source);
					ndots({
						event: "store_mutation",
						mutation: "clearSourceStatus",
						sourceKey,
						workspaceId: workspaceId ?? null,
						from:
							useV2NotificationStore.getState().sources[sourceKey]?.status ??
							null,
						to: null,
						occurredAt: Date.now(),
					});
					set((state) => {
						const entry = state.sources[sourceKey];
						if (!entry || (workspaceId && entry.workspaceId !== workspaceId)) {
							return state;
						}
						const { [sourceKey]: _removed, ...sources } = state.sources;
						return { sources };
					});
				},
				clearSourceStatuses: (sourceInputs, workspaceId) => {
					set((state) => {
						const sourceKeys = new Set(
							[...sourceInputs].map(getV2NotificationSourceKey),
						);
						const sources: Record<string, V2NotificationStatusEntry> = {};
						let changed = false;
						for (const [sourceKey, source] of Object.entries(state.sources)) {
							if (
								sourceKeys.has(sourceKey as V2NotificationSourceKey) &&
								(!workspaceId || source.workspaceId === workspaceId)
							) {
								changed = true;
								continue;
							}
							sources[sourceKey] = source;
						}
						return changed ? { sources } : state;
					});
				},
				clearSourceAttention: (source, workspaceId) => {
					const sourceKey = getV2NotificationSourceKey(source);
					set((state) => {
						const entry = state.sources[sourceKey];
						if (
							!entry ||
							entry.status !== "review" ||
							(workspaceId && entry.workspaceId !== workspaceId)
						) {
							return state;
						}
						const { [sourceKey]: _removed, ...sources } = state.sources;
						return { sources };
					});
				},
				clearWorkspaceStatuses: (workspaceId) => {
					set((state) => {
						const sources: Record<string, V2NotificationStatusEntry> = {};
						let changed = false;
						for (const [sourceKey, source] of Object.entries(state.sources)) {
							if (source.workspaceId === workspaceId) {
								changed = true;
								continue;
							}
							sources[sourceKey] = source;
						}
						// (BA) Also drop background-running entries for this workspace — the
						// blue axis has no OSC self-clear, so a workspace teardown must purge
						// it too or a stale entry survives (hidden by the open-tab gate, but
						// still leaked).
						const backgroundRunningTerminals: Record<
							string,
							V2ShellRunningEntry
						> = {};
						let bgChanged = false;
						for (const [tid, entry] of Object.entries(
							state.backgroundRunningTerminals,
						)) {
							if (entry.workspaceId === workspaceId) {
								bgChanged = true;
								continue;
							}
							backgroundRunningTerminals[tid] = entry;
						}
						const hadManual = workspaceId in state.manualUnread;
						if (!changed && !bgChanged && !hadManual) return state;
						const next: Partial<V2NotificationState> = {};
						if (changed) next.sources = sources;
						if (bgChanged)
							next.backgroundRunningTerminals = backgroundRunningTerminals;
						if (hadManual) {
							const { [workspaceId]: _removed, ...manualUnread } =
								state.manualUnread;
							next.manualUnread = manualUnread;
						}
						return next;
					});
				},
				clearWorkspaceAttention: (workspaceId) => {
					{
						// Log each source this call will clear (workspace match +
						// status "review"). One line per source so each carries its
						// own sourceKey. Read-only snapshot — no logic change.
						const now = Date.now();
						for (const [sourceKey, source] of Object.entries(
							useV2NotificationStore.getState().sources,
						)) {
							if (
								source.workspaceId === workspaceId &&
								source.status === "review"
							) {
								ndots({
									event: "store_mutation",
									mutation: "clearWorkspaceAttention",
									sourceKey,
									workspaceId,
									from: source.status,
									to: null,
									occurredAt: now,
								});
							}
						}
					}
					set((state) => {
						const sources: Record<string, V2NotificationStatusEntry> = {};
						let changed = false;
						for (const [sourceKey, source] of Object.entries(state.sources)) {
							if (
								source.workspaceId === workspaceId &&
								source.status === "review"
							) {
								changed = true;
								continue;
							}
							sources[sourceKey] = source;
						}
						const hadManual = workspaceId in state.manualUnread;
						if (!changed && !hadManual) return state;
						const next: Partial<V2NotificationState> = {};
						if (changed) next.sources = sources;
						if (hadManual) {
							const { [workspaceId]: _removed, ...manualUnread } =
								state.manualUnread;
							next.manualUnread = manualUnread;
						}
						return next;
					});
				},
			}),
			{
				name: "v2-notification-dots",
				storage: createJSONStorage(() => window.sessionStorage),
				partialize: (state) => ({
					sources: state.sources,
					shellRunningTerminals: state.shellRunningTerminals,
					backgroundRunningTerminals: state.backgroundRunningTerminals,
					manualUnread: state.manualUnread,
					terminalSeenAt: state.terminalSeenAt,
					agentTerminals: state.agentTerminals,
				}),
			},
		),
		{ name: "V2Notifications" },
	),
);

export function getV2NotificationSourceKey(
	source: V2NotificationSourceInput,
): V2NotificationSourceKey {
	if (typeof source === "string") return source;
	return `${source.type}:${source.id}`;
}

export function getV2TerminalNotificationSource(
	terminalId: string,
): V2NotificationSource {
	return { type: "terminal", id: terminalId };
}

export function getV2ChatNotificationSource(
	chatId: string,
): V2NotificationSource {
	return { type: "chat", id: chatId };
}

export function getV2ManualNotificationSource(
	workspaceId: string,
): V2NotificationSource {
	return { type: "manual", id: workspaceId };
}

export function getV2NotificationSourcesForPane(
	pane: V2NotificationPaneLike | null | undefined,
): V2NotificationSource[] {
	const terminalId = getTerminalIdForPane(pane);
	if (terminalId) return [getV2TerminalNotificationSource(terminalId)];
	const chatId = getChatIdForPane(pane);
	if (chatId) return [getV2ChatNotificationSource(chatId)];
	return [];
}

export function getV2NotificationSourcesForTab(
	tab: V2NotificationTabLike | null | undefined,
): V2NotificationSource[] {
	if (!tab) return [];
	const sources = new Map<V2NotificationSourceKey, V2NotificationSource>();
	for (const pane of Object.values(tab.panes)) {
		for (const source of getV2NotificationSourcesForPane(pane)) {
			sources.set(getV2NotificationSourceKey(source), source);
		}
	}
	return [...sources.values()];
}

/**
 * Used by close (races against host exit) and interrupt (pty stays alive,
 * no host exit) — neither can rely on the `terminal:lifecycle` exit path.
 */
export function clearV2TerminalRunStatus(
	terminalId: string,
	workspaceId: string,
): void {
	const store = useV2NotificationStore.getState();
	store.clearSourceStatus(
		getV2TerminalNotificationSource(terminalId),
		workspaceId,
	);
	// (BA) The cloud/background-running blue axis has NO OSC self-clear (unlike
	// shell-running, which clears on the 133;D command-end). Both interrupt
	// (Ctrl+C/Esc, useTerminalInterruptClear) and pane close (usePaneRegistry
	// onAfterClose) route through here, so clear it too — otherwise a stale blue
	// dot lingers on a live/closed terminal until some later agent event.
	store.clearTerminalBackgroundRunning(terminalId);
}

/**
 * Terminal IDs that currently belong to an OPEN pane in the workspace's
 * persisted v2 pane layout (`v2WorkspaceLocalState.paneLayout`) — the SAME
 * cross-workspace source of truth the v2 workspace page hydrates from (and
 * that `V2NotificationController` reads). Used to GATE the workspace-level
 * status / unread / per-terminal-dot selectors below so a CLOSED (or
 * never-opened) terminal's lingering notification entry is never represented
 * — by construction, "any tab closed is never representable."
 *
 * This is the safe form of the reverted (AI) orphan prune: the signal is the
 * renderer's open-tabs layout, NOT JSONL session presence (which wrongly
 * killed live-but-quiet dots). Render-time filter only — the store is never
 * mutated, so there is no reconcile race.
 *
 * The returned Set's identity changes only when the id set itself changes (it
 * is derived from a sorted, comma-joined key) so consumers don't re-fire on
 * every store tick. Cache-first (AGENTS.md rule 9): empty until the row
 * hydrates, so dots resolve once the layout is known rather than flashing
 * stale entries. The workspace rollup and unread hooks subscribe independently
 * to this cheap local-collection query.
 *
 * (CHIP-DOT-UNIFY) The surviving sidebar chip consumer is
 * `useV2WorkspaceTabChips` below. It reads the same pane layout directly so
 * chip liveness and workspace liveness cannot disagree.
 */
export function useV2WorkspaceOpenTerminalIds(
	workspaceId: string,
): ReadonlySet<string> {
	const collections = useCollections();
	const { data: rows = [] } = useLiveQuery(
		(q) =>
			q
				.from({ local: collections.v2WorkspaceLocalState })
				.where(({ local }) => eq(local.workspaceId, workspaceId))
				.select(({ local }) => ({ paneLayout: local.paneLayout })),
		[collections, workspaceId],
	);
	const paneLayout = rows[0]?.paneLayout as
		| WorkspaceState<unknown>
		| null
		| undefined;
	const key = useMemo(() => {
		if (!paneLayout) return "";
		const ids = new Set<string>();
		for (const tab of paneLayout.tabs ?? []) {
			for (const pane of Object.values(tab.panes ?? {})) {
				const terminalId = getTerminalIdForPane(pane);
				if (terminalId) ids.add(terminalId);
			}
		}
		return [...ids].sort().join(",");
	}, [paneLayout]);
	return useMemo(() => new Set(key ? key.split(",") : []), [key]);
}

/**
 * A terminal source whose terminal is NOT in the workspace's open-pane set —
 * a closed/never-opened terminal whose lingering entry must not be
 * represented. Chat/manual sources are never closed-terminals. When
 * `openTerminalIds` is undefined the gate is disabled (ungated, back-compat).
 */
function isClosedTerminalSource(
	entry: V2NotificationStatusEntry,
	openTerminalIds: ReadonlySet<string> | undefined,
): boolean {
	return (
		entry.source.type === "terminal" &&
		!!openTerminalIds &&
		!openTerminalIds.has(entry.source.id)
	);
}

// ---------------------------------------------------------------------------
// (AY/BA) THE single display-status derivation. Every dot surface — tab dot,
// terminal pane-header dot, sidebar per-terminal row, sidebar workspace
// rollup, kanban card — derives from these two functions, so two surfaces can
// never disagree: the workspace rollup IS the fold of the per-source dots.
// Precedence red > yellow > blue > green, applied per source and at the fold.
// ---------------------------------------------------------------------------

const DISPLAY_STATUS_PRIORITY: readonly DisplayStatus[] = [
	"permission",
	"working",
	"shell-running",
	"background-running",
	"review",
];

export function getHighestPriorityDisplayStatus(
	statuses: Iterable<DisplayStatus | null>,
): DisplayStatus | null {
	let best: DisplayStatus | null = null;
	let bestRank = DISPLAY_STATUS_PRIORITY.length;
	for (const status of statuses) {
		if (!status) continue;
		const rank = DISPLAY_STATUS_PRIORITY.indexOf(status);
		if (rank !== -1 && rank < bestRank) {
			best = status;
			bestRank = rank;
			if (rank === 0) break;
		}
	}
	return best;
}

// Typed tie to the canonical key format (`${source.type}:${source.id}` in
// getV2NotificationSourceKey) — a drift in the source-type name fails to
// compile instead of silently breaking the blue-axis decode.
const TERMINAL_SOURCE_PREFIX =
	`${"terminal" satisfies V2NotificationSourceType}:` as const;

/**
 * What ONE source's dot shows: agent permission/working (red/yellow) win;
 * else a terminal's shell-running / background-running blue; else the agent's
 * review (green); else nothing. Blue axes exist only for terminal sources.
 */
function getSourceDisplayStatus(
	state: V2NotificationState,
	workspaceId: string,
	sourceKey: V2NotificationSourceKey,
): DisplayStatus | null {
	const entry = state.sources[sourceKey];
	const agentStatus = entry?.workspaceId === workspaceId ? entry.status : null;
	if (agentStatus === "permission" || agentStatus === "working") {
		return agentStatus;
	}
	if (sourceKey.startsWith(TERMINAL_SOURCE_PREFIX)) {
		const terminalId = sourceKey.slice(TERMINAL_SOURCE_PREFIX.length);
		// The blue axes are keyed by terminalId. Upstream 1.13.1's terminal
		// lifecycle event no longer carries a workspaceId to key the shell-running
		// entry by, so the terminal→workspace scoping is enforced by the callers'
		// open-terminal gate instead: every call site passes a terminal that
		// belongs to `workspaceId` (a pane's own terminal, or an open terminal of
		// this workspace). A present entry is therefore this workspace's blue dot.
		// (AGENT-SHELL-BLUE) OSC-133 shell-running applies to PLAIN shells only:
		// on an agent terminal the agent CLI itself is the long-running
		// foreground command, so command-start latches for the whole session
		// (see the AUTO-RESUME note in host-service terminal.ts) and would paint
		// every idle agent tab blue over its green. The gate is the DURABLE
		// agentTerminals registry, not the transient sources entry — mark-seen /
		// turn-end clear that entry while the OSC latch persists. Agent
		// terminals take blue only from the background-tasks axis below.
		if (
			!state.agentTerminals[terminalId] &&
			state.shellRunningTerminals[terminalId]
		) {
			return "shell-running";
		}
		if (state.backgroundRunningTerminals[terminalId]) {
			return "background-running";
		}
	}
	return agentStatus;
}

/**
 * Highest-priority status across a workspace's sources. Terminal sources are
 * gated to `openTerminalIds` (when provided) so closed terminals don't tint
 * the workspace icon; chat/manual sources are always considered.
 */
export function selectV2WorkspaceNotificationStatus(
	workspaceId: string,
	openTerminalIds?: ReadonlySet<string>,
) {
	return (state: V2NotificationState) => {
		function* statuses() {
			for (const source of Object.values(state.sources)) {
				if (source.workspaceId !== workspaceId) continue;
				if (isClosedTerminalSource(source, openTerminalIds)) continue;
				yield source.status;
			}
		}
		return getHighestPriorityStatus(statuses());
	};
}

/**
 * (TAB-CHIPS) Ordered tab models from the persisted pane layout. Each status is
 * a fold of that tab's explicit pane sources through the shared display-status
 * primitive, so closed panes are unrepresentable and plain shell blue remains
 * visible without consulting terminal session liveness.
 */
export function useV2WorkspaceTabChips(
	workspaceId: string,
	enabled = true,
): V2WorkspaceTabChipData[] {
	const collections = useCollections();
	const { data: rows = [] } = useLiveQuery(
		(q) =>
			q
				.from({ local: collections.v2WorkspaceLocalState })
				.where(({ local }) => eq(local.workspaceId, enabled ? workspaceId : ""))
				.select(({ local }) => ({ paneLayout: local.paneLayout })),
		[collections, workspaceId, enabled],
	);
	const paneLayout = rows[0]?.paneLayout as
		| WorkspaceState<unknown>
		| null
		| undefined;
	const tabs = useMemo(() => {
		if (!enabled || !paneLayout) return [];
		return paneLayout.tabs.map((tab) => ({
			tabId: tab.id,
			titleOverride: tab.titleOverride,
			activePaneId: tab.activePaneId,
			panes: Object.values(tab.panes).map((pane) => ({
				id: pane.id,
				kind: pane.kind,
				titleOverride: pane.titleOverride,
				terminalId: getTerminalIdForPane(pane) ?? undefined,
				chatSessionId: getChatIdForPane(pane) ?? undefined,
				filePath: getFilePathForPane(pane) ?? undefined,
				browserPageTitle:
					getPaneDataString(pane, "browser", "pageTitle") ?? undefined,
				browserUrl: getPaneDataString(pane, "browser", "url") ?? undefined,
				commentAuthorLogin:
					getPaneDataString(pane, "comment", "authorLogin") ?? undefined,
			})),
			sources: getV2NotificationSourcesForTab(tab),
		}));
	}, [enabled, paneLayout]);
	const selector = useMemo(
		() =>
			enabled
				? (state: V2NotificationState) =>
						tabs
							.map(
								(tab) =>
									getHighestPriorityDisplayStatus(
										tab.sources.map((source) =>
											getSourceDisplayStatus(
												state,
												workspaceId,
												getV2NotificationSourceKey(source),
											),
										),
									) ?? "",
							)
							.join(",")
				: () => "",
		[enabled, tabs, workspaceId],
	);
	const displayKey = useV2NotificationStore(selector);
	return useMemo(() => {
		const statuses = displayKey.split(",");
		return tabs.map(({ sources: _sources, ...tab }, index) => ({
			...tab,
			status: (statuses[index] || null) as DisplayStatus | null,
		}));
	}, [displayKey, tabs]);
}

export function selectV2TabNotificationStatus(
	workspaceId: string,
	tab: V2NotificationTabLike | null | undefined,
) {
	return selectV2SourcesNotificationStatus(
		workspaceId,
		getV2NotificationSourcesForTab(tab),
	);
}

export function selectV2PaneNotificationStatus(
	workspaceId: string,
	pane: V2NotificationPaneLike | null | undefined,
) {
	return selectV2SourcesNotificationStatus(
		workspaceId,
		getV2NotificationSourcesForPane(pane),
	);
}

export function selectV2TerminalNotificationStatus(
	workspaceId: string,
	terminalId: string | null | undefined,
) {
	return selectV2SourcesNotificationStatus(
		workspaceId,
		terminalId ? [getV2TerminalNotificationSource(terminalId)] : [],
	);
}

export function selectV2ChatNotificationStatus(
	workspaceId: string,
	chatId: string | null | undefined,
) {
	return selectV2SourcesNotificationStatus(
		workspaceId,
		chatId ? [getV2ChatNotificationSource(chatId)] : [],
	);
}

export function selectV2SourcesNotificationStatus(
	workspaceId: string,
	sources: Iterable<V2NotificationSourceInput>,
) {
	const sourceKeys = [...new Set([...sources].map(getV2NotificationSourceKey))];
	return (state: V2NotificationState) =>
		selectStatusForSourceKeys(state, workspaceId, sourceKeys);
}

/**
 * (AY/BA) Display status for an explicit source set — the TAB dot and the
 * terminal pane-header dot. A straight fold of the per-source primitive, so
 * it can never disagree with the workspace rollup (the same fold over all
 * open sources).
 */
export function selectV2SourcesDisplayStatus(
	workspaceId: string,
	sources: Iterable<V2NotificationSourceInput>,
) {
	const sourceKeys = [...new Set([...sources].map(getV2NotificationSourceKey))];
	return (state: V2NotificationState): DisplayStatus | null =>
		getHighestPriorityDisplayStatus(
			sourceKeys.map((sourceKey) =>
				getSourceDisplayStatus(state, workspaceId, sourceKey),
			),
		);
}

export function useV2SourcesDisplayStatus(
	workspaceId: string,
	sources: Iterable<V2NotificationSourceInput>,
): DisplayStatus | null {
	return useV2NotificationStore(
		selectV2SourcesDisplayStatus(workspaceId, sources),
	);
}

/**
 * (AY/BA) The single status the WORKSPACE ICON should render: the SAME
 * per-source fold the tab dots render, accumulated over every open source —
 * the sidebar literally represents the dots in the tabs, so they can never
 * drift. Terminal sources are gated to OPEN terminals; chat/manual sources
 * always count. Precedence red > yellow > blue > green lives in the shared
 * primitive, never here and never in `sources`.
 */
export function selectV2WorkspaceDisplayStatus(
	workspaceId: string,
	// REQUIRED: scopes terminal agent and blue-axis state to open panes.
	openTerminalIds: ReadonlySet<string>,
) {
	return (state: V2NotificationState): DisplayStatus | null => {
		function* statuses() {
			for (const [sourceKey, entry] of Object.entries(state.sources)) {
				if (entry.workspaceId !== workspaceId) continue;
				if (isClosedTerminalSource(entry, openTerminalIds)) continue;
				// Object.entries widens the key to string; the store only ever
				// writes canonical source keys.
				yield getSourceDisplayStatus(
					state,
					workspaceId,
					sourceKey as V2NotificationSourceKey,
				);
			}
			// Open terminals whose ONLY state is a blue axis (plain shell, no
			// agent source entry) still get their dot represented.
			for (const terminalId of openTerminalIds) {
				const sourceKey: V2NotificationSourceKey = `${TERMINAL_SOURCE_PREFIX}${terminalId}`;
				if (state.sources[sourceKey]) continue; // folded above
				yield getSourceDisplayStatus(state, workspaceId, sourceKey);
			}
		}
		return getHighestPriorityDisplayStatus(statuses());
	};
}

export function useV2WorkspaceDisplayStatus(
	workspaceId: string,
): DisplayStatus | null {
	const openTerminalIds = useV2WorkspaceOpenTerminalIds(workspaceId);
	const selector = useMemo(
		() => selectV2WorkspaceDisplayStatus(workspaceId, openTerminalIds),
		[workspaceId, openTerminalIds],
	);
	return useV2NotificationStore(selector);
}

export function selectV2WorkspaceIsUnread(
	workspaceId: string,
	openTerminalIds?: ReadonlySet<string>,
) {
	return (state: V2NotificationState) => {
		for (const entry of Object.values(state.sources)) {
			if (entry.workspaceId !== workspaceId) continue;
			if (isClosedTerminalSource(entry, openTerminalIds)) continue;
			if (entry.status === "review") return true;
		}
		return false;
	};
}

export function useV2WorkspaceIsUnread(workspaceId: string) {
	const openTerminalIds = useV2WorkspaceOpenTerminalIds(workspaceId);
	const selector = useMemo(
		() => selectV2WorkspaceIsUnread(workspaceId, openTerminalIds),
		[workspaceId, openTerminalIds],
	);
	return useV2NotificationStore(selector);
}

export function useV2TabNotificationStatus(
	workspaceId: string,
	tab: V2NotificationTabLike | null | undefined,
) {
	return useV2NotificationStore(
		selectV2TabNotificationStatus(workspaceId, tab),
	);
}

export function useV2PaneNotificationStatus(
	workspaceId: string,
	pane: V2NotificationPaneLike | null | undefined,
) {
	return useV2NotificationStore(
		selectV2PaneNotificationStatus(workspaceId, pane),
	);
}

export function useV2TerminalNotificationStatus(
	workspaceId: string,
	terminalId: string | null | undefined,
) {
	return useV2NotificationStore(
		selectV2TerminalNotificationStatus(workspaceId, terminalId),
	);
}

export function useV2ChatNotificationStatus(
	workspaceId: string,
	chatId: string | null | undefined,
) {
	return useV2NotificationStore(
		selectV2ChatNotificationStatus(workspaceId, chatId),
	);
}

function selectStatusForSourceKeys(
	state: V2NotificationState,
	workspaceId: string,
	sourceKeys: Iterable<V2NotificationSourceKey>,
) {
	function* statuses() {
		for (const sourceKey of sourceKeys) {
			const source = state.sources[sourceKey];
			if (source?.workspaceId === workspaceId) {
				yield source.status;
			}
		}
	}
	return getHighestPriorityStatus(statuses());
}

function getTerminalIdForPane(
	pane: V2NotificationPaneLike | null | undefined,
): string | null {
	if (!pane || pane.kind !== "terminal") return null;
	if (!pane.data || typeof pane.data !== "object") return null;
	const terminalId = (pane.data as { terminalId?: unknown }).terminalId;
	return typeof terminalId === "string" && terminalId ? terminalId : null;
}

function getChatIdForPane(
	pane: V2NotificationPaneLike | null | undefined,
): string | null {
	if (!pane || pane.kind !== "chat") return null;
	if (!pane.data || typeof pane.data !== "object") return null;
	const sessionId = (pane.data as { sessionId?: unknown }).sessionId;
	return typeof sessionId === "string" && sessionId ? sessionId : null;
}

function getPaneDataString(
	pane: V2NotificationPaneLike | null | undefined,
	kind: string,
	field: string,
): string | null {
	if (!pane || pane.kind !== kind) return null;
	if (!pane.data || typeof pane.data !== "object") return null;
	const value = (pane.data as Record<string, unknown>)[field];
	return typeof value === "string" && value ? value : null;
}

function getFilePathForPane(
	pane: V2NotificationPaneLike | null | undefined,
): string | null {
	if (!pane || pane.kind !== "file") return null;
	if (!pane.data || typeof pane.data !== "object") return null;
	const filePath = (pane.data as { filePath?: unknown }).filePath;
	return typeof filePath === "string" && filePath ? filePath : null;
}

// (render-dot diagnostic) Snapshot every dot's ACTUALLY-rendered status once
// per second into a SEPARATE log so it can be matched against the watcher's
// emit log (~/.superset/agent-watcher-debug.log) by source key + workspaceId.
// The store is the single source the StatusIndicator dots render from, so this
// faithfully captures what the user sees. Renderer-only, started once per
// window. Forwarded via console.info with a "[render-dot]" prefix that the
// main process (main.ts) routes to ~/.superset/agent-dot-render.log. Never
// throws; logs nothing when no sources exist (idle window).
{
	const w = globalThis as { __supersetDotRenderLog?: boolean };
	if (typeof window !== "undefined" && !w.__supersetDotRenderLog) {
		w.__supersetDotRenderLog = true;
		setInterval(() => {
			try {
				const state = useV2NotificationStore.getState();
				const dots = Object.entries(state.sources).map(([key, entry]) => ({
					key,
					workspaceId: entry.workspaceId,
					status: entry.status,
				}));
				// (BA diagnostic) Also snapshot the SEPARATE blue axes — the agent
				// `sources` snapshot above never showed these, so a never-set vs
				// set-but-masked blue dot was indistinguishable from logs alone.
				const bg = Object.entries(state.backgroundRunningTerminals).map(
					([terminalId, entry]) => ({
						terminalId,
						workspaceId: entry.workspaceId,
					}),
				);
				const shell = Object.entries(state.shellRunningTerminals).map(
					([terminalId, entry]) => ({
						terminalId,
						workspaceId: entry.workspaceId,
					}),
				);
				if (dots.length > 0 || bg.length > 0 || shell.length > 0) {
					console.info(`[render-dot] ${JSON.stringify({ dots, bg, shell })}`);
				}
			} catch {
				// never let diagnostics break the renderer
			}
		}, 1000);
	}
}
