import { useLocalHostService } from "renderer/routes/_authenticated/providers/LocalHostServiceProvider";
import { useCliTerminalScriptImport } from "./hooks/useCliTerminalScriptImport";
import { useDefaultV2TerminalPresets } from "./hooks/useDefaultV2TerminalPresets";
import { usePlaceLocalWorktreesInSidebar } from "./hooks/usePlaceLocalWorktreesInSidebar";
import { useSidebarMirrorSync } from "./hooks/useSidebarMirrorSync";
import { useSurfaceHiddenMainWorkspaces } from "./hooks/useSurfaceHiddenMainWorkspaces";

/**
 * Component that runs agent-related hooks requiring CollectionsProvider context.
 */
export function AgentHooks() {
	const { activeHostUrl, activeOrganizationId } = useLocalHostService();
	// Seeds the default v2 terminal presets and warms the local host's agent
	// config cache for Settings.
	useDefaultV2TerminalPresets(activeHostUrl);
	useCliTerminalScriptImport(activeOrganizationId);
	usePlaceLocalWorktreesInSidebar();
	// (MASTER-ALWAYS-ACTIVE) Returns master workspaces stranded in the legacy
	// "hidden" bucket (no active lane, no Archived section, no way back) to the
	// active list. Runs AFTER placement so a main placed this pass is already
	// row-backed, and BEFORE the mirror below so a launch's first push carries
	// the repair instead of publishing the broken state first.
	useSurfaceHiddenMainWorkspaces();
	// (SIDEBAR-MIRROR) Publishes sidebar curation (membership, placement,
	// soft-delete, archive, snooze, complete, hide, pin, order) into host.db so
	// consumers outside the renderer stop reading the uncurated raw set. Mounted
	// here because this is the always-on component inside CollectionsProvider —
	// curation changes from every entry point in the app, and the mirror has to
	// follow all of them, not just the sidebar route's.
	useSidebarMirrorSync();
	return null;
}
