/**
 * (BRIDGE-SIDEBAR-FILTER) The consumer side of `(SIDEBAR-MIRROR)`.
 *
 * `host.db` is a lifecycle-free append store: every project, workspace and
 * terminal session this machine has ever created, with no column for any of the
 * judgements the user makes about them. The bridge used to ship all of it —
 * measured, 22/22 projects and 183/183 workspaces, with a thread binned last
 * month rendering exactly like one blocked on the user right now. The mirror
 * tables put the renderer's curation into `host.db`; this module is the ONE
 * place that reads them, so every companion surface hides the same set.
 *
 * ---------------------------------------------------------------------------
 * THE TWO ABSENCE RULES, WHICH ARE DELIBERATELY DIFFERENT
 * ---------------------------------------------------------------------------
 * The mirror's contract has exactly one permitted failure direction: a missing
 * or stale row means "no opinion recorded", never "hidden". Applied literally to
 * both tables that would be wrong in one direction and right in the other,
 * because the renderer itself treats the two absences differently:
 *
 *  - WORKSPACE absence = NO OPINION -> SHOW. The renderer's own driver is the
 *    local-state row, but a workspace can legitimately exist before its row
 *    does (a CLI worktree created while the desktop was closed, a sync in
 *    flight). Hiding on absence would turn a transient miss into a blocked
 *    agent nobody sees. Only a POSITIVE mark — deleted, completed, archived,
 *    snoozed, hidden — hides a workspace.
 *
 *  - PROJECT absence = A REAL STATEMENT -> HIDE, but only once the mirror has
 *    been filled at all. The desktop starts from the placement collection and
 *    drops every host project without a row ("same as the old inner join did"),
 *    so a project with no placement is not in the sidebar however many
 *    workspaces it owns. The bootstrap hole this opens — `v2SidebarProjects` is
 *    device-local, so a fresh install has zero rows — is closed by
 *    `sidebar_mirror_meta`: NO META ROW MEANS NO RENDERER HAS EVER SYNCED, and
 *    this module then filters nothing at all.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS NOT
 * ---------------------------------------------------------------------------
 * It is not an answer guard. Curation decides what the phone LISTS; it must
 * never decide what the phone may answer. A question captured before its
 * workspace was snoozed is still a real question on a real terminal, and the
 * answer path resolves handles without consulting any of this — filters fail
 * toward showing, guards fail toward refusing, and they are different code.
 */

/** `sidebar_workspace_state`, as read. Field names match the schema's camelCase. */
export interface SidebarWorkspaceMirrorRow {
	workspaceId: string;
	/** The project the row is PLACED under — curation, not `workspaces.project_id`. */
	projectId: string;
	isHidden: number | boolean;
	archivedAt: number | null;
	snoozeUntil: number | null;
	snoozeLaunchId: string | null;
	completedAt: number | null;
	deletedAt: number | null;
	pinnedAt: number | null;
	tabOrder: number;
}

/** `sidebar_project_state`, as read. Presence IS the membership fact. */
export interface SidebarProjectMirrorRow {
	projectId: string;
	tabOrder: number;
	isPinned: number | boolean;
	isCollapsed: number | boolean;
}

/** `sidebar_mirror_meta`. Its PRESENCE is the bootstrap signal. */
export interface SidebarMirrorMetaRow {
	lastFullSyncAtMs: number;
	/** The renderer launch that wrote it — the only way to evaluate a launch snooze. */
	appLaunchId: string;
	organizationId: string;
	workspaceCount: number;
	projectCount: number;
}

export interface SidebarMirrorSnapshot {
	meta: SidebarMirrorMetaRow | null;
	workspaces: SidebarWorkspaceMirrorRow[];
	projects: SidebarProjectMirrorRow[];
}

/**
 * Why a row is not on the phone. Kept as a discriminated reason rather than a
 * boolean so a diagnostic can say WHICH act of curation removed something —
 * "the phone is missing a thread" and "the phone is missing a whole repo" have
 * different causes and different fixes.
 */
export type SidebarVerdict =
	| "show"
	| "deleted"
	| "completed"
	| "archived"
	| "snoozed"
	| "hidden"
	| "project_not_in_sidebar";

export interface WorkspaceCurationInput {
	/** `workspaces.id`. */
	id: string;
	/** `workspaces.project_id` — the fallback when the mirror has no placement. */
	projectId: string;
	/** `workspaces.type`; a hidden `main` is merely hidden, a hidden branch is archived. */
	type: string;
}

export interface SidebarCuration {
	/**
	 * False when no renderer has ever synced. Every predicate below then answers
	 * `"show"`, so a fresh install or a cleared profile cannot fail closed.
	 */
	readonly enabled: boolean;
	/**
	 * Where this workspace sits in the SIDEBAR, which is the mirrored placement
	 * when there is one and the host row's own project otherwise. Placement is a
	 * curation act: a thread dragged under another repo groups there on the
	 * desktop and must group there on the phone.
	 */
	effectiveProjectId(workspace: WorkspaceCurationInput): string;
	workspaceVerdict(workspace: WorkspaceCurationInput): SidebarVerdict;
	projectVerdict(projectId: string): SidebarVerdict;
}

/**
 * The renderer's bucket classifier (`getWorkspaceSidebarBucket`), reproduced
 * against mirrored columns. Order is load-bearing and matches it exactly:
 * deleted first (the bin is a thread's only surface once it is binned), then
 * completed, archived, snoozed, hidden. Anything else is `active` — the one
 * bucket the sidebar shows by default, and therefore the one the phone shows.
 */
function classifyWorkspace(
	row: SidebarWorkspaceMirrorRow,
	type: string,
	appLaunchId: string,
	nowMs: number,
): SidebarVerdict {
	if (row.deletedAt != null) return "deleted";
	if (row.completedAt != null) return "completed";
	// A hidden NON-main thread is archived; a hidden `main` is merely hidden.
	// Both are off the default sidebar — the distinction is which revealable
	// section they land in, which the phone does not render either way.
	if (row.archivedAt != null) return "archived";
	const isHidden = row.isHidden === true || row.isHidden === 1;
	if (isHidden) return type === "main" ? "hidden" : "archived";
	// An "until next launch" snooze is stored as the renderer's launch id and is
	// only still in force while that is the CURRENT launch. Comparing it to the
	// mirror's own `app_launch_id` is the whole reason that column exists.
	if (row.snoozeLaunchId != null && row.snoozeLaunchId === appLaunchId) {
		return "snoozed";
	}
	if (typeof row.snoozeUntil === "number" && row.snoozeUntil > nowMs) {
		return "snoozed";
	}
	return "show";
}

export function createSidebarCuration(
	snapshot: SidebarMirrorSnapshot,
	nowMs: number,
): SidebarCuration {
	const meta = snapshot.meta;
	if (meta === null) {
		// Bootstrap: nothing has ever been mirrored, so the two tables carry no
		// information and filtering on them would hide a sidebar we cannot see.
		return {
			enabled: false,
			effectiveProjectId: (workspace) => workspace.projectId,
			workspaceVerdict: () => "show",
			projectVerdict: () => "show",
		};
	}

	const workspaceById = new Map<string, SidebarWorkspaceMirrorRow>();
	for (const row of snapshot.workspaces)
		workspaceById.set(row.workspaceId, row);
	const projectIds = new Set<string>();
	for (const row of snapshot.projects) projectIds.add(row.projectId);

	const placementOf = (workspace: WorkspaceCurationInput): string =>
		workspaceById.get(workspace.id)?.projectId ?? workspace.projectId;

	return {
		enabled: true,
		effectiveProjectId: placementOf,
		workspaceVerdict(workspace) {
			// The project gate first: a thread under a repo the user removed from
			// the sidebar is not on their sidebar, whatever its own row says. This
			// is also what reproduces `isAutoIncludedLocalMainWorkspace` — a `main`
			// workspace with NO row is auto-included exactly when its project is
			// placed, which is precisely what this check asks.
			if (!projectIds.has(placementOf(workspace))) {
				return "project_not_in_sidebar";
			}
			const row = workspaceById.get(workspace.id);
			// Absence is no opinion. See the module header.
			if (row === undefined) return "show";
			return classifyWorkspace(row, workspace.type, meta.appLaunchId, nowMs);
		},
		projectVerdict(projectId) {
			return projectIds.has(projectId) ? "show" : "project_not_in_sidebar";
		},
	};
}
