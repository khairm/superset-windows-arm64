import {
	createSidebarCuration,
	type SidebarCuration,
	type WorkspaceCurationInput,
} from "../../companion/sidebar-filter";
import type { HostDb } from "../../db";
import {
	sidebarMirrorMeta,
	sidebarProjectState,
	sidebarWorkspaceState,
} from "../../db/schema";

function readSidebarCuration(
	db: HostDb,
	organizationId: string,
): SidebarCuration {
	const nowMs = Date.now();
	const [meta = null] = db.select().from(sidebarMirrorMeta).limit(1).all();
	const metaOnly = createSidebarCuration(
		{ meta, workspaces: [], projects: [] },
		nowMs,
		organizationId,
	);
	if (!metaOnly.enabled) return metaOnly;
	return createSidebarCuration(
		{
			meta,
			workspaces: db
				.select({
					workspaceId: sidebarWorkspaceState.workspaceId,
					projectId: sidebarWorkspaceState.projectId,
					isHidden: sidebarWorkspaceState.isHidden,
					archivedAt: sidebarWorkspaceState.archivedAt,
					snoozeUntil: sidebarWorkspaceState.snoozeUntil,
					snoozeLaunchId: sidebarWorkspaceState.snoozeLaunchId,
					completedAt: sidebarWorkspaceState.completedAt,
					deletedAt: sidebarWorkspaceState.deletedAt,
					pinnedAt: sidebarWorkspaceState.pinnedAt,
					tabOrder: sidebarWorkspaceState.tabOrder,
				})
				.from(sidebarWorkspaceState)
				.all(),
			projects: db
				.select({
					projectId: sidebarProjectState.projectId,
					tabOrder: sidebarProjectState.tabOrder,
					isPinned: sidebarProjectState.isPinned,
					isCollapsed: sidebarProjectState.isCollapsed,
				})
				.from(sidebarProjectState)
				.all(),
		},
		nowMs,
		organizationId,
	);
}

export function createExitedWorkspaceFilterLoader({
	db,
	organizationId,
}: {
	db: HostDb;
	organizationId: string;
}): () => (workspace: WorkspaceCurationInput) => boolean {
	let lastEnabled: boolean | null = null;
	return () => {
		const curation = readSidebarCuration(db, organizationId);
		if (curation.enabled !== lastEnabled) {
			lastEnabled = curation.enabled;
			console.warn(
				curation.enabled
					? "[host-service:pull-request-runtime] (PR-SWEEP-SKIPS-EXITED) Sidebar mirror is fresh; PR sweeps skip workspaces off the sidebar"
					: "[host-service:pull-request-runtime] (PR-SWEEP-SKIPS-EXITED) Sidebar mirror is absent, stale or for another org; PR sweeps cover every workspace",
				{ lastSyncAgeMs: curation.lastSyncAgeMs },
			);
		}
		return (workspace) => curation.workspaceVerdict(workspace) !== "show";
	};
}
