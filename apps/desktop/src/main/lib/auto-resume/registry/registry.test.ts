// (AUTO-RESUME) registry state-machine tests (pure transitions).
import { describe, expect, test } from "bun:test";
import {
	afterSend,
	afterTransientFailure,
	applyReschedule,
	backoffDelayMs,
	decideFire,
	MAX_SENDS,
	MAX_TRANSPORT_FAILURES,
	type ResumeEntry,
	WALLCLOCK_BUDGET_MS,
} from "./registry";

function entry(over: Partial<ResumeEntry> = {}): ResumeEntry {
	return {
		failureId: "s1:f.jsonl:100",
		sessionId: "s1",
		transcriptPath: "/x/f.jsonl",
		offset: 100,
		failureClass: "server_error",
		resumeAtMs: 1000,
		sentCount: 0,
		rescheduleCount: 0,
		transportFailureCount: 0,
		state: "armed",
		...over,
	};
}

describe("backoffDelayMs — 60/180/540/1620/4860s", () => {
	test("escalation", () => {
		expect([0, 1, 2, 3, 4].map(backoffDelayMs)).toEqual([
			60_000, 180_000, 540_000, 1_620_000, 4_860_000,
		]);
	});
});

describe("decideFire", () => {
	test("waits before resumeAtMs", () => {
		expect(decideFire(entry({ resumeAtMs: 5000 }), 1000)).toEqual({
			action: "wait",
		});
	});
	test("fires at/after resumeAtMs", () => {
		expect(decideFire(entry({ resumeAtMs: 1000 }), 1000)).toEqual({
			action: "fire",
		});
	});
	test("gives up past the 5-send cap", () => {
		expect(decideFire(entry({ sentCount: MAX_SENDS }), 9e9)).toEqual({
			action: "giveUp",
		});
	});
	test("gives up past the 24h RETRY budget (runs from first send)", () => {
		expect(
			decideFire(
				entry({ firstSendAt: 0, resumeAtMs: 0 }),
				WALLCLOCK_BUDGET_MS + 1,
			),
		).toEqual({ action: "giveUp" });
	});
	test("does NOT give up while waiting for a far-future scheduled reset", () => {
		// Weekly reset days out, no send yet (firstSendAt undefined): must keep waiting,
		// not give up at the 24h mark. This is the headline weekly-limit case.
		const threeDays = 3 * 24 * 60 * 60 * 1000;
		expect(
			decideFire(entry({ resumeAtMs: threeDays }), WALLCLOCK_BUDGET_MS + 1),
		).toEqual({ action: "wait" });
	});
	test("non-armed waits", () => {
		expect(decideFire(entry({ state: "sent" }), 9e9)).toEqual({
			action: "wait",
		});
	});
});

describe("afterSend", () => {
	test("schedules the next escalation step and stays armed", () => {
		const e = afterSend(entry({ sentCount: 0 }), 1_000_000);
		expect(e.sentCount).toBe(1);
		expect(e.state).toBe("armed");
		expect(e.firstSendAt).toBe(1_000_000); // budget anchor set on first send
		// next gap is backoffDelayMs(1)=180s plus deterministic jitter (<120s)
		expect(e.resumeAtMs).toBeGreaterThanOrEqual(1_000_000 + 180_000);
		expect(e.resumeAtMs).toBeLessThan(1_000_000 + 180_000 + 120_000);
	});
	test("gives up after the 5th send", () => {
		const e = afterSend(entry({ sentCount: MAX_SENDS - 1 }), 1000);
		expect(e.sentCount).toBe(MAX_SENDS);
		expect(e.state).toBe("gaveUp");
	});
});

describe("applyReschedule", () => {
	test("reschedules to the new reset time", () => {
		const e = applyReschedule(entry({ rescheduleCount: 0 }), 5_000_000, 1000);
		expect(e.state).toBe("armed");
		expect(e.resumeAtMs).toBeGreaterThanOrEqual(5_000_000);
	});
	test("gives up past the reschedule cap", () => {
		const e = applyReschedule(entry({ rescheduleCount: 3 }), 5_000_000, 1000);
		expect(e.state).toBe("gaveUp");
	});
});

describe("afterTransientFailure", () => {
	test("bumps the durable counter and stays armed below the cap", () => {
		const e = afterTransientFailure(entry({ transportFailureCount: 0 }));
		expect(e.transportFailureCount).toBe(1);
		expect(e.state).toBe("armed");
	});
	test("gives up loudly at the cap (survives restart via the persisted field)", () => {
		const e = afterTransientFailure(
			entry({ transportFailureCount: MAX_TRANSPORT_FAILURES - 1 }),
		);
		expect(e.state).toBe("gaveUp");
	});
});
