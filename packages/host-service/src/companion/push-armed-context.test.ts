/**
 * (ALERT-CONTEXT-NAMES) The RAW host ids a question push carries from arm to
 * fire — including across a restart.
 *
 * The push's own `workspaceId` is the DERIVED opaque handle, which is exactly
 * what must not be used to look a name up. These tests pin that the raw ids
 * survive both the ordinary path and fence reconstruction, and that the fire
 * path asks about them at FIRE time rather than at arm time.
 */

import { describe, expect, it } from "bun:test";
import type { DeviceStore } from "./device-store";
import type { PresenceStore } from "./presence";
import { createPushSender } from "./push";
import type { PushAlertContext } from "./push-context";
import type { PushFence, PushFenceRecord } from "./push-fence";
import type { QuestionId, WorkspaceId } from "./types";

const NOW = 1_700_000_000_000;
const QUESTION = "q".repeat(22) as QuestionId;
const HANDLE = "w".repeat(22) as WorkspaceId;
const TERMINAL_HANDLE = "t".repeat(22);

/** Away, always: the fire path is the thing under test, not presence. */
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

/** No device: `broadcast` returns before any envelope is built, which is fine —
 * every assertion here is about what the sender ASKED, not what it sent. */
const NO_DEVICES = {
	list: async () => [],
	setFcmToken: async () => {},
} as unknown as DeviceStore;

function fenceHolding(records: PushFenceRecord[]): PushFence {
	return {
		load: () => records,
		arm: () => {},
		markSent: () => {},
		clear: () => {},
	};
}

function armedRecord(
	overrides: Partial<PushFenceRecord> = {},
): PushFenceRecord {
	return {
		questionId: QUESTION,
		workspaceId: HANDLE,
		questionCount: 1,
		expiresAtMs: NOW + 3_600_000,
		armedAtMs: NOW - 1_000,
		state: "armed",
		sentAtMs: null,
		hostTerminalId: "terminal-1",
		hostWorkspaceId: "workspace-1",
		transcriptPath: null,
		toolUseId: null,
		...overrides,
	};
}

/** A second, unrelated question — the cheapest way to run one `evaluate`. */
function unrelatedQuestion() {
	return {
		questionId: "z".repeat(22) as QuestionId,
		workspaceId: HANDLE,
		questionCount: 1,
		expiresAtMs: NOW + 3_600_000,
		hostTerminalId: "terminal-9",
		hostWorkspaceId: "workspace-9",
		transcriptPath: null,
		toolUseId: null,
	};
}

function setup(
	options: { fence?: PushFence | null; context?: PushAlertContext | null } = {},
) {
	const asked: Array<{
		hostTerminalId: string | null;
		hostWorkspaceId: string | null;
	}> = [];
	const sender = createPushSender({
		serviceAccountPath: "/nonexistent/fcm-service-account.json",
		devices: NO_DEVICES,
		presence: AWAY,
		fence: options.fence ?? null,
		fireVerdict: () => "fire",
		isCuratedOff: () => false,
		resolveAlertContext: (input) => {
			asked.push(input);
			return options.context ?? null;
		},
		verifyOrphanResolved: null,
		onFault: () => {},
		now: () => NOW,
	});
	return { sender, asked };
}

describe("(ALERT-CONTEXT-NAMES) a question push keeps its raw host ids", () => {
	it("asks about the ids it was armed with, at fire time", () => {
		const { sender, asked } = setup();
		try {
			sender.schedule({
				questionId: QUESTION,
				workspaceId: HANDLE,
				questionCount: 1,
				expiresAtMs: NOW + 3_600_000,
				hostTerminalId: "terminal-1",
				hostWorkspaceId: "workspace-1",
				transcriptPath: null,
				toolUseId: null,
			});
			// `schedule` evaluates presence inline, so an away user fires on the spot.
			expect(asked).toEqual([
				{ hostTerminalId: "terminal-1", hostWorkspaceId: "workspace-1" },
			]);
		} finally {
			sender.stop();
		}
	});

	it("keeps them through FENCE RECONSTRUCTION, so a restart still names the chat", () => {
		// Reconstruction used to drop both ids on the floor: the row carried them
		// (they have been persisted since PUSH-ARMED-ORPHAN) and the rebuilt entry
		// simply had nowhere to put them, so every push held across a restart
		// buzzed with generic wording.
		const { sender, asked } = setup({
			fence: fenceHolding([armedRecord()]),
		});
		try {
			// A reconstructed entry fires on the ordinary away sweep. Arming an
			// unrelated question runs that evaluation inline, which is the same code
			// path a tick would take without waiting two seconds for one.
			sender.schedule(unrelatedQuestion());
			expect(asked).toContainEqual({
				hostTerminalId: "terminal-1",
				hostWorkspaceId: "workspace-1",
			});
		} finally {
			sender.stop();
		}
	});

	it("fires with NO ids rather than not at all, for a pre-upgrade fence row", () => {
		const { sender, asked } = setup({
			fence: fenceHolding([
				armedRecord({ hostTerminalId: null, hostWorkspaceId: null }),
			]),
		});
		try {
			sender.schedule(unrelatedQuestion());
			expect(asked).toContainEqual({
				hostTerminalId: null,
				hostWorkspaceId: null,
			});
		} finally {
			sender.stop();
		}
	});

	it("still fires when the resolver THROWS", () => {
		const sender = createPushSender({
			serviceAccountPath: "/nonexistent/fcm-service-account.json",
			devices: NO_DEVICES,
			presence: AWAY,
			fence: null,
			fireVerdict: () => "fire",
			isCuratedOff: () => false,
			resolveAlertContext: () => {
				throw new Error("host.db is locked");
			},
			verifyOrphanResolved: null,
			onFault: () => {},
			now: () => NOW,
		});
		try {
			expect(() =>
				sender.schedule({
					questionId: QUESTION,
					workspaceId: HANDLE,
					questionCount: 1,
					expiresAtMs: NOW + 3_600_000,
					hostTerminalId: "terminal-1",
					hostWorkspaceId: "workspace-1",
					transcriptPath: null,
					toolUseId: null,
				}),
			).not.toThrow();
			// It committed the entry to `sent`, which is the fact that proves the
			// resolver's failure did not cost the buzz.
			expect(sender.inspect().sent).toEqual([QUESTION]);
		} finally {
			sender.stop();
		}
	});

	it("never asks when the resolver is disabled", () => {
		const sender = createPushSender({
			serviceAccountPath: "/nonexistent/fcm-service-account.json",
			devices: NO_DEVICES,
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
			expect(() =>
				sender.schedule({
					questionId: QUESTION,
					workspaceId: HANDLE,
					questionCount: 1,
					expiresAtMs: NOW + 3_600_000,
					hostTerminalId: "terminal-1",
					hostWorkspaceId: "workspace-1",
					transcriptPath: null,
					toolUseId: null,
				}),
			).not.toThrow();
			expect(sender.inspect().sent).toEqual([QUESTION]);
		} finally {
			sender.stop();
		}
	});
});

describe("(ALERT-CONTEXT-NAMES) sendLifecycleRetraction is best effort", () => {
	it("resolves even with no device to deliver to", async () => {
		const { sender } = setup();
		try {
			// The alert path REJECTS here on purpose (its caller holds and retries);
			// a retraction has no such caller, so it must resolve.
			await sender.sendLifecycleRetraction({
				alertId: "a".repeat(22),
				workspaceId: HANDLE,
				terminalHandle: TERMINAL_HANDLE,
				outcomeAtMs: 1_700_000_000_000,
			});
		} finally {
			sender.stop();
		}
	});

	it("throws at the CALL SITE for a malformed id, not from inside a chain", () => {
		const { sender } = setup();
		try {
			expect(() =>
				sender.sendLifecycleRetraction({
					alertId: "not an alert id",
					workspaceId: HANDLE,
					terminalHandle: TERMINAL_HANDLE,
					outcomeAtMs: 1_700_000_000_000,
				}),
			).toThrow(/22 base64url/);
		} finally {
			sender.stop();
		}
	});
});
