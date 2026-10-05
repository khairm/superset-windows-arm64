import { afterEach, describe, expect, it } from "bun:test";
import { fakePowerMonitor } from "main/lib/screen-lock/fixtures/fakePowerMonitor";
import {
	startScreenLock,
	stopScreenLock,
} from "main/lib/screen-lock/screen-lock";
import { createWindowRouter } from "./window";

afterEach(() => {
	stopScreenLock();
});

describe("(PRESENCE-SCREEN-LOCK) window.screenLock", () => {
	it("forwards the current value, then each change", async () => {
		const os = fakePowerMonitor("active");
		startScreenLock({
			powerMonitor: os.powerMonitor,
			now: () => 0,
			startInterval: () => () => {},
			logger: { info: () => {}, error: () => {} },
		});
		const caller = createWindowRouter().createCaller({ senderWindow: null });
		const stream = await caller.screenLock();
		const values: Array<boolean | null> = [];
		const subscription = stream.subscribe({
			next: (locked) => values.push(locked),
		});
		os.emit("lock-screen");
		subscription.unsubscribe();
		expect(values).toEqual([false, true]);
	});
});
