import type { WorkspaceActivityById } from "renderer/hooks/host-workspaces/useHostWorkspaces";

export interface WorkspaceActivityStore {
	get: () => WorkspaceActivityById;
	set: (next: WorkspaceActivityById) => void;
	subscribe: (listener: () => void) => () => void;
}

/**
 * (ACTIVITY-SPLIT) Holds the per-workspace activity map outside React
 * context, so a value that moves on every agent tick reaches only the
 * subscribers that read it.
 */
export function createWorkspaceActivityStore(
	initial: WorkspaceActivityById,
): WorkspaceActivityStore {
	let current = initial;
	const listeners = new Set<() => void>();
	return {
		get: () => current,
		set: (next) => {
			if (next === current) return;
			current = next;
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
