import { describe, expect, it } from "bun:test";
import {
	createNotifyingCaptureSink,
	markRemoteAnsweredAndPublish,
} from "./index";
import {
	createQuestionStore,
	type QuestionSourceResolver,
} from "./question-store";

const NOW = Date.now();

function source(): QuestionSourceResolver {
	return {
		resolveTerminal: () => ({
			hostProjectId: "project-1",
			hostWorkspaceId: "workspace-1",
			agentId: "claude",
		}),
		resolveActiveTerminal: () => ({
			hostProjectId: "project-1",
			hostWorkspaceId: "workspace-1",
			agentId: "claude",
		}),
		resolveTranscriptPath: () => null,
		resolveTerminalActivityMs: () => NOW,
	};
}

function captureInput() {
	return {
		hostTerminalId: "terminal-1",
		workspaceId: "workspace-1",
		toolUseId: "tool-use-1",
		sessionId: "session-1",
		transcriptPath: "C:/transcripts/session-1.jsonl",
		cwd: "C:/repo",
		agentId: null,
		agentType: null,
		askedAtMs: NOW,
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
}

describe("companion remote-answer settlement events", () => {
	it("publishes corrected phone provenance when PostToolUse wins the race", () => {
		const frames: Record<string, unknown>[] = [];
		const store = createQuestionStore({
			source: source(),
			liveness: { isProvablyGone: () => false },
			onSettled: () => {},
		});
		const inner = store.asCaptureSink();
		const sink = createNotifyingCaptureSink({
			inner,
			questions: store,
			push: {
				schedule: () => {},
				cancelPending: () => {},
			} as never,
			events: {
				publish: (frame: Record<string, unknown>) => frames.push(frame),
			} as never,
			logger: { info: () => {}, warn: () => {}, error: () => {} },
		});
		sink.capture(captureInput());
		const question = store.byHostTerminal("terminal-1");
		if (question === null) throw new Error("expected pending question");

		sink.resolve({
			hostTerminalId: question.hostTerminalId,
			toolUseId: question.toolUseId,
			resolvedAtMs: NOW + 2,
		});
		expect(frames.at(-1)).toMatchObject({
			t: "question.resolved",
			d: { resolvedBy: { deviceLabel: null, surface: "desktop" } },
		});

		const resolvedBy = { deviceLabel: "phone", surface: "phone" } as const;
		const deliveredAtMs = NOW + 1;
		markRemoteAnsweredAndPublish(
			{
				questions: store,
				events: {
					publish: (frame: Record<string, unknown>) => frames.push(frame),
				} as never,
				logger: { info: () => {}, warn: () => {}, error: () => {} },
			},
			question.questionId,
			resolvedBy,
			deliveredAtMs,
		);

		expect(frames.at(-1)).toEqual({
			t: "question.resolved",
			d: {
				questionId: question.questionId,
				resolvedAtMs: deliveredAtMs,
				resolvedBy,
				outcome: "answered",
			},
		});
	});
});
