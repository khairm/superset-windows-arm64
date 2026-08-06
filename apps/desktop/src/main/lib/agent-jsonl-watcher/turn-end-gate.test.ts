import { beforeEach, describe, expect, test } from "bun:test";
import {
	isSyntheticApiAbortRecord,
	isSyntheticInterruptRecord,
	judgeTurnEndRecord,
	mayBeTurnEndLine,
	parseTranscriptRecord,
	resetTurnEndGate,
	TURN_END_MAX_AGE_MS,
	TURN_END_MAX_FUTURE_SKEW_MS,
} from "./turn-end-gate";

/**
 * (WATCHER-BLUE-STOMP) Fixtures are verbatim lines from real transcripts under
 * ~/.claude/projects, trimmed only of unrelated trailing fields. The two false
 * positives are the shapes that actually fired false turn-ends in the live
 * watcher log: a tool_result quoting the sentinel, and a teammate message
 * pasted into the transcript as a long user string.
 */
const SENTINEL_LINE = `{"parentUuid":"d373b6fe-d081-4362-95c6-d5c969c68cae","isSidechain":false,"promptId":"01398ca7-096d-40ef-87e1-866af1c3013e","type":"user","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user]"}]},"uuid":"86ee37ea-f74d-486a-9d46-6ed6bcc91760","timestamp":"2026-07-18T11:30:35.597Z","interruptedMessageId":"msg_011Cd9SsXEScDPPN28ziVAw5","userType":"external","entrypoint":"cli","cwd":"C:\\\\Users\\\\khair","sessionId":"5e9203a5-ffbc-40b3-a9a4-13bccc5f74c4","version":"2.1.214","gitBranch":"HEAD"}`;

const SENTINEL_TOOL_USE_VARIANT = `{"parentUuid":"e09ef28c-3de8-4078-9884-810802fe9316","isSidechain":true,"type":"user","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user for tool use]"}]},"uuid":"bdb28d74-f5da-4aab-bb4d-2c222cd495ec","timestamp":"2026-07-20T09:30:44.872Z","userType":"external"}`;

const QUOTED_IN_TOOL_RESULT = `{"parentUuid":"bc66154e-9ae3-46db-b774-23524f95a48c","isSidechain":false,"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_011N9byhftPBMoMwEmh5npy5","type":"tool_result","content":"\\"text\\":\\"[Request interrupted by user for tool use]\\"}]}"}]},"uuid":"11111111-1111-1111-1111-111111111111","timestamp":"2026-08-06T17:40:00.000Z","userType":"external"}`;

const QUOTED_IN_TEAMMATE_MESSAGE = `{"parentUuid":"d6f2f4bc-f9f8-41e2-b46b-154f19de21ed","isSidechain":false,"type":"user","message":{"role":"user","content":"Another Claude session sent a message:\\n<agent-message from=\\"review-opus\\">\\nThe predicate matches any line containing Request interrupted by user, which is wrong.\\n</agent-message>"},"uuid":"22222222-2222-2222-2222-222222222222","timestamp":"2026-08-06T17:41:00.000Z","userType":"external"}`;

const API_ABORT_LINE = `{"parentUuid":"2395766c-3d17-4c5f-b9e7-73916e978b85","isSidechain":false,"type":"assistant","isApiErrorMessage":true,"uuid":"33333333-3333-3333-3333-333333333333","timestamp":"2026-08-06T17:42:00.000Z","message":{"id":"17161c70-367b-4d87-b266-b9b4249a108e","model":"<synthetic>","role":"assistant","type":"message","content":[{"type":"text","text":"API Error: Stream idle timeout - partial response received"}]}}`;

const API_TRANSIENT_LINE = `{"parentUuid":"2395766c-3d17-4c5f-b9e7-73916e978b85","isSidechain":false,"type":"assistant","isApiErrorMessage":true,"uuid":"44444444-4444-4444-4444-444444444444","timestamp":"2026-08-06T17:43:00.000Z","message":{"model":"<synthetic>","role":"assistant","type":"message","content":[{"type":"text","text":"API Error: 500 Anthropic error: {\\"type\\":\\"error\\",\\"error\\":{\\"type\\":\\"overloaded_error\\"}}"}]}}`;

const API_ABORT_QUOTED = `{"parentUuid":"ac237e0d-7854-48e5-915d-4433a11a62c4","isSidechain":false,"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_014XKMNdQhynKgHtQ1KtHJ2m","type":"tool_result","content":"    177 API Error: Stream idle timeout - partial response received\\n    141 \\"isApiErrorMessage\\":true"}]},"uuid":"55555555-5555-5555-5555-555555555555","timestamp":"2026-08-06T17:44:00.000Z"}`;

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

	test("the turn-ending api-abort record is a turn-end, a transient one is not", () => {
		expect(isSyntheticApiAbortRecord(record(API_ABORT_LINE))).toBe(true);
		expect(isSyntheticApiAbortRecord(record(API_TRANSIENT_LINE))).toBe(false);
	});

	test("an api-abort signature quoted in a tool_result is NOT a turn-end", () => {
		expect(isSyntheticApiAbortRecord(record(API_ABORT_QUOTED))).toBe(false);
		expect(isSyntheticInterruptRecord(record(API_ABORT_QUOTED))).toBe(false);
	});

	test("the cheap prefilter passes every candidate it is meant to", () => {
		for (const line of [
			SENTINEL_LINE,
			SENTINEL_TOOL_USE_VARIANT,
			API_ABORT_LINE,
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
