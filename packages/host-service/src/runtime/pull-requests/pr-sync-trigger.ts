import type { GitChangedEvent } from "../../events/git-watcher";

export interface PrSyncTriggerOptions {
	/** Min gap between syncs after a `.git/` or overflowed batch (no `paths`). */
	broadIntervalMs: number;
	/** Min gap between syncs after worktree-file-only batches. */
	fileOnlyIntervalMs: number;
}

export interface PrSyncEvent {
	workspaceId: string;
	/** Absent from sources with no rate limiter, such as a bare GitWatcher. */
	trailing?: boolean;
}

export type PrSyncListener = (event: PrSyncEvent) => void;

export interface PrSyncTrigger {
	push(event: GitChangedEvent): void;
	onChanged(listener: PrSyncListener): () => void;
	cancelWorkspace(workspaceId: string): void;
	dispose(): void;
}

interface WorkspaceTrigger {
	lastFireAt: number | null;
	timer: ReturnType<typeof setTimeout> | null;
	dueAt: number;
}

/**
 * (GIT-LAUNCH-BUDGET-B) Calls after `dispose` are no-ops, because GitWatcher's
 * own close still reports every workspace as unwatched.
 */
export function createPrSyncTrigger(
	options: PrSyncTriggerOptions,
): PrSyncTrigger {
	const listeners = new Set<PrSyncListener>();
	const workspaces = new Map<string, WorkspaceTrigger>();
	let disposed = false;

	const fire = (
		workspaceId: string,
		state: WorkspaceTrigger,
		trailing: boolean,
	) => {
		if (state.timer) clearTimeout(state.timer);
		state.timer = null;
		state.lastFireAt = Date.now();
		for (const listener of listeners) {
			try {
				listener({ workspaceId, trailing });
			} catch (error) {
				console.error("[pr-sync-trigger] listener threw — contained", {
					workspaceId,
					error,
				});
			}
		}
	};

	return {
		push(event) {
			if (disposed) return;
			const intervalMs =
				event.paths === undefined
					? options.broadIntervalMs
					: options.fileOnlyIntervalMs;
			let state = workspaces.get(event.workspaceId);
			if (!state) {
				state = { lastFireAt: null, timer: null, dueAt: 0 };
				workspaces.set(event.workspaceId, state);
			}
			const now = Date.now();
			if (state.lastFireAt === null || now - state.lastFireAt >= intervalMs) {
				fire(event.workspaceId, state, false);
				return;
			}
			const dueAt = state.lastFireAt + intervalMs;
			if (state.timer && state.dueAt <= dueAt) return;
			if (state.timer) clearTimeout(state.timer);
			const scheduled = state;
			scheduled.dueAt = dueAt;
			scheduled.timer = setTimeout(
				() => fire(event.workspaceId, scheduled, true),
				dueAt - now,
			);
		},
		onChanged(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		cancelWorkspace(workspaceId) {
			const state = workspaces.get(workspaceId);
			if (state?.timer) clearTimeout(state.timer);
			workspaces.delete(workspaceId);
		},
		dispose() {
			disposed = true;
			for (const state of workspaces.values()) {
				if (state.timer) clearTimeout(state.timer);
			}
			workspaces.clear();
			listeners.clear();
		},
	};
}
