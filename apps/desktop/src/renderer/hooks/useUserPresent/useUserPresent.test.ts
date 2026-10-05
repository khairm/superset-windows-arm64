import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	isUserPresent,
	setScreenLocked,
	subscribeToPresence,
} from "./useUserPresent";

const dom = globalThis.document as unknown as {
	hidden: boolean;
	hasFocus: () => boolean;
};

beforeEach(() => {
	dom.hidden = false;
	dom.hasFocus = () => true;
});

afterEach(() => {
	setScreenLocked(null);
});

describe("(PRESENCE-SCREEN-LOCK) isUserPresent", () => {
	it("is not present before main has ever reported a lock state", () => {
		expect(isUserPresent()).toBe(false);
	});

	it("an unknown lock state is not present", () => {
		setScreenLocked(null);
		expect(isUserPresent()).toBe(false);
	});

	it("a locked session is not present", () => {
		setScreenLocked(true);
		expect(isUserPresent()).toBe(false);
	});

	it("unlocked, focused and visible is present", () => {
		setScreenLocked(false);
		expect(isUserPresent()).toBe(true);
	});

	it("a hidden page is not present", () => {
		setScreenLocked(false);
		dom.hidden = true;
		expect(isUserPresent()).toBe(false);
	});

	it("listeners fire on a lock change", () => {
		setScreenLocked(false);
		let calls = 0;
		const unsubscribe = subscribeToPresence(() => {
			calls += 1;
		});
		setScreenLocked(true);
		setScreenLocked(true);
		setScreenLocked(false);
		unsubscribe();
		setScreenLocked(true);
		expect(calls).toBe(2);
	});
});
