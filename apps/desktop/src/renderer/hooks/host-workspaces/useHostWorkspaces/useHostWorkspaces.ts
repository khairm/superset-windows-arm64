import { getEventBus } from "@superset/workspace-client";
import { useLiveQuery } from "@tanstack/react-db";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useKnownHosts } from "renderer/hooks/known-hosts/useKnownHosts";
import { useRelayUrl } from "renderer/hooks/useRelayUrl";
import { getHostServiceWsToken } from "renderer/lib/host-service-auth";
import { getHostServiceClientByUrl } from "renderer/lib/host-service-client";
import { useCollections } from "renderer/routes/_authenticated/providers/CollectionsProvider";
import { useLocalHostService } from "renderer/routes/_authenticated/providers/LocalHostServiceProvider";
import {
	applyWorkspaceChangedEvent,
	deriveHostWorkspacesQueryTargets,
	getHostWorkspacesQueryKey,
	type HostWorkspaceItem,
	type HostWorkspaceRow,
	loadHostWorkspacesSnapshot,
	mergeHostWorkspaces,
	saveHostWorkspacesSnapshot,
} from "./useHostWorkspaces.utils";

export type { HostWorkspaceItem } from "./useHostWorkspaces.utils";

const WORKSPACES_FALLBACK_REFETCH_INTERVAL_MS = 30_000;

export interface HostWorkspacesCacheOps {
	/** Resolve the URL to reach the host owning `hostId` (null = unreachable). */
	resolveHostUrl: (hostId: string) => string | null;
	/**
	 * Optimistically upsert a row into a host's cached list. The host's
	 * `workspace:changed` broadcast (or the next refetch) converges the
	 * cache onto the real row.
	 */
	upsertWorkspace: (row: HostWorkspaceRow) => void;
	/** Optimistically drop a row from a host's cached list. */
	removeWorkspace: (hostId: string, workspaceId: string) => void;
	/** Rollback hammer: refetch a host's list after a failed write. */
	invalidateHost: (hostId: string) => void;
}

export interface UseHostWorkspacesResult {
	workspaces: HostWorkspaceItem[];
	/**
	 * True once every host answered, failed, or served a snapshot. Gates
	 * empty states only — existing rows always render (cache-first rule).
	 */
	isReady: boolean;
	/**
	 * (KANBAN-HOST-SOURCE) True only while EVERY known host's live
	 * `workspace.list` has data this session (kept through refetch errors).
	 * The only state in which a row's absence from `workspaces` proves
	 * deletion when the row's owning host is unknown. Snapshots deliberately
	 * do NOT count: they are best-effort and possibly stale/empty — they can
	 * prove presence, never absence. Destructive reactions to a missing row
	 * must gate on this (or on `isAbsenceAuthoritative` with a known owner),
	 * never on `isReady`.
	 */
	isAuthoritative: boolean;
	/**
	 * (KANBAN-HOST-SOURCE) Per-owner absence authority: for a row known to
	 * belong to `hostId`, absence is proven once THAT host's live list has
	 * data (unrelated offline hosts don't block), or when the host row was
	 * removed from the org entirely. Null/undefined owner falls back to the
	 * global `isAuthoritative`.
	 */
	isAbsenceAuthoritative: (hostId: string | null | undefined) => boolean;
	cache: HostWorkspacesCacheOps;
}

/**
 * The workspace read path: `workspace.list` per host (local direct, remote
 * via relay), merged, live-updated from each host's `workspace:changed`
 * events, with last-seen lists persisted per host to IndexedDB so remote
 * machines still render offline.
 *
 * Unscoped (`scopedHostId` omitted): fans out to every known host — runs
 * once inside HostWorkspacesProvider; consumers read the shared result via
 * that provider's useHostWorkspaces. Cloud rows from the still-synced
 * Electric collection fill in only for hosts that served nothing (pre-R1
 * builds, no snapshot) — that fallback disappears in R3.
 *
 * Scoped (`scopedHostId` a machine id): a single host, no fan-out and no
 * cloud fallback — an unreachable host shows its snapshot or nothing, never
 * stale cloud rows. Query keys are shared with the provider, so a scoped
 * call where the provider is mounted fetches the host once, not twice.
 * Passing null resolves no target and runs nothing (stays !isReady).
 *
 * `includeArchived` additionally fetches archived tombstones (soft-deleted
 * workspaces) under a separate query key — the shared live cache and its
 * snapshots never see archived rows. Tombstones append after live rows with
 * `archivedAt`/`archiveReason` set.
 */
export function useHostWorkspacesSource(
	scopedHostId?: string | null,
	options?: { includeArchived?: boolean },
): UseHostWorkspacesResult {
	const includeArchived = options?.includeArchived ?? false;
	const collections = useCollections();
	const queryClient = useQueryClient();
	const { activeHostUrl, machineId } = useLocalHostService();
	const relayUrl = useRelayUrl();

	const {
		hosts,
		organizationId: knownHostsOrgId,
		settled: knownHostsSettled,
	} = useKnownHosts();
	// (KANBAN-HOST-SOURCE) Absence authority below needs to know the hosts
	// collection is HYDRATED — `useKnownHosts` deliberately hides readiness
	// because it can serve a persisted snapshot, so read the collection's own
	// `isReady` here. An unhydrated `[]` must never claim "no other hosts".
	const { isReady: hostsReady } = useLiveQuery(
		(q) =>
			q.from({ hosts: collections.v2Hosts }).select(({ hosts }) => ({
				machineId: hosts.machineId,
			})),
		[collections],
	);

	const { data: cloudRows = [] } = useLiveQuery(
		(q) => q.from({ workspaces: collections.v2Workspaces }),
		[collections],
	);

	const targets = useMemo(() => {
		const all = deriveHostWorkspacesQueryTargets({
			activeHostUrl,
			hosts,
			machineId,
			relayUrl,
			fallbackOrganizationId: knownHostsOrgId,
		});
		return scopedHostId === undefined
			? all
			: all.filter((target) => target.machineId === scopedHostId);
	}, [
		activeHostUrl,
		hosts,
		knownHostsOrgId,
		machineId,
		relayUrl,
		scopedHostId,
	]);

	// Last-seen snapshots hydrate once per (org, host); live data always wins.
	const [snapshots, setSnapshots] = useState<Map<string, HostWorkspaceRow[]>>(
		() => new Map(),
	);
	useEffect(() => {
		let cancelled = false;
		for (const target of targets) {
			if (snapshots.has(target.machineId)) continue;
			void loadHostWorkspacesSnapshot(
				target.organizationId,
				target.machineId,
			).then((rows) => {
				if (cancelled || !rows) return;
				setSnapshots((prev) => {
					if (prev.has(target.machineId)) return prev;
					const next = new Map(prev);
					next.set(target.machineId, rows);
					return next;
				});
			});
		}
		return () => {
			cancelled = true;
		};
	}, [targets, snapshots]);

	// (KANBAN-HOST-SOURCE) Provenance for absence authority: a host earns its
	// entry the moment its REAL `workspace.list` request resolves — recorded
	// inside the queryFn, never derived from the query cache, which optimistic
	// setQueryData writes (creates/renames) also populate and which therefore
	// cannot prove the host ever answered. Session-scoped and monotonic, same
	// lifetime as the kept-through-refetch-errors query data.
	const [liveAnsweredHostIds, setLiveAnsweredHostIds] = useState<Set<string>>(
		() => new Set(),
	);

	const queries = useQueries({
		queries: targets.map((target) => ({
			queryKey: getHostWorkspacesQueryKey(target),
			enabled: target.hostUrl !== null,
			refetchInterval: WORKSPACES_FALLBACK_REFETCH_INTERVAL_MS,
			// The local host is reachable at 127.0.0.1 even with the machine
			// offline — the default "online" networkMode would pause these
			// queries the moment navigator.onLine goes false, defeating
			// offline-first entirely.
			networkMode: "always" as const,
			// The interval is the healing path for missed workspace:changed
			// events; keep it running while the window is backgrounded
			// (automation/CLI creates land without the app focused).
			refetchIntervalInBackground: true,
			// Bounded retries so an online-per-cloud but tunnel-less relay
			// target settles into isError quickly instead of holding isReady.
			retry: 1,
			queryFn: async (): Promise<HostWorkspaceRow[]> => {
				if (!target.hostUrl) return [];
				const client = getHostServiceClientByUrl(target.hostUrl);
				const rows =
					(await client.workspace.list.query()) as HostWorkspaceRow[];
				setLiveAnsweredHostIds((prev) =>
					prev.has(target.machineId)
						? prev
						: new Set(prev).add(target.machineId),
				);
				saveHostWorkspacesSnapshot(
					target.organizationId,
					target.machineId,
					rows,
				);
				return rows;
			},
		})),
	});

	// Archived tombstones, opt-in, own query key: the shared live list (and
	// its persisted snapshots) must never contain archived rows.
	const archivedQueries = useQueries({
		queries: targets.map((target) => ({
			queryKey: [
				"host-service",
				"workspaces",
				"archived",
				target.organizationId,
				target.machineId,
			] as const,
			enabled: includeArchived && target.hostUrl !== null,
			refetchInterval: WORKSPACES_FALLBACK_REFETCH_INTERVAL_MS,
			networkMode: "always" as const,
			queryFn: async (): Promise<HostWorkspaceRow[]> => {
				if (!target.hostUrl) return [];
				const client = getHostServiceClientByUrl(target.hostUrl);
				const rows = (await client.workspace.list.query({
					includeArchived: true,
				})) as HostWorkspaceRow[];
				return rows.filter((row) => row.archivedAt != null);
			},
		})),
	});

	// Live updates: each reachable host's workspace:changed patches its own
	// cached list (and the snapshot) without a refetch.
	useEffect(() => {
		const cleanups: Array<() => void> = [];
		for (const target of targets) {
			if (!target.hostUrl) continue;
			const hostUrl = target.hostUrl;
			const bus = getEventBus(hostUrl, () => getHostServiceWsToken(hostUrl));
			const removeListener = bus.on(
				"workspace:changed",
				"*",
				(workspaceId, event) => {
					queryClient.setQueryData<HostWorkspaceRow[] | undefined>(
						getHostWorkspacesQueryKey(target),
						(rows) => {
							const next = applyWorkspaceChangedEvent(
								rows,
								event,
								{
									organizationId: target.organizationId,
									machineId: target.machineId,
								},
								workspaceId,
							);
							if (next && next !== rows) {
								saveHostWorkspacesSnapshot(
									target.organizationId,
									target.machineId,
									next,
								);
							}
							return next;
						},
					);
					// Archive state flips arrive as deleted/created events; the
					// tombstone list has no patch payload, so refetch it.
					if (includeArchived) {
						void queryClient.invalidateQueries({
							queryKey: [
								"host-service",
								"workspaces",
								"archived",
								target.organizationId,
								target.machineId,
							],
						});
					}
				},
			);
			const releaseBus = bus.retain();
			cleanups.push(() => {
				removeListener();
				releaseBus();
			});
		}
		return () => {
			for (const cleanup of cleanups) cleanup();
		};
	}, [targets, queryClient, includeArchived]);

	const workspaces = useMemo(() => {
		const merged = mergeHostWorkspaces({
			hostResults: targets.map((target, index) => {
				const query = queries[index];
				const live = query?.data;
				return {
					target,
					rows: live ?? snapshots.get(target.machineId),
					reachable: live !== undefined && !query?.isError,
				};
			}),
			cloudRows: scopedHostId === undefined ? cloudRows : [],
		});
		if (!includeArchived) return merged;
		// Tombstones append after live rows; consumers dedupe by id, so a row
		// mid-unarchive can't render twice.
		const liveIds = new Set(merged.map((row) => row.id));
		const archived: HostWorkspaceItem[] = targets.flatMap((_target, index) => {
			const query = archivedQueries[index];
			const rows = query?.data ?? [];
			return rows
				.filter((row) => !liveIds.has(row.id))
				.map((row) => ({
					...row,
					// react-query retains prior data across a failed refetch —
					// don't report a host as answering when it did not.
					hostReachable: !query?.isError,
					source: "host" as const,
				}));
		});
		return [...merged, ...archived];
	}, [
		targets,
		queries,
		snapshots,
		cloudRows,
		scopedHostId,
		includeArchived,
		archivedQueries,
	]);

	// Readiness reflects host-query settlement only. The Electric collection
	// is a fallback merge, NOT a gate: an Electric collection can stay
	// !isReady indefinitely on an offline cold start (it serves persisted
	// rows without reaching ready), so gating on cloudReady would hang the
	// empty state forever for a genuinely-empty local host while offline.
	// A scoped host that hasn't resolved to a target yet is still loading.
	// Known-hosts settlement IS a gate, though: targets derive from it, and
	// before it settles the fan-out covers only the local host — every query
	// answering then means "the hosts we know of answered", not "every host
	// answered". Reporting ready off that would flash not-found for remote
	// workspaces right after an org switch (offline stays fine: a prior
	// session's snapshot settles it without Electric).
	const isReady =
		knownHostsSettled &&
		(scopedHostId === undefined || targets.length > 0) &&
		queries.every(
			(query, index) =>
				query.isSuccess ||
				query.isError ||
				targets[index]?.hostUrl === null ||
				snapshots.has(targets[index]?.machineId ?? ""),
		) &&
		// Tombstones count toward settlement too: an archived-only host must
		// not read as a settled empty view while its archived query loads.
		(!includeArchived ||
			archivedQueries.every(
				(query, index) =>
					query.isSuccess || query.isError || targets[index]?.hostUrl === null,
			));

	// (KANBAN-HOST-SOURCE) Authority is about proving ABSENCE, and only a
	// host's own real `workspace.list` answer can do that — hence
	// liveAnsweredHostIds recorded inside the queryFn. Neither the query
	// cache (polluted by optimistic setQueryData writes) nor snapshots
	// (best-effort, possibly stale/empty) qualify: both may prove a row
	// EXISTS, never that one doesn't. Global authority additionally requires
	// the hosts collection to be hydrated — an unhydrated `[]` host list must
	// not masquerade as "no other hosts exist". The per-host form lets
	// consumers that know a row's owning host judge its absence while
	// unrelated hosts are offline.
	const isAuthoritative =
		hostsReady &&
		targets.length > 0 &&
		targets.every((target) => liveAnsweredHostIds.has(target.machineId));

	const isAbsenceAuthoritative = useMemo(() => {
		const known = new Set(targets.map((target) => target.machineId));
		return (hostId: string | null | undefined): boolean => {
			// Owner unknown (unbound/legacy) — only org-wide live coverage counts.
			if (hostId == null) return isAuthoritative;
			// The owning host row was removed from the org entirely: its
			// workspaces are unreachable forever, treat their absence as final
			// (self-heal for decommissioned hosts). Only a HYDRATED hosts
			// collection can assert removal — a cold-start `[]` proves nothing.
			if (!known.has(hostId)) return hostsReady;
			return liveAnsweredHostIds.has(hostId);
		};
	}, [targets, liveAnsweredHostIds, isAuthoritative, hostsReady]);

	const cache = useMemo<HostWorkspacesCacheOps>(() => {
		const targetFor = (hostId: string) =>
			targets.find((target) => target.machineId === hostId);
		return {
			resolveHostUrl: (hostId) => targetFor(hostId)?.hostUrl ?? null,
			upsertWorkspace: (row) => {
				const target = targetFor(row.hostId);
				if (!target) return;
				queryClient.setQueryData<HostWorkspaceRow[] | undefined>(
					getHostWorkspacesQueryKey(target),
					(rows) => {
						if (!rows) return [row];
						const exists = rows.some((existing) => existing.id === row.id);
						return exists
							? rows.map((existing) =>
									existing.id === row.id ? { ...existing, ...row } : existing,
								)
							: [...rows, row];
					},
				);
			},
			removeWorkspace: (hostId, workspaceId) => {
				const target = targetFor(hostId);
				if (!target) return;
				queryClient.setQueryData<HostWorkspaceRow[] | undefined>(
					getHostWorkspacesQueryKey(target),
					(rows) => rows?.filter((row) => row.id !== workspaceId),
				);
			},
			invalidateHost: (hostId) => {
				const target = targetFor(hostId);
				if (!target) return;
				void queryClient.invalidateQueries({
					queryKey: getHostWorkspacesQueryKey(target),
				});
			},
		};
	}, [targets, queryClient]);

	return {
		workspaces,
		isReady,
		isAuthoritative,
		isAbsenceAuthoritative,
		cache,
	};
}
