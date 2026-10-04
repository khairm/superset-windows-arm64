export type WorkspaceActivityMap = ReadonlyMap<string, number | null>;

export interface WorkspaceActivityStore {
	get: () => WorkspaceActivityMap;
	set: (next: WorkspaceActivityMap) => void;
	subscribe: (listener: () => void) => () => void;
}

/**
 * (ACTIVITY-SPLIT) Holds the per-workspace activity map outside React
 * context, so a value that moves on every agent tick reaches only the
 * subscribers that read it.
 */
export function createWorkspaceActivityStore(
	initial: WorkspaceActivityMap,
): WorkspaceActivityStore {
	let current = initial;
	const listeners = new Set<() => void>();
	return {
		get: () => current,
		set: (next) => {
			const changed = next !== current;
			current = next;
			if (!changed) return;
			for (const listener of [...listeners]) listener();
		},
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}
