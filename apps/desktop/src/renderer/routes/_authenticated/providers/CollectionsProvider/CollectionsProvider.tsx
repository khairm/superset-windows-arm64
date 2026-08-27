import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { env } from "renderer/env.renderer";
import { authClient } from "renderer/lib/auth-client";
import {
	CLOUD_TRPC_ROUTER_ROOTS,
	setCloudOrganizationId,
} from "renderer/lib/cloud-trpc";
import { useActiveOrganizationId } from "renderer/lib/local-identity";
import { electronTrpcClient } from "renderer/lib/trpc-client";
import { electronQueryClient } from "renderer/providers/ElectronTRPCProvider/ElectronTRPCProvider";
import {
	evictInactiveOrgCollections,
	getCollections,
	preloadCollections,
} from "./collections";

// Cloud query procedures take no organizationId input (the server scopes by
// active org), so their React Query keys don't encode the org — on org switch
// the previous org's rows must be dropped, not just marked stale.
const ORG_SCOPED_CLOUD_ROUTERS = new Set<string>(CLOUD_TRPC_ROUTER_ROOTS);

function dropCloudQueriesForOrgSwitch(): void {
	electronQueryClient.removeQueries({
		predicate: (query) => {
			const head = query.queryKey[0];
			return (
				Array.isArray(head) &&
				typeof head[0] === "string" &&
				ORG_SCOPED_CLOUD_ROUTERS.has(head[0])
			);
		},
	});
}

type CollectionsContextType = ReturnType<typeof getCollections> & {
	activeOrganizationId: string;
	switchOrganization: (organizationId: string) => Promise<void>;
};

const CollectionsContext = createContext<CollectionsContextType | null>(null);

export function preloadActiveOrganizationCollections(
	activeOrganizationId: string | null | undefined,
): void {
	if (!activeOrganizationId) return;
	void preloadCollections(activeOrganizationId).catch((error) => {
		console.error(
			"[collections-provider] Failed to preload active org collections:",
			error,
		);
	});
}

export function CollectionsProvider({ children }: { children: ReactNode }) {
	const { refetch: refetchSession } = authClient.useSession();
	const [isSwitching, setIsSwitching] = useState(false);
	// (CLOUD-SEVERANCE-P2) Frozen local organization — the collection keys are
	// suffixed with it, so it must be stable for the life of the process.
	//
	// Upstream made this per-window: it seeded from the shared login session,
	// reconciled against the account's organization list, and let each window
	// switch independently. None of those inputs exist here — there is exactly
	// one organization, resolved from disk by main before this window renders —
	// so the window's org is simply that one, known synchronously. The two
	// per-window SINKS below are kept and fed, because they are what the rest of
	// upstream's multi-window work reads.
	const activeOrganizationId = useActiveOrganizationId();

	// Scope this window's cloud reads to its own org, during render rather than
	// in an effect: children below issue their first queries while this render
	// commits, and an effect would let those go out on the session's org — the
	// other window's data — before correcting itself.
	setCloudOrganizationId(activeOrganizationId);

	// Keep the main-process window registry in sync with this window's active
	// org. Declarative and idempotent: re-asserted whenever the org changes, so
	// the registry (which backs the window title, restore-on-relaunch, and
	// openNew) always reflects the displayed org. This replaces a one-shot,
	// fire-and-forget seed — a transient IPC failure self-corrects on the next
	// change or next launch rather than leaving the registry permanently stale.
	useEffect(() => {
		if (!activeOrganizationId) return;
		void electronTrpcClient.window.setActiveOrg
			.mutate({ organizationId: activeOrganizationId })
			.catch((error) => {
				console.error(
					"[collections-provider] Failed to sync window org to registry:",
					error,
				);
			});
	}, [activeOrganizationId]);

	const switchOrganization = useCallback(
		async (organizationId: string) => {
			if (organizationId === activeOrganizationId) return;
			setIsSwitching(true);
			try {
				await authClient.organization.setActive({ organizationId });
				await preloadCollections(organizationId);
				await refetchSession();
			} finally {
				setIsSwitching(false);
			}
		},
		[activeOrganizationId, refetchSession],
	);

	const previousOrganizationIdRef = useRef<string | null>(null);
	useEffect(() => {
		preloadActiveOrganizationCollections(activeOrganizationId);
		// Once the active org is current, evict every prior org's local
		// collection set. This effect is the single trigger for all switch
		// paths, including callers that set the active org directly without
		// going through `switchOrganization`.
		if (activeOrganizationId) {
			evictInactiveOrgCollections(activeOrganizationId);
			if (
				previousOrganizationIdRef.current &&
				previousOrganizationIdRef.current !== activeOrganizationId
			) {
				dropCloudQueriesForOrgSwitch();
			}
			previousOrganizationIdRef.current = activeOrganizationId;
		}
	}, [activeOrganizationId]);

	const collections = useMemo(
		() => (activeOrganizationId ? getCollections(activeOrganizationId) : null),
		[activeOrganizationId],
	);

	const contextValue = useMemo<CollectionsContextType | null>(
		() =>
			collections && activeOrganizationId
				? { ...collections, activeOrganizationId, switchOrganization }
				: null,
		[collections, activeOrganizationId, switchOrganization],
	);

	if (!contextValue || isSwitching) {
		return null;
	}

	return (
		<CollectionsContext.Provider value={contextValue}>
			{children}
		</CollectionsContext.Provider>
	);
}

export function useCollections(): CollectionsContextType {
	const context = useContext(CollectionsContext);
	if (!context) {
		throw new Error("useCollections must be used within CollectionsProvider");
	}
	return context;
}
