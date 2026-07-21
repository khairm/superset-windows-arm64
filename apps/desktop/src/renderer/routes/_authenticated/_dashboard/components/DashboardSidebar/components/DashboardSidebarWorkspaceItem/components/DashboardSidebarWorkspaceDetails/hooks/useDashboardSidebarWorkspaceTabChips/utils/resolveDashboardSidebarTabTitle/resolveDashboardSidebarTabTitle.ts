import type {
	V2WorkspaceTabChipData,
	V2WorkspaceTabPaneDescriptor,
} from "renderer/stores/v2-notifications";

const DEFAULT_PANE_TITLES: Readonly<Record<string, string>> = {
	terminal: "Terminal",
	chat: "Chat",
	diff: "Changes",
	file: "File",
	browser: "Browser",
	devtools: "DevTools",
	comment: "Comment",
};

function getTitlePane(
	tab: Pick<V2WorkspaceTabChipData, "activePaneId" | "panes">,
): V2WorkspaceTabPaneDescriptor | undefined {
	if (tab.panes.length === 1) return tab.panes[0];
	if (!tab.activePaneId) return undefined;
	return tab.panes.find((pane) => pane.id === tab.activePaneId);
}

function getPaneTitle(
	pane: V2WorkspaceTabPaneDescriptor | undefined,
): string | undefined {
	if (!pane) return undefined;
	if (pane.titleOverride) return pane.titleOverride;
	if (pane.kind === "file" && pane.filePath) {
		return pane.filePath.split(/[\\/]/).filter(Boolean).at(-1) ?? "File";
	}
	return DEFAULT_PANE_TITLES[pane.kind];
}

export function resolveDashboardSidebarTabTitle(
	tab: Pick<V2WorkspaceTabChipData, "titleOverride" | "activePaneId" | "panes">,
	index: number,
): string {
	if (tab.titleOverride) return tab.titleOverride;
	return getPaneTitle(getTitlePane(tab)) ?? `Tab ${index + 1}`;
}
