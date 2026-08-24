/**
 * (SESSIONS-PROJECT) Answering a question raised inside a SESSION, from the
 * phone or the watch.
 *
 * WHY THIS IS THE LOAD-BEARING TEST. A session has a real `workspaces` row, so
 * the parts of the answer path that touch a pty — adoption, the terminal lock,
 * the acknowledged raw write — were never the problem and must NOT be handed
 * an invented workspace id: `getOrAdoptSession` looks the workspace up in
 * host.db and refuses ("Workspace not found") for anything it cannot find, and
 * `writableSession` refuses again if the id does not match the session's owner.
 * What DID break is the identity the phone is shown: `resolveSource` mints
 * `deriveHandle("project", hostProjectId)` for every `/v1/question` — the call
 * the phone makes to OPEN a question before answering it — and a session's
 * `project_id` is NULL.
 *
 * So the two halves below: the source resolves against real SQL with the real
 * workspace id and the synthetic project id, and an answer submitted for that
 * question is written and confirmed, with the guards that must keep refusing
 * still refusing.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../db";
import { projects, terminalSessions, workspaces } from "../db/schema";
import { type AnswerDeps, type HostTerminalRef, handleAnswer } from "./answer";
import type { AttemptLedger, LedgerRecord } from "./attempt-ledger";
import { RAW_PTY_WRITER_KIND, type RawWriteInput } from "./keystrokes";
import { createLeaseRegistry, createTerminalLockRegistry } from "./lease";
import {
	createQuestionStore,
	type PendingQuestion,
	type QuestionStore,
} from "./question-store";
import { openHostDbReadOnly } from "./read-api";
import { SESSIONS_PROJECT_ID } from "./session-project";
import type {
	AnswerRequest,
	DeviceId,
	Fingerprint,
	QuestionId,
	QuestionItem,
	TerminalId,
} from "./types";

const NOW = Date.now();
const OLD = NOW - 7 * 86_400_000;

/** The session's REAL workspace id — never a synthesised one. */
const SESSION_WORKSPACE_ID = "w-session";
const SESSION_TERMINAL_ID = "term-session";

// ---------------------------------------------------------------------------
// the question source, against real SQL
// ---------------------------------------------------------------------------

describe("(SESSIONS-PROJECT) the question source for a session terminal", () => {
	const dir = mkdtempSync(join(tmpdir(), "companion-session-answer-"));
	const dbPath = join(dir, "host.db");
	const db = createDb(dbPath, join(import.meta.dirname, "..", "..", "drizzle"));
	db.insert(projects)
		.values({ id: "p-1", repoPath: "C:/repo", name: "repo", createdAt: OLD })
		.run();
	db.insert(workspaces)
		.values([
			{
				id: "w-branch",
				projectId: "p-1",
				name: "feature",
				branch: "feature",
				worktreePath: "C:/wt/feature",
				type: "worktree",
				createdAt: OLD,
			},
			// Exactly what `workspaces.createSession` inserts.
			{
				id: SESSION_WORKSPACE_ID,
				projectId: null,
				name: "quiet-otter",
				branch: "main",
				worktreePath: "C:/Users/me/.superset/sessions/quiet-otter",
				type: "session",
				createdAt: OLD,
			},
		])
		.run();
	db.insert(terminalSessions)
		.values([
			{
				id: SESSION_TERMINAL_ID,
				originWorkspaceId: SESSION_WORKSPACE_ID,
				status: "active",
				createdAt: OLD,
			},
			{
				id: "term-session-closed",
				originWorkspaceId: SESSION_WORKSPACE_ID,
				status: "disposed",
				createdAt: OLD,
				endedAt: OLD + 1_000,
			},
		])
		.run();
	const reader = openHostDbReadOnly(dbPath, () => [join(dir, "claude")]);

	afterAll(() => {
		reader.close();
		db.$client.close();
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// Windows holds the WAL sidecar briefly; leave it for the OS to reap.
		}
	});

	it("resolves to the REAL workspace id under the synthetic project id — the workspace is what adoption and the pty write key on, so it is passed through untouched", () => {
		expect(reader.resolveActiveTerminal(SESSION_TERMINAL_ID)).toEqual({
			hostProjectId: SESSIONS_PROJECT_ID,
			hostWorkspaceId: SESSION_WORKSPACE_ID,
			agentId: null,
		});
	});

	it("keeps answering for a CLOSED session on the unrestricted resolver — reopening the question you just answered must not 500", () => {
		expect(reader.resolveTerminal("term-session-closed")).toEqual({
			hostProjectId: SESSIONS_PROJECT_ID,
			hostWorkspaceId: SESSION_WORKSPACE_ID,
			agentId: null,
		});
	});

	it("does not touch a repo terminal's real project id", () => {
		db.insert(terminalSessions)
			.values({
				id: "term-branch",
				originWorkspaceId: "w-branch",
				status: "active",
				createdAt: OLD,
			})
			.run();
		expect(reader.resolveActiveTerminal("term-branch")).toEqual({
			hostProjectId: "p-1",
			hostWorkspaceId: "w-branch",
			agentId: null,
		});
	});

	it("(CAPTURE-BOUNDED) still refuses a terminal with no workspace at all — an orphan is not a session", () => {
		db.insert(terminalSessions)
			.values({
				id: "term-orphan",
				originWorkspaceId: null,
				status: "active",
				createdAt: OLD,
			})
			.run();
		expect(reader.resolveActiveTerminal("term-orphan")).toBeNull();
		expect(reader.resolveTerminal("term-orphan")).toBeNull();
	});

	it("captures a question on the session terminal and builds a §7.4 source for it — the call the phone makes to OPEN a question", async () => {
		const store = createQuestionStore({
			source: reader,
			liveness: { isProvablyGone: () => false },
			onSettled: () => {},
		});
		const question = store.capture({
			hostTerminalId: SESSION_TERMINAL_ID,
			workspaceId: SESSION_WORKSPACE_ID,
			toolUseId: "tu-session",
			sessionId: "s-session",
			transcriptPath: "",
			cwd: "C:/Users/me/.superset/sessions/quiet-otter",
			agentId: null,
			agentType: null,
			askedAtMs: NOW - 1_000,
			questions: [questionItem()],
		});
		expect(question.state).toBe("pending");
		expect(question.hostWorkspaceId).toBe(SESSION_WORKSPACE_ID);

		const response = await store.toResponse(question, { granted: [] });
		// Both handles are present and derived — the NULL project used to reach
		// `deriveHandle` here, which is what made the question unopenable.
		expect(typeof response.source.projectId).toBe("string");
		expect(response.source.projectId.length).toBeGreaterThan(0);
		expect(typeof response.source.workspaceId).toBe("string");
		expect(response.answerable).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// the answer itself
// ---------------------------------------------------------------------------

function questionItem(): QuestionItem {
	return {
		index: 0,
		header: "Pick one",
		question: "Which?",
		multiSelect: false,
		options: [
			{ index: 0, label: "A", description: "" },
			{ index: 1, label: "B", description: "" },
		],
		freeTextOption: null,
	};
}

/** A pending question raised inside the session, as the store holds it. */
function sessionQuestion(): PendingQuestion {
	return {
		questionId: "AAAAAAAAAAAAAAAAAAAAAA" as QuestionId,
		fingerprint: "AQEBAQEBAQEBAQEBAQEBAQ" as Fingerprint,
		state: "pending",
		askedAtMs: 1,
		resolvedAtMs: null,
		resolvedBy: null,
		remoteAnswer: null,
		toolUseId: "tu-session",
		sessionId: "s-session",
		terminalId: "wire-terminal" as TerminalId,
		agentType: null,
		questions: [questionItem()],
		origin: "unauthenticated_localhost_hook",
		hostTerminalId: SESSION_TERMINAL_ID,
		hostWorkspaceId: SESSION_WORKSPACE_ID,
		transcriptPath: "",
		agentKind: "claude",
		agentId: null,
	} satisfies PendingQuestion;
}

function memoryLedger(): AttemptLedger {
	const records = new Map<string, LedgerRecord>();
	return {
		currentEpoch: () => "epoch-session",
		claimForAnswer: (claim) => {
			const previous = records.get(claim.requestId);
			if (previous !== undefined) return { kind: "replay", record: previous };
			records.set(claim.requestId, {
				requestId: claim.requestId,
				status: "claimed",
				questionId: claim.questionId,
				deviceId: claim.deviceId,
				surface: claim.surface,
				leaseId: null,
				startedAtMs: claim.startedAtMs,
				createdAtMs: claim.startedAtMs,
				resolvedAtMs: null,
				failureCode: null,
				guardsPassed: [],
				coverageEpoch: "epoch-session",
			} as unknown as LedgerRecord);
			return { kind: "claimed", coverageEpoch: "epoch-session" };
		},
		beginWrite: (requestId, leaseId) => {
			const current = records.get(requestId);
			if (current?.status !== "claimed") throw new Error("missing claim");
			records.set(requestId, { ...current, status: "in_flight", leaseId });
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

function answerHarness(question: PendingQuestion) {
	let now = 10_000;
	const writeTargets: { terminalId: string; workspaceId: string }[] = [];
	const repaints: HostTerminalRef[] = [];
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
			return true;
		},
		markStale: () => {
			question.state = "stale";
		},
	} as unknown as QuestionStore;
	const writeInput = Object.assign(
		async (input: RawWriteInput) => {
			writeTargets.push({
				terminalId: input.terminalId,
				workspaceId: input.workspaceId,
			});
			return { success: true as const };
		},
		{
			writerKind: RAW_PTY_WRITER_KIND,
			prepare: async (target: { terminalId: string; workspaceId: string }) => {
				// Stands in for `prepareAcknowledgedInputSession`, whose real
				// implementation calls `getOrAdoptSession` with exactly this pair.
				writeTargets.push({
					terminalId: target.terminalId,
					workspaceId: target.workspaceId,
				});
				return { success: true as const, acknowledgedInputSupported: true };
			},
		},
	);
	const deps = {
		writeInput,
		nudgeRepaint: (host: HostTerminalRef) => {
			repaints.push(host);
			return { success: true as const };
		},
		locks: createTerminalLockRegistry(),
		leases: createLeaseRegistry(),
		ledger: memoryLedger(),
		questions,
		markRemoteAnsweredAndPublish: questions.markRemoteAnswered,
		audit: { append: async () => {}, prune: async () => 0 },
		now: () => now++,
		delay: async () => {},
		log: () => {},
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
			deviceId: "device-session" as DeviceId,
			label: "phone",
			writeEnabled: true,
		},
	} as unknown as Parameters<typeof handleAnswer>[1];
	return { deps, ctx, request, question, writeTargets, repaints };
}

describe("(SESSIONS-PROJECT) answering a session question remotely", () => {
	it("confirms an answer submitted from the phone and writes it to the session's REAL (terminal, workspace) pair", async () => {
		const harness = answerHarness(sessionQuestion());

		const response = await handleAnswer(
			harness.deps,
			harness.ctx,
			harness.request,
		);

		expect(response.status).toBe("confirmed");
		expect(harness.question.remoteAnswer).toMatchObject({
			resolvedBy: { deviceLabel: "phone", surface: "phone" },
		});
		// Every target the answer path touched is the session's own pair. A
		// synthesised workspace id here would be refused by `getOrAdoptSession`
		// ("Workspace not found") and by `writableSession` ("does not belong to
		// this workspace") in production, which is why this is asserted on every
		// write rather than just the first.
		expect(harness.writeTargets.length).toBeGreaterThan(0);
		for (const target of harness.writeTargets) {
			expect(target).toEqual({
				terminalId: SESSION_TERMINAL_ID,
				workspaceId: SESSION_WORKSPACE_ID,
			});
		}
		expect(harness.repaints).toEqual([
			{
				hostTerminalId: SESSION_TERMINAL_ID,
				hostWorkspaceId: SESSION_WORKSPACE_ID,
			},
		]);
	});

	it("answers from the watch on the same path", async () => {
		const harness = answerHarness(sessionQuestion());

		const response = await handleAnswer(harness.deps, harness.ctx, {
			...harness.request,
			surface: "watch",
		});

		expect(response.status).toBe("confirmed");
		expect(harness.question.remoteAnswer).toMatchObject({
			resolvedBy: { deviceLabel: "phone", surface: "watch" },
		});
	});

	it("leaves the existing guards intact — a resolved session question is still refused, and no bytes are written", async () => {
		const resolved = sessionQuestion();
		resolved.state = "resolved";
		resolved.resolvedAtMs = 5;
		resolved.resolvedBy = { deviceLabel: "desk", surface: "desktop" };
		const harness = answerHarness(resolved);

		await expect(
			handleAnswer(harness.deps, harness.ctx, harness.request),
		).rejects.toThrow();
		expect(harness.writeTargets).toEqual([]);
	});

	it("still refuses a fingerprint that does not match the captured question", async () => {
		const harness = answerHarness(sessionQuestion());

		await expect(
			handleAnswer(harness.deps, harness.ctx, {
				...harness.request,
				fingerprint: "BQEBAQEBAQEBAQEBAQEBAQ" as Fingerprint,
			}),
		).rejects.toThrow();
		expect(harness.writeTargets).toEqual([]);
	});
});
