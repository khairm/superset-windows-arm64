import type {
	ClaudeAccountControlsChangedMessage,
	ClaudeAccountStateChangedMessage,
	ClaudeAccountWarningMessage,
} from "../events/types";

export const SENTINEL_REFRESH_TOKEN = "managed-by-usage-display-tray";

export interface ClaudeAccountsLogger {
	info(message: string, fields?: Record<string, unknown>): void;
	warn(message: string, fields?: Record<string, unknown>): void;
	error(message: string, fields?: Record<string, unknown>): void;
}

export type ClaudeAccountEvent =
	| ClaudeAccountStateChangedMessage
	| ClaudeAccountWarningMessage
	| ClaudeAccountControlsChangedMessage;

// (CLAUDE-ACCOUNT-SCHEDULE)
export type ClaudeScheduleTarget =
	| { kind: "account"; slug: string }
	| { kind: "default" };

/**
 * Retried every 30 s until `fireAt + 30 min`; expiry then records the last
 * one seen. `profile-unavailable`: the workspace's credentials file was empty
 * or unreadable when the switch captured it; the 60 s tick rewrites it.
 */
export const CLAUDE_SCHEDULE_RETRYABLE_FAILURES = [
	"target-unavailable",
	"pi-unavailable",
	"default-unavailable",
	"profile-unavailable",
] as const;

/** `not-run`: expired with no attempt result. `error`: failed at once. */
export const CLAUDE_SCHEDULE_FAILURES = [
	...CLAUDE_SCHEDULE_RETRYABLE_FAILURES,
	"not-run",
	"error",
] as const;

export type ClaudeScheduleRetryableFailure =
	(typeof CLAUDE_SCHEDULE_RETRYABLE_FAILURES)[number];
export type ClaudeScheduleFailure = (typeof CLAUDE_SCHEDULE_FAILURES)[number];

export type ClaudeScheduleView =
	| {
			status: "pending";
			scheduleId: string;
			target: ClaudeScheduleTarget;
			fireAt: number;
	  }
	| {
			status: "failed";
			scheduleId: string;
			target: ClaudeScheduleTarget;
			fireAt: number;
			failedAt: number;
			failure: ClaudeScheduleFailure;
			lastError: string | null;
	  };

export interface ClaudeAccountRosterEntry {
	slug: string;
	displayName: string;
	enabled: boolean;
	dead: boolean;
	deadReason: string | null;
	fivePct: number | null;
	sevenPct: number | null;
	fablePct: number | null;
	fiveResetsAt: string | null;
	sevenResetsAt: string | null;
	lastSuccess: string | null;
}

// (CLAUDE-ACCOUNT-IP-STATE)
export type ClaudeAccountIpState = "own" | "home" | "getting_ip" | "cut_off";

export interface PiAccount extends ClaudeAccountRosterEntry {
	type: "claude" | "codex";
	fableResetsAt: string | null;
	fableInUse: boolean;
	/** null for Codex accounts. */
	ipState: ClaudeAccountIpState | null;
}

export interface ClaudeAccessToken {
	account: string;
	accessToken: string;
	expiresAt: number;
	scopes?: string[];
	subscriptionType?: string;
	rateLimitTier?: string;
}

export interface ManagedCredentials {
	claudeAiOauth: {
		accessToken: string;
		expiresAt: number;
		refreshToken: typeof SENTINEL_REFRESH_TOKEN;
		scopes?: string[];
		subscriptionType?: string;
		rateLimitTier?: string;
	};
	trayManagedAccount: string | null;
}

export type GlobalIdentity =
	| { kind: "absent" }
	| { kind: "tray"; slug: string; credentials: ManagedCredentials }
	| { kind: "unmanaged"; credentials: ManagedCredentials };
