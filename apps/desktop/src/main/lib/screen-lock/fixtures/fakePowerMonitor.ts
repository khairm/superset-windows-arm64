import type { ScreenLockPowerMonitor, SystemIdleState } from "../screen-lock";

type PowerEvent = "lock-screen" | "unlock-screen" | "resume";

export function fakePowerMonitor(initial: SystemIdleState | Error) {
	let state: SystemIdleState | Error = initial;
	const thresholds: number[] = [];
	const handlers = new Map<PowerEvent, Set<() => void>>();
	const powerMonitor: ScreenLockPowerMonitor = {
		getSystemIdleState: (threshold) => {
			thresholds.push(threshold);
			if (state instanceof Error) throw state;
			return state;
		},
		on: (event, listener) => {
			const set = handlers.get(event) ?? new Set<() => void>();
			set.add(listener);
			handlers.set(event, set);
		},
		removeListener: (event, listener) => {
			handlers.get(event)?.delete(listener);
		},
	};
	return {
		powerMonitor,
		thresholds,
		setOs: (next: SystemIdleState | Error) => {
			state = next;
		},
		emit: (event: PowerEvent) => {
			for (const listener of handlers.get(event) ?? []) listener();
		},
		listenerCount: () =>
			[...handlers.values()].reduce((sum, set) => sum + set.size, 0),
	};
}
