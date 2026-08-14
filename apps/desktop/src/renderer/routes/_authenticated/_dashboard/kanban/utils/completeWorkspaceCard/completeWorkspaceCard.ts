import type { HostShapedWorkspace } from "renderer/hooks/host-workspaces/useHostWorkspaces";
import {
	KANBAN_COMPLETED_COLUMN_ID,
	type KanbanCardRow,
	kanbanBoundCardId,
} from "renderer/routes/_authenticated/providers/CollectionsProvider/dashboardSidebarLocal";
import { buildCompletedContext } from "../completedFilter";
import { deriveCardTitle } from "../deriveCardTitle";

// The host-served shape (project-less "session" workspaces included) — the
// eligibility rules exist precisely to reject the widened cases, so they must
// be expressible here.
export type CompletableWorkspace = Pick<
	HostShapedWorkspace,
	"id" | "projectId" | "type" | "name" | "branch" | "hostId"
>;

export type CompletionEligibleWorkspace = Pick<
	HostShapedWorkspace,
	"projectId" | "type"
>;

export type CompletionSectionState = "snoozed" | "archived" | "deleted";

export type CompleteWorkspaceCardResult =
	| { ok: true }
	| { ok: false; reason: string; canFreezeCard: boolean };

/** An eligible verdict carries the workspace it validated, with its project id
 * already narrowed to a string — an eligible worktree always has one. */
export type WorkspaceCompletionVerdict<W> =
	| { ok: true; workspace: W; projectId: string }
	| { ok: false; reason: string; canFreezeCard: boolean };

export function canMarkWorkspaceCompleted(
	workspace: CompletionEligibleWorkspace,
	sectionState: CompletionSectionState | undefined,
	projectIsInSidebar: boolean,
): boolean {
	return (
		sectionState === undefined &&
		workspace.type === "worktree" &&
		projectIsInSidebar &&
		workspace.projectId !== null
	);
}

// (KANBAN-MARK-COMPLETED) The one verdict every completion path shares, and the
// hard backstop on freezing: a card may only freeze into Completed when nothing
// live sits behind it. A workspace that still exists but is ineligible (main,
// any non-worktree, project-less, or a project removed from the sidebar) is
// refused outright — freezing it would strand a real branch in Completed even
// though canDropCard rejects that drag.
export function classifyWorkspaceCompletion<
	W extends CompletionEligibleWorkspace,
>({
	workspaceId,
	requestedCardId,
	existingCard,
	workspace,
	projectIsInSidebar,
}: {
	workspaceId: string;
	requestedCardId: string | undefined;
	existingCard: KanbanCardRow | null;
	workspace: W | undefined;
	projectIsInSidebar: boolean;
}): WorkspaceCompletionVerdict<W> {
	if (requestedCardId && !existingCard) {
		return {
			ok: false,
			reason: `Kanban card ${requestedCardId} no longer exists`,
			canFreezeCard: false,
		};
	}
	if (!workspace) {
		// Genuinely missing/orphaned — the card survives as a frozen record.
		return {
			ok: false,
			reason: `Workspace ${workspaceId} no longer exists`,
			canFreezeCard: existingCard !== null,
		};
	}
	if (
		workspace.projectId === null ||
		!canMarkWorkspaceCompleted(workspace, undefined, projectIsInSidebar)
	) {
		return {
			ok: false,
			reason: `Workspace ${workspaceId} is not eligible for Kanban completion`,
			canFreezeCard: false,
		};
	}
	return { ok: true, workspace, projectId: workspace.projectId };
}

/** `present` = the host list still serves the workspace; `gone` = its owning
 * host proved the absence; `unproven` = it is missing but nobody authoritative
 * said so (host offline/errored) — the state in which nothing destructive may
 * happen. */
export type BoundCardWorkspacePresence = "present" | "gone" | "unproven";

// (KANBAN-HOST-SOURCE) The single absence-authority verdict for a bound card.
// A workspace missing from the host-served lists proves nothing while its
// owning host is unjudgeable, so a live workspace — including a main — must
// never be completed or frozen during a host outage. Both the drag check and
// the freeze fallback read this.
export function classifyBoundCardWorkspace({
	workspacePresent,
	hostId,
	isAbsenceAuthoritative,
}: {
	workspacePresent: boolean;
	hostId: string | null;
	isAbsenceAuthoritative: (hostId: string | null | undefined) => boolean;
}): BoundCardWorkspacePresence {
	if (workspacePresent) return "present";
	return isAbsenceAuthoritative(hostId) ? "gone" : "unproven";
}

// (KANBAN COMPLETED) The Completed-column drop rule. A main is never
// completable, and a bound card may only be dragged in while its workspace is
// either served (a live worktree, completed for real) or provably gone (frozen
// record) — never while a host outage merely hides it.
export function canDropCardIntoCompleted({
	cardIsBound,
	workspaceType,
	hostId,
	isAbsenceAuthoritative,
}: {
	cardIsBound: boolean;
	workspaceType: string | null | undefined;
	hostId: string | null;
	isAbsenceAuthoritative: (hostId: string | null | undefined) => boolean;
}): boolean {
	if (workspaceType === "main") return false;
	if (!cardIsBound) return true;
	return (
		classifyBoundCardWorkspace({
			workspacePresent: workspaceType != null,
			hostId,
			isAbsenceAuthoritative,
		}) !== "unproven"
	);
}

// (KANBAN-MARK-COMPLETED) The freeze patch for a card with no live workspace
// behind it. Completing is terminal for an UNBOUND (Queued) task's own hide
// states, so they clear. A BOUND card's snooze/archive live on the sidebar row
// it was frozen from and are preserved verbatim — the frozen record must read
// exactly like the card did.
export function buildFrozenCompletedCardPatch(
	card: Pick<KanbanCardRow, "workspaceId">,
	completedAt: number,
): Partial<KanbanCardRow> &
	Pick<
		KanbanCardRow,
		"columnId" | "tabOrder" | "deadlineTabOrder" | "completedAt"
	> {
	const patch = {
		columnId: KANBAN_COMPLETED_COLUMN_ID,
		tabOrder: 0,
		deadlineTabOrder: null,
		completedAt,
	};
	if (card.workspaceId) return patch;
	return {
		...patch,
		snoozeUntil: null,
		snoozeLaunchId: null,
		archivedAt: null,
	};
}

// (KANBAN-MARK-COMPLETED) Single chokepoint every completion path goes through
// (Completed-column drop and sidebar Mark completed) to stamp the completed card.
export function buildCompletedWorkspaceCard({
	workspace,
	projectName,
	existingCard,
	completedAt,
}: {
	workspace: CompletableWorkspace;
	projectName: string | null;
	existingCard: KanbanCardRow | null;
	completedAt: number;
}): KanbanCardRow {
	if (workspace.type !== "worktree") {
		throw new Error(
			`Cannot complete non-worktree workspace ${workspace.id} (${workspace.type})`,
		);
	}
	if (workspace.projectId === null) {
		throw new Error(`Cannot complete project-less workspace ${workspace.id}`);
	}
	if (existingCard?.workspaceId && existingCard.workspaceId !== workspace.id) {
		throw new Error(
			`Cannot complete workspace ${workspace.id} using card ${existingCard.id} bound to ${existingCard.workspaceId}`,
		);
	}

	return {
		id: existingCard?.id ?? kanbanBoundCardId(workspace.id),
		columnId: KANBAN_COMPLETED_COLUMN_ID,
		tabOrder: 0,
		title: deriveCardTitle(workspace),
		description: existingCard?.description ?? null,
		deadline: existingCard?.deadline ?? null,
		deadlineTabOrder: null,
		workspaceId: workspace.id,
		hostId: existingCard?.hostId ?? workspace.hostId,
		snoozeUntil: existingCard?.snoozeUntil ?? null,
		snoozeLaunchId: existingCard?.snoozeLaunchId ?? null,
		archivedAt: existingCard?.archivedAt ?? null,
		completedAt,
		completedContext: buildCompletedContext(projectName, workspace.branch),
		deletedAt: existingCard?.deletedAt ?? null,
		createdAt: existingCard?.createdAt ?? completedAt,
	};
}
