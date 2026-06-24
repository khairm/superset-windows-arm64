type SidebarWorkspaceVisibilitySource =
	| { isHidden?: boolean | null }
	| { sidebarState: { isHidden?: boolean | null } };

export function getSidebarWorkspaceIsHidden(
	workspace: SidebarWorkspaceVisibilitySource,
): boolean {
	if ("sidebarState" in workspace) {
		return workspace.sidebarState.isHidden === true;
	}
	return workspace.isHidden === true;
}

export function isSidebarWorkspaceVisible(
	workspace: SidebarWorkspaceVisibilitySource,
): boolean {
	return !getSidebarWorkspaceIsHidden(workspace);
}

export function getVisibleSidebarWorkspaces<
	Workspace extends SidebarWorkspaceVisibilitySource,
>(workspaces: readonly Workspace[]): Workspace[] {
	return workspaces.filter(isSidebarWorkspaceVisible);
}

/**
 * A `main` workspace is auto-included in the sidebar when the user hasn't
 * explicitly placed it (no local-state row), it lives on this machine, and its
 * project is one the user added to their sidebar. Shared by the sidebar tree
 * builder and the notification/ports visibility filters so they agree on what
 * "in the sidebar" means.
 */
export function isAutoIncludedLocalMainWorkspace(
	workspace: { id: string; hostId: string; projectId: string },
	{
		localStateWorkspaceIds,
		sidebarProjectIds,
		machineId,
	}: {
		localStateWorkspaceIds: ReadonlySet<string>;
		sidebarProjectIds: ReadonlySet<string>;
		machineId: string | null;
	},
): boolean {
	return (
		!localStateWorkspaceIds.has(workspace.id) &&
		workspace.hostId === machineId &&
		sidebarProjectIds.has(workspace.projectId)
	);
}

// ---------------------------------------------------------------------------
// Snooze / Archive — thread states layered on top of the local sidebar row.
//
// archived := sidebarState.archivedAt != null   (an explicit archive timestamp).
//             archiveWorkspace also sets isHidden so the row leaves the active
//             lane, but the ARCHIVED signal is archivedAt — NOT raw isHidden.
//             Raw isHidden WITHOUT a timestamp is still produced by whole-project
//             teardown and by LEGACY hidden mains (pre MASTER-ARCHIVE-ONLY, when a
//             master-card remove hid instead of archiving) — these must not
//             surface as archived. A master-card remove now archives (archivedAt).
// snoozed  := snooze timer still in the future, OR an "until next launch"
//             snooze whose launch id matches THIS app launch.
// active   := neither.
//
// All local-only and visual-only — these helpers only classify; nothing here
// touches a worktree or a running session.
// ---------------------------------------------------------------------------

/** One id per app launch. An "until next launch" snooze stores this; on the
 * next launch the id differs, so the thread is no longer snoozed. */
export const APP_LAUNCH_ID = crypto.randomUUID();

interface SidebarWorkspaceStateFields {
	isHidden?: boolean | null;
	archivedAt?: number | null;
	snoozeUntil?: number | null;
	snoozeLaunchId?: string | null;
	completedAt?: number | null;
	// (RECYCLE-BIN) Soft-delete timestamp — presence makes the thread bucket
	// "deleted" (highest precedence), surfacing it ONLY in the Recycle Bin.
	deletedAt?: number | null;
}

type SidebarWorkspaceStateSource =
	| (SidebarWorkspaceStateFields & { type?: string | null })
	| { sidebarState: SidebarWorkspaceStateFields; type?: string | null };

function readSidebarWorkspaceState(
	workspace: SidebarWorkspaceStateSource,
): SidebarWorkspaceStateFields {
	return "sidebarState" in workspace ? workspace.sidebarState : workspace;
}

/** The workspace "type" (e.g. "main") lives on the workspace row, alongside the
 * sidebar state. Reading it lets the classifier treat a removed non-main thread
 * as archived while keeping a removed main workspace merely hidden. */
function readWorkspaceType(
	workspace: SidebarWorkspaceStateSource,
): string | null | undefined {
	return (workspace as { type?: string | null }).type;
}

/** (RECYCLE-BIN) A thread is soft-deleted while `deletedAt` is set. The Recycle
 * Bin is the ONLY surface for it — the bucket classifier checks this FIRST so a
 * deleted thread never reappears under Archived/Snoozed/Completed. Visual-only;
 * the worktree and branch are untouched until a permanent destroy. */
export function isWorkspaceDeleted(
	workspace: SidebarWorkspaceStateSource,
): boolean {
	return readSidebarWorkspaceState(workspace).deletedAt != null;
}

export function isWorkspaceArchived(
	workspace: SidebarWorkspaceStateSource,
	workspaceType?: string | null,
): boolean {
	const state = readSidebarWorkspaceState(workspace);
	if (state.archivedAt != null) return true;
	// A non-main thread removed via "Remove from Sidebar" (isHidden, no archive
	// timestamp) surfaces under Archived — recoverable. A removed main/pinned
	// workspace stays fully hidden and is never treated as archived.
	const type = workspaceType ?? readWorkspaceType(workspace);
	return state.isHidden === true && type !== "main";
}

export function isWorkspaceSnoozed(
	workspace: SidebarWorkspaceStateSource,
	nowMs: number = Date.now(),
): boolean {
	const state = readSidebarWorkspaceState(workspace);
	if (state.snoozeLaunchId != null && state.snoozeLaunchId === APP_LAUNCH_ID) {
		return true;
	}
	return typeof state.snoozeUntil === "number" && state.snoozeUntil > nowMs;
}

export type SidebarWorkspaceBucket =
	| "active"
	| "snoozed"
	| "archived"
	| "hidden"
	| "completed"
	| "deleted";

export function getWorkspaceSidebarBucket(
	workspace: SidebarWorkspaceStateSource,
	nowMs: number = Date.now(),
	workspaceType?: string | null,
): SidebarWorkspaceBucket {
	// (RECYCLE-BIN) checked FIRST of all: deleteWorkspace also sets isHidden (and
	// clears every other state flag), but a soft-deleted thread must surface ONLY
	// in the Recycle Bin — never under Completed/Archived/Snoozed/Hidden. Restore
	// clears deletedAt to return it to active.
	if (isWorkspaceDeleted(workspace)) return "deleted";
	// (KANBAN COMPLETED) checked next: completeWorkspace also sets isHidden so
	// raw-visibility consumers hide the row, but isHidden + non-main would
	// classify "archived" below and surface the thread under the project's
	// Archived section. Completed threads have NO sidebar surface at all — the
	// kanban Completed column is the only place they exist.
	if (readSidebarWorkspaceState(workspace).completedAt != null) {
		return "completed";
	}
	// Main rows can be snoozed/archived on purpose (the UI offers it). A main with
	// archivedAt set buckets "archived" below; a main hidden WITHOUT an archive
	// timestamp stays merely "hidden" — isWorkspaceArchived's `&& type !== "main"`
	// keeps an accidental remove out of "archived" (so it still resurrects on
	// reopen, never silently archived).
	if (isWorkspaceArchived(workspace, workspaceType)) return "archived";
	if (isWorkspaceSnoozed(workspace, nowMs)) return "snoozed";
	// A removed non-main workspace (isHidden, no archive timestamp) is hidden
	// outright — not archived, not snoozed, and NOT in the active lane.
	if (readSidebarWorkspaceState(workspace).isHidden === true) return "hidden";
	return "active";
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** (RECYCLE-BIN) Retention is a DISPLAY filter only — nothing is ever
 * auto-purged. Returns true when an item should be shown by default in the bin:
 * a missing timestamp is always shown, otherwise it's within the last
 * `retentionDays`. Older items are kept but collapsed behind the per-bin
 * "Show all" toggle. */
export function isWithinRecycleBinWindow(
	deletedAt: number | null | undefined,
	retentionDays: number,
	nowMs: number = Date.now(),
): boolean {
	if (deletedAt == null) return true;
	return nowMs - deletedAt <= retentionDays * DAY_MS;
}

export type SnoozeDuration =
	| { kind: "next-launch" }
	| { kind: "tomorrow" }
	| { kind: "ms"; ms: number }
	| { kind: "hours"; hours: number };

export interface SnoozePresetOption {
	id: string;
	label: string;
	duration: SnoozeDuration;
}

/** Preset entries for the Snooze submenu, in display order. The custom
 * "N hours" entry is rendered separately as an inline field. */
export const SNOOZE_PRESET_OPTIONS: readonly SnoozePresetOption[] = [
	{ id: "tomorrow", label: "Until tomorrow", duration: { kind: "tomorrow" } },
	{ id: "1d", label: "1 day", duration: { kind: "ms", ms: DAY_MS } },
	{ id: "3d", label: "3 days", duration: { kind: "ms", ms: 3 * DAY_MS } },
	{ id: "1w", label: "1 week", duration: { kind: "ms", ms: 7 * DAY_MS } },
	{
		id: "next-launch",
		label: "Until next launch",
		duration: { kind: "next-launch" },
	},
] as const;

/** Resolve a chosen duration to a stored snooze value: an absolute epoch-ms
 * deadline, or the "next-launch" sentinel handled by the caller. */
export function computeSnoozeUntil(
	duration: SnoozeDuration,
	nowMs: number = Date.now(),
): number | "next-launch" {
	switch (duration.kind) {
		case "next-launch":
			return "next-launch";
		case "hours":
			return nowMs + Math.max(1, Math.round(duration.hours * HOUR_MS));
		case "ms":
			return nowMs + duration.ms;
		case "tomorrow": {
			const tomorrow = new Date(nowMs);
			tomorrow.setDate(tomorrow.getDate() + 1);
			tomorrow.setHours(9, 0, 0, 0);
			return tomorrow.getTime();
		}
	}
}

/** Short label for how long a snooze has left: "launch", "5m", "3h", "2d". */
export function formatSnoozeRemaining(
	snoozeUntil: number | null | undefined,
	snoozeLaunchId: string | null | undefined,
	nowMs: number = Date.now(),
): string {
	if (
		snoozeLaunchId != null &&
		snoozeLaunchId === APP_LAUNCH_ID &&
		(typeof snoozeUntil !== "number" || snoozeUntil <= nowMs)
	) {
		return "launch";
	}
	if (typeof snoozeUntil !== "number") return "";
	const remaining = snoozeUntil - nowMs;
	if (remaining <= 0) return "";
	const minutes = Math.round(remaining / 60_000);
	if (minutes < 60) return `${Math.max(1, minutes)}m`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.round(hours / 24)}d`;
}
