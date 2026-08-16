/**
 * (ALERT-CONTEXT-NAMES) What a companion alert should call each terminal's tab.
 *
 * PURE, AND DELIBERATELY SO. It takes a persisted pane layout plus a way to ask
 * for a terminal's live title, and returns a snapshot. No React, no store, no
 * network: the whole thing is one function whose output is a value, which is
 * what makes the duplicate-appearance policy and the title precedence testable
 * without mounting anything.
 *
 * WHY THE RENDERER OWNS THIS AT ALL. A tab's title exists in exactly one place:
 * here. `host.db` has a `terminal_sessions` row and no column that could hold a
 * user's rename, a pane title, or the title a program set through OSC 0/2. So
 * the host asks the renderer, and this is the answer it gets.
 *
 * PRECEDENCE — resolved ONCE PER TAB (see `resolveTabTitle`):
 *
 *   1. the tab's own `titleOverride` — the user renamed the tab; nothing beats
 *      an explicit instruction;
 *   2. the TITLE PANE's `titleOverride` — the user renamed the pane that names
 *      the tab;
 *   3. the title pane's live terminal title, when that pane IS a terminal —
 *      what the shell or agent currently calls itself, the useful name almost
 *      always;
 *   4. nothing.
 *
 * IT IS DELIBERATELY NARROWER THAN THE SIDEBAR'S OWN LADDER, and this is a
 * PRIVACY boundary rather than an omission. `resolveDashboardSidebarTabTitle`
 * falls through to names it DERIVES from pane contents — a file's basename, a
 * browser tab's page title or host, a comment author's login. Those are free
 * text about what the user is working on, and the 2026-08-16 waiver covers
 * exactly three names: project, workspace and tab. A derived pane name is none
 * of them, so it must never reach an FCM payload. Recorded in FINAL.md §8.
 *
 * The practical consequence, and it is intended: a non-terminal pane names the
 * tab ONLY through an explicit rename (step 2, which is the user's own words
 * about their own tab). A diff pane the user has not renamed contributes
 * nothing, and step 4 applies.
 *
 *   Step 4 — nothing — also covers a tab whose only honest name would be the
 *   generic word "Terminal": `tn: ""` makes the phone say "Finished — ready for
 *   review", which is better than "Terminal — finished, ready for review",
 *   which reads like a name and is not one.
 *
 * WHICH PANE NAMES A SPLIT TAB is the sidebar's rule verbatim: the only pane if
 * there is one, otherwise the ACTIVE pane, otherwise nothing. A tab split three
 * ways with no active pane has no single honest name. Every terminal in the tab
 * then receives that ONE title — a tab has one name, and resolving per terminal
 * let two panes of the same tab disagree and lose the title to the ambiguity
 * rule below.
 *
 * DUPLICATE APPEARANCE. One terminal can be open in two TABS. If both resolve
 * the SAME title, that is not a conflict and the title stands. If they differ,
 * the terminal's title is dropped (`""`): naming one of the two would be a coin
 * flip about which tab the user means, and the project and workspace names —
 * which are unambiguous — still carry the alert.
 */

import type { Pane, Tab, WorkspaceState } from "@superset/panes";

/**
 * What a terminal's title becomes when two TABS holding it disagree. Same
 * sentinel the host uses for the same reason: absence is spelled `""`.
 */
const AMBIGUOUS = "";

export interface AlertContextTerminal {
	terminalId: string;
	/** `""` when no title resolved, or when the terminal is ambiguous. */
	tabTitle: string;
}

export interface AlertContextSnapshot {
	/** How many tabs the workspace has. The phone omits the tab below 2. */
	tabCount: number;
	/** One entry per DISTINCT terminal id, in first-appearance order. */
	terminals: AlertContextTerminal[];
}

/**
 * (ALERT-CONTEXT-NAMES) One terminal pane, identified the way the terminal
 * RUNTIME REGISTRY identifies it.
 *
 * A terminal's runtime is keyed by `(terminalId, paneId)` — `TerminalPane`
 * mounts it with `pane.id` as the instance — so a terminal id ALONE cannot
 * address a runtime. Anything that wants a live title, or a title listener,
 * needs the pair. Deliberately NOT part of `AlertContextSnapshot`: pane ids are
 * renderer-local plumbing and have no business on the wire.
 */
export interface TerminalPaneRef {
	terminalId: string;
	paneId: string;
}

/**
 * Every terminal pane in a layout, as `(terminalId, paneId)` pairs.
 *
 * Exists for listener RECONCILIATION: the subscriber has to subscribe to the
 * exact instance that carries the title events, and to do it without minting a
 * default entry for one that does not exist.
 */
export function collectTerminalPaneRefs(
	paneLayout: WorkspaceState<unknown> | null | undefined,
): TerminalPaneRef[] {
	const refs: TerminalPaneRef[] = [];
	for (const tab of (paneLayout?.tabs ?? []) as Tab<unknown>[]) {
		for (const pane of Object.values(tab.panes ?? {}) as Pane<unknown>[]) {
			const terminalId = terminalIdOfPane(pane);
			if (terminalId === null) continue;
			refs.push({ terminalId, paneId: pane.id });
		}
	}
	return refs;
}

/**
 * The live-title lookup, as the app supplies it
 * (`terminalRuntimeRegistry.getTitle`). BOTH ids are required: the registry
 * keys runtimes by `(terminalId, instanceId)` and V2's instance id is the PANE
 * id, so passing the terminal id alone falls back to a "primary" entry that may
 * be a different pane's runtime — or, once a shadow default entry exists, an
 * empty one.
 */
type GetTerminalTitle = (
	terminalId: string,
	paneId: string,
) => string | null | undefined;

/** The one fact a terminal pane carries that this module needs. */
function terminalIdOfPane(
	pane: Pane<unknown> | null | undefined,
): string | null {
	if (!pane || pane.kind !== "terminal") return null;
	if (!pane.data || typeof pane.data !== "object") return null;
	const terminalId = (pane.data as { terminalId?: unknown }).terminalId;
	return typeof terminalId === "string" && terminalId.length > 0
		? terminalId
		: null;
}

function paneTitleOverride(pane: Pane<unknown> | null | undefined): string {
	const override = (pane as { titleOverride?: unknown } | null | undefined)
		?.titleOverride;
	return typeof override === "string" ? override.trim() : "";
}

/** The sidebar's own rule: the only pane, else the active pane, else none. */
function titlePaneOf(tab: Tab<unknown>): Pane<unknown> | undefined {
	const panes = Object.values(tab.panes ?? {}) as Pane<unknown>[];
	if (panes.length === 1) return panes[0];
	if (!tab.activePaneId) return undefined;
	return panes.find((pane) => pane.id === tab.activePaneId);
}

/**
 * The title of ONE tab, resolved ONCE — never per terminal inside it.
 *
 * A tab has a single name, so a split tab holding two terminals must report the
 * same name for both. Resolving per-pane looked equivalent while every pane in
 * the tab agreed, and diverged the moment one of them carried a `titleOverride`
 * the other did not: the two terminals then reported different titles for one
 * tab, and the duplicate-appearance rule below read that as ambiguity and threw
 * the title away for a tab that has never been ambiguous.
 *
 * The precedence:
 *
 *   1. the tab's `titleOverride` — the user renamed the tab;
 *   2. the TITLE PANE's `titleOverride` — the user renamed the pane that names
 *      the tab. Which pane that is comes from the sidebar's rule: the only pane
 *      if there is one, else the ACTIVE pane, else none;
 *   3. if that title pane is a terminal, its live title;
 *   4. nothing.
 *
 * A NON-TERMINAL TITLE PANE NAMES THE TAB ONLY THROUGH AN EXPLICIT RENAME —
 * step 2 and no further. It deliberately does NOT reach for the sidebar's
 * `getPaneTitle`, which DERIVES a name from pane contents (a file's basename, a
 * browser page title or host, a comment author's login). Those are free text
 * about what the user is working on, and the 2026-08-16 waiver covers three
 * names only: project, workspace and tab. So a diff pane the user has renamed
 * "Changes" names the tab, and an unrenamed one contributes nothing rather than
 * leaking a filename to FCM. See the header and FINAL.md §8.
 *
 * Step 3 is likewise conditional on the title pane BEING the terminal, not on
 * the tab merely containing one: borrowing a terminal's live title for a tab
 * the user is viewing a diff in would label the notification with a pane nobody
 * is looking at.
 */
function resolveTabTitle(
	tab: Tab<unknown>,
	getTerminalTitle: GetTerminalTitle,
): string {
	const tabOverride =
		typeof tab.titleOverride === "string" ? tab.titleOverride.trim() : "";
	if (tabOverride.length > 0) return tabOverride;

	const titlePane = titlePaneOf(tab);
	if (titlePane === undefined) return "";

	const paneOverride = paneTitleOverride(titlePane);
	if (paneOverride.length > 0) return paneOverride;

	const titlePaneTerminalId = terminalIdOfPane(titlePane);
	if (titlePaneTerminalId === null) return "";
	// The PANE id is the runtime's instance id — a terminal id alone addresses
	// no runtime in V2.
	return safeTerminalTitle(getTerminalTitle, titlePaneTerminalId, titlePane.id);
}

export function extractAlertContexts({
	paneLayout,
	getTerminalTitle,
}: {
	paneLayout: WorkspaceState<unknown> | null | undefined;
	getTerminalTitle: GetTerminalTitle;
}): AlertContextSnapshot {
	const tabs = (paneLayout?.tabs ?? []) as Tab<unknown>[];
	// Not `terminals.length`: a workspace's tab count is what the PHONE uses to
	// decide whether naming a tab is even meaningful, and a tab holding a file or
	// a browser counts towards "this workspace has more than one thing open"
	// exactly as a terminal tab does.
	const tabCount = tabs.length;

	/** terminalId -> resolved title, or `AMBIGUOUS` once two TABS disagree. */
	const titles = new Map<string, string>();
	const order: string[] = [];

	for (const tab of tabs) {
		// ONCE PER TAB, then handed to every terminal in it: the alert names the
		// TAB the user would click, not the pane.
		const resolved = resolveTabTitle(tab, getTerminalTitle);

		for (const pane of Object.values(tab.panes ?? {}) as Pane<unknown>[]) {
			const terminalId = terminalIdOfPane(pane);
			if (terminalId === null) continue;

			if (!titles.has(terminalId)) {
				titles.set(terminalId, resolved);
				order.push(terminalId);
				continue;
			}
			const existing = titles.get(terminalId);
			if (existing !== resolved) titles.set(terminalId, AMBIGUOUS);
		}
	}

	return {
		tabCount,
		terminals: order.map((terminalId) => ({
			terminalId,
			tabTitle: titles.get(terminalId) ?? "",
		})),
	};
}

/**
 * The live-title lookup reaches into a runtime registry of open transports. It
 * has no business being able to break a snapshot, so anything it throws costs
 * that one terminal its live title and nothing else.
 */
function safeTerminalTitle(
	getTerminalTitle: GetTerminalTitle,
	terminalId: string,
	paneId: string,
): string {
	try {
		const title = getTerminalTitle(terminalId, paneId);
		return typeof title === "string" ? title.trim() : "";
	} catch {
		return "";
	}
}

/**
 * A stable fingerprint of a snapshot, so the sender can skip a sync that would
 * change nothing.
 *
 * These snapshots are recomputed on every layout live-query tick and every
 * terminal title change, which on a busy machine is several a second; without
 * this the host would take a mutation for each one. The hash is over exactly
 * what the wire carries, so two snapshots with the same hash are two snapshots
 * the host cannot tell apart.
 */
export function alertContextsHash(snapshot: AlertContextSnapshot): string {
	return JSON.stringify([
		snapshot.tabCount,
		snapshot.terminals.map((terminal) => [
			terminal.terminalId,
			terminal.tabTitle,
		]),
	]);
}
