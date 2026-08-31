function localCollectionStorageKey(
	prefix: string,
	organizationId: string,
): string {
	if (organizationId.length === 0) {
		throw new Error("Cannot create a local collection key without an organization ID");
	}
	return `${prefix}-${organizationId}`;
}

export function workspaceLocalStateStorageKey(
	organizationId: string,
): string {
	return localCollectionStorageKey("v2-workspace-local-state", organizationId);
}

export function kanbanCardsStorageKey(organizationId: string): string {
	return localCollectionStorageKey("v2-kanban-cards", organizationId);
}
