import { toast } from "@superset/ui/sonner";
import { useMatchRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useRef } from "react";
import { useActiveOrganizationId } from "renderer/lib/local-identity";
import { cloudTrpc } from "renderer/lib/cloud-trpc";
import { getHostServiceClientByUrl } from "renderer/lib/host-service-client";
import { useDashboardSidebarState } from "renderer/routes/_authenticated/hooks/useDashboardSidebarState";
import { useLocalHostService } from "renderer/routes/_authenticated/providers/LocalHostServiceProvider";
import type { NewWorkspacePromptContextApi } from "renderer/stores/new-workspace-prompt-context";
import { usePromptHistoryStore } from "renderer/stores/prompt-history";
import { useWorkspaceCreates } from "renderer/stores/workspace-creates";
import { useDashboardNewWorkspaceDraft } from "../../../../../DashboardNewWorkspaceDraftContext";
import {
	getMasterMissingAgentRefusal,
	type MasterWorkspaceTarget,
} from "../../../../../hooks/useMasterWorkspaceTarget";
import { CLOUD_HOST_ID } from "../../../components/DevicePicker/constants";
import type { WorkspaceCreateAgent } from "../../types";
import type { UseUploadAttachmentsApi } from "../useUploadAttachments";
import { resolveNames } from "./resolveNames";

/**
 * Submits a workspace create against the new `workspaces.create` host
 * procedure. Attachment uploads run optimistically through `useUploadAttachments`
 * — submit only blocks on whatever uploads are still in flight, then dispatches
 * the create with the resulting `attachmentIds` on the agent launch sugar.
 */
export function useSubmitWorkspace(
	projectId: string | null,
	selectedAgent: WorkspaceCreateAgent,
	selectedModel: string | null,
	selectedEffort: string | null,
	selectedMode: string | null,
	uploadAttachments: UseUploadAttachmentsApi,
	promptContext: NewWorkspacePromptContextApi,
	/**
	 * (MASTER-PLUS-LAUNCH) What this submit should DO. Required, not optional:
	 * a call site that never enters master mode passes `BRANCH_ONLY_TARGET`
	 * explicitly, so no caller can silently inherit the wrong flow.
	 */
	masterTarget: MasterWorkspaceTarget,
) {
	const navigate = useNavigate();
	const matchRoute = useMatchRoute();
	const { closeAndResetDraft, draft } = useDashboardNewWorkspaceDraft();
	const { submit } = useWorkspaceCreates();
	const { machineId } = useLocalHostService();
	const { restoreWorkspace, ensureWorkspaceInSidebar } =
		useDashboardSidebarState();
	// (MASTER-PLUS-LAUNCH) Master submits are fire-and-navigate: nothing about
	// the UI goes pending, so a second trigger would launch a second agent in
	// the same workspace. Three paths can fire (the submit button, the prompt
	// input, and the window-level Cmd/Ctrl+Enter listener), and by the time we
	// reach the master branch we are already past `await awaitUploads()` — so
	// the check and the set MUST stay adjacent, with no await between them, or
	// two queued submits both pass it. Deliberately NOT released on the success
	// path: the modal closes and unmounts this hook, and that unmount is what
	// makes the next open a fresh submit.
	const masterSubmitInFlight = useRef(false);
	// (CLOUD-SEVERANCE-P2) Frozen local organization. Upstream reads the
	// per-window org here; with one organization every window resolves to it.
	const activeOrganizationId = useActiveOrganizationId();
	const createCloudWorkspace = cloudTrpc.cloudWorkspace.create.useMutation();
	const utils = cloudTrpc.useUtils();

	const isSession = draft.isSession;

	const submitWorkspace = useCallback(async () => {
		if (!projectId && !isSession) {
			toast.error("Select a project first");
			return;
		}
		if (isSession && draft.linkedPR !== null) {
			toast.error("Checking out a PR requires a project");
			return;
		}
		if (!activeOrganizationId) {
			toast.error("No active organization");
			return;
		}

		const hostId = draft.hostId ?? machineId;
		if (!hostId) {
			toast.error("No active host");
			return;
		}

		const { readyIds: attachmentIds, errors } =
			await uploadAttachments.awaitUploads();
		if (errors.length > 0) {
			const first = errors[0];
			toast.error(
				first.filename
					? `Attachment upload failed (${first.filename}): ${first.message}`
					: `Attachment upload failed: ${first.message}`,
			);
			return;
		}

		// ── Master mode (MASTER-PLUS-LAUNCH) ─────────────────────────
		// A resolved local NON-GIT single-repo project has no branches to create.
		// Submit restores its master workspace to Active and launches the agent
		// inside it, instead of going anywhere near `workspaces.create`.
		if (masterTarget.mode === "master") {
			const { mainWorkspaceId, hostUrl, masterLabel } = masterTarget;

			// Everything below refuses SYNCHRONOUSLY and mutates nothing, so it
			// all sits above the in-flight latch: a refused submit must leave the
			// latch clear for the corrected one, and only the try/catch below has
			// to put it back.
			//
			// Refused because a PR checkout needs a branch and master mode has
			// none. Mirrors the session guard above.
			if (draft.linkedPR !== null) {
				toast.error("Checking out a PR requires a branch workspace");
				return;
			}

			// Defensive: the resolver only produces a master target with an
			// address, but the host can drop between that render and this click.
			if (!hostUrl) {
				toast.error("Host service is not running");
				return;
			}

			// Deliberately NOT `hasAnyContext`: picking an agent and pressing
			// send with an empty prompt must still launch the bare agent
			// (`agents.run` defaults `prompt` to "").
			const wantAgent = selectedAgent !== "none";

			// The same rule the inline blocker in PromptGroup shows; re-checked
			// here as thin defense, because this hook has three trigger paths and
			// the blocker is only rendered guidance.
			const missingAgentRefusal = getMasterMissingAgentRefusal({
				hasAgent: wantAgent,
				prompt: draft.prompt,
				hasAttachments: attachmentIds.length > 0,
				masterLabel,
			});
			if (missingAgentRefusal) {
				toast.error(missingAgentRefusal);
				return;
			}

			// Past every refusal, so the latch closes immediately before the work
			// it protects — no await between this check and its set, or two
			// queued submits both pass it.
			if (masterSubmitInFlight.current) return;
			masterSubmitInFlight.current = true;

			try {
				const finalPrompt = wantAgent
					? await promptContext.build({
							userPrompt: draft.prompt,
							linkedPR: draft.linkedPR,
							linkedIssues: draft.linkedIssues,
							timeoutMs: 2000,
						})
					: null;

				// Back to Active, and only once nothing above can still throw: a
				// failed `build` must leave the master exactly where it was rather
				// than surfacing it under a "Could not open the project workspace"
				// toast. `restoreWorkspace` clears deletedAt / archivedAt /
				// completedAt / snooze / isHidden in one go, so a master in ANY
				// inactive bucket comes back — including a Recycle-Binned one, which
				// unarchive+unsnooze left in the bin while the agent launched into
				// it (`ensure` refuses to resurrect a "deleted" row, so nothing else
				// would have surfaced it either). It safely no-ops for the row-less
				// auto-included master; `ensure` is what inserts that row, and it is
				// in turn a no-op for a row this call has just made active. A
				// restored master comes back with its stale `sectionId`/`tabOrder` —
				// identical to restoring it from the Archived section or the bin by
				// hand, and accepted for the same reason. Still ahead of the
				// navigate, so the row is Active before the workspace screen opens.
				restoreWorkspace(mainWorkspaceId);
				ensureWorkspaceInSidebar(mainWorkspaceId, projectId);

				// History before the reset, close before the navigate — the draft
				// is gone after either one.
				const trimmedMasterPrompt = draft.prompt.trim();
				if (trimmedMasterPrompt) {
					usePromptHistoryStore.getState().recordPrompt(trimmedMasterPrompt);
				}
				closeAndResetDraft();

				void navigate({
					to: "/v2-workspace/$workspaceId",
					params: { workspaceId: mainWorkspaceId },
				}).catch((error) => {
					console.error(
						"[useSubmitWorkspace] failed to open master workspace",
						error,
					);
				});

				if (wantAgent) {
					// Fire-and-navigate: the workspace screen is already up, and the
					// terminal appears when the host answers.
					void getHostServiceClientByUrl(hostUrl)
						.agents.run.mutate({
							workspaceId: mainWorkspaceId,
							agent: selectedAgent,
							prompt: finalPrompt ?? "",
							attachmentIds:
								attachmentIds.length > 0 ? attachmentIds : undefined,
							model: selectedModel ?? undefined,
							effort: selectedEffort ?? undefined,
						})
						.catch((error: unknown) => {
							toast.error(
								error instanceof Error
									? error.message
									: "Could not start the agent",
							);
						});
				}
			} catch (error) {
				masterSubmitInFlight.current = false;
				toast.error(
					error instanceof Error
						? error.message
						: "Could not open the project workspace",
				);
			}
			return;
		}

		const { branchName, workspaceName } = resolveNames(draft);

		// Cloud workspaces are provisioned by the API, not the local host, so
		// they bypass the host `workspaces.create` path entirely.
		if (hostId === CLOUD_HOST_ID) {
			if (!projectId) {
				toast.error("Cloud workspaces require a project");
				return;
			}
			try {
				// A typed name wins; otherwise the API names it from the prompt,
				// since nothing about a cloud workspace runs on this device.
				// Returns as soon as the row exists — the sandbox is still being
				// provisioned behind it, which the workspace screen renders.
				const created = await createCloudWorkspace.mutateAsync({
					organizationId: activeOrganizationId,
					projectId,
					name: workspaceName ?? undefined,
					prompt: draft.prompt.trim() || undefined,
					branch: branchName ?? "main",
				});
				closeAndResetDraft();
				// The cloud list is what both the sidebar and the workspace route
				// read, and nothing used to tell it a workspace had been created —
				// the row appeared whenever the poll next came round, which is why
				// creating one felt like nothing had happened. Seeded rather than
				// only invalidated because the route we're about to open decides
				// between "provisioning" and "doesn't exist" off this list, and
				// even one refetch round trip is long enough to flash the wrong
				// one. Cancelled first so an in-flight fetch from before the
				// create can't land on top of the patch.
				const listInput = { organizationId: activeOrganizationId };
				await utils.cloudWorkspace.list.cancel(listInput);
				utils.cloudWorkspace.list.setData(listInput, (rows) =>
					rows ? [created, ...rows] : [created],
				);
				void navigate({
					to: "/v2-workspace/$workspaceId",
					params: { workspaceId: created.id },
				}).catch((error) => {
					console.error(
						"[useSubmitWorkspace] failed to open cloud workspace",
						error,
					);
				});
				// Server truth on top of the patch — the generated name lands here.
				void utils.cloudWorkspace.list.invalidate();
			} catch (error) {
				toast.error(
					error instanceof Error
						? error.message
						: "Could not create cloud workspace",
				);
			}
			return;
		}

		const isPrCheckout = draft.linkedPR !== null;

		const linkedTaskId = draft.linkedIssues.find(
			(issue) => issue.source === "internal" && issue.taskId,
		)?.taskId;

		const hasAnyContext =
			!!draft.prompt.trim() ||
			draft.linkedPR !== null ||
			draft.linkedIssues.length > 0 ||
			attachmentIds.length > 0;
		const wantAgent = selectedAgent !== "none" && hasAnyContext;

		const finalPrompt = wantAgent
			? await promptContext.build({
					userPrompt: draft.prompt,
					linkedPR: draft.linkedPR,
					linkedIssues: draft.linkedIssues,
					timeoutMs: 2000,
				})
			: null;

		const agents = wantAgent
			? [
					{
						agent: selectedAgent,
						prompt: finalPrompt ?? "",
						attachmentIds: attachmentIds.length > 0 ? attachmentIds : undefined,
						model: selectedModel ?? undefined,
						effort: selectedEffort ?? undefined,
						mode: selectedMode ?? undefined,
					},
				]
			: undefined;

		// PR path supplies a name (PR title) so the in-flight UI has
		// something to show immediately. Branch path leaves both `name`
		// and `branch` undefined when the user didn't type — a typed name
		// seeds the branch slug; otherwise the server creates with a
		// friendly random and AI-renames once names arrive.
		const prName = isPrCheckout
			? draft.linkedPR?.title || `PR #${draft.linkedPR?.prNumber}`
			: undefined;

		const trimmedPrompt = draft.prompt.trim();
		const workspaceId = crypto.randomUUID();
		const snapshot = isSession
			? {
					id: workspaceId,
					projectId: null,
					name: workspaceName ?? undefined,
					agents,
					namingPrompt: !wantAgent && trimmedPrompt ? trimmedPrompt : undefined,
				}
			: {
					id: workspaceId,
					projectId: projectId as string,
					name: isPrCheckout ? prName : (workspaceName ?? undefined),
					branch: isPrCheckout ? undefined : (branchName ?? undefined),
					skipBranchPrefix:
						!isPrCheckout && branchName !== null && draft.branchNameFromProvider
							? true
							: undefined,
					pr: isPrCheckout ? draft.linkedPR?.prNumber : undefined,
					baseBranch: draft.baseBranch ?? undefined,
					taskId: linkedTaskId,
					agents,
					namingPrompt:
						!isPrCheckout && !wantAgent && trimmedPrompt
							? trimmedPrompt
							: undefined,
				};

		if (trimmedPrompt) {
			usePromptHistoryStore.getState().recordPrompt(trimmedPrompt);
		}

		closeAndResetDraft();
		const { completed } = submit({ hostId, snapshot });
		void navigate({
			to: "/v2-workspace/$workspaceId",
			params: { workspaceId },
		}).catch((error) => {
			console.error("[useSubmitWorkspace] failed to open workspace", error);
		});

		const isViewingOptimisticWorkspace = () => {
			const workspaceMatch = matchRoute({
				to: "/v2-workspace/$workspaceId",
			});
			return (
				workspaceMatch !== false && workspaceMatch.workspaceId === workspaceId
			);
		};

		void completed.then((outcome) => {
			if (!outcome.ok) return;

			// The server can resolve the optimistic workspace to a different
			// canonical id; follow it only if we're still on the optimistic route.
			if (outcome.workspaceId === workspaceId) return;
			if (!isViewingOptimisticWorkspace()) return;
			void navigate({
				to: "/v2-workspace/$workspaceId",
				params: { workspaceId: outcome.workspaceId },
				replace: true,
			}).catch((error) => {
				console.error(
					"[useSubmitWorkspace] failed to redirect workspace",
					error,
				);
			});
		});
	}, [
		activeOrganizationId,
		closeAndResetDraft,
		createCloudWorkspace,
		draft,
		ensureWorkspaceInSidebar,
		isSession,
		masterTarget,
		matchRoute,
		machineId,
		navigate,
		projectId,
		promptContext,
		selectedAgent,
		selectedModel,
		selectedEffort,
		restoreWorkspace,
		selectedMode,
		submit,
		uploadAttachments,
		utils,
	]);

	// Cloud creation is the one path the user waits on, now only for as long as
	// it takes to record the workspace — the sandbox comes up behind the
	// workspace screen. Returned so the submit control can carry its own
	// pending state for that moment rather than looking inert.
	return { submitWorkspace, isCreating: createCloudWorkspace.isPending };
}
