import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import {
	askqMarkerDirFor,
	askqMarkerRoot,
	exists,
	seedAskqOwner,
	withFakeHome,
} from "../../../../test/helpers/askq-markers";
import { createNotifyingCaptureSink } from "../../../companion/index";
import {
	createQuestionStore,
	type PendingQuestion,
	QUESTION_STALE_MANUAL_DISMISS_REASON,
	type QuestionSourceResolver,
	type QuestionStore,
} from "../../../companion/question-store";
import { createEventStreamServer } from "../../../companion/ws";
import type { HostDb } from "../../../db";
import * as schema from "../../../db/schema";
import { terminalSessions } from "../../../db/schema";
import { TerminalAgentStore } from "../../../terminal-agents";
import { setCompanionQuestionSink } from "../notifications";
import { dismissWorkspaceStatuses } from "./terminal-agents";

const MIGRATIONS_FOLDER = resolve(import.meta.dir, "../../../../drizzle");

const fakeHome = withFakeHome("dismiss-mutation-");

afterEach(() => {
	setCompanionQuestionSink(null);
});

function createTestDb(): HostDb {
	const sqlite = new Database(":memory:");
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
	// Same cast as the sibling router tests: bun:sqlite's drizzle type differs
	// from the better-sqlite3-based HostDb, the query surface used here does not.
	return db as unknown as HostDb;
}

function seedSession(
	db: HostDb,
	terminalId: string,
	workspaceId: string,
): void {
	db.insert(terminalSessions)
		.values({
			id: terminalId,
			status: "active",
			originWorkspaceId: workspaceId,
			createdAt: 1,
		})
		.run();
}

function storeWithBinding(
	bindings: { terminalId: string; workspaceId: string }[],
): TerminalAgentStore {
	const store = new TerminalAgentStore();
	for (const binding of bindings) {
		store.recordEvent({
			terminalId: binding.terminalId,
			workspaceId: binding.workspaceId,
			eventType: "SubagentActive",
			agentId: "claude",
			occurredAt: 1_000,
		});
	}
	return store;
}

describe("(MANUAL-DISMISS) dismissWorkspaceStatuses", () => {
	it("deletes the markers that existed at click time and flips the binding to Stop", async () => {
		const home = await fakeHome();
		const db = createTestDb();
		seedSession(db, "term-1", "ws-1");
		const owner = await seedAskqOwner(
			home,
			"term-1",
			"_main",
			Date.now() - 60_000,
		);
		const terminalAgentStore = storeWithBinding([
			{ terminalId: "term-1", workspaceId: "ws-1" },
		]);

		const result = await dismissWorkspaceStatuses(
			{ db, terminalAgentStore },
			{ workspaceId: "ws-1" },
		);

		expect(result.terminals).toEqual([
			{
				terminalId: "term-1",
				lastEventAt: 1_000,
				markersRemoved: 1,
				pendingAfter: false,
				questionDismissed: false,
			},
		]);
		expect(result.dismissStartedAtMs).toBeGreaterThan(0);
		expect(await exists(owner)).toBe(false);
		expect(terminalAgentStore.get("term-1")?.lastEventType).toBe("Stop");
	});

	it("reports pendingAfter for a question raised after the click and leaves its marker alone", async () => {
		const home = await fakeHome();
		const db = createTestDb();
		seedSession(db, "term-1", "ws-1");
		const late = await seedAskqOwner(
			home,
			"term-1",
			"sub-late",
			Date.now() + 5_000,
		);
		const terminalAgentStore = storeWithBinding([
			{ terminalId: "term-1", workspaceId: "ws-1" },
		]);

		const result = await dismissWorkspaceStatuses(
			{ db, terminalAgentStore },
			{ workspaceId: "ws-1" },
		);

		expect(result.terminals[0]).toMatchObject({
			markersRemoved: 0,
			pendingAfter: true,
		});
		expect(await exists(late)).toBe(true);
	});

	it("succeeds for the valid siblings of a terminal whose id could never have produced a marker", async () => {
		const home = await fakeHome();
		const db = createTestDb();
		// A session row whose id would traverse out of the marker root if the
		// guard were not inside the path builder.
		seedSession(db, "../victim", "ws-1");
		seedSession(db, "term-ok", "ws-1");
		const victim = join(home, ".superset", "victim.askq");
		await mkdir(victim, { recursive: true });
		await writeFile(join(victim, "_main"), "");
		const okOwner = await seedAskqOwner(
			home,
			"term-ok",
			"_main",
			Date.now() - 1_000,
		);

		const result = await dismissWorkspaceStatuses(
			{ db, terminalAgentStore: new TerminalAgentStore() },
			{ workspaceId: "ws-1" },
		);

		expect(result.terminals).toEqual([
			{
				terminalId: "../victim",
				lastEventAt: null,
				markersRemoved: 0,
				pendingAfter: false,
				questionDismissed: false,
			},
			{
				terminalId: "term-ok",
				lastEventAt: null,
				markersRemoved: 1,
				pendingAfter: false,
				questionDismissed: false,
			},
		]);
		expect(await exists(join(victim, "_main"))).toBe(true);
		expect(await exists(okOwner)).toBe(false);
	});

	it("never touches another workspace's terminals, even one named by the caller", async () => {
		const home = await fakeHome();
		const db = createTestDb();
		seedSession(db, "term-mine", "ws-1");
		seedSession(db, "term-theirs", "ws-2");
		const mine = await seedAskqOwner(
			home,
			"term-mine",
			"_main",
			Date.now() - 1_000,
		);
		const theirs = await seedAskqOwner(
			home,
			"term-theirs",
			"_main",
			Date.now() - 1_000,
		);
		const terminalAgentStore = storeWithBinding([
			{ terminalId: "term-mine", workspaceId: "ws-1" },
			{ terminalId: "term-theirs", workspaceId: "ws-2" },
		]);

		const result = await dismissWorkspaceStatuses(
			{ db, terminalAgentStore },
			{ workspaceId: "ws-1", terminalId: "term-theirs" },
		);

		// The client named a terminal it does not own; the DB read is the authority.
		expect(result.terminals).toEqual([]);
		expect(await exists(mine)).toBe(true);
		expect(await exists(theirs)).toBe(true);
		expect(terminalAgentStore.get("term-theirs")?.lastEventType).toBe(
			"SubagentActive",
		);
	});

	it("scopes to one terminal when the caller names one it does own", async () => {
		const home = await fakeHome();
		const db = createTestDb();
		seedSession(db, "term-a", "ws-1");
		seedSession(db, "term-b", "ws-1");
		const a = await seedAskqOwner(home, "term-a", "_main", Date.now() - 1_000);
		const b = await seedAskqOwner(home, "term-b", "_main", Date.now() - 1_000);

		const result = await dismissWorkspaceStatuses(
			{ db, terminalAgentStore: new TerminalAgentStore() },
			{ workspaceId: "ws-1", terminalId: "term-b" },
		);

		expect(result.terminals.map((entry) => entry.terminalId)).toEqual([
			"term-b",
		]);
		expect(await exists(a)).toBe(true);
		expect(await exists(b)).toBe(false);
	});

	it("sweeps a leaked marker off a terminal that has a session row but NO live binding", async () => {
		const home = await fakeHome();
		const db = createTestDb();
		seedSession(db, "term-orphan", "ws-1");
		const leaked = await seedAskqOwner(
			home,
			"term-orphan",
			"_main",
			Date.now() - 86_400_000,
		);

		const result = await dismissWorkspaceStatuses(
			{ db, terminalAgentStore: new TerminalAgentStore() },
			{ workspaceId: "ws-1" },
		);

		expect(result.terminals).toEqual([
			{
				terminalId: "term-orphan",
				lastEventAt: null,
				markersRemoved: 1,
				pendingAfter: false,
				questionDismissed: false,
			},
		]);
		expect(await exists(leaked)).toBe(false);
	});

	it("aborts LOUD on a marker failure and names the terminals that were already dismissed", async () => {
		const home = await fakeHome();
		const db = createTestDb();
		seedSession(db, "term-ok", "ws-1");
		seedSession(db, "term-wedged", "ws-1");
		seedSession(db, "term-never", "ws-1");
		const ok = await seedAskqOwner(
			home,
			"term-ok",
			"_main",
			Date.now() - 1_000,
		);
		const never = await seedAskqOwner(
			home,
			"term-never",
			"_main",
			Date.now() - 1_000,
		);
		// A file where `term-wedged`'s marker directory belongs: readdir ENOTDIRs.
		await writeFile(join(askqMarkerRoot(home), "term-wedged.askq"), "");

		const failure = await dismissWorkspaceStatuses(
			{ db, terminalAgentStore: new TerminalAgentStore() },
			{ workspaceId: "ws-1" },
		).then(
			() => null,
			(error: Error) => error,
		);

		expect(failure).not.toBeNull();
		expect(failure?.message).toContain("term-wedged");
		expect(failure?.message).toContain("INCOMPLETE");
		expect(failure?.message).toContain("term-ok");
		expect(failure?.message).not.toContain("term-never");
		// The work that DID happen is real, which is exactly why the caller may not
		// be told the whole dismissal succeeded.
		expect(await exists(ok)).toBe(false);
		expect(await exists(never)).toBe(true);
	});
});

// ---------------------------------------------------------------------------

function resolver(): QuestionSourceResolver {
	return {
		resolveTerminal: () => ({
			hostProjectId: "p-1",
			hostWorkspaceId: "ws-1",
			agentId: "claude",
		}),
		resolveActiveTerminal: () => ({
			hostProjectId: "p-1",
			hostWorkspaceId: "ws-1",
			agentId: "claude",
		}),
		resolveTranscriptPath: () => null,
		resolveTerminalActivityMs: () => Date.now(),
	};
}

function captureInput(hostTerminalId: string, askedAtMs = Date.now() - 60_000) {
	return {
		hostTerminalId,
		workspaceId: "ws-1",
		toolUseId: "tu-1",
		sessionId: "s-1",
		transcriptPath: "C:/transcripts/s-1.jsonl",
		cwd: "C:/wt/ws-1",
		agentId: null,
		agentType: null,
		askedAtMs,
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

/**
 * The real store + the real event stream, wired to `push.cancelPending` through
 * `onSettled` exactly as `createCompanionBridge` wires them. Faking the store
 * here would prove nothing: the whole claim under test is that `markStale`
 * reaches the retraction through the `(SETTLE-CHOKE-POINT)` seam.
 */
function registerBridgeSink(askedAtMs?: number): {
	questions: QuestionStore;
	cancelled: string[];
	frames: { t: string; d: unknown }[];
	gseq: () => number;
} {
	const cancelled: string[] = [];
	const frames: { t: string; d: unknown }[] = [];
	const questions = createQuestionStore({
		source: resolver(),
		liveness: { isProvablyGone: () => false },
		onSettled: (question: PendingQuestion) => {
			cancelled.push(question.questionId);
		},
	});
	const events = createEventStreamServer(
		{} as unknown as Parameters<typeof createEventStreamServer>[0],
	);
	const publish = events.publish.bind(events);
	const sink = createNotifyingCaptureSink({
		inner: questions.asCaptureSink(),
		questions,
		push: { schedule: () => {}, cancelPending: () => {} } as never,
		events: {
			publish: (frame: { t: string; d: unknown }) => {
				frames.push(frame);
				publish(frame as never);
			},
		} as never,
		logger: { info: () => {}, warn: () => {}, error: () => {} },
	});
	setCompanionQuestionSink(sink);
	sink.capture(captureInput("term-1", askedAtMs));
	return { questions, cancelled, frames, gseq: () => events.currentGseq() };
}

describe("(MANUAL-DISMISS) companion dismissal", () => {
	it("marks the question stale (never resolved), retracts the push, and publishes a stale frame that advances gseq", async () => {
		const home = await fakeHome();
		const db = createTestDb();
		seedSession(db, "term-1", "ws-1");
		await seedAskqOwner(home, "term-1", "_main", Date.now() - 60_000);
		const bridge = registerBridgeSink();
		const question = bridge.questions.byHostTerminal("term-1");
		if (question === null) throw new Error("expected a pending question");
		const gseqBefore = bridge.gseq();

		const result = await dismissWorkspaceStatuses(
			{ db, terminalAgentStore: new TerminalAgentStore() },
			{ workspaceId: "ws-1" },
		);

		expect(result.terminals[0]?.questionDismissed).toBe(true);
		// `stale`, NOT `resolved`: nobody answered, so there is no provenance.
		expect(bridge.questions.get(question.questionId)?.state).toBe("stale");
		expect(bridge.questions.get(question.questionId)?.resolvedBy).toBeNull();
		// settle() -> onSettled -> push.cancelPending
		expect(bridge.cancelled).toEqual([question.questionId]);
		expect(bridge.frames.at(-1)).toEqual({
			t: "question.stale",
			d: {
				questionId: question.questionId,
				reason: QUESTION_STALE_MANUAL_DISMISS_REASON,
			},
		});
		expect(bridge.gseq()).toBe(gseqBefore + 1);
	});

	it("reports questionDismissed false without throwing when no bridge is running", async () => {
		const home = await fakeHome();
		const db = createTestDb();
		seedSession(db, "term-1", "ws-1");
		const owner = await seedAskqOwner(
			home,
			"term-1",
			"_main",
			Date.now() - 60_000,
		);

		const result = await dismissWorkspaceStatuses(
			{ db, terminalAgentStore: new TerminalAgentStore() },
			{ workspaceId: "ws-1" },
		);

		expect(result.terminals[0]?.questionDismissed).toBe(false);
		// The dot work still happened — a dismissal must not depend on the bridge.
		expect(await exists(owner)).toBe(false);
	});

	it("reports questionDismissed false when the bridge has no pending question for the terminal", async () => {
		const home = await fakeHome();
		const db = createTestDb();
		seedSession(db, "term-other", "ws-1");
		await seedAskqOwner(home, "term-other", "_main", Date.now() - 60_000);
		const bridge = registerBridgeSink();

		const result = await dismissWorkspaceStatuses(
			{ db, terminalAgentStore: new TerminalAgentStore() },
			{ workspaceId: "ws-1" },
		);

		expect(result.terminals[0]?.questionDismissed).toBe(false);
		expect(bridge.cancelled).toEqual([]);
		expect(
			await readdir(askqMarkerDirFor(home, "term-1")).catch(() => null),
		).toBeNull();
	});

	it("leaves the companion question alone when a MARKER survived the click — the phone must still be able to answer it", async () => {
		const home = await fakeHome();
		const db = createTestDb();
		seedSession(db, "term-1", "ws-1");
		// The question the user was looking at was answered; the agent asked a new
		// one between the click and the sweep, and its marker is newer than the click.
		const late = await seedAskqOwner(
			home,
			"term-1",
			"sub-late",
			Date.now() + 5_000,
		);
		const bridge = registerBridgeSink();
		const question = bridge.questions.byHostTerminal("term-1");
		if (question === null) throw new Error("expected a pending question");
		const framesBefore = bridge.frames.length;

		const result = await dismissWorkspaceStatuses(
			{ db, terminalAgentStore: new TerminalAgentStore() },
			{ workspaceId: "ws-1" },
		);

		expect(result.terminals[0]).toMatchObject({
			pendingAfter: true,
			questionDismissed: false,
		});
		// Still answerable from the phone: pending, not settled, push not retracted,
		// no stale frame telling the watch to drop the alert.
		expect(bridge.questions.get(question.questionId)?.state).toBe("pending");
		expect(bridge.cancelled).toEqual([]);
		expect(bridge.frames.length).toBe(framesBefore);
		expect(await exists(late)).toBe(true);
	});

	it("leaves a companion question RAISED AFTER the click alone even when the markers all predate it", async () => {
		const home = await fakeHome();
		const db = createTestDb();
		seedSession(db, "term-1", "ws-1");
		// Marker sweep finds nothing to keep: the old question's owner was removed
		// by the answer that ended it. Only `askedAtMs` can see the new question.
		const owner = await seedAskqOwner(
			home,
			"term-1",
			"_main",
			Date.now() - 60_000,
		);
		const bridge = registerBridgeSink(Date.now() + 5_000);
		const question = bridge.questions.byHostTerminal("term-1");
		if (question === null) throw new Error("expected a pending question");
		const framesBefore = bridge.frames.length;

		const result = await dismissWorkspaceStatuses(
			{ db, terminalAgentStore: new TerminalAgentStore() },
			{ workspaceId: "ws-1" },
		);

		expect(result.terminals[0]).toMatchObject({
			markersRemoved: 1,
			pendingAfter: false,
			questionDismissed: false,
		});
		expect(bridge.questions.get(question.questionId)?.state).toBe("pending");
		expect(bridge.cancelled).toEqual([]);
		expect(bridge.frames.length).toBe(framesBefore);
		expect(await exists(owner)).toBe(false);
	});
});
