/**
 * (ALERT-CONTEXT-NAMES) What the renderer tells the host each tab is called.
 *
 * The rules under test are the ones a user would notice getting wrong: the
 * wrong name on the notification, a placeholder that reads like a name, or a
 * coin flip when one terminal is open in two tabs.
 */

import { describe, expect, it } from "bun:test";
import type { WorkspaceState } from "@superset/panes";
import { alertContextsHash, extractAlertContexts } from "./alertContexts";

function terminalPane(id: string, terminalId: string, titleOverride?: string) {
	return { id, kind: "terminal", data: { terminalId }, titleOverride };
}

function layout(
	tabs: Array<{
		id: string;
		titleOverride?: string;
		activePaneId?: string | null;
		panes: ReturnType<typeof terminalPane>[];
	}>,
): WorkspaceState<unknown> {
	return {
		tabs: tabs.map((tab) => ({
			id: tab.id,
			createdAt: 0,
			titleOverride: tab.titleOverride,
			activePaneId: tab.activePaneId ?? tab.panes[0]?.id ?? null,
			layout: { type: "pane", paneId: tab.panes[0]?.id ?? "" },
			panes: Object.fromEntries(tab.panes.map((pane) => [pane.id, pane])),
		})),
	} as unknown as WorkspaceState<unknown>;
}

const noTitles = () => null;

describe("(ALERT-CONTEXT-NAMES) extractAlertContexts", () => {
	it("answers empty for a layout that has not hydrated", () => {
		expect(
			extractAlertContexts({ paneLayout: null, getTerminalTitle: noTitles }),
		).toEqual({ tabCount: 0, terminals: [] });
		expect(
			extractAlertContexts({
				paneLayout: undefined,
				getTerminalTitle: noTitles,
			}),
		).toEqual({ tabCount: 0, terminals: [] });
	});

	it("prefers the tab's own rename over everything else", () => {
		const snapshot = extractAlertContexts({
			paneLayout: layout([
				{
					id: "tab-1",
					titleOverride: "Login work",
					panes: [terminalPane("pane-1", "terminal-1", "Pane name")],
				},
			]),
			getTerminalTitle: () => "zsh",
		});
		expect(snapshot.terminals).toEqual([
			{ terminalId: "terminal-1", tabTitle: "Login work" },
		]);
	});

	it("falls to the pane's rename, then to the LIVE terminal title", () => {
		expect(
			extractAlertContexts({
				paneLayout: layout([
					{
						id: "tab-1",
						panes: [terminalPane("pane-1", "terminal-1", "Pane name")],
					},
				]),
				getTerminalTitle: () => "zsh",
			}).terminals[0]?.tabTitle,
		).toBe("Pane name");

		expect(
			extractAlertContexts({
				paneLayout: layout([
					{ id: "tab-1", panes: [terminalPane("pane-1", "terminal-1")] },
				]),
				getTerminalTitle: () => "claude — resume",
			}).terminals[0]?.tabTitle,
		).toBe("claude — resume");
	});

	it("contributes NO title rather than the placeholder word", () => {
		// "Terminal — finished, ready for review" reads like a name and is not
		// one; the phone's generic wording is better.
		expect(
			extractAlertContexts({
				paneLayout: layout([
					{ id: "tab-1", panes: [terminalPane("pane-1", "terminal-1")] },
				]),
				getTerminalTitle: noTitles,
			}).terminals,
		).toEqual([{ terminalId: "terminal-1", tabTitle: "" }]);
	});

	it("counts EVERY tab, not just the ones holding a terminal", () => {
		const snapshot = extractAlertContexts({
			paneLayout: layout([
				{ id: "tab-1", panes: [terminalPane("pane-1", "terminal-1")] },
				{ id: "tab-2", panes: [] },
				{ id: "tab-3", panes: [] },
			]),
			getTerminalTitle: () => "zsh",
		});
		// The phone omits the tab name below two tabs; "this workspace has more
		// than one thing open" is true whatever those things are.
		expect(snapshot.tabCount).toBe(3);
		expect(snapshot.terminals).toHaveLength(1);
	});

	it("names a SPLIT tab from its active pane, and gives every terminal in it the SAME name", () => {
		const snapshot = extractAlertContexts({
			paneLayout: layout([
				{
					id: "tab-1",
					activePaneId: "pane-2",
					panes: [
						terminalPane("pane-1", "terminal-1", "Left"),
						terminalPane("pane-2", "terminal-2", "Right"),
					],
				},
			]),
			getTerminalTitle: noTitles,
		});
		// A tab has ONE name. Resolving per terminal made pane-1 report "Left"
		// and pane-2 "Right" for a single tab — and any terminal open in a second
		// tab then lost its title to the ambiguity rule for no reason.
		expect(snapshot.terminals).toEqual([
			{ terminalId: "terminal-1", tabTitle: "Right" },
			{ terminalId: "terminal-2", tabTitle: "Right" },
		]);
	});

	it("lets a NON-TERMINAL active pane name the tab when the user RENAMED it", () => {
		const snapshot = extractAlertContexts({
			paneLayout: {
				tabs: [
					{
						id: "tab-1",
						activePaneId: "pane-2",
						panes: {
							"pane-1": {
								id: "pane-1",
								kind: "terminal",
								data: { terminalId: "terminal-1" },
							},
							"pane-2": {
								id: "pane-2",
								kind: "diff",
								data: {},
								titleOverride: "Changes",
							},
						},
					},
				],
			} as unknown as WorkspaceState<unknown>,
			getTerminalTitle: () => "zsh",
		});
		// The user is looking at the diff. "Changes" is the honest name for that
		// tab; borrowing the terminal's name would label the notification with a
		// pane nobody is on.
		expect(snapshot.terminals).toEqual([
			{ terminalId: "terminal-1", tabTitle: "Changes" },
		]);
	});

	it("emits no title when a non-terminal title pane has no name of its own", () => {
		const snapshot = extractAlertContexts({
			paneLayout: {
				tabs: [
					{
						id: "tab-1",
						activePaneId: "pane-2",
						panes: {
							"pane-1": {
								id: "pane-1",
								kind: "terminal",
								data: { terminalId: "terminal-1" },
							},
							"pane-2": {
								id: "pane-2",
								kind: "file",
								data: { path: "/repo/src/secret-project-plan.ts" },
							},
						},
					},
				],
			} as unknown as WorkspaceState<unknown>,
			getTerminalTitle: () => "zsh",
		});
		// The sidebar would call this tab "secret-project-plan.ts". That is a
		// DERIVED name — free text about what the user is working on — and the
		// 2026-08-16 waiver covers project, workspace and tab names only. It must
		// not reach an FCM payload, so the tab contributes nothing.
		expect(snapshot.terminals).toEqual([
			{ terminalId: "terminal-1", tabTitle: "" },
		]);
	});

	it("uses the TITLE pane's live title, not each terminal's own", () => {
		const snapshot = extractAlertContexts({
			paneLayout: layout([
				{
					id: "tab-1",
					activePaneId: "pane-1",
					panes: [
						terminalPane("pane-1", "terminal-1"),
						terminalPane("pane-2", "terminal-2"),
					],
				},
			]),
			getTerminalTitle: (terminalId) =>
				terminalId === "terminal-1" ? "claude" : "zsh",
		});
		expect(snapshot.terminals).toEqual([
			{ terminalId: "terminal-1", tabTitle: "claude" },
			{ terminalId: "terminal-2", tabTitle: "claude" },
		]);
	});

	it("gives a split tab with no active pane no title at all", () => {
		const snapshot = extractAlertContexts({
			paneLayout: layout([
				{
					id: "tab-1",
					activePaneId: null,
					panes: [
						terminalPane("pane-1", "terminal-1"),
						terminalPane("pane-2", "terminal-2"),
					],
				},
			]),
			getTerminalTitle: noTitles,
		});
		expect(snapshot.terminals.every((t) => t.tabTitle === "")).toBe(true);
	});

	it("drops the title when one terminal is in two tabs with DIFFERENT names", () => {
		const snapshot = extractAlertContexts({
			paneLayout: layout([
				{
					id: "tab-1",
					titleOverride: "Left",
					panes: [terminalPane("pane-1", "terminal-1")],
				},
				{
					id: "tab-2",
					titleOverride: "Right",
					panes: [terminalPane("pane-2", "terminal-1")],
				},
			]),
			getTerminalTitle: noTitles,
		});
		// Naming one of the two would be a coin flip about which tab the user
		// means. Project and workspace names still carry the alert.
		expect(snapshot.terminals).toEqual([
			{ terminalId: "terminal-1", tabTitle: "" },
		]);
	});

	it("keeps the title when the two appearances AGREE", () => {
		const snapshot = extractAlertContexts({
			paneLayout: layout([
				{
					id: "tab-1",
					titleOverride: "Same",
					panes: [terminalPane("pane-1", "terminal-1")],
				},
				{
					id: "tab-2",
					titleOverride: "Same",
					panes: [terminalPane("pane-2", "terminal-1")],
				},
			]),
			getTerminalTitle: noTitles,
		});
		expect(snapshot.terminals).toEqual([
			{ terminalId: "terminal-1", tabTitle: "Same" },
		]);
	});

	it("ignores panes that are not terminals, and terminal panes with no id", () => {
		const snapshot = extractAlertContexts({
			paneLayout: {
				tabs: [
					{
						id: "tab-1",
						activePaneId: "pane-1",
						panes: {
							"pane-1": {
								id: "pane-1",
								kind: "chat",
								data: { sessionId: "s" },
							},
							"pane-2": { id: "pane-2", kind: "terminal", data: {} },
							"pane-3": { id: "pane-3", kind: "terminal", data: null },
						},
					},
				],
			} as unknown as WorkspaceState<unknown>,
			getTerminalTitle: noTitles,
		});
		expect(snapshot.terminals).toEqual([]);
		expect(snapshot.tabCount).toBe(1);
	});

	it("survives a live-title lookup that throws", () => {
		const snapshot = extractAlertContexts({
			paneLayout: layout([
				{ id: "tab-1", panes: [terminalPane("pane-1", "terminal-1")] },
			]),
			getTerminalTitle: () => {
				throw new Error("registry exploded");
			},
		});
		expect(snapshot.terminals).toEqual([
			{ terminalId: "terminal-1", tabTitle: "" },
		]);
	});

	it("trims a title rather than sending its whitespace", () => {
		expect(
			extractAlertContexts({
				paneLayout: layout([
					{ id: "tab-1", panes: [terminalPane("pane-1", "terminal-1")] },
				]),
				getTerminalTitle: () => "   ",
			}).terminals[0]?.tabTitle,
		).toBe("");
	});
});

describe("(ALERT-CONTEXT-NAMES) alertContextsHash", () => {
	it("is equal for two snapshots the host could not tell apart", () => {
		const a = { tabCount: 2, terminals: [{ terminalId: "t", tabTitle: "A" }] };
		const b = { tabCount: 2, terminals: [{ terminalId: "t", tabTitle: "A" }] };
		expect(alertContextsHash(a)).toBe(alertContextsHash(b));
	});

	it("differs when the tab COUNT changes, even with the same terminals", () => {
		// The count is what the phone uses to decide whether to name a tab at all,
		// so a snapshot that only changed it is a snapshot worth sending.
		expect(
			alertContextsHash({
				tabCount: 1,
				terminals: [{ terminalId: "t", tabTitle: "A" }],
			}),
		).not.toBe(
			alertContextsHash({
				tabCount: 2,
				terminals: [{ terminalId: "t", tabTitle: "A" }],
			}),
		);
	});

	it("differs when a title changes", () => {
		expect(
			alertContextsHash({
				tabCount: 1,
				terminals: [{ terminalId: "t", tabTitle: "A" }],
			}),
		).not.toBe(
			alertContextsHash({
				tabCount: 1,
				terminals: [{ terminalId: "t", tabTitle: "B" }],
			}),
		);
	});
});
