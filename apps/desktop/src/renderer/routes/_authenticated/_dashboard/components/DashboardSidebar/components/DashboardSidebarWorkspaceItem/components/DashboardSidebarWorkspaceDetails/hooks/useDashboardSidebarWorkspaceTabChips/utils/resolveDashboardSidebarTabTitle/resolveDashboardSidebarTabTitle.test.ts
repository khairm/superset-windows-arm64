import { describe, expect, it } from "bun:test";
import { resolveDashboardSidebarTabTitle } from "./resolveDashboardSidebarTabTitle";

const terminalPane = {
	id: "terminal-pane",
	kind: "terminal",
	terminalId: "terminal-1",
};

describe("resolveDashboardSidebarTabTitle", () => {
	it("prefers the tab override over pane titles", () => {
		expect(
			resolveDashboardSidebarTabTitle(
				{
					titleOverride: "Deploy logs",
					activePaneId: "terminal-pane",
					panes: [{ ...terminalPane, titleOverride: "Shell" }],
				},
				0,
			),
		).toBe("Deploy logs");
	});

	it("uses the active pane override for a split tab", () => {
		expect(
			resolveDashboardSidebarTabTitle(
				{
					activePaneId: "chat-pane",
					panes: [
						terminalPane,
						{
							id: "chat-pane",
							kind: "chat",
							titleOverride: "Release review",
						},
					],
				},
				1,
			),
		).toBe("Release review");
	});

	it("uses per-kind defaults and the filename for file panes", () => {
		expect(
			resolveDashboardSidebarTabTitle(
				{ activePaneId: "terminal-pane", panes: [terminalPane] },
				0,
			),
		).toBe("Terminal");
		expect(
			resolveDashboardSidebarTabTitle(
				{
					activePaneId: "file-pane",
					panes: [
						{
							id: "file-pane",
							kind: "file",
							filePath: "C:\\src\\feature.tsx",
						},
					],
				},
				0,
			),
		).toBe("feature.tsx");
	});

	it("falls back to the one-based tab index", () => {
		expect(
			resolveDashboardSidebarTabTitle({ activePaneId: null, panes: [] }, 2),
		).toBe("Tab 3");
	});
});
