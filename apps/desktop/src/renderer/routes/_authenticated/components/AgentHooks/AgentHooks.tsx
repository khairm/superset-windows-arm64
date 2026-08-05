import { useLocalHostService } from "renderer/routes/_authenticated/providers/LocalHostServiceProvider";
import { useCommandWatcher } from "./hooks/useCommandWatcher";
import { useDefaultV2TerminalPresets } from "./hooks/useDefaultV2TerminalPresets";
import { useDevicePresence } from "./hooks/useDevicePresence";
import { usePlaceLocalWorktreesInSidebar } from "./hooks/usePlaceLocalWorktreesInSidebar";
import { useSidebarMirrorSync } from "./hooks/useSidebarMirrorSync";

/**
 * Component that runs agent-related hooks requiring CollectionsProvider context.
 * useCommandWatcher uses useCollections which must be inside the provider.
 */
export function AgentHooks() {
	const { activeHostUrl } = useLocalHostService();
	useDevicePresence();
	useCommandWatcher();
	// Seeds the default v2 terminal presets and warms the local host's agent
	// config cache for Settings.
	useDefaultV2TerminalPresets(activeHostUrl);
	usePlaceLocalWorktreesInSidebar();
	// (SIDEBAR-MIRROR) Publishes sidebar curation (membership, placement,
	// soft-delete, archive, snooze, complete, hide, pin, order) into host.db so
	// consumers outside the renderer stop reading the uncurated raw set. Mounted
	// here because this is the always-on component inside CollectionsProvider —
	// curation changes from every entry point in the app, and the mirror has to
	// follow all of them, not just the sidebar route's.
	useSidebarMirrorSync();
	return null;
}
