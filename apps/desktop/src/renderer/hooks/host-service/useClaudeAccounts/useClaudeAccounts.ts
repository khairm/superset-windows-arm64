import type { AppRouter } from "@superset/host-service";
import { toast } from "@superset/ui/sonner";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import {
	getHostServiceClientByUrl,
	type HostServiceClient,
} from "renderer/lib/host-service-client";
import { electronQueryClient } from "renderer/providers/ElectronTRPCProvider";
import {
	claudeWorkspaceAccountStateQueryKey,
	invalidateClaudeWorkspaceAccountState,
	updateClaudeWorkspaceAccountStateCaches,
} from "./claudeAccountCache";

type RouterOutputs = inferRouterOutputs<AppRouter>;

export type ClaudeAccountCapability =
	RouterOutputs["claudeAccounts"]["capability"];
export type ClaudeAccountRoster = RouterOutputs["claudeAccounts"]["roster"];
export type ClaudeAccount = ClaudeAccountRoster["accounts"][number];
// (CLAUDE-ACCOUNT-SCHEDULE)
export type ClaudeScheduleView =
	RouterOutputs["claudeAccounts"]["scheduleSwitch"];
export type ClaudeScheduleTarget = ClaudeScheduleView["target"];
export type ClaudeScheduleFailure = Extract<
	ClaudeScheduleView,
	{ status: "failed" }
>["failure"];

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
					schedule: slug === current.slug ? current.schedule : null,
				}),
			);
		},
		onError: (error) =>
			toast.error("Couldn't change workspace account", {
				description: error.message,
			}),
	});
}

function useWorkspaceAccountMutation<TVariables, TResult>({
	hostUrl,
	workspaceId,
	call,
	errorTitle,
	inlineErrors = false,
}: {
	hostUrl: string | null;
	workspaceId: string;
	call: (client: HostServiceClient, variables: TVariables) => Promise<TResult>;
	errorTitle: string;
	inlineErrors?: boolean;
}) {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (variables: TVariables) => {
			if (!hostUrl) throw new Error("Workspace host is unavailable.");
			return call(getHostServiceClientByUrl(hostUrl), variables);
		},
		onSuccess: () => {
			if (!hostUrl) return;
			return invalidateClaudeWorkspaceAccountState(
				queryClient,
				hostUrl,
				workspaceId,
			);
		},
		onError: (error) => {
			if (inlineErrors) return;
			toast.error(errorTitle, { description: error.message });
		},
	});
}

export function useSetClaudeAutoSwitch(
	hostUrl: string | null,
	workspaceId: string,
) {
	return useWorkspaceAccountMutation({
		hostUrl,
		workspaceId,
		call: (client, enabled: boolean) =>
			client.claudeAccounts.setAutoSwitch.mutate({ workspaceId, enabled }),
		errorTitle: "Couldn't change auto-switch",
	});
}

export function useScheduleClaudeSwitch(
	hostUrl: string | null,
	workspaceId: string,
	{ inlineErrors = false }: { inlineErrors?: boolean } = {},
) {
	return useWorkspaceAccountMutation({
		hostUrl,
		workspaceId,
		call: (
			client,
			{ target, fireAt }: { target: ClaudeScheduleTarget; fireAt: number },
		) =>
			client.claudeAccounts.scheduleSwitch.mutate({
				workspaceId,
				target,
				fireAt,
			}),
		errorTitle: "Couldn't schedule the switch",
		inlineErrors,
	});
}

export function useClearClaudeScheduledSwitch(
	hostUrl: string | null,
	workspaceId: string,
) {
	return useWorkspaceAccountMutation({
		hostUrl,
		workspaceId,
		call: (client, scheduleId: string) =>
			client.claudeAccounts.clearScheduledSwitch.mutate({
				workspaceId,
				scheduleId,
			}),
		errorTitle: "Couldn't cancel the scheduled switch",
	});
}

export async function pinWorkspaceToMachineDefault(
	hostUrl: string,
	workspaceId: string,
	opts?: { onlyIfFollowing?: boolean },
): Promise<void> {
	await getHostServiceClientByUrl(
		hostUrl,
	).claudeAccounts.pinWorkspaceToMachineDefault.mutate({
		workspaceId,
		...opts,
	});
	await invalidateClaudeWorkspaceAccountState(
		electronQueryClient,
		hostUrl,
		workspaceId,
	);
}
