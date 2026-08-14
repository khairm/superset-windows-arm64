import { describe, expect, test } from "bun:test";
import {
	KANBAN_COMPLETED_COLUMN_ID,
	type KanbanCardRow,
	kanbanBoundCardId,
} from "renderer/routes/_authenticated/providers/CollectionsProvider/dashboardSidebarLocal";
import {
	buildCompletedWorkspaceCard,
	buildFrozenCompletedCardPatch,
	type CompletableWorkspace,
	canMarkWorkspaceCompleted,
	classifyWorkspaceCompletion,
} from "./completeWorkspaceCard";

const WORKSPACE: CompletableWorkspace = {
	id: "workspace-1",
	projectId: "project-1",
	type: "worktree",
	name: "Feature branch",
	branch: "feature/branch",
	hostId: "host-1",
};

function existingCard(): KanbanCardRow {
	return {
		id: kanbanBoundCardId(WORKSPACE.id),
		columnId: "in-progress",
		tabOrder: 7,
		title: "Custom title",
		description: "Keep me",
		deadline: 123,
		deadlineTabOrder: 2,
		workspaceId: WORKSPACE.id,
		hostId: "old-host",
		snoozeUntil: 456,
		snoozeLaunchId: "launch",
		archivedAt: 789,
		completedAt: null,
		completedContext: null,
		deletedAt: null,
		createdAt: 10,
	};
}

describe("canMarkWorkspaceCompleted", () => {
	test("allows only active eligible worktrees", () => {
		expect(canMarkWorkspaceCompleted(WORKSPACE, undefined, true)).toBe(true);
		expect(canMarkWorkspaceCompleted(WORKSPACE, "snoozed", true)).toBe(false);
		expect(
			canMarkWorkspaceCompleted(
				{ ...WORKSPACE, type: "main" },
				undefined,
				true,
			),
		).toBe(false);
		expect(
			canMarkWorkspaceCompleted(
				{ ...WORKSPACE, projectId: null },
				undefined,
				true,
			),
		).toBe(false);
		expect(canMarkWorkspaceCompleted(WORKSPACE, undefined, false)).toBe(false);
	});
});

describe("classifyWorkspaceCompletion", () => {
	const classify = (
		overrides: Partial<Parameters<typeof classifyWorkspaceCompletion>[0]> = {},
	) =>
		classifyWorkspaceCompletion({
			workspaceId: WORKSPACE.id,
			requestedCardId: undefined,
			existingCard: existingCard(),
			workspace: WORKSPACE,
			projectIsInSidebar: true,
			...overrides,
		});

	test("accepts an eligible worktree and narrows its project id", () => {
		expect(classify()).toEqual({
			ok: true,
			workspace: WORKSPACE,
			projectId: "project-1",
		});
	});

	test("a requested card that vanished is not freezable", () => {
		expect(classify({ requestedCardId: "card-9", existingCard: null })).toEqual(
			{
				ok: false,
				reason: "Kanban card card-9 no longer exists",
				canFreezeCard: false,
			},
		);
	});

	test("only a missing workspace with a card may freeze", () => {
		expect(classify({ workspace: undefined })).toEqual({
			ok: false,
			reason: `Workspace ${WORKSPACE.id} no longer exists`,
			canFreezeCard: true,
		});
		expect(classify({ workspace: undefined, existingCard: null })).toEqual({
			ok: false,
			reason: `Workspace ${WORKSPACE.id} no longer exists`,
			canFreezeCard: false,
		});
	});

	test("an existing but ineligible workspace never freezes", () => {
		for (const overrides of [
			{ workspace: { ...WORKSPACE, type: "main" as const } },
			{ workspace: { ...WORKSPACE, type: "session" as const } },
			{ workspace: { ...WORKSPACE, projectId: null } },
			{ projectIsInSidebar: false },
		]) {
			expect(classify(overrides)).toEqual({
				ok: false,
				reason: `Workspace ${WORKSPACE.id} is not eligible for Kanban completion`,
				canFreezeCard: false,
			});
		}
	});
});

describe("buildFrozenCompletedCardPatch", () => {
	test("preserves a bound orphan's snooze and archive state", () => {
		expect(buildFrozenCompletedCardPatch(existingCard(), 5_000)).toEqual({
			columnId: KANBAN_COMPLETED_COLUMN_ID,
			tabOrder: 0,
			deadlineTabOrder: null,
			completedAt: 5_000,
		});
	});

	test("clears an unbound task's hide states — completing is terminal", () => {
		expect(
			buildFrozenCompletedCardPatch(
				{ ...existingCard(), workspaceId: null },
				5_000,
			),
		).toEqual({
			columnId: KANBAN_COMPLETED_COLUMN_ID,
			tabOrder: 0,
			deadlineTabOrder: null,
			completedAt: 5_000,
			snoozeUntil: null,
			snoozeLaunchId: null,
			archivedAt: null,
		});
	});
});

describe("buildCompletedWorkspaceCard", () => {
	test("creates a missing bound card at the top of Completed", () => {
		const card = buildCompletedWorkspaceCard({
			workspace: WORKSPACE,
			projectName: "Project",
			existingCard: null,
			completedAt: 1_000,
		});

		expect(card).toEqual({
			id: kanbanBoundCardId(WORKSPACE.id),
			columnId: KANBAN_COMPLETED_COLUMN_ID,
			tabOrder: 0,
			title: "Feature branch",
			description: null,
			deadline: null,
			deadlineTabOrder: null,
			workspaceId: WORKSPACE.id,
			hostId: "host-1",
			snoozeUntil: null,
			snoozeLaunchId: null,
			archivedAt: null,
			completedAt: 1_000,
			completedContext: "Project / feature/branch",
			deletedAt: null,
			createdAt: 1_000,
		});
	});

	test("applies the exact completion patch to an existing card", () => {
		const card = buildCompletedWorkspaceCard({
			workspace: WORKSPACE,
			projectName: "Project",
			existingCard: existingCard(),
			completedAt: 2_000,
		});

		expect(card.columnId).toBe(KANBAN_COMPLETED_COLUMN_ID);
		expect(card.tabOrder).toBe(0);
		expect(card.deadlineTabOrder).toBeNull();
		expect(card.completedAt).toBe(2_000);
		expect(card.title).toBe("Feature branch");
		expect(card.completedContext).toBe("Project / feature/branch");
		expect(card.description).toBe("Keep me");
		expect(card.deadline).toBe(123);
		expect(card.snoozeUntil).toBe(456);
		expect(card.snoozeLaunchId).toBe("launch");
		expect(card.archivedAt).toBe(789);
		expect(card.createdAt).toBe(10);
	});

	test("fails loudly for main, session, and mismatched cards", () => {
		expect(() =>
			buildCompletedWorkspaceCard({
				workspace: { ...WORKSPACE, type: "main" },
				projectName: "Project",
				existingCard: null,
				completedAt: 1,
			}),
		).toThrow("non-worktree");
		expect(() =>
			buildCompletedWorkspaceCard({
				workspace: { ...WORKSPACE, projectId: null },
				projectName: null,
				existingCard: null,
				completedAt: 1,
			}),
		).toThrow("project-less");
		expect(() =>
			buildCompletedWorkspaceCard({
				workspace: WORKSPACE,
				projectName: "Project",
				existingCard: { ...existingCard(), workspaceId: "workspace-2" },
				completedAt: 1,
			}),
		).toThrow("bound to workspace-2");
	});
});
