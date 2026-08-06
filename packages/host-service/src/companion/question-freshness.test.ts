import { describe, expect, it } from "bun:test";
import { BRIDGE_CAPABILITIES } from "./config";
import { type NotifyingSinkDeps, publishPendingQuestion } from "./index";
import {
	createQuestionStore,
	type PendingQuestion,
	type QuestionSourceResolver,
} from "./question-store";
import type { QuestionItem } from "./types";

// ---------------------------------------------------------------------------
// (TREE-FRESHNESS-GSEQ)
//
// The bug these cover: `gseq` moved for exactly ONE reason, a question
// RESOLVING. A capture moved nothing, and the counts beside it do not always
// move either — `deriveSessionStatus` already reports `needs_input` for a
// terminal whose binding is latched on `PermissionRequest` — so the phone kept
// stamping its list "updated just now" over a tree with no tappable card for a
// live blocked agent.
// ---------------------------------------------------------------------------

const NOW = Date.now();

function questionItem(overrides: Partial<QuestionItem> = {}): QuestionItem {
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
		...overrides,
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

function resolver(
	overrides: Partial<QuestionSourceResolver> = {},
): QuestionSourceResolver {
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
		...overrides,
	};
}

function pendingQuestion(overrides: Record<string, unknown> = {}) {
	const store = createQuestionStore({
		source: resolver(),
		liveness: { isProvablyGone: () => false },
		onSettled: () => {},
	});
	return { store, question: store.capture(captureInput(overrides)) };
}

describe("(TREE-FRESHNESS-GSEQ) QuestionStore.summarize", () => {
	it("projects the §9.4 identity and shape fields, and reports a claude question as answerable to a fully-granted device", () => {
		const { store, question } = pendingQuestion();
		const summary = store.summarize(question, {
			granted: BRIDGE_CAPABILITIES,
		});
		expect(summary).not.toBeNull();
		expect(summary).toMatchObject({
			questionId: question.questionId,
			fingerprint: question.fingerprint,
			terminalId: question.terminalId,
			askedAtMs: question.askedAtMs,
			questionCount: 1,
			multiSelect: false,
			answerable: true,
			headline: "Pick one",
		});
		// DERIVED handles, never the raw host.db ids — the same opaque values
		// `/v1/tree` puts on the wire.
		expect(summary?.workspaceId).not.toBe("w-1");
		expect(summary?.projectId).not.toBe("p-1");
	});

	it("counts the items and reports multiSelect when ANY item is multi-select", () => {
		const { store, question } = pendingQuestion({
			questions: [
				questionItem(),
				questionItem({ index: 1, multiSelect: true }),
			],
		});
		const summary = store.summarize(question, {
			granted: BRIDGE_CAPABILITIES,
		});
		expect(summary?.questionCount).toBe(2);
		expect(summary?.multiSelect).toBe(true);
	});

	it("decides `answerable` with the same rule as every other surface — an ungranted context makes it false rather than throwing", () => {
		const { store, question } = pendingQuestion();
		expect(store.summarize(question, { granted: [] })?.answerable).toBe(false);
	});

	it("clamps the headline to the first item's header, never the body", () => {
		const { store, question } = pendingQuestion({
			questions: [questionItem({ header: "Deploy to prod?" })],
		});
		expect(
			store.summarize(question, { granted: BRIDGE_CAPABILITIES })?.headline,
		).toBe("Deploy to prod?");
	});

	it("FAILS CLOSED: a record whose terminal no longer resolves in host.db is dropped, not published with a guessed project handle", () => {
		const { question } = pendingQuestion();
		// The row goes away between capture and the frame — a disposed terminal, a
		// pruned workspace. `resolveSource` throws, and a fabricated identity on
		// the wire is worse than a missing frame.
		const gone = createQuestionStore({
			source: resolver({ resolveTerminal: () => null }),
			liveness: { isProvablyGone: () => false },
			onSettled: () => {},
		});
		expect(
			gone.summarize(question, { granted: BRIDGE_CAPABILITIES }),
		).toBeNull();
	});
});

describe("(TREE-FRESHNESS-GSEQ) publishPendingQuestion", () => {
	function sink(
		summarize: unknown,
		publish: (frame: { t: string; d: unknown }) => void,
	): { deps: NotifyingSinkDeps; warns: string[]; errors: string[] } {
		const warns: string[] = [];
		const errors: string[] = [];
		const deps = {
			inner: { capture: () => {}, resolve: () => {} },
			questions: { summarize },
			push: {},
			events: { publish },
			logger: {
				info: () => {},
				warn: (message: string) => {
					warns.push(message);
				},
				error: (message: string) => {
					errors.push(message);
				},
			},
			db: {},
			organizationId: "org-1",
		} as unknown as NotifyingSinkDeps;
		return { deps, warns, errors };
	}

	const question = { questionId: "q-1" } as unknown as PendingQuestion;

	it("publishes a question.pending frame carrying the summary, which is what moves `gseq` on a capture", () => {
		const frames: { t: string; d: unknown }[] = [];
		const summary = { questionId: "q-1" };
		const { deps } = sink(
			() => summary,
			(frame) => frames.push(frame),
		);
		publishPendingQuestion(deps, question);
		expect(frames).toEqual([{ t: "question.pending", d: summary }]);
	});

	it("evaluates `answerable` against the bridge's OWN capabilities — a broadcast frame has no device to narrow to", () => {
		const granted: (readonly string[])[] = [];
		const { deps } = sink(
			(_question: PendingQuestion, ctx: { granted: readonly string[] }) => {
				granted.push(ctx.granted);
				return { questionId: "q-1" };
			},
			() => {},
		);
		publishPendingQuestion(deps, question);
		expect(granted).toEqual([BRIDGE_CAPABILITIES]);
	});

	it("publishes NOTHING, and says so, when the record cannot be summarised", () => {
		const frames: unknown[] = [];
		const { deps, warns } = sink(
			() => null,
			(frame) => frames.push(frame),
		);
		publishPendingQuestion(deps, question);
		expect(frames).toEqual([]);
		expect(warns).toHaveLength(1);
	});

	it("NEVER throws into the capture path — a capture that succeeded must not become a 500 over a freshness signal", () => {
		const { deps, errors } = sink(
			() => {
				throw new Error("the store is having a day");
			},
			() => {},
		);
		expect(() => publishPendingQuestion(deps, question)).not.toThrow();
		expect(errors).toHaveLength(1);
	});

	it("swallows a throwing publish too, not only a throwing summarize", () => {
		const { deps, errors } = sink(
			() => ({ questionId: "q-1" }),
			() => {
				throw new Error("no sockets today");
			},
		);
		expect(() => publishPendingQuestion(deps, question)).not.toThrow();
		expect(errors).toHaveLength(1);
	});
});
