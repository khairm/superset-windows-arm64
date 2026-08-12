import { describe, expect, it } from "bun:test";
import {
	ANSWER_INTER_FRAME_DELAY_MS,
	type AnswerDeps,
	assertAnswerDeps,
	type HostTerminalRef,
	handleAnswer,
	injectSequence,
	ledgerRecordToResponse,
	SEQUENCE_EXECUTION_ALLOWANCE_MS,
} from "./answer";
import type { AttemptLedger, LedgerRecord } from "./attempt-ledger";
import { ROUTES } from "./http";
import {
	createRawPtyWriter,
	type Keystroke,
	RAW_PTY_WRITER_KIND,
	type RawWriteInput,
	type RawWriteResult,
} from "./keystrokes";
import { createLeaseRegistry, createTerminalLockRegistry } from "./lease";
import type { PendingQuestion, QuestionStore } from "./question-store";
import type {
	AnswerLease,
	AnswerRequest,
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
		nudgeRepaint: () => ({ success: true }),
		delay: async () => {},
		log: () => {},
		...overrides,
	} as unknown as AnswerDeps;
}

function testWriter(write: (data: string) => RawWriteResult) {
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
		resolveStatus: () => ({ kind: "unconfirmed", why: "unused in this test" }),
		rotateEpoch: () => "epoch-rotated",
	};
}

function answerHarness(
	options: {
		repaint?: AnswerDeps["nudgeRepaint"];
		onWrite?: (data: string, question: PendingQuestion) => void;
		locks?: AnswerDeps["locks"];
	} = {},
) {
	let now = 10_000;
	let writes = 0;
	const events: Record<string, unknown>[] = [];
	const question: PendingQuestion = {
		...QUESTION,
		questionId: "AAAAAAAAAAAAAAAAAAAAAA" as QuestionId,
		fingerprint: "AQEBAQEBAQEBAQEBAQEBAQ" as Fingerprint,
		questions: [
			{
				index: 0,
				header: "Pick one",
				question: "Which?",
				multiSelect: false,
				options: [{ index: 0, label: "A", description: "" }],
				freeTextOption: null,
			},
		],
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
			writes += 1;
			options.onWrite?.(input.data, question);
			return { success: true as const };
		},
		{
			writerKind: RAW_PTY_WRITER_KIND,
			prepare: async () => ({
				success: true as const,
				acknowledgedInputSupported: true,
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
		audit: { append: async () => {}, prune: async () => 0 },
		now: () => now++,
		delay: async () => {},
		log: (event: Record<string, unknown>) => events.push(event),
	} as unknown as AnswerDeps;
	const request = {
		questionId: question.questionId,
		fingerprint: question.fingerprint,
		requestId: "00000000-0000-4000-8000-000000000001",
		answers: [{ questionIndex: 0, kind: "select", optionIndex: 0 }],
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
		writeCount: () => writes,
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

describe("(ANSWER-FRAME-PACING) deterministic v3 injection", () => {
	const fourFrames: Keystroke[] = [
		{
			kind: "select_digit",
			data: "1",
			questionIndex: 0,
			optionIndex: 0,
			expect: { kind: "item_picker", itemIndex: 0 },
			submits: false,
		},
		{
			kind: "select_digit",
			data: "2",
			questionIndex: 1,
			optionIndex: 1,
			expect: { kind: "item_picker", itemIndex: 1 },
			submits: false,
		},
		{
			kind: "select_digit",
			data: "3",
			questionIndex: 2,
			optionIndex: 2,
			expect: { kind: "item_picker", itemIndex: 2 },
			submits: false,
		},
		{
			kind: "submit_return",
			data: "\r",
			questionIndex: 2,
			optionIndex: null,
			expect: { kind: "same_prompt", itemIndex: 2 },
			submits: true,
		},
	];

	it("waits exactly 500ms after each non-final v3 frame, then renews immediately before the next write", async () => {
		const events: string[] = [];
		const deps = stubDeps({
			delay: async (ms) => {
				events.push(`delay:${ms}`);
			},
			leases: testLeases(() => {
				events.push("extend");
				return { ok: true as const, lease: LEASE };
			}),
		});
		const writer = testWriter((data) => {
			events.push(`write:${JSON.stringify(data)}`);
			return { success: true };
		});

		const result = await injectSequence(deps, {
			question: QUESTION,
			host: HOST,
			keystrokes: fourFrames,
			leaseId: LEASE.leaseId,
			acknowledgedInputSupported: true,
			writer,
		});

		expect(result).toEqual({ kind: "confirmed" });
		expect(events).toEqual([
			"extend",
			'write:"1"',
			`delay:${ANSWER_INTER_FRAME_DELAY_MS}`,
			"extend",
			'write:"2"',
			`delay:${ANSWER_INTER_FRAME_DELAY_MS}`,
			"extend",
			'write:"3"',
			`delay:${ANSWER_INTER_FRAME_DELAY_MS}`,
			"extend",
			'write:"\\r"',
		]);
	});

	it("does not pace the single complete protocol-v2 legacy frame", async () => {
		const events: string[] = [];
		const deps = stubDeps({
			delay: async (ms) => {
				events.push(`delay:${ms}`);
			},
			leases: testLeases(() => {
				events.push("extend");
				return { ok: true as const, lease: LEASE };
			}),
		});
		const writer = testWriter((data) => {
			events.push(`write:${JSON.stringify(data)}`);
			return { error: "v2 is unacknowledged", writeOutcome: "unknown" };
		});

		expect(
			await injectSequence(deps, {
				question: QUESTION,
				host: HOST,
				keystrokes: fourFrames,
				leaseId: LEASE.leaseId,
				acknowledgedInputSupported: false,
				writer,
			}),
		).toMatchObject({ kind: "unconfirmed", written: 0, abortedAt: 4 });
		expect(events).toEqual(["extend", 'write:"123\\r"']);
	});

	it("checks the dynamic deadline after a wait and before renewing or writing", async () => {
		let now = 0;
		const events: string[] = [];
		const deps = stubDeps({
			now: () => now,
			delay: async (ms) => {
				events.push(`delay:${ms}`);
				now = SEQUENCE_EXECUTION_ALLOWANCE_MS + ms;
			},
			leases: testLeases(() => {
				events.push("extend");
				return { ok: true as const, lease: LEASE };
			}),
		});
		const writer = testWriter((data) => {
			events.push(`write:${JSON.stringify(data)}`);
			return { success: true };
		});

		expect(await run(writer, deps)).toMatchObject({
			kind: "unconfirmed",
			reason: "sequence deadline exceeded",
			written: 1,
			abortedAt: 1,
		});
		expect(events).toEqual([
			"extend",
			'write:"1"',
			`delay:${ANSWER_INTER_FRAME_DELAY_MS}`,
		]);
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
		const writer = testWriter((data) => {
			events.push(`write:${JSON.stringify(data)}`);
			return { success: true };
		});

		await expect(run(writer, deps)).rejects.toThrow("timer unavailable");
		expect(events).toEqual([
			"extend",
			'write:"1"',
			`delay:${ANSWER_INTER_FRAME_DELAY_MS}`,
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
		const writer = testWriter((data) => {
			events.push(`write:${JSON.stringify(data)}`);
			return { success: true };
		});

		expect(await run(writer, deps)).toMatchObject({
			kind: "unconfirmed",
			reason: "lease expired",
			written: 1,
			abortedAt: 1,
		});
		expect(events).toEqual([
			"extend",
			'write:"1"',
			`delay:${ANSWER_INTER_FRAME_DELAY_MS}`,
			"extend",
		]);
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
				lease: { ...LEASE, expiresAtMs: now + 15_000 },
			})),
			snapshotScreen: forbidden,
			sessionActive: forbidden,
			agentBinding: forbidden,
			permissionAxisLatched: forbidden,
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
