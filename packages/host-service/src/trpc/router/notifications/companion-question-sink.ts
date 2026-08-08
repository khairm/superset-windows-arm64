/**
 * (COMPANION-CAPTURE) Delivery point for AskUserQuestion payloads captured by
 * the agent notify hook.
 *
 * WHY A REGISTERED SINK AND NOT `ctx`
 * -----------------------------------
 * `notifications.hook` is the only place in the host-service that sees a
 * question at the moment it is raised — the `PreToolUse` payload carries the
 * full text and options, and nothing downstream can recover it (the picker's
 * scrollback is lossy for anything longer than the window). The companion
 * bridge owns custody of that payload, but the bridge is composed separately
 * (`companion/index.ts` → `createCompanionBridge`) and is not wired into the
 * tRPC context. A module-level sink keeps the two independent: the hook route
 * has no idea whether a bridge exists, and the bridge does not have to reach
 * into the router.
 *
 * If no sink is registered, captures are dropped. That is the correct
 * behaviour for every build where the companion feature is not running, and it
 * is why the hook route must never depend on the sink's return value.
 *
 * IDS ARE THE HOST-SERVICE'S OWN, NOT THE BRIDGE'S
 * ------------------------------------------------
 * Everything here is internal: `hostTerminalId`, `workspaceId`, `sessionId`,
 * `toolUseId` and `transcriptPath` are the host-service's real handles.
 * PROTOCOL.md §0.1 requires the wire to carry bridge-minted opaque ids instead,
 * so translating these — and making sure `toolUseId` / `sessionId` /
 * `transcriptPath` never leave the process — is the BRIDGE's job, not this
 * file's.
 */

import { z } from "zod";
import { provenFreeTextRowLabel } from "../../../companion/keystrokes";
import {
	MAX_HEADER_CHARS,
	MAX_ID_CHARS,
	MAX_OPTION_DESCRIPTION_CHARS,
	MAX_OPTION_LABEL_CHARS,
	MAX_OPTIONS_PER_QUESTION,
	MAX_PATH_CHARS,
	MAX_QUESTION_TEXT_CHARS,
	MAX_QUESTIONS_PER_PROMPT,
} from "../../../companion/limits";
import type { QuestionItem } from "../../../companion/types";

/** One AskUserQuestion prompt, exactly as the PreToolUse hook delivered it. */
export interface CompanionQuestionCapture {
	/** Host-service terminal session id (internal; never sent to a client). */
	hostTerminalId: string;
	/** Host-service workspace id (internal). */
	workspaceId: string;
	/** Claude's tool_use_id (internal; part of the §7.4 fingerprint). */
	toolUseId: string;
	/** Claude's session_id (internal; part of the §7.4 fingerprint). */
	sessionId: string;
	/** Absolute path of the session transcript (internal; guard 1 reads it). */
	transcriptPath: string;
	/** The agent's cwd at the moment the question was raised. */
	cwd: string;
	/** Subagent id when a subagent asked; null on the main loop. */
	agentId: string | null;
	/** Subagent type when a subagent asked; null on the main loop. */
	agentType: string | null;
	askedAtMs: number;
	/**
	 * 1..N items. N > 1 is 59% of real traffic, so this is a list by default,
	 * never a single question with a "there might be more" flag.
	 */
	questions: QuestionItem[];
}

/** A question stopped being answerable from the phone — it was handled here. */
export interface CompanionQuestionResolution {
	hostTerminalId: string;
	toolUseId: string;
	resolvedAtMs: number;
}

export interface CompanionQuestionSink {
	/** A new AskUserQuestion is on screen. */
	capture(input: CompanionQuestionCapture): void;
	/**
	 * The question was answered (or otherwise closed) at the desk. Drives push
	 * retraction (§13.3): without this the phone keeps buzzing about a question
	 * the user already dealt with in front of them.
	 */
	resolve(input: CompanionQuestionResolution): void;
}

let sink: CompanionQuestionSink | null = null;

/**
 * Install the bridge's sink. Pass `null` on bridge shutdown.
 *
 * Replacing a live sink is a programming error — two owners of question custody
 * would both mint ids and both answer, which is the double-injection failure
 * PROTOCOL §11.4 exists to prevent. Fail loud instead of silently taking the
 * newer one.
 */
export function setCompanionQuestionSink(
	next: CompanionQuestionSink | null,
): void {
	if (next !== null && sink !== null) {
		throw new Error(
			"[companion-capture] a question sink is already registered; " +
				"unregister it (pass null) before installing another",
		);
	}
	sink = next;
}

export function getCompanionQuestionSink(): CompanionQuestionSink | null {
	return sink;
}

// ---------------------------------------------------------------------------
// (COMPANION-CAPTURE) the hook seam
//
// Everything below is the fork's half of `notifications.hook`: the wire schema
// for the two additive fields, the drop warning, and the forward. It lives HERE,
// in the fork-only file, rather than inside the upstream-owned router, so an
// upstream merge conflicts on a `.extend()` and four call lines instead of on
// 140 lines of fork business logic that the nightly's AI resolver would have to
// re-derive (the v1.14.2 SIDEBAR-STATE-PROJECTION failure mode).
// ---------------------------------------------------------------------------

/**
 * Validated strictly at the boundary rather than coerced. The producer is our
 * own script, which already refuses to build the object unless every field is
 * the documented shape — so anything that fails here is a real bug and must
 * surface, not be normalised into a half-question the user is then asked to
 * answer from a phone.
 *
 * (CAPTURE-BOUNDED) Every string and array is capped HERE as well as in
 * `question-store.validateCapture`. The route is `publicProcedure` on an
 * unauthenticated localhost endpoint, so without a `.max()` the router happily
 * materialises an arbitrarily large body before the store ever gets a chance to
 * refuse it. Both boundaries import ONE set of caps from `companion/limits.ts`,
 * and both must keep asserting them: sharing the number does not make either
 * check redundant — drop the schema cap and the router materialises the body
 * anyway; drop the store cap and a future non-tRPC producer bypasses this
 * schema entirely.
 */

const companionQuestionOptionInput = z.object({
	index: z.number().int().nonnegative().max(MAX_OPTIONS_PER_QUESTION),
	label: z.string().min(1).max(MAX_OPTION_LABEL_CHARS),
	description: z.string().max(MAX_OPTION_DESCRIPTION_CHARS),
});

const companionQuestionItemInput = z.object({
	index: z.number().int().nonnegative().max(MAX_QUESTIONS_PER_PROMPT),
	header: z.string().max(MAX_HEADER_CHARS),
	// NEVER truncated — median 1 412 chars, and truncation is precisely the
	// failure the native watch app exists to avoid. Capped, not truncated: an
	// over-cap question is REFUSED, so nobody is ever shown a clipped question.
	question: z.string().min(1).max(MAX_QUESTION_TEXT_CHARS),
	multiSelect: z.boolean(),
	options: z
		.array(companionQuestionOptionInput)
		.min(1)
		.max(MAX_OPTIONS_PER_QUESTION),
});

const companionQuestionInput = z.object({
	toolUseId: z.string().min(1).max(MAX_ID_CHARS),
	sessionId: z.string().min(1).max(MAX_ID_CHARS),
	transcriptPath: z.string().min(1).max(MAX_PATH_CHARS),
	cwd: z.string().min(1).max(MAX_PATH_CHARS),
	agentId: z.string().min(1).max(MAX_ID_CHARS).nullable(),
	agentType: z.string().min(1).max(MAX_ID_CHARS).nullable(),
	askedAtMs: z.number().int().positive(),
	questions: z
		.array(companionQuestionItemInput)
		.min(1)
		.max(MAX_QUESTIONS_PER_PROMPT),
});

const companionQuestionResolvedInput = z.object({
	toolUseId: z.string().min(1).max(MAX_ID_CHARS),
});

/**
 * The AskUserQuestion payload, forwarded verbatim by superset-notify.py from the
 * `PreToolUse` hook. ADDITIVE: an agent hook that does not send these fields
 * behaves exactly as before, and nothing here can change the dot decision.
 *
 * Merged into the router's `hookInput` with `.extend(...)`.
 */
export const companionHookFields = {
	companionQuestion: companionQuestionInput.optional(),
	companionQuestionResolved: companionQuestionResolvedInput.optional(),
};

/**
 * The fork-owned slice of the hook payload. Written as `?: T | undefined` so it
 * accepts the router's inferred input under `exactOptionalPropertyTypes` either
 * way; the router passes its whole `input` and the extra upstream fields are
 * structurally ignored.
 */
export interface CompanionHookPayload {
	terminalId?: string | undefined;
	companionQuestion?: z.infer<typeof companionQuestionInput> | undefined;
	companionQuestionResolved?:
		| z.infer<typeof companionQuestionResolvedInput>
		| undefined;
}

/**
 * A capture that reached the route but could not be placed. Loud: a dropped
 * question is a question the user will never see on their phone, and silence
 * would make that indistinguishable from "no question was asked".
 */
export function warnDroppedCompanionCapture(
	payload: CompanionHookPayload,
	reason: string,
): void {
	if (!payload.companionQuestion && !payload.companionQuestionResolved) return;
	console.warn("[companion-capture] dropping question payload:", reason, {
		terminalId: payload.terminalId,
		kind: payload.companionQuestion ? "capture" : "resolve",
	});
}

/**
 * The picker's free-text slot, or `null` where this fork has no PROVEN byte
 * contract for one. The hook payload carries no such field, so it is derived —
 * and derived conservatively, because a wrong derivation here is not a bad
 * render, it is wrong bytes in a live pty.
 *
 * Proven by driving a real Claude Code picker in a pty: for a prompt of exactly
 * ONE single-select question, digit N+1 opens an inline editor, then UTF-8 text,
 * then `\r` (index === options.length, as PROTOCOL §7.4 requires). Nothing else
 * was ever proven, and both remaining cases are refused rather than assumed:
 *
 *  - `multiSelect` INVERTS the picker — digits and space TOGGLE, and Enter
 *    toggles rather than submits. Emitting [N+1, text, `\r`] there would toggle
 *    an arbitrary subset chosen by the body text and leave the picker open on a
 *    selection nobody made, with no safe retry and no compensating keystroke.
 *  - an N>1 prompt has a proven shape only when EVERY item is a plain select
 *    (`classifyAnswerShape` refuses any other kind with `shape_unproven`), so a
 *    free-text slot on those items can only ever produce a refusal — a dead
 *    affordance rendered on a phone.
 *
 * (GUARD5-ANCHOR) The BRIDGE is the authority on this: `validateCapture` in
 * `companion/question-store.ts` re-derives the slot with the identical rule and
 * REFUSES a capture that disagrees, because the label is an on-screen anchor
 * guard 5 matches a digit row against. Change the two together or the capture
 * is rejected — which is the intended failure mode, not a hazard.
 */
function deriveFreeTextOption(
	item: { options: readonly unknown[]; multiSelect: boolean },
	questionCount: number,
): QuestionItem["freeTextOption"] {
	if (item.multiSelect) return null;
	if (questionCount !== 1) return null;
	// (PICKER-CONTRACT-VERSIONED) The SHARED derivation, not a second literal —
	// see `provenFreeTextRowLabel`. This file previously held its own copy of the
	// label, kept in agreement with the bridge's by nothing but a comment; when
	// they drifted, `validateCapture` rejected EVERY single-question capture at
	// ingestion, so the hook 500s and the phone is never notified.
	const label = provenFreeTextRowLabel();
	if (label === null) return null;
	return { index: item.options.length, label };
}

/**
 * Hand a captured question (and/or a desk-side resolution) to the bridge.
 *
 * Called STRICTLY AFTER the router's dot work, so a companion fault can never
 * alter or delay the agent-status broadcast. Drops silently when no bridge is
 * registered — that is every build where the companion is not running, and it is
 * why the hook route must never depend on this returning anything.
 */
export function forwardCompanionCapture(args: {
	payload: CompanionHookPayload;
	terminalId: string;
	workspaceId: string;
	occurredAt: number;
}): void {
	const { payload, terminalId, workspaceId, occurredAt } = args;
	const captured = payload.companionQuestion;
	const resolved = payload.companionQuestionResolved;
	if (!captured && !resolved) return;

	const current = sink;
	if (!current) return;

	if (captured) {
		const questionCount = captured.questions.length;
		current.capture({
			hostTerminalId: terminalId,
			workspaceId,
			toolUseId: captured.toolUseId,
			sessionId: captured.sessionId,
			transcriptPath: captured.transcriptPath,
			cwd: captured.cwd,
			agentId: captured.agentId,
			agentType: captured.agentType,
			askedAtMs: captured.askedAtMs,
			questions: captured.questions.map((item) => ({
				index: item.index,
				header: item.header,
				question: item.question,
				multiSelect: item.multiSelect,
				options: item.options.map((option) => ({
					index: option.index,
					label: option.label,
					description: option.description,
				})),
				freeTextOption: deriveFreeTextOption(item, questionCount),
			})),
		});
	}

	if (resolved) {
		current.resolve({
			hostTerminalId: terminalId,
			toolUseId: resolved.toolUseId,
			resolvedAtMs: occurredAt,
		});
	}
}
