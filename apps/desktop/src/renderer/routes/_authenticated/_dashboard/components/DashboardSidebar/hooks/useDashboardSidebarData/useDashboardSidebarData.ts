import { eq } from "@tanstack/db";
import { useLiveQuery } from "@tanstack/react-db";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRelayUrl } from "renderer/hooks/useRelayUrl";
import { getHostServiceClientByUrl } from "renderer/lib/host-service-client";
import { useDashboardSidebarState } from "renderer/routes/_authenticated/hooks/useDashboardSidebarState";
import { useCollections } from "renderer/routes/_authenticated/providers/CollectionsProvider";
import {
	APP_LAUNCH_ID,
	formatSnoozeRemaining,
	getWorkspaceSidebarBucket,
	isAutoIncludedLocalMainWorkspace,
} from "renderer/routes/_authenticated/providers/CollectionsProvider/dashboardSidebarLocal";
import { useLocalHostService } from "renderer/routes/_authenticated/providers/LocalHostServiceProvider";
import { useWorkspaceTransactionsStore } from "renderer/stores/workspace-creates";
import type {
	DashboardSidebarProject,
	DashboardSidebarProjectChild,
	DashboardSidebarSection,
	DashboardSidebarWorkspace,
} from "../../types";
import {
	derivePullRequestQueryTargets,
	getDashboardSidebarPullRequestQueryKey,
	type PullRequestQueryTarget,
} from "./derivePullRequestQueryTargets";

const MAIN_WORKSPACE_TAB_ORDER = Number.MIN_SAFE_INTEGER;

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

export function useDashboardSidebarData() {
	const collections = useCollections();
	const { machineId, activeHostUrl } = useLocalHostService();
	const relayUrl = useRelayUrl();
	const { toggleProjectCollapsed, unsnoozeWorkspace } =
		useDashboardSidebarState();
	const queryClient = useQueryClient();
	const workspaceTransactionsById = useWorkspaceTransactionsStore(
		(state) => state.byWorkspaceId,
	);
	const clearWorkspaceTransaction = useWorkspaceTransactionsStore(
		(state) => state.clear,
	);

	const { data: hosts = [] } = useLiveQuery(
		(q) =>
			q.from({ hosts: collections.v2Hosts }).select(({ hosts }) => ({
				organizationId: hosts.organizationId,
				machineId: hosts.machineId,
				isOnline: hosts.isOnline,
			})),
		[collections],
	);
	const hostsByMachineId = useMemo(
		() => new Map(hosts.map((host) => [host.machineId, host])),
		[hosts],
	);

	const { data: rawSidebarProjects = [] } = useLiveQuery(
		(q) =>
			q
				.from({ sidebarProjects: collections.v2SidebarProjects })
				.innerJoin(
					{ projects: collections.v2Projects },
					({ sidebarProjects, projects }) =>
						eq(sidebarProjects.projectId, projects.id),
				)
				.leftJoin(
					{ repos: collections.githubRepositories },
					({ projects, repos }) => eq(projects.githubRepositoryId, repos.id),
				)
				.orderBy(({ sidebarProjects }) => sidebarProjects.tabOrder, "asc")
				.select(({ sidebarProjects, projects, repos }) => ({
					id: projects.id,
					name: projects.name,
					slug: projects.slug,
					githubRepositoryId: projects.githubRepositoryId,
					githubOwner: repos?.owner ?? null,
					githubRepoName: repos?.name ?? null,
					iconUrl: projects.iconUrl,
					createdAt: projects.createdAt,
					updatedAt: projects.updatedAt,
					isCollapsed: sidebarProjects.isCollapsed,
					isPinned: sidebarProjects.isPinned,
					showSnoozed: sidebarProjects.showSnoozed,
					showArchived: sidebarProjects.showArchived,
					snoozedCollapsed: sidebarProjects.snoozedCollapsed,
					archivedCollapsed: sidebarProjects.archivedCollapsed,
				})),
		[collections],
	);

	const sidebarProjects = useMemo(
		() =>
			rawSidebarProjects.map((project) => ({
				...project,
				githubOwner: project.githubOwner ?? null,
				githubRepoName: project.githubRepoName ?? null,
				// Heal legacy project rows persisted before the reveal flags existed
				// (they read back undefined despite the boolean type).
				isPinned: project.isPinned ?? false,
				showSnoozed: project.showSnoozed ?? false,
				showArchived: project.showArchived ?? false,
				snoozedCollapsed: project.snoozedCollapsed ?? false,
				archivedCollapsed: project.archivedCollapsed ?? false,
			})),
		[rawSidebarProjects],
	);

	const { data: sidebarSections = [] } = useLiveQuery(
		(q) =>
			q
				.from({ sidebarSections: collections.v2SidebarSections })
				.orderBy(({ sidebarSections }) => sidebarSections.tabOrder, "asc")
				.select(({ sidebarSections }) => ({
					id: sidebarSections.sectionId,
					projectId: sidebarSections.projectId,
					name: sidebarSections.name,
					createdAt: sidebarSections.createdAt,
					isCollapsed: sidebarSections.isCollapsed,
					tabOrder: sidebarSections.tabOrder,
					color: sidebarSections.color,
				})),
		[collections],
	);

	const { data: rawSidebarWorkspaces = [] } = useLiveQuery(
		(q) =>
			q
				.from({ sidebarWorkspaces: collections.v2WorkspaceLocalState })
				.innerJoin(
					{ workspaces: collections.v2Workspaces },
					({ sidebarWorkspaces, workspaces }) =>
						eq(sidebarWorkspaces.workspaceId, workspaces.id),
				)
				.orderBy(
					({ sidebarWorkspaces }) => sidebarWorkspaces.sidebarState.tabOrder,
					"asc",
				)
				.select(({ sidebarWorkspaces, workspaces }) => ({
					id: workspaces.id,
					projectId: sidebarWorkspaces.sidebarState.projectId,
					hostId: workspaces.hostId,
					type: workspaces.type,
					name: workspaces.name,
					branch: workspaces.branch,
					taskId: workspaces.taskId,
					createdAt: workspaces.createdAt,
					updatedAt: workspaces.updatedAt,
					isSynced: workspaces.$synced,
					tabOrder: sidebarWorkspaces.sidebarState.tabOrder,
					sectionId: sidebarWorkspaces.sidebarState.sectionId,
					isHidden: sidebarWorkspaces.sidebarState.isHidden,
					snoozeUntil: sidebarWorkspaces.sidebarState.snoozeUntil,
					snoozeLaunchId: sidebarWorkspaces.sidebarState.snoozeLaunchId,
					archivedAt: sidebarWorkspaces.sidebarState.archivedAt,
					// (KANBAN COMPLETED) must be projected or the bucket classifier
					// below can't see it — completed rows are also isHidden and would
					// misclassify as "archived" (surfacing under the Archived section).
					completedAt: sidebarWorkspaces.sidebarState.completedAt,
				})),
		[collections],
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

	// Re-evaluate snooze expiry on a coarse timer so a snoozed thread pops back
	// into the active lane shortly after its deadline. The ticker only runs while
	// at least one row carries a snooze, so an idle sidebar isn't churning.
	const [nowMs, setNowMs] = useState(() => Date.now());
	// Gate the ticker on a TIMED snooze only. An "until next launch" snooze has no
	// wall-clock deadline (it clears on relaunch via APP_LAUNCH_ID), so counting it
	// here would keep the interval running forever doing nothing.
	const hasPendingSnooze = useMemo(
		() =>
			rawSidebarWorkspaces.some((workspace) => workspace.snoozeUntil != null),
		[rawSidebarWorkspaces],
	);
	useEffect(() => {
		if (!hasPendingSnooze) return;
		const interval = setInterval(() => setNowMs(Date.now()), 60_000);
		return () => clearInterval(interval);
	}, [hasPendingSnooze]);

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
			const expiredTimer =
				typeof workspace.snoozeUntil === "number" &&
				workspace.snoozeUntil <= nowMs;
			if (staleLaunch || expiredTimer) {
				expiredIds.push(workspace.id);
				// Timer expiry is an auto-return (flashes); a stale-launch return on
				// relaunch is not, to avoid a burst of highlights at startup.
				if (expiredTimer) autoReturnedIdsRef.current.add(workspace.id);
			}
		}
		if (expiredIds.length === 0) return;
		for (const id of expiredIds) unsnoozeWorkspace(id);
	}, [nowMs, rawSidebarWorkspaces, unsnoozeWorkspace]);

	const {
		sidebarWorkspaces,
		snoozedSidebarWorkspaces,
		archivedSidebarWorkspaces,
	} = useMemo(() => {
		type SidebarWorkspaceRow =
			(typeof rawSidebarWorkspacesWithHostStatus)[number];
		const active: SidebarWorkspaceRow[] = [];
		const snoozed: SidebarWorkspaceRow[] = [];
		const archived: SidebarWorkspaceRow[] = [];
		for (const workspace of rawSidebarWorkspacesWithHostStatus) {
			// Single source of truth: getWorkspaceSidebarBucket reads the row's
			// type. A removed non-main thread surfaces under Archived; a master card
			// removed now archives too (archivedAt), while a LEGACY hidden main
			// (isHidden, no timestamp) stays hidden — matching ensureSidebarWorkspaceRecord.
			switch (getWorkspaceSidebarBucket(workspace, nowMs)) {
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

	const localStateWorkspaceIds = useMemo(
		() => new Set(rawSidebarWorkspaces.map((workspace) => workspace.id)),
		[rawSidebarWorkspaces],
	);

	const { data: rawLocalMainWorkspaces = [] } = useLiveQuery(
		(q) =>
			q
				.from({ workspaces: collections.v2Workspaces })
				.where(({ workspaces }) => eq(workspaces.type, "main"))
				.select(({ workspaces }) => ({
					id: workspaces.id,
					projectId: workspaces.projectId,
					hostId: workspaces.hostId,
					type: workspaces.type,
					name: workspaces.name,
					branch: workspaces.branch,
					taskId: workspaces.taskId,
					createdAt: workspaces.createdAt,
					updatedAt: workspaces.updatedAt,
					isSynced: workspaces.$synced,
					tabOrder: MAIN_WORKSPACE_TAB_ORDER,
					sectionId: null as string | null,
				})),
		[collections],
	);
	const localMainWorkspaces = useMemo(
		() =>
			rawLocalMainWorkspaces.map((workspace) => ({
				...workspace,
				hostIsOnline: hostsByMachineId.get(workspace.hostId)?.isOnline ?? false,
				pendingTransaction: workspaceTransactionsById[workspace.id] ?? null,
			})),
		[hostsByMachineId, rawLocalMainWorkspaces, workspaceTransactionsById],
	);

	useEffect(() => {
		for (const workspace of [
			...rawSidebarWorkspaces,
			...rawLocalMainWorkspaces,
		]) {
			const transaction = workspaceTransactionsById[workspace.id];
			if (workspace.isSynced && transaction?.type === "insert") {
				clearWorkspaceTransaction(workspace.id);
			}
		}
	}, [
		clearWorkspaceTransaction,
		rawLocalMainWorkspaces,
		rawSidebarWorkspaces,
		workspaceTransactionsById,
	]);

	const visibleSidebarWorkspaces = useMemo(() => {
		const sidebarProjectIds = new Set(
			sidebarProjects.map((project) => project.id),
		);
		const autoLocalMainWorkspaces = localMainWorkspaces.filter((workspace) =>
			isAutoIncludedLocalMainWorkspace(workspace, {
				localStateWorkspaceIds,
				sidebarProjectIds,
				machineId,
			}),
		);

		return [...autoLocalMainWorkspaces, ...sidebarWorkspaces];
	}, [
		localMainWorkspaces,
		localStateWorkspaceIds,
		machineId,
		sidebarProjects,
		sidebarWorkspaces,
	]);

	const pullRequestQueryTargets = useMemo<PullRequestQueryTarget[]>(
		() =>
			derivePullRequestQueryTargets({
				activeHostUrl,
				hosts,
				machineId,
				relayUrl,
				workspaces: visibleSidebarWorkspaces,
			}),
		[activeHostUrl, hosts, machineId, relayUrl, visibleSidebarWorkspaces],
	);

	const pullRequestQueries = useQueries({
		queries: pullRequestQueryTargets.map((target) => ({
			queryKey: getDashboardSidebarPullRequestQueryKey(target),
			refetchInterval: 10_000,
			queryFn: async () => {
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
	// without this it would change every 60s tick and churn the onWorkspaceHover
	// prop on every memoised row.
	const pullRequestRefreshInputsRef = useRef({
		visibleSidebarWorkspaces,
		pullRequestQueryTargets,
	});
	pullRequestRefreshInputsRef.current = {
		visibleSidebarWorkspaces,
		pullRequestQueryTargets,
	};

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
			if (!target) return;

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

		for (const project of sidebarProjects) {
			projectsById.set(project.id, {
				...project,
				children: [],
				snoozedWorkspaces: [],
				archivedWorkspaces: [],
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

		for (const workspace of visibleSidebarWorkspaces) {
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
				pendingTransaction: workspace.pendingTransaction,
				justReturned: justReturnedIds.has(workspace.id),
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
				pendingTransaction: workspace.pendingTransaction,
				snoozeUntil: workspace.snoozeUntil ?? null,
				snoozeLaunchId: workspace.snoozeLaunchId ?? null,
				archivedAt: workspace.archivedAt ?? null,
				snoozeRemainingLabel: formatSnoozeRemaining(
					workspace.snoozeUntil,
					workspace.snoozeLaunchId,
					nowMs,
				),
			};
		};

		for (const workspace of snoozedSidebarWorkspaces) {
			const project = projectsById.get(workspace.projectId);
			if (!project) continue;
			project.snoozedWorkspaces.push(
				buildInactiveWorkspace(workspace, project),
			);
		}

		for (const workspace of archivedSidebarWorkspaces) {
			const project = projectsById.get(workspace.projectId);
			if (!project) continue;
			project.archivedWorkspaces.push(
				buildInactiveWorkspace(workspace, project),
			);
		}

		return sidebarProjects.flatMap((project) => {
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
			return [sidebarProject];
		});
	}, [
		machineId,
		nowMs,
		justReturnedIds,
		pullRequestsByWorkspaceId,
		sidebarProjects,
		sidebarSections,
		visibleSidebarWorkspaces,
		snoozedSidebarWorkspaces,
		archivedSidebarWorkspaces,
	]);
	const groups = useStableDashboardSidebarProjects(computedGroups);

	return {
		groups,
		refreshWorkspacePullRequest,
		toggleProjectCollapsed,
	};
}
