import { useLingui } from "@lingui/react/macro";
import { useLiveQuery } from "@tanstack/react-db";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import {
	useCallback,
	useEffect,
	useMemo,
	useReducer,
	useRef,
	useState,
} from "react";
import { resolveProjectIconUrl } from "renderer/hooks/host-projects/resolveProjectIconUrl";
import { useHostProjects } from "renderer/hooks/host-projects/useHostProjects";
import { useKnownHosts } from "renderer/hooks/known-hosts/useKnownHosts";
import { useActiveOrganizationId } from "renderer/hooks/useActiveOrganizationId";
import { useCloudWorkspaces } from "renderer/hooks/useCloudWorkspaces";
import { useRelayUrl } from "renderer/hooks/useRelayUrl";
import { authClient } from "renderer/lib/auth-client";
import { getHostServiceClientByUrl } from "renderer/lib/host-service-client";
import {
	type CloudPullRequestRef,
	useCloudPullRequests,
} from "renderer/routes/_authenticated/_dashboard/hooks/useCloudPullRequests";
import { useCloudWorkspaceRepositories } from "renderer/routes/_authenticated/_dashboard/hooks/useCloudWorkspaceRepositories";
import {
	EMPTY_CLOUD_SIDEBAR,
	useCloudSidebarStore,
} from "renderer/routes/_authenticated/_dashboard/stores/cloudSidebarStore";
import { isInCloudSidebar } from "renderer/routes/_authenticated/_dashboard/utils/buildCloudSidebar";
import { useDashboardSidebarState } from "renderer/routes/_authenticated/hooks/useDashboardSidebarState";
import { useCollections } from "renderer/routes/_authenticated/providers/CollectionsProvider";
import {
	APP_LAUNCH_ID,
	getWorkspaceSidebarBucket,
	isSnoozeDue,
} from "renderer/routes/_authenticated/providers/CollectionsProvider/dashboardSidebarLocal";
import { useHostWorkspaces } from "renderer/routes/_authenticated/providers/HostWorkspacesProvider";
import { useLocalHostService } from "renderer/routes/_authenticated/providers/LocalHostServiceProvider";
import {
	deriveTagFolders,
	useTagFolderContext,
} from "renderer/routes/_authenticated/utils/workspaceTagFolders";
import { useWorkspaceTransactionsStore } from "renderer/stores/workspace-creates";
import type {
	DashboardSidebarGithubHold,
	DashboardSidebarHiddenProject,
	DashboardSidebarPinnedWorkspace,
	DashboardSidebarProject,
	DashboardSidebarProjectChild,
	DashboardSidebarSection,
	DashboardSidebarWorkspace,
} from "../../types";
import { useSnoozeWake } from "../useSnoozeWake";
import {
	applyCloudSidebarPinnedRows,
	applyCloudSidebarRows,
} from "./applyCloudSidebarRows";
import { buildCloudSidebarWorkspaces } from "./buildCloudSidebarWorkspaces";
// The project tree itself is still built INLINE below (computedGroups): the
// extracted builder has no notion of the fork's Snoozed / Archived / Recycle
// Bin buckets or the just-returned highlight. Only upstream's pinned and
// session helpers are shared from it.
import {
	buildDashboardSidebarInactiveSessionWorkspaces,
	buildDashboardSidebarPinnedWorkspaces,
	buildDashboardSidebarSessions,
	partitionSidebarWorkspacesByPinned,
	partitionSidebarWorkspacesBySession,
} from "./buildDashboardSidebarProjects";
import {
	derivePullRequestQueryTargets,
	getDashboardSidebarPullRequestQueryKey,
	type PullRequestQueryTarget,
} from "./derivePullRequestQueryTargets";
import { pickGithubStatus } from "./pickGithubStatus";
import { createPullRequestRefreshGate } from "./pullRequestRefreshCooldown";

// Module-level so remounting the sidebar doesn't reset the cool-down.
const pullRequestRefreshGate = createPullRequestRefreshGate();

type SidebarPullRequest = DashboardSidebarWorkspace["pullRequest"];
type PullRequestWorkspaceRow = {
	workspaceId: string;
	pullRequest: SidebarPullRequest;
};

function haveSameProjects(
	left: DashboardSidebarProject[],
	right: DashboardSidebarProject[],
): boolean {
	return (
		left.length === right.length &&
		left.every((project, index) => project === right[index])
	);
}

function getPullRequestRowsFingerprint(
	rows: PullRequestWorkspaceRow[],
): string {
	return JSON.stringify(
		rows
			.map((row) => [row.workspaceId, row.pullRequest] as const)
			.sort(([leftWorkspaceId], [rightWorkspaceId]) =>
				leftWorkspaceId.localeCompare(rightWorkspaceId),
			),
	);
}

function getDashboardSidebarProjectFingerprint(
	project: DashboardSidebarProject,
): string {
	return JSON.stringify(project);
}

function useStablePullRequestsByWorkspaceId(
	rows: PullRequestWorkspaceRow[] | undefined,
): Map<string, SidebarPullRequest> {
	const previousRef = useRef<{
		fingerprint: string;
		map: Map<string, SidebarPullRequest>;
	} | null>(null);

	return useMemo(() => {
		const nextRows = rows ?? [];
		const fingerprint = getPullRequestRowsFingerprint(nextRows);
		const previous = previousRef.current;
		if (previous?.fingerprint === fingerprint) {
			return previous.map;
		}

		const map = new Map(
			nextRows.map((workspace) => [
				workspace.workspaceId,
				workspace.pullRequest,
			]),
		);
		previousRef.current = { fingerprint, map };
		return map;
	}, [rows]);
}

/**
 * Returns the previous reference while the JSON serialization is unchanged.
 * Same purpose as the fingerprinted hooks below: the sidebar builders produce
 * fresh arrays every run, and downstream memoization needs stable identities.
 */
function useJsonStable<Value>(value: Value): Value {
	const previousRef = useRef<{ fingerprint: string; value: Value } | null>(
		null,
	);
	return useMemo(() => {
		const fingerprint = JSON.stringify(value);
		const previous = previousRef.current;
		if (previous?.fingerprint === fingerprint) {
			return previous.value;
		}
		previousRef.current = { fingerprint, value };
		return value;
	}, [value]);
}

function useStableDashboardSidebarProjects(
	projects: DashboardSidebarProject[],
): DashboardSidebarProject[] {
	const previousRef = useRef<{
		projects: DashboardSidebarProject[];
		byId: Map<
			string,
			{ fingerprint: string; project: DashboardSidebarProject }
		>;
	} | null>(null);

	return useMemo(() => {
		const previous = previousRef.current;
		const nextById = new Map<
			string,
			{ fingerprint: string; project: DashboardSidebarProject }
		>();
		const nextProjects = projects.map((project) => {
			const fingerprint = getDashboardSidebarProjectFingerprint(project);
			const previousProject = previous?.byId.get(project.id);
			const stableProject =
				previousProject?.fingerprint === fingerprint
					? previousProject.project
					: project;

			nextById.set(project.id, { fingerprint, project: stableProject });
			return stableProject;
		});

		if (previous && haveSameProjects(previous.projects, nextProjects)) {
			previousRef.current = { projects: previous.projects, byId: nextById };
			return previous.projects;
		}

		previousRef.current = { projects: nextProjects, byId: nextById };
		return nextProjects;
	}, [projects]);
}

interface UseDashboardSidebarDataOptions {
	/**
	 * File cloud workspaces under their repo's project instead of leaving
	 * them to the Cloud section.
	 */
	inlineCloudWorkspaces?: boolean;
}

export function useDashboardSidebarData({
	inlineCloudWorkspaces = false,
}: UseDashboardSidebarDataOptions = {}) {
	const { t } = useLingui();
	const collections = useCollections();
	const { machineId, activeHostUrl } = useLocalHostService();
	const relayUrl = useRelayUrl();
	const {
		autoReturnSnoozedWorkspace,
		ensureProjectInSidebar,
		ensureWorkspaceInSidebar,
		toggleProjectCollapsed,
	} = useDashboardSidebarState();
	const queryClient = useQueryClient();
	const workspaceTransactionsById = useWorkspaceTransactionsStore(
		(state) => state.byWorkspaceId,
	);

	const { hosts, organizationId: knownHostsOrgId } = useKnownHosts();
	const hostsByMachineId = useMemo(
		() => new Map(hosts.map((host) => [host.machineId, host])),
		[hosts],
	);

	// Placement (order/collapse) is local; project identity comes from the
	// host fan-out (useHostProjects) — projects are fully local, so the
	// sidebar joins the two in JS on the project id.
	const { data: sidebarProjectRows = [], isReady: sidebarProjectRowsReady } =
		useLiveQuery(
			(q) =>
				q
					.from({ sidebarProjects: collections.v2SidebarProjects })
					.select(({ sidebarProjects }) => ({
						projectId: sidebarProjects.projectId,
						isCollapsed: sidebarProjects.isCollapsed,
						isHidden: sidebarProjects.isHidden,
						tabOrder: sidebarProjects.tabOrder,
						isPinned: sidebarProjects.isPinned,
						showSnoozed: sidebarProjects.showSnoozed,
						showArchived: sidebarProjects.showArchived,
						snoozedCollapsed: sidebarProjects.snoozedCollapsed,
						archivedCollapsed: sidebarProjects.archivedCollapsed,
						// (RECYCLE-BIN) reveal + collapse for the per-project Recycle Bin.
						showDeleted: sidebarProjects.showDeleted,
						deletedCollapsed: sidebarProjects.deletedCollapsed,
					})),
			[collections],
		);
	// Sorted in JS, not via the query's orderBy: the incremental orderBy
	// does not reliably re-sort on row inserts/renumbers (a newly added
	// project stayed appended at the bottom until reload), and tabOrders
	// can collide (bulk ensure paths mint duplicates) so ties need a
	// stable secondary key. Workspaces/sections don't need this — the
	// project-tree builder re-sorts them by tabOrder itself.
	const orderedSidebarProjectRows = useMemo(
		() =>
			[...sidebarProjectRows].sort(
				(left, right) =>
					left.tabOrder - right.tabOrder ||
					left.projectId.localeCompare(right.projectId),
			),
		[sidebarProjectRows],
	);

	const { projects: hostProjects, isReady: hostProjectsReady } =
		useHostProjects();

	const hostProjectsByKey = useMemo(
		() => new Map(hostProjects.map((project) => [project.projectKey, project])),
		[hostProjects],
	);
	const sidebarProjects = useMemo(
		() =>
			orderedSidebarProjectRows.flatMap((row) => {
				// A hidden project keeps its placement rows but renders nowhere;
				// it comes back through the "hidden projects" restore list.
				if (row.isHidden) return [];
				const project = hostProjectsByKey.get(row.projectId);
				// No host serves it: stale placement row (deleted project) — drop
				// it, same as the old inner join did.
				if (!project) return [];
				return [
					{
						id: project.projectKey,
						name: project.name,
						githubOwner: project.repoOwner,
						githubRepoName: project.repoName,
						iconUrl: resolveProjectIconUrl(project),
						color: project.color,
						createdAt: new Date(project.createdAt),
						updatedAt: new Date(project.updatedAt),
						isCollapsed: row.isCollapsed,
						// Heal legacy project rows persisted before the reveal flags existed
						// (they read back undefined despite the boolean type).
						isPinned: row.isPinned ?? false,
						showSnoozed: row.showSnoozed ?? false,
						showArchived: row.showArchived ?? false,
						snoozedCollapsed: row.snoozedCollapsed ?? false,
						archivedCollapsed: row.archivedCollapsed ?? false,
						// (RECYCLE-BIN) heal rows persisted before the bin flags existed.
						showDeleted: row.showDeleted ?? false,
						deletedCollapsed: row.deletedCollapsed ?? false,
					},
				];
			}),
		[orderedSidebarProjectRows, hostProjectsByKey],
	);
	// Cloud rows match against every project a host serves, visible first so
	// sidebar order still breaks ties: a hidden project keeps its cloud rows
	// (hidden with it) instead of losing them to a stand-in.
	const cloudProjectTargets = useMemo(() => {
		const visible = new Set(sidebarProjects.map((project) => project.id));
		return [
			...sidebarProjects,
			...hostProjects
				.filter((project) => !visible.has(project.projectKey))
				.map((project) => ({
					id: project.projectKey,
					githubOwner: project.repoOwner,
					githubRepoName: project.repoName,
				})),
		];
	}, [sidebarProjects, hostProjects]);
	const hiddenProjects = useMemo<DashboardSidebarHiddenProject[]>(
		() =>
			orderedSidebarProjectRows.flatMap((row) => {
				if (!row.isHidden) return [];
				const project = hostProjectsByKey.get(row.projectId);
				if (!project) return [];
				return [
					{
						id: project.projectKey,
						name: project.name,
						iconUrl: resolveProjectIconUrl(project),
						color: project.color,
					},
				];
			}),
		[orderedSidebarProjectRows, hostProjectsByKey],
	);

	const { data: storedSidebarSections = [] } = useLiveQuery(
		(q) =>
			q
				.from({ sidebarSections: collections.v2SidebarSections })
				// Same tie-breaking rationale as the projects query above.
				.orderBy(({ sidebarSections }) => sidebarSections.tabOrder, "asc")
				.orderBy(({ sidebarSections }) => sidebarSections.sectionId, "asc")
				.select(({ sidebarSections }) => ({
					sectionId: sidebarSections.sectionId,
					projectId: sidebarSections.projectId,
					name: sidebarSections.name,
					createdAt: sidebarSections.createdAt,
					isCollapsed: sidebarSections.isCollapsed,
					tabOrder: sidebarSections.tabOrder,
					color: sidebarSections.color,
					tag: sidebarSections.tag,
				})),
		[collections],
	);

	const { workspaces: allHostWorkspaces, cache: hostWorkspacesCache } =
		useHostWorkspaces();
	// A cloud workspace's rows come from the cloud list, never from its
	// sandbox's host rows, whatever placement their local-state row carries.
	const hostWorkspaces = useMemo(
		() =>
			allHostWorkspaces.filter(
				(workspace) => !hostWorkspacesCache.isSandboxHost(workspace.hostId),
			),
		[allHostWorkspaces, hostWorkspacesCache],
	);
	const hostWorkspacesById = useMemo(
		() => new Map(hostWorkspaces.map((workspace) => [workspace.id, workspace])),
		[hostWorkspaces],
	);

	// The section lane the builder consumes is the deriveTagFolders union:
	// stored presentation rows PLUS folders that exist only because some
	// workspace carries the tag. A folder must exist because a workspace
	// carries the tag, not because a local row does.
	const tagFolderContext = useTagFolderContext();
	const sidebarSections = useMemo(
		() =>
			deriveTagFolders(
				storedSidebarSections,
				hostWorkspaces,
				tagFolderContext,
			).map((section) => ({
				id: section.sectionId,
				projectId: section.projectId,
				name: section.name,
				createdAt: section.createdAt,
				isCollapsed: section.isCollapsed,
				tabOrder: section.tabOrder,
				color: section.color,
				tag: section.tag,
			})),
		[hostWorkspaces, storedSidebarSections, tagFolderContext],
	);

	const { data: sidebarLocalStateRows = [], isReady: sidebarLocalStateReady } =
		useLiveQuery(
			(q) =>
				q
					.from({ sidebarWorkspaces: collections.v2WorkspaceLocalState })
					// Same tie-breaking rationale as the projects query above.
					.orderBy(
						({ sidebarWorkspaces }) => sidebarWorkspaces.sidebarState.tabOrder,
						"asc",
					)
					.orderBy(
						({ sidebarWorkspaces }) => sidebarWorkspaces.workspaceId,
						"asc",
					)
					.select(({ sidebarWorkspaces }) => ({
						workspaceId: sidebarWorkspaces.workspaceId,
						projectId: sidebarWorkspaces.sidebarState.projectId,
						tabOrder: sidebarWorkspaces.sidebarState.tabOrder,
						sectionId: sidebarWorkspaces.sidebarState.sectionId,
						isHidden: sidebarWorkspaces.sidebarState.isHidden,
						pinnedAt: sidebarWorkspaces.sidebarState.pinnedAt,
						snoozeUntil: sidebarWorkspaces.sidebarState.snoozeUntil,
						snoozeLaunchId: sidebarWorkspaces.sidebarState.snoozeLaunchId,
						archivedAt: sidebarWorkspaces.sidebarState.archivedAt,
						// (KANBAN COMPLETED) must be projected or the bucket classifier
						// below can't see it — completed rows are also isHidden and would
						// misclassify as "archived" (surfacing under the Archived section).
						completedAt: sidebarWorkspaces.sidebarState.completedAt,
						// (RECYCLE-BIN) likewise projected so the classifier buckets it
						// "deleted" (deletedAt is checked first) and the Recycle Bin
						// section can sort by it / apply the retention window.
						deletedAt: sidebarWorkspaces.sidebarState.deletedAt,
					})),
			[collections],
		);
	const sidebarProjectRowsById = useMemo(
		() => new Map(orderedSidebarProjectRows.map((row) => [row.projectId, row])),
		[orderedSidebarProjectRows],
	);
	const organizationId = useActiveOrganizationId();
	const { data: session } = authClient.useSession();
	const userId = session?.user?.id ?? null;
	const { workspaces: cloudRows, isFresh: isCloudListFresh } =
		useCloudWorkspaces();
	const cloudSidebarEntries = useCloudSidebarStore((state) =>
		organizationId
			? (state.byOrganization[organizationId] ?? EMPTY_CLOUD_SIDEBAR).entries
			: EMPTY_CLOUD_SIDEBAR.entries,
	);
	const pruneCloudSidebarEntries = useCloudSidebarStore(
		(state) => state.pruneEntries,
	);
	useEffect(() => {
		if (
			!inlineCloudWorkspaces ||
			!organizationId ||
			!cloudRows ||
			!isCloudListFresh
		) {
			return;
		}
		pruneCloudSidebarEntries(
			organizationId,
			new Set(cloudRows.map((row) => row.id)),
		);
	}, [
		inlineCloudWorkspaces,
		organizationId,
		cloudRows,
		isCloudListFresh,
		pruneCloudSidebarEntries,
	]);
	const shownCloudRows = useMemo(
		() =>
			inlineCloudWorkspaces
				? (cloudRows ?? []).filter((row) =>
						isInCloudSidebar(row, cloudSidebarEntries[row.id], userId),
					)
				: [],
		[inlineCloudWorkspaces, cloudRows, cloudSidebarEntries, userId],
	);
	const {
		primaryRepositoryById: cloudRepoFullNameById,
		isReady: cloudRepositoriesReady,
		refetch: refetchCloudRepositories,
	} = useCloudWorkspaceRepositories({
		organizationId,
		enabled: shownCloudRows.length > 0,
	});
	// The repo list is cached for minutes; a workspace created since then
	// has no repo here and would file under the unknown-repo stand-in until
	// the next fetch. Fetch once per unknown id, so a workspace that truly
	// has no repo can't loop it.
	const repoRefetchedForRef = useRef(new Set<string>());
	useEffect(() => {
		if (!cloudRepositoriesReady) return;
		const unknown = shownCloudRows.filter(
			(row) =>
				!cloudRepoFullNameById.has(row.id) &&
				!repoRefetchedForRef.current.has(row.id),
		);
		if (unknown.length === 0) return;
		for (const row of unknown) repoRefetchedForRef.current.add(row.id);
		void refetchCloudRepositories();
	}, [
		cloudRepositoriesReady,
		shownCloudRows,
		cloudRepoFullNameById,
		refetchCloudRepositories,
	]);
	// Only the open workspace's sandbox is a host, and it alone knows the
	// branch the agent has moved to; every other row shows its created branch.
	const cloudBranchById = useMemo(
		() =>
			new Map(
				allHostWorkspaces.map((workspace) => [workspace.id, workspace.branch]),
			),
		[allHostWorkspaces],
	);
	const cloudPullRequestRefs = useMemo<CloudPullRequestRef[]>(
		() =>
			shownCloudRows.flatMap((row) => {
				const repoFullName = cloudRepoFullNameById.get(row.id);
				return repoFullName
					? [
							{
								repoFullName,
								headBranch: cloudBranchById.get(row.id) ?? row.branch,
							},
						]
					: [];
			}),
		[shownCloudRows, cloudRepoFullNameById, cloudBranchById],
	);
	const { byRef: cloudPullRequestsByRef } =
		useCloudPullRequests(cloudPullRequestRefs);
	const cloudLayout = useMemo(
		() =>
			inlineCloudWorkspaces
				? buildCloudSidebarWorkspaces({
						cloudWorkspaces: shownCloudRows,
						userId,
						projects: cloudProjectTargets,
						repoFullNameById: cloudRepoFullNameById,
						branchById: cloudBranchById,
						pullRequestsByRef: cloudPullRequestsByRef,
						unknownRepoProjectName: t({ message: "Cloud" }),
					})
				: null,
		[
			inlineCloudWorkspaces,
			shownCloudRows,
			userId,
			cloudProjectTargets,
			cloudRepoFullNameById,
			cloudBranchById,
			cloudPullRequestsByRef,
			t,
		],
	);
	const cloudRowById = useMemo(() => {
		const byId = new Map<string, DashboardSidebarWorkspace>();
		if (!cloudLayout) return byId;
		for (const rows of cloudLayout.byProjectId.values()) {
			for (const row of rows) byId.set(row.id, row);
		}
		for (const repoProject of cloudLayout.repoProjects) {
			for (const row of repoProject.cloudWorkspaces) byId.set(row.id, row);
		}
		return byId;
	}, [cloudLayout]);
	const standInProjectIds = useMemo(
		() =>
			new Set(
				(cloudLayout?.repoProjects ?? []).map((repoProject) => repoProject.id),
			),
		[cloudLayout],
	);
	// Cloud rows are placed like worktrees: a row-less workspace gets a
	// placement row once, and a hidden one stays hidden. The project is the
	// one fact the cloud list owns, so it follows a repo that resolves later
	// (stand-in to real project) without touching order or pin.
	useEffect(() => {
		if (
			!inlineCloudWorkspaces ||
			!sidebarLocalStateReady ||
			!cloudRepositoriesReady ||
			!hostProjectsReady
		) {
			return;
		}
		const placedById = new Map(
			sidebarLocalStateRows.map((row) => [row.workspaceId, row]),
		);
		// Each new row prepends, so walk oldest first and the latest ends on top.
		for (const row of [...cloudRowById.values()].reverse()) {
			const placed = placedById.get(row.id);
			if (!placed) {
				ensureWorkspaceInSidebar(row.id, row.projectId, {
					revealProject: false,
				});
				continue;
			}
			if (placed.projectId !== row.projectId) {
				collections.v2WorkspaceLocalState.update(row.id, (draft) => {
					draft.sidebarState.projectId = row.projectId;
				});
			}
		}
	}, [
		inlineCloudWorkspaces,
		sidebarLocalStateReady,
		cloudRepositoriesReady,
		hostProjectsReady,
		sidebarLocalStateRows,
		cloudRowById,
		ensureWorkspaceInSidebar,
		collections,
	]);
	// The builder files rows by project, so a stand-in repo project joins
	// the real ones here, in placement order; one seen for the first time
	// trails until its row lands.
	const builderProjects = useMemo(() => {
		if (!cloudLayout) return sidebarProjects;
		const standIns = cloudLayout.repoProjects.flatMap((repoProject) => {
			const row = sidebarProjectRowsById.get(repoProject.id);
			if (row?.isHidden) return [];
			return [
				{
					id: repoProject.id,
					name: repoProject.name,
					githubOwner: repoProject.githubOwner,
					githubRepoName: repoProject.githubRepoName,
					iconUrl: repoProject.iconUrl,
					color: null,
					createdAt: repoProject.createdAt,
					updatedAt: repoProject.updatedAt,
					isCollapsed: row?.isCollapsed ?? false,
					// A stand-in reads the same placement row as a real project, so
					// the fork's pin tier and its Snoozed / Archived / Recycle Bin
					// reveal + collapse flags come from there too.
					isPinned: row?.isPinned ?? false,
					showSnoozed: row?.showSnoozed ?? false,
					showArchived: row?.showArchived ?? false,
					snoozedCollapsed: row?.snoozedCollapsed ?? false,
					archivedCollapsed: row?.archivedCollapsed ?? false,
					showDeleted: row?.showDeleted ?? false,
					deletedCollapsed: row?.deletedCollapsed ?? false,
				},
			];
		});
		if (standIns.length === 0) return sidebarProjects;
		const orderIndexById = new Map(
			orderedSidebarProjectRows.map((row, index) => [row.projectId, index]),
		);
		const orderOf = (project: { id: string }) =>
			orderIndexById.get(project.id) ?? Number.MAX_SAFE_INTEGER;
		return [...sidebarProjects, ...standIns].sort(
			(left, right) => orderOf(left) - orderOf(right),
		);
	}, [
		cloudLayout,
		sidebarProjects,
		sidebarProjectRowsById,
		orderedSidebarProjectRows,
	]);
	const rawSidebarWorkspaces = useMemo(
		() =>
			sidebarLocalStateRows.flatMap((localState) => {
				// A cloud row carries no host tags; its folder is its local pointer.
				const source =
					hostWorkspacesById.get(localState.workspaceId) ??
					cloudRowById.get(localState.workspaceId);
				if (!source) return [];
				return [
					{
						id: source.id,
						projectId: localState.projectId,
						hostId: source.hostId,
						type: source.type,
						name: source.name,
						branch: source.branch,
						taskId: source.taskId,
						createdAt: source.createdAt,
						updatedAt: source.updatedAt,
						// (ACTIVITY-SPLIT) The activity stamp is deliberately NOT carried
						// here: activity is read from useHostWorkspaceActivityStore, and a
						// per-tick field on this row re-renders every sidebar consumer.
						tabOrder: localState.tabOrder,
						sectionId: localState.sectionId,
						tags: "tags" in source ? source.tags : null,
						isHidden: localState.isHidden,
						pinnedAt: localState.pinnedAt,
						// (SIDEBAR-STATE-PROJECTION) Carry the fork's FULL sidebar-state
						// fields through this projection. The bucket classifier and the
						// Snoozed / Archived / Recycle Bin sections read them off this
						// row — the v1.14.2 upstream merge rebuilt this mapping (host-
						// owned workspaces) and silently dropped them, which broke
						// snooze (rows never left the active lane), emptied the Recycle
						// Bin, vanished archived masters, and resurfaced completed
						// threads under Archived.
						snoozeUntil: localState.snoozeUntil,
						snoozeLaunchId: localState.snoozeLaunchId,
						archivedAt: localState.archivedAt,
						completedAt: localState.completedAt,
						deletedAt: localState.deletedAt,
					},
				];
			}),
		[cloudRowById, hostWorkspacesById, sidebarLocalStateRows],
	);
	const rawSidebarWorkspacesWithHostStatus = useMemo(
		() =>
			rawSidebarWorkspaces.map((workspace) => ({
				...workspace,
				hostIsOnline: hostsByMachineId.get(workspace.hostId)?.isOnline ?? false,
				pendingTransaction: workspaceTransactionsById[workspace.id] ?? null,
			})),
		[hostsByMachineId, rawSidebarWorkspaces, workspaceTransactionsById],
	);

	// (SNOOZE-WAKE-TICK)
	const wakeEpoch = useSnoozeWake(rawSidebarWorkspaces);
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-read the clock on row change and on a due tick
	const nowMs = useMemo(() => Date.now(), [rawSidebarWorkspaces, wakeEpoch]);

	// Ids whose snooze expired by TIMER (not via manual "Unsnooze now") — only
	// these flash the just-returned highlight when they re-enter the active lane.
	const autoReturnedIdsRef = useRef<Set<string>>(new Set());

	// Lazily clear snooze fields once they expire (a past deadline, or an
	// "until next launch" snooze from a previous launch) so stale markers don't
	// accumulate and a returned thread carries no leftover snooze state.
	useEffect(() => {
		const expiredIds: string[] = [];
		for (const workspace of rawSidebarWorkspaces) {
			const staleLaunch =
				workspace.snoozeLaunchId != null &&
				workspace.snoozeLaunchId !== APP_LAUNCH_ID;
			const expiredTimer = isSnoozeDue(workspace, nowMs);
			if (staleLaunch || expiredTimer) {
				expiredIds.push(workspace.id);
				// Timer expiry is an auto-return (flashes); a stale-launch return on
				// relaunch is not, to avoid a burst of highlights at startup.
				if (expiredTimer) autoReturnedIdsRef.current.add(workspace.id);
			}
		}
		if (expiredIds.length === 0) return;
		for (const id of expiredIds) autoReturnSnoozedWorkspace(id);
	}, [autoReturnSnoozedWorkspace, nowMs, rawSidebarWorkspaces]);

	const {
		sidebarWorkspaces,
		snoozedSidebarWorkspaces,
		archivedSidebarWorkspaces,
		deletedSidebarWorkspaces,
	} = useMemo(() => {
		type SidebarWorkspaceRow =
			(typeof rawSidebarWorkspacesWithHostStatus)[number];
		const active: SidebarWorkspaceRow[] = [];
		const snoozed: SidebarWorkspaceRow[] = [];
		const archived: SidebarWorkspaceRow[] = [];
		const deleted: SidebarWorkspaceRow[] = [];
		for (const workspace of rawSidebarWorkspacesWithHostStatus) {
			// Single source of truth: getWorkspaceSidebarBucket reads the row's
			// type. A removed non-main thread surfaces under Archived; a master card
			// removed now archives too (archivedAt), while a LEGACY hidden main
			// (isHidden, no timestamp) stays hidden — matching ensureSidebarWorkspaceRecord.
			switch (getWorkspaceSidebarBucket(workspace, nowMs)) {
				case "deleted":
					// (RECYCLE-BIN) soft-deleted: surfaces ONLY in the project's Recycle
					// Bin, never in the active lane / Snoozed / Archived / Completed.
					deleted.push(workspace);
					break;
				case "archived":
					archived.push(workspace);
					break;
				case "snoozed":
					snoozed.push(workspace);
					break;
				case "hidden":
					// Removed main/pinned workspace (isHidden, not archived): excluded
					// from the active lane entirely — not shown anywhere, not resurrected.
					break;
				case "completed":
					// (KANBAN COMPLETED) no sidebar surface at all — the kanban board's
					// Completed column is the thread's only surface. Falling through to
					// default would resurrect it into the ACTIVE lane.
					break;
				default:
					active.push(workspace);
			}
		}
		return {
			sidebarWorkspaces: active,
			snoozedSidebarWorkspaces: snoozed,
			archivedSidebarWorkspaces: archived,
			deletedSidebarWorkspaces: deleted,
		};
	}, [rawSidebarWorkspacesWithHostStatus, nowMs]);

	// Flash a subtle one-shot highlight on threads that just AUTO-returned from
	// snooze (timer expiry flipped them snoozed -> active). Manual "Unsnooze now"
	// is excluded — only ids the expiry ticker marked in autoReturnedIdsRef flash.
	// Removal timers are owned by a ref-keyed map (not the effect's cleanup) so an
	// unrelated re-render can't cancel a fade and strand the highlight.
	const previousSnoozedIdsRef = useRef<Set<string>>(new Set());
	const [justReturnedIds, setJustReturnedIds] = useState<ReadonlySet<string>>(
		() => new Set(),
	);
	const justReturnedTimersRef = useRef<
		Map<string, ReturnType<typeof setTimeout>>
	>(new Map());
	useEffect(() => {
		const currentSnoozed = new Set(
			snoozedSidebarWorkspaces.map((workspace) => workspace.id),
		);
		const activeIds = new Set(
			sidebarWorkspaces.map((workspace) => workspace.id),
		);
		const returned: string[] = [];
		for (const id of previousSnoozedIdsRef.current) {
			if (
				!currentSnoozed.has(id) &&
				activeIds.has(id) &&
				autoReturnedIdsRef.current.has(id)
			) {
				returned.push(id);
				autoReturnedIdsRef.current.delete(id);
			}
		}
		previousSnoozedIdsRef.current = currentSnoozed;
		if (returned.length === 0) return;
		setJustReturnedIds((previous) => {
			const next = new Set(previous);
			for (const id of returned) next.add(id);
			return next;
		});
		const timers = justReturnedTimersRef.current;
		for (const id of returned) {
			const existing = timers.get(id);
			if (existing) clearTimeout(existing);
			timers.set(
				id,
				setTimeout(() => {
					timers.delete(id);
					setJustReturnedIds((previous) => {
						if (!previous.has(id)) return previous;
						const next = new Set(previous);
						next.delete(id);
						return next;
					});
				}, 3_000),
			);
		}
	}, [snoozedSidebarWorkspaces, sidebarWorkspaces]);
	// Clear any pending highlight timers only on unmount.
	useEffect(() => {
		const timers = justReturnedTimersRef.current;
		return () => {
			for (const timeout of timers.values()) clearTimeout(timeout);
			timers.clear();
		};
	}, []);

	// Placement is the only way into the sidebar: local and worktree rows
	// alike appear because a local-state row says so (the reconciler in
	// usePlaceWorktreesInSidebar writes one for anything created outside
	// this renderer), never because of the row's type.
	const visibleSidebarWorkspaces = sidebarWorkspaces;

	// From the placement rows, not the host-joined list: a hidden project
	// whose host is offline has no host metadata yet still has cached
	// workspace rows that must not poll.
	const hiddenProjectIds = useMemo(
		() =>
			new Set(
				orderedSidebarProjectRows
					.filter((row) => row.isHidden)
					.map((row) => row.projectId),
			),
		[orderedSidebarProjectRows],
	);
	const pullRequestQueryTargets = useMemo<PullRequestQueryTarget[]>(
		() =>
			derivePullRequestQueryTargets({
				activeHostUrl,
				hosts,
				machineId,
				relayUrl,
				// Sessions (null projectId) have no remote and never carry PRs.
				// A hidden project renders nothing, so its workspaces stop
				// polling too.
				workspaces: visibleSidebarWorkspaces.filter(
					(workspace) =>
						workspace.projectId !== null &&
						!hiddenProjectIds.has(workspace.projectId),
				),
				fallbackOrganizationId: knownHostsOrgId,
			}),
		[
			activeHostUrl,
			hiddenProjectIds,
			hosts,
			knownHostsOrgId,
			machineId,
			relayUrl,
			visibleSidebarWorkspaces,
		],
	);

	const pullRequestQueries = useQueries({
		queries: pullRequestQueryTargets.map((target) => ({
			queryKey: getDashboardSidebarPullRequestQueryKey(target),
			refetchInterval: 10_000,
			// Unreachable host: keep the query mounted so cached chips stay
			// rendered through the outage; fetches resume when the URL returns.
			enabled: target.hostUrl !== null,
			queryFn: async () => {
				if (!target.hostUrl) return { workspaces: [], github: null };
				const client = getHostServiceClientByUrl(target.hostUrl);
				return client.pullRequests.getByWorkspaces.query({
					workspaceIds: target.workspaceIds,
				});
			},
		})),
	});

	const pullRequestRows = useMemo<PullRequestWorkspaceRow[]>(() => {
		const rows: PullRequestWorkspaceRow[] = [];
		for (const query of pullRequestQueries) {
			const data = query.data;
			if (!data) continue;
			for (const row of data.workspaces) {
				rows.push({
					workspaceId: row.workspaceId,
					pullRequest: row.pullRequest,
				});
			}
		}
		return rows;
	}, [pullRequestQueries]);

	// Keep the latest hover-target inputs in a ref so refreshWorkspacePullRequest
	// keeps a STABLE identity. Its inputs derive from the nowMs partition, so
	// without this it would change on every due snooze tick and churn the
	// onWorkspaceHover prop on every memoised row.
	const pullRequestRefreshInputsRef = useRef({
		visibleSidebarWorkspaces,
		pullRequestQueryTargets,
	});
	pullRequestRefreshInputsRef.current = {
		visibleSidebarWorkspaces,
		pullRequestQueryTargets,
	};

	// A held host's query can stop polling (host offline) and keep its cached
	// hold, so nothing else re-renders when the hold expires.
	const [githubExpiryTick, onGithubHoldExpired] = useReducer(
		(tick: number) => tick + 1,
		0,
	);
	// One notice for the whole sidebar: the hold is per host credential, not
	// per workspace, and the local machine's is the one the user can fix.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the tick re-reads Date.now() when a hold expires
	const githubStatus = useMemo<DashboardSidebarGithubHold | null>(() => {
		const picked = pickGithubStatus(
			pullRequestQueries.map((query, index) => ({
				machineId: pullRequestQueryTargets[index]?.machineId ?? "",
				status: query.data?.github,
			})),
			machineId,
			Date.now(),
		);
		if (!picked) return null;
		return {
			...picked.status,
			machineId: picked.machineId,
			hostName: hostsByMachineId.get(picked.machineId)?.name ?? null,
			isLocalHost: picked.machineId === machineId,
		};
	}, [
		githubExpiryTick,
		hostsByMachineId,
		machineId,
		pullRequestQueries,
		pullRequestQueryTargets,
	]);
	const githubHoldUntil = githubStatus?.until;
	useEffect(() => {
		if (githubHoldUntil === undefined) return;
		const timer = setTimeout(
			onGithubHoldExpired,
			Math.max(0, githubHoldUntil - Date.now()) + 50,
		);
		return () => clearTimeout(timer);
	}, [githubHoldUntil]);

	const refreshWorkspacePullRequest = useCallback(
		async (workspaceId: string) => {
			const {
				visibleSidebarWorkspaces: latestWorkspaces,
				pullRequestQueryTargets: latestTargets,
			} = pullRequestRefreshInputsRef.current;
			const workspace = latestWorkspaces.find(
				(candidate) => candidate.id === workspaceId,
			);
			if (!workspace) return;
			const target = latestTargets.find(
				(candidate) => candidate.machineId === workspace.hostId,
			);
			if (!target?.hostUrl) return;
			if (!pullRequestRefreshGate.shouldRefresh(workspaceId, Date.now())) {
				return;
			}

			const client = getHostServiceClientByUrl(target.hostUrl);
			await client.pullRequests.refreshByWorkspaces.mutate({
				workspaceIds: [workspaceId],
			});
			await queryClient.invalidateQueries({
				queryKey: getDashboardSidebarPullRequestQueryKey(target),
			});
		},
		[queryClient],
	);

	const pullRequestsByWorkspaceId =
		useStablePullRequestsByWorkspaceId(pullRequestRows);

	// Pinned rows render only in the top-level Pinned section, so they are
	// partitioned out before the per-project tree is built. PR polling targets
	// derive from the pre-partition list above, so pinned rows keep PR status.
	const { pinned: pinnedRows, unpinned: unpinnedRows } = useMemo(
		() => partitionSidebarWorkspacesByPinned(visibleSidebarWorkspaces),
		[visibleSidebarWorkspaces],
	);

	// Unpinned sessions render in the top-level Sessions section; pinned
	// sessions stay in Pinned like any other row.
	const { sessions: sessionRows, projectScoped: projectRows } = useMemo(
		() => partitionSidebarWorkspacesBySession(unpinnedRows),
		[unpinnedRows],
	);

	// (SESSION-LIFECYCLE) A snoozed / archived session has no project row to hang
	// off, so it is split out here and rendered in the top-level Snoozed Sessions
	// / Archived Sessions subsections. The project-scoped remainder feeds the
	// per-project subsections below.
	const { sessions: sessionSnoozedRows, projectScoped: projectSnoozedRows } =
		useMemo(
			() => partitionSidebarWorkspacesBySession(snoozedSidebarWorkspaces),
			[snoozedSidebarWorkspaces],
		);

	const { sessions: sessionArchivedRows, projectScoped: projectArchivedRows } =
		useMemo(
			() => partitionSidebarWorkspacesBySession(archivedSidebarWorkspaces),
			[archivedSidebarWorkspaces],
		);

	// (RECYCLE-BIN-SESSIONS) Same split for the soft-deleted bucket: a deleted
	// session has no project bin to land in, so it feeds the top-level Recycle
	// Bin subsection under Sessions while project-scoped rows keep feeding the
	// per-project bins below. Before this split a deleted session fell into a
	// void — the project loop skipped it and no other surface rendered it.
	const { sessions: sessionDeletedRows, projectScoped: projectDeletedRows } =
		useMemo(
			() => partitionSidebarWorkspacesBySession(deletedSidebarWorkspaces),
			[deletedSidebarWorkspaces],
		);

	// Inline builder (see the import note): project-scoped rows only — sessions
	// go through upstream's session builder below.
	const computedGroups = useMemo<DashboardSidebarProject[]>(() => {
		const projectsById = new Map<
			string,
			DashboardSidebarProject & {
				sectionMap: Map<string, DashboardSidebarSection>;
				childEntries: Array<{
					tabOrder: number;
					child: DashboardSidebarProjectChild;
				}>;
				orphanedWorkspaces: Array<{
					tabOrder: number;
					workspace: DashboardSidebarWorkspace;
				}>;
			}
		>();

		for (const project of builderProjects) {
			projectsById.set(project.id, {
				...project,
				children: [],
				snoozedWorkspaces: [],
				archivedWorkspaces: [],
				// (RECYCLE-BIN) full, unfiltered bin contents; the section component
				// applies the retention window and derives its header count from this
				// array's length.
				deletedWorkspaces: [],
				sectionMap: new Map(),
				childEntries: [],
				orphanedWorkspaces: [],
			});
		}

		for (const section of sidebarSections) {
			const project = projectsById.get(section.projectId);
			if (!project) continue;

			const sidebarSection: DashboardSidebarSection = {
				...section,
				workspaces: [],
			};

			project.sectionMap.set(section.id, sidebarSection);
			project.childEntries.push({
				tabOrder: section.tabOrder,
				child: {
					type: "section",
					section: sidebarSection,
				},
			});
		}

		for (const workspace of projectRows) {
			const project = projectsById.get(workspace.projectId);
			if (!project) continue;

			const hostType: DashboardSidebarWorkspace["hostType"] =
				workspace.hostId === machineId ? "local-device" : "remote-device";

			const sidebarWorkspace: DashboardSidebarWorkspace = {
				id: workspace.id,
				projectId: workspace.projectId,
				hostId: workspace.hostId,
				hostType,
				type: workspace.type,
				hostIsOnline:
					hostType === "remote-device" ? workspace.hostIsOnline : null,
				accentColor: null,
				name: workspace.name,
				branch: workspace.branch,
				pullRequest: pullRequestsByWorkspaceId.get(workspace.id) ?? null,
				repoUrl:
					project.githubOwner && project.githubRepoName
						? `https://github.com/${project.githubOwner}/${project.githubRepoName}`
						: null,
				branchExistsOnRemote:
					project.githubOwner !== null && project.githubRepoName !== null,
				previewUrl: null,
				needsRebase: null,
				behindCount: null,
				createdAt: workspace.createdAt,
				updatedAt: workspace.updatedAt,
				taskId: workspace.taskId,
				// Always false here — pinned rows were partitioned out above and
				// render only in the Pinned section.
				isPinned: workspace.pinnedAt != null,
				pendingTransaction: workspace.pendingTransaction,
				justReturned: justReturnedIds.has(workspace.id),
				// A device row has no cloud ownership or sandbox; a placed cloud row
				// gets both back from `applyCloudSidebarRows` below.
				isMine: null,
				sandboxStatus: null,
			};

			if (workspace.sectionId) {
				const section = project.sectionMap.get(workspace.sectionId);
				if (section) {
					section.workspaces.push({
						...sidebarWorkspace,
						accentColor: section.color,
					});
					continue;
				}
				// Section was deleted out from under this workspace — surface it at
				// top level instead of silently dropping it.
				project.orphanedWorkspaces.push({
					tabOrder: workspace.tabOrder,
					workspace: sidebarWorkspace,
				});
				continue;
			}

			project.childEntries.push({
				tabOrder: workspace.tabOrder,
				child: {
					type: "workspace",
					workspace: sidebarWorkspace,
				},
			});
		}

		const buildInactiveWorkspace = (
			workspace: (typeof snoozedSidebarWorkspaces)[number],
			project: DashboardSidebarProject,
		): DashboardSidebarWorkspace => {
			const hostType: DashboardSidebarWorkspace["hostType"] =
				workspace.hostId === machineId ? "local-device" : "remote-device";
			return {
				id: workspace.id,
				projectId: workspace.projectId,
				hostId: workspace.hostId,
				hostType,
				type: workspace.type,
				hostIsOnline:
					hostType === "remote-device" ? workspace.hostIsOnline : null,
				accentColor: null,
				name: workspace.name,
				branch: workspace.branch,
				pullRequest: null,
				repoUrl:
					project.githubOwner && project.githubRepoName
						? `https://github.com/${project.githubOwner}/${project.githubRepoName}`
						: null,
				branchExistsOnRemote:
					project.githubOwner !== null && project.githubRepoName !== null,
				previewUrl: null,
				needsRebase: null,
				behindCount: null,
				createdAt: workspace.createdAt,
				updatedAt: workspace.updatedAt,
				taskId: workspace.taskId,
				// A snoozed / archived / soft-deleted row never renders in the Pinned
				// section, so its pin state is irrelevant to the row it produces.
				isPinned: false,
				pendingTransaction: workspace.pendingTransaction,
				isMine: null,
				sandboxStatus: null,
				snoozeUntil: workspace.snoozeUntil ?? null,
				snoozeLaunchId: workspace.snoozeLaunchId ?? null,
				archivedAt: workspace.archivedAt ?? null,
				// (RECYCLE-BIN) carried so the Recycle Bin section can sort by it and
				// apply the retention "Show all" filter.
				deletedAt: workspace.deletedAt ?? null,
			};
		};

		for (const workspace of projectSnoozedRows) {
			const project = projectsById.get(workspace.projectId);
			if (!project) continue;
			project.snoozedWorkspaces.push(
				buildInactiveWorkspace(workspace, project),
			);
		}

		for (const workspace of projectArchivedRows) {
			const project = projectsById.get(workspace.projectId);
			if (!project) continue;
			project.archivedWorkspaces.push(
				buildInactiveWorkspace(workspace, project),
			);
		}

		for (const workspace of projectDeletedRows) {
			const project = projectsById.get(workspace.projectId);
			if (!project) continue;
			project.deletedWorkspaces.push(
				buildInactiveWorkspace(workspace, project),
			);
		}

		return builderProjects.flatMap((project) => {
			const resolvedProject = projectsById.get(project.id);
			if (!resolvedProject) return [];
			const {
				childEntries,
				sectionMap: _sectionMap,
				orphanedWorkspaces,
				...sidebarProject
			} = resolvedProject;

			const isLocalMain = (entry: (typeof childEntries)[number]) =>
				entry.child.type === "workspace" &&
				entry.child.workspace.type === "main" &&
				entry.child.workspace.hostType === "local-device";

			const sortedChildren = childEntries
				.sort((left, right) => {
					const leftLocalMain = isLocalMain(left);
					const rightLocalMain = isLocalMain(right);
					if (leftLocalMain !== rightLocalMain) {
						return leftLocalMain ? -1 : 1;
					}
					return left.tabOrder - right.tabOrder;
				})
				.map(({ child }) => child);

			// Ungrouped workspaces rendered after a section header are visually
			// grouped with that section (shared accent, collapse-together) and will
			// be committed into it on next DnD. Reparent them here so section counts
			// match what the user sees.
			const children: DashboardSidebarProjectChild[] = [];
			let currentSection: DashboardSidebarSection | null = null;
			for (const child of sortedChildren) {
				if (child.type === "section") {
					currentSection = child.section;
					children.push(child);
				} else if (currentSection) {
					currentSection.workspaces.push({
						...child.workspace,
						accentColor: currentSection.color,
					});
				} else {
					children.push(child);
				}
			}

			// Workspaces whose section was deleted (orphaned) render above the
			// first section so they stay visible instead of vanishing.
			if (orphanedWorkspaces.length > 0) {
				const isLocalMainWorkspace = (workspace: DashboardSidebarWorkspace) =>
					workspace.type === "main" && workspace.hostType === "local-device";
				const firstSectionIndex = children.findIndex(
					(child) => child.type === "section",
				);
				const insertIndex =
					firstSectionIndex === -1 ? children.length : firstSectionIndex;
				children.splice(
					insertIndex,
					0,
					...orphanedWorkspaces
						.sort((left, right) => {
							const leftLocalMain = isLocalMainWorkspace(left.workspace);
							const rightLocalMain = isLocalMainWorkspace(right.workspace);
							if (leftLocalMain !== rightLocalMain) {
								return leftLocalMain ? -1 : 1;
							}
							return left.tabOrder - right.tabOrder;
						})
						.map(({ workspace }) => ({
							type: "workspace" as const,
							workspace,
						})),
				);
			}

			sidebarProject.children = children;
			sidebarProject.snoozedWorkspaces.sort(
				(left, right) =>
					(left.snoozeUntil ?? Number.MAX_SAFE_INTEGER) -
					(right.snoozeUntil ?? Number.MAX_SAFE_INTEGER),
			);
			sidebarProject.archivedWorkspaces.sort(
				(left, right) => (right.archivedAt ?? 0) - (left.archivedAt ?? 0),
			);
			// (RECYCLE-BIN) most-recently-deleted first.
			sidebarProject.deletedWorkspaces.sort(
				(left, right) => (right.deletedAt ?? 0) - (left.deletedAt ?? 0),
			);
			return [sidebarProject];
		});
	}, [
		machineId,
		justReturnedIds,
		pullRequestsByWorkspaceId,
		builderProjects,
		sidebarSections,
		projectRows,
		projectSnoozedRows,
		projectArchivedRows,
		projectDeletedRows,
	]);

	// A stand-in repo project keeps its collapse, order and hidden state in
	// the same placement rows as a real project; the row is written on first
	// sight so the chevron works from the start.
	useEffect(() => {
		if (!cloudLayout || !sidebarProjectRowsReady) return;
		for (const repoProject of cloudLayout.repoProjects) {
			if (!sidebarProjectRowsById.has(repoProject.id)) {
				ensureProjectInSidebar(repoProject.id);
			}
		}
	}, [
		cloudLayout,
		sidebarProjectRowsReady,
		sidebarProjectRowsById,
		ensureProjectInSidebar,
	]);

	const decoratedGroups = useMemo(
		() =>
			cloudLayout
				? applyCloudSidebarRows(computedGroups, cloudRowById, standInProjectIds)
				: computedGroups,
		[cloudLayout, computedGroups, cloudRowById, standInProjectIds],
	);
	const groups = useStableDashboardSidebarProjects(decoratedGroups);

	const hiddenRepoProjects = useMemo<DashboardSidebarHiddenProject[]>(
		() =>
			(cloudLayout?.repoProjects ?? []).flatMap((repoProject) =>
				sidebarProjectRowsById.get(repoProject.id)?.isHidden
					? [
							{
								id: repoProject.id,
								name: repoProject.name,
								iconUrl: repoProject.iconUrl,
								color: null,
							},
						]
					: [],
			),
		[cloudLayout, sidebarProjectRowsById],
	);
	const allHiddenProjects = useMemo(
		() =>
			hiddenRepoProjects.length === 0
				? hiddenProjects
				: [...hiddenProjects, ...hiddenRepoProjects],
		[hiddenProjects, hiddenRepoProjects],
	);

	const computedSessions = useMemo(
		() =>
			buildDashboardSidebarSessions({
				sessionSidebarWorkspaces: sessionRows,
				sidebarSections,
				machineId,
				pullRequestsByWorkspaceId,
			}),
		[machineId, pullRequestsByWorkspaceId, sessionRows, sidebarSections],
	);
	const sessions = useJsonStable(computedSessions);
	const sessionWorkspaces = sessions.workspaces;

	// (SESSION-LIFECYCLE) Rows for the top-level Snoozed Sessions / Archived
	// Sessions subsections.
	const computedSnoozedSessionWorkspaces = useMemo<DashboardSidebarWorkspace[]>(
		() =>
			buildDashboardSidebarInactiveSessionWorkspaces({
				sessionSidebarWorkspaces: sessionSnoozedRows,
				variant: "snoozed",
				machineId,
			}),
		[machineId, sessionSnoozedRows],
	);
	const snoozedSessionWorkspaces = useJsonStable(
		computedSnoozedSessionWorkspaces,
	);

	const computedArchivedSessionWorkspaces = useMemo<
		DashboardSidebarWorkspace[]
	>(
		() =>
			buildDashboardSidebarInactiveSessionWorkspaces({
				sessionSidebarWorkspaces: sessionArchivedRows,
				variant: "archived",
				machineId,
			}),
		[machineId, sessionArchivedRows],
	);
	const archivedSessionWorkspaces = useJsonStable(
		computedArchivedSessionWorkspaces,
	);

	// (RECYCLE-BIN-SESSIONS) Rows for the top-level session Recycle Bin,
	// most-recently-deleted first. The section itself applies the retention
	// display window.
	const computedDeletedSessionWorkspaces = useMemo<DashboardSidebarWorkspace[]>(
		() =>
			buildDashboardSidebarInactiveSessionWorkspaces({
				sessionSidebarWorkspaces: sessionDeletedRows,
				variant: "deleted",
				machineId,
			}),
		[machineId, sessionDeletedRows],
	);
	const deletedSessionWorkspaces = useJsonStable(
		computedDeletedSessionWorkspaces,
	);

	const computedPinnedWorkspaces = useMemo<DashboardSidebarPinnedWorkspace[]>(
		() =>
			buildDashboardSidebarPinnedWorkspaces({
				pinnedSidebarWorkspaces: pinnedRows,
				sidebarProjects: builderProjects,
				machineId,
				pullRequestsByWorkspaceId,
			}),
		[machineId, pinnedRows, pullRequestsByWorkspaceId, builderProjects],
	);
	const decoratedPinnedWorkspaces = useMemo(
		() =>
			cloudLayout
				? applyCloudSidebarPinnedRows(computedPinnedWorkspaces, cloudRowById)
				: computedPinnedWorkspaces,
		[cloudLayout, computedPinnedWorkspaces, cloudRowById],
	);
	const pinnedWorkspaces = useJsonStable(decoratedPinnedWorkspaces);

	return {
		groups,
		hiddenProjects: allHiddenProjects,
		pinnedWorkspaces,
		sessionWorkspaces,
		sessionChildren: sessions.children,
		snoozedSessionWorkspaces,
		archivedSessionWorkspaces,
		deletedSessionWorkspaces,
		githubStatus,
		refreshWorkspacePullRequest,
		toggleProjectCollapsed,
	};
}
