/**
 * (ALERT-CONTEXT-NAMES) The TAB half of an alert's context, and the only part
 * of it host.db cannot answer.
 *
 * WHY A REGISTRY EXISTS AT ALL. A companion alert now says WHICH chat it is
 * about: `<project> · <workspace>` as the title, `<tab> — <event>` as the body.
 * Two of those three come straight off `host.db` (`findWorkspace`,
 * `listProjects`) and are as durable as the rows themselves. The third does not
 * exist there and cannot: a tab's title is renderer state — a user override, a
 * pane title, or the live title a terminal's own program set through OSC — and
 * `terminal_sessions` has no column for any of it. So the renderer, which is
 * the only process that knows, pushes a per-workspace SNAPSHOT here and this
 * module holds it for the alert path to read.
 *
 * IT IS A CACHE OF A DISPLAY DETAIL, AND IT IS TREATED AS ONE. Nothing here can
 * delay, hold, or fail an alert. Every lookup either answers with a title or
 * answers with nothing, the send proceeds either way, and the phone falls back
 * to its generic wording for a name it did not receive. That direction is
 * deliberate: a missing tab title costs the user a word, while a context lookup
 * that could fail a send would cost them the notification.
 *
 * PROCESS-LOCAL AND BOUNDED, never durable. A restart empties it and the next
 * renderer sync refills it (`HostNotificationSubscriber` re-sends on every
 * resync epoch, which a host restart produces by definition). Durable storage
 * would mean a schema change for something that is stale the moment the user
 * renames a tab.
 *
 * NO VALUE EVER REACHES A LOG. Diagnostics here count things and name ids; the
 * titles themselves are the private part and the whole point of the 2026-08-16
 * waiver being narrow is that this module does not widen it.
 */

import type { BridgeLogger } from "./http";
import type { HostDbReader } from "./read-api";

/**
 * (ALERT-CONTEXT-NAMES) How many workspaces keep a snapshot. LRU, oldest-first.
 *
 * Sized well past the largest real sidebar (183 workspaces on the machine this
 * was measured on) so eviction is a bound rather than a policy: an evicted
 * workspace costs its next alert a tab title, and the next sync restores it.
 */
export const ALERT_CONTEXT_MAX_WORKSPACES = 512;

/**
 * Terminals per workspace snapshot. A workspace with more open terminal panes
 * than this is not a workspace, it is a bug or a hostile caller; the snapshot is
 * REFUSED whole rather than truncated, because a half-applied snapshot would
 * silently mislabel whichever terminals fell off the end.
 */
export const ALERT_CONTEXT_MAX_TERMINALS_PER_WORKSPACE = 256;

/** Longest tab title accepted at the boundary, in UTF-16 units. */
export const ALERT_CONTEXT_MAX_TITLE_CHARS = 512;

/** Upper bound on a reported tab count. Same reasoning as the terminal cap. */
export const ALERT_CONTEXT_MAX_TAB_COUNT = 1_000;

/**
 * (ALERT-CONTEXT-NAMES) Everything an alert needs in order to name its chat.
 *
 * Names are RAW here and sanitised at the wire boundary
 * (`sanitizePushName`), not before: this shape is also what a diagnostic or a
 * future non-FCM surface would consume, and pre-truncating for FCM's byte
 * budget would bake one transport's limit into every consumer.
 */
export interface PushAlertContext {
	/** Opaque terminal handle (22 base64url chars), or `""` when unknown. */
	terminalHandle: string;
	projectName: string;
	workspaceName: string;
	/** `""` when no title resolved, or when the terminal is ambiguous. */
	tabTitle: string;
	/** `null` when the workspace has no snapshot; the phone then omits the tab. */
	tabCount: number | null;
}

/** One terminal's contribution to a workspace snapshot. */
export interface AlertContextTerminalInput {
	terminalId: string;
	/** `null`/absent means "no title resolved" — never an error. */
	tabTitle?: string | null;
}

export interface AlertContextSnapshotInput {
	hostWorkspaceId: string;
	tabCount: number;
	terminals: readonly AlertContextTerminalInput[];
}

/**
 * Why a snapshot was refused, or `"applied"` / `"evicted"`. Returned to the
 * caller rather than only logged: the renderer is a client of this and a
 * silently dropped sync would leave it believing its titles are live.
 */
export type AlertContextSyncOutcome =
	| "applied"
	| "evicted"
	| "unknown-workspace"
	| "too-many-terminals"
	| "bad-tab-count";

export interface AlertContextSyncResult {
	outcome: AlertContextSyncOutcome;
	/** How many terminals of the snapshot were kept (0 on a refusal). */
	terminals: number;
	/** Terminals dropped because host.db does not place them in this workspace. */
	rejectedTerminals: number;
	/** Terminals whose title was dropped as ambiguous (see `AMBIGUOUS`). */
	ambiguousTitles: number;
}

export interface AlertContextRegistry {
	/**
	 * ATOMIC REPLACE of one workspace's snapshot. Never a merge: the renderer
	 * sends the whole hydrated workspace, so a terminal absent from the new
	 * snapshot is a terminal whose pane was closed, and merging would keep
	 * labelling alerts with a tab that no longer exists.
	 */
	sync(input: AlertContextSnapshotInput): AlertContextSyncResult;
	/** The tab context for one terminal, or `null` when there is none. */
	lookup(
		hostWorkspaceId: string,
		hostTerminalId: string,
	): { tabTitle: string; tabCount: number } | null;
	/** Bridge stop. Nothing may survive a bridge that is no longer running. */
	clear(): void;
	/** Diagnostics only — counts, never values. */
	inspect(): { workspaces: number; terminals: number };
}

export interface AlertContextRegistryDeps {
	/**
	 * host.db, for the ONE relationship check that matters: does this terminal
	 * actually belong to this workspace? Required, never optional — without it
	 * any caller could label a workspace's alerts with another workspace's tab
	 * titles, which is the one way this cache could tell an actual lie.
	 */
	db: HostDbReader;
	logger: BridgeLogger;
}

/**
 * The sentinel a terminal's title becomes when one snapshot claims two
 * different titles for it (the same terminal rendered in two tabs, renamed in
 * one of them). Reporting either would be a coin flip about which tab the user
 * means, so the alert says nothing about the tab and keeps its project and
 * workspace names — which are unambiguous.
 */
const AMBIGUOUS = "";

interface WorkspaceSnapshot {
	tabCount: number;
	titlesByTerminalId: Map<string, string>;
}

export function createAlertContextRegistry(
	deps: AlertContextRegistryDeps,
): AlertContextRegistry {
	if (deps.db === null || deps.db === undefined) {
		throw new TypeError(
			"(ALERT-CONTEXT-NAMES) createAlertContextRegistry requires a host.db reader; without it a terminal could be labelled with another workspace's tab title",
		);
	}
	if (typeof deps.logger?.info !== "function") {
		throw new TypeError(
			"(ALERT-CONTEXT-NAMES) createAlertContextRegistry requires a logger",
		);
	}

	/** Insertion-ordered, which is what makes the LRU eviction below oldest-first. */
	const byWorkspace = new Map<string, WorkspaceSnapshot>();

	function evictOldest(): void {
		while (byWorkspace.size > ALERT_CONTEXT_MAX_WORKSPACES) {
			const oldest = byWorkspace.keys().next();
			if (oldest.done) return;
			byWorkspace.delete(oldest.value);
			// INFO, not error: an evicted snapshot costs a tab title, nothing more.
			deps.logger.info(
				"alert-context registry exceeded its bound; dropped the oldest workspace snapshot",
				{
					hostWorkspaceId: oldest.value,
					maxWorkspaces: ALERT_CONTEXT_MAX_WORKSPACES,
				},
			);
		}
	}

	return {
		sync(input) {
			const empty: AlertContextSyncResult = {
				outcome: "applied",
				terminals: 0,
				rejectedTerminals: 0,
				ambiguousTitles: 0,
			};

			if (
				!Number.isInteger(input.tabCount) ||
				input.tabCount < 0 ||
				input.tabCount > ALERT_CONTEXT_MAX_TAB_COUNT
			) {
				deps.logger.error(
					"refusing an alert-context snapshot with an implausible tab count",
					{ hostWorkspaceId: input.hostWorkspaceId, tabCount: input.tabCount },
				);
				return { ...empty, outcome: "bad-tab-count" };
			}
			if (input.terminals.length > ALERT_CONTEXT_MAX_TERMINALS_PER_WORKSPACE) {
				deps.logger.error(
					"refusing an alert-context snapshot with more terminals than a workspace can plausibly hold",
					{
						hostWorkspaceId: input.hostWorkspaceId,
						terminals: input.terminals.length,
						maxTerminals: ALERT_CONTEXT_MAX_TERMINALS_PER_WORKSPACE,
					},
				);
				return { ...empty, outcome: "too-many-terminals" };
			}

			// EMPTY EVICTS. A workspace whose last terminal pane closed has no tab
			// context, and keeping the previous snapshot would go on naming a tab
			// nobody has open.
			if (input.terminals.length === 0) {
				byWorkspace.delete(input.hostWorkspaceId);
				return { ...empty, outcome: "evicted" };
			}

			// THE RELATIONSHIP IS RE-DERIVED FROM host.db, never trusted from the
			// wire. The renderer is authenticated and local, but "authenticated" is
			// not "correct": a stale layout row, a workspace id typo, or a terminal
			// re-parented between the read and the send would otherwise attach one
			// workspace's tab title to another workspace's alert.
			//
			// ONE QUERY FOR THE WHOLE SNAPSHOT. The membership set is a fact about
			// this workspace, so it is read once and tested against; the point
			// lookup this replaced ran a statement per terminal to answer the same
			// question, on a path the renderer drives from ordinary layout changes.
			const placedHere = new Set(
				deps.db.listTerminalIdsForWorkspace(input.hostWorkspaceId),
			);
			const titlesByTerminalId = new Map<string, string>();
			let rejected = 0;
			let ambiguous = 0;
			for (const terminal of input.terminals) {
				const terminalId = terminal.terminalId;
				if (typeof terminalId !== "string" || terminalId.length === 0) {
					rejected++;
					continue;
				}
				if (!placedHere.has(terminalId)) {
					rejected++;
					continue;
				}
				const title =
					typeof terminal.tabTitle === "string" &&
					terminal.tabTitle.length > 0 &&
					terminal.tabTitle.length <= ALERT_CONTEXT_MAX_TITLE_CHARS
						? terminal.tabTitle
						: "";
				const existing = titlesByTerminalId.get(terminalId);
				if (existing !== undefined && existing !== title) {
					// Ambiguous: the same terminal, two different titles, one snapshot.
					titlesByTerminalId.set(terminalId, AMBIGUOUS);
					ambiguous++;
					continue;
				}
				titlesByTerminalId.set(terminalId, title);
			}

			if (rejected > 0) {
				deps.logger.info(
					"dropped alert-context terminals host.db does not place in this workspace",
					{ hostWorkspaceId: input.hostWorkspaceId, rejected },
				);
			}
			if (ambiguous > 0) {
				deps.logger.info(
					"a terminal appeared twice in one alert-context snapshot with different titles; its alerts will name no tab",
					{ hostWorkspaceId: input.hostWorkspaceId, ambiguous },
				);
			}

			if (titlesByTerminalId.size === 0) {
				byWorkspace.delete(input.hostWorkspaceId);
				return {
					outcome: "unknown-workspace",
					terminals: 0,
					rejectedTerminals: rejected,
					ambiguousTitles: ambiguous,
				};
			}

			// Delete-then-set so a re-synced workspace moves to the YOUNG end of the
			// insertion order; without it the LRU would evict whichever workspace was
			// synced first, however recently it was refreshed.
			byWorkspace.delete(input.hostWorkspaceId);
			byWorkspace.set(input.hostWorkspaceId, {
				tabCount: input.tabCount,
				titlesByTerminalId,
			});
			evictOldest();

			return {
				outcome: "applied",
				terminals: titlesByTerminalId.size,
				rejectedTerminals: rejected,
				ambiguousTitles: ambiguous,
			};
		},

		lookup(hostWorkspaceId, hostTerminalId) {
			const snapshot = byWorkspace.get(hostWorkspaceId);
			if (snapshot === undefined) return null;
			const tabTitle = snapshot.titlesByTerminalId.get(hostTerminalId);
			if (tabTitle === undefined) return null;
			return { tabTitle, tabCount: snapshot.tabCount };
		},

		clear() {
			byWorkspace.clear();
		},

		inspect() {
			let terminals = 0;
			for (const snapshot of byWorkspace.values()) {
				terminals += snapshot.titlesByTerminalId.size;
			}
			return { workspaces: byWorkspace.size, terminals };
		},
	};
}
