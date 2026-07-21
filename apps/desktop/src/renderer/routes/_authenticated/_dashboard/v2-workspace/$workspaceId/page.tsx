import { createFileRoute } from "@tanstack/react-router";
import {
	V2WorkspaceView,
	type WorkspaceSearch,
} from "./components/V2WorkspaceView";
import type { V2WorkspaceUrlOpenTarget } from "./utils/openUrlInV2Workspace";

function parseOpenUrlTarget(
	value: unknown,
): V2WorkspaceUrlOpenTarget | undefined {
	if (value === "current-tab" || value === "new-tab") return value;
	return undefined;
}

function parseNonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export const Route = createFileRoute(
	"/_authenticated/_dashboard/v2-workspace/$workspaceId/",
)({
	component: V2WorkspacePage,
	validateSearch: (raw: Record<string, unknown>): WorkspaceSearch => ({
		tabId: parseNonEmptyString(raw.tabId),
		terminalId: parseNonEmptyString(raw.terminalId),
		chatSessionId: parseNonEmptyString(raw.chatSessionId),
		focusRequestId: parseNonEmptyString(raw.focusRequestId),
		openUrl: parseNonEmptyString(raw.openUrl),
		openUrlTarget: parseOpenUrlTarget(raw.openUrlTarget),
		openUrlRequestId: parseNonEmptyString(raw.openUrlRequestId),
	}),
});

// The workspace centre lives in <V2WorkspaceView/> so the Kanban collapse-split
// (via V2WorkspaceMount) can mount the exact same view. This route is now a thin
// shim that feeds it the parsed URL search params.
function V2WorkspacePage() {
	const search = Route.useSearch();
	return <V2WorkspaceView {...search} />;
}
