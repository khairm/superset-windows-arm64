import { toast } from "@superset/ui/sonner";
import type {
	ClaudeAccountStateChangedPayload,
	ClaudeAccountWarningPayload,
} from "@superset/workspace-client";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useEffectEvent, useMemo } from "react";
import {
	claudeWorkspaceAccountStatesQueryKey,
	updateClaudeWorkspaceAccountStateCaches,
} from "renderer/hooks/host-service/useClaudeAccounts";
import { getHostEventBus } from "renderer/lib/host-event-bus";

export interface ClaudeAccountEventWorkspace {
	workspaceId: string;
	workspaceName: string;
}

export function ClaudeAccountEventSubscriber({
	hostUrl,
	workspaces,
}: {
	hostUrl: string;
	workspaces: ClaudeAccountEventWorkspace[];
}): null {
	const queryClient = useQueryClient();
	const workspaceNames = useMemo(
		() =>
			new Map(
				workspaces.map((workspace) => [
					workspace.workspaceId,
					workspace.workspaceName,
				]),
			),
		[workspaces],
	);

	const handleStateChanged = useEffectEvent(
		(workspaceId: string, payload: ClaudeAccountStateChangedPayload) => {
			updateClaudeWorkspaceAccountStateCaches(
				queryClient,
				hostUrl,
				workspaceId,
				(current) => ({
					...current,
					state: payload.state,
					slug: payload.slug,
				}),
				{
					state: payload.state,
					slug: payload.slug,
					warning: null,
				},
			);

			if (payload.cause !== "auto-fallback") return;
			const workspaceName = workspaceNames.get(workspaceId) ?? "Workspace";
			toast.warning(`${workspaceName} fell back to Default (tray)`, {
				description:
					"Its pinned account reached a usage limit. New requests now use the tray default.",
				id: `claude-account-fallback:${hostUrl}:${workspaceId}`,
			});
		},
	);

	const handleWarning = useEffectEvent(
		(workspaceId: string | null, payload: ClaudeAccountWarningPayload) => {
			if (workspaceId) {
				const found = updateClaudeWorkspaceAccountStateCaches(
					queryClient,
					hostUrl,
					workspaceId,
					(current) => ({
						...current,
						warning: payload.active
							? { kind: payload.kind, message: payload.message }
							: null,
					}),
				);
				if (!found) {
					void queryClient.invalidateQueries({
						queryKey: claudeWorkspaceAccountStatesQueryKey(hostUrl),
					});
				}
			} else {
				void queryClient.invalidateQueries({
					queryKey: claudeWorkspaceAccountStatesQueryKey(hostUrl),
				});
			}

			const warningKey = `claude-account-warning:${hostUrl}:${workspaceId ?? "host"}:${payload.kind}`;
			if (!payload.active) {
				toast.dismiss(warningKey);
				return;
			}

			const workspaceName = workspaceId
				? (workspaceNames.get(workspaceId) ?? "Workspace")
				: "Claude account";
			toast.warning(`${workspaceName} needs attention`, {
				description: payload.message,
				id: warningKey,
			});
		},
	);

	useEffect(() => {
		const bus = getHostEventBus(hostUrl);
		const removeStateListener = bus.on(
			"claude-account-state-changed",
			"*",
			handleStateChanged,
		);
		const removeWarningListener = bus.on(
			"claude-account-warning",
			"*",
			handleWarning,
		);
		const release = bus.retain();

		return () => {
			removeStateListener();
			removeWarningListener();
			release();
		};
	}, [hostUrl]);

	return null;
}
