import { describe, expect, it } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FCM_PROJECT_ID } from "./config";
import type { DeviceStore } from "./device-store";
import { createLifecycleAlertManager } from "./lifecycle-alerts";
import type { PresenceStore } from "./presence";
import {
	assertPushDataSafe,
	buildLifecyclePushData,
	createPushSender,
	FCM_SEND_ENDPOINT,
	PushConfigError,
} from "./push";
import type { WorkspaceId } from "./types";

describe("lifecycle push v3", () => {
	it("builds the exact content-free shape when there is no context", () => {
		const data = buildLifecyclePushData({
			alertId: "a".repeat(22),
			workspaceId: "w".repeat(22) as never,
			kind: "e",
			expiresAtMs: 1_700_000_000_000,
			// An error alert is never replaced in place, so an unresolvable handle
			// costs it nothing — unlike a ready alert, which refuses to build.
			terminalHandle: "",
			outcomeAtMs: 1_700_000_000_000,
			readThroughAtMs: null,
			context: null,
		});
		// (ALERT-CONTEXT-NAMES) v3, and every context key present but EMPTY. The
		// shape is what changed; "carries nothing it was not given" did not.
		expect(data).toEqual({
			v: "3",
			k: "e",
			i: "a".repeat(22),
			w: "w".repeat(22),
			x: "1700000000000",
			t: "",
			pn: "",
			wn: "",
			tn: "",
			tc: "",
		});
		const envelope = {
			token: "token",
			android: {
				priority: "high" as const,
				ttl: "21600s",
				collapse_key: data.i,
			},
			data,
		};
		expect(() => assertPushDataSafe(data, envelope)).not.toThrow();
	});

	it("rejects text-like and extra values at the FCM boundary", () => {
		const data = buildLifecyclePushData({
			alertId: "b".repeat(22),
			workspaceId: "w".repeat(22) as never,
			kind: "e",
			expiresAtMs: 1_700_000_000_000,
			terminalHandle: "t".repeat(22),
			outcomeAtMs: 1_700_000_000_000,
			readThroughAtMs: null,
			context: null,
		});
		const leaked = { ...data, i: "agent finished with error" };
		const envelope = {
			token: "token",
			android: {
				priority: "high" as const,
				ttl: "21600s",
				collapse_key: leaked.i,
			},
			data: leaked,
		};
		expect(() => assertPushDataSafe(leaked, envelope)).toThrow(PushConfigError);
	});

	// The builder is where a malformed id must die: with no registered device
	// `broadcast` never builds an envelope, so `assertPushDataSafe` would never
	// see it.
	it("rejects a malformed lifecycle alertId at the builder", () => {
		expect(() =>
			buildLifecyclePushData({
				alertId: "agent finished with error",
				workspaceId: "w".repeat(22) as never,
				kind: "e",
				expiresAtMs: 1_700_000_000_000,
				terminalHandle: "t".repeat(22),
				outcomeAtMs: 1_700_000_000_000,
				readThroughAtMs: null,
				context: null,
			}),
		).toThrow(PushConfigError);
		for (const alertId of ["", "a".repeat(21), "a".repeat(23), "a+b/c=d"]) {
			expect(() =>
				buildLifecyclePushData({
					alertId,
					workspaceId: "w".repeat(22) as never,
					kind: "g",
					expiresAtMs: 1_700_000_000_000,
					terminalHandle: "t".repeat(22),
					outcomeAtMs: 1_700_000_000_000,
					readThroughAtMs: 0,
					context: null,
				}),
			).toThrow(PushConfigError);
		}
	});

	it("rejects a malformed lifecycle workspaceId at the builder", () => {
		for (const workspaceId of ["", "w-handle", "w".repeat(43), "feature/x"]) {
			expect(() =>
				buildLifecyclePushData({
					alertId: "a".repeat(22),
					workspaceId: workspaceId as never,
					kind: "g",
					expiresAtMs: 1_700_000_000_000,
					terminalHandle: "t".repeat(22),
					outcomeAtMs: 1_700_000_000_000,
					readThroughAtMs: 0,
					context: null,
				}),
			).toThrow(PushConfigError);
		}
	});

	it("never echoes the rejected id in the error message", () => {
		expect(() =>
			buildLifecyclePushData({
				alertId: "agent finished with error",
				workspaceId: "w".repeat(22) as never,
				kind: "e",
				expiresAtMs: 1_700_000_000_000,
				terminalHandle: "t".repeat(22),
				outcomeAtMs: 1_700_000_000_000,
				readThroughAtMs: null,
				context: null,
			}),
		).toThrow(/^(?!.*agent finished with error).*$/);
	});
});

describe("(LIFECYCLE-ALERT-RETRY) sendLifecycleAlert delivery outcome", () => {
	/**
	 * No phone paired yet is the state most likely to persist for hours, and it
	 * is precisely the state that must NOT read as delivered: a phone that pairs
	 * an hour from now is still inside the alert's six-hour life, and the manager
	 * can only keep holding it if this rejects.
	 */
	it("rejects when there is no registered device to deliver to", async () => {
		const devices = {
			list: async () => [],
			setFcmToken: async () => {},
		} as unknown as DeviceStore;
		const presence = {
			present: () => ({
				present: false,
				reason: "no-signal" as const,
				humanInputAgeMs: null,
				beaconAgeMs: null,
				idleSeconds: null,
				locked: null,
			}),
		} as unknown as PresenceStore;
		const sender = createPushSender({
			serviceAccountPath: "/nonexistent/fcm-service-account.json",
			devices,
			presence,
			fence: null,
			fireVerdict: () => "fire",
			isCuratedOff: () => false,
			resolveAlertContext: null,
			verifyOrphanResolved: null,
			onFault: () => {},
			now: () => 1_700_000_000_000,
		});
		try {
			await expect(
				sender.sendLifecycleAlert({
					alertId: "a".repeat(22),
					workspaceId: "w".repeat(22) as WorkspaceId,
					kind: "g",
					expiresAtMs: 1_700_000_100_000,
					terminalHandle: "t".repeat(22),
					outcomeAtMs: 1_700_000_000_000,
					resolveReadThroughAtMs: () => 0,
					context: null,
				}),
			).rejects.toThrow(/no registered device/);
		} finally {
			sender.stop();
		}
	});
});

describe("ready alert delivery through the real sender", () => {
	const TOKEN_URI = "https://oauth2.example.test/token";
	const NOW = 1_700_000_000_000;
	const AWAY = {
		present: () => ({
			present: false,
			reason: "no-signal" as const,
			humanInputAgeMs: null,
			beaconAgeMs: null,
			idleSeconds: null,
			locked: null,
		}),
	} as unknown as PresenceStore;

	/**
	 * A sender whose only way out is `fetch`, answered by `fcm`. The service
	 * account is a throwaway key in a temp file; nothing reaches the network.
	 */
	async function withSender(
		deviceCount: number,
		fcm: (data: Record<string, string>) => Response,
		run: (
			sender: ReturnType<typeof createPushSender>,
			delivered: ReadonlyArray<Record<string, string>>,
		) => Promise<void>,
	): Promise<Array<Record<string, string>>> {
		const root = mkdtempSync(join(tmpdir(), "lifecycle-push-"));
		const serviceAccountPath = join(root, "fcm-service-account.json");
		const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
		writeFileSync(
			serviceAccountPath,
			JSON.stringify({
				type: "service_account",
				project_id: FCM_PROJECT_ID,
				private_key_id: "test-key",
				private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
				client_email: "push@test.invalid",
				token_uri: TOKEN_URI,
			}),
		);
		const devices = {
			list: async () =>
				Array.from({ length: deviceCount }, (_, index) => ({
					deviceId: `device-${index}`,
					fcmToken: `fcm-token-${index}`,
					revokedAtMs: null,
				})),
			setFcmToken: async () => {},
		} as unknown as DeviceStore;
		const delivered: Array<Record<string, string>> = [];
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (
			url: string | URL | Request,
			init?: RequestInit,
		) => {
			if (String(url) === TOKEN_URI) {
				return new Response(
					JSON.stringify({ access_token: "access-1", expires_in: 3_600 }),
					{ status: 200 },
				);
			}
			if (String(url) !== FCM_SEND_ENDPOINT) {
				throw new Error(`unexpected fetch ${String(url)}`);
			}
			const data = JSON.parse(String(init?.body)).message.data;
			delivered.push(data);
			return fcm(data);
		}) as typeof fetch;
		const sender = createPushSender({
			serviceAccountPath,
			devices,
			presence: AWAY,
			fence: null,
			fireVerdict: () => "fire",
			isCuratedOff: () => false,
			resolveAlertContext: null,
			verifyOrphanResolved: null,
			onFault: () => {},
			now: () => NOW,
		});
		try {
			await run(sender, delivered);
		} finally {
			sender.stop();
			globalThis.fetch = realFetch;
			rmSync(root, { recursive: true, force: true });
		}
		return delivered;
	}

	function readyAlert(resolveReadThroughAtMs: () => number) {
		return {
			alertId: "a".repeat(22),
			workspaceId: "w".repeat(22) as WorkspaceId,
			kind: "g" as const,
			expiresAtMs: NOW + 3_600_000,
			terminalHandle: "t".repeat(22),
			outcomeAtMs: NOW,
			resolveReadThroughAtMs,
			context: null,
		};
	}

	it("puts the read mark of the moment on each attempt's `rg`", async () => {
		let readMark = 0;
		let fcmCalls = 0;
		const delivered = await withSender(
			1,
			() => {
				fcmCalls += 1;
				if (fcmCalls > 1) return new Response("{}", { status: 200 });
				// The read lands while this attempt backs off; `retry-after: 0`
				// keeps the backoff from being a real wait.
				readMark = 1_700_000_000_500;
				return new Response(
					JSON.stringify({ error: { status: "UNAVAILABLE" } }),
					{
						status: 503,
						headers: { "retry-after": "0" },
					},
				);
			},
			async (sender) => {
				await sender.sendLifecycleAlert(readyAlert(() => readMark));
			},
		);
		expect(delivered.map((data) => [data.v, data.i, data.rg])).toEqual([
			["4", "a".repeat(22), ""],
			["4", "a".repeat(22), "1700000000500"],
		]);
	});

	it("counts a copy one device took as sent, so a later read takes it down", async () => {
		const stopAt = NOW - 1_000;
		let readCalls = 0;
		const alertSends: Promise<void>[] = [];
		const retractions: Promise<void>[] = [];
		const delivered = await withSender(
			2,
			() => new Response("{}", { status: 200 }),
			async (sender, posted) => {
				const manager = createLifecycleAlertManager({
					presence: AWAY,
					// Both sends start synchronously inside the manager call that
					// causes them, so the test awaits each one directly.
					push: {
						sendLifecycleAlert: (alert) => {
							const sent = sender.sendLifecycleAlert(alert);
							alertSends.push(sent);
							return sent;
						},
						sendLifecycleRetraction: (retraction) => {
							const sent = sender.sendLifecycleRetraction(retraction);
							retractions.push(sent);
							return sent;
						},
					},
					workspaceHandle: () => "w".repeat(22) as WorkspaceId,
					terminalHandle: () => "t".repeat(22),
					isCuratedOff: () => false,
					curatedOffAmong: () => new Set<string>(),
					resolveContext: null,
					restartEvidence: null,
					readySettleMs: 0,
					// The first read validates the frame; the next two are one per
					// device, and the second device's read throws.
					reads: {
						readThroughAt: () => {
							readCalls += 1;
							if (readCalls === 3) throw new Error("host.db is locked");
							return 0;
						},
						advance: () => {},
					},
					logger: { info: () => {}, warn: () => {}, error: () => {} },
					now: () => NOW,
				});
				try {
					manager.record({
						producerEventId: "p".repeat(22),
						outcome: "ready",
						eventType: "Stop",
						hostTerminalId: "terminal-1",
						hostWorkspaceId: "workspace-1",
						occurredAtMs: stopAt,
						previousEventType: "Start",
						previousEventAtMs: stopAt - 1_000,
					});
					expect(alertSends).toHaveLength(1);
					await alertSends[0];
					// The manager records the delivery after its own await of the
					// same promise.
					for (let i = 0; i < 10; i++) await Promise.resolve();
					expect(posted).toHaveLength(1);
					expect(readCalls).toBe(3);
					manager.markLifecycleRead({
						hostTerminalId: "terminal-1",
						hostWorkspaceId: "workspace-1",
						origin: "user",
						seenThroughAt: stopAt,
					});
					expect(retractions).toHaveLength(1);
					await Promise.all(retractions);
				} finally {
					manager.stop();
				}
			},
		);
		const alertId = delivered[0]?.i;
		expect(delivered.map((data) => [data.k, data.i])).toEqual([
			["g", alertId],
			["c", alertId],
			["c", alertId],
		]);
	});
});
