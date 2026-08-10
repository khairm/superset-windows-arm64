import { describe, expect, it } from "bun:test";
import {
	type AnswerDeps,
	injectSequence,
	SEQUENCE_DEADLINE_MS,
} from "./answer";
import { ROUTES } from "./http";
import {
	createRawPtyWriter,
	type Keystroke,
	RAW_PTY_WRITER_KIND,
	type RawWriteInput,
} from "./keystrokes";
import { createLeaseRegistry } from "./lease";
import type { PendingQuestion } from "./question-store";
import type {
	AnswerLease,
	DeviceId,
	Fingerprint,
	LeaseId,
	QuestionId,
	TerminalId,
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

const HOST = {
	hostTerminalId: "host-terminal",
	hostWorkspaceId: "host-workspace",
};

const LEASE = {
	leaseId: "lease-guardless" as LeaseId,
	questionId: QUESTION.questionId,
	deviceId: "device-guardless" as DeviceId,
	surface: "phone",
	acquiredAtMs: 1_000,
	expiresAtMs: 2_000,
} satisfies AnswerLease;

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

function testLeases(
	extend: AnswerDeps["leases"]["extend"],
): AnswerDeps["leases"] {
	return { ...createLeaseRegistry(), extend };
}

function stubDeps(overrides: Partial<AnswerDeps> = {}): AnswerDeps {
	return {
		now: () => 1_000,
		leases: testLeases(() => ({ ok: true as const, lease: LEASE })),
		log: () => {},
		...overrides,
	} as unknown as AnswerDeps;
}

function testWriter(
	write: (
		data: string,
	) =>
		| { success: true }
		| { error: string; writeOutcome: "not_written" | "unknown" },
) {
	return createRawPtyWriter(
		Object.assign(async (input: RawWriteInput) => write(input.data), {
			writerKind: RAW_PTY_WRITER_KIND,
			prepare: async () => ({
				acknowledgedInputSupported: true,
				success: true as const,
			}),
		}),
	);
}

function run(
	writer: ReturnType<typeof testWriter>,
	deps = stubDeps(),
	acknowledgedInputSupported = true,
) {
	return injectSequence(deps, {
		question: QUESTION,
		host: HOST,
		keystrokes: KEYSTROKES,
		leaseId: "lease-guardless",
		acknowledgedInputSupported,
		writer,
	});
}

describe("(ANSWER-GUARDLESS) answer boundary", () => {
	const request = {
		questionId: "A".repeat(22),
		fingerprint: "AQEBAQEBAQEBAQEBAQEBAQ",
		requestId: "00000000-0000-4000-8000-000000000001",
		answers: [{ questionIndex: 0, kind: "select", optionIndex: 0 }],
		surface: "phone",
	};

	it("accepts a valid answer without the obsolete biometric client claim", () => {
		expect(() => ROUTES["/v1/answer"].schema.parse(request)).not.toThrow();
	});

	it("still rejects a malformed biometric claim when one is supplied", () => {
		expect(() =>
			ROUTES["/v1/answer"].schema.parse({
				...request,
				confirmedBiometric: "yes",
			}),
		).toThrow();
	});
});

describe("(ANSWER-GUARDLESS) direct PTY injection", () => {
	it("confirms successful writes without consulting transcript, screen, session, binding, permission, or marker sources", async () => {
		let now = 1_000;
		const written: string[] = [];
		const writer = testWriter((data) => {
			written.push(data);
			return { success: true };
		});
		const forbidden = () => {
			throw new Error("legacy guard source was consulted");
		};
		const deps = stubDeps({
			now: () => now++,
			leases: testLeases(() => ({
				ok: true as const,
				lease: {
					...LEASE,
					expiresAtMs: now + SEQUENCE_DEADLINE_MS,
				},
			})),
			snapshotScreen: forbidden,
			toolResultExists: forbidden,
			sessionActive: forbidden,
			agentBinding: forbidden,
			permissionAxisLatched: forbidden,
			askqMarkerExists: forbidden,
		});

		const result = await run(writer, deps);

		expect(result).toEqual({ kind: "confirmed" });
		expect(written).toEqual(["1", "\r"]);
	});

	it("queues the whole sequence in one legacy frame before reporting an unknown v2 outcome", async () => {
		const queued: string[] = [];
		const writer = testWriter((data) => {
			queued.push(data);
			return {
				error: "daemon protocol 2 cannot acknowledge input",
				writeOutcome: "unknown",
			};
		});

		expect(await run(writer, stubDeps(), false)).toMatchObject({
			kind: "unconfirmed",
			written: 0,
			abortedAt: KEYSTROKES.length,
			writeOutcome: "unknown",
		});
		expect(queued).toEqual([KEYSTROKES.map((key) => key.data).join("")]);
	});

	it("reports an acknowledged writer rejection as a zero-write failure", async () => {
		const writer = createRawPtyWriter(
			Object.assign(
				async () => {
					throw new Error("daemon disconnected");
				},
				{
					writerKind: RAW_PTY_WRITER_KIND,
					prepare: async () => ({
						acknowledgedInputSupported: true,
						success: true as const,
					}),
				},
			),
		);

		expect(await run(writer)).toMatchObject({
			kind: "unconfirmed",
			written: 0,
			abortedAt: 0,
			writeOutcome: "unknown",
			reason: "pty write threw",
		});
	});

	it("reports a known zero-write refusal without fabricating guard evidence", async () => {
		const writer = testWriter(() => ({
			error: "pty unavailable",
			writeOutcome: "not_written",
		}));

		const result = await run(writer);

		expect(result).toMatchObject({
			kind: "unconfirmed",
			written: 0,
			abortedAt: 0,
			reason: "pty write refused: pty unavailable",
		});
	});

	it("reports only an actual PTY write refusal after partial input", async () => {
		let writes = 0;
		const writer = testWriter(() => {
			writes += 1;
			return writes === 1
				? { success: true }
				: { error: "pty unavailable", writeOutcome: "not_written" };
		});

		const result = await run(writer);

		expect(result).toMatchObject({
			kind: "unconfirmed",
			written: 1,
			abortedAt: 1,
			reason: "pty write refused: pty unavailable",
		});
	});
});
