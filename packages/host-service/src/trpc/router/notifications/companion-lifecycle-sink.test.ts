import { afterEach, describe, expect, it } from "bun:test";
import {
	forwardCompanionLifecycle,
	setCompanionLifecycleSink,
} from "./companion-lifecycle-sink";

afterEach(() => setCompanionLifecycleSink(null));

describe("companion lifecycle sink", () => {
	it("forwards only inputs carrying both validated lifecycle fields", () => {
		const received: unknown[] = [];
		setCompanionLifecycleSink({ record: (input) => received.push(input) });
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
		expect(received).toHaveLength(1);
		expect(received[0]).toMatchObject({
			outcome: "failed",
			eventType: "Failed",
			previousEventType: "Start",
			previousEventAtMs: 90,
		});
	});
});
