import {
	type QueryClient,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { getHostEventBus } from "renderer/lib/host-event-bus";
import { getHostServiceClientByUrl } from "renderer/lib/host-service-client";
import { createTrailingRefreshScheduler } from "../useGitStatus/createTrailingRefreshScheduler";
import { useWorkspaceHostUrl } from "../useWorkspaceHostUrl";

type ListByWorkspaceClient = ReturnType<
	typeof getHostServiceClientByUrl
>["terminalAgents"]["listByWorkspace"];
type TerminalAgentBindings = Awaited<
	ReturnType<ListByWorkspaceClient["query"]>
>;
export type TerminalAgentBinding = TerminalAgentBindings[number];

/**
 * Keyed by workspaceId alone (globally unique): hostUrl in the key meant a
 * host-service port change cold-started every agent chip. The queryFn
 * resolves the current host URL at fetch time.
 */
export function getTerminalAgentBindingsQueryKey(workspaceId: string) {
	return ["terminal-agent-bindings", workspaceId] as const;
}

type BindingsQueryKey = ReturnType<typeof getTerminalAgentBindingsQueryKey>;

// (BINDINGS-COALESCE)
type BindingSubscription = {
	acquire: () => () => void;
	refresh: () => void;
};

type ClientBindingState = {
	subscriptions: Map<string, BindingSubscription>;
	hostUrlByQuery: WeakMap<object, string>;
};

const bindingStateByQueryClient = new WeakMap<
	QueryClient,
	ClientBindingState
>();

function subscriptionKey(hostUrl: string, workspaceId: string) {
	return `${hostUrl}\n${workspaceId}`;
}

function getBindingState(queryClient: QueryClient): ClientBindingState {
	let state = bindingStateByQueryClient.get(queryClient);
	if (!state) {
		state = { subscriptions: new Map(), hostUrlByQuery: new WeakMap() };
		bindingStateByQueryClient.set(queryClient, state);
	}
	return state;
}

function createBindingSubscription(
	queryClient: QueryClient,
	hostUrl: string,
	workspaceId: string,
	queryKey: BindingsQueryKey,
	onLastRelease: () => void,
): BindingSubscription {
	const bus = getHostEventBus(hostUrl);
	const scheduler = createTrailingRefreshScheduler(async () => {
		if (queryClient.getQueryState(queryKey)?.fetchStatus === "fetching") {
			await queryClient.refetchQueries(
				{ queryKey, exact: true, type: "all" },
				{ cancelRefetch: false },
			);
		}
		await queryClient.invalidateQueries(
			{ queryKey, exact: true, refetchType: "all" },
			{ cancelRefetch: false },
		);
	});
	let consumers = 0;
	let pendingRefresh: Promise<void> | undefined;
	const refresh = () => {
		const pending = scheduler.request();
		if (pendingRefresh === pending) return;
		pendingRefresh = pending;
		void pending.then(() => {
			if (pendingRefresh !== pending) return;
			pendingRefresh = undefined;
			if (consumers === 0) scheduler.dispose();
		});
	};
	const detachFromBus = [
		bus.on("agent:lifecycle", workspaceId, refresh),
		bus.on("agent:bindings-changed", workspaceId, refresh),
		// (DISPOSE-LIMBO) Deliberately NOT gated on `payload.confirmed`: this only
		// refetches the host's own binding list, so an unconfirmed exit re-reads
		// truth rather than asserting any. Whatever the host still considers live
		// stays live.
		bus.on("terminal:lifecycle", workspaceId, refresh),
		bus.retain(),
	];

	return {
		refresh,
		acquire: () => {
			consumers++;
			return () => {
				consumers--;
				if (consumers !== 0) return;
				if (!pendingRefresh) scheduler.dispose();
				for (const detach of detachFromBus) detach();
				onLastRelease();
			};
		},
	};
}

export function acquireTerminalAgentBindingsSubscription(
	queryClient: QueryClient,
	hostUrl: string,
	workspaceId: string,
): () => void {
	const state = getBindingState(queryClient);
	const queryKey = getTerminalAgentBindingsQueryKey(workspaceId);
	const key = subscriptionKey(hostUrl, workspaceId);
	const query = queryClient.getQueryCache().find({ queryKey, exact: true });
	if (!query) throw new Error("Terminal agent bindings query is missing");

	let subscription = state.subscriptions.get(key);
	if (!subscription) {
		subscription = createBindingSubscription(
			queryClient,
			hostUrl,
			workspaceId,
			queryKey,
			() => state.subscriptions.delete(key),
		);
		state.subscriptions.set(key, subscription);
	}
	const release = subscription.acquire();

	const knownHostUrl = state.hostUrlByQuery.get(query);
	const cacheIsFromAnotherHost =
		knownHostUrl === undefined
			? query.state.data !== undefined
			: knownHostUrl !== hostUrl;
	state.hostUrlByQuery.set(query, hostUrl);
	if (cacheIsFromAnotherHost) subscription.refresh();

	return release;
}

/**
 * Map of `terminalId → agent binding` for a workspace, read from the host
 * store and invalidated on `agent:lifecycle` / `terminal:lifecycle` events.
 */
export function useTerminalAgentBindings(
	workspaceId: string,
	options?: { enabled?: boolean },
): Map<string, TerminalAgentBinding> {
	const hostUrl = useWorkspaceHostUrl(workspaceId);
	const queryClient = useQueryClient();
	const queryKey = useMemo(
		() => getTerminalAgentBindingsQueryKey(workspaceId),
		[workspaceId],
	);

	const enabled =
		(options?.enabled ?? true) && Boolean(workspaceId) && Boolean(hostUrl);

	const { data } = useQuery({
		queryKey,
		enabled,
		queryFn: () => {
			if (!hostUrl) return [] as TerminalAgentBindings;
			return getHostServiceClientByUrl(
				hostUrl,
			).terminalAgents.listByWorkspace.query({ workspaceId });
		},
		// Lifecycle events invalidate for instant updates; the finite
		// staleTime lets focus/remount refetches self-heal any staleness
		// from events missed while the WS was down (host restart, sleep).
		staleTime: 30_000,
	});

	useEffect(() => {
		if (!enabled || !hostUrl) return;
		return acquireTerminalAgentBindingsSubscription(
			queryClient,
			hostUrl,
			workspaceId,
		);
	}, [enabled, hostUrl, queryClient, workspaceId]);

	return useMemo(() => {
		const map = new Map<string, TerminalAgentBinding>();
		for (const binding of data ?? []) {
			map.set(binding.terminalId, binding);
		}
		return map;
	}, [data]);
}

export function useTerminalAgentBinding(
	workspaceId: string,
	terminalId: string,
): TerminalAgentBinding | undefined {
	const bindings = useTerminalAgentBindings(workspaceId);
	return bindings.get(terminalId);
}
