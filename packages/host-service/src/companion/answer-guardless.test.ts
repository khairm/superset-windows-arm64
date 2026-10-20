import { afterEach, describe, expect, it } from "bun:test";
import {
	type AnswerDeps,
	assertAnswerDeps,
	type HostTerminalRef,
	handleAnswer,
	handleAnswerStatus,
	injectSequence,
	ledgerRecordToResponse,
} from "./answer";
import type { AttemptLedger, LedgerRecord } from "./attempt-ledger";
import { ROUTES } from "./http";
import {
	createRawPtyWriter,
	encodeAnswer,
	type KeystrokeFrame,
	RAW_PTY_WRITER_KIND,
	type RawWriteInput,
	type RawWriteResult,
} from "./keystrokes";
import { createLeaseRegistry, createTerminalLockRegistry } from "./lease";
import type { PendingQuestion, QuestionStore } from "./question-store";
import { multiItem, singleItem } from "./question-item-fixtures";
import { forgetTerminal, stampInput } from "./terminal-input-fence";
import type {
	AnswerItem,
	AnswerLease,
	AnswerRequest,
	AuditEntry,
	DeviceId,
	Fingerprint,
	LeaseId,
	QuestionId,
	QuestionItem,
	TerminalId,
} from "./types";

const QUESTION = {
	questionId: "q-guardless" as QuestionId,
	fingerprint: "fp-guardless" as Fingerprint,
	state: "pending",
	askedAtMs: 1,
	capturedAtMs: 1,
	resolvedAtMs: null,
	resolvedBy: null,
	remoteAnswer: null,
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

/** Two digit questions: three frames, one per screen. */
const FRAMES: KeystrokeFrame[] = encodeAnswer(
	[singleItem(0), singleItem(1)],
	[
		{ questionIndex: 0, kind: "select", optionIndex: 0 },
		{ questionIndex: 1, kind: "select", optionIndex: 1 },
	],
);

function testLeases(
	extend: AnswerDeps["leases"]["extend"],
): AnswerDeps["leases"] {
	return { ...createLeaseRegistry(), extend };
}

function stubDeps(overrides: Partial<AnswerDeps> = {}): AnswerDeps {
	return {
		now: () => 1_000,
		leases: testLeases(() => ({ ok: true as const, lease: LEASE })),
		nudgeRepaint: () => ({ success: true }),
		delay: async () => {},
		log: () => {},
		...overrides,
	} as unknown as AnswerDeps;
}

function testWriter(write: (input: RawWriteInput) => RawWriteResult) {
	return createRawPtyWriter(
		Object.assign(async (input: RawWriteInput) => write(input), {
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
	frames: readonly KeystrokeFrame[] = FRAMES,
) {
	return injectSequence(deps, {
		requestId: "00000000-0000-4000-8000-000000000001",
		question: QUESTION,
		host: HOST,
		frames,
		leaseId: "lease-guardless",
		writer,
	});
}

function memoryLedger(): AttemptLedger {
	const records = new Map<string, LedgerRecord>();
	return {
		currentEpoch: () => "epoch-guardless",
		claimForAnswer: (claim) => {
			const previous = records.get(claim.requestId);
			if (previous !== undefined) return { kind: "replay", record: previous };
			records.set(
				claim.requestId,
				ledgerRow({
					requestId: claim.requestId,
					status: "claimed",
					questionId: claim.questionId,
					deviceId: claim.deviceId,
					surface: claim.surface,
					leaseId: null,
					startedAtMs: claim.startedAtMs,
					createdAtMs: claim.startedAtMs,
					resolvedAtMs: null,
				}),
			);
			return { kind: "claimed", coverageEpoch: "epoch-guardless" };
		},
		beginWrite: (requestId, leaseId) => {
			const current = records.get(requestId);
			if (current?.status !== "claimed") throw new Error("missing claim");
			for (const record of records.values()) {
				if (
					record.requestId !== requestId &&
					record.questionId === current.questionId &&
					(record.status === "in_flight" ||
						record.status === "confirmed" ||
						record.status === "unconfirmed")
				) {
					return record;
				}
			}
			records.set(requestId, {
				...current,
				status: "in_flight",
				leaseId,
			});
			return null;
		},
		recordOutcome: (outcome) => {
			const current = records.get(outcome.requestId);
			if (current?.status !== "claimed" && current?.status !== "in_flight")
				return;
			records.set(outcome.requestId, {
				...current,
				...outcome,
				guardsPassed: [...outcome.guardsPassed],
			});
		},
		get: (requestId) => records.get(requestId) ?? null,
		resolveStatus: (requestId) => {
			const record = records.get(requestId);
			return record === undefined
				? { kind: "unconfirmed", why: "no record in this test" }
				: { kind: "known", record };
		},
		rotateEpoch: () => "epoch-rotated",
	};
}

function answerHarness(
	options: {
		questions?: QuestionItem[];
		answers?: AnswerItem[];
		question?: Partial<PendingQuestion>;
		repaint?: AnswerDeps["nudgeRepaint"];
		onWrite?: (data: string, question: PendingQuestion) => void;
		onDelay?: (ms: number, question: PendingQuestion) => void;
		locks?: AnswerDeps["locks"];
		acknowledgedInputSupported?: boolean;
		writeResult?: () => RawWriteResult;
	} = {},
) {
	let now = 10_000;
	const writes: string[] = [];
	const delays: number[] = [];
	const audits: AuditEntry[] = [];
	const events: Record<string, unknown>[] = [];
	const question: PendingQuestion = {
		...QUESTION,
		questionId: "AAAAAAAAAAAAAAAAAAAAAA" as QuestionId,
		fingerprint: "AQEBAQEBAQEBAQEBAQEBAQ" as Fingerprint,
		questions: options.questions ?? [singleItem(0)],
		...options.question,
	};
	const questions = {
		get: (questionId: QuestionId) =>
			questionId === question.questionId ? question : null,
		byHostTerminal: (hostTerminalId: string) =>
			hostTerminalId === question.hostTerminalId && question.state === "pending"
				? question
				: null,
		markRemoteAnswered: (
			questionId: QuestionId,
			resolvedBy: PendingQuestion["resolvedBy"],
			deliveredAtMs: number,
		) => {
			if (questionId !== question.questionId || resolvedBy === null)
				return false;
			question.remoteAnswer = { resolvedBy, deliveredAtMs };
			if (question.state === "resolved") {
				question.resolvedBy = resolvedBy;
				question.resolvedAtMs = deliveredAtMs;
			}
			return true;
		},
		markStale: () => {
			question.state = "stale";
		},
	} as unknown as QuestionStore;
	const writeInput = Object.assign(
		async (input: RawWriteInput) => {
			writes.push(input.data);
			options.onWrite?.(input.data, question);
			return options.writeResult?.() ?? { success: true as const };
		},
		{
			writerKind: RAW_PTY_WRITER_KIND,
			prepare: async () => ({
				success: true as const,
				acknowledgedInputSupported: options.acknowledgedInputSupported ?? true,
			}),
		},
	);
	const deps = {
		writeInput,
		nudgeRepaint: options.repaint ?? (() => ({ success: true as const })),
		locks: options.locks ?? createTerminalLockRegistry(),
		leases: createLeaseRegistry(),
		ledger: memoryLedger(),
		questions,
		markRemoteAnsweredAndPublish: questions.markRemoteAnswered,
		audit: {
			append: async (entry: AuditEntry) => {
				audits.push(entry);
			},
			prune: async () => 0,
		},
		now: () => now,
		delay: async (ms: number) => {
			delays.push(ms);
			now += ms;
			options.onDelay?.(ms, question);
		},
		log: (event: Record<string, unknown>) => events.push(event),
	} as unknown as AnswerDeps;
	const request = {
		questionId: question.questionId,
		fingerprint: question.fingerprint,
		requestId: "00000000-0000-4000-8000-000000000001",
		answers: options.answers ?? [
			{ questionIndex: 0, kind: "select", optionIndex: 0 },
		],
		surface: "phone",
	} satisfies AnswerRequest;
	const ctx = {
		device: {
			deviceId: "device-guardless" as DeviceId,
			label: "phone",
			writeEnabled: true,
		},
	} as unknown as Parameters<typeof handleAnswer>[1];
	return {
		deps,
		ctx,
		request,
		question,
		events,
		writes,
		delays,
		audits,
		now: () => now,
		writeCount: () => writes.length,
		status: () =>
			handleAnswerStatus(deps, ctx, {
				requestId: request.requestId,
				coverageEpoch: "epoch-guardless",
			}),
	};
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

	it("accepts ticks plus text, and text alone, and refuses 301 units on both free-text kinds", () => {
		const parse = (answer: Record<string, unknown>) =>
			ROUTES["/v1/answer"].schema.parse({ ...request, answers: [answer] });
		const base = { questionIndex: 0, kind: "multiselect_freetext" };
		expect(() =>
			parse({ ...base, optionIndexes: [0, 2], text: "x".repeat(300) }),
		).not.toThrow();
		expect(() => parse({ ...base, optionIndexes: [], text: "x" })).not.toThrow();
		expect(() =>
			parse({ ...base, optionIndexes: [2, 0], text: "x" }),
		).toThrow();
		expect(() =>
			parse({ ...base, optionIndexes: [0], text: "x".repeat(301) }),
		).toThrow();
		expect(() =>
			parse({ questionIndex: 0, kind: "freetext", text: "x".repeat(301) }),
		).toThrow();
	});
});

describe("(ANSWER-GUARDLESS) post-answer settlement and repaint", () => {
	it("requires the non-vetoing repaint adapter at startup", () => {
		expect(() =>
			// Only the adapter under test matters; the raw writer marker is validated
			// before this dependency check.
			assertAnswerDeps({
				writeInput: Object.assign(async () => ({ success: true as const }), {
					writerKind: RAW_PTY_WRITER_KIND,
					prepare: async () => ({
						success: true as const,
						acknowledgedInputSupported: true,
					}),
				}),
				writeFramed: async () => ({ success: true as const }),
				snapshotScreen: async () => "",
				delay: async () => {},
			} as unknown as AnswerDeps),
		).toThrow("nudgeRepaint");
	});

	it("durably confirms, keeps discovery pending, records provenance, and repaints", async () => {
		const repaints: HostTerminalRef[] = [];
		const harness = answerHarness({
			repaint: (host) => {
				repaints.push(host);
				return { success: true };
			},
		});

		const response = await handleAnswer(
			harness.deps,
			harness.ctx,
			harness.request,
		);

		expect(response.status).toBe("confirmed");
		expect(harness.question.state).toBe("pending");
		expect(harness.question.remoteAnswer).toEqual({
			resolvedBy: { deviceLabel: "phone", surface: "phone" },
			deliveredAtMs: response.resolvedAtMs as number,
		});
		expect(repaints).toEqual([HOST]);
		expect(harness.writeCount()).toBe(1);
	});

	it("does not downgrade a durable confirmation when repaint fails", async () => {
		const harness = answerHarness({
			repaint: () => ({ error: "resize failed" }),
		});

		const response = await handleAnswer(
			harness.deps,
			harness.ctx,
			harness.request,
		);

		expect(response.status).toBe("confirmed");
		expect(harness.events).toContainEqual(
			expect.objectContaining({
				event: "companion.answer.repaint_failed",
				error: "resize failed",
			}),
		);
	});

	it("records a lock infrastructure failure as proven zero-write and non-fencing", async () => {
		const harness = answerHarness({
			locks: {
				runExclusive: async () => {
					throw new Error("lock infrastructure failed");
				},
			},
		});

		await expect(
			handleAnswer(harness.deps, harness.ctx, harness.request),
		).rejects.toThrow("lock infrastructure failed");
		expect(harness.deps.ledger.get(harness.request.requestId)).toMatchObject({
			status: "failed",
			failureCode: "internal",
		});

		harness.deps.locks = createTerminalLockRegistry();
		const retry = await handleAnswer(harness.deps, harness.ctx, {
			...harness.request,
			requestId: "00000000-0000-4000-8000-000000000003",
		});
		expect(retry.status).toBe("confirmed");
	});

	it("does not let a pre-write claim fence the request that wins the answer lease", async () => {
		const harness = answerHarness();
		const competingRequest = {
			...harness.request,
			requestId: "00000000-0000-4000-8000-000000000099",
		};
		harness.deps.ledger.claimForAnswer({
			requestId: competingRequest.requestId,
			questionId: competingRequest.questionId,
			deviceId: harness.ctx.device.deviceId,
			surface: competingRequest.surface,
			startedAtMs: 9_999,
		});

		const response = await handleAnswer(
			harness.deps,
			harness.ctx,
			harness.request,
		);

		expect(response.status).toBe("confirmed");
		expect(harness.writeCount()).toBe(1);
	});

	it("never retypes a durable delivery under a fresh request id", async () => {
		const harness = answerHarness();
		await handleAnswer(harness.deps, harness.ctx, harness.request);

		await expect(
			handleAnswer(harness.deps, harness.ctx, {
				...harness.request,
				requestId: "00000000-0000-4000-8000-000000000002",
			}),
		).rejects.toMatchObject({
			statusCode: 409,
			body: { code: "already_resolved" },
		});
		expect(harness.writeCount()).toBe(1);
	});

	it("keeps phone provenance when positive settlement wins the marking race", async () => {
		const harness = answerHarness({
			onWrite: (_data, question) => {
				question.state = "resolved";
				question.resolvedBy = { deviceLabel: null, surface: "desktop" };
				question.resolvedAtMs = 9_999;
			},
		});

		const response = await handleAnswer(
			harness.deps,
			harness.ctx,
			harness.request,
		);

		expect(response.status).toBe("confirmed");
		expect(harness.question.resolvedBy).toEqual({
			deviceLabel: "phone",
			surface: "phone",
		});
		expect(harness.question.resolvedAtMs).toBe(response.resolvedAtMs);
	});
});

describe("(ANSWER-GUARDLESS) answer validation writes nothing", () => {
	it("refuses bad ticks, over-long text and control or broken text with 400", async () => {
		const ticks = (optionIndexes: number[]): AnswerItem => ({
			questionIndex: 0,
			kind: "multiselect_freetext",
			optionIndexes,
			text: "ok",
		});
		const typed = (text: string): AnswerItem => ({
			questionIndex: 0,
			kind: "multiselect_freetext",
			optionIndexes: [0],
			text,
		});
		const cases: { item: AnswerItem; multi: boolean }[] = [
			{ item: ticks([0, 0]), multi: true },
			{ item: ticks([2, 0]), multi: true },
			{ item: ticks([3]), multi: true },
			{ item: typed("x".repeat(301)), multi: true },
			{
				item: { questionIndex: 0, kind: "freetext", text: "x".repeat(301) },
				multi: false,
			},
			...["a\rb", "a\nb", "a\tb", "a\x1bb", "a\u009bb", "a\ud800b"].map(
				(text) => ({ item: typed(text), multi: true }),
			),
		];
		for (const [index, { item, multi }] of cases.entries()) {
			const harness = answerHarness({
				questions: [multi ? multiItem(0) : singleItem(0)],
				answers: [item],
			});
			await expect(
				handleAnswer(harness.deps, harness.ctx, {
					...harness.request,
					requestId: `00000000-0000-4000-8000-0000000001${String(index).padStart(2, "0")}`,
				}),
			).rejects.toMatchObject({
				statusCode: 400,
				body: { code: "bad_request" },
			});
			expect(harness.writeCount()).toBe(0);
		}
	});

	it("records a pre-write refusal under its own code, readable by status, with a failed audit line", async () => {
		const harness = answerHarness({
			questions: [0, 1, 2, 3, 4].map((index) => singleItem(index)),
			answers: [0, 1, 2, 3, 4].map((questionIndex) => ({
				questionIndex,
				kind: "select" as const,
				optionIndex: 0,
			})),
		});

		await expect(
			handleAnswer(harness.deps, harness.ctx, harness.request),
		).rejects.toMatchObject({
			statusCode: 501,
			body: { code: "capability_unsupported" },
		});

		expect(harness.writeCount()).toBe(0);
		expect(harness.deps.ledger.get(harness.request.requestId)).toMatchObject({
			status: "failed",
			failureCode: "capability_unsupported",
		});
		expect((await harness.status()).outcome).toMatchObject({
			kind: "known",
			status: "failed",
			failureCode: "capability_unsupported",
		});
		expect(harness.audits).toEqual([
			expect.objectContaining({
				outcome: "failed",
				failureCode: "capability_unsupported",
				leaseId: null,
				payloadHash: expect.any(String),
			}),
		]);
	});

	it("refuses a capture whose askedAtMs runs more than 2 s ahead of its capture", async () => {
		const harness = answerHarness({
			question: { askedAtMs: 5_000 + 2_001, capturedAtMs: 5_000 },
		});

		await expect(
			handleAnswer(harness.deps, harness.ctx, harness.request),
		).rejects.toMatchObject({
			statusCode: 400,
			body: { code: "bad_request" },
		});
		expect(harness.writeCount()).toBe(0);
	});
});

describe("(ANSWER-FRAME-PACING) one write per picker screen", () => {
	it("writes ticks plus typed text on a one-question multi-select as the group, then the final Return alone", async () => {
		const questions = [multiItem(0)];
		const answers: AnswerItem[] = [
			{
				questionIndex: 0,
				kind: "multiselect_freetext",
				optionIndexes: [0, 2],
				text: "hello other",
			},
		];
		const harness = answerHarness({ questions, answers });

		const response = await handleAnswer(
			harness.deps,
			harness.ctx,
			harness.request,
		);

		expect(response.status).toBe("confirmed");
		expect(harness.writes).toEqual(
			encodeAnswer(questions, answers).map((frame) => frame.data),
		);
		expect(harness.delays).toEqual([2000]);
	});

	it("waits exactly 2000 ms between frames, renews immediately before the next write, and logs each ack", async () => {
		const events: string[] = [];
		const logged: Record<string, unknown>[] = [];
		const deps = stubDeps({
			delay: async (ms) => {
				events.push(`delay:${ms}`);
			},
			leases: testLeases(() => {
				events.push("extend");
				return { ok: true as const, lease: LEASE };
			}),
			log: (event) => logged.push(event),
		});
		const writer = testWriter((input) => {
			events.push(`write:${JSON.stringify(input.data)}`);
			return { success: true };
		});
		const p1 = encodeAnswer(
			[singleItem(0), singleItem(1)],
			[
				{ questionIndex: 0, kind: "freetext", text: "hello" },
				{ questionIndex: 1, kind: "select", optionIndex: 1 },
			],
		);

		expect(await run(writer, deps, p1)).toEqual({ kind: "confirmed" });
		expect(logged).toEqual(
			[0, 1, 2].map((frameIndex) => ({
				event: "companion.answer.frame_acked",
				requestId: "00000000-0000-4000-8000-000000000001",
				frameIndex,
				frameCount: 3,
				ackMs: 0,
			})),
		);
		const [first, second, third] = p1.map((frame) =>
			JSON.stringify(frame.data),
		);
		expect(events).toEqual([
			"extend",
			`write:${first}`,
			"delay:2000",
			"extend",
			`write:${second}`,
			"delay:2000",
			"extend",
			`write:${third}`,
		]);
	});

	it("budgets 5000 ms plus 2000 ms per gap, hands each ack the remaining budget, stops before a gap that cannot fit, and a late final ack is unconfirmed", async () => {
		let now = 0;
		const ackTimeouts: number[] = [];
		const deps = stubDeps({
			now: () => now,
			delay: async (ms) => {
				now += ms;
			},
		});
		const writer = testWriter((input) => {
			ackTimeouts.push(input.ackTimeoutMs);
			if (ackTimeouts.length === FRAMES.length) now = 5_000 + 2 * 2_000 + 1;
			return { success: true };
		});

		expect(await run(writer, deps)).toMatchObject({
			kind: "unconfirmed",
			written: 3,
			failureCode: null,
		});
		expect(ackTimeouts).toEqual([9_000, 7_000, 5_000]);

		let slowNow = 0;
		const slowDelays: number[] = [];
		const slowDeps = stubDeps({
			now: () => slowNow,
			delay: async (ms) => {
				slowDelays.push(ms);
				slowNow += ms;
			},
		});
		const slowWriter = testWriter(() => {
			slowNow += 7_000;
			return { success: true };
		});

		expect(await run(slowWriter, slowDeps)).toMatchObject({
			kind: "unconfirmed",
			written: 1,
			writeOutcome: "not_written",
			failureCode: null,
		});
		expect(slowDelays).toEqual([]);
	});

	it("fails loud when the required pacing timer rejects instead of bursting the remainder", async () => {
		const events: string[] = [];
		const deps = stubDeps({
			delay: async (ms) => {
				events.push(`delay:${ms}`);
				throw new Error("timer unavailable");
			},
			leases: testLeases(() => {
				events.push("extend");
				return { ok: true as const, lease: LEASE };
			}),
		});
		const writer = testWriter((input) => {
			events.push(`write:${JSON.stringify(input.data)}`);
			return { success: true };
		});

		await expect(run(writer, deps)).rejects.toThrow("timer unavailable");
		expect(events).toEqual([
			"extend",
			`write:${JSON.stringify("\x1b[49u")}`,
			"delay:2000",
		]);
	});

	it("stops on a lease failure immediately after the inter-frame wait", async () => {
		const events: string[] = [];
		let extensions = 0;
		const deps = stubDeps({
			delay: async (ms) => {
				events.push(`delay:${ms}`);
			},
			leases: testLeases(() => {
				extensions += 1;
				events.push("extend");
				return extensions === 1
					? { ok: true as const, lease: LEASE }
					: { ok: false as const, reason: "expired" as const };
			}),
		});
		const writer = testWriter((input) => {
			events.push(`write:${JSON.stringify(input.data)}`);
			return { success: true };
		});

		expect(await run(writer, deps)).toMatchObject({
			kind: "unconfirmed",
			reason: "lease expired",
			written: 1,
		});
		expect(events).toEqual([
			"extend",
			`write:${JSON.stringify("\x1b[49u")}`,
			"delay:2000",
			"extend",
		]);
	});

	it("waits until the capture is 6000 ms old before the first write, and never more than 6000 ms", async () => {
		for (const { capturedAtMs, expected } of [
			{ capturedAtMs: 10_000 - 1_000, expected: 5_000 },
			{ capturedAtMs: 10_000 + 60_000, expected: 6_000 },
		]) {
			const harness = answerHarness({
				question: { askedAtMs: capturedAtMs, capturedAtMs },
			});

			expect(
				(await handleAnswer(harness.deps, harness.ctx, harness.request))
					.status,
			).toBe("confirmed");
			expect(harness.delays).toEqual([expected]);
		}
	});

	it("refuses a desk answer that lands during the settle wait, before any write", async () => {
		const harness = answerHarness({
			question: { capturedAtMs: 10_000 },
			onDelay: (_ms, question) => {
				question.state = "resolved";
				question.resolvedBy = { deviceLabel: null, surface: "desktop" };
			},
		});

		await expect(
			handleAnswer(harness.deps, harness.ctx, harness.request),
		).rejects.toMatchObject({ body: { code: "already_resolved" } });
		expect(harness.writeCount()).toBe(0);
	});

	it("refuses a multi-frame answer on a daemon that cannot acknowledge, before the lease", async () => {
		const harness = answerHarness({
			acknowledgedInputSupported: false,
			questions: [singleItem(0), singleItem(1)],
			answers: [
				{ questionIndex: 0, kind: "select", optionIndex: 0 },
				{ questionIndex: 1, kind: "select", optionIndex: 1 },
			],
		});

		await expect(
			handleAnswer(harness.deps, harness.ctx, harness.request),
		).rejects.toMatchObject({
			statusCode: 501,
			body: { code: "capability_unsupported" },
		});
		expect(harness.writeCount()).toBe(0);
		expect(harness.audits).toEqual([
			expect.objectContaining({ outcome: "failed", leaseId: null }),
		]);
	});

	it("still writes a one-frame answer to a daemon that cannot acknowledge, and reports it unconfirmed", async () => {
		const harness = answerHarness({
			acknowledgedInputSupported: false,
			writeResult: () => ({
				error: "daemon protocol 2 cannot acknowledge input",
				writeOutcome: "unknown",
			}),
		});

		const response = await handleAnswer(
			harness.deps,
			harness.ctx,
			harness.request,
		);

		expect(response.status).toBe("unconfirmed");
		expect(harness.writes).toEqual(["\x1b[49u"]);
	});
});

describe("(ANSWER-DESK-TOUCH-FENCE) input at the terminal after the question", () => {
	const touched: string[] = [];
	afterEach(() => {
		for (const hostTerminalId of touched.splice(0)) {
			forgetTerminal(hostTerminalId);
		}
	});

	function fenceHarness(
		hostTerminalId: string,
		options: Parameters<typeof answerHarness>[0] = {},
	) {
		touched.push(hostTerminalId);
		const harness = answerHarness({
			...options,
			question: { hostTerminalId, ...options.question },
		});
		expect(harness.question.terminalId).not.toBe(hostTerminalId);
		return harness;
	}

	it("refuses with 412 desk_input when touched during the settle, before any write", async () => {
		const hostTerminalId = "host-terminal-fence-settle";
		const harness = fenceHarness(hostTerminalId, {
			question: { capturedAtMs: 10_000 },
			onDelay: () => stampInput(hostTerminalId, harness.now()),
		});

		await expect(
			handleAnswer(harness.deps, harness.ctx, harness.request),
		).rejects.toMatchObject({ statusCode: 412, body: { code: "desk_input" } });
		expect(harness.writeCount()).toBe(0);
		expect(harness.deps.ledger.get(harness.request.requestId)).toMatchObject({
			status: "failed",
			failureCode: "desk_input",
		});
		await expect(
			handleAnswer(harness.deps, harness.ctx, harness.request),
		).rejects.toMatchObject({ statusCode: 412, body: { code: "desk_input" } });
		expect((await harness.status()).outcome).toMatchObject({
			kind: "known",
			status: "failed",
			failureCode: "desk_input",
		});
	});

	it("stops between frames as unconfirmed with desk_input on the response, the replay and the status read", async () => {
		const hostTerminalId = "host-terminal-fence-between";
		const harness = fenceHarness(hostTerminalId, {
			questions: [singleItem(0), singleItem(1)],
			answers: [
				{ questionIndex: 0, kind: "select", optionIndex: 0 },
				{ questionIndex: 1, kind: "select", optionIndex: 1 },
			],
			onDelay: () => stampInput(hostTerminalId, harness.now()),
		});

		const response = await handleAnswer(
			harness.deps,
			harness.ctx,
			harness.request,
		);

		expect(response).toMatchObject({
			status: "unconfirmed",
			failureCode: "desk_input",
		});
		expect(harness.writes).toEqual(["\x1b[49u"]);
		expect(
			await handleAnswer(harness.deps, harness.ctx, harness.request),
		).toMatchObject({ status: "unconfirmed", failureCode: "desk_input" });
		expect((await harness.status()).outcome).toMatchObject({
			kind: "known",
			status: "unconfirmed",
			failureCode: "desk_input",
		});
	});

	it("does not refuse input stamped before the question was asked", async () => {
		const hostTerminalId = "host-terminal-fence-before";
		const harness = fenceHarness(hostTerminalId, {
			question: { askedAtMs: 5_000, capturedAtMs: 5_000 },
		});
		stampInput(hostTerminalId, 4_999);

		const response = await handleAnswer(
			harness.deps,
			harness.ctx,
			harness.request,
		);

		expect(response.status).toBe("confirmed");
		expect(response.failureCode).toBeUndefined();
	});

	it("refuses input stamped at exactly askedAtMs", async () => {
		const hostTerminalId = "host-terminal-fence-exact";
		const harness = fenceHarness(hostTerminalId, {
			question: { askedAtMs: 5_000, capturedAtMs: 5_000 },
		});
		stampInput(hostTerminalId, 5_000);

		await expect(
			handleAnswer(harness.deps, harness.ctx, harness.request),
		).rejects.toMatchObject({ statusCode: 412, body: { code: "desk_input" } });
		expect(harness.writeCount()).toBe(0);
	});

	it("accepts askedAtMs exactly 2000 ms after the capture", async () => {
		const harness = fenceHarness("host-terminal-fence-lead", {
			question: { askedAtMs: 5_000 + 2_000, capturedAtMs: 5_000 },
		});

		const response = await handleAnswer(
			harness.deps,
			harness.ctx,
			harness.request,
		);

		expect(response.status).toBe("confirmed");
		expect(harness.writeCount()).toBe(1);
	});
});

describe("(ANSWER-GUARDLESS) direct PTY injection", () => {
	it("confirms successful writes without consulting transcript, screen, session, binding, permission, or marker sources", async () => {
		let now = 1_000;
		const written: string[] = [];
		const writer = testWriter((input) => {
			written.push(input.data);
			return { success: true };
		});
		const forbidden = () => {
			throw new Error("legacy guard source was consulted");
		};
		const deps = stubDeps({
			now: () => now++,
			leases: testLeases(() => ({
				ok: true as const,
				lease: { ...LEASE, expiresAtMs: now + 15_000 },
			})),
			snapshotScreen: forbidden,
			sessionActive: forbidden,
			agentBinding: forbidden,
			permissionAxisLatched: forbidden,
		});

		const result = await run(writer, deps);

		expect(result).toEqual({ kind: "confirmed" });
		expect(written).toEqual(["\x1b[49u", "\x1b[50u", "\x1b[13u"]);
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
			reason: "pty write refused: pty unavailable",
		});
	});
});

// ---------------------------------------------------------------------------
// (ANSWER-GUARDLESS) the REPLAY contract
//
// A durable ledger row has no abstain column and, since the guard stack was
// removed, no guard evaluation to reconstruct either. `ledgerRecordToResponse`
// is the only place a §11.4 replay decides what to say about that, and it is a
// pure record-to-response mapper, so the derivation is pinned here.
// ---------------------------------------------------------------------------

function ledgerRow(overrides: Partial<LedgerRecord> = {}): LedgerRecord {
	return {
		requestId:
			"00000000-0000-4000-8000-000000000001" as LedgerRecord["requestId"],
		status: "confirmed",
		questionId: "q-guardless",
		deviceId: "device-guardless",
		surface: "phone",
		leaseId: "lease-guardless",
		startedAtMs: 1 as LedgerRecord["startedAtMs"],
		createdAtMs: 1 as LedgerRecord["createdAtMs"],
		resolvedAtMs: 2 as LedgerRecord["resolvedAtMs"],
		failureCode: null,
		guardsPassed: [],
		coverageEpoch: "epoch-1",
		...overrides,
	};
}

describe("(ANSWER-GUARDLESS) a replayed answer", () => {
	it("reports nothing abstained on a confirmed row", () => {
		const response = ledgerRecordToResponse(ledgerRow());

		expect(response.status).toBe("confirmed");
		expect(response.resolvedAtMs).toBe(2 as LedgerRecord["resolvedAtMs"]);
		expect(response.guardsPassed).toEqual([]);
		expect(response.guardsAbstained).toEqual([]);
	});

	it("says it CANNOT SAY for a row that is not confirmed — never []", () => {
		const response = ledgerRecordToResponse(
			ledgerRow({ status: "unconfirmed", resolvedAtMs: null }),
		);

		expect(response.status).toBe("unconfirmed");
		expect(response.resolvedAtMs).toBeNull();
		expect(response.guardsAbstained).toBeNull();
	});

	it("replays a legacy row's stored guard evidence without inferring new outcomes", () => {
		// Rows written by an older bridge still name the guards that build
		// evaluated. They are reported verbatim, and nothing is derived from which
		// guards are absent.
		const response = ledgerRecordToResponse(
			ledgerRow({ guardsPassed: ["transcript", "screen", "session"] }),
		);

		expect(response.guardsPassed).toEqual(["transcript", "screen", "session"]);
		expect(response.guardsAbstained).toEqual([]);
	});

	it("reports an absent lease as absent rather than inventing one", () => {
		// The claim is made before the lease is acquired, so a row whose attempt
		// died between the two has no lease to report.
		const response = ledgerRecordToResponse(
			ledgerRow({ status: "failed", leaseId: null, questionId: null }),
		);

		expect(response.status).toBe("unconfirmed");
		expect(response.leaseId).toBe("");
		expect(response.questionId).toBe("");
	});
});
