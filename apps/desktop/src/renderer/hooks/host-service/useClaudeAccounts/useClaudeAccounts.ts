import type { AppRouter } from "@superset/host-service";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import { getHostServiceClientByUrl } from "renderer/lib/host-service-client";
import {
	claudeWorkspaceAccountStateQueryKey,
	updateClaudeWorkspaceAccountStateCaches,
} from "./claudeAccountCache";

type RouterOutputs = inferRouterOutputs<AppRouter>;

export type ClaudeAccountCapability =
	RouterOutputs["claudeAccounts"]["capability"];
export type ClaudeAccountRoster = RouterOutputs["claudeAccounts"]["roster"];
export type ClaudeAccount = ClaudeAccountRoster["accounts"][number];

export const CLAUDE_ACCOUNT_CAPABILITY_QUERY_KEY = [
	"claude-account-capability",
] as const;
export const CLAUDE_ACCOUNT_ROSTER_QUERY_KEY = [
	"claude-account-roster",
] as const;

const CAPABILITY_STALE_TIME_MS = 60_000;
const ROSTER_STALE_TIME_MS = 60_000;
const STATE_STALE_TIME_MS = 60_000;
export function claudeAccountCapabilityQueryKey(hostUrl: string | null) {
	return [...CLAUDE_ACCOUNT_CAPABILITY_QUERY_KEY, hostUrl] as const;
}

export function claudeAccountRosterQueryKey(hostUrl: string | null) {
	return [...CLAUDE_ACCOUNT_ROSTER_QUERY_KEY, hostUrl] as const;
}

export function useClaudeAccountCapability(
	hostUrl: string | null,
	enabled = true,
) {
	return useQuery({
		queryKey: claudeAccountCapabilityQueryKey(hostUrl),
		enabled: enabled && hostUrl !== null,
		queryFn: () => {
			if (!hostUrl) throw new Error("Workspace host is unavailable.");
			return getHostServiceClientByUrl(
				hostUrl,
			).claudeAccounts.capability.query();
		},
		staleTime: CAPABILITY_STALE_TIME_MS,
	});
}

export function useClaudeAccountRoster(hostUrl: string | null, enabled = true) {
	return useQuery({
		queryKey: claudeAccountRosterQueryKey(hostUrl),
		enabled: enabled && hostUrl !== null,
		queryFn: () => {
			if (!hostUrl) throw new Error("Workspace host is unavailable.");
			return getHostServiceClientByUrl(hostUrl).claudeAccounts.roster.query();
		},
		staleTime: ROSTER_STALE_TIME_MS,
	});
}

export function useClaudeWorkspaceAccountState(
	hostUrl: string | null,
	workspaceId: string,
	enabled = true,
) {
	return useQuery({
		queryKey: claudeWorkspaceAccountStateQueryKey(hostUrl, workspaceId),
		enabled: enabled && hostUrl !== null,
		queryFn: () => {
			if (!hostUrl) throw new Error("Workspace host is unavailable.");
			return getHostServiceClientByUrl(
				hostUrl,
			).claudeAccounts.getWorkspaceState.query({ workspaceId });
		},
		staleTime: STATE_STALE_TIME_MS,
	});
}

export function useSetClaudeWorkspaceAccount(
	hostUrl: string | null,
	workspaceId: string,
) {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (slug: string | null) => {
			if (!hostUrl) throw new Error("Workspace host is unavailable.");
			return getHostServiceClientByUrl(
				hostUrl,
			).claudeAccounts.setWorkspaceAccount.mutate({ workspaceId, slug });
		},
		onSuccess: (_result, slug) => {
			if (!hostUrl) return;
			updateClaudeWorkspaceAccountStateCaches(
				queryClient,
				hostUrl,
				workspaceId,
				(current) => ({
					...current,
					state: slug === null ? "following" : "pinned",
					slug,
				}),
				{
					state: slug === null ? "following" : "pinned",
					slug,
					warning: null,
				},
			);
		},
	});
}
