// (AUTO-RESUME) Classify a terminal API failure into a resume policy.
//
// Validated against the real on-disk corpus (12,810 Claude jsonl / 1,779 error records;
// 7,219 Codex rollouts) via tmp/scan_api_failures.py + tmp/probe_codex_events.py.
//
// Contract: DENY-LIST FIRST (auth / policy / bad-image / model-unavailable can never be
// auto-resumed), THEN the ALLOW-LIST. Order mirrors the validated scan precedence. We act
// on an allow-list: anything unrecognized defaults to non-resumable (notify only).

export type FailureClass =
	| "rate_limit_resume"
	| "rate_limit_transient"
	| "half_stop"
	| "server_error"
	| "connection_drop"
	| "auth"
	| "invalid_request"
	| "model_unavailable"
	| "other";

export type ResumeMode = "schedule" | "backoff" | "none";

export interface ResetTextRef {
	timeText: string;
	tz: string; // IANA tz; empty string when the source carries none (Codex)
}

export interface Classification {
	resumable: boolean;
	class: FailureClass;
	mode: ResumeMode;
	reset?: ResetTextRef;
}

export interface ClaudeFailureInput {
	error?: string | null;
	apiErrorStatus?: number | null;
	text: string; // message.content[0].text
}

const lc = (s: string) => s.toLowerCase();
const has = (text: string, needles: string[]): boolean => {
	const t = lc(text);
	return needles.some((n) => t.includes(n));
};

// --- reset-time extraction (Claude) ---------------------------------------
const RESET_WEEKLY =
	/resets\s+([A-Z][a-z]{2}\s+\d{1,2},\s*\d{1,2}(?::\d{2})?\s*[ap]m)\s*\(([^)]+)\)/i;
const RESET_SESSION = /resets\s+(\d{1,2}(?::\d{2})?\s*[ap]m)\s*\(([^)]+)\)/i;

export function extractClaudeReset(text: string): ResetTextRef | undefined {
	const weekly = RESET_WEEKLY.exec(text);
	if (weekly) return { timeText: weekly[1], tz: weekly[2] };
	const session = RESET_SESSION.exec(text);
	if (session) return { timeText: session[1], tz: session[2] };
	return undefined;
}

// --- non-resumable (deny-list) signatures ---------------------------------
const AUTH_TEXT = [
	"not logged in",
	"invalid authentication credentials",
	"please run /login",
];
const POLICY_TEXT = [
	"usage policy",
	"requires usage credits",
	"could not be processed", // image removed
	"exceeds the dimension limit",
	"it may not exist or you may not have access",
];
const MODEL_UNAVAILABLE_TEXT = ["currently unavailable"];

// --- resumable (allow-list) signatures ------------------------------------
const HALF_STOP_TEXT = [
	"mid-response",
	"partial response",
	"idle timeout",
	"may be incomplete",
];
const TRANSIENT_TEXT = ["temporarily limiting", "not your usage limit"];
const CONN_TEXT = [
	"unable to connect",
	"econnreset",
	"connectionrefused",
	"failedtoopensocket",
	"socket connection was closed",
];

const SERVER_STATUS = new Set([500, 502, 503, 529]);
const INVALID_STATUS = new Set([400, 404, 413, 422]);

const nonResumable = (cls: FailureClass): Classification => ({
	resumable: false,
	class: cls,
	mode: "none",
});

/**
 * Classify a Claude API-error record. Caller must have already confirmed (via the
 * StopFailure anchor + last-meaningful-line check) that this is a turn-ENDING failure.
 */
export function classifyClaudeFailure(
	input: ClaudeFailureInput,
): Classification {
	const error = input.error ?? null;
	const status = input.apiErrorStatus ?? null;
	const text = input.text ?? "";

	// 1) DENY-LIST FIRST — never auto-resume these.
	if (
		error === "authentication_failed" ||
		status === 401 ||
		has(text, AUTH_TEXT)
	) {
		return nonResumable("auth");
	}
	if (error === "rate_limit" && has(text, MODEL_UNAVAILABLE_TEXT)) {
		return nonResumable("model_unavailable");
	}
	if (has(text, POLICY_TEXT)) {
		return nonResumable("invalid_request");
	}
	if (
		error === "invalid_request" ||
		(status !== null && INVALID_STATUS.has(status))
	) {
		return nonResumable("invalid_request");
	}

	// 2) ALLOW-LIST (validated scan precedence).
	if (has(text, HALF_STOP_TEXT)) {
		return { resumable: true, class: "half_stop", mode: "backoff" };
	}
	if (error === "rate_limit") {
		if (has(text, TRANSIENT_TEXT)) {
			// Not auto-retried by Claude; the turn stalls (user-confirmed). No reset time.
			return {
				resumable: true,
				class: "rate_limit_transient",
				mode: "backoff",
			};
		}
		const reset = extractClaudeReset(text);
		if (reset) {
			return {
				resumable: true,
				class: "rate_limit_resume",
				mode: "schedule",
				reset,
			};
		}
		// rate_limit with neither transient text nor a parseable reset => don't gamble.
		return nonResumable("other");
	}
	if (has(text, CONN_TEXT)) {
		return { resumable: true, class: "connection_drop", mode: "backoff" };
	}
	if (
		error === "server_error" ||
		(status !== null && SERVER_STATUS.has(status))
	) {
		return { resumable: true, class: "server_error", mode: "backoff" };
	}

	return nonResumable("other");
}

// --- Codex (NOTIFY-ONLY in v1) --------------------------------------------
// The ONLY genuine standalone signal is the exact phrase inside an errored
// <subagent_notification>. Requiring this literal phrase makes the 2,897 corpus
// code-lines that merely contain "rate limit"/"usage limit" impossible to match.
const CODEX_USAGE_LIMIT = /you'?ve hit your usage limit/i;
const CODEX_RETRY_TIME = /try again (?:after|at)\s+([^."]+?)\s*\./i;

export interface CodexClassification extends Classification {
	class: "rate_limit_resume" | "other";
}

/**
 * Classify a Codex usage-limit notification. `text` must already be scoped by the caller
 * to a structured `response_item`/`message`/role==user record carrying a
 * `<subagent_notification>` with `status.errored` — NEVER a raw rollout-line scan.
 * tz is the machine-local IANA zone (Codex prose carries none).
 */
export function classifyCodexUsageLimit(
	text: string,
	machineTz: string,
): CodexClassification | null {
	if (!text.includes("<subagent_notification>")) return null;
	if (!CODEX_USAGE_LIMIT.test(text)) return null;
	const m = CODEX_RETRY_TIME.exec(text);
	if (m) {
		return {
			resumable: true,
			class: "rate_limit_resume",
			mode: "schedule",
			reset: { timeText: m[1].trim(), tz: machineTz },
		};
	}
	return { resumable: true, class: "other", mode: "backoff" };
}
