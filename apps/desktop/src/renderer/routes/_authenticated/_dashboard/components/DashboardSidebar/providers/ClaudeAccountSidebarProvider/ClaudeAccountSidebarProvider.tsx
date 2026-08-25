import { useQuery } from "@tanstack/react-query";
import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useMemo,
	useState,
} from "react";
import {
	type ClaudeWorkspaceAccountState,
	claudeAccountCapabilityQueryKey,
	claudeAccountRosterQueryKey,
	claudeWorkspaceAccountStatesQueryKey,
} from "renderer/hooks/host-service/useClaudeAccounts";
import { getHostServiceClientByUrl } from "renderer/lib/host-service-client";
import {
	FIVE_HOUR_WINDOW_MS,
	type UsagePaceLevel,
	usagePaceLevel,
	WEEKLY_WINDOW_MS,
} from "../../utils/claudeUsagePace";
import { KeyedEntryStore, useKeyedEntry } from "../KeyedEntryStore";

const SIDEBAR_ACCOUNT_STALE_TIME_MS = 60_000;
const SIDEBAR_ACCOUNT_REFETCH_INTERVAL_MS = 60_000;

export interface ClaudeAccountSidebarAccount {
	slug: string;
	fivePct: number | null;
	sevenPct: number | null;
	fablePct: number | null;
	/** null exactly when the matching percent is null. */
	fivePace: UsagePaceLevel | null;
	sevenPace: UsagePaceLevel | null;
	fablePace: UsagePaceLevel | null;
}

export interface ClaudeAccountSidebarEntry {
	state: ClaudeWorkspaceAccountState | null;
	account: ClaudeAccountSidebarAccount | null;
}

const EMPTY_ENTRY: ClaudeAccountSidebarEntry = {
	state: null,
	account: null,
};

function entriesEqual(
	left: ClaudeAccountSidebarEntry,
	right: ClaudeAccountSidebarEntry,
): boolean {
	return (
		left.state?.state === right.state?.state &&
		left.state?.slug === right.state?.slug &&
		left.state?.warning?.kind === right.state?.warning?.kind &&
		left.state?.warning?.message === right.state?.warning?.message &&
		left.account?.slug === right.account?.slug &&
		left.account?.fivePct === right.account?.fivePct &&
		left.account?.sevenPct === right.account?.sevenPct &&
		left.account?.fablePct === right.account?.fablePct &&
		left.account?.fivePace === right.account?.fivePace &&
		left.account?.sevenPace === right.account?.sevenPace &&
		left.account?.fablePace === right.account?.fablePace
	);
}

const ClaudeAccountSidebarContext =
	createContext<KeyedEntryStore<ClaudeAccountSidebarEntry> | null>(null);

export function ClaudeAccountSidebarProvider({
	hostUrl,
	workspaceIds,
	includeRoster,
	children,
}: {
	hostUrl: string | null;
	workspaceIds: string[];
	includeRoster: boolean;
	children: ReactNode;
}) {
	const [store] = useState(
		() => new KeyedEntryStore(EMPTY_ENTRY, entriesEqual),
	);
	const capability = useQuery({
		queryKey: claudeAccountCapabilityQueryKey(hostUrl),
		enabled: hostUrl !== null,
		queryFn: () => {
			if (!hostUrl) throw new Error("Workspace host is unavailable.");
			return getHostServiceClientByUrl(
				hostUrl,
			).claudeAccounts.capability.query();
		},
		staleTime: SIDEBAR_ACCOUNT_STALE_TIME_MS,
	});
	const managed = capability.data?.managed === true;
	const workspaceIdSet = useMemo(() => new Set(workspaceIds), [workspaceIds]);
	const states = useQuery({
		queryKey: claudeWorkspaceAccountStatesQueryKey(hostUrl),
		enabled: hostUrl !== null && managed,
		queryFn: () => {
			if (!hostUrl) throw new Error("Workspace host is unavailable.");
			return getHostServiceClientByUrl(
				hostUrl,
			).claudeAccounts.getWorkspaceStates.query();
		},
		staleTime: SIDEBAR_ACCOUNT_STALE_TIME_MS,
	});
	const hasPinnedWorkspace =
		states.data?.some(
			(state) =>
				state.state === "pinned" && workspaceIdSet.has(state.workspaceId),
		) === true;
	const roster = useQuery({
		queryKey: claudeAccountRosterQueryKey(hostUrl),
		enabled: hostUrl !== null && managed && includeRoster && hasPinnedWorkspace,
		queryFn: () => {
			if (!hostUrl) throw new Error("Workspace host is unavailable.");
			return getHostServiceClientByUrl(hostUrl).claudeAccounts.roster.query();
		},
		staleTime: SIDEBAR_ACCOUNT_STALE_TIME_MS,
		refetchInterval: SIDEBAR_ACCOUNT_REFETCH_INTERVAL_MS,
		// A blurred window counts as unfocused here, which would otherwise park
		// the poll and freeze the percentages the moment the user alt-tabs. The
		// interval stays unconditional: gating it on document.hidden lets a poll
		// that fires while minimized clear the interval for good.
		refetchIntervalInBackground: true,
		// dataUpdatedAt is already tracked because the join memo reads it; listing
		// it explicitly keeps the re-pace alive if that read ever moves.
		notifyOnChangeProps: ["data", "dataUpdatedAt"],
	});
	const statesByWorkspaceId = useMemo(
		() =>
			new Map(
				(states.data ?? []).map((state) => [state.workspaceId, state] as const),
			),
		[states.data],
	);
	const entries = useMemo(() => {
		const now = Date.now();
		const accountsBySlug = new Map(
			(roster.data?.accounts ?? []).map((account) => [
				account.slug,
				{
					slug: account.slug,
					fivePct: account.fivePct,
					sevenPct: account.sevenPct,
					fablePct: account.fablePct,
					fivePace:
						account.fivePct === null
							? null
							: usagePaceLevel(
									account.fivePct,
									account.fiveResetsAt,
									FIVE_HOUR_WINDOW_MS,
									now,
								),
					sevenPace:
						account.sevenPct === null
							? null
							: usagePaceLevel(
									account.sevenPct,
									account.sevenResetsAt,
									WEEKLY_WINDOW_MS,
									now,
								),
					// Fable shares the weekly reset boundary; the roster does not
					// carry a separate fableResetsAt.
					fablePace:
						account.fablePct === null
							? null
							: usagePaceLevel(
									account.fablePct,
									account.sevenResetsAt,
									WEEKLY_WINDOW_MS,
									now,
								),
				},
			]),
		);
		return new Map(
			workspaceIds.map((workspaceId) => {
				const state = statesByWorkspaceId.get(workspaceId) ?? null;
				const account =
					state?.state === "pinned" && state.slug
						? (accountsBySlug.get(state.slug) ?? null)
						: null;
				return [workspaceId, { state, account }] as const;
			}),
		);
		// dataUpdatedAt: each poll re-paces the percentages against the clock even
		// when the roster payload is unchanged.
	}, [workspaceIds, statesByWorkspaceId, roster.data, roster.dataUpdatedAt]);

	store.replaceEntries(entries);
	useEffect(() => store.flushNotifications());

	return (
		<ClaudeAccountSidebarContext.Provider value={store}>
			{children}
		</ClaudeAccountSidebarContext.Provider>
	);
}

export function useClaudeAccountSidebarEntry(
	workspaceId: string,
): ClaudeAccountSidebarEntry {
	const store = useContext(ClaudeAccountSidebarContext);
	if (!store) {
		throw new Error(
			"useClaudeAccountSidebarEntry must be used inside ClaudeAccountSidebarProvider",
		);
	}
	return useKeyedEntry(store, workspaceId);
}
