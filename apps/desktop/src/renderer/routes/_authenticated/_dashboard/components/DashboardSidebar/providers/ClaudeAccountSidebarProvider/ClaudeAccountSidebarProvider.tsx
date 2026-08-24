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
import { KeyedEntryStore, useKeyedEntry } from "../KeyedEntryStore";

const SIDEBAR_ACCOUNT_STALE_TIME_MS = 60_000;

interface ClaudeAccountSidebarAccount {
	slug: string;
	fivePct: number | null;
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
		left.account?.fivePct === right.account?.fivePct
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
	});
	const entries = useMemo(() => {
		const statesByWorkspaceId = new Map(
			(states.data ?? []).map((state) => [state.workspaceId, state] as const),
		);
		const accountsBySlug = new Map(
			(roster.data?.accounts ?? []).map((account) => [
				account.slug,
				{ slug: account.slug, fivePct: account.fivePct },
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
	}, [workspaceIds, states.data, roster.data]);

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
