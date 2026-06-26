// (AUTO-RESUME) classifier tests — real corpus templates + Codex false-positive guard.
import { describe, expect, test } from "bun:test";
import {
	classifyClaudeFailure,
	classifyCodexUsageLimit,
	extractClaudeReset,
} from "./classifier";

describe("classifyClaudeFailure — resumable", () => {
	test("rate_limit_resume (session)", () => {
		const c = classifyClaudeFailure({
			error: "rate_limit",
			apiErrorStatus: 429,
			text: "You've hit your session limit · resets 3:30am (Europe/London)",
		});
		expect(c).toMatchObject({
			resumable: true,
			class: "rate_limit_resume",
			mode: "schedule",
		});
		expect(c.reset).toEqual({ timeText: "3:30am", tz: "Europe/London" });
	});
	test("rate_limit_resume (weekly)", () => {
		const c = classifyClaudeFailure({
			error: "rate_limit",
			apiErrorStatus: 429,
			text: "You've hit your weekly limit · resets Jun 17, 1am (Europe/London)",
		});
		expect(c.reset).toEqual({ timeText: "Jun 17, 1am", tz: "Europe/London" });
	});
	test("rate_limit_transient -> backoff", () => {
		const c = classifyClaudeFailure({
			error: "rate_limit",
			apiErrorStatus: 429,
			text: "API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited",
		});
		expect(c).toMatchObject({
			resumable: true,
			class: "rate_limit_transient",
			mode: "backoff",
		});
	});
	test("half_stop (idle timeout)", () => {
		const c = classifyClaudeFailure({
			error: "unknown",
			apiErrorStatus: null,
			text: "API Error: Stream idle timeout - partial response received",
		});
		expect(c).toMatchObject({ resumable: true, class: "half_stop" });
	});
	test("half_stop (mid-response)", () => {
		const c = classifyClaudeFailure({
			error: "server_error",
			apiErrorStatus: null,
			text: "API Error: Connection closed mid-response. The response above may be incomplete.",
		});
		expect(c).toMatchObject({ resumable: true, class: "half_stop" });
	});
	test("server_error 529 Overloaded", () => {
		const c = classifyClaudeFailure({
			error: "server_error",
			apiErrorStatus: 529,
			text: "API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment.",
		});
		expect(c).toMatchObject({
			resumable: true,
			class: "server_error",
			mode: "backoff",
		});
	});
	test("connection_drop ECONNRESET", () => {
		const c = classifyClaudeFailure({
			error: "unknown",
			apiErrorStatus: null,
			text: "API Error: Unable to connect to API (ECONNRESET)",
		});
		expect(c).toMatchObject({ resumable: true, class: "connection_drop" });
	});
});

describe("classifyClaudeFailure — non-resumable (deny-list)", () => {
	test("auth not logged in", () => {
		expect(
			classifyClaudeFailure({
				error: "authentication_failed",
				apiErrorStatus: 401,
				text: "Not logged in · Please run /login",
			}),
		).toMatchObject({ resumable: false, class: "auth" });
	});
	test("usage policy violation", () => {
		expect(
			classifyClaudeFailure({
				error: "invalid_request",
				apiErrorStatus: null,
				text: "API Error: Claude Code is unable to respond to this request, which appears to violate our Usage Policy",
			}),
		).toMatchObject({ resumable: false, class: "invalid_request" });
	});
	test("bad image removed", () => {
		expect(
			classifyClaudeFailure({
				error: "invalid_request",
				apiErrorStatus: null,
				text: "API Error: an image in the conversation could not be processed and was removed.",
			}),
		).toMatchObject({ resumable: false });
	});
	test("model unavailable (Fable)", () => {
		expect(
			classifyClaudeFailure({
				error: "rate_limit",
				apiErrorStatus: null,
				text: "Claude Fable 2 is currently unavailable. Learn more: ...",
			}),
		).toMatchObject({ resumable: false, class: "model_unavailable" });
	});
	test("model policy credits", () => {
		expect(
			classifyClaudeFailure({
				error: null,
				apiErrorStatus: null,
				text: "Your model policy only allows Fable 2, which requires usage credits",
			}),
		).toMatchObject({ resumable: false });
	});
});

describe("extractClaudeReset", () => {
	test("weekly beats session", () => {
		expect(extractClaudeReset("resets Jun 17, 1am (Europe/London)")).toEqual({
			timeText: "Jun 17, 1am",
			tz: "Europe/London",
		});
	});
});

describe("classifyCodexUsageLimit — structural, FP-safe", () => {
	const TZ = "Europe/London";
	test("genuine errored notification with clock time", () => {
		const text =
			'<subagent_notification>\n{"status":{"errored":"You\'ve hit your usage limit. Visit https://chatgpt.com/codex/settings/usage or try again after 1:08 PM."}}';
		const c = classifyCodexUsageLimit(text, TZ);
		expect(c).toMatchObject({ resumable: true, class: "rate_limit_resume" });
		expect(c?.reset?.timeText).toBe("1:08 PM");
	});
	test("genuine errored notification with dated time", () => {
		const text =
			'<subagent_notification>{"status":{"errored":"You\'ve hit your usage limit. Try again at May 31st, 2026 12:58 AM."}}';
		const c = classifyCodexUsageLimit(text, TZ);
		expect(c?.reset?.timeText).toBe("May 31st, 2026 12:58 AM");
	});
	test("does NOT match source code mentioning rate limit (the 2897-FP guard)", () => {
		const codeLines = [
			'log.warning(f"get_support_tickets_for_homes: pagination limit reached, user={user_email}")',
			"# Rate-limit charging stays on the caller so BG retries",
			'except ZendeskRateLimitError as e: log.error(f"Zendesk 429 retry_after={e.retry_after}s")',
			"USER_RATE_LIMIT_PER_MIN = 60  # Per-user rate limit",
			'rg -n "rate limit|usage limit|retry after" server_code',
		];
		for (const line of codeLines) {
			expect(classifyCodexUsageLimit(line, TZ)).toBeNull();
		}
	});
	test("requires the literal usage-limit phrase even inside a notification", () => {
		expect(
			classifyCodexUsageLimit(
				'<subagent_notification>{"status":{"errored":"some other error"}}',
				TZ,
			),
		).toBeNull();
	});
});
