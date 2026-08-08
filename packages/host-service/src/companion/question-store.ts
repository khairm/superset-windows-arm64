/**
 * (COMPANION-BRIDGE) — capture and custody of pending AskUserQuestion prompts (§7.4).
 *
 * Source of truth for question TEXT is the `PreToolUse` hook payload, captured
 * at the moment the question was raised: it already carries `tool_name`,
 * `tool_use_id`, `transcript_path`, `session_id`, `cwd`, `tool_input.questions[]`
 * and `agent_id`/`agent_type` for a subagent. No transcript parsing is needed to
 * DISCOVER a question; the transcript is a cross-check, not the source.
 *
 * Nothing here ever leaves the process unredacted: `tool_use_id`, `session_id`,
 * transcript paths and pty handles are NEVER sent to a client.
 *
 * Delivery route: `notifications.hook` -> `companion-question-sink` ->
 * `QuestionStore.asCaptureSink()`. The route zod-validates the wire shape; this
 * module re-validates everything it is handed, because the sink is a
 * process-global anything in this process can call and a second validation is
 * cheap next to a malformed question reaching a phone.
 *
 * ---------------------------------------------------------------------------
 * THREAT MODEL — READ THIS BEFORE USING ANYTHING THIS MODULE RETURNS
 * ---------------------------------------------------------------------------
 * Everything in this store arrives through `notifications.hook`, which is
 * DELIBERATELY UNAUTHENTICATED on localhost and whose URL sits in every agent
 * shell's environment. Any process on this machine — including an agent that
 * read untrusted content and followed instructions in it — can POST an
 * arbitrary, well-formed "a question is pending on terminal X" payload.
 *
 * Therefore:
 *
 *   1. Every record in this store is UNVERIFIED ATTACKER-INFLUENCEABLE INPUT.
 *      That is why the internal record carries `origin:
 *      "unauthenticated_localhost_hook"` and why every accessor below is
 *      documented as returning unverified state. It is not decoration; it is
 *      the only honest description of the data.
 *
 *   2. THIS STORE MUST NEVER BE THE LOAD-BEARING GUARD FOR AN INJECTION.
 *      §11.3 guards 1 (`transcript`) and 5 (`screen`) are load-bearing, and
 *      both are outside this endpoint's reach. Guards 2 (`binding`) and 4
 *      (`permission_axis`) read state written by this same unauthenticated
 *      endpoint and are explicitly NOT load-bearing. This module deliberately
 *      exposes NO method whose name or return type could be mistaken for
 *      "it is safe to type into that terminal".
 *
 *   3. The one verification primitive this module owns is
 *      `verifyResolvedInTranscript()` — guard 1. It reads the agent's own
 *      on-disk transcript, which the hook endpoint cannot write, and returns a
 *      TRI-STATE: `resolved` / `unresolved` / `unreadable`. `unreadable` is
 *      never silently collapsed into either answer; callers must treat it as a
 *      refusal, not as permission.
 *
 *      (TRANSCRIPT-PATH-DERIVED) Guard 1 only carries anti-forgery weight if
 *      the hook cannot choose WHICH FILE it reads. It previously could: the
 *      hook's `transcriptPath` was stored verbatim and handed straight to
 *      `findToolResultInTranscript`, so pointing it at an empty file made
 *      "no tool_result here" — i.e. "still unanswered" — true on demand, and
 *      guard 1 passed for a question that was never asked. The path is now
 *      DERIVED from host.db (`QuestionSourceResolver.resolveTranscriptPath`)
 *      and the hook's own value is never stored: it is compared against the
 *      derived path once, at capture, and a mismatch is logged LOUDLY. It is
 *      never opened, and never read by a guard or by the transcript
 *      endpoint. When the path cannot be derived it is EMPTY, guard 1 answers
 *      `unreadable`, and the answer is refused.
 *
 *      Absence of evidence is also not evidence: `findToolResultInTranscript`
 *      requires the matching `tool_use` block to be POSITIVELY OBSERVED before
 *      it will report `unresolved`. A file that does not contain the tool call
 *      at all — empty, rotated, foreign, or forged — is `unreadable`.
 *
 * Worst case if a forged payload is accepted: the phone shows a question that
 * was never asked, and every answer attempt against it fails guard 1 and/or 5
 * and writes nothing. That is the containment the structure above buys.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { agentKindFromAgentId } from "./agent-kind";
import { provenPickerContract } from "./keystrokes";
import {
	MAX_HEADER_CHARS,
	MAX_ID_CHARS,
	MAX_OPTION_DESCRIPTION_CHARS,
	MAX_OPTION_LABEL_CHARS,
	MAX_OPTIONS_PER_QUESTION,
	MAX_PATH_CHARS,
	MAX_QUESTION_TEXT_CHARS,
	MAX_QUESTIONS_PER_PROMPT,
} from "./limits";
import type {
	Capability,
	EpochMs,
	Fingerprint,
	ProjectId,
	QuestionAgentKind,
	QuestionId,
	QuestionItem,
	QuestionResponse,
	QuestionSource,
	QuestionState,
	QuestionSummary,
	ResolvedBy,
	TerminalId,
	TranscriptEntry,
	TranscriptRole,
	TranscriptToolDetail,
	UnanswerableReason,
	WorkspaceId,
} from "./types";

// ---------------------------------------------------------------------------
// module constants (local: §15 does not fix these, they are custody policy)
// ---------------------------------------------------------------------------

/** Resolved/stale questions are retained this long so `already_resolved` (§10) stays answerable. */
const QUESTION_RETENTION_MS = 86_400_000;

/**
 * (CAPTURE-BOUNDED) Ceiling on how many records this store will ever hold.
 *
 * `mintQuestionId` hashes three caller-supplied fields, so an unauthenticated
 * localhost caller can mint unlimited distinct ids. The per-record caps above
 * bound one record; without this one, the RECORD COUNT was unbounded.
 *
 * (CAPTURE-EVICTION) The cap alone did not bound the store usefully, because
 * nothing guaranteed the cap could ever be reclaimed. `prune` only reclaims
 * SETTLED records past their 24 h retention, so a burst of forged captures
 * filled the map with records that were all younger than the retention, and
 * every real question for the next 24 h was refused — the store stayed "bounded"
 * while the product silently stopped working. Reclamation now has three tiers,
 * in order:
 *
 *   1. `prune` — settled and past retention. Free.
 *   2. evict the OLDEST SETTLED records, retention notwithstanding. A settled
 *      record is history: losing it costs `already_resolved` (§10) precision for
 *      a question nobody is waiting on. Loud.
 *   3. refuse, loudly — reached only when all `MAX_TRACKED_QUESTIONS` records are
 *      PENDING, which (given a capture must name a terminal host.db actually has,
 *      and a terminal holds at most one pending record) means this many live
 *      terminals are blocked at once. That is a machine state, not a flood.
 *
 * A live question is never evicted at any tier: making a real blocked agent
 * vanish from the phone is the one failure this product cannot have.
 */
const MAX_TRACKED_QUESTIONS = 512;

/**
 * (CAPTURE-BOUNDED) `askedAtMs` is a CLOCK READING, not a free integer.
 *
 * It was validated only as "a positive integer", and it is the sole input to
 * `prune()`'s retention arithmetic and to `oldestPendingAgeMs`. A far-future
 * value makes `now - askedAt` permanently negative, so the record is never
 * reclaimed; a seconds-instead-of-milliseconds producer bug makes every record
 * instantly prunable and breaks `already_resolved` (§10). Both are silent.
 * Anything outside this window around the bridge's own clock is rejected.
 */
const CAPTURE_MAX_FUTURE_SKEW_MS = 300_000;
const CAPTURE_MAX_AGE_MS = 86_400_000;

/** `PendingQuestionRef.headline` / `QuestionSummary.headline` are <= 80 chars (§7.2, §9.4). */
const HEADLINE_MAX_CHARS = 80;

/** §7.4 — the sheet gets the last 10 transcript entries as context. */
const QUESTION_CONTEXT_ENTRIES = 10;

/** Bounded transcript reads. Never the whole file: multi-GB transcripts exist. */
const TRANSCRIPT_WINDOW_STEPS_BYTES = [262_144, 2_097_152, 8_388_608] as const;

/** Per-entry cap on `tool.detail`; `text` is NEVER truncated (§7.3). */
const TOOL_DETAIL_MAX_CHARS = 8_192;

/** Guard-1 scan window: how far back from EOF we look for the matching `tool_result`. */
const TOOL_RESULT_SCAN_BYTES = 8_388_608;

/** Domain separation for opaque wire handles (§7.2). */
const HANDLE_LABEL = "sc/v1 handle ";
const FINGERPRINT_LABEL = "sc/v1 fingerprint";

// ---------------------------------------------------------------------------
// opaque wire handles
// ---------------------------------------------------------------------------

export type HandleKind = "project" | "workspace" | "terminal";

function b64url(bytes: Buffer): string {
	return bytes.toString("base64url");
}

/**
 * (HANDLE-MEMO) Memo for `deriveHandle`, keyed on `kind_hostId`. The three
 * `HandleKind` literals are distinct non-prefix words, so the key is
 * unambiguous without a separator that cannot appear in a host id.
 *
 * `deriveHandle` is a PURE function of its two arguments, so this is a
 * memoised hash and NOTHING ELSE. It is emphatically not a cache of "which
 * terminals exist": the reverse lookups in `index.ts` and `read-api.ts` still
 * enumerate `listActiveTerminals()` on every single call, so a terminal that
 * has gone away is still absent from every scan and the per-keystroke guard
 * re-evaluation is unweakened. What the memo removes is the SHA-256 those scans
 * recomputed per row per call — roughly five adapter calls per answer, each
 * re-hashing every live terminal, and the whole tree projection on every read.
 *
 * Bounded by clearing wholesale at the cap rather than by an LRU: entries are
 * interchangeable and a rebuild costs one hash each, so the simplest bound that
 * cannot leak is the right one.
 */
const HANDLE_MEMO_MAX_ENTRIES = 4_096;
const handleMemo = new Map<string, string>();

/**
 * §0.1 — wire ids are 16 raw bytes -> 22 base64url chars, and are opaque to the
 * client. They are DERIVED, not minted-and-remembered, so they survive a bridge
 * restart without any persisted map:
 *
 *   handle = SHA-256("sc/v1 handle " || kind || 0x00 || hostId)[0..16]
 *
 * Opacity here is a layering property, not a secrecy control — the secrecy
 * control is the sealed envelope (§3). The reverse direction is a lookup over
 * the ids currently present in host.db, never an inversion of this hash.
 */
export function deriveHandle(kind: HandleKind, hostId: string): string {
	if (hostId.length === 0) {
		throw new Error(`deriveHandle: empty hostId for kind=${kind}`);
	}
	const memoKey = `${kind}_${hostId}`;
	const memoised = handleMemo.get(memoKey);
	if (memoised !== undefined) return memoised;
	const h = createHash("sha256");
	h.update(HANDLE_LABEL, "utf8");
	h.update(kind, "utf8");
	h.update(Buffer.of(0x00));
	h.update(hostId, "utf8");
	const handle = b64url(h.digest().subarray(0, 16));
	if (handleMemo.size >= HANDLE_MEMO_MAX_ENTRIES) handleMemo.clear();
	handleMemo.set(memoKey, handle);
	return handle;
}

// ---------------------------------------------------------------------------
// the capture boundary — validated HARD, twice, on purpose
// ---------------------------------------------------------------------------

/**
 * Raised by `validateCapture` on ANY deviation. There is no coercion, no
 * defaulting and no partial acceptance: a malformed capture is dropped loudly
 * at the boundary rather than stored in a half-known shape and then shown to
 * someone who is being asked to answer it from a watch.
 */
export class CaptureRejectedError extends Error {
	constructor(
		readonly field: string,
		reason: string,
	) {
		super(`companion question capture rejected: ${field}: ${reason}`);
		this.name = "CaptureRejectedError";
	}
}

/**
 * What `notifications.hook` hands the bridge (structurally identical to
 * `CompanionQuestionCapture` in
 * `trpc/router/notifications/companion-question-sink.ts`; declared here rather
 * than imported so the bridge never depends on the router).
 *
 * UNTRUSTED. See the module header.
 */
export interface QuestionCaptureInput {
	/** host.db `terminal_sessions.id`. Internal; never sent to a client. */
	hostTerminalId: string;
	/** host.db `workspaces.id`. Internal; never sent to a client. */
	workspaceId: string;
	/** Claude's `tool_use_id`. Internal; part of the §7.4 fingerprint. */
	toolUseId: string;
	/** Claude's `session_id`. Internal; part of the §7.4 fingerprint. */
	sessionId: string;
	/** Absolute path of the session transcript. Internal; guard 1 reads it. */
	transcriptPath: string;
	cwd: string;
	/** SUBAGENT id when a subagent asked; `null` on the main loop. */
	agentId: string | null;
	/** SUBAGENT type when a subagent asked; `null` on the main loop. */
	agentType: string | null;
	askedAtMs: number;
	questions: QuestionItem[];
}

/** What the hook reports when a question was dealt with at the desk. */
export interface QuestionResolutionInput {
	hostTerminalId: string;
	toolUseId: string;
	resolvedAtMs: number;
}

/** Structural shape of `CompanionQuestionSink`; see `asCaptureSink()`. */
export interface QuestionCaptureSink {
	capture(input: QuestionCaptureInput): void;
	resolve(input: QuestionResolutionInput): void;
}

function requireString(
	value: unknown,
	field: string,
	opts: { maxChars: number; allowEmpty?: boolean },
): string {
	if (typeof value !== "string") {
		throw new CaptureRejectedError(
			field,
			`expected string, got ${typeof value}`,
		);
	}
	if (!opts.allowEmpty && value.length === 0) {
		throw new CaptureRejectedError(field, "must not be empty");
	}
	if (value.length > opts.maxChars) {
		throw new CaptureRejectedError(
			field,
			`${value.length} chars exceeds cap ${opts.maxChars}`,
		);
	}
	return value;
}

function requireNullableString(
	value: unknown,
	field: string,
	maxChars: number,
): string | null {
	if (value === null) return null;
	return requireString(value, field, { maxChars });
}

function requireBoolean(value: unknown, field: string): boolean {
	if (typeof value !== "boolean") {
		throw new CaptureRejectedError(
			field,
			`expected boolean, got ${typeof value}`,
		);
	}
	return value;
}

function requirePositiveInt(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
		throw new CaptureRejectedError(field, "expected a positive integer");
	}
	return value;
}

/**
 * (CAPTURE-BOUNDED) A wall-clock stamp, checked against OUR clock.
 *
 * See `CAPTURE_MAX_FUTURE_SKEW_MS`. An out-of-window stamp is refused rather
 * than clamped: clamping would silently rewrite the field that retention and
 * `oldestUnansweredMs` are computed from.
 */
function requireTimestampMs(
	value: unknown,
	field: string,
	nowMs: number,
): number {
	const stamp = requirePositiveInt(value, field);
	if (stamp > nowMs + CAPTURE_MAX_FUTURE_SKEW_MS) {
		throw new CaptureRejectedError(
			field,
			`${stamp} is more than ${CAPTURE_MAX_FUTURE_SKEW_MS} ms in the future (now ${nowMs})`,
		);
	}
	if (stamp < nowMs - CAPTURE_MAX_AGE_MS) {
		throw new CaptureRejectedError(
			field,
			`${stamp} is more than ${CAPTURE_MAX_AGE_MS} ms in the past (now ${nowMs})`,
		);
	}
	return stamp;
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new CaptureRejectedError(field, "expected an object");
	}
	return value as Record<string, unknown>;
}

function requireArray(value: unknown, field: string, max: number): unknown[] {
	if (!Array.isArray(value)) {
		throw new CaptureRejectedError(field, "expected an array");
	}
	if (value.length === 0) {
		throw new CaptureRejectedError(field, "must not be empty");
	}
	if (value.length > max) {
		throw new CaptureRejectedError(
			field,
			`${value.length} entries exceeds cap ${max}`,
		);
	}
	return value;
}

/**
 * (PICKER-CONTRACT-VERSIONED) The free-text row's label for the build the byte
 * contract is proven against — `null` when that build has no proven free-text
 * sequence, or is not a build this fork has observed at all.
 *
 * `null` propagates to `freeTextOption: null`, which makes the slot absent
 * everywhere at once: the phone is not offered it, the encoder is never asked for
 * it, and guard 5 never looks for its row. That single source is the point. The
 * label used to be a local literal `"Other"` here while the matcher searched for
 * a different build's copy, so the item the phone received and the needle the
 * screen check used could disagree — and did.
 */
function freeTextRowLabel(): string | null {
	const contract = provenPickerContract();
	if (contract === null) return null;
	return contract.freeTextBytesProven ? contract.freeTextRowLabel : null;
}

/**
 * The picker's free-text slot, DERIVED — never accepted from the capture.
 *
 * (GUARD5-ANCHOR) The label is an on-screen anchor guard 5 matches a digit row
 * against, so letting the caller supply it hands the caller a knob on the only
 * load-bearing screen check. It is therefore computed here, from the same
 * PROVEN byte contract `companion-question-sink.ts` uses, and a capture that
 * disagrees is rejected rather than silently overridden.
 *
 * Proven by driving a real Claude Code picker in a pty: for a prompt of exactly
 * ONE single-select question, digit N+1 opens an inline editor. `multiSelect`
 * inverts the picker and an N>1 prompt has no proven free-text shape, so both
 * are `null`.
 */
function deriveFreeTextOption(
	multiSelect: boolean,
	optionCount: number,
	questionCount: number,
): QuestionItem["freeTextOption"] {
	if (multiSelect) return null;
	if (questionCount !== 1) return null;
	const label = freeTextRowLabel();
	if (label === null) return null;
	return { index: optionCount, label };
}

/**
 * Validate a capture at this module's boundary.
 *
 * Index discipline is enforced rather than repaired: `questions[i].index` must
 * be exactly `i` and `options[j].index` exactly `j`, and `freeTextOption.index`
 * must be `options.length`. Those indices ARE the keystrokes the answer path
 * later types, so a renumbering here would be a wrong keypress against a live
 * picker, which §11 says is unrecoverable. Reject instead.
 *
 * What this does NOT do, on purpose: it does not make the capture trustworthy.
 * A perfectly-shaped capture from a prompt-injected agent passes every check
 * here. See the module header for why that is contained rather than prevented.
 */
export function validateCapture(
	raw: unknown,
	nowMs: number = Date.now(),
): QuestionCaptureInput {
	const o = requireObject(raw, "capture");

	const transcriptPath = requireString(o.transcriptPath, "transcriptPath", {
		maxChars: MAX_PATH_CHARS,
	});
	if (!path.isAbsolute(transcriptPath)) {
		throw new CaptureRejectedError("transcriptPath", "must be absolute");
	}

	const rawQuestions = requireArray(
		o.questions,
		"questions",
		MAX_QUESTIONS_PER_PROMPT,
	);
	const questionCount = rawQuestions.length;
	const questions: QuestionItem[] = rawQuestions.map((entry, i) => {
		const q = requireObject(entry, `questions[${i}]`);
		if (q.index !== i) {
			throw new CaptureRejectedError(
				`questions[${i}].index`,
				`must equal its position ${i}, got ${String(q.index)}`,
			);
		}
		const rawOptions = requireArray(
			q.options,
			`questions[${i}].options`,
			MAX_OPTIONS_PER_QUESTION,
		);
		const options = rawOptions.map((optEntry, j) => {
			const opt = requireObject(optEntry, `questions[${i}].options[${j}]`);
			if (opt.index !== j) {
				throw new CaptureRejectedError(
					`questions[${i}].options[${j}].index`,
					`must equal its position ${j}, got ${String(opt.index)}`,
				);
			}
			return {
				index: j,
				label: requireString(opt.label, `questions[${i}].options[${j}].label`, {
					maxChars: MAX_OPTION_LABEL_CHARS,
				}),
				description: requireString(
					opt.description,
					`questions[${i}].options[${j}].description`,
					{ maxChars: MAX_OPTION_DESCRIPTION_CHARS, allowEmpty: true },
				),
			};
		});

		const multiSelect = requireBoolean(
			q.multiSelect,
			`questions[${i}].multiSelect`,
		);
		// (GUARD5-ANCHOR) DERIVED, then cross-checked. A supplied slot that does
		// not match what this fork can actually drive is a refusal, not an
		// override: the two disagreeing means one of them is wrong about a live
		// pty, and guessing which is how a wrong digit gets typed.
		const freeTextOption = deriveFreeTextOption(
			multiSelect,
			options.length,
			questionCount,
		);
		if (q.freeTextOption !== null && q.freeTextOption !== undefined) {
			const ft = requireObject(
				q.freeTextOption,
				`questions[${i}].freeTextOption`,
			);
			if (freeTextOption === null) {
				throw new CaptureRejectedError(
					`questions[${i}].freeTextOption`,
					"this prompt shape has no proven free-text slot, so one must not be supplied",
				);
			}
			if (ft.index !== freeTextOption.index) {
				throw new CaptureRejectedError(
					`questions[${i}].freeTextOption.index`,
					`must equal options.length ${freeTextOption.index}, got ${String(ft.index)}`,
				);
			}
			if (ft.label !== freeTextOption.label) {
				throw new CaptureRejectedError(
					`questions[${i}].freeTextOption.label`,
					"the free-text label is bridge-owned and cannot be supplied by the capture",
				);
			}
		}

		return {
			index: i,
			header: requireString(q.header, `questions[${i}].header`, {
				maxChars: MAX_HEADER_CHARS,
				allowEmpty: true,
			}),
			// NEVER truncated — median 1 412 chars, and truncation is exactly the
			// failure the native watch app exists to prevent.
			question: requireString(q.question, `questions[${i}].question`, {
				maxChars: MAX_QUESTION_TEXT_CHARS,
			}),
			multiSelect,
			options,
			freeTextOption,
		};
	});

	return {
		hostTerminalId: requireString(o.hostTerminalId, "hostTerminalId", {
			maxChars: MAX_ID_CHARS,
		}),
		workspaceId: requireString(o.workspaceId, "workspaceId", {
			maxChars: MAX_ID_CHARS,
		}),
		toolUseId: requireString(o.toolUseId, "toolUseId", {
			maxChars: MAX_ID_CHARS,
		}),
		sessionId: requireString(o.sessionId, "sessionId", {
			maxChars: MAX_ID_CHARS,
		}),
		transcriptPath,
		cwd: requireString(o.cwd, "cwd", { maxChars: MAX_PATH_CHARS }),
		agentId: requireNullableString(o.agentId, "agentId", MAX_ID_CHARS),
		agentType: requireNullableString(o.agentType, "agentType", MAX_ID_CHARS),
		askedAtMs: requireTimestampMs(o.askedAtMs, "askedAtMs", nowMs),
		questions,
	};
}

// ---------------------------------------------------------------------------
// the internal record
// ---------------------------------------------------------------------------

/** The internal record. The wire types in §7.4 are projections of this. */
export interface PendingQuestion {
	questionId: QuestionId;
	fingerprint: Fingerprint;
	state: QuestionState;
	askedAtMs: number;
	resolvedAtMs: number | null;
	resolvedBy: ResolvedBy | null;
	/** Never sent to a client. */
	toolUseId: string;
	/** Never sent to a client. */
	sessionId: string;
	terminalId: TerminalId;
	agentType: string | null;
	questions: QuestionItem[];
	/**
	 * Provenance, stated in the record itself: this content came from the
	 * unauthenticated localhost hook and is attacker-influenceable. Anything
	 * that consumes a `PendingQuestion` is consuming unverified input.
	 */
	origin: "unauthenticated_localhost_hook";
	/** host.db `terminal_sessions.id`. Never sent to a client. */
	hostTerminalId: string;
	/** host.db `workspaces.id`. Never sent to a client. */
	hostWorkspaceId: string;
	/**
	 * (TRANSCRIPT-PATH-DERIVED) Absolute path to the agent's own transcript,
	 * DERIVED FROM host.db — never the hook's own value. Empty string when it
	 * could not be derived, which makes guard 1 answer `unreadable` (a refusal).
	 * Never sent to a client.
	 */
	transcriptPath: string;
	/** Resolved from host.db's agent binding, NOT from the hook payload. */
	agentKind: QuestionAgentKind;
	/**
	 * SUBAGENT id when a subagent asked; `null` on the main loop. Never sent to a
	 * client. Guard 6 needs it to compute the per-owner `.askq` marker key.
	 */
	agentId: string | null;
}

/** Result of guard 1 (§11.3). `unreadable` is a REFUSAL, never a pass. */
export type TranscriptVerdict = "resolved" | "unresolved" | "unreadable";

/** Per-session answerability inputs. `granted` is this device's session grant (§6.2). */
export interface AnswerabilityContext {
	granted: readonly Capability[];
}

/**
 * Resolves a host terminal id to the rows that own it. Implemented by
 * `openHostDbReadOnly` in `read-api.ts`; declared here so this module never
 * imports the read path (and so the dependency arrow only ever points one way).
 */
export interface QuestionSourceResolver {
	resolveTerminal(hostTerminalId: string): {
		hostProjectId: string;
		hostWorkspaceId: string;
		/** `terminal_agent_bindings.agent_id`, e.g. `"claude"`. `null` = unbound. */
		agentId: string | null;
	} | null;
	/**
	 * (CAPTURE-BOUNDED) The same resolution, restricted to a session row that is
	 * still `active` with no `ended_at`.
	 *
	 * A SEPARATE method rather than a predicate added to the one above, because
	 * the two callers ask different questions. `capture` asks "may I start
	 * tracking a question here?" and its own refusal text says "names no active
	 * terminal joined to a workspace in host.db" — a claim the unrestricted query
	 * did not make, so 212 disposed rows on this machine sailed through it.
	 * `resolveSource` asks "where did this record come from?" and must keep
	 * answering for SETTLED records on terminals the user has since closed, or
	 * reopening the question you just answered becomes a 500.
	 */
	resolveActiveTerminal(hostTerminalId: string): {
		hostProjectId: string;
		hostWorkspaceId: string;
		agentId: string | null;
	} | null;
	/**
	 * (TRANSCRIPT-PATH-DERIVED) The agent transcript path for this terminal,
	 * computed from host.db's own workspace path and agent session id — the two
	 * facts the unauthenticated hook cannot choose independently of each other.
	 *
	 * `null` when it cannot be derived (no binding, no session id, not Claude, an
	 * unsafe session id, or no workspace row). `null` is a REFUSAL upstream, never
	 * a licence to fall back to a caller-supplied path.
	 */
	resolveTranscriptPath(hostTerminalId: string): string | null;
	/**
	 * (QUESTION-EXPIRY) The row's newest known instant — `last_attached_at ??
	 * created_at` — or `null` when host.db has no row for the id at all.
	 *
	 * Unrestricted by `status`/`ended_at` and unjoined to `workspaces`, unlike
	 * the two resolvers above: this is the input to a LIVENESS grace, and the
	 * row it has to rescue is precisely the one that was created moments ago and
	 * may not be in the daemon listing yet. Filtering it would reintroduce the
	 * birth race the grace exists to close.
	 *
	 * `null` is "no timestamp", which the predicate treats as no grace, not as
	 * proof of anything.
	 */
	resolveTerminalActivityMs(hostTerminalId: string): number | null;
}

/**
 * (QUESTION-EXPIRY) Does the terminal a pending question is waiting on still
 * exist? Implemented by `(BRIDGE-LIVENESS)`; declared as its own one-method
 * interface so this module depends on the QUESTION it needs answered rather
 * than on the daemon plumbing that answers it.
 *
 * The method is `isProvablyGone`, NOT `isLive`, and the difference is the whole
 * safety argument. Expiry is IRREVERSIBLE — `settle(stale)` is terminal and
 * `markStale` refuses to move a record afterwards — so this caller may act only
 * on positive evidence of death, never on the absence of evidence of life. The
 * strict predicate additionally refuses to read anything into an empty daemon
 * listing, which `isLive` (a display filter, whose mistakes cost one refresh)
 * deliberately does trust after its warm-up window.
 *
 * `lastActivityMs` is the row's newest known instant (`last_attached_at ??
 * created_at`), which is what keeps a terminal created after the daemon
 * snapshot was taken from reading as dead. Pass it: the display path
 * (`listLiveTerminals`) always does, and it would be perverse for the one
 * caller whose mistake is permanent to be the one flying without it.
 *
 * One observation is still not enough on its own — see
 * `QUESTION_EXPIRY_CORROBORATION_MS`.
 */
export interface QuestionTerminalLiveness {
	isProvablyGone(
		hostTerminalId: string,
		lastActivityMs?: number | null,
	): boolean;
}

export interface QuestionStoreDeps {
	source: QuestionSourceResolver;
	liveness: QuestionTerminalLiveness;
	/**
	 * (SETTLE-CHOKE-POINT) THE INVARIANT: every route a question can leave
	 * `pending` by calls this, exactly once, because they all go through
	 * `settle()` and `settle()` is the only thing that writes a terminal state.
	 *
	 * A settled question is exactly the moment any notification about it must be
	 * pulled off the phone (§13.3), and the wiring for that used to hang off
	 * individual call sites: the desk-answer sink retracted, the reconcile path
	 * retracted, and the other two settle routes — a REMOTE answer (`/v1/answer`
	 * resolves the record and returns) and a SUPERSEDE (a newer question on the
	 * same terminal marks the prior one stale) — did not. Both left the watch
	 * buzzing about a question that no longer existed, and the supersede case
	 * left it buzzing toward a record the tree had already dropped.
	 *
	 * Adding the call to those two sites would have fixed those two sites. This
	 * is the seam instead, so a settle route added later cannot forget: there is
	 * nowhere to write `state = "resolved" | "stale"` except `settle()`.
	 *
	 * Called AFTER the record is settled, so a sink reading the store back sees
	 * the ending rather than the pending state it replaced.
	 */
	onSettled: (question: PendingQuestion) => void;
}

export interface QuestionStore {
	/**
	 * Called from the PreToolUse hook path with an ALREADY-VALIDATED payload.
	 * Mints the id and the fingerprint. Prefer `asCaptureSink()`, which does the
	 * boundary validation for you.
	 */
	capture(input: QuestionCaptureInput): PendingQuestion;
	/**
	 * THE ENTRY POINT for captures. The object to hand
	 * `setCompanionQuestionSink()`; structurally a `CompanionQuestionSink`.
	 *
	 * Every call is re-validated as untrusted input (`validateCapture`, which
	 * throws `CaptureRejectedError`) even though the tRPC route already
	 * zod-validated it: the sink is a process-global that anything in this
	 * process can call, so the router's schema is not the only boundary this
	 * payload can arrive through.
	 */
	asCaptureSink(): QuestionCaptureSink;
	/** UNVERIFIED hook-derived state. Never treat as proof of anything (module header). */
	get(questionId: QuestionId): PendingQuestion | null;
	/** UNVERIFIED hook-derived state. `terminalId` is the OPAQUE wire handle. */
	byTerminal(terminalId: TerminalId): PendingQuestion | null;
	/** UNVERIFIED hook-derived state. `hostTerminalId` is host.db's own id. */
	byHostTerminal(hostTerminalId: string): PendingQuestion | null;
	/** UNVERIFIED hook-derived state, oldest first. */
	listPending(): PendingQuestion[];
	/**
	 * Records a resolution. `stale` is TERMINAL — a superseded record is never
	 * promoted to `resolved`, because doing so would stamp a phone/watch
	 * provenance onto a question that device never actually answered and leave the
	 * tree reporting a superseded question as phone-answered. Returns whether the
	 * record was actually resolved, so a caller can log the miss instead of
	 * silently assuming it took.
	 */
	resolve(
		questionId: QuestionId,
		resolvedBy: ResolvedBy,
		atMs: number,
	): boolean;
	markStale(questionId: QuestionId, reason: string): void;
	/**
	 * GUARD 1 (§11.3), the load-bearing one this module owns: does the question's
	 * `tool_use_id` still have NO `tool_result` in the agent's own transcript?
	 * Tri-state on purpose — `unreadable` must be handled as a refusal.
	 */
	verifyResolvedInTranscript(
		question: PendingQuestion,
	): Promise<TranscriptVerdict>;
	/**
	 * Cross-check every pending record against the transcript and settle the ones
	 * the hook never told us about. A `PostToolUse` hook can die mid-flight —
	 * emulated msys2 on this ARM64 box has form for exactly that — so
	 * hook-silence is NOT evidence a question is still open. Returns the ids it
	 * moved to `resolved`. Also prunes records past 24 h.
	 */
	reconcile(nowMs: EpochMs): Promise<QuestionId[]>;
	/** Age of the oldest pending question, for §7.7 `oldestUnansweredMs`. */
	oldestPendingAgeMs(nowMs: EpochMs): number | null;
	/** §7.4 projection, including the last 10 transcript entries as context. */
	toResponse(
		question: PendingQuestion,
		ctx: AnswerabilityContext,
	): Promise<QuestionResponse>;
	/** §7.2 `headline` — the FIRST item's `header`, clamped to 80 chars. Not the body. */
	headline(question: PendingQuestion): string;
	/**
	 * (TREE-FRESHNESS-GSEQ) §9.4 projection of ONE record: the same identity and
	 * shape fields `/v1/tree` derives, minus the transcript context.
	 *
	 * `ctx` decides `answerable` exactly as it does everywhere else, so a caller
	 * publishing a BROADCAST frame must pass the bridge's own capability set and
	 * mean "answerable by a fully-granted device" — the per-device narrowing is
	 * the snapshot's job, not a frame's.
	 *
	 * Returns `null` when the record's source no longer resolves in host.db.
	 * Publishing a summary with an invented project or workspace handle would put
	 * a fabricated identity on the wire; a missing frame is recoverable, a wrong
	 * one is not.
	 */
	summarize(
		question: PendingQuestion,
		ctx: AnswerabilityContext,
	): QuestionSummary | null;
	/** Why this question cannot be answered from a phone, or `null` if it can. */
	unanswerableReason(
		question: PendingQuestion,
		ctx: AnswerabilityContext,
	): UnanswerableReason | null;
}

// ---------------------------------------------------------------------------
// fingerprint
// ---------------------------------------------------------------------------

/** Deterministic JSON: object keys sorted, no whitespace, arrays in order. */
function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value) ?? "null";
	}
	if (Array.isArray(value)) {
		return `[${value.map(canonicalJson).join(",")}]`;
	}
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, v]) => v !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `{${entries
		.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
		.join(",")}}`;
}

/**
 * §7.4 — SHA-256(toolUseId || 0x00 || sessionId || 0x00 || terminalId || 0x00 ||
 * canonicalJson(questions))[0..16], base64url. It changes if ANYTHING the answer
 * depends on changes; the client echoes it and a mismatch is `stale_question`.
 */
export function computeFingerprint(input: {
	toolUseId: string;
	sessionId: string;
	terminalId: TerminalId;
	questions: QuestionItem[];
}): Fingerprint {
	const h = createHash("sha256");
	h.update(FINGERPRINT_LABEL, "utf8");
	h.update(Buffer.of(0x00));
	h.update(input.toolUseId, "utf8");
	h.update(Buffer.of(0x00));
	h.update(input.sessionId, "utf8");
	h.update(Buffer.of(0x00));
	h.update(input.terminalId, "utf8");
	h.update(Buffer.of(0x00));
	h.update(canonicalJson(input.questions), "utf8");
	return b64url(h.digest().subarray(0, 16));
}

// ---------------------------------------------------------------------------
// transcript reading (bounded, non-blocking) — shared with read-api
// ---------------------------------------------------------------------------

/** One parsed JSONL record plus the byte offset of the line it came from. */
interface RawTranscriptRecord {
	byteOffset: number;
	record: Record<string, unknown>;
}

/**
 * The wire entries one JSONL record produced, tagged with that record's byte
 * offset. Pages are cut on these boundaries so no record is ever split across
 * two pages.
 */
interface ProjectedRecord {
	byteOffset: number;
	entries: TranscriptEntry[];
}

export interface TranscriptWindow {
	/** Oldest -> newest. */
	entries: TranscriptEntry[];
	/**
	 * Byte offset of the line that produced the OLDEST entry in this window.
	 * Pass it back as `beforeOffset` to page further back. `null` when the
	 * window is empty.
	 */
	oldestOffset: number | null;
	/** true => there are older bytes before `oldestOffset`. */
	hasMore: boolean;
}

/**
 * Read a bounded window of a JSONL transcript, newest-first, and return it
 * oldest-first.
 *
 * NEVER reads the whole file: real transcripts run to gigabytes, and a
 * synchronous or unbounded read on this process is the documented footgun that
 * starves the renderer's `superset-app://` loader. Reads are `fs/promises`,
 * anchored at a byte offset, and capped; the window grows through at most three
 * steps before the caller is told `hasMore` instead of being made to wait.
 */
export async function readTranscriptWindow(opts: {
	transcriptPath: string;
	limit: number;
	/** Only bytes strictly BEFORE this offset are considered. `null` = from EOF. */
	beforeOffset: number | null;
}): Promise<TranscriptWindow> {
	if (!Number.isInteger(opts.limit) || opts.limit < 1) {
		throw new Error(`readTranscriptWindow: bad limit ${opts.limit}`);
	}
	const handle = await fs.open(opts.transcriptPath, "r");
	try {
		const stat = await handle.stat();
		const end =
			opts.beforeOffset === null
				? stat.size
				: Math.min(opts.beforeOffset, stat.size);
		if (end <= 0) {
			return {
				entries: [],
				oldestOffset: null,
				hasMore: false,
			};
		}

		// Grow the window until it yields `limit` PROJECTED entries, not `limit`
		// raw lines: a JSONL transcript is mostly book-keeping records (`mode`,
		// `queue-operation`, `file-history-snapshot`, ...) that carry no
		// conversation, so counting lines under-fills every page.
		let projected: ProjectedRecord[] = [];
		let windowStart = end;
		let sawPartialTail = false;

		for (const windowBytes of TRANSCRIPT_WINDOW_STEPS_BYTES) {
			const start = Math.max(0, end - windowBytes);
			const length = end - start;
			const buf = Buffer.alloc(length);
			await handle.read(buf, 0, length, start);

			const parsed = parseJsonlRegion(buf, start, {
				// A window that does not begin at byte 0 begins mid-line; that
				// fragment is dropped rather than parsed as a truncated record.
				dropFirstFragment: start > 0,
			});
			// Project over the WHOLE region so a `tool_result` can still resolve
			// its name from a `tool_use` that ends up sliced off the page.
			projected = projectTranscriptRecords(parsed.records);
			windowStart = start;
			sawPartialTail = opts.beforeOffset === null && parsed.trailingFragment;

			const total = projected.reduce((n, p) => n + p.entries.length, 0);
			if (total >= opts.limit || start === 0) break;
		}

		// Cut on a RECORD boundary. Slicing mid-record would make the next page
		// (anchored at that record's offset) re-emit the blocks we already sent,
		// and the client de-dups on `entryId`, not on page identity.
		const page: ProjectedRecord[] = [];
		let taken = 0;
		for (let i = projected.length - 1; i >= 0; i--) {
			const candidate = projected[i];
			if (candidate === undefined) continue;
			if (candidate.entries.length === 0) continue;
			if (taken > 0 && taken + candidate.entries.length > opts.limit) break;
			page.unshift(candidate);
			taken += candidate.entries.length;
			if (taken >= opts.limit) break;
		}

		const entries = page.flatMap((p) => p.entries);
		// One record whose own blocks exceed `limit`: keep the newest `limit` of
		// them rather than returning an empty page. Paging back from here can
		// repeat that record's earlier blocks; the client's `entryId` de-dup
		// absorbs it, and a single message with >100 blocks is vanishingly rare.
		const clipped =
			entries.length > opts.limit
				? entries.slice(entries.length - opts.limit)
				: entries;

		// The newest entry is the only one that can be mid-stream, and only when
		// we are reading the live tail.
		const newest = clipped[clipped.length - 1];
		if (sawPartialTail && newest !== undefined) newest.partial = true;

		const oldest = page[0];
		const oldestOffset = oldest === undefined ? null : oldest.byteOffset;
		const hasMore = oldestOffset === null ? windowStart > 0 : oldestOffset > 0;

		return { entries: clipped, oldestOffset, hasMore };
	} finally {
		await handle.close();
	}
}

/**
 * Split a byte region on `\n` and JSON-parse each complete line. `\n` (0x0A)
 * cannot occur inside a UTF-8 multi-byte sequence, so splitting on the byte and
 * decoding each line independently is safe across an arbitrary region boundary.
 *
 * A line that does not parse is SKIPPED, not repaired and not defaulted: the
 * transcript is another program's append-only log, and a half-written tail line
 * is a normal steady state, not an error condition of ours. The fact that it
 * happened is reported via `trailingFragment`.
 */
function parseJsonlRegion(
	buf: Buffer,
	regionStart: number,
	opts: { dropFirstFragment: boolean },
): { records: RawTranscriptRecord[]; trailingFragment: boolean } {
	const records: RawTranscriptRecord[] = [];
	let lineStart = 0;
	let first = true;
	let trailingFragment = false;

	for (let i = 0; i <= buf.length; i++) {
		const atEnd = i === buf.length;
		if (!atEnd && buf[i] !== 0x0a) continue;

		const lineBytes = buf.subarray(lineStart, i);
		const byteOffset = regionStart + lineStart;
		const isFirst = first;
		first = false;
		lineStart = i + 1;

		if (atEnd && lineBytes.length === 0) break;
		if (isFirst && opts.dropFirstFragment) continue;
		if (lineBytes.length === 0) continue;

		const text = lineBytes.toString("utf8").trim();
		if (text.length === 0) continue;

		let parsedLine: unknown;
		try {
			parsedLine = JSON.parse(text);
		} catch {
			// Only the final line can legitimately be a half-written record.
			if (atEnd) trailingFragment = true;
			continue;
		}
		if (
			typeof parsedLine !== "object" ||
			parsedLine === null ||
			Array.isArray(parsedLine)
		) {
			continue;
		}
		records.push({ byteOffset, record: parsedLine as Record<string, unknown> });
	}

	return { records, trailingFragment };
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return null;
	}
	return value as Record<string, unknown>;
}

function tsMsOf(record: Record<string, unknown>): number | null {
	const raw = record.timestamp;
	if (typeof raw !== "string") return null;
	const parsedTs = Date.parse(raw);
	return Number.isFinite(parsedTs) ? parsedTs : null;
}

function firstLine(text: string, maxChars: number): string {
	const line = text.split("\n", 1)[0] ?? "";
	return line.length > maxChars ? `${line.slice(0, maxChars - 1)}…` : line;
}

function clampChars(text: string, maxChars: number): string {
	return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

/**
 * Project Claude Code JSONL records onto §7.3 `TranscriptEntry` values.
 *
 * Conversational shape, per the assignment: user messages, agent replies, and
 * tool calls collapsed to a one-line chip with the full payload behind it.
 *
 * Deliberate omissions, each of which is a rendering decision and NOT a
 * truncation of anything the client asked for:
 *   - `thinking` blocks — reasoning, not a reply; the client renders a
 *     conversation and a thinking block is neither a user turn nor an answer.
 *   - book-keeping record types (`mode`, `permission-mode`, `bridge-session`,
 *     `file-history-snapshot`, `last-prompt`, `queue-operation`, `ai-title`,
 *     `attachment`) — they have no `uuid` and no conversational content.
 *   - `isMeta` records — Claude's own injected preamble, not a user turn.
 * `text` itself is passed through VERBATIM and is never truncated or scrubbed.
 */
function projectTranscriptRecords(
	raws: RawTranscriptRecord[],
): ProjectedRecord[] {
	const toolNameById = new Map<string, string>();
	const out: ProjectedRecord[] = [];
	for (const { record, byteOffset } of raws) {
		const entries = projectOneRecord(record, toolNameById);
		if (entries.length > 0) out.push({ byteOffset, entries });
	}
	return out;
}

function projectOneRecord(
	record: Record<string, unknown>,
	toolNameById: Map<string, string>,
): TranscriptEntry[] {
	const type = record.type;
	if (typeof type !== "string") return [];
	if (type !== "user" && type !== "assistant" && type !== "system") return [];
	if (record.isMeta === true) return [];

	const uuid = record.uuid;
	if (typeof uuid !== "string" || uuid.length === 0) return [];
	const tsMs = tsMsOf(record) ?? 0;

	if (type === "system") {
		const subtype =
			typeof record.subtype === "string" ? record.subtype : "system";
		return [
			{
				entryId: uuid,
				tsMs,
				role: "system",
				text: subtype,
				tool: null,
				partial: false,
			},
		];
	}

	const message = asRecord(record.message);
	if (message === null) return [];
	const role: TranscriptRole = type === "user" ? "user" : "assistant";
	const content = message.content;

	if (typeof content === "string") {
		if (content.length === 0) return [];
		return [
			{ entryId: uuid, tsMs, role, text: content, tool: null, partial: false },
		];
	}
	if (!Array.isArray(content)) return [];

	const entries: TranscriptEntry[] = [];
	let blockIndex = 0;
	for (const rawBlock of content) {
		const block = asRecord(rawBlock);
		if (block === null) continue;
		const blockType = block.type;
		const entryId = blockIndex === 0 ? uuid : `${uuid}:${blockIndex}`;
		blockIndex++;

		if (blockType === "text" && typeof block.text === "string") {
			if (block.text.length === 0) continue;
			entries.push({
				entryId,
				tsMs,
				role,
				text: block.text,
				tool: null,
				partial: false,
			});
			continue;
		}

		if (blockType === "tool_use") {
			const name = typeof block.name === "string" ? block.name : "tool";
			const id = typeof block.id === "string" ? block.id : null;
			if (id !== null) toolNameById.set(id, name);
			entries.push({
				entryId,
				tsMs,
				role: "tool",
				text: null,
				tool: toolDetailFromInput(name, block.input),
				partial: false,
			});
			continue;
		}

		if (blockType === "tool_result") {
			const id =
				typeof block.tool_use_id === "string" ? block.tool_use_id : null;
			const name =
				(id !== null ? toolNameById.get(id) : undefined) ?? "tool_result";
			entries.push({
				entryId,
				tsMs,
				role: "tool",
				text: null,
				tool: toolDetailFromResult(
					name,
					block.content,
					block.is_error === true,
				),
				partial: false,
			});
		}
		// Any other block type (thinking, image, ...) is intentionally dropped.
	}

	return entries;
}

function stringifyPayload(value: unknown): string {
	if (typeof value === "string") return value;
	if (value === undefined) return "";
	try {
		return JSON.stringify(value) ?? "";
	} catch {
		return "";
	}
}

function toolDetailFromInput(
	name: string,
	input: unknown,
): TranscriptToolDetail {
	const inputRecord = asRecord(input);
	// Prefer the field the tool itself uses as its human summary; fall back to
	// the serialized input rather than inventing a description.
	const candidate =
		inputRecord !== null &&
		typeof inputRecord.description === "string" &&
		inputRecord.description.length > 0
			? inputRecord.description
			: stringifyPayload(input);
	const full = stringifyPayload(input);
	return {
		name,
		summary: firstLine(candidate, HEADLINE_MAX_CHARS),
		detail: full.length === 0 ? null : clampChars(full, TOOL_DETAIL_MAX_CHARS),
		detailTruncated: full.length > TOOL_DETAIL_MAX_CHARS,
	};
}

function toolDetailFromResult(
	name: string,
	content: unknown,
	isError: boolean,
): TranscriptToolDetail {
	let text: string;
	if (Array.isArray(content)) {
		text = content
			.map((part) => {
				const block = asRecord(part);
				return block !== null && typeof block.text === "string"
					? block.text
					: "";
			})
			.filter((s) => s.length > 0)
			.join("\n");
	} else {
		text = stringifyPayload(content);
	}
	const prefix = isError ? "error: " : "";
	return {
		name,
		summary: `${prefix}${firstLine(text, HEADLINE_MAX_CHARS)}`,
		detail: text.length === 0 ? null : clampChars(text, TOOL_DETAIL_MAX_CHARS),
		detailTruncated: text.length > TOOL_DETAIL_MAX_CHARS,
	};
}

/**
 * GUARD 1 (§11.3). Scan the tail of the transcript for a `tool_result` block
 * carrying `toolUseId`.
 *
 * Tri-state and fail-closed: an unreadable, missing or rotated transcript
 * returns `unreadable`, which callers MUST treat as a refusal. Collapsing it to
 * `unresolved` would turn "I could not check" into "it is safe to type", which
 * is precisely the failure this guard exists to prevent.
 *
 * (TRANSCRIPT-PATH-DERIVED) ABSENCE OF EVIDENCE IS NOT EVIDENCE OF ABSENCE.
 * `unresolved` — the ONLY verdict that permits a keystroke — now requires the
 * matching `tool_use` block to have been POSITIVELY OBSERVED in the scan
 * window. It used to be returned for any file in which the id simply did not
 * appear, so an empty file (or any file smaller than the scan window that never
 * mentions the id) reported "still unanswered" and guard 1 passed for a
 * question that was never asked. A file that does not contain the tool call is
 * now `unreadable`.
 */
export async function findToolResultInTranscript(
	transcriptPath: string,
	toolUseId: string,
): Promise<TranscriptVerdict> {
	let handle: fs.FileHandle | undefined;
	try {
		handle = await fs.open(transcriptPath, "r");
		const stat = await handle.stat();
		if (stat.size === 0) return "unreadable";
		const length = Math.min(stat.size, TOOL_RESULT_SCAN_BYTES);
		const start = stat.size - length;
		const buf = Buffer.alloc(length);
		await handle.read(buf, 0, length, start);

		const { records } = parseJsonlRegion(buf, start, {
			dropFirstFragment: start > 0,
		});
		let sawToolUse = false;
		for (const { record } of records) {
			const message = asRecord(record.message);
			if (message === null) continue;
			const content = message.content;
			if (!Array.isArray(content)) continue;
			for (const rawBlock of content) {
				const block = asRecord(rawBlock);
				if (block === null) continue;
				if (block.type === "tool_use" && block.id === toolUseId) {
					sawToolUse = true;
					continue;
				}
				if (block.type !== "tool_result") continue;
				if (block.tool_use_id === toolUseId) return "resolved";
			}
		}
		// The tool call itself is not in the window. We cannot say this question
		// was ever asked in this transcript, so we cannot say it is unanswered.
		if (!sawToolUse) return "unreadable";
		// The call is here and its result is not.
		return "unresolved";
	} catch {
		return "unreadable";
	} finally {
		await handle?.close().catch(() => {});
	}
}

/**
 * (RECONCILE-STAT-CACHE) The identity of a transcript file at the moment a
 * verdict was computed from it, plus that verdict.
 *
 * A transcript is append-only, and `findToolResultInTranscript` is a pure
 * function of (file bytes, toolUseId). So if the file is byte-for-byte the one
 * a verdict was already computed from, re-reading up to 8 MiB of it and
 * re-parsing the JSONL produces the same answer — which is what the 60-second
 * heartbeat was doing, once per pending question, forever.
 *
 * ALL FOUR FIELDS ARE REQUIRED and equality must be exact. `size` alone would
 * accept a file that was truncated and rewritten to the same length; `(dev,
 * ino)` catches a replaced file; `mtimeNs` catches a same-length in-place
 * rewrite. Anything that does not match exactly — including a file that SHRANK,
 * which is not something an append-only log does — invalidates the mark and
 * forces the full scan. `bigint: true` because a 64-bit inode does not survive
 * a JS number on win32.
 */
interface TranscriptScanMark {
	dev: bigint;
	ino: bigint;
	size: bigint;
	mtimeNs: bigint;
	verdict: TranscriptVerdict;
}

/**
 * (QUESTION-EXPIRY) How long a question's terminal must have been PROVABLY GONE
 * — across two separate reconcile passes, not merely twice inside one — before
 * the question is settled `stale`.
 *
 * Five minutes, the same separation the reaper's reverse walk requires before
 * it corrects a row, and for the same reason: the evidence is one `daemon.list()`
 * per pass, a partially-populated one is a thing that happens, and the cost of
 * believing a bad one is not symmetric. There it is a live terminal losing its
 * place in the session list; here it is a live blocked agent losing its only
 * wrist surface, permanently, because `settle(stale)` cannot be undone.
 *
 * It costs nothing that matters. The rows this exists to clear had been dead for
 * up to 77 days; a question whose terminal really is gone is expired on the next
 * heartbeat after the window instead of this one, and until then it behaves
 * exactly as it did before the feature existed. The heartbeat runs every 60 s
 * foreground / 300 s background, so this is never fewer than two passes and is
 * usually several.
 */
export const QUESTION_EXPIRY_CORROBORATION_MS = 300_000;

/**
 * (TREE-FRESHNESS-GSEQ) Why `(QUESTION-EXPIRY)` settles a question `stale`, in
 * the words that go on the wire.
 *
 * A constant rather than a literal at each site because `markStale` LOGS the
 * reason and does not store it (a write-only field on the record is worse than
 * no field), so the frame published when a settle happens cannot read it back
 * off the record and has to name the same string the caller passed. One
 * definition is what keeps those two from drifting into a `question.stale`
 * frame that explains a different expiry than the one that occurred.
 */
export const QUESTION_STALE_TERMINAL_GONE_REASON =
	"the terminal this question was asked in no longer exists";

/**
 * (RECONCILE-STAT-CACHE) One stat, or `null` when there is nothing to compare.
 *
 * A failed stat is NOT swallowed into a verdict — it returns `null`, which makes
 * the caller take the full scan, and the full scan reports `unreadable` on its
 * own terms. The only thing lost here is the cheap proof that a re-read can be
 * skipped.
 */
async function markTranscript(
	transcriptPath: string,
): Promise<Omit<TranscriptScanMark, "verdict"> | null> {
	if (transcriptPath.length === 0) return null;
	try {
		const stat = await fs.stat(transcriptPath, { bigint: true });
		if (!stat.isFile()) return null;
		return {
			dev: stat.dev,
			ino: stat.ino,
			size: stat.size,
			mtimeNs: stat.mtimeNs,
		};
	} catch {
		return null;
	}
}

function sameTranscriptFile(
	mark: TranscriptScanMark,
	current: Omit<TranscriptScanMark, "verdict">,
): boolean {
	return (
		mark.dev === current.dev &&
		mark.ino === current.ino &&
		mark.size === current.size &&
		mark.mtimeNs === current.mtimeNs
	);
}

// ---------------------------------------------------------------------------
// answerability
// ---------------------------------------------------------------------------

function agentKindOf(agentId: string | null): QuestionAgentKind {
	// (BRIDGE-AGENT-KIND) One rule, shared with the answer path's binding check.
	return agentKindFromAgentId(agentId);
}

/** Which capabilities a given prompt shape needs before a phone may answer it. */
function requiredCapabilities(questions: QuestionItem[]): Capability[] {
	const needed: Capability[] = ["answer.single"];
	if (questions.length > 1) needed.push("answer.multi_question");
	if (questions.some((q) => q.multiSelect)) needed.push("answer.multiselect");
	return needed;
}

/**
 * (SHAPE-UNPROVEN-UPFRONT) Does this prompt have a shape the fork has no proven
 * byte sequence for?
 *
 * This is the SAME classification `keystrokes.ts` `classifyAnswerShape` applies
 * at submit time, hoisted to the point where the client decides whether to offer
 * the prompt at all. It is deliberately a duplicate of that rule and not a call
 * into it: the encoder classifies a (questions, answers) PAIR and needs answers
 * that do not exist yet here. Both must stay in step — if `classifyAnswerShape`
 * ever proves a new shape, this must stop refusing it, or the bridge will hide a
 * prompt it can now drive.
 *
 * The proven shapes are: one question (select / multiselect / freetext), and N>1
 * questions where EVERY item is a plain single select. A `multiSelect` item
 * inside an N>1 prompt has no proven sequence — `validateAnswerItems` refuses to
 * coerce `"select"` onto a multiSelect item, so such an item can only be
 * answered with `kind: "multiselect"`, which `classifyAnswerShape` then refuses
 * with `shape_unproven`.
 *
 * Before this check the phone and watch showed the prompt as answerable, the
 * user read it, picked an answer for every question, submitted, and only THEN
 * got a 501. The refusal was correct — guessing a byte sequence against a live
 * picker is unrecoverable — but it arrived after all of the work. Nothing about
 * the refusal changes here; only its timing.
 *
 * `freeTextOption` needs no companion check: `deriveFreeTextOption` already
 * returns `null` for every N>1 prompt, so no free-text slot is ever offered in a
 * shape where free text is unproven.
 */
function hasUnprovenAnswerShape(questions: QuestionItem[]): boolean {
	if (questions.length <= 1) return false;
	return questions.some((q) => q.multiSelect);
}

// ---------------------------------------------------------------------------
// the store
// ---------------------------------------------------------------------------

export function createQuestionStore(deps: QuestionStoreDeps): QuestionStore {
	const byId = new Map<QuestionId, PendingQuestion>();
	/** host terminal id -> questionId of the record currently `pending` there. */
	const pendingByHostTerminal = new Map<string, QuestionId>();
	/**
	 * (RECONCILE-STAT-CACHE) The verdict `reconcile()` last computed for a
	 * question, together with the identity of the transcript file it computed it
	 * from. Rebuilt from scratch on every pass, so it holds at most one entry per
	 * CURRENTLY pending question and cannot outlive one.
	 *
	 * This is ONLY consulted by `reconcile()`. `verifyResolvedInTranscript` — the
	 * guard-1 entry point — never reads it and never will: the per-keystroke guard
	 * re-run is an explicit design mandate and a cached verdict there would be a
	 * check that did not happen.
	 */
	let reconcileMarks = new Map<QuestionId, TranscriptScanMark>();

	/**
	 * (QUESTION-EXPIRY) questionId -> the instant this pass first saw its
	 * terminal as provably gone. Built fresh and swapped in exactly like
	 * `reconcileMarks`, so a question that recovers — or that settles by any
	 * other route — silently drops its candidacy and starts from zero if it ever
	 * comes back.
	 *
	 * This is the corroboration `markStale` cannot supply for itself: the verdict
	 * it acts on is terminal, and one daemon listing is one fallible observation.
	 */
	let staleCandidates = new Map<QuestionId, number>();

	function mintQuestionId(
		toolUseId: string,
		sessionId: string,
		askedAtMs: number,
	): QuestionId {
		const h = createHash("sha256");
		h.update("sc/v1 questionId", "utf8");
		h.update(Buffer.of(0x00));
		h.update(toolUseId, "utf8");
		h.update(Buffer.of(0x00));
		h.update(sessionId, "utf8");
		h.update(Buffer.of(0x00));
		h.update(String(askedAtMs), "utf8");
		return b64url(h.digest().subarray(0, 16));
	}

	/**
	 * (SETTLE-CHOKE-POINT) The ONLY writer of a terminal state, which is what
	 * makes `deps.onSettled` unmissable — see the dep's docblock.
	 *
	 * The notification never throws into the settle. Settling has already
	 * happened by the time it runs, so a sink that throws would leave the record
	 * terminal while telling `resolve()`/`markStale()`/`capture()` they failed —
	 * and on the answer path that caller has already typed into a terminal. A
	 * failed retraction is one notification that outlives its subject; a thrown
	 * settle is an answer the bridge reports as failed after injecting it.
	 */
	function settle(
		question: PendingQuestion,
		state: Exclude<QuestionState, "pending">,
	): void {
		question.state = state;
		const current = pendingByHostTerminal.get(question.hostTerminalId);
		if (current === question.questionId) {
			pendingByHostTerminal.delete(question.hostTerminalId);
		}
		try {
			deps.onSettled(question);
		} catch (error) {
			console.error(
				"[companion-bridge] a settled-question sink threw; anything it drives (the push retraction above all) did not happen for this question",
				{ questionId: question.questionId, state, error },
			);
		}
	}

	function prune(nowMs: EpochMs): void {
		for (const [id, question] of byId) {
			if (question.state === "pending") continue;
			const settledAt = question.resolvedAtMs ?? question.askedAtMs;
			if (nowMs - settledAt > QUESTION_RETENTION_MS) byId.delete(id);
		}
	}

	/**
	 * (CAPTURE-EVICTION) Tier 2. Drops the oldest SETTLED records until the store
	 * is at or under `target`, and reports how many it dropped so the caller can
	 * tell a flood from a machine full of blocked agents. Pending records are
	 * never candidates.
	 */
	function evictOldestSettled(target: number): number {
		if (byId.size <= target) return 0;
		const settled: PendingQuestion[] = [];
		for (const question of byId.values()) {
			if (question.state !== "pending") settled.push(question);
		}
		settled.sort(
			(a, b) =>
				(a.resolvedAtMs ?? a.askedAtMs) - (b.resolvedAtMs ?? b.askedAtMs),
		);
		let evicted = 0;
		for (const question of settled) {
			if (byId.size <= target) break;
			byId.delete(question.questionId);
			evicted += 1;
		}
		return evicted;
	}

	function headline(question: PendingQuestion): string {
		const first = question.questions[0];
		if (first === undefined) {
			throw new Error(
				`companion: question ${question.questionId} has no items — capture should have rejected it`,
			);
		}
		return clampChars(first.header, HEADLINE_MAX_CHARS);
	}

	/**
	 * (TREE-FRESHNESS-GSEQ) See the interface. Fails CLOSED — `null` rather than
	 * a summary carrying a guessed project or workspace handle.
	 */
	function summarize(
		question: PendingQuestion,
		ctx: AnswerabilityContext,
	): QuestionSummary | null {
		let source: QuestionSource;
		try {
			source = resolveSource(question);
		} catch {
			return null;
		}
		return {
			questionId: question.questionId,
			fingerprint: question.fingerprint,
			terminalId: source.terminalId,
			workspaceId: source.workspaceId,
			projectId: source.projectId,
			askedAtMs: question.askedAtMs as EpochMs,
			questionCount: question.questions.length,
			multiSelect: question.questions.some((item) => item.multiSelect),
			answerable: unanswerableReason(question, ctx) === null,
			headline: headline(question),
		};
	}

	function unanswerableReason(
		question: PendingQuestion,
		ctx: AnswerabilityContext,
	): UnanswerableReason | null {
		if (question.state === "resolved") return "resolved";
		if (question.state !== "pending") return "stale";
		// v1 never grants `agent.codex`: the Codex byte contract is not
		// established, and a wrong keystroke against a picker is unrecoverable.
		if (question.agentKind === "codex") return "codex_agent";
		if (question.agentKind !== "claude") return "no_agent_binding";
		if (!ctx.granted.includes("agent.claude")) return "capability_missing";
		for (const needed of requiredCapabilities(question.questions)) {
			if (!ctx.granted.includes(needed)) return "capability_missing";
		}
		// (SHAPE-UNPROVEN-UPFRONT) Granted capabilities are not enough: the prompt
		// also has to be a shape this fork has actually driven against a live
		// picker. See `hasUnprovenAnswerShape`.
		//
		// HONEST LIMIT ON THE WIRE VALUE: the accurate reason is "this shape has no
		// proven byte sequence", and `UnanswerableReason` (types.ts, PROTOCOL.md
		// §7.4) has no such member, so it is reported as `capability_missing`. That
		// is the same category the submit-time refusal already uses — `answer.ts`
		// answers this exact shape with `501 capability_unsupported`,
		// `detail: { capability: "answer.multiselect", reason: "shape_unproven" }` —
		// so the client's user-visible outcome is unchanged and only its timing
		// moves. It IS misleading to a human debugging grants, which is why adding a
		// distinct `shape_unproven` member to the enum (types.ts + PROTOCOL.md §7.4
		// + the Kotlin `UnanswerableReason`, which already tolerates unknown wire
		// strings via its UNKNOWN member) is the follow-up.
		if (hasUnprovenAnswerShape(question.questions)) return "capability_missing";
		// A missing `answer.freetext` grant does NOT make the prompt
		// unanswerable — every listed option is still selectable; only the
		// free-text slot is unavailable, and the client disables that control.
		return null;
	}

	function resolveSource(question: PendingQuestion): QuestionSource {
		const resolved = deps.source.resolveTerminal(question.hostTerminalId);
		const hostProjectId = resolved?.hostProjectId;
		if (hostProjectId === undefined) {
			throw new Error(
				`companion: terminal ${question.hostTerminalId} is not in host.db — cannot build QuestionSource`,
			);
		}
		return {
			projectId: deriveHandle("project", hostProjectId) as ProjectId,
			workspaceId: deriveHandle(
				"workspace",
				question.hostWorkspaceId,
			) as WorkspaceId,
			terminalId: question.terminalId,
			agentKind: question.agentKind,
			subagent:
				question.agentType === null ? null : { agentType: question.agentType },
		};
	}

	const store: QuestionStore = {
		capture(input) {
			if (input.questions.length === 0) {
				throw new CaptureRejectedError("questions", "must not be empty");
			}
			const terminalId = deriveHandle(
				"terminal",
				input.hostTerminalId,
			) as TerminalId;
			const questionId = mintQuestionId(
				input.toolUseId,
				input.sessionId,
				input.askedAtMs,
			);
			const existing = byId.get(questionId);
			if (existing !== undefined) return existing;

			// (CAPTURE-BOUNDED) Validate at the boundary: the capture must name a
			// terminal host.db actually has, joined to the workspace that owns it.
			//
			// The agent KIND comes from that same binding, never from the hook
			// payload: the payload's `agentId` is the SUBAGENT id, and letting an
			// unauthenticated caller declare "this is a Claude terminal" would put
			// the codex/claude answerability decision inside the attacker's reach.
			//
			// Requiring the row to EXIST is what bounds the store by something real.
			// Without it, `hostTerminalId` was a free-form attacker-chosen string, so
			// the pending set had no relationship to the machine at all — and such a
			// record was unusable anyway: `resolveSource` throws for it, so every
			// `/v1/question` and every summary projection over it failed. Rejecting
			// it here turns a late, obscure 500 into a loud refusal at the door.
			const binding = deps.source.resolveActiveTerminal(input.hostTerminalId);
			if (binding === null) {
				throw new CaptureRejectedError(
					"hostTerminalId",
					"names no active terminal joined to a workspace in host.db; refusing to track a question that cannot be projected",
				);
			}

			// (CAPTURE-BOUNDED) Reclaim first, then refuse. `prune` is otherwise only
			// reached from `reconcile`, which needs a paired device to be polling —
			// so without this the only bound on the map was "a phone showed up".
			prune(Date.now());
			if (byId.size >= MAX_TRACKED_QUESTIONS) {
				// (CAPTURE-EVICTION) Tier 2 before tier 3: history yields to a live
				// question, never the other way round.
				const evicted = evictOldestSettled(MAX_TRACKED_QUESTIONS - 1);
				if (evicted > 0) {
					console.warn(
						`[companion-bridge] question store hit its ${MAX_TRACKED_QUESTIONS}-record cap; evicted ${evicted} settled record(s) to make room. Settled records are history — an evicted one can no longer answer "already_resolved". A sustained rate here means something is minting captures.`,
					);
				}
			}
			if (byId.size >= MAX_TRACKED_QUESTIONS) {
				throw new CaptureRejectedError(
					"capture",
					`the question store already holds ${byId.size} records (cap ${MAX_TRACKED_QUESTIONS}) and every one of them is still pending; refusing to grow`,
				);
			}

			// (TRANSCRIPT-PATH-DERIVED) Guard 1's file is chosen HERE, from host.db,
			// and never by the caller. `null` -> empty -> guard 1 is `unreadable` ->
			// the answer path refuses. The hook's own claim is kept only so a
			// mismatch is investigable.
			const derivedTranscriptPath =
				deps.source.resolveTranscriptPath(input.hostTerminalId) ?? "";
			if (
				derivedTranscriptPath.length > 0 &&
				path.resolve(derivedTranscriptPath).toLowerCase() !==
					path.resolve(input.transcriptPath).toLowerCase()
			) {
				// LOUD. Either the hook is lying about which conversation this is, or
				// the derivation is wrong for this machine. Both need a human; neither
				// changes which file the guard reads.
				console.warn(
					"[companion-bridge] transcript path mismatch: the hook claimed a different file than host.db derives; using the derived one",
					{
						hostTerminalId: input.hostTerminalId,
						derived: derivedTranscriptPath,
						claimed: input.transcriptPath,
					},
				);
			}

			// (HOOK-CLAIM-NOT-TRUSTED) host.db's value, never the hook's. Same rule
			// as the transcript path directly above, applied to the other field the
			// hook also claims: `resolveActiveTerminal` has just returned this
			// terminal's `hostWorkspaceId` from the database, and storing
			// `input.workspaceId` instead let an unauthenticated localhost POST
			// choose which workspace a question belongs to. It decides which thread
			// the phone opens, and it is the id `(PUSH-CURATION-GATE)` asks curation
			// about — so a wrong one buzzes about, and opens, somebody else's thread.
			// The claim is kept only so a mismatch is investigable.
			if (input.workspaceId !== binding.hostWorkspaceId) {
				console.warn(
					"[companion-bridge] workspace mismatch: the hook claimed a different workspace than host.db derives for this terminal; using the derived one",
					{
						hostTerminalId: input.hostTerminalId,
						derived: binding.hostWorkspaceId,
						claimed: input.workspaceId,
					},
				);
			}

			const question: PendingQuestion = {
				questionId,
				fingerprint: computeFingerprint({
					toolUseId: input.toolUseId,
					sessionId: input.sessionId,
					terminalId,
					questions: input.questions,
				}),
				state: "pending",
				askedAtMs: input.askedAtMs,
				resolvedAtMs: null,
				resolvedBy: null,
				toolUseId: input.toolUseId,
				sessionId: input.sessionId,
				terminalId,
				agentType: input.agentType,
				questions: input.questions,
				origin: "unauthenticated_localhost_hook",
				hostTerminalId: input.hostTerminalId,
				hostWorkspaceId: binding.hostWorkspaceId,
				transcriptPath: derivedTranscriptPath,
				agentKind: agentKindOf(binding.agentId),
				agentId: input.agentId,
			};
			byId.set(questionId, question);

			// A new question on a terminal supersedes any earlier one still marked
			// pending there: the picker can only show one prompt at a time, so the
			// older record is by construction no longer on screen.
			const superseded = pendingByHostTerminal.get(input.hostTerminalId);
			if (superseded !== undefined && superseded !== questionId) {
				const prior = byId.get(superseded);
				if (prior !== undefined && prior.state === "pending") {
					// The reason is LOGGED, not stored: nothing ever read it back off
					// the record, so keeping it there made a write-only field look like
					// state something depended on.
					console.info(
						"[companion-bridge] question superseded by a newer question on this terminal",
						{
							hostTerminalId: input.hostTerminalId,
							supersededQuestionId: superseded,
							questionId,
						},
					);
					// (SETTLE-CHOKE-POINT) Through `settle()`, never by assigning
					// `state` here. This branch used to write the field directly, so a
					// question the user never saw again kept its notification on the
					// watch: the prior record left `pending` without any of the effects
					// leaving `pending` is supposed to have. `settle()` also drops the
					// terminal's pending mapping, which the line below immediately
					// re-points at the new question.
					settle(prior, "stale");
				}
			}
			pendingByHostTerminal.set(input.hostTerminalId, questionId);
			return question;
		},

		asCaptureSink() {
			return {
				capture: (input) => {
					store.capture(validateCapture(input));
				},
				resolve: (input) => {
					const hostTerminalId = requireString(
						(input as { hostTerminalId?: unknown }).hostTerminalId,
						"hostTerminalId",
						{ maxChars: MAX_ID_CHARS },
					);
					const toolUseId = requireString(
						(input as { toolUseId?: unknown }).toolUseId,
						"toolUseId",
						{ maxChars: MAX_ID_CHARS },
					);
					const resolvedAtMs = requirePositiveInt(
						(input as { resolvedAtMs?: unknown }).resolvedAtMs,
						"resolvedAtMs",
					);
					const question = store.byHostTerminal(hostTerminalId);
					// A resolution for a question we never captured, or for a
					// different one than is open, is dropped rather than guessed at.
					if (question === null || question.toolUseId !== toolUseId) return;
					store.resolve(
						question.questionId,
						{ deviceLabel: null, surface: "desktop" },
						resolvedAtMs,
					);
				},
			};
		},

		get(questionId) {
			return byId.get(questionId) ?? null;
		},

		byTerminal(terminalId) {
			for (const questionId of pendingByHostTerminal.values()) {
				const question = byId.get(questionId);
				if (question !== undefined && question.terminalId === terminalId) {
					return question;
				}
			}
			return null;
		},

		byHostTerminal(hostTerminalId) {
			const questionId = pendingByHostTerminal.get(hostTerminalId);
			if (questionId === undefined) return null;
			return byId.get(questionId) ?? null;
		},

		listPending() {
			const out: PendingQuestion[] = [];
			for (const questionId of pendingByHostTerminal.values()) {
				const question = byId.get(questionId);
				if (question !== undefined && question.state === "pending") {
					out.push(question);
				}
			}
			out.sort((a, b) => a.askedAtMs - b.askedAtMs);
			return out;
		},

		resolve(questionId, resolvedBy, atMs) {
			const question = byId.get(questionId);
			if (question === undefined) {
				throw new Error(`companion: resolve on unknown question ${questionId}`);
			}
			if (question.state === "resolved") return false;
			// `markStale` already refuses to move a non-pending record; `resolve` has
			// to match, or the two disagree about whether `stale` is terminal. It is:
			// `settle()` has already removed a stale record from
			// `pendingByHostTerminal`, and re-labelling it `resolved` with a device's
			// provenance records an answer that device never gave.
			if (question.state !== "pending") return false;
			question.resolvedAtMs = atMs;
			question.resolvedBy = resolvedBy;
			settle(question, "resolved");
			return true;
		},

		markStale(questionId, reason) {
			const question = byId.get(questionId);
			if (question === undefined) {
				throw new Error(
					`companion: markStale on unknown question ${questionId}`,
				);
			}
			if (question.state !== "pending") return;
			// LOGGED, not stored. The reason was a write-only field on the record;
			// the caller's diagnostic is worth keeping, the dead field is not.
			console.info("[companion-bridge] question marked stale", {
				questionId,
				reason,
			});
			settle(question, "stale");
		},

		async verifyResolvedInTranscript(question) {
			// GUARD 1. UNCACHED, ALWAYS, BY MANDATE. (RECONCILE-STAT-CACHE) memoises
			// the HEARTBEAT's use of this scan; this entry point is the one the
			// per-keystroke guard stack calls, and every keystroke must re-read the
			// file. Do not route it through the mark cache.
			if (question.transcriptPath.length === 0) return "unreadable";
			return findToolResultInTranscript(
				question.transcriptPath,
				question.toolUseId,
			);
		},

		async reconcile(nowMs) {
			const settled: QuestionId[] = [];
			// (RECONCILE-STAT-CACHE) Built fresh and swapped in at the end, so the
			// surviving marks are exactly the ones for questions still pending when
			// this pass ran. Nothing has to remember to evict — including the
			// supersede path, which retires a record without going through
			// `settle()`.
			const marks = new Map<QuestionId, TranscriptScanMark>();
			// (QUESTION-EXPIRY) Same rebuild-and-swap discipline as `marks`.
			const nextStaleCandidates = new Map<QuestionId, number>();
			for (const question of store.listPending()) {
				const current = await markTranscript(question.transcriptPath);
				const previous = reconcileMarks.get(question.questionId);
				let verdict: TranscriptVerdict;
				if (
					current !== null &&
					previous !== undefined &&
					sameTranscriptFile(previous, current)
				) {
					// Byte-identical file, same tool call: the scan cannot say anything
					// it did not already say. RECONCILE-RETRACT semantics are unchanged —
					// the verdict acted on below is the same one a re-read would produce.
					verdict = previous.verdict;
				} else {
					verdict = await store.verifyResolvedInTranscript(question);
				}
				if (current !== null) {
					marks.set(question.questionId, { ...current, verdict });
				}
				// `unreadable` deliberately does nothing: it is "I could not check",
				// and treating it as either answer would be inventing a fact.
				if (verdict !== "resolved") {
					// (QUESTION-EXPIRY) The transcript says nothing — but does the
					// terminal still exist?
					//
					// `reconcile` used to settle on a `tool_result` and nothing else, so
					// a question whose terminal was killed by a pane close, a quit or a
					// crash stayed PENDING forever: it kept its armed push (which fires
					// on presence lapse, not on a short timer, so the window is
					// unbounded), kept growing `oldestUnansweredMs` while `counts`
					// reported zero blocked agents, and kept a slot against the
					// 512-record cap. Nothing in the system ever asked whether the
					// terminal was still there.
					//
					// `stale` rather than `resolved` because nobody answered it. It is
					// terminal, it makes `unanswerableReason` say so, and returning the
					// id here routes it through the existing `onQuestionsSettled` ->
					// `push.cancelPending` wiring, which is what retracts a notification
					// already sitting on the phone.
					//
					// Ordering: the transcript is consulted FIRST, so a question the
					// user answered at the desk moments before closing the pane is
					// recorded as `resolved` with its real provenance rather than being
					// flattened into `stale`.
					//
					// TWO INDEPENDENT OBSERVATIONS, `QUESTION_EXPIRY_CORROBORATION_MS`
					// apart, and the strict predicate for each. `settle(stale)` is
					// terminal — `markStale` refuses to move a non-pending record and
					// the retraction it triggers is a push already pulled off the
					// phone — so this decision has exactly the shape the reaper's
					// reverse walk refuses to take on one `daemon.list()`. It costs a
					// live blocked agent its only wrist surface, which is the one
					// failure this feature cannot absorb, so it is held to the same bar:
					// positive evidence (never `!isLive`), the row's own activity grace
					// so a terminal born after the snapshot cannot lose that race, and
					// the same verdict again on a later pass.
					const activityMs = deps.source.resolveTerminalActivityMs(
						question.hostTerminalId,
					);
					if (
						!deps.liveness.isProvablyGone(question.hostTerminalId, activityMs)
					) {
						continue;
					}
					const firstSeenGoneAtMs =
						staleCandidates.get(question.questionId) ?? nowMs;
					if (nowMs - firstSeenGoneAtMs < QUESTION_EXPIRY_CORROBORATION_MS) {
						// Carried forward, not acted on. The record stays pending and
						// keeps its armed push, exactly as it did before this feature.
						nextStaleCandidates.set(question.questionId, firstSeenGoneAtMs);
						continue;
					}
					store.markStale(
						question.questionId,
						QUESTION_STALE_TERMINAL_GONE_REASON,
					);
					settled.push(question.questionId);
					continue;
				}
				question.resolvedAtMs = nowMs;
				// Nothing paired resolved it — every device answer goes through
				// `resolve()` with its own provenance — so it was answered at the
				// desk (or the agent cancelled it).
				question.resolvedBy = { deviceLabel: null, surface: "desktop" };
				settle(question, "resolved");
				settled.push(question.questionId);
			}
			reconcileMarks = marks;
			staleCandidates = nextStaleCandidates;
			prune(nowMs);
			return settled;
		},

		oldestPendingAgeMs(nowMs) {
			const oldest = store.listPending()[0];
			if (oldest === undefined) return null;
			return Math.max(0, nowMs - oldest.askedAtMs);
		},

		async toResponse(question, ctx) {
			const source = resolveSource(question);
			let context: TranscriptEntry[] = [];
			if (question.transcriptPath.length > 0) {
				try {
					const window = await readTranscriptWindow({
						transcriptPath: question.transcriptPath,
						limit: QUESTION_CONTEXT_ENTRIES,
						beforeOffset: null,
					});
					context = window.entries;
				} catch {
					// An unreadable transcript costs the sheet its context; it must not
					// cost the user the question, which is the whole point of §7.4.
					context = [];
				}
			}
			const reason = unanswerableReason(question, ctx);
			return {
				questionId: question.questionId,
				fingerprint: question.fingerprint,
				state: question.state,
				askedAtMs: question.askedAtMs,
				resolvedAtMs: question.resolvedAtMs,
				resolvedBy: question.resolvedBy,
				source,
				answerable: reason === null,
				unanswerableReason: reason,
				questions: question.questions,
				context,
			};
		},

		headline,
		summarize,
		unanswerableReason,
	};

	return store;
}
