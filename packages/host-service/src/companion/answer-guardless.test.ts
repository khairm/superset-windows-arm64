import { describe, expect, it } from "bun:test";
import {
	type AnswerDeps,
	injectSequence,
	SEQUENCE_DEADLINE_MS,
} from "./answer";
import { createRawPtyWriter, type Keystroke } from "./keystrokes";
import type { PendingQuestion } from "./question-store";
import {
	ANSWER_GUARD_NAMES,
	type Fingerprint,
	type QuestionId,
	type TerminalId,
} from "./types";

const QUESTION = {
	questionId: "q-guardless" as QuestionId,
	fingerprint: "fp-guardless" as Fingerprint,
	state: "pending",
	askedAtMs: 1,
	resolvedAtMs: null,
	resolvedBy: null,
	toolUseId: "toolu_guardless",
	sessionId: "session-guardless",
	terminalId: "wire-terminal" as TerminalId,
	agentType: null,
	questions: [],
	origin: "unauthenticated_localhost_hook",
	hostTerminalId: "host-terminal",
	hostWorkspaceId: "host-workspace",
	transcriptPath: "C:/gone/transcript.jsonl",
	agentKind: "claude",
	agentId: null,
} satisfies PendingQuestion;

const KEYSTROKES: Keystroke[] = [
	{
		kind: "select_digit",
		data: "1",
		questionIndex: 0,
		optionIndex: 0,
		expect: { kind: "item_picker", itemIndex: 0 },
		submits: false,
	},
	{
		kind: "submit_return",
		data: "\r",
		questionIndex: 0,
		optionIndex: null,
		expect: { kind: "same_prompt", itemIndex: 0 },
		submits: true,
	},
];

describe("(ANSWER-GUARDLESS) direct PTY injection", () => {
	it("confirms successful writes without consulting transcript, screen, session, binding, permission, or marker sources", async () => {
		let now = 1_000;
		const written: string[] = [];
		const writer = createRawPtyWriter((input) => {
			if (input.terminalId.startsWith("\0")) {
				return { error: "probe" };
			}
			written.push(input.data);
			return { success: true };
		});
		const forbidden = () => {
			throw new Error("legacy guard source was consulted");
		};
		const deps = {
			now: () => now++,
			leases: {
				extend: () => ({
					ok: true as const,
					expiresAtMs: now + SEQUENCE_DEADLINE_MS,
				}),
			},
			log: () => {},
			snapshotScreen: forbidden,
			toolResultExists: forbidden,
			sessionActive: forbidden,
			agentBinding: forbidden,
			permissionAxisLatched: forbidden,
			askqMarkerExists: forbidden,
		} as unknown as AnswerDeps;

		const result = await injectSequence(deps, {
			question: QUESTION,
			host: {
				hostTerminalId: "host-terminal",
				hostWorkspaceId: "host-workspace",
			},
			keystrokes: KEYSTROKES,
			leaseId: "lease-guardless",
			writer,
		});

		expect(result).toMatchObject({
			kind: "confirmed",
			guardsPassed: [],
			guardsAbstained: [...ANSWER_GUARD_NAMES],
		});
		expect(written).toEqual(["1", "\r"]);
	});

	it("reports only an actual PTY write refusal after partial input", async () => {
		let writes = 0;
		const writer = createRawPtyWriter((input) => {
			if (input.terminalId.startsWith("\0")) return { error: "probe" };
			writes += 1;
			return writes === 1 ? { success: true } : { error: "pty unavailable" };
		});
		const deps = {
			now: () => 1_000,
			leases: { extend: () => ({ ok: true as const, expiresAtMs: 2_000 }) },
			log: () => {},
		} as unknown as AnswerDeps;

		const result = await injectSequence(deps, {
			question: QUESTION,
			host: {
				hostTerminalId: "host-terminal",
				hostWorkspaceId: "host-workspace",
			},
			keystrokes: KEYSTROKES,
			leaseId: "lease-guardless",
			writer,
		});

		expect(result).toMatchObject({
			kind: "unconfirmed",
			written: 1,
			abortedAt: 1,
			reason: "pty write refused: pty unavailable",
		});
	});
});
