import { describe, expect, it } from "bun:test";
import { RETRACT_TTL_MS } from "./config";
import { buildRetractPushData } from "./push";
import {
	createQuestionStore,
	type PendingQuestion,
	type QuestionSourceResolver,
} from "./question-store";
import type { QuestionId, QuestionItem, WorkspaceId } from "./types";

const QUESTION = "q-1" as QuestionId;
const WORKSPACE = "w-1" as WorkspaceId;

/**
 * (RETRACT-TTL) The client applies `x` BEFORE it switches on `k`, so these are
 * assertions about whether a retraction is readable at all — not about
 * formatting.
 */
describe("(RETRACT-TTL) buildRetractPushData", () => {
	it("stamps an expiry in the FUTURE — a retraction stamped with `now` is discarded by the client's isExpired check before it ever reaches the retract branch", () => {
		const nowMs = 1_800_000_000_000;
		const data = buildRetractPushData({
			questionId: QUESTION,
			workspaceId: WORKSPACE,
			nowMs,
		});
		expect(Number(data.x)).toBe(nowMs + RETRACT_TTL_MS);
		expect(Number(data.x)).toBeGreaterThan(nowMs);
	});

	it("outlives a phone that was off the network for a working day", () => {
		// The delivery delay the constant is sized against: powered down, in Doze,
		// or out of coverage while the question was answered at the desk.
		expect(RETRACT_TTL_MS).toBeGreaterThanOrEqual(12 * 60 * 60 * 1000);
	});

	it("still identifies the notification the client is holding", () => {
		const data = buildRetractPushData({
			questionId: QUESTION,
			workspaceId: WORKSPACE,
			nowMs: 1_800_000_000_000,
		});
		expect(data).toMatchObject({
			v: "1",
			k: "r",
			i: QUESTION,
			w: WORKSPACE,
			n: "0",
		});
	});

	it("refuses a non-epoch `nowMs` rather than minting `NaN` into the expiry", () => {
		expect(() =>
			buildRetractPushData({
				questionId: QUESTION,
				workspaceId: WORKSPACE,
				nowMs: Number.NaN,
			}),
		).toThrow();
	});
});

// ---------------------------------------------------------------------------
// (SETTLE-CHOKE-POINT)
// ---------------------------------------------------------------------------

const NOW = Date.now();

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

function captureInput(overrides: Record<string, unknown> = {}) {
	return {
		hostTerminalId: "term-live",
		workspaceId: "w-1",
		toolUseId: "tu-1",
		sessionId: "s-1",
		transcriptPath: "",
		cwd: "C:/wt/w-1",
		agentId: null,
		agentType: null,
		askedAtMs: NOW - 60_000,
		questions: [questionItem()],
		...overrides,
	};
}

function resolver(): QuestionSourceResolver {
	return {
		resolveTerminal: () => ({
			hostProjectId: "p-1",
			hostWorkspaceId: "w-1",
			agentId: "claude",
		}),
		resolveActiveTerminal: () => ({
			hostProjectId: "p-1",
			hostWorkspaceId: "w-1",
			agentId: "claude",
		}),
		resolveTranscriptPath: () => null,
		resolveTerminalActivityMs: () => NOW - 60_000,
	};
}

describe("(HOOK-CLAIM-NOT-TRUSTED) the workspace a question belongs to", () => {
	it("stores host.db's value, not the hook's claim", () => {
		const store = createQuestionStore({
			source: resolver(),
			liveness: { isProvablyGone: () => false },
			onSettled: () => {},
		});
		// An unauthenticated localhost POST naming somebody else's thread. That id
		// decides which thread the phone opens and is the one the curation gate
		// asks about, so the derived value is the only one that may be stored.
		const question = store.capture(
			captureInput({ workspaceId: "w-somebody-elses" }),
		);
		expect(question.hostWorkspaceId).toBe("w-1");
	});
});

/** The store plus the record of everything its settle seam reported. */
function settleHarness() {
	const settled: { questionId: QuestionId; state: string }[] = [];
	const store = createQuestionStore({
		source: resolver(),
		liveness: { isProvablyGone: () => false },
		onSettled: (question: PendingQuestion) => {
			settled.push({
				questionId: question.questionId,
				state: question.state,
			});
		},
	});
	return { store, settled };
}

/**
 * One assertion per route out of `pending`. The bug these replace was not that
 * any one route was wrong — it was that retraction was wired per-route, so the
 * two routes nobody wired (a REMOTE answer, and a supersede) left the watch
 * buzzing about a question that no longer existed.
 */
describe("(SETTLE-CHOKE-POINT) every route out of `pending` reports itself", () => {
	it("a REMOTE answer — the path `/v1/answer` takes, which had no retraction wiring at all", () => {
		const { store, settled } = settleHarness();
		const question = store.capture(captureInput());
		expect(
			store.resolve(
				question.questionId,
				{ deviceLabel: "pixel", surface: "phone" },
				NOW,
			),
		).toBe(true);
		expect(settled).toEqual([
			{ questionId: question.questionId, state: "resolved" },
		]);
	});

	it("a DESK answer through the capture sink", () => {
		const { store, settled } = settleHarness();
		const question = store.capture(captureInput());
		store.asCaptureSink().resolve({
			hostTerminalId: "term-live",
			toolUseId: "tu-1",
			resolvedAtMs: NOW,
		});
		expect(settled).toEqual([
			{ questionId: question.questionId, state: "resolved" },
		]);
	});

	it("a SUPERSEDE — the prior record left `pending` by a direct field write, so nothing retracted its notification", () => {
		const { store, settled } = settleHarness();
		const first = store.capture(captureInput());
		const second = store.capture(
			captureInput({ toolUseId: "tu-2", sessionId: "s-2" }),
		);
		expect(second.questionId).not.toBe(first.questionId);
		expect(settled).toEqual([{ questionId: first.questionId, state: "stale" }]);
		// And the supersede still re-points the terminal at the new question.
		expect(store.byHostTerminal("term-live")?.questionId).toBe(
			second.questionId,
		);
	});

	it("a RECONCILE-STALE settle", () => {
		const { store, settled } = settleHarness();
		const question = store.capture(captureInput());
		store.markStale(question.questionId, "terminal_gone");
		expect(settled).toEqual([
			{ questionId: question.questionId, state: "stale" },
		]);
	});

	it("reports each ending exactly once — a second resolve is not a second retraction", () => {
		const { store, settled } = settleHarness();
		const question = store.capture(captureInput());
		store.resolve(
			question.questionId,
			{ deviceLabel: null, surface: "desktop" },
			NOW,
		);
		store.resolve(
			question.questionId,
			{ deviceLabel: null, surface: "desktop" },
			NOW,
		);
		store.markStale(question.questionId, "terminal_gone");
		expect(settled).toHaveLength(1);
	});

	it("does not let a thrown sink un-settle the question — the answer was already typed by then", () => {
		const store = createQuestionStore({
			source: resolver(),
			liveness: { isProvablyGone: () => false },
			onSettled: () => {
				throw new Error("FCM is down");
			},
		});
		const question = store.capture(captureInput());
		expect(() =>
			store.resolve(
				question.questionId,
				{ deviceLabel: "pixel", surface: "phone" },
				NOW,
			),
		).not.toThrow();
		expect(store.get(question.questionId)?.state).toBe("resolved");
	});
});
