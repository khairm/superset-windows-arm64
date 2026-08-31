export interface KanbanWorkspaceLifecycleSnapshot {
	cardId: string;
	workspaceId: string;
	isCompletedCard: boolean;
	now: number;
}

export interface KanbanWorkspaceLifecycleState {
	bucket: string;
	completedAt: number | null;
}

export interface KanbanWorkspaceLifecycleActions {
	getWorkspaceState: (workspaceId: string) => KanbanWorkspaceLifecycleState;
	getCardCompletedAt: (cardId: string) => number | null | undefined;
	completeWorkspace: (
		cardId: string,
		workspaceId: string,
		completedAt: number,
	) => void;
	uncompleteWorkspace: (workspaceId: string) => void;
	setCardCompletedAt: (cardId: string, completedAt: number) => void;
}

/**
 * Repairs a bound card after a prior multi-collection update stopped halfway.
 * The sidebar lifecycle commands own every runtime cleanup invariant; this
 * reconciler reads live state so two mounted reconcilers cannot repeat a repair.
 */
export function repairKanbanWorkspaceLifecycle(
	snapshot: KanbanWorkspaceLifecycleSnapshot,
	actions: KanbanWorkspaceLifecycleActions,
): void {
	const workspace = actions.getWorkspaceState(snapshot.workspaceId);
	const cardCompletedAt = actions.getCardCompletedAt(snapshot.cardId);

	if (snapshot.isCompletedCard) {
		if (workspace.bucket === "hidden" || workspace.bucket === "deleted") return;

		if (workspace.bucket !== "completed") {
			const completedAt = cardCompletedAt ?? snapshot.now;
			actions.completeWorkspace(
				snapshot.cardId,
				snapshot.workspaceId,
				completedAt,
			);
			return;
		}

		if (cardCompletedAt == null) {
			actions.setCardCompletedAt(
				snapshot.cardId,
				workspace.completedAt ?? snapshot.now,
			);
		}
		return;
	}

	if (workspace.bucket === "completed") {
		actions.uncompleteWorkspace(snapshot.workspaceId);
	}
}
