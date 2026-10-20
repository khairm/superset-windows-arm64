import type { PaneDefinition } from "@superset/panes";
import type { ReactNode } from "react";

// (FORK-BROWSER-OFF) (FORK-CHAT-V3-OFF) (FORK-PRS-OFF)
export function createDisabledPaneDefinition<TData>(
	title: string,
	icon: ReactNode,
): PaneDefinition<TData> {
	return {
		getIcon: () => icon,
		getTitle: () => title,
		renderPane: () => null,
	};
}
