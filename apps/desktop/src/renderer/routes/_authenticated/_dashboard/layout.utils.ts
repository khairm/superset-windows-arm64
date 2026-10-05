import type { ParsedLocation } from "@tanstack/react-router";
import {
	isExactly,
	isUnder,
	v1WorkspaceIdOf,
	v2WorkspaceIdOf,
} from "renderer/lib/active-route";

export function selectCurrentWorkspaceId(
	matched: ParsedLocation,
): string | null {
	return v1WorkspaceIdOf(matched.pathname);
}

export function selectOnV2WorkspaceRoute(matched: ParsedLocation): boolean {
	return v2WorkspaceIdOf(matched.pathname, { fuzzy: true }) !== null;
}

export function selectOnNewWorkspaceRoute(matched: ParsedLocation): boolean {
	return isExactly(matched.pathname, "/new-workspace");
}

// (CLOUD-SEVERANCE-P2) Automations and Tasks used to be part of this set;
// they are severed, so the only full-width dashboard views left are pull
// requests and the workspaces list.
export function selectOnDashboardViewRoute(matched: ParsedLocation): boolean {
	return (
		isUnder(matched.pathname, "/pull-requests") ||
		isUnder(matched.pathname, "/plugins") ||
		isUnder(matched.pathname, "/pages") ||
		isUnder(matched.pathname, "/v2-workspaces")
	);
}
