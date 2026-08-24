import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseTrayTriggers, type TrayTriggers } from "./tray-state-schema";
import type { ClaudeAccountsLogger, PiAccount } from "./types";

const DATA_FRESH_MS = 30 * 60 * 1000;

export type { TrayTriggers } from "./tray-state-schema";

export type FallbackEvaluation =
	| { action: "fallback"; reason: string }
	| { action: "suppress"; reason: string };

export class FallbackPolicy {
	readonly trayStatePath = join(homedir(), ".usage-display", "tray-state.json");

	constructor(private readonly log: ClaudeAccountsLogger) {}

	async readTriggers(): Promise<TrayTriggers | null> {
		let text: string;
		try {
			text = await readFile(this.trayStatePath, "utf8");
		} catch (error) {
			this.log.info(
				"Claude account auto-fallback suppressed: tray state unavailable",
				{
					path: this.trayStatePath,
					error,
				},
			);
			return null;
		}
		let raw: unknown;
		try {
			raw = JSON.parse(text);
		} catch (error) {
			this.log.warn(
				"Claude account auto-fallback suppressed: tray state is invalid JSON",
				{
					path: this.trayStatePath,
					error,
				},
			);
			return null;
		}
		try {
			return parseTrayTriggers(raw);
		} catch (error) {
			this.log.warn(
				"Claude account auto-fallback suppressed: tray state failed validation",
				{ path: this.trayStatePath, error },
			);
			return null;
		}
	}

	evaluate(
		account: PiAccount,
		triggers: TrayTriggers,
		now = Date.now(),
	): FallbackEvaluation {
		if (!account.enabled) {
			return { action: "suppress", reason: "pinned account is disabled" };
		}
		const lastSuccess = account.lastSuccess
			? Date.parse(account.lastSuccess)
			: Number.NaN;
		if (!Number.isFinite(lastSuccess) || now - lastSuccess > DATA_FRESH_MS) {
			return {
				action: "suppress",
				reason: "account usage data is missing or older than 30 minutes",
			};
		}
		if (account.dead) {
			return {
				action: "suppress",
				reason: "pinned account credentials need re-login",
			};
		}
		const five = effectivePercentage(
			account.fivePct,
			account.fiveResetsAt,
			now,
		);
		const seven = effectivePercentage(
			account.sevenPct,
			account.sevenResetsAt,
			now,
		);
		const fable = effectivePercentage(
			account.fablePct,
			account.fableResetsAt,
			now,
		);
		if (five !== null && five >= triggers.five) {
			return {
				action: "fallback",
				reason: `5h usage ${five}% crossed tray line ${triggers.five}%`,
			};
		}
		if (seven !== null && seven >= triggers.seven) {
			return {
				action: "fallback",
				reason: `7d usage ${seven}% crossed tray line ${triggers.seven}%`,
			};
		}
		if (account.fableInUse && fable !== null && fable >= triggers.seven) {
			return {
				action: "fallback",
				reason: `Fable weekly usage ${fable}% crossed tray line ${triggers.seven}%`,
			};
		}
		return {
			action: "suppress",
			reason:
				five === null && seven === null
					? "account usage percentages are unavailable"
					: "account remains below tray trigger lines",
		};
	}
}

function effectivePercentage(
	percentage: number | null,
	resetAt: string | null,
	now: number,
): number | null {
	if (percentage === null) return null;
	if (resetAt) {
		const reset = Date.parse(resetAt);
		if (Number.isFinite(reset) && reset <= now) return 0;
	}
	return percentage;
}
