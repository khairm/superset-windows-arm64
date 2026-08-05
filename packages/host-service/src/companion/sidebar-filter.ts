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
 * The mirror's contract has exactly one permitted failure direction: a MISSING
 * row means "no opinion recorded", never "hidden". Staleness is a SEPARATE
 * question with the opposite shape — a stale row still carrying
 * `deleted_at`/`archived_at`/`snooze_until` hides a thread that is no longer
 * hidden, and a stale `app_launch_id` keeps an "until next launch" snooze in
 * force forever — so it cannot be answered by any per-row rule. It is answered
 * WHOLESALE, by `(MIRROR-AGE-OUT)` below: past `MIRROR_MAX_AGE_MS` with no
 * renderer heartbeat, this module stops filtering at all rather than serving a
 * dead desktop's last opinion as if it were current.
 *
 * Applied literally to both tables the absence rule would be wrong in one
 * direction and right in the other, because the renderer itself treats the two
 * absences differently:
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
	 * False when the mirror is not evidence about this machine's sidebar right
	 * now — no renderer has ever synced, the last sync is older than
	 * `MIRROR_MAX_AGE_MS`, or the mirror belongs to a different organization.
	 * Every predicate below then answers `"show"`, so none of those states can
	 * fail closed.
	 */
	readonly enabled: boolean;
	/**
	 * (CURATION-PROVENANCE) How old the mirror was when this curation was built,
	 * or null when there is no meta row at all. Reported even when `enabled` is
	 * false — that is exactly the case a diagnostic needs it for, since the age
	 * is what distinguishes "no renderer has ever synced" from "the mirror aged
	 * out" from "the mirror belongs to another org".
	 */
	readonly lastSyncAgeMs: number | null;
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

/**
 * (MIRROR-AGE-OUT) How old `sidebar_mirror_meta.last_full_sync_at_ms` may get
 * before this module stops filtering.
 *
 * Chosen against the writer's heartbeat, not against any guess about user
 * behaviour: the renderer re-pushes the unchanged snapshot every five minutes,
 * so a live desktop refreshes this stamp four times inside the window. That
 * margin is the point — a single failed push, one retry backoff, or a laptop
 * that slept through a beat must not make a running desktop look dead, because
 * an unnecessary age-out shows the phone binned and snoozed threads. Twenty
 * minutes is four beats: enough that only a genuinely absent renderer reaches
 * it, short enough that a quit app stops curating the phone in minutes.
 */
export const MIRROR_MAX_AGE_MS = 1_200_000;

/**
 * The one disabled curation, shared by every reason for disabling. Callers of
 * `SidebarCuration` cannot tell these reasons apart and must not: the whole
 * contract of the disabled state is "filter nothing", and three hand-written
 * copies of it would be three chances for one of them to drift into filtering
 * something.
 */
function passThroughCuration(lastSyncAgeMs: number | null): SidebarCuration {
	return {
		enabled: false,
		lastSyncAgeMs,
		effectiveProjectId: (workspace) => workspace.projectId,
		workspaceVerdict: () => "show",
		projectVerdict: () => "show",
	};
}

export function createSidebarCuration(
	snapshot: SidebarMirrorSnapshot,
	nowMs: number,
	organizationId: string,
): SidebarCuration {
	const meta = snapshot.meta;
	if (meta === null) {
		// Bootstrap: nothing has ever been mirrored, so the two tables carry no
		// information and filtering on them would hide a sidebar we cannot see.
		return passThroughCuration(null);
	}
	const lastSyncAgeMs = nowMs - meta.lastFullSyncAtMs;
	// (MIRROR-AGE-OUT) The writer heartbeats the unchanged snapshot every five
	// minutes (`MIRROR-HEARTBEAT`), so `lastFullSyncAtMs` means "a renderer was
	// alive at this moment" and not "somebody last dragged a thread". Past the
	// window that is positive evidence that NO renderer is running — the app is
	// quit, the machine woke without it, the hook chain is broken — and every
	// hiding field in these tables is then an opinion from a session that has
	// ended. `snooze_launch_id` is the sharpest case: it hides a thread only
	// while it equals the CURRENT launch, so a mirror frozen mid-launch keeps
	// hiding threads the very next launch would have released, with nothing to
	// release them. Fail toward SHOWING: too noisy is the permitted direction,
	// a blocked agent nobody can see is not.
	if (lastSyncAgeMs > MIRROR_MAX_AGE_MS) {
		return passThroughCuration(lastSyncAgeMs);
	}
	// (MIRROR-ORG-GATE) The mirror is written per ORG by whichever renderer is
	// signed in, and `host.db` is per machine — one file that a sign-out and a
	// sign-in to a different organization both write through. The column has
	// been recorded and read since the mirror shipped and was never once
	// compared, so a mirror left behind by org A curated org B's tree: A's
	// placements decided where B's threads grouped, and A's binned/snoozed rows
	// hid B's live ones by workspace id. Ids do not collide, so in practice the
	// damage is the project gate — every one of B's projects is "not in the
	// sidebar" — which hides the WHOLE tree. Same seam, same direction: a mirror
	// that is not about this org is not evidence about this org.
	if (meta.organizationId !== organizationId) {
		return passThroughCuration(lastSyncAgeMs);
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
		lastSyncAgeMs,
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
