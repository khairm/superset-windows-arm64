export interface SharedTicker {
	subscribe: (onTick: () => void) => () => void;
	getSnapshot: () => number;
}

export function createSharedTicker(ms: number): SharedTicker {
	const listeners = new Set<() => void>();
	let epoch = 0;
	let interval: ReturnType<typeof globalThis.setInterval> | null = null;

	const tick = () => {
		epoch += 1;
		for (const listener of listeners) listener();
	};

	const subscribe = (onTick: () => void) => {
		listeners.add(onTick);
		if (interval === null) interval = globalThis.setInterval(tick, ms);
		return () => {
			listeners.delete(onTick);
			if (listeners.size === 0 && interval !== null) {
				globalThis.clearInterval(interval);
				interval = null;
			}
		};
	};

	const getSnapshot = () => epoch;

	return { subscribe, getSnapshot };
}

export const noopSubscribe = (): (() => void) => () => {};
