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

	it("uses persisted browser title, then a normalized URL host", () => {
		expect(
			resolveDashboardSidebarTabTitle(
				{
					activePaneId: "browser-pane",
					panes: [
						{
							id: "browser-pane",
							kind: "browser",
							browserPageTitle: "Superset Docs",
							browserUrl: "https://www.example.com/docs",
						},
					],
				},
				0,
			),
		).toBe("Superset Docs");
		expect(
			resolveDashboardSidebarTabTitle(
				{
					activePaneId: "browser-pane",
					panes: [
						{
							id: "browser-pane",
							kind: "browser",
							browserUrl: "https://www.example.com:8443/docs",
						},
					],
				},
				0,
			),
		).toBe("example.com:8443");
	});

	it("falls back to Browser for malformed or missing URLs", () => {
		for (const browserUrl of ["not a valid url", undefined]) {
			expect(
				resolveDashboardSidebarTabTitle(
					{
						activePaneId: "browser-pane",
						panes: [{ id: "browser-pane", kind: "browser", browserUrl }],
					},
					0,
				),
			).toBe("Browser");
		}
	});

	it("uses the persisted comment author login", () => {
		expect(
			resolveDashboardSidebarTabTitle(
				{
					activePaneId: "comment-pane",
					panes: [
						{
							id: "comment-pane",
							kind: "comment",
							commentAuthorLogin: "octocat",
						},
					],
				},
				0,
			),
		).toBe("octocat");
		expect(
			resolveDashboardSidebarTabTitle(
				{
					activePaneId: "comment-pane",
					panes: [{ id: "comment-pane", kind: "comment" }],
				},
				0,
			),
		).toBe("Comment");
	});

	it("falls back to the one-based tab index", () => {
		expect(
			resolveDashboardSidebarTabTitle({ activePaneId: null, panes: [] }, 2),
		).toBe("Tab 3");
	});
});
