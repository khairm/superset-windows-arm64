import type { WorkspaceTransactionSnapshot } from "renderer/stores/workspace-creates";

export type DashboardSidebarWorkspaceHostType =
	| "local-device"
	| "remote-device"
	| "cloud";

export type DashboardSidebarWorkspaceType = "main" | "worktree" | "session";

export type DashboardSidebarWorkspaceIndentation =
	| "top-level"
	| "workspace"
	| "grouped";

export interface DashboardSidebarWorkspacePullRequestCheck {
	name: string;
	status: "success" | "failure" | "pending" | "skipped" | "cancelled";
	url: string | null;
}

export interface DashboardSidebarWorkspacePullRequest {
	url: string;
	number: number;
	title: string;
	state: "open" | "merged" | "closed" | "draft" | "queued";
	reviewDecision: "approved" | "changes_requested" | "pending" | null;
	requestedReviewers?: string[];
	checksStatus: "success" | "failure" | "pending" | "none";
	checks: DashboardSidebarWorkspacePullRequestCheck[];
}

export interface DashboardSidebarWorkspace {
	id: string;
	/** Null for project-less "session" workspaces. */
	projectId: string | null;
	hostId: string;
	hostType: DashboardSidebarWorkspaceHostType;
	type: DashboardSidebarWorkspaceType;
	hostIsOnline: boolean | null;
	accentColor: string | null;
	name: string;
	branch: string;
	pullRequest: DashboardSidebarWorkspacePullRequest | null;
	repoUrl: string | null;
	branchExistsOnRemote: boolean;
	previewUrl: string | null;
	needsRebase: boolean | null;
	behindCount: number | null;
	createdAt: Date;
	updatedAt: Date;
	/**
	 * Epoch ms of the newest agent lifecycle event, stamped by the workspace's
	 * host. Null when the host predates the column (rank by `updatedAt`).
	 * Unlike `updatedAt` it never moves on metadata writes.
	 */
	lastActivityAt: number | null;
	taskId: string | null;
	isPinned: boolean;
	pendingTransaction: WorkspaceTransactionSnapshot | null;
	// Snooze / archive state — populated for items rendered inside the
	// Snoozed / Archived sections (used for sort + the "time left" badge).
	snoozeUntil?: number | null;
	snoozeLaunchId?: string | null;
	archivedAt?: number | null;
	// (RECYCLE-BIN) Soft-delete timestamp — populated for items rendered inside
	// the Recycle Bin section (used for sort + the retention "Show all" filter).
	deletedAt?: number | null;
	/** Precomputed "time left" label for a snoozed row (e.g. "3d"), derived in
	 * the data hook from the live tick so the badge actually counts down. */
	snoozeRemainingLabel?: string;
	/** Set briefly on an active row that just auto-returned from snooze, to
	 * drive a subtle one-shot "just returned" highlight. */
	justReturned?: boolean;
}

/**
 * A pinned workspace rendered in the sidebar's top-level Pinned section.
 * Carries its project's identity since the row renders outside any project
 * group.
 */
export type DashboardSidebarPinnedWorkspace = DashboardSidebarWorkspace & {
	/** Null for project-less "session" workspaces. */
	projectName: string | null;
	projectIconUrl: string | null;
};

export interface DashboardSidebarSection {
	id: string;
	projectId: string;
	name: string;
	createdAt: Date;
	isCollapsed: boolean;
	tabOrder: number;
	color: string | null;
	workspaces: DashboardSidebarWorkspace[];
}

/**
 * The Sessions lane: project-less workspaces and their tag folders, shaped
 * exactly like a project's children so the same list rendering and DnD
 * apply. Folder ids are keyed by the Sessions tag scope.
 */
export interface DashboardSidebarSessions {
	children: DashboardSidebarProjectChild[];
	/** Every session in render order (ungrouped and grouped), for flat consumers. */
	workspaces: DashboardSidebarWorkspace[];
}

export type DashboardSidebarProjectChild =
	| {
			type: "workspace";
			workspace: DashboardSidebarWorkspace;
	  }
	| {
			type: "section";
			section: DashboardSidebarSection;
	  };

export interface DashboardSidebarProject {
	id: string;
	name: string;
	githubOwner: string | null;
	githubRepoName: string | null;
	iconUrl: string | null;
	/** Accent color as a `#rrggbb` hex, or null for the default. */
	color: string | null;
	createdAt: Date;
	updatedAt: Date;
	isCollapsed: boolean;
	// (ACTIVE-FIRST) Manually pinned (right-click). Pinned projects sort into the
	// top tier, above active (badge > 0) and idle (badge 0) projects.
	isPinned: boolean;
	children: DashboardSidebarProjectChild[];
	// Snoozed / archived / soft-deleted threads live outside `children` (so they
	// don't count toward the active badge or the DnD lane) and render in their own
	// reveal-able sections below the active list.
	snoozedWorkspaces: DashboardSidebarWorkspace[];
	archivedWorkspaces: DashboardSidebarWorkspace[];
	// (RECYCLE-BIN) Soft-deleted threads, sorted by deletedAt DESC. Intentionally
	// the FULL, unfiltered bin — the retention window is applied ONLY in the section
	// component for display (and its "Show all" toggle overrides it locally), and the
	// header count is derived straight from this array's length. Do NOT filter it
	// here: Restore-all / Empty-bin must act on older-than-retention items too.
	deletedWorkspaces: DashboardSidebarWorkspace[];
	showSnoozed: boolean;
	showArchived: boolean;
	snoozedCollapsed: boolean;
	archivedCollapsed: boolean;
	// (RECYCLE-BIN) reveal + collapse for the per-project Recycle Bin section.
	showDeleted: boolean;
	deletedCollapsed: boolean;
}
