import type { SelectV2Workspace } from "@superset/db/schema";

/**
 * Default title for an auto-mirrored branch card = the branch's display name
 * (falling back to its git branch). Users can override via inline edit / the
 * Card tab without touching the underlying branch name.
 */
export function deriveCardTitle(
	workspace: Pick<SelectV2Workspace, "name" | "branch">,
): string {
	return workspace.name?.trim() || workspace.branch?.trim() || "Untitled";
}
