import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../db";
import { projects, terminalSessions, workspaces } from "../db/schema";
import {
	CaptureRejectedError,
	createQuestionStore,
	QUESTION_EXPIRY_CORROBORATION_MS,
	type QuestionSourceResolver,
	type QuestionStore,
} from "./question-store";
import { openHostDbReadOnly } from "./read-api";
import type { QuestionItem } from "./types";

const NOW = Date.now();
const OLD = NOW - 7 * 86_400_000;

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
		// EMPTY on purpose: `markTranscript` returns null and
		// `verifyResolvedInTranscript` answers `unreadable`, which is "I could not
		// check". That is exactly the state the expiry path has to handle, and it
		// keeps these cases off the filesystem.
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

// ---------------------------------------------------------------------------
// (CAPTURE-BOUNDED) the capture gate — read-api's `resolveActiveTerminal`
// ---------------------------------------------------------------------------

describe("(CAPTURE-BOUNDED) capture is gated on an ACTIVE terminal", () => {
	it("refuses a capture whose terminal is not active, even though the unrestricted resolver would answer for it", () => {
		const store = createQuestionStore({
			source: resolver({ resolveActiveTerminal: () => null }),
			liveness: { isProvablyGone: () => false },
			onSettled: () => {},
		});
		expect(() => store.capture(captureInput())).toThrow(CaptureRejectedError);
		expect(store.listPending()).toEqual([]);
	});

	it("accepts one whose terminal is active", () => {
		const store = createQuestionStore({
			source: resolver(),
			liveness: { isProvablyGone: () => false },
			onSettled: () => {},
		});
		const question = store.capture(captureInput());
		expect(question.state).toBe("pending");
		expect(store.listPending()).toHaveLength(1);
	});
});

describe("(CAPTURE-BOUNDED) resolveActiveTerminal against real SQL", () => {
	const dir = mkdtempSync(join(tmpdir(), "companion-capture-"));
	const dbPath = join(dir, "host.db");
	const db = createDb(dbPath, join(import.meta.dirname, "..", "..", "drizzle"));
	db.insert(projects)
		.values({
			id: "p-1",
			repoPath: "C:/repo",
			name: "repo",
			createdAt: OLD,
		})
		.run();
	db.insert(workspaces)
		.values({
			id: "w-1",
			projectId: "p-1",
			name: "feature",
			branch: "feature",
			worktreePath: "C:/wt/feature",
			type: "worktree",
			createdAt: OLD,
		})
		.run();
	db.insert(terminalSessions)
		.values([
			{
				id: "term-live",
				originWorkspaceId: "w-1",
				status: "active",
				createdAt: OLD,
			},
			{
				id: "term-disposed",
				originWorkspaceId: "w-1",
				status: "disposed",
				createdAt: OLD,
				endedAt: OLD + 1_000,
			},
			{
				id: "term-ended-but-active",
				originWorkspaceId: "w-1",
				status: "active",
				createdAt: OLD,
				endedAt: OLD + 1_000,
			},
			// No workspace join: `origin_workspace_id` is null.
			{
				id: "term-orphan",
				originWorkspaceId: null,
				status: "active",
				createdAt: OLD,
			},
		])
		.run();
	const reader = openHostDbReadOnly(dbPath);

	afterAll(() => {
		reader.close();
		db.$client.close();
		// Best-effort. Windows keeps a handle on a WAL sidecar for a moment after
		// the last connection closes, and EBUSY on a temp directory must not fail
		// a suite that has already proved what it came to prove.
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// left for the OS to reap
		}
	});

	it("answers for a live row", () => {
		expect(reader.resolveActiveTerminal("term-live")).toEqual({
			hostProjectId: "p-1",
			hostWorkspaceId: "w-1",
			agentId: null,
		});
	});

	it.each([
		"term-disposed",
		"term-ended-but-active",
		"term-orphan",
		"term-nope",
	])("refuses %s", (id) => {
		expect(reader.resolveActiveTerminal(id)).toBeNull();
	});

	it("but the UNRESTRICTED resolver still answers for a disposed row — reopening a question you already answered must not 500", () => {
		expect(reader.resolveTerminal("term-disposed")).not.toBeNull();
		expect(reader.resolveTerminal("term-ended-but-active")).not.toBeNull();
	});
});

// ---------------------------------------------------------------------------
// (QUESTION-EXPIRY) the two-pass reconcile loop
// ---------------------------------------------------------------------------

/** The capture above is the only pending record; assert that rather than assume it. */
function requireFirstPendingId(store: QuestionStore) {
	const first = store.listPending()[0];
	if (first === undefined) throw new Error("expected one pending question");
	return first.questionId;
}

describe("transcript reconciliation cache", () => {
	it("retries an unreadable transcript even when its stat identity is unchanged", async () => {
		const dir = mkdtempSync(join(tmpdir(), "companion-reconcile-cache-"));
		const transcriptPath = join(dir, "session.jsonl");
		writeFileSync(transcriptPath, "stable transcript bytes", "utf8");
		try {
			const store = createQuestionStore({
				source: resolver(),
				liveness: { isProvablyGone: () => false },
				onSettled: () => {},
			});
			const question = store.capture(captureInput({ transcriptPath }));
			let scans = 0;
			store.verifyResolvedInTranscript = async () => {
				scans += 1;
				return scans === 1 ? "unreadable" : "resolved";
			};

			expect(await store.reconcile(NOW)).toEqual([]);
			expect(store.get(question.questionId)?.state).toBe("pending");
			expect(await store.reconcile(NOW + 1)).toEqual([question.questionId]);
			expect(store.get(question.questionId)?.state).toBe("resolved");
			expect(scans).toBe(2);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not overwrite a phone resolution that lands during the transcript read", async () => {
		const dir = mkdtempSync(join(tmpdir(), "companion-reconcile-race-"));
		const transcriptPath = join(dir, "session.jsonl");
		writeFileSync(transcriptPath, "stable transcript bytes", "utf8");
		try {
			const store = createQuestionStore({
				source: resolver(),
				liveness: { isProvablyGone: () => false },
				onSettled: () => {},
			});
			const question = store.capture(captureInput({ transcriptPath }));
			let announceScan!: () => void;
			const scanStarted = new Promise<void>((resolve) => {
				announceScan = resolve;
			});
			let finishScan!: (verdict: "resolved") => void;
			const scanResult = new Promise<"resolved">((resolve) => {
				finishScan = resolve;
			});
			store.verifyResolvedInTranscript = async () => {
				announceScan();
				return scanResult;
			};

			const reconciliation = store.reconcile(NOW);
			await scanStarted;
			expect(
				store.resolve(
					question.questionId,
					{ deviceLabel: "phone", surface: "phone" },
					NOW - 1,
				),
			).toBe(true);
			finishScan("resolved");

			expect(await reconciliation).toEqual([]);
			expect(store.get(question.questionId)?.resolvedBy).toEqual({
				deviceLabel: "phone",
				surface: "phone",
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("(QUESTION-EXPIRY) reconcile needs TWO observations", () => {
	function goneStore(isProvablyGone: () => boolean): QuestionStore {
		const store = createQuestionStore({
			source: resolver(),
			liveness: { isProvablyGone },
			onSettled: () => {},
		});
		store.capture(captureInput());
		return store;
	}

	it("a SINGLE observation can never expire a question, however far in the future the pass runs", async () => {
		const store = goneStore(() => true);
		// A whole day past the corroboration window, on the FIRST pass. The clock
		// starts at the first sighting, so age alone proves nothing — the second
		// sighting is the evidence, and it has not happened.
		const settled = await store.reconcile(NOW + 86_400_000);
		expect(settled).toEqual([]);
		expect(store.listPending()).toHaveLength(1);
	});

	it("expires on the second observation, once the window has passed", async () => {
		const store = goneStore(() => true);
		const questionId = requireFirstPendingId(store);

		expect(await store.reconcile(NOW)).toEqual([]);
		expect(store.get(questionId)?.state).toBe("pending");

		// Inside the window: carried forward, still pending, still armed.
		expect(
			await store.reconcile(NOW + QUESTION_EXPIRY_CORROBORATION_MS - 1),
		).toEqual([]);
		expect(store.get(questionId)?.state).toBe("pending");

		expect(
			await store.reconcile(NOW + QUESTION_EXPIRY_CORROBORATION_MS),
		).toEqual([questionId]);
		expect(store.get(questionId)?.state).toBe("stale");
		expect(store.listPending()).toEqual([]);
	});

	it("a FLAP resets the clock — one pass that sees the terminal alive undoes the standing of every pass before it", async () => {
		let gone = true;
		const store = goneStore(() => gone);
		const questionId = requireFirstPendingId(store);

		await store.reconcile(NOW);
		gone = false;
		await store.reconcile(NOW + 1_000);
		gone = true;
		// Far past the window measured from the FIRST sighting, but the flap
		// dropped that candidacy, so this is a first sighting again.
		expect(
			await store.reconcile(NOW + QUESTION_EXPIRY_CORROBORATION_MS * 3),
		).toEqual([]);
		expect(store.get(questionId)?.state).toBe("pending");
	});

	it("never expires a question whose terminal is not PROVABLY gone, however many passes run", async () => {
		const store = goneStore(() => false);
		for (let i = 0; i < 5; i++) {
			expect(
				await store.reconcile(NOW + i * QUESTION_EXPIRY_CORROBORATION_MS * 2),
			).toEqual([]);
		}
		expect(store.listPending()).toHaveLength(1);
	});

	it("passes the row's own activity stamp to the liveness predicate — a terminal born after the daemon snapshot must not lose that race", async () => {
		const seen: (number | null | undefined)[] = [];
		const store = createQuestionStore({
			source: resolver({ resolveTerminalActivityMs: () => 4_242 }),
			liveness: {
				isProvablyGone: (_id, lastActivityMs) => {
					seen.push(lastActivityMs);
					return false;
				},
			},
			onSettled: () => {},
		});
		store.capture(captureInput());
		await store.reconcile(NOW);
		expect(seen).toEqual([4_242]);
	});
});
