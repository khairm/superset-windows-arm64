import { AsyncLocalStorage } from "node:async_hooks";

interface Waiter {
	resolve: () => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout> | null;
}

interface LockState {
	waiters: Waiter[];
}

interface HeldLease {
	active: boolean;
}

const DEFAULT_LOCK_TIMEOUT_MS = 30_000;

export class WorkspaceLockBusyError extends Error {
	constructor(workspaceId: string) {
		super(`Claude account lock is busy for workspace ${workspaceId}`);
		this.name = "WorkspaceLockBusyError";
	}
}

export class WorkspaceLockTimeoutError extends Error {
	constructor(workspaceId: string, timeoutMs: number) {
		super(
			`Timed out after ${timeoutMs}ms waiting for Claude account lock for workspace ${workspaceId}`,
		);
		this.name = "WorkspaceLockTimeoutError";
	}
}

export class WorkspaceLocks {
	private readonly locks = new Map<string, LockState>();
	private readonly held = new AsyncLocalStorage<
		ReadonlyMap<string, HeldLease>
	>();

	async withLock<T>(
		workspaceId: string,
		fn: () => Promise<T>,
		opts?: { tryOnly?: boolean; timeoutMs?: number },
	): Promise<T> {
		if (this.held.getStore()?.get(workspaceId)?.active) return fn();
		await this.acquire(workspaceId, opts);
		const inherited = this.held.getStore() ?? new Map<string, HeldLease>();
		const held = new Map(
			[...inherited].filter(([, inheritedLease]) => inheritedLease.active),
		);
		const lease: HeldLease = { active: true };
		held.set(workspaceId, lease);
		try {
			return await this.held.run(held, fn);
		} finally {
			lease.active = false;
			this.release(workspaceId);
		}
	}

	async withLocks<T>(
		workspaceIds: readonly string[],
		fn: () => Promise<T>,
		opts?: { timeoutMs?: number },
	): Promise<T> {
		const sortedIds = [...new Set(workspaceIds)].sort();
		if (sortedIds.length === 0) return fn();
		const timeoutMs = opts?.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
		if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
			throw new Error(
				`Workspace lock timeout must be positive, got ${timeoutMs}`,
			);
		}
		const deadline = Date.now() + timeoutMs;
		const acquire = (index: number): Promise<T> => {
			const workspaceId = sortedIds[index];
			if (workspaceId === undefined) return fn();
			const remainingMs = deadline - Date.now();
			if (remainingMs <= 0) {
				return Promise.reject(
					new WorkspaceLockTimeoutError(workspaceId, timeoutMs),
				);
			}
			return this.withLock(workspaceId, () => acquire(index + 1), {
				timeoutMs: remainingMs,
			});
		};
		return acquire(0);
	}

	private acquire(
		workspaceId: string,
		opts?: { tryOnly?: boolean; timeoutMs?: number },
	): Promise<void> {
		let state = this.locks.get(workspaceId);
		if (!state) {
			state = { waiters: [] };
			this.locks.set(workspaceId, state);
			return Promise.resolve();
		}
		if (opts?.tryOnly) {
			return Promise.reject(new WorkspaceLockBusyError(workspaceId));
		}

		const timeoutMs = opts?.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
		if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
			return Promise.reject(
				new Error(`Workspace lock timeout must be positive, got ${timeoutMs}`),
			);
		}
		return new Promise<void>((resolve, reject) => {
			const waiter: Waiter = { resolve, reject, timer: null };
			waiter.timer = setTimeout(() => {
				const index = state.waiters.indexOf(waiter);
				if (index >= 0) state.waiters.splice(index, 1);
				reject(new WorkspaceLockTimeoutError(workspaceId, timeoutMs));
			}, timeoutMs);
			state.waiters.push(waiter);
		});
	}

	private release(workspaceId: string): void {
		const state = this.locks.get(workspaceId);
		if (!state) {
			throw new Error(`Claude account lock for ${workspaceId} was not held`);
		}
		const next = state.waiters.shift();
		if (next) {
			if (next.timer) clearTimeout(next.timer);
			next.resolve();
			return;
		}
		this.locks.delete(workspaceId);
	}
}
