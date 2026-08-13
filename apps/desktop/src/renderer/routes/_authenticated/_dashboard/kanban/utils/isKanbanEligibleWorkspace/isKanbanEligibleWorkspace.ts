/**
 * (SESSION-LIFECYCLE) Every Kanban card is bound to a branch inside a sidebar
 * project — the board's columns, promote-to-branch drag and completed-context
 * label all assume a repo behind the card. A "session" is project-less by
 * definition, so it is excluded here rather than relying on `Set.has(null)`
 * happening to be false: sessions must never seed, heal into, or render as a
 * card. A workspace whose project has been removed from the sidebar is
 * excluded for the same reason it is hidden in the sidebar.
 */
export function isKanbanEligibleWorkspace(
	workspace: { projectId: string | null },
	sidebarProjectIds: ReadonlySet<string>,
): boolean {
	if (workspace.projectId === null) return false;
	return sidebarProjectIds.has(workspace.projectId);
}
