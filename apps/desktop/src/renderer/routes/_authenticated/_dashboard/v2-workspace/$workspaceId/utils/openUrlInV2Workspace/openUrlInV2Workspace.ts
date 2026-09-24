import { msg } from "@lingui/core/macro";
import { i18n } from "@superset/i18n";
import type { WorkspaceStore } from "@superset/panes";
import { toast } from "@superset/ui/sonner";
import { electronTrpcClient } from "renderer/lib/trpc-client";
import type { StoreApi } from "zustand/vanilla";
import type { PaneViewerData } from "../../types";

export type V2WorkspaceUrlOpenTarget = "current-tab" | "new-tab";

export function openUrlInV2Workspace({
	url,
}: {
	store: StoreApi<WorkspaceStore<PaneViewerData>>;
	target: V2WorkspaceUrlOpenTarget;
	url: string;
}): void {
	// (FORK-BROWSER-OFF)
	void electronTrpcClient.external.openUrl.mutate(url).catch((error) => {
		console.error("[v2 workspace] Failed to open URL:", url, error);
		toast.error(
			i18n._(msg({ message: "Failed to open URL in external browser" })),
		);
	});
}
