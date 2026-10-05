import { afterEach, describe, expect, it } from "bun:test";
import {
	type ScreenLockPowerMonitor,
	type SystemIdleState,
	startScreenLock,
	stopScreenLock,
} from "main/lib/screen-lock/screen-lock";
import { isUserPresent, setScreenLocked } from "renderer/hooks/useUserPresent";
import { createWindowRouter } from "./window";

const unsubscribers: Array<() => void> = [];

afterEach(() => {
	for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
	stopScreenLock();
	setScreenLocked(null);
});

function start(state: SystemIdleState) {
	const handlers = new Map<string, Set<() => void>>();
	const powerMonitor: ScreenLockPowerMonitor = {
		getSystemIdleState: () => state,
		on: (event, listener) => {
			const set = handlers.get(event) ?? new Set<() => void>();
			set.add(listener);
			handlers.set(event, set);
		},
		removeListener: (event, listener) => {
			handlers.get(event)?.delete(listener);
		},
	};
	startScreenLock({
		powerMonitor,
		now: () => 0,
		startInterval: () => () => {},
		logger: { info: () => {}, error: () => {} },
	});
	return {
		emit: (event: "lock-screen" | "unlock-screen") => {
			for (const listener of handlers.get(event) ?? []) listener();
		},
	};
}

async function subscribe() {
	const caller = createWindowRouter().createCaller({ senderWindow: null });
	const stream = await caller.screenLock();
	const values: Array<boolean | null> = [];
	const subscription = stream.subscribe({
		next: (locked) => values.push(locked),
	});
	const unsubscribe = () => subscription.unsubscribe();
	unsubscribers.push(unsubscribe);
	return { values, unsubscribe };
}

describe("(PRESENCE-SCREEN-LOCK) window.screenLock", () => {
	it("emits true first when the session starts locked", async () => {
		start("locked");
		const { values } = await subscribe();
		expect(values).toEqual([true]);
	});

	it("emits null first when the lock state is unknown, which reads as away", async () => {
		start("unknown");
		const { values } = await subscribe();
		expect(values).toEqual([null]);

		const dom = globalThis.document as unknown as {
			hidden: boolean;
			hasFocus: () => boolean;
		};
		dom.hidden = false;
		dom.hasFocus = () => true;
		for (const locked of values) setScreenLocked(locked);
		expect(isUserPresent()).toBe(false);
	});

	it("a reload while locked gets true first", async () => {
		const os = start("active");
		const before = await subscribe();
		os.emit("lock-screen");
		before.unsubscribe();

		const after = await subscribe();
		expect(after.values).toEqual([true]);
	});

	it("two windows both get the current value and every change", async () => {
		const os = start("active");
		const first = await subscribe();
		const second = await subscribe();
		os.emit("lock-screen");
		os.emit("unlock-screen");
		expect(first.values).toEqual([false, true, false]);
		expect(second.values).toEqual([false, true, false]);
	});
});
