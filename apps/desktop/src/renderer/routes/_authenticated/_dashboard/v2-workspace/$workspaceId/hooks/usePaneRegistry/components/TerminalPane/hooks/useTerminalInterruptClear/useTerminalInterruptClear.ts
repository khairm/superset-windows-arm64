import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useEffectEvent } from "react";
import {
	getTerminalAgentBindingsQueryKey,
	useTerminalAgentBinding,
} from "renderer/hooks/host-service/useTerminalAgentBindings";
import { useWorkspaceHostUrl } from "renderer/hooks/host-service/useWorkspaceHostUrl";
import { getHostServiceClientByUrl } from "renderer/lib/host-service-client";
import {
	type ConnectionState,
	terminalRuntimeRegistry,
} from "renderer/lib/terminal/terminal-runtime-registry";
import {
	getV2NotificationSourceKey,
	getV2TerminalNotificationSource,
	useV2NotificationStore,
} from "renderer/stores/v2-notifications";

/**
 * (MANUAL-DISMISS) Drop the axes an interrupted turn leaves behind on ONE
 * terminal.
 *
 * The host binding is the durable truth, but the dot is rendered from the
 * renderer's own latched axes and no event is coming to clear them — the whole
 * reason this path exists is that an interrupted agent fires no Stop hook. So
 * the yellow and the green go here, and the dot follows the binding
 * immediately instead of waiting for the next resync.
 *
 * NEVER THE PERMISSION AXIS. An interrupt is an automatic path, not the user
 * saying they have dealt with the question, and Escape is a key people press
 * constantly. A live red must survive it; only the explicit "Clear Status"
 * dismiss may retract one.
 */
export function clearInterruptedTerminalAxes({
	terminalId,
	workspaceId,
}: {
	terminalId: string;
	workspaceId: string;
}): void {
	const store = useV2NotificationStore.getState();
	const source = getV2TerminalNotificationSource(terminalId);
	const entry = store.sources[getV2NotificationSourceKey(source)];
	// Carry the entry's own instant rather than stamping `Date.now()`: a
	// surviving permission axis leaves the entry in place, and its occurredAt is
	// HOST-clock evidence that the resync fences replayed rows against.
	store.applySourceAxes(
		source,
		workspaceId,
		{ set: [], clear: ["working", "review"] },
		entry?.occurredAt,
	);
	// The background-running blue has no OSC self-clear either.
	store.clearTerminalBackgroundRunning(terminalId);
}

interface UseTerminalInterruptClearOptions {
	terminalId: string;
	terminalInstanceId: string;
	workspaceId: string;
	connectionState: ConnectionState;
}

/**
 * Ctrl+C / Escape kills the foreground agent turn while the shell stays
 * alive, and Claude Code's Stop hook doesn't fire on user interrupt — so the
 * host binding (the status source of truth) would stay "working". Clear the
 * binding via the silent status mutation (not a synthetic hook event, which
 * would broadcast a completion chime); a real hook event arriving later
 * harmlessly overwrites it. lastEventAt is preserved, so the visible pane's
 * seen mark already covers it and no transient `review` appears.
 */
export function useTerminalInterruptClear({
	terminalId,
	terminalInstanceId,
	workspaceId,
	connectionState,
}: UseTerminalInterruptClearOptions): void {
	const hostUrl = useWorkspaceHostUrl(workspaceId);
	const binding = useTerminalAgentBinding(workspaceId, terminalId);
	const queryClient = useQueryClient();

	const recordInterrupt = useEffectEvent(() => {
		const agentActive =
			binding?.lastEventType === "Start" ||
			binding?.lastEventType === "PermissionRequest";
		if (!agentActive || !hostUrl) return;
		getHostServiceClientByUrl(hostUrl)
			.terminalAgents.clearWorkspaceStatuses.mutate({ workspaceId, terminalId })
			.then(() => {
				clearInterruptedTerminalAxes({ terminalId, workspaceId });
				return queryClient.invalidateQueries({
					queryKey: getTerminalAgentBindingsQueryKey(workspaceId),
				});
			})
			.catch((error) => {
				console.warn(
					"[terminal] failed to clear agent status on interrupt:",
					error,
				);
			});
	});

	// biome-ignore lint/correctness/useExhaustiveDependencies: connectionState re-runs the effect on reconnect so we subscribe to the new xterm instance
	useEffect(() => {
		const terminal = terminalRuntimeRegistry.getTerminal(
			terminalId,
			terminalInstanceId,
		);
		if (!terminal) return;
		const subscription = terminal.onKey(({ domEvent }) => {
			const isInterrupt =
				(domEvent.key === "c" && domEvent.ctrlKey) || domEvent.key === "Escape";
			if (!isInterrupt) return;
			recordInterrupt();
		});
		return () => subscription.dispose();
	}, [terminalId, terminalInstanceId, connectionState]);
}
