import { afterEach, describe, expect, it } from "bun:test";
import {
	type ScreenLockPowerMonitor,
	type SystemIdleState,
	startScreenLock,
	stopScreenLock,
	subscribeScreenLock,
} from "./screen-lock";

type PowerEvent = "lock-screen" | "unlock-screen" | "resume";

const unsubscribers: Array<() => void> = [];

afterEach(() => {
	for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
	stopScreenLock();
});

function start(initial: SystemIdleState | Error) {
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
	let now = 100_000;
	let intervalTick: (() => void) | null = null;
	let intervalMs: number | null = null;
	const errors: unknown[] = [];

	const deps = {
		powerMonitor,
		now: () => now,
		startInterval: (tick: () => void, ms: number) => {
			intervalTick = tick;
			intervalMs = ms;
			return () => {
				intervalTick = null;
			};
		},
		logger: {
			info: () => {},
			error: (_message: string, error: unknown) => {
				errors.push(error);
			},
		},
	};
	startScreenLock(deps);

	return {
		deps,
		thresholds,
		errors,
		intervalMs: () => intervalMs,
		setOs: (next: SystemIdleState | Error) => {
			state = next;
		},
		emit: (event: PowerEvent) => {
			for (const listener of handlers.get(event) ?? []) listener();
		},
		listenerCount: () =>
			[...handlers.values()].reduce((sum, set) => sum + set.size, 0),
		advance: (ms: number) => {
			now += ms;
		},
		tick: () => {
			if (!intervalTick) throw new Error("no interval running");
			intervalTick();
		},
	};
}

function subscribe(): Array<boolean | null> {
	const values: Array<boolean | null> = [];
	unsubscribers.push(subscribeScreenLock((locked) => values.push(locked)));
	return values;
}

describe("(PRESENCE-SCREEN-LOCK) screen-lock", () => {
	it("seeds from getSystemIdleState(1)", () => {
		const os = start("locked");
		expect(os.thresholds[0]).toBe(1);
		expect(subscribe()).toEqual([true]);
	});

	it("seeds active and idle as unlocked", () => {
		start("active");
		expect(subscribe()).toEqual([false]);
		stopScreenLock();
		start("idle");
		expect(subscribe()).toEqual([false]);
	});

	it("an unknown seed stays null until the OS or an event says locked", () => {
		const os = start("unknown");
		const values = subscribe();
		expect(values).toEqual([null]);

		os.tick();
		expect(values).toEqual([null]);

		os.setOs("locked");
		os.tick();
		expect(values).toEqual([null, true]);
	});

	it("an unknown seed is set by a lock event", () => {
		const os = start("unknown");
		const values = subscribe();
		os.emit("lock-screen");
		expect(values).toEqual([null, true]);
	});

	it("a seed read that throws stays null and logs one error", () => {
		const os = start(new Error("boom"));
		expect(os.errors).toHaveLength(1);
		os.setOs("unknown");
		expect(subscribe()).toEqual([null]);
		expect(os.errors).toHaveLength(1);
	});

	it("a failing read logs once, and again only after a successful read", () => {
		const os = start(new Error("boom"));
		os.tick();
		expect(os.errors).toHaveLength(1);

		os.setOs("active");
		os.tick();
		os.setOs(new Error("boom again"));
		os.tick();
		os.tick();
		expect(os.errors).toHaveLength(2);
	});

	it("lock and unlock events flip the value and notify; the same value does not", () => {
		const os = start("active");
		const values = subscribe();
		os.emit("lock-screen");
		os.emit("lock-screen");
		os.emit("unlock-screen");
		os.emit("unlock-screen");
		expect(values).toEqual([false, true, false]);
	});

	it("starting twice adds one set of listeners, and stop removes them", () => {
		const os = start("active");
		startScreenLock(os.deps);
		expect(os.listenerCount()).toBe(3);
		expect(os.intervalMs()).toBe(15_000);

		stopScreenLock();
		expect(os.listenerCount()).toBe(0);
		expect(() => os.tick()).toThrow("no interval running");
	});

	it("subscribe re-reads and corrects a stale value", () => {
		const os = start("active");
		const first = subscribe();
		os.setOs("locked");
		expect(subscribe()).toEqual([true]);
		expect(first).toEqual([false, true]);
	});

	it("resume re-reads the OS", () => {
		const os = start("active");
		const values = subscribe();
		os.setOs("locked");
		os.emit("resume");
		expect(values).toEqual([false, true]);
	});

	it("the 15 s read clears a screensaver that ended without an event", () => {
		const os = start("locked");
		const values = subscribe();
		os.setOs("active");
		os.tick();
		expect(values).toEqual([true, false]);
	});

	it("ignores an 'active' read 1 s after a lock event", () => {
		const os = start("active");
		const values = subscribe();
		os.emit("lock-screen");
		os.advance(1_000);
		os.tick();
		expect(values).toEqual([false, true]);
	});

	it("an 'unknown' read keeps the value", () => {
		const os = start("locked");
		const values = subscribe();
		os.setOs("unknown");
		os.tick();
		expect(values).toEqual([true]);
	});
});
