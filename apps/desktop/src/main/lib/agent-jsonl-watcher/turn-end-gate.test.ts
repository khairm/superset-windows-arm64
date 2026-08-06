import { beforeEach, describe, expect, test } from "bun:test";
import {
	classifyClaudeFailure,
	HALF_STOP_INCOMPLETE_TEXTS,
} from "../auto-resume/classifier/classifier";
import {
	isSyntheticApiAbortRecord,
	isSyntheticInterruptRecord,
	isToolUseContinuationRecord,
	judgeTurnEndRecord,
	mayBeTurnEndLine,
	parseTranscriptRecord,
	recordPredatesFence,
	resetTurnEndGate,
	TURN_END_MAX_AGE_MS,
	TURN_END_MAX_FUTURE_SKEW_MS,
} from "./turn-end-gate";

/**
 * (WATCHER-BLUE-STOMP) Fixture provenance, per fixture — the predicates here are
 * exact-shape checks, so it matters which lines are real and which are not.
 *
 * VERBATIM       — a real line from a transcript under ~/.claude/projects, with
 *                  only the bulky `usage` / `container` / `context_management`
 *                  fields removed. Every field the predicates read is untouched.
 * VERBATIM SHAPE — a real line's structure with its uuid replaced by a readable
 *                  placeholder (11111111-…), because the case it covers is about
 *                  the shape, not the identity.
 * CONSTRUCTED    — written for this test; no line like it exists in the corpus.
 *                  Each one says below why it is worth testing anyway.
 */

/** VERBATIM. The synthetic record for a plain user interrupt. */
const SENTINEL_LINE = `{"parentUuid":"d373b6fe-d081-4362-95c6-d5c969c68cae","isSidechain":false,"promptId":"01398ca7-096d-40ef-87e1-866af1c3013e","type":"user","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user]"}]},"uuid":"86ee37ea-f74d-486a-9d46-6ed6bcc91760","timestamp":"2026-07-18T11:30:35.597Z","interruptedMessageId":"msg_011Cd9SsXEScDPPN28ziVAw5","userType":"external","entrypoint":"cli","cwd":"C:\\\\Users\\\\khair","sessionId":"5e9203a5-ffbc-40b3-a9a4-13bccc5f74c4","version":"2.1.214","gitBranch":"HEAD"}`;

/** VERBATIM. The same record with the second sentinel wording. */
const SENTINEL_TOOL_USE_VARIANT = `{"parentUuid":"e09ef28c-3de8-4078-9884-810802fe9316","isSidechain":true,"type":"user","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user for tool use]"}]},"uuid":"bdb28d74-f5da-4aab-bb4d-2c222cd495ec","timestamp":"2026-07-20T09:30:44.872Z","userType":"external"}`;

/**
 * VERBATIM SHAPE. One of the 57 tool_results that quote the sentinel — the shape
 * that actually fired false turn-ends in the live watcher log.
 */
const QUOTED_IN_TOOL_RESULT = `{"parentUuid":"bc66154e-9ae3-46db-b774-23524f95a48c","isSidechain":false,"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_011N9byhftPBMoMwEmh5npy5","type":"tool_result","content":"\\"text\\":\\"[Request interrupted by user for tool use]\\"}]}"}]},"uuid":"11111111-1111-1111-1111-111111111111","timestamp":"2026-08-06T17:40:00.000Z","userType":"external"}`;

/**
 * VERBATIM SHAPE. The other false-positive shape: a teammate message pasted in
 * as a bare content STRING rather than a text block.
 */
const QUOTED_IN_TEAMMATE_MESSAGE = `{"parentUuid":"d6f2f4bc-f9f8-41e2-b46b-154f19de21ed","isSidechain":false,"type":"user","message":{"role":"user","content":"Another Claude session sent a message:\\n<agent-message from=\\"review-opus\\">\\nThe predicate matches any line containing Request interrupted by user, which is wrong.\\n</agent-message>"},"uuid":"22222222-2222-2222-2222-222222222222","timestamp":"2026-08-06T17:41:00.000Z","userType":"external"}`;

/**
 * VERBATIM. A real half-stop that ENDED its turn (the next record in that
 * transcript is a user prompt). The commonest of the three wordings: 16 records
 * in the corpus, CLI 2.1.205 – 2.1.222.
 */
const HALF_STOP_CONNECTION_CLOSED = `{"parentUuid":"2395766c-3d17-4c5f-b9e7-73916e978b85","isSidechain":false,"type":"assistant","uuid":"689f9df4-8198-47d0-a4b6-3d920080d3d7","timestamp":"2026-07-10T01:13:19.546Z","message":{"id":"17161c70-367b-4d87-b266-b9b4249a108e","model":"<synthetic>","role":"assistant","stop_details":null,"stop_reason":"stop_sequence","stop_sequence":"","type":"message","content":[{"type":"text","text":"API Error: Connection closed mid-response. The response above may be incomplete."}]},"error":"server_error","isApiErrorMessage":true,"session_id":"c78e3f27-f80d-46f3-8d92-0cc3b2070ce3","userType":"external","entrypoint":"cli","cwd":"C:\\\\Users\\\\khair","sessionId":"c78e3f27-f80d-46f3-8d92-0cc3b2070ce3","version":"2.1.206","gitBranch":"HEAD"}`;

/** VERBATIM. The stall wording, from a subagent transcript. 4 in the corpus. */
const HALF_STOP_STALLED = `{"parentUuid":"01d450ef-ca14-4ce9-b8d8-70cc2371f355","isSidechain":true,"agentId":"aspec-writer-019144ab61c4552e","type":"assistant","uuid":"f8c23efd-4880-4a33-988f-adc58200cc91","timestamp":"2026-07-27T22:08:10.631Z","message":{"id":"d820e451-ad4a-4cee-a2cd-dd19368e1b7b","model":"<synthetic>","role":"assistant","stop_details":null,"stop_reason":"stop_sequence","stop_sequence":"","type":"message","content":[{"type":"text","text":"API Error: Response stalled mid-stream. The response above may be incomplete."}]},"error":"server_error","isApiErrorMessage":true,"userType":"external","entrypoint":"cli","cwd":"C:\\\\Users\\\\khair","sessionId":"bb8514a8-a1db-42e3-b43b-33996dafd498","version":"2.1.220","gitBranch":"HEAD"}`;

/**
 * VERBATIM PAIR, adjacent lines 1703/1704 of one transcript. The CLI finalized a
 * partial response that had already yielded a tool call, so it stamped
 * `stop_reason:"tool_use"` and CARRIED ON — 0.3 s later the tool_result lands.
 * The api-error record looks identical to a real half-stop; only its predecessor
 * says the turn is still running.
 */
const CONTINUATION_PRIOR_TOOL_USE = `{"parentUuid":"5c5ed5ba-5a69-4056-b346-dba47b4361e7","isSidechain":false,"message":{"model":"claude-fable-5","id":"msg_011CcwPnMV2sqREzMwMfoaxi","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_01YRrf6nuNXyywrgLXSgRy3k","name":"TaskUpdate","input":{"taskId":"3","status":"completed"},"caller":{"type":"direct"}}],"stop_reason":"tool_use","stop_sequence":null,"stop_details":null},"requestId":"req_011CcwPnHrzam68a8w784JqN","type":"assistant","uuid":"1c300364-0fc5-4437-abf1-2233b49b64da","timestamp":"2026-07-12T02:44:38.547Z","sessionId":"b32f0f38-3bf8-4dfb-ae3a-8dc40f7cb0f1","version":"2.1.207","gitBranch":"HEAD"}`;

const CONTINUATION_HALF_STOP = `{"parentUuid":"1c300364-0fc5-4437-abf1-2233b49b64da","isSidechain":false,"type":"assistant","uuid":"c479800a-3974-4f18-aed9-e6e5210ae804","timestamp":"2026-07-12T02:44:38.553Z","message":{"id":"70d8506d-be6a-47b7-8cef-528e00b4f612","model":"<synthetic>","role":"assistant","stop_details":null,"stop_reason":"stop_sequence","stop_sequence":"","type":"message","content":[{"type":"text","text":"API Error: Server error mid-response. The response above may be incomplete."}]},"error":"server_error","isApiErrorMessage":true,"sessionId":"b32f0f38-3bf8-4dfb-ae3a-8dc40f7cb0f1","version":"2.1.207","gitBranch":"HEAD"}`;

/**
 * VERBATIM. A real api-error that is NOT a half-stop. The gate leaves this whole
 * class (5xx, rate limits, credit exhaustion, policy blocks) to Claude Code's
 * StopFailure hook — admitting it would only widen the destructive path.
 */
const API_ERROR_NOT_HALF_STOP = `{"parentUuid":"6dbe9406-8db7-43c7-9fc7-ac615092e315","isSidechain":false,"type":"assistant","uuid":"929a06b1-7733-40d0-9fae-e109fb486a15","timestamp":"2026-08-04T17:39:51.121Z","message":{"id":"4294bf46-abe6-4853-b97b-4ed4254ba7c3","model":"<synthetic>","role":"assistant","stop_details":null,"stop_reason":"stop_sequence","stop_sequence":"","type":"message","content":[{"type":"text","text":"API Error: 500 Anthropic error: {\\"type\\":\\"error\\",\\"error\\":{\\"type\\":\\"api_error\\",\\"message\\":\\"Internal server error\\"}}. This is a server-side issue, usually temporary — try again in a moment."}]},"error":"server_error","isApiErrorMessage":true,"apiErrorStatus":500,"sessionId":"b8875eb7-2dcc-4265-a5d1-85ef0d7569df","version":"2.1.221","gitBranch":"HEAD"}`;

/**
 * CONSTRUCTED. No transcript record has ever carried this text — the wording is
 * an internal `Error` message inside the CLI, not something it writes to a
 * transcript, which is why the signature list dropped it. Kept as a regression
 * test: if it ever starts matching again, the destructive path has re-widened.
 */
const LEGACY_SIGNATURE_LINE = `{"parentUuid":"2395766c-3d17-4c5f-b9e7-73916e978b85","isSidechain":false,"type":"assistant","isApiErrorMessage":true,"uuid":"33333333-3333-3333-3333-333333333333","timestamp":"2026-08-06T17:42:00.000Z","message":{"model":"<synthetic>","role":"assistant","type":"message","content":[{"type":"text","text":"API Error: Stream idle timeout - partial response received"}]}}`;

/**
 * VERBATIM SHAPE. A tool_result that cats a real api-error line, carrying both
 * the signature AND the `isApiErrorMessage` substring — the case that would slip
 * through a raw-substring predicate.
 */
const API_ABORT_QUOTED = `{"parentUuid":"ac237e0d-7854-48e5-915d-4433a11a62c4","isSidechain":false,"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_014XKMNdQhynKgHtQ1KtHJ2m","type":"tool_result","content":"    16 API Error: Connection closed mid-response. The response above may be incomplete.\\n   141 \\"isApiErrorMessage\\":true"}]},"uuid":"55555555-5555-5555-5555-555555555555","timestamp":"2026-08-06T17:44:00.000Z"}`;

function record(line: string) {
	const parsed = parseTranscriptRecord(line);
	if (!parsed) throw new Error("fixture failed to parse");
	return parsed;
}

/** `nowMs` such that the fixture's own timestamp is `ageMs` old. */
function nowFor(line: string, ageMs: number): number {
	const ts = record(line).timestamp;
	if (typeof ts !== "string") throw new Error("fixture has no timestamp");
	return Date.parse(ts) + ageMs;
}

/** Absolute epoch ms of a fixture's own timestamp. */
function stampOf(line: string): number {
	return nowFor(line, 0);
}

beforeEach(() => {
	resetTurnEndGate();
});

describe("turn-end identification", () => {
	test("the synthetic interrupt record is a turn-end", () => {
		expect(isSyntheticInterruptRecord(record(SENTINEL_LINE))).toBe(true);
		expect(isSyntheticInterruptRecord(record(SENTINEL_TOOL_USE_VARIANT))).toBe(
			true,
		);
	});

	test("a sentinel quoted inside a tool_result is NOT a turn-end", () => {
		expect(isSyntheticInterruptRecord(record(QUOTED_IN_TOOL_RESULT))).toBe(
			false,
		);
		expect(isSyntheticApiAbortRecord(record(QUOTED_IN_TOOL_RESULT))).toBe(
			false,
		);
	});

	test("a sentinel quoted inside a teammate message is NOT a turn-end", () => {
		expect(isSyntheticInterruptRecord(record(QUOTED_IN_TEAMMATE_MESSAGE))).toBe(
			false,
		);
	});

	test("a longer message that merely contains the sentinel is NOT a turn-end", () => {
		const embedded = record(
			JSON.stringify({
				type: "user",
				uuid: "66666666-6666-6666-6666-666666666666",
				timestamp: "2026-08-06T17:45:00.000Z",
				message: {
					role: "user",
					content: [
						{
							type: "text",
							text: "Here is what the transcript shows: [Request interrupted by user] — note the shape.",
						},
					],
				},
			}),
		);
		expect(isSyntheticInterruptRecord(embedded)).toBe(false);
	});

	test("a sentinel alongside a sibling block is NOT a turn-end", () => {
		const twoBlocks = record(
			JSON.stringify({
				type: "user",
				uuid: "77777777-7777-7777-7777-777777777777",
				timestamp: "2026-08-06T17:46:00.000Z",
				message: {
					role: "user",
					content: [
						{ type: "text", text: "[Request interrupted by user]" },
						{ type: "tool_result", tool_use_id: "toolu_x", content: "ok" },
					],
				},
			}),
		);
		expect(isSyntheticInterruptRecord(twoBlocks)).toBe(false);
	});

	test("a real half-stop record is a turn-end", () => {
		expect(isSyntheticApiAbortRecord(record(HALF_STOP_CONNECTION_CLOSED))).toBe(
			true,
		);
		expect(isSyntheticApiAbortRecord(record(HALF_STOP_STALLED))).toBe(true);
	});

	test("an api-error that is not a half-stop is NOT a turn-end", () => {
		expect(isSyntheticApiAbortRecord(record(API_ERROR_NOT_HALF_STOP))).toBe(
			false,
		);
	});

	test("the retired 'Stream idle timeout' wording no longer matches", () => {
		expect(isSyntheticApiAbortRecord(record(LEGACY_SIGNATURE_LINE))).toBe(
			false,
		);
	});

	test("an api-abort signature quoted in a tool_result is NOT a turn-end", () => {
		expect(isSyntheticApiAbortRecord(record(API_ABORT_QUOTED))).toBe(false);
		expect(isSyntheticInterruptRecord(record(API_ABORT_QUOTED))).toBe(false);
	});

	test("the cheap prefilter passes every candidate it is meant to", () => {
		for (const line of [
			SENTINEL_LINE,
			SENTINEL_TOOL_USE_VARIANT,
			HALF_STOP_CONNECTION_CLOSED,
			HALF_STOP_STALLED,
			QUOTED_IN_TOOL_RESULT,
		]) {
			expect(mayBeTurnEndLine(line)).toBe(true);
		}
		expect(mayBeTurnEndLine('{"type":"assistant","message":{}}')).toBe(false);
	});

	test("a malformed line yields no record rather than throwing", () => {
		expect(parseTranscriptRecord("{not json")).toBeNull();
		expect(parseTranscriptRecord("[1,2,3]")).toBeNull();
	});

	test("every shared half-stop text is what the auto-resume classifier calls a half_stop", () => {
		for (const text of HALF_STOP_INCOMPLETE_TEXTS) {
			expect(classifyClaudeFailure({ text: `API Error: ${text}` }).class).toBe(
				"half_stop",
			);
		}
	});
});

describe("tool-use continuation", () => {
	test("a half-stop finalized as a tool call is flagged by its predecessor", () => {
		// The abort record itself still LOOKS like a turn-end…
		expect(isSyntheticApiAbortRecord(record(CONTINUATION_HALF_STOP))).toBe(
			true,
		);
		// …and the record before it is what proves the turn carried on.
		expect(
			isToolUseContinuationRecord(record(CONTINUATION_PRIOR_TOOL_USE)),
		).toBe(true);
	});

	test("a real turn-ending half-stop is not itself a continuation", () => {
		expect(
			isToolUseContinuationRecord(record(HALF_STOP_CONNECTION_CLOSED)),
		).toBe(false);
		expect(isToolUseContinuationRecord(record(CONTINUATION_HALF_STOP))).toBe(
			false,
		);
	});

	test("only an assistant record with stop_reason tool_use counts", () => {
		expect(isToolUseContinuationRecord(record(QUOTED_IN_TOOL_RESULT))).toBe(
			false,
		);
		const endTurn = record(
			JSON.stringify({
				type: "assistant",
				uuid: "99999999-9999-9999-9999-999999999999",
				message: { role: "assistant", content: [], stop_reason: "end_turn" },
			}),
		);
		expect(isToolUseContinuationRecord(endTurn)).toBe(false);
	});
});

describe("replay gate", () => {
	test("a fresh sentinel is judged fresh", () => {
		const verdict = judgeTurnEndRecord(
			record(SENTINEL_LINE),
			nowFor(SENTINEL_LINE, 435),
		);
		expect(verdict.fresh).toBe(true);
		expect(verdict.reason).toBe("fresh");
		expect(verdict.ageMs).toBe(435);
		expect(verdict.uuid).toBe("86ee37ea-f74d-486a-9d46-6ed6bcc91760");
	});

	test("the same entry re-presented is suppressed on its uuid, at any age", () => {
		const rec = record(SENTINEL_LINE);
		expect(judgeTurnEndRecord(rec, nowFor(SENTINEL_LINE, 100)).fresh).toBe(
			true,
		);
		const replay = judgeTurnEndRecord(rec, nowFor(SENTINEL_LINE, 200));
		expect(replay.fresh).toBe(false);
		expect(replay.reason).toBe("replayed-uuid");
	});

	test("a sentinel older than the window is stale", () => {
		const verdict = judgeTurnEndRecord(
			record(SENTINEL_LINE),
			nowFor(SENTINEL_LINE, TURN_END_MAX_AGE_MS + 1),
		);
		expect(verdict.fresh).toBe(false);
		expect(verdict.reason).toBe("stale");
	});

	test("a sentinel exactly at the window is still fresh", () => {
		const verdict = judgeTurnEndRecord(
			record(SENTINEL_LINE),
			nowFor(SENTINEL_LINE, TURN_END_MAX_AGE_MS),
		);
		expect(verdict.fresh).toBe(true);
	});

	test("a small negative age (clock jitter) is still fresh", () => {
		const verdict = judgeTurnEndRecord(
			record(SENTINEL_LINE),
			nowFor(SENTINEL_LINE, -TURN_END_MAX_FUTURE_SKEW_MS),
		);
		expect(verdict.fresh).toBe(true);
	});

	test("a backward clock step does not resurrect history", () => {
		// The NTP-correction case: `now` jumps behind the whole transcript, so
		// every historical entry reads as negative-age. Without the clamp a
		// years-old interrupt would be judged fresh and emit a Stop.
		const verdict = judgeTurnEndRecord(
			record(SENTINEL_LINE),
			nowFor(SENTINEL_LINE, -365 * 24 * 60 * 60 * 1000),
		);
		expect(verdict.fresh).toBe(false);
		expect(verdict.reason).toBe("future-skew");
	});

	test("an undatable entry is suppressed", () => {
		const undatable = record(
			JSON.stringify({
				type: "user",
				uuid: "88888888-8888-8888-8888-888888888888",
				message: {
					role: "user",
					content: [{ type: "text", text: "[Request interrupted by user]" }],
				},
			}),
		);
		const verdict = judgeTurnEndRecord(undatable, Date.now());
		expect(verdict.fresh).toBe(false);
		expect(verdict.reason).toBe("undatable");
	});

	test("distinct entries are judged independently", () => {
		const a = judgeTurnEndRecord(
			record(SENTINEL_LINE),
			nowFor(SENTINEL_LINE, 100),
		);
		const b = judgeTurnEndRecord(
			record(SENTINEL_TOOL_USE_VARIANT),
			nowFor(SENTINEL_TOOL_USE_VARIANT, 100),
		);
		expect(a.fresh).toBe(true);
		expect(b.fresh).toBe(true);
	});

	test("resetTurnEndGate drops the uuid layer", () => {
		const rec = record(SENTINEL_LINE);
		expect(judgeTurnEndRecord(rec, nowFor(SENTINEL_LINE, 100)).fresh).toBe(
			true,
		);
		resetTurnEndGate();
		expect(judgeTurnEndRecord(rec, nowFor(SENTINEL_LINE, 100)).fresh).toBe(
			true,
		);
	});
});

describe("startup pre-start fence", () => {
	test("an entry written before the watcher started is suppressed, not stale", () => {
		// 61s old: young enough that the age layer would let it through, but it
		// predates the watcher, so the startup re-read must not announce it.
		const verdict = judgeTurnEndRecord(
			record(SENTINEL_LINE),
			nowFor(SENTINEL_LINE, 61_000),
			stampOf(SENTINEL_LINE) + 60_000,
		);
		expect(verdict.fresh).toBe(false);
		expect(verdict.reason).toBe("pre-start");
	});

	test("an entry written after the watcher started is fresh", () => {
		const verdict = judgeTurnEndRecord(
			record(SENTINEL_LINE),
			nowFor(SENTINEL_LINE, 500),
			stampOf(SENTINEL_LINE) - 60_000,
		);
		expect(verdict.fresh).toBe(true);
		expect(verdict.reason).toBe("fresh");
	});

	test("the fence gives the same slack the skew clamp does", () => {
		const rec = record(SENTINEL_LINE);
		const atSlack = judgeTurnEndRecord(
			rec,
			nowFor(SENTINEL_LINE, 500),
			stampOf(SENTINEL_LINE) + TURN_END_MAX_FUTURE_SKEW_MS,
		);
		expect(atSlack.fresh).toBe(true);
		resetTurnEndGate();
		const pastSlack = judgeTurnEndRecord(
			rec,
			nowFor(SENTINEL_LINE, 500),
			stampOf(SENTINEL_LINE) + TURN_END_MAX_FUTURE_SKEW_MS + 1,
		);
		expect(pastSlack.fresh).toBe(false);
		expect(pastSlack.reason).toBe("pre-start");
	});

	test("steady state (no fence) still emits a young entry", () => {
		// The live path: same entry, same age, fence off — this MUST emit, or the
		// gate would swallow every normal turn-end.
		const verdict = judgeTurnEndRecord(
			record(SENTINEL_LINE),
			nowFor(SENTINEL_LINE, 61_000),
			null,
		);
		expect(verdict.fresh).toBe(true);
	});

	test("a fenced entry is still remembered, so a later unfenced re-read cannot fire it", () => {
		const rec = record(SENTINEL_LINE);
		expect(
			judgeTurnEndRecord(
				rec,
				nowFor(SENTINEL_LINE, 1000),
				stampOf(SENTINEL_LINE) + 60_000,
			).reason,
		).toBe("pre-start");
		expect(
			judgeTurnEndRecord(rec, nowFor(SENTINEL_LINE, 1000), null).reason,
		).toBe("replayed-uuid");
	});

	test("recordPredatesFence needs a usable timestamp", () => {
		expect(
			recordPredatesFence(
				record(SENTINEL_LINE),
				stampOf(SENTINEL_LINE) + 60_000,
			),
		).toBe(true);
		expect(
			recordPredatesFence(
				record(SENTINEL_LINE),
				stampOf(SENTINEL_LINE) - 60_000,
			),
		).toBe(false);
		const undated = record(
			JSON.stringify({ type: "assistant", isApiErrorMessage: true }),
		);
		expect(recordPredatesFence(undated, Date.now())).toBe(false);
	});
});
