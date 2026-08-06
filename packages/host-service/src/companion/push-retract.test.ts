import { describe, expect, it } from "bun:test";
import { RETRACT_TTL_MS } from "./config";
import { buildRetractPushData } from "./push";
import type { QuestionId, WorkspaceId } from "./types";

const QUESTION = "q-1" as QuestionId;
const WORKSPACE = "w-1" as WorkspaceId;

/**
 * (RETRACT-TTL) The client applies `x` BEFORE it switches on `k`, so these are
 * assertions about whether a retraction is readable at all — not about
 * formatting.
 */
describe("(RETRACT-TTL) buildRetractPushData", () => {
	it("stamps an expiry in the FUTURE — a retraction stamped with `now` is discarded by the client's isExpired check before it ever reaches the retract branch", () => {
		const nowMs = 1_800_000_000_000;
		const data = buildRetractPushData({
			questionId: QUESTION,
			workspaceId: WORKSPACE,
			nowMs,
		});
		expect(Number(data.x)).toBe(nowMs + RETRACT_TTL_MS);
		expect(Number(data.x)).toBeGreaterThan(nowMs);
	});

	it("outlives a phone that was off the network for a working day", () => {
		// The delivery delay the constant is sized against: powered down, in Doze,
		// or out of coverage while the question was answered at the desk.
		expect(RETRACT_TTL_MS).toBeGreaterThanOrEqual(12 * 60 * 60 * 1000);
	});

	it("still identifies the notification the client is holding", () => {
		const data = buildRetractPushData({
			questionId: QUESTION,
			workspaceId: WORKSPACE,
			nowMs: 1_800_000_000_000,
		});
		expect(data).toMatchObject({
			v: "1",
			k: "r",
			i: QUESTION,
			w: WORKSPACE,
			n: "0",
		});
	});

	it("refuses a non-epoch `nowMs` rather than minting `NaN` into the expiry", () => {
		expect(() =>
			buildRetractPushData({
				questionId: QUESTION,
				workspaceId: WORKSPACE,
				nowMs: Number.NaN,
			}),
		).toThrow();
	});
});
