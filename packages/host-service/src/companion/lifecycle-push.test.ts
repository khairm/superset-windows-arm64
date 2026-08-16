import { describe, expect, it } from "bun:test";
import type { DeviceStore } from "./device-store";
import type { PresenceStore } from "./presence";
import {
	assertPushDataSafe,
	buildLifecyclePushData,
	createPushSender,
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
					context: null,
				}),
			).rejects.toThrow(/no registered device/);
		} finally {
			sender.stop();
		}
	});
});
