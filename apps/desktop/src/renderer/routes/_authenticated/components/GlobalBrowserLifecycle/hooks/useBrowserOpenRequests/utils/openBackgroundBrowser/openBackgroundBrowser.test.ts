import { describe, expect, test } from "bun:test";
import { createWorkspaceStore, type WorkspaceState } from "@superset/panes";
import type { PaneViewerData } from "renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/types";
import type { AppCollections } from "renderer/routes/_authenticated/providers/CollectionsProvider/collections";
import { openBackgroundBrowser } from "./openBackgroundBrowser";

function fixture() {
	const store = createWorkspaceStore<PaneViewerData>();
	store.getState().addTab({
		panes: [{ kind: "terminal", data: { terminalId: "working-terminal" } }],
	});
	const state = store.getState();
	const initial: WorkspaceState<PaneViewerData> = {
		version: 1,
		tabs: state.tabs,
		activeTabId: state.activeTabId,
	};
	const rows = new Map([
		["agent", { paneLayout: structuredClone(initial) }],
		["user", { paneLayout: structuredClone(initial) }],
	]);
	const collections = {
		v2WorkspaceLocalState: {
			get: (id: string) => rows.get(id),
			update: (
				id: string,
				update: (row: { paneLayout: WorkspaceState<PaneViewerData> }) => void,
			) => {
				const row = rows.get(id);
				if (row) update(row);
			},
		},
	} as unknown as Pick<AppCollections, "v2WorkspaceLocalState">;
	return { collections, rows, initial };
}

describe("openBackgroundBrowser (FORK-BROWSER-OFF)", () => {
	function paneKinds(layout: WorkspaceState<PaneViewerData> | undefined) {
		return (layout?.tabs ?? [])
			.flatMap((tab) => Object.values(tab.panes))
			.map((pane) => pane.kind);
	}

	for (const target of ["current-tab", "new-tab"] as const) {
		test(`${target} refuses the open and leaves every workspace layout untouched`, () => {
			const { collections, rows, initial } = fixture();
			expect(() =>
				openBackgroundBrowser({
					collections,
					workspaceId: "agent",
					url: "https://example.com",
					target,
				}),
			).toThrow("Browser panes are disabled in this fork");
			expect(rows.get("agent")?.paneLayout).toEqual(initial);
			expect(rows.get("user")?.paneLayout).toEqual(initial);
			expect(paneKinds(rows.get("agent")?.paneLayout)).not.toContain("browser");
		});
	}

	test("successive opens accumulate no tabs and no panes", () => {
		const { collections, rows, initial } = fixture();
		const request = {
			collections,
			workspaceId: "agent",
			url: "https://example.com",
			target: "new-tab" as const,
		};
		expect(() => openBackgroundBrowser(request)).toThrow(
			"Browser panes are disabled in this fork",
		);
		expect(() => openBackgroundBrowser(request)).toThrow(
			"Browser panes are disabled in this fork",
		);
		const layout = rows.get("agent")?.paneLayout;
		expect(layout).toEqual(initial);
		expect(layout?.tabs).toHaveLength(1);
		expect(paneKinds(layout)).not.toContain("browser");
	});
});
