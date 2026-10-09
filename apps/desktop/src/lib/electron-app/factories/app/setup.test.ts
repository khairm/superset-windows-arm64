// Reads setup.ts as source rather than importing it: importing links its named
// electron imports against whichever `mock.module("electron")` an earlier test
// file installed, and Bun cannot add an export the linked mock lacks.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const setupSource = readFileSync(join(import.meta.dirname, "setup.ts"), "utf8");

describe("app setup GPU policy", () => {
	test("leaves GPU acceleration to Chromium's blocklist (#5948)", () => {
		expect(setupSource).not.toMatch(/disableHardwareAcceleration\s*\(/);
		expect(setupSource).not.toMatch(/appendSwitch\(\s*["']disable-gpu/);
	});
});

describe("(WEBVIEW-WEB-ONLY-NAV) app setup webview guests", () => {
	test("guard every guest's main-frame navigations and its src", () => {
		const webviewBranch = setupSource.slice(
			setupSource.indexOf('contents.getType() === "webview"'),
			setupSource.indexOf('"will-attach-webview"'),
		);
		expect(webviewBranch).toContain(
			'"will-frame-navigate", blockNonWebMainFrame',
		);
		expect(webviewBranch).toContain('"will-redirect", blockNonWebMainFrame');
		expect(setupSource).toContain("isAllowedGuestUrl(params.src)");
	});

	test("one permission handler on both guest sessions, installed first", () => {
		expect(setupSource).toContain(
			"callback(guestMayOpenExternal(contents, permission))",
		);
		expect(setupSource).toContain("session.defaultSession");
		expect(setupSource).toContain("session.fromPartition(APP_PARTITION)");
		expect(setupSource).toMatch(/\{\s*denyGuestOpenExternal\(\);/);
	});
});
