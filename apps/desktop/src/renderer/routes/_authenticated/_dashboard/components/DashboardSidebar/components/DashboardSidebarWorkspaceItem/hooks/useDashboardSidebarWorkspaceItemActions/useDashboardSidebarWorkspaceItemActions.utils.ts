import type { ParsedLocation, RouterState } from "@tanstack/react-router";
import { isUnder, v2WorkspaceIdOf } from "renderer/lib/active-route";

// The card id reads the pending location, so on a pending kanban switch the
// target row lights up first, as before.
export function selectIsWorkspaceRowActive(
	matched: ParsedLocation,
	state: Pick<RouterState, "location">,
	workspaceId: string,
): boolean {
	return (
		v2WorkspaceIdOf(matched.pathname, { fuzzy: true }) === workspaceId ||
		(isUnder(matched.pathname, "/kanban") &&
			(state.location.search as { cardId?: string }).cardId === workspaceId)
	);
}
