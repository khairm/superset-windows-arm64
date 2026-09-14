import { pinWorkspaceToMachineDefault } from "renderer/hooks/host-service/useClaudeAccounts/useClaudeAccounts";
import type {
	HostWorkspaceItem,
	UseHostWorkspacesResult,
} from "renderer/hooks/host-workspaces/useHostWorkspaces";
import type { AppCollections } from "renderer/routes/_authenticated/providers/CollectionsProvider/collections";
import { getWorkspaceSidebarBucket } from "renderer/routes/_authenticated/providers/CollectionsProvider/dashboardSidebarLocal";

export type WorkspacePinTarget = Pick<
	UseHostWorkspacesResult,
	"workspaces" | "cache"
>;
type ResolvedWorkspacePinTarget = {
	workspaceType: HostWorkspaceItem["type"] | null;
	isSandbox: boolean;
};

// (CLAUDE-ACCOUNT-PIN-ON-ACTIVATE) Never wait for account selection to return a card.
export function pinActiveWorkspace(
	collections: Pick<AppCollections, "v2WorkspaceLocalState">,
	workspaceId: string,
	target: WorkspacePinTarget | ResolvedWorkspacePinTarget,
	opts: { hostUrl?: string; onlyIfFollowing?: boolean } = {},
): void {
	const row = collections.v2WorkspaceLocalState.get(workspaceId);
	if (!row || row.sidebarState.runtimeCleanupPendingAt != null) return;
	let workspaceType: HostWorkspaceItem["type"] | null;
	let hostId: string | null = null;
	if ("workspaces" in target) {
		const workspace = target.workspaces.find(
			(candidate) => candidate.id === workspaceId,
		);
		if (!workspace) {
			console.warn(
				"[claude-accounts] could not pin returned workspace: workspace missing",
				{ workspaceId },
			);
			return;
		}
		if (target.cache.isSandboxHost(workspace.hostId)) return;
		workspaceType = workspace.type;
		hostId = workspace.hostId;
	} else {
		if (target.isSandbox) return;
		workspaceType = target.workspaceType;
	}
	if (
		getWorkspaceSidebarBucket(row.sidebarState, Date.now(), workspaceType) !==
		"active"
	)
		return;
	const hostUrl =
		opts.hostUrl ??
		(hostId !== null && "cache" in target
			? target.cache.resolveHostUrl(hostId)
			: null);
	if (hostUrl === null) {
		console.warn(
			"[claude-accounts] could not pin returned workspace: owner unavailable",
			{ workspaceId },
		);
		return;
	}
	void pinWorkspaceToMachineDefault(hostUrl, workspaceId, {
		onlyIfFollowing: opts.onlyIfFollowing,
	}).catch((error) => {
		console.warn("[claude-accounts] could not pin returned workspace", {
			workspaceId,
			error,
		});
	});
}
