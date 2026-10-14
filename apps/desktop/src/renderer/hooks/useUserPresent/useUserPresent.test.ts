import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	isUserPresent,
	setScreenLocked,
	subscribeToPresence,
} from "./useUserPresent";

const dom = globalThis.document as unknown as {
	hasFocus: () => boolean;
};

// happy-dom derives `document.hidden` from visibilityState and exposes it as a
// getter, so the suite overrides the property rather than assigning to it.
function setPageHidden(hidden: boolean) {
	Object.defineProperty(globalThis.document, "hidden", {
		configurable: true,
		get: () => hidden,
	});
}

beforeEach(() => {
	setPageHidden(false);
	dom.hasFocus = () => true;
});

afterEach(() => {
	setScreenLocked(null);
});

describe("(PRESENCE-SCREEN-LOCK) isUserPresent", () => {
	it("is not present before main has ever reported a lock state", () => {
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
		setPageHidden(true);
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
