import { describe, expect, it } from "bun:test";
import { FallbackPolicy } from "./fallback";
import type { ClaudeAccountsLogger, PiAccount } from "./types";

const log: ClaudeAccountsLogger = {
	info() {},
	warn() {},
	error() {},
};

function account(overrides: Partial<PiAccount> = {}): PiAccount {
	return {
		slug: "pinned",
		displayName: "Pinned",
		type: "claude",
		enabled: true,
		dead: false,
		deadReason: null,
		lastSuccess: new Date(1_000_000).toISOString(),
		fivePct: 0,
		sevenPct: 0,
		fablePct: 0,
		fiveResetsAt: null,
		sevenResetsAt: null,
		fableResetsAt: null,
		fableInUse: false,
		...overrides,
	};
}

const triggers = { five: 99, seven: 99 };

describe("FallbackPolicy", () => {
	it("stands down on stale data even when the account is dead", () => {
		const policy = new FallbackPolicy(log);
		expect(
			policy.evaluate(
				account({ dead: true, lastSuccess: new Date(0).toISOString() }),
				triggers,
				31 * 60 * 1000,
			),
		).toEqual({
			action: "suppress",
			reason: "account usage data is missing or older than 30 minutes",
		});
	});

	it("suppresses fallback when current credentials need re-login", () => {
		const policy = new FallbackPolicy(log);
		expect(
			policy.evaluate(account({ dead: true }), triggers, 1_000_000),
		).toEqual({
			action: "suppress",
			reason: "pinned account credentials need re-login",
		});
	});

	it("treats a percentage as zero after its reset passes", () => {
		const policy = new FallbackPolicy(log);
		expect(
			policy.evaluate(
				account({
					fivePct: 100,
					fiveResetsAt: new Date(999_999).toISOString(),
				}),
				triggers,
				1_000_000,
			).action,
		).toBe("suppress");
	});

	it("uses the weekly trigger for active Fable work only", () => {
		const policy = new FallbackPolicy(log);
		expect(
			policy.evaluate(account({ fablePct: 99 }), triggers, 1_000_000).action,
		).toBe("suppress");
		expect(
			policy.evaluate(
				account({ fablePct: 99, fableInUse: true }),
				triggers,
				1_000_000,
			),
		).toEqual({
			action: "fallback",
			reason: "Fable weekly usage 99% crossed tray line 99%",
		});
	});
});
