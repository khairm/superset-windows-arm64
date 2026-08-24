import type {
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
	| ClaudeAccountWarningMessage;

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

export interface PiAccount extends ClaudeAccountRosterEntry {
	type: "claude" | "codex";
	fableResetsAt: string | null;
	fableInUse: boolean;
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
