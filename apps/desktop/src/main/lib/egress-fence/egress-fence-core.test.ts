import { describe, expect, test } from "bun:test";
import {
	assertEgressFenceInstalled,
	classifyInitiator,
	createEgressFenceCore,
	DEFAULT_MAX_ENTRIES,
	isAppOwnedWebContents,
	markEgressFenceInstalled,
	registerAppWebContents,
	resetAppWebContentsForTests,
	resetEgressFenceInstalledForTests,
	toOrigin,
	UNPARSEABLE_ORIGIN,
	unregisterAppWebContents,
} from "./egress-fence-core";

function core() {
	let clock = 1_700_000_000_000;
	return createEgressFenceCore({ now: () => clock++ });
}

describe("toOrigin", () => {
	test("keeps scheme, host and port and drops path, query and fragment", () => {
		expect(toOrigin("https://api.superset.sh/api/trpc/thing?batch=1")).toBe(
			"https://api.superset.sh",
		);
		expect(toOrigin("http://127.0.0.1:5883/rpc?x=1")).toBe(
			"http://127.0.0.1:5883",
		);
	});

	test("never leaks a URL fragment (the companion pairing secret lives there)", () => {
		const secret = "s3cret-pairing-material";
		const origin = toOrigin(`https://tunnel.example.com/pair#${secret}`);
		expect(origin).toBe("https://tunnel.example.com");
		expect(origin).not.toContain(secret);
	});

	test("never leaks a query-string token", () => {
		const origin = toOrigin("https://api.superset.sh/x?access_token=abc123");
		expect(origin).toBe("https://api.superset.sh");
		expect(origin).not.toContain("abc123");
	});

	test("hostless schemes collapse to the bare scheme, carrying no payload", () => {
		expect(toOrigin("data:text/plain;base64,SGVsbG8=")).toBe("data:");
		expect(toOrigin("blob:superset-app://app/0e1f-uuid")).toBe("blob:");
	});

	test("a non-special scheme keeps its host but still drops the path", () => {
		expect(toOrigin("sentry-ipc://envelope/secret-payload")).toBe(
			"sentry-ipc://envelope",
		);
		expect(toOrigin("superset-app://app/renderer/index.html")).toBe(
			"superset-app://app",
		);
	});

	test("returns null for an unparseable URL rather than echoing it", () => {
		expect(toOrigin("not a url at all")).toBeNull();
	});
});

describe("egress fence core", () => {
	test("records app-renderer traffic as origin only", () => {
		const fence = core();
		fence.record({
			url: "https://api.superset.sh/api/auth/get-session?x=1",
			method: "GET",
			resourceType: "xhr",
			initiator: "app-renderer",
		});
		const [observation] = fence.snapshot();
		expect(observation.origin).toBe("https://api.superset.sh");
		expect(observation.method).toBe("GET");
		expect(observation.resourceType).toBe("xhr");
		expect(observation.initiator).toBe("app-renderer");
		expect(observation.count).toBe(1);
		// The whole record must contain no path or query anywhere.
		expect(JSON.stringify(observation)).not.toContain("get-session");
	});

	test("webview traffic is EXEMPT: counted, never recorded with an origin", () => {
		const fence = core();
		fence.record({
			url: "https://some-site-the-user-browsed.example/private/page",
			method: "GET",
			resourceType: "mainFrame",
			initiator: "webview",
		});
		fence.record({
			url: "https://another.example/thing",
			method: "GET",
			resourceType: "image",
			initiator: "webview",
		});
		expect(fence.snapshot()).toHaveLength(0);
		expect(fence.drainChanged()).toHaveLength(0);
		expect(fence.stats().webviewSkipped).toBe(2);
		expect(fence.stats().tracked).toBe(0);
	});

	test("unknown-initiator traffic records NO origin, only a bare count", () => {
		const fence = core();
		// A service worker registered by a site in a browser pane fetches on this
		// partition with no webContentsId at all. Logging its origin would leak
		// the user's browsing just as surely as logging the webview itself.
		fence.record({
			url: "https://a-site-the-user-visited.example/sw-fetch",
			method: "GET",
			resourceType: "xhr",
			initiator: "unknown",
		});
		expect(fence.snapshot()).toHaveLength(0);
		expect(fence.drainChanged()).toHaveLength(0);
		expect(fence.stats().unattributedSkipped).toBe(1);
		expect(fence.stats().webviewSkipped).toBe(0);
	});

	test("a stale/destroyed webContents id leaks no origin", () => {
		const fence = core();
		// classifyInitiator maps a destroyed webContents to "unknown"; a webview
		// request completing after teardown must not become a logged origin.
		fence.record({
			url: "https://private.example/page?token=abc123",
			method: "GET",
			resourceType: "subFrame",
			initiator: "unknown",
		});
		expect(fence.snapshot()).toHaveLength(0);
		expect(JSON.stringify(fence.snapshot())).not.toContain("private.example");
		expect(fence.stats().unattributedSkipped).toBe(1);
	});

	test("unattributed traffic cannot consume the entry cap", () => {
		const fence = createEgressFenceCore({ maxEntries: 2 });
		for (let i = 0; i < 50; i++) {
			fence.record({
				url: `https://browsed-${i}.example`,
				method: "GET",
				resourceType: "xhr",
				initiator: "unknown",
			});
		}
		expect(fence.stats().tracked).toBe(0);
		expect(fence.stats().droppedAtCap).toBe(0);
		// Room is still there for real app egress.
		fence.record({
			url: "https://api.superset.sh/x",
			method: "GET",
			resourceType: "xhr",
			initiator: "app-renderer",
		});
		expect(fence.stats().tracked).toBe(1);
	});

	test("dedupes on initiator+method+resourceType+origin and counts repeats", () => {
		const fence = core();
		for (const path of ["/a", "/b", "/c"]) {
			fence.record({
				url: `https://api.superset.sh${path}`,
				method: "GET",
				resourceType: "xhr",
				initiator: "app-renderer",
			});
		}
		expect(fence.snapshot()).toHaveLength(1);
		expect(fence.snapshot()[0].count).toBe(3);
	});

	test("a different method or resource type is a separate observation", () => {
		const fence = core();
		fence.record({
			url: "https://api.superset.sh/x",
			method: "GET",
			resourceType: "xhr",
			initiator: "app-renderer",
		});
		fence.record({
			url: "https://api.superset.sh/x",
			method: "POST",
			resourceType: "xhr",
			initiator: "app-renderer",
		});
		expect(fence.snapshot()).toHaveLength(2);
	});

	test("first-seen timestamp is kept from the first sighting", () => {
		const fence = core();
		const input = {
			url: "https://api.superset.sh/x",
			method: "GET",
			resourceType: "xhr",
			initiator: "app-renderer" as const,
		};
		fence.record(input);
		const firstSeenAt = fence.snapshot()[0].firstSeenAt;
		fence.record(input);
		expect(fence.snapshot()[0].firstSeenAt).toBe(firstSeenAt);
	});

	test("drainChanged returns only what moved since the last drain", () => {
		const fence = core();
		fence.record({
			url: "https://api.superset.sh/x",
			method: "GET",
			resourceType: "xhr",
			initiator: "app-renderer",
		});
		expect(fence.drainChanged()).toHaveLength(1);
		expect(fence.drainChanged()).toHaveLength(0);
		fence.record({
			url: "https://api.superset.sh/x",
			method: "GET",
			resourceType: "xhr",
			initiator: "app-renderer",
		});
		expect(fence.drainChanged()).toHaveLength(1);
	});

	test("an unparseable URL is recorded as a placeholder, never as the URL", () => {
		const fence = core();
		fence.record({
			url: "://broken/thing-with-secret",
			method: "GET",
			resourceType: "xhr",
			initiator: "app-renderer",
		});
		const [observation] = fence.snapshot();
		expect(observation.origin).toBe(UNPARSEABLE_ORIGIN);
		expect(JSON.stringify(observation)).not.toContain("thing-with-secret");
	});

	test("is bounded and reports drops loudly instead of evicting silently", () => {
		const fence = createEgressFenceCore({ maxEntries: 3 });
		for (let i = 0; i < 10; i++) {
			fence.record({
				url: `https://host-${i}.example`,
				method: "GET",
				resourceType: "xhr",
				initiator: "app-renderer",
			});
		}
		expect(fence.snapshot()).toHaveLength(3);
		expect(fence.stats().droppedAtCap).toBe(7);
	});

	test("default cap is bounded", () => {
		expect(DEFAULT_MAX_ENTRIES).toBeGreaterThan(0);
		expect(DEFAULT_MAX_ENTRIES).toBeLessThanOrEqual(4096);
	});
});

describe("classifyInitiator", () => {
	const appOwned = (id: number) => id === 1;

	test("a registered app webContents is app-renderer", () => {
		expect(classifyInitiator({ id: 1, type: "window" }, appOwned)).toBe(
			"app-renderer",
		);
	});

	test("a webview is a webview even if somehow registered", () => {
		expect(classifyInitiator({ id: 1, type: "webview" }, appOwned)).toBe(
			"webview",
		);
	});

	test("an UNREGISTERED type-'window' webContents is unattributed, not app-renderer", () => {
		// Browser panes set `allowpopups`, so a browsed site can win a real
		// BrowserWindow on persist:superset. It looks exactly like app chrome by
		// type; only the registry distinguishes it. Logging its origins would leak
		// browsing history.
		expect(classifyInitiator({ id: 99, type: "window" }, appOwned)).toBe(
			"unknown",
		);
	});

	test("a null webContents (absent or destroyed id) is unattributed", () => {
		expect(classifyInitiator(null, appOwned)).toBe("unknown");
	});

	test("a site popup's origins never reach the log", () => {
		const fence = core();
		const popup = classifyInitiator({ id: 99, type: "window" }, appOwned);
		fence.record({
			url: "https://a-site-the-user-browsed.example/page?token=abc",
			method: "GET",
			resourceType: "xhr",
			initiator: popup,
		});
		expect(fence.snapshot()).toHaveLength(0);
		expect(fence.stats().unattributedSkipped).toBe(1);
	});
});

describe("app-owned registry", () => {
	test("register / query / unregister", () => {
		resetAppWebContentsForTests();
		expect(isAppOwnedWebContents(7)).toBe(false);
		registerAppWebContents(7);
		expect(isAppOwnedWebContents(7)).toBe(true);
		unregisterAppWebContents(7);
		expect(isAppOwnedWebContents(7)).toBe(false);
	});

	test("a destroyed-and-unregistered window stops counting as the app", () => {
		resetAppWebContentsForTests();
		registerAppWebContents(3);
		expect(
			classifyInitiator({ id: 3, type: "window" }, isAppOwnedWebContents),
		).toBe("app-renderer");
		unregisterAppWebContents(3);
		expect(
			classifyInitiator({ id: 3, type: "window" }, isAppOwnedWebContents),
		).toBe("unknown");
	});
});

describe("install proof", () => {
	test("asserting before install throws", () => {
		resetEgressFenceInstalledForTests();
		expect(() => assertEgressFenceInstalled()).toThrow(/EGRESS-FENCE/);
	});

	test("asserting after install passes", () => {
		resetEgressFenceInstalledForTests();
		markEgressFenceInstalled();
		expect(() => assertEgressFenceInstalled()).not.toThrow();
	});
});
