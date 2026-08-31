import { afterEach, describe, expect, it } from "bun:test";
import {
	forwardCompanionLifecycle,
	setCompanionLifecycleSink,
} from "./companion-lifecycle-sink";

afterEach(() => setCompanionLifecycleSink(null));

describe("companion lifecycle sink", () => {
	it("forwards only inputs carrying both validated lifecycle fields", () => {
		const received: unknown[] = [];
		const calls: string[] = [];
		setCompanionLifecycleSink({
			observeStatus: (terminalId, eventType) =>
				calls.push(`observe:${terminalId}:${eventType}`),
			record: (input) => {
				calls.push("record");
				received.push(input);
			},
		});
		forwardCompanionLifecycle({
			payload: {
				companionLifecycleEventId: "a".repeat(22),
				companionLifecycleOutcome: "failed",
			},
			eventType: "Failed",
			terminalId: "terminal-1",
			workspaceId: "workspace-1",
			occurredAtMs: 100,
			previousEventType: "Start",
			previousEventAtMs: 90,
		});
		forwardCompanionLifecycle({
			payload: { companionLifecycleEventId: "b".repeat(22) },
			eventType: "Stop",
			terminalId: "terminal-1",
			workspaceId: "workspace-1",
			occurredAtMs: 101,
			previousEventType: "Failed",
			previousEventAtMs: 100,
		});
		forwardCompanionLifecycle({
			payload: {},
			eventType: "SubagentActive",
			terminalId: "terminal-1",
			workspaceId: "workspace-1",
			occurredAtMs: 102,
			previousEventType: "Stop",
			previousEventAtMs: 101,
		});
		expect(calls).toEqual([
			"observe:terminal-1:Failed",
			"record",
			"observe:terminal-1:Stop",
			"observe:terminal-1:SubagentActive",
		]);
		expect(received).toHaveLength(1);
		expect(received[0]).toMatchObject({
			outcome: "failed",
			eventType: "Failed",
			previousEventType: "Start",
			previousEventAtMs: 90,
		});
	});

	// A swallowed fault here would let the caller's `recordEvent` bury the `Stop`
	// row this event was meant to retract against, losing the only durable
	// evidence of the alert. Both sink entry points must therefore propagate.
	it("propagates a record fault instead of swallowing it", () => {
		setCompanionLifecycleSink({
			observeStatus: () => {},
			record: () => {
				throw new Error("record exploded");
			},
		});

		expect(() =>
			forwardCompanionLifecycle({
				payload: {
					companionLifecycleEventId: "c".repeat(22),
					companionLifecycleOutcome: "progress",
				},
				eventType: "Start",
				terminalId: "terminal-1",
				workspaceId: "workspace-1",
				occurredAtMs: 200,
				previousEventType: "Stop",
				previousEventAtMs: 190,
			}),
		).toThrow("record exploded");
	});

	it("propagates an observeStatus fault, which is the immediate-retraction path", () => {
		setCompanionLifecycleSink({
			observeStatus: () => {
				throw new Error("observe exploded");
			},
			record: () => {},
		});

		expect(() =>
			forwardCompanionLifecycle({
				payload: {},
				eventType: "SubagentActive",
				terminalId: "terminal-1",
				workspaceId: "workspace-1",
				occurredAtMs: 200,
				previousEventType: "Stop",
				previousEventAtMs: 190,
			}),
		).toThrow("observe exploded");
	});
});
