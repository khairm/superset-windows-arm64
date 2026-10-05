import type { ParsedLocation, RouterState } from "@tanstack/react-router";
import { isUnder, v2WorkspaceIdOf } from "renderer/lib/active-route";

interface ParsedRowRoute {
	pathname: string;
	v2WorkspaceId: string | null;
	onKanban: boolean;
}

// Every row runs the select on each router notification; parse the path once.
let lastParsed: ParsedRowRoute | null = null;

function parseRowRoute(pathname: string): ParsedRowRoute {
	if (lastParsed === null || lastParsed.pathname !== pathname) {
		lastParsed = {
			pathname,
			v2WorkspaceId: v2WorkspaceIdOf(pathname, { fuzzy: true }),
			onKanban: isUnder(pathname, "/kanban"),
		};
	}
	return lastParsed;
}

// The card id reads the pending location, so on a pending kanban switch the
// target row lights up first, as before.
export function selectIsWorkspaceRowActive(
	matched: ParsedLocation,
	state: Pick<RouterState, "location">,
	workspaceId: string,
): boolean {
	const route = parseRowRoute(matched.pathname);
	return (
		route.v2WorkspaceId === workspaceId ||
		(route.onKanban &&
			(state.location.search as { cardId?: string }).cardId === workspaceId)
	);
}
