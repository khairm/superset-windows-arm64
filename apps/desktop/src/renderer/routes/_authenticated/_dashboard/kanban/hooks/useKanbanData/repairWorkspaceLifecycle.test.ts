import { describe, expect, it } from "bun:test";
import {
	type KanbanWorkspaceLifecycleActions,
	type KanbanWorkspaceLifecycleSnapshot,
	repairKanbanWorkspaceLifecycle,
} from "./repairWorkspaceLifecycle";

const BASE_SNAPSHOT: KanbanWorkspaceLifecycleSnapshot = {
	cardId: "card-1",
	workspaceId: "workspace-1",
	isCompletedCard: true,
	now: 999,
};

interface LiveState {
	workspaceBucket: string;
	workspaceCompletedAt: number | null;
	cardCompletedAt: number | null | undefined;
}

function makeActions(
	calls: string[],
	overrides: Partial<LiveState> = {},
): KanbanWorkspaceLifecycleActions {
	const live: LiveState = {
		workspaceBucket: "active",
		workspaceCompletedAt: null,
		cardCompletedAt: 123,
		...overrides,
	};
	return {
		getWorkspaceState: () => ({
			bucket: live.workspaceBucket,
			completedAt: live.workspaceCompletedAt,
		}),
		getCardCompletedAt: () => live.cardCompletedAt,
		completeWorkspace: (cardId, workspaceId, completedAt) => {
			calls.push(`complete:${cardId}:${workspaceId}:${completedAt}`);
			live.cardCompletedAt = completedAt;
			live.workspaceBucket = "completed";
			live.workspaceCompletedAt = completedAt;
		},
		uncompleteWorkspace: (workspaceId) => {
			calls.push(`uncomplete:${workspaceId}`);
			live.workspaceBucket = "active";
			live.workspaceCompletedAt = null;
		},
		setCardCompletedAt: (cardId, completedAt) => {
			calls.push(`stamp:${cardId}:${completedAt}`);
			live.cardCompletedAt = completedAt;
		},
	};
}

describe("repairKanbanWorkspaceLifecycle", () => {
	it("routes a partially completed card through the full completion lifecycle", () => {
		const calls: string[] = [];

		repairKanbanWorkspaceLifecycle(BASE_SNAPSHOT, makeActions(calls));

		expect(calls).toEqual(["complete:card-1:workspace-1:123"]);
	});

	it("uses one timestamp for the card intent and workspace completion", () => {
		const calls: string[] = [];

		repairKanbanWorkspaceLifecycle(
			BASE_SNAPSHOT,
			makeActions(calls, { cardCompletedAt: null }),
		);

		expect(calls).toEqual(["complete:card-1:workspace-1:999"]);
	});

	it("routes a card moved out of Completed through uncompletion", () => {
		const calls: string[] = [];

		repairKanbanWorkspaceLifecycle(
			{ ...BASE_SNAPSHOT, isCompletedCard: false },
			makeActions(calls, {
				workspaceBucket: "completed",
				workspaceCompletedAt: 123,
			}),
		);

		expect(calls).toEqual(["uncomplete:workspace-1"]);
	});

	it("fills a missing card timestamp without repeating workspace cleanup", () => {
		const calls: string[] = [];

		repairKanbanWorkspaceLifecycle(
			BASE_SNAPSHOT,
			makeActions(calls, {
				workspaceBucket: "completed",
				workspaceCompletedAt: 456,
				cardCompletedAt: null,
			}),
		);

		expect(calls).toEqual(["stamp:card-1:456"]);
	});

	it("does not repeat lifecycle work after another reconciler repaired it", () => {
		const calls: string[] = [];
		const actions = makeActions(calls, { cardCompletedAt: null });

		repairKanbanWorkspaceLifecycle(BASE_SNAPSHOT, actions);
		repairKanbanWorkspaceLifecycle(BASE_SNAPSHOT, actions);

		expect(calls).toEqual(["complete:card-1:workspace-1:999"]);
	});

	it("does not turn a hidden or deleted workspace into Completed", () => {
		for (const workspaceBucket of ["hidden", "deleted"]) {
			const calls: string[] = [];

			repairKanbanWorkspaceLifecycle(
				BASE_SNAPSHOT,
				makeActions(calls, { workspaceBucket }),
			);

			expect(calls).toEqual([]);
		}
	});
});
