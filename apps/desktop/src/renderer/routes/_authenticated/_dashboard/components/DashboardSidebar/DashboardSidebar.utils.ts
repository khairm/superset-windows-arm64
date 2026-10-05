import type { ParsedLocation } from "@tanstack/react-router";
import { isUnder, v2WorkspaceIdOf } from "renderer/lib/active-route";

export function selectIsSettingsOpen(matched: ParsedLocation): boolean {
	return isUnder(matched.pathname, "/settings");
}

export function selectActiveV2WorkspaceId(
	matched: ParsedLocation,
): string | null {
	return v2WorkspaceIdOf(matched.pathname, { fuzzy: false });
}
