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

export type V2NotificationSource =
	| { type: "terminal"; id: string }
	| { type: "chat"; id: string }
	| { type: "manual"; id: string };

export type V2NotificationSourceType = V2NotificationSource["type"];
export type V2NotificationSourceKey = `${V2NotificationSourceType}:${string}`;
export type V2NotificationSourceInput =
	| V2NotificationSource
	| V2NotificationSourceKey;

export interface V2NotificationStatusEntry {
	sourceKey: V2NotificationSourceKey;
	source: V2NotificationSource;
	workspaceId: string;
	status: ActivePaneStatus;
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

export const useV2NotificationStore = create<V2NotificationState>()((set) => ({
	sources: {},
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
	setSourceStatus: (source, workspaceId, status, occurredAt = Date.now()) => {
		const sourceKey = getV2NotificationSourceKey(source);
		ndots({
			event: "store_mutation",
			mutation: "setSourceStatus",
			sourceKey,
			workspaceId,
			from:
				useV2NotificationStore.getState().sources[sourceKey]?.status ?? null,
			to: status,
			occurredAt,
		});
		set((state) => ({
			sources: {
				...state.sources,
				[sourceKey]: {
					sourceKey,
					source,
					workspaceId,
					status,
					occurredAt,
				},
			},
		}));
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
				useV2NotificationStore.getState().sources[sourceKey]?.status ?? null,
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
			const backgroundRunningTerminals: Record<string, V2ShellRunningEntry> =
				{};
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
			if (!changed && !bgChanged) return state;
			const next: Partial<V2NotificationState> = {};
			if (changed) next.sources = sources;
			if (bgChanged)
				next.backgroundRunningTerminals = backgroundRunningTerminals;
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
				if (source.workspaceId === workspaceId && source.status === "review") {
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
				if (source.workspaceId === workspaceId && source.status === "review") {
					changed = true;
					continue;
				}
				sources[sourceKey] = source;
			}
			return changed ? { sources } : state;
		});
	},
}));

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
 * stale entries. NOTE: each of the three consumer hooks below subscribes
 * independently (≤3 identical live queries per workspace row); kept this way
 * to keep the patch to store.ts only — hoisting into DashboardSidebarWorkspaceItem
 * would touch a heavily-patched (P+AG+AL) file for a cheap local-collection query.
 */
function useV2WorkspaceOpenTerminalIds(
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

function getHighestPriorityDisplayStatus(
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
const TERMINAL_SOURCE_PREFIX = `${"terminal" satisfies V2NotificationSourceType}:`;

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
		if (state.shellRunningTerminals[terminalId]?.workspaceId === workspaceId) {
			return "shell-running";
		}
		if (
			state.backgroundRunningTerminals[terminalId]?.workspaceId === workspaceId
		) {
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
 * (AY) Per-terminal DISPLAY statuses for a workspace, derived per terminal
 * from the SAME shared primitive as the tab dots and the workspace rollup.
 * Encoded inside the selector as a sorted `terminalId=status` string for
 * referential stability (the subscription only re-fires when a dot actually
 * changes), then decoded for the consumer.
 */
export function selectV2WorkspaceTerminalDisplayKey(
	workspaceId: string,
	// REQUIRED: every display-status surface gates on open terminals. (An
	// optional param had inverted "ungated" semantics between the sources loop
	// and the blue maps — most-permissive vs most-restrictive.)
	openTerminalIds: ReadonlySet<string>,
) {
	return (state: V2NotificationState): string => {
		const terminalIds = new Set<string>();
		for (const entry of Object.values(state.sources)) {
			if (entry.workspaceId !== workspaceId) continue;
			if (entry.source.type !== "terminal") continue;
			if (isClosedTerminalSource(entry, openTerminalIds)) continue;
			terminalIds.add(entry.source.id);
		}
		for (const map of [
			state.shellRunningTerminals,
			state.backgroundRunningTerminals,
		]) {
			for (const [terminalId, entry] of Object.entries(map)) {
				if (entry.workspaceId !== workspaceId) continue;
				if (openTerminalIds && !openTerminalIds.has(terminalId)) continue;
				terminalIds.add(terminalId);
			}
		}
		const parts: string[] = [];
		for (const terminalId of terminalIds) {
			const status = getSourceDisplayStatus(
				state,
				workspaceId,
				`${TERMINAL_SOURCE_PREFIX}${terminalId}`,
			);
			if (status) parts.push(`${terminalId}=${status}`);
		}
		parts.sort();
		return parts.join(",");
	};
}

export function useV2WorkspaceTerminalStatuses(
	workspaceId: string,
): Array<{ terminalId: string; status: DisplayStatus }> {
	const openTerminalIds = useV2WorkspaceOpenTerminalIds(workspaceId);
	const selector = useMemo(
		() => selectV2WorkspaceTerminalDisplayKey(workspaceId, openTerminalIds),
		[workspaceId, openTerminalIds],
	);
	const key = useV2NotificationStore(selector);
	return useMemo(() => {
		const result: Array<{ terminalId: string; status: DisplayStatus }> = [];
		if (!key) return result;
		for (const pair of key.split(",")) {
			const eq = pair.indexOf("=");
			if (eq < 0) continue;
			result.push({
				terminalId: pair.slice(0, eq),
				status: pair.slice(eq + 1) as DisplayStatus,
			});
		}
		return result;
	}, [key]);
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
	// REQUIRED — see selectV2WorkspaceTerminalDisplayKey.
	openTerminalIds: ReadonlySet<string>,
) {
	return (state: V2NotificationState): DisplayStatus | null => {
		function* statuses() {
			for (const [sourceKey, entry] of Object.entries(state.sources)) {
				if (entry.workspaceId !== workspaceId) continue;
				if (isClosedTerminalSource(entry, openTerminalIds)) continue;
				yield getSourceDisplayStatus(state, workspaceId, sourceKey);
			}
			// Open terminals whose ONLY state is a blue axis (plain shell, no
			// agent source entry) still get their dot represented.
			for (const terminalId of openTerminalIds) {
				const sourceKey = `${TERMINAL_SOURCE_PREFIX}${terminalId}`;
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
