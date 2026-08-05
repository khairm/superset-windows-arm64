/**
 * (PUSH-PRESENCE) The desktop beacon is the signal that lets the companion push
 * tell "reading the question" from "not at the machine", so the cases covered
 * here are the ones where getting it wrong changes whether a phone buzzes:
 *
 *  - the bridge being off costs nothing and makes no request at all;
 *  - a `lock` event reports `locked: true` even if the OS has not caught up,
 *    because a lock beacon that says "unlocked" suppresses the very push a
 *    locked machine most needs;
 *  - an `"unknown"` idle state falls back to the latch rather than guessing
 *    "unlocked";
 *  - and NOTHING here can break the keep-awake tick it rides on: every dep is
 *    made to fail and the call still resolves.
 */

import { describe, expect, it } from "bun:test";
import type { HostServiceManifest } from "../host-service-manifest";
import { COMPANION_ENABLE_ENV } from "./companion-gate";
import {
	initialisePresenceLockState,
	type PowerMonitorLike,
	type PresenceBeaconDeps,
	resetPresenceBeaconState,
	sendPresenceBeacon,
} from "./presence-beacon";

const ENABLED: NodeJS.ProcessEnv = { [COMPANION_ENABLE_ENV]: "1" };
const DISABLED: NodeJS.ProcessEnv = {};

const silentLogger: PresenceBeaconDeps["logger"] = {
	info: () => {},
	warn: () => {},
};

function manifest(orgId: string): HostServiceManifest {
	return {
		pid: 1234,
		endpoint: `http://127.0.0.1:5555/${orgId}`,
		authToken: `token-${orgId}`,
		startedAt: 1,
		organizationId: orgId,
	};
}

function monitor(
	idleSeconds: number,
	state: ReturnType<PowerMonitorLike["getSystemIdleState"]> = "active",
): PowerMonitorLike {
	return {
		getSystemIdleTime: () => idleSeconds,
		getSystemIdleState: () => state,
	};
}

interface Capture {
	url: string;
	init: RequestInit | undefined;
}

function recordingFetch(captures: Capture[], ok = true) {
	return (url: string, init?: RequestInit): Promise<Response> => {
		captures.push({ url, init });
		return Promise.resolve(new Response("{}", { status: ok ? 200 : 500 }));
	};
}

/** The `{ json: ... }` superjson envelope the mutation is posted inside. */
function sentBody(capture: Capture): {
	idleSeconds: number;
	locked: boolean;
	event: string;
} {
	const parsed = JSON.parse(String(capture.init?.body)) as {
		json: { idleSeconds: number; locked: boolean; event: string };
	};
	return parsed.json;
}

function deps(overrides: Partial<PresenceBeaconDeps> = {}): PresenceBeaconDeps {
	return {
		env: ENABLED,
		powerMonitor: monitor(5),
		listOrgIds: () => ["org-a"],
		readManifestFn: manifest,
		fetchFn: recordingFetch([]),
		logger: silentLogger,
		...overrides,
	};
}

describe("(PUSH-PRESENCE) sendPresenceBeacon", () => {
	it("makes no request at all when the bridge is off", async () => {
		resetPresenceBeaconState();
		const captures: Capture[] = [];
		const outcome = await sendPresenceBeacon(
			"tick",
			deps({ env: DISABLED, fetchFn: recordingFetch(captures) }),
		);
		expect(outcome).toEqual({ skipped: "disabled" });
		expect(captures).toEqual([]);
	});

	it("skips when no host-service is running", async () => {
		resetPresenceBeaconState();
		const captures: Capture[] = [];
		const outcome = await sendPresenceBeacon(
			"tick",
			deps({ listOrgIds: () => [], fetchFn: recordingFetch(captures) }),
		);
		expect(outcome).toEqual({ skipped: "no-host-service" });
		expect(captures).toEqual([]);
	});

	it("POSTs one beacon per org with the PSK bearer and the superjson envelope", async () => {
		resetPresenceBeaconState();
		const captures: Capture[] = [];
		const outcome = await sendPresenceBeacon(
			"tick",
			deps({
				listOrgIds: () => ["org-a", "org-b"],
				powerMonitor: monitor(12),
				fetchFn: recordingFetch(captures),
			}),
		);

		expect(outcome).toEqual({
			sent: 2,
			failed: 0,
			idleSeconds: 12,
			locked: false,
		});
		expect(captures.map((c) => c.url)).toEqual([
			"http://127.0.0.1:5555/org-a/trpc/companion.presenceBeacon",
			"http://127.0.0.1:5555/org-b/trpc/companion.presenceBeacon",
		]);
		expect(captures[0]?.init?.method).toBe("POST");
		expect(
			(captures[0]?.init?.headers as Record<string, string>).Authorization,
		).toBe("Bearer token-org-a");
		expect(sentBody(captures[0] as Capture)).toEqual({
			idleSeconds: 12,
			locked: false,
			event: "tick",
		});
	});

	it("floors a fractional idle time so the integer boundary cannot reject it", async () => {
		resetPresenceBeaconState();
		const captures: Capture[] = [];
		await sendPresenceBeacon(
			"tick",
			deps({
				powerMonitor: {
					getSystemIdleTime: () => 7.9,
					getSystemIdleState: () => "active",
				},
				fetchFn: recordingFetch(captures),
			}),
		);
		expect(sentBody(captures[0] as Capture).idleSeconds).toBe(7);
	});

	it("a lock event reports locked even while the OS still says active", async () => {
		resetPresenceBeaconState();
		const captures: Capture[] = [];
		const outcome = await sendPresenceBeacon(
			"lock",
			deps({
				powerMonitor: monitor(0, "active"),
				fetchFn: recordingFetch(captures),
			}),
		);
		expect(sentBody(captures[0] as Capture)).toEqual({
			idleSeconds: 0,
			locked: true,
			event: "lock",
		});
		expect(outcome).toMatchObject({ locked: true });
	});

	it("an unknown idle state falls back to the latch rather than guessing unlocked", async () => {
		resetPresenceBeaconState();
		const captures: Capture[] = [];
		// Latch it via a lock event, then tick with an OS that cannot tell.
		await sendPresenceBeacon(
			"lock",
			deps({ fetchFn: recordingFetch(captures) }),
		);
		await sendPresenceBeacon(
			"tick",
			deps({
				powerMonitor: monitor(1, "unknown"),
				fetchFn: recordingFetch(captures),
			}),
		);
		expect(sentBody(captures[1] as Capture).locked).toBe(true);

		// An unlock clears it, and a later unknown tick stays cleared.
		await sendPresenceBeacon(
			"unlock",
			deps({ fetchFn: recordingFetch(captures) }),
		);
		await sendPresenceBeacon(
			"tick",
			deps({
				powerMonitor: monitor(1, "unknown"),
				fetchFn: recordingFetch(captures),
			}),
		);
		expect(sentBody(captures[3] as Capture).locked).toBe(false);
	});

	it("seeds the lock latch from the OS at startup", () => {
		resetPresenceBeaconState();
		expect(
			initialisePresenceLockState(deps({ powerMonitor: monitor(0, "locked") })),
		).toBe(true);
		expect(
			initialisePresenceLockState(deps({ powerMonitor: monitor(0, "active") })),
		).toBe(false);
	});

	/**
	 * The property `keep-awake/index.ts` depends on. Its `tick()` AWAITS this
	 * call, so a rejection here would abort the tick before the gate read and the
	 * agent-activity poll — the machine's own sleep decision — ever ran.
	 */
	it("a beacon POST failure never breaks the tick", async () => {
		resetPresenceBeaconState();
		const warnings: string[] = [];
		const outcome = await sendPresenceBeacon(
			"tick",
			deps({
				fetchFn: () => Promise.reject(new Error("ECONNREFUSED")),
				logger: { info: () => {}, warn: (message) => warnings.push(message) },
			}),
		);
		expect(outcome).toEqual({
			sent: 0,
			failed: 1,
			idleSeconds: 5,
			locked: false,
		});
		expect(warnings.length).toBe(1);
	});

	it("an HTTP error, a missing manifest and a throwing powerMonitor all resolve", async () => {
		resetPresenceBeaconState();
		const http = await sendPresenceBeacon(
			"tick",
			deps({ fetchFn: recordingFetch([], false) }),
		);
		expect(http).toMatchObject({ sent: 0, failed: 1 });

		resetPresenceBeaconState();
		const noManifest = await sendPresenceBeacon(
			"tick",
			deps({ readManifestFn: () => null }),
		);
		expect(noManifest).toMatchObject({ sent: 0, failed: 1 });

		resetPresenceBeaconState();
		const broken = await sendPresenceBeacon(
			"tick",
			deps({
				powerMonitor: {
					getSystemIdleTime: () => {
						throw new Error("powerMonitor is gone");
					},
					getSystemIdleState: () => "active",
				},
			}),
		);
		expect(broken).toEqual({ skipped: "no-host-service" });

		resetPresenceBeaconState();
		const nonNumeric = await sendPresenceBeacon(
			"tick",
			deps({
				powerMonitor: {
					getSystemIdleTime: () => Number.NaN,
					getSystemIdleState: () => "active",
				},
			}),
		);
		expect(nonNumeric).toEqual({ skipped: "no-host-service" });
	});

	it("logs a repeated failure once, and says so when it recovers", async () => {
		resetPresenceBeaconState();
		const warnings: string[] = [];
		const infos: string[] = [];
		const logger = {
			info: (message: string) => infos.push(message),
			warn: (message: string) => warnings.push(message),
		};
		const failing = deps({
			fetchFn: () => Promise.reject(new Error("ECONNREFUSED")),
			logger,
		});

		await sendPresenceBeacon("tick", failing);
		await sendPresenceBeacon("tick", failing);
		await sendPresenceBeacon("tick", failing);
		expect(warnings.length).toBe(1);

		await sendPresenceBeacon("tick", deps({ logger }));
		expect(infos.some((m) => m.includes("recovered"))).toBe(true);

		await sendPresenceBeacon("tick", failing);
		expect(warnings.length).toBe(2);
	});
});
