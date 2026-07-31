/**
 * (KEEP-AWAKE) The gate decides whether a fork user's machine may be pinned out
 * of sleep at all, so every branch of it is covered here — most importantly the
 * ones that must NOT read as "open": bridge disabled, no host-service to ask,
 * a bridge that is enabled but down, and every failure to get an authoritative
 * answer (which must be `ok: false`, never a quiet "closed").
 */

import { describe, expect, it } from "bun:test";
import type { HostServiceManifest } from "../host-service-manifest";
import {
	COMPANION_ENABLE_ENV,
	type CompanionGateDeps,
	pollCompanionGate,
} from "./companion-gate";

const ENABLED: NodeJS.ProcessEnv = { [COMPANION_ENABLE_ENV]: "1" };
const DISABLED: NodeJS.ProcessEnv = {};

function manifest(orgId: string): HostServiceManifest {
	return {
		pid: 1234,
		endpoint: `http://127.0.0.1:5555/${orgId}`,
		authToken: `token-${orgId}`,
		startedAt: 1,
		organizationId: orgId,
	};
}

/** The tRPC envelope `companion.gate` answers with. */
function envelope(json: unknown): string {
	return JSON.stringify({ result: { data: { json } } });
}

function gateBody(overrides: Record<string, unknown> = {}): string {
	return envelope({
		bridgeEnabled: true,
		bridgeRunning: true,
		pairedDeviceCount: 0,
		...overrides,
	});
}

/** One org, one manifest, responses served per call in order. */
function deps(
	overrides: Partial<CompanionGateDeps> = {},
): Partial<CompanionGateDeps> {
	return {
		env: ENABLED,
		listOrgIds: () => ["org-a"],
		readManifestFn: (orgId) => manifest(orgId),
		fetchFn: async () => new Response(gateBody(), { status: 200 }),
		...overrides,
	};
}

describe("pollCompanionGate", () => {
	it("is closed, and makes no request, when the bridge is disabled", async () => {
		const gate = await pollCompanionGate({
			env: DISABLED,
			listOrgIds: () => {
				throw new Error("must not be called");
			},
			fetchFn: async () => {
				throw new Error("must not be called");
			},
		});
		expect(gate).toEqual({
			ok: true,
			open: false,
			bridgeEnabled: false,
			bridgeRunning: false,
			pairedDeviceCount: 0,
		});
	});

	it('treats an env value other than exactly "1" as disabled', async () => {
		const gate = await pollCompanionGate(
			deps({ env: { [COMPANION_ENABLE_ENV]: "true" } }),
		);
		expect(gate).toEqual({
			ok: true,
			open: false,
			bridgeEnabled: false,
			bridgeRunning: false,
			pairedDeviceCount: 0,
		});
	});

	it("is closed when no host-service is running", async () => {
		const gate = await pollCompanionGate(
			deps({
				listOrgIds: () => [],
				fetchFn: async () => {
					throw new Error("must not be called");
				},
			}),
		);
		expect(gate).toEqual({
			ok: true,
			open: false,
			bridgeEnabled: true,
			bridgeRunning: false,
			pairedDeviceCount: 0,
		});
	});

	it("fails rather than guessing when a running host-service has no manifest", async () => {
		const gate = await pollCompanionGate(deps({ readManifestFn: () => null }));
		expect(gate.ok).toBe(false);
		if (!gate.ok) expect(gate.error).toContain("no manifest");
	});

	it("fails rather than reporting a closed gate when the request rejects", async () => {
		const gate = await pollCompanionGate(
			deps({
				fetchFn: async () => {
					throw new Error("ECONNREFUSED");
				},
			}),
		);
		expect(gate.ok).toBe(false);
		if (!gate.ok) expect(gate.error).toContain("ECONNREFUSED");
	});

	it("fails rather than reporting a closed gate on a non-OK response", async () => {
		const gate = await pollCompanionGate(
			deps({ fetchFn: async () => new Response("nope", { status: 500 }) }),
		);
		expect(gate.ok).toBe(false);
		if (!gate.ok) expect(gate.error).toContain("HTTP 500");
	});

	it("fails rather than reporting a closed gate on a malformed envelope", async () => {
		const gate = await pollCompanionGate(
			deps({
				fetchFn: async () =>
					new Response(JSON.stringify({ result: {} }), { status: 200 }),
			}),
		);
		expect(gate.ok).toBe(false);
	});

	it("fails rather than silently defaulting a non-integer pairedDeviceCount", async () => {
		const gate = await pollCompanionGate(
			deps({
				fetchFn: async () =>
					new Response(gateBody({ pairedDeviceCount: "2" }), { status: 200 }),
			}),
		);
		expect(gate.ok).toBe(false);
	});

	it("is closed when the bridge runs with zero pairings", async () => {
		const gate = await pollCompanionGate(deps());
		expect(gate).toEqual({
			ok: true,
			open: false,
			bridgeEnabled: true,
			bridgeRunning: true,
			pairedDeviceCount: 0,
		});
	});

	it("is open when the bridge runs with live pairings", async () => {
		const gate = await pollCompanionGate(
			deps({
				fetchFn: async () =>
					new Response(gateBody({ pairedDeviceCount: 2 }), { status: 200 }),
			}),
		);
		expect(gate).toEqual({
			ok: true,
			open: true,
			bridgeEnabled: true,
			bridgeRunning: true,
			pairedDeviceCount: 2,
		});
	});

	it("is closed when devices are paired but the bridge is not running", async () => {
		const gate = await pollCompanionGate(
			deps({
				fetchFn: async () =>
					new Response(
						gateBody({ bridgeRunning: false, pairedDeviceCount: 2 }),
						{ status: 200 },
					),
			}),
		);
		expect(gate).toEqual({
			ok: true,
			open: false,
			bridgeEnabled: true,
			bridgeRunning: false,
			pairedDeviceCount: 2,
		});
	});

	it("fails when the child says the bridge env is unset while main says 1", async () => {
		const gate = await pollCompanionGate(
			deps({
				fetchFn: async () =>
					new Response(gateBody({ bridgeEnabled: false }), { status: 200 }),
			}),
		);
		expect(gate.ok).toBe(false);
		if (!gate.ok) expect(gate.error).toContain(COMPANION_ENABLE_ENV);
	});

	it("sums counts across host-services and needs only one running bridge", async () => {
		const bodies: Record<string, string> = {
			"org-a": gateBody({ bridgeRunning: true, pairedDeviceCount: 1 }),
			"org-b": gateBody({ bridgeRunning: false, pairedDeviceCount: 1 }),
		};
		const gate = await pollCompanionGate(
			deps({
				listOrgIds: () => ["org-a", "org-b"],
				fetchFn: async (input) => {
					const url = String(input);
					const org = url.includes("org-a") ? "org-a" : "org-b";
					return new Response(bodies[org], { status: 200 });
				},
			}),
		);
		expect(gate).toEqual({
			ok: true,
			open: true,
			bridgeEnabled: true,
			bridgeRunning: true,
			pairedDeviceCount: 2,
		});
	});

	it("fails the whole read when any one host-service fails to answer", async () => {
		let call = 0;
		const gate = await pollCompanionGate(
			deps({
				listOrgIds: () => ["org-a", "org-b"],
				fetchFn: async () => {
					call += 1;
					if (call === 1) {
						return new Response(gateBody({ pairedDeviceCount: 3 }), {
							status: 200,
						});
					}
					throw new Error("ECONNREFUSED");
				},
			}),
		);
		expect(gate.ok).toBe(false);
	});
});
