import { useMemo } from "react";
import { useWorkspaceHostUrl } from "renderer/hooks/host-service/useWorkspaceHostUrl";
import { useProjectGitState } from "renderer/routes/_authenticated/_dashboard/kanban/hooks/useProjectGitState";
import { useHostWorkspaces } from "renderer/routes/_authenticated/providers/HostWorkspacesProvider";
import { useLocalHostService } from "renderer/routes/_authenticated/providers/LocalHostServiceProvider";
import { CLOUD_HOST_ID } from "../../components/DashboardNewWorkspaceForm/components/DevicePicker/constants";
import {
	type MasterWorkspaceTarget,
	resolveMasterMode,
} from "./resolveMasterMode";

/**
 * (MASTER-PLUS-LAUNCH) Gathers everything `resolveMasterMode` needs and
 * returns what the new-workspace modal should do for the selected project +
 * host. All of the judgement lives in the pure resolver; this hook only reads.
 *
 * @param projectId the modal's selected project (`draft.selectedProjectId`).
 * @param selectedHostId the launch host (`draft.hostId ?? machineId`).
 * @param projectName the selected project's display name, used as the launch
 *   label when the master row itself is nameless.
 */
export function useMasterWorkspaceTarget(
	projectId: string | null,
	selectedHostId: string | null,
	projectName: string | null,
): MasterWorkspaceTarget {
	const { machineId } = useLocalHostService();
	const { workspaces, isAbsenceAuthoritative } = useHostWorkspaces();

	// One scan for all three master facts. This hook re-runs on every keystroke
	// in the prompt (the draft is context state), and the id, the name and
	// `worktreeExists` all come off the same row — resolving them separately
	// walked the whole workspace list three times per character.
	//
	// Host-scoped: v2 allows one main workspace PER HOST, and master mode
	// restores the one on the host the user is actually launching against.
	const master = useMemo(() => {
		if (!projectId) return null;
		return (
			workspaces.find(
				(workspace) =>
					workspace.projectId === projectId &&
					workspace.type === "main" &&
					(selectedHostId ? workspace.hostId === selectedHostId : true),
			) ?? null
		);
	}, [workspaces, projectId, selectedHostId]);
	const mainWorkspaceId = master?.id ?? null;

	// Rungs 1-3 of the ladder discard the probe's answer outright for a cloud
	// or remote selection, so don't pay for it: `enabled: false` keeps
	// `git.isRepo` / `getMultiRepoInfo` off the wire while the user is pointed
	// at another device.
	const isLocalSelection =
		selectedHostId != null &&
		selectedHostId !== CLOUD_HOST_ID &&
		selectedHostId === machineId;
	const { isResolved, isError, isGitRepo, isMultiRepo } = useProjectGitState(
		projectId,
		selectedHostId,
		isLocalSelection,
	);
	const hostUrl = useWorkspaceHostUrl(mainWorkspaceId);
	// Absence of the master row is only ever proven by the host that would own
	// it — an unrelated offline host must not hold the modal on "Checking…".
	const absenceAuthoritative = isAbsenceAuthoritative(selectedHostId);

	const masterName = master?.name ?? null;
	const masterWorktreeExists = master?.worktreeExists;

	return useMemo(
		() =>
			resolveMasterMode({
				projectId,
				selectedHostId,
				machineId,
				mainWorkspaceId,
				masterWorktreeExists,
				isAbsenceAuthoritative: absenceAuthoritative,
				isResolved,
				isError,
				isGitRepo,
				isMultiRepo,
				hostUrl,
				masterName,
				projectName,
			}),
		[
			projectId,
			selectedHostId,
			machineId,
			mainWorkspaceId,
			masterWorktreeExists,
			absenceAuthoritative,
			isResolved,
			isError,
			isGitRepo,
			isMultiRepo,
			hostUrl,
			masterName,
			projectName,
		],
	);
}
