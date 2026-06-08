import type { WorkspaceTransactionSnapshot } from "renderer/stores/workspace-creates";

export type DashboardSidebarWorkspaceHostType =
	| "local-device"
	| "remote-device"
	| "cloud";

export type DashboardSidebarWorkspaceType = "main" | "worktree";

export interface DashboardSidebarWorkspacePullRequestCheck {
	name: string;
	status: "success" | "failure" | "pending" | "skipped" | "cancelled";
	url: string | null;
}

export interface DashboardSidebarWorkspacePullRequest {
	url: string;
	number: number;
	title: string;
	state: "open" | "merged" | "closed" | "draft";
	reviewDecision: "approved" | "changes_requested" | "pending" | null;
	requestedReviewers?: string[];
	checksStatus: "success" | "failure" | "pending" | "none";
	checks: DashboardSidebarWorkspacePullRequestCheck[];
}

export interface DashboardSidebarWorkspace {
	id: string;
	projectId: string;
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
	taskId: string | null;
	pendingTransaction: WorkspaceTransactionSnapshot | null;
	// Snooze / archive state — populated for items rendered inside the
	// Snoozed / Archived sections (used for sort + the "time left" badge).
	snoozeUntil?: number | null;
	snoozeLaunchId?: string | null;
	archivedAt?: number | null;
	/** Precomputed "time left" label for a snoozed row (e.g. "3d"), derived in
	 * the data hook from the live tick so the badge actually counts down. */
	snoozeRemainingLabel?: string;
	/** Set briefly on an active row that just auto-returned from snooze, to
	 * drive a subtle one-shot "just returned" highlight. */
	justReturned?: boolean;
}

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
	slug: string;
	githubRepositoryId: string | null;
	githubOwner: string | null;
	githubRepoName: string | null;
	iconUrl: string | null;
	createdAt: Date;
	updatedAt: Date;
	isCollapsed: boolean;
	children: DashboardSidebarProjectChild[];
	// Snoozed / archived threads live outside `children` (so they don't count
	// toward the active badge or the DnD lane) and render in their own
	// reveal-able sections below the active list.
	snoozedWorkspaces: DashboardSidebarWorkspace[];
	archivedWorkspaces: DashboardSidebarWorkspace[];
	showSnoozed: boolean;
	showArchived: boolean;
	snoozedCollapsed: boolean;
	archivedCollapsed: boolean;
}
