import { describe, expect, it } from "bun:test";
import { NON_GIT_BRANCH } from "../runtime/git/non-git";
import {
	CURATION_RECHECK_MS,
	PUSH_GONE_CORROBORATION_MS,
	PUSH_QUESTION_EXPIRY_MS,
} from "./config";
import type { DeviceStore } from "./device-store";
import {
	armPush,
	createFireVerdictProbe,
	createIsCuratedOffProbe,
	type NotifyingSinkDeps,
} from "./index";
import type { PresenceStore } from "./presence";
import {
	createPushSender,
	PUSH_SWEEP_INTERVAL_MS,
	type PushFireVerdict,
} from "./push";
import type { PushFence, PushFenceRecord } from "./push-fence";
import type {
	OrphanTranscriptVerdict,
	PendingQuestion,
} from "./question-store";
import {
	type HostBindingRow,
	type HostDbReader,
	type HostProjectRow,
	type HostTerminalRow,
	type HostWorkspaceRow,
	handleHeartbeat,
	handleTree,
	type ReadDeps,
} from "./read-api";
import {
	createSidebarCuration,
	MIRROR_MAX_AGE_MS,
	type SidebarMirrorSnapshot,
	type SidebarProjectMirrorRow,
	type SidebarWorkspaceMirrorRow,
} from "./sidebar-filter";
import type {
	QuestionId,
	QuestionItem,
	SealedRequestContext,
	TerminalId,
	TreeResponse,
	WorkspaceId,
} from "./types";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

// Real wall time: `handleTree`, `armPush` and the push probe all call
// `Date.now()` themselves, so a fixture clock in the far future would read as a
// mirror written after the fact. The pure `createSidebarCuration` cases pass
// `NOW` in explicitly and are unaffected either way.
const NOW = Date.now();
const ORG = "org-this-machine";
const OTHER_ORG = "org-somebody-else";
const LAUNCH = "launch-1";

function mirrorWorkspace(
	workspaceId: string,
	overrides: Partial<SidebarWorkspaceMirrorRow> = {},
): SidebarWorkspaceMirrorRow {
	return {
		workspaceId,
		projectId: "p-git",
		isHidden: false,
		archivedAt: null,
		snoozeUntil: null,
		snoozeLaunchId: null,
		completedAt: null,
		deletedAt: null,
		pinnedAt: null,
		tabOrder: 0,
		...overrides,
	};
}

function mirrorProject(
	projectId: string,
	overrides: Partial<SidebarProjectMirrorRow> = {},
): SidebarProjectMirrorRow {
	return {
		projectId,
		tabOrder: 0,
		isPinned: false,
		isCollapsed: false,
		...overrides,
	};
}

function snapshot(
	workspaces: SidebarWorkspaceMirrorRow[],
	projects: SidebarProjectMirrorRow[],
	metaOverrides: Partial<SidebarMirrorSnapshot["meta"] & object> = {},
): SidebarMirrorSnapshot {
	return {
		meta: {
			lastFullSyncAtMs: NOW - 1_000,
			appLaunchId: LAUNCH,
			organizationId: ORG,
			workspaceCount: workspaces.length,
			projectCount: projects.length,
			...metaOverrides,
		},
		workspaces,
		projects,
	};
}

const branchWorkspace = { id: "w-1", projectId: "p-git", type: "worktree" };

// ---------------------------------------------------------------------------
// (MIRROR-AGE-OUT) — item 2
// ---------------------------------------------------------------------------

describe("(MIRROR-AGE-OUT)", () => {
	it("stops curating once the mirror is older than the window — a quit desktop must not keep hiding threads with a frozen launch id", () => {
		const stale = createSidebarCuration(
			snapshot(
				[mirrorWorkspace("w-1", { snoozeLaunchId: LAUNCH })],
				[mirrorProject("p-git")],
				{ lastFullSyncAtMs: NOW - MIRROR_MAX_AGE_MS - 1 },
			),
			NOW,
			ORG,
		);
		expect(stale.enabled).toBe(false);
		// The very row that WOULD have been hidden by the launch snooze.
		expect(stale.workspaceVerdict(branchWorkspace)).toBe("show");
		expect(stale.projectVerdict("p-not-placed-at-all")).toBe("show");
	});

	it("still curates exactly ON the window — the boundary is `>`, so a mirror that has just reached it is not yet evidence of an absent renderer", () => {
		const edge = createSidebarCuration(
			snapshot(
				[mirrorWorkspace("w-1", { snoozeLaunchId: LAUNCH })],
				[mirrorProject("p-git")],
				{ lastFullSyncAtMs: NOW - MIRROR_MAX_AGE_MS },
			),
			NOW,
			ORG,
		);
		expect(edge.enabled).toBe(true);
		expect(edge.workspaceVerdict(branchWorkspace)).toBe("snoozed");
	});

	it("(CLOCK-STEP-FAILS-OPEN) ages out a FUTURE stamp instead of reading it as maximally fresh", () => {
		// This used to assert the opposite, on the reasoning that a backwards clock
		// step does not make the mirror's CONTENT wrong. True for a small step, and
		// beside the point for a large one: the window is the only thing standing
		// between the phone and a mirror left behind by a renderer that has since
		// quit, and a stamp `now` cannot have reached yet satisfies an upper bound
		// forever. A quit desktop then curates — hides — the phone's tree for as
		// long as the step lasts, which is the one direction this feature is not
		// allowed to fail in.
		const future = createSidebarCuration(
			snapshot(
				[mirrorWorkspace("w-1", { snoozeLaunchId: LAUNCH })],
				[mirrorProject("p-git")],
				{
					lastFullSyncAtMs: NOW + 60_000,
				},
			),
			NOW,
			ORG,
		);
		expect(future.enabled).toBe(false);
		// The row a still-in-force mirror would have hidden.
		expect(future.workspaceVerdict(branchWorkspace)).toBe("show");
		expect(future.lastSyncAgeMs).toBe(-60_000);
	});

	it("reports the mirror's age even when it refuses to use it", () => {
		const stale = createSidebarCuration(
			snapshot([], [], { lastFullSyncAtMs: NOW - MIRROR_MAX_AGE_MS - 5 }),
			NOW,
			ORG,
		);
		expect(stale.lastSyncAgeMs).toBe(MIRROR_MAX_AGE_MS + 5);
		const bootstrap = createSidebarCuration(
			{ meta: null, workspaces: [], projects: [] },
			NOW,
			ORG,
		);
		// null, NOT zero: "never synced" and "synced this instant" are opposite
		// facts and a diagnostic must be able to tell them apart.
		expect(bootstrap.lastSyncAgeMs).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// (MIRROR-ORG-GATE) — item 3
// ---------------------------------------------------------------------------

describe("(MIRROR-ORG-GATE)", () => {
	it("passes everything through when the mirror belongs to another org — ids never collide, so filtering on it would hide the WHOLE tree", () => {
		const foreign = createSidebarCuration(
			snapshot(
				[mirrorWorkspace("w-1", { deletedAt: NOW - 5 })],
				[mirrorProject("p-somebody-elses")],
				{ organizationId: OTHER_ORG },
			),
			NOW,
			ORG,
		);
		expect(foreign.enabled).toBe(false);
		// Both directions of the damage: the binned row is shown, and the project
		// the other org never placed is no longer "not in the sidebar".
		expect(foreign.workspaceVerdict(branchWorkspace)).toBe("show");
		expect(foreign.projectVerdict("p-git")).toBe("show");
		expect(foreign.effectiveProjectId(branchWorkspace)).toBe("p-git");
	});

	it("curates normally when the org matches", () => {
		const mine = createSidebarCuration(
			snapshot(
				[mirrorWorkspace("w-1", { deletedAt: NOW - 5 })],
				[mirrorProject("p-git")],
			),
			NOW,
			ORG,
		);
		expect(mine.enabled).toBe(true);
		expect(mine.workspaceVerdict(branchWorkspace)).toBe("deleted");
	});
});

describe("classifyWorkspace matches the renderer's bucket ORDER", () => {
	const mainWorkspace = { id: "w-1", projectId: "p-git", type: "main" };

	it("calls a snoozed hidden MAIN `snoozed`, the way getWorkspaceSidebarBucket does — it used to say `hidden`", () => {
		// The renderer asks archived, then snoozed, then hidden, and only a hidden
		// MAIN can reach that last test. Answering both hidden cases above snooze
		// mislabelled this one. Both verdicts are off the sidebar so the push
		// outcome is identical either way; the verdict is what the hold log names,
		// and "not now" is a different user act from "removed from the sidebar".
		const curation = createSidebarCuration(
			snapshot(
				[
					mirrorWorkspace("w-1", {
						isHidden: true,
						snoozeUntil: NOW + 3_600_000,
					}),
				],
				[mirrorProject("p-git")],
			),
			NOW,
			ORG,
		);
		expect(curation.workspaceVerdict(mainWorkspace)).toBe("snoozed");
	});

	it("still calls a hidden NON-main `archived`, above snooze, exactly as isWorkspaceArchived does", () => {
		const curation = createSidebarCuration(
			snapshot(
				[
					mirrorWorkspace("w-1", {
						isHidden: true,
						snoozeUntil: NOW + 3_600_000,
					}),
				],
				[mirrorProject("p-git")],
			),
			NOW,
			ORG,
		);
		expect(curation.workspaceVerdict(branchWorkspace)).toBe("archived");
	});

	it("still calls a hidden MAIN with no snooze `hidden`", () => {
		const curation = createSidebarCuration(
			snapshot(
				[mirrorWorkspace("w-1", { isHidden: true })],
				[mirrorProject("p-git")],
			),
			NOW,
			ORG,
		);
		expect(curation.workspaceVerdict(mainWorkspace)).toBe("hidden");
	});
});

// ---------------------------------------------------------------------------
// (EMIT-OPTIONAL-FIELDS) — item 8, the pinned half
// ---------------------------------------------------------------------------

describe("(EMIT-OPTIONAL-FIELDS) pinned accessors", () => {
	it("reads pinning off the mirror, and answers false for a row with no opinion", () => {
		const curation = createSidebarCuration(
			snapshot(
				[
					mirrorWorkspace("w-pinned", { pinnedAt: NOW - 10 }),
					mirrorWorkspace("w-plain"),
				],
				[mirrorProject("p-pinned", { isPinned: true }), mirrorProject("p-git")],
			),
			NOW,
			ORG,
		);
		expect(curation.workspacePinned("w-pinned")).toBe(true);
		expect(curation.workspacePinned("w-plain")).toBe(false);
		expect(curation.workspacePinned("w-not-mirrored")).toBe(false);
		expect(curation.projectPinned("p-pinned")).toBe(true);
		expect(curation.projectPinned("p-git")).toBe(false);
	});

	it("accepts SQLite's integer booleans, which is how these columns actually come back", () => {
		const curation = createSidebarCuration(
			snapshot([], [mirrorProject("p-git", { isPinned: 1 })]),
			NOW,
			ORG,
		);
		expect(curation.projectPinned("p-git")).toBe(true);
	});

	it("answers null — NO OPINION, which is not the same as not-pinned — when no curation is in force", () => {
		const off = createSidebarCuration(
			{ meta: null, workspaces: [], projects: [] },
			NOW,
			ORG,
		);
		expect(off.workspacePinned("w-1")).toBeNull();
		expect(off.projectPinned("p-git")).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// (PUSH-CURATION-GATE) — item 4
// ---------------------------------------------------------------------------

function pendingQuestionFixture(
	overrides: Partial<PendingQuestion> = {},
): PendingQuestion {
	return {
		questionId: "q-1" as QuestionId,
		fingerprint: "fp-1" as PendingQuestion["fingerprint"],
		state: "pending",
		askedAtMs: NOW - 1_000,
		resolvedAtMs: null,
		resolvedBy: null,
		toolUseId: "tu-1",
		sessionId: "s-1",
		terminalId: "t-wire" as TerminalId,
		agentType: null,
		questions: [questionItem()],
		origin: "unauthenticated_localhost_hook",
		hostTerminalId: "term-1",
		hostWorkspaceId: "w-1",
		transcriptPath: "",
		agentKind: "claude",
		agentId: null,
		...overrides,
	};
}

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

/**
 * ARM-TIME DEPS. There is no curation in here any more — `armPush` arms
 * unconditionally now — so this fixture only has to prove that.
 */
function armDeps(): {
	deps: NotifyingSinkDeps;
	scheduled: QuestionId[];
	errors: string[];
} {
	const scheduled: QuestionId[] = [];
	const errors: string[] = [];
	const deps = {
		inner: { capture: () => {}, resolve: () => {} },
		questions: {} as NotifyingSinkDeps["questions"],
		push: {
			schedule: (input: { questionId: QuestionId }) => {
				scheduled.push(input.questionId);
			},
		} as unknown as NotifyingSinkDeps["push"],
		events: {} as NotifyingSinkDeps["events"],
		logger: {
			info: () => {},
			warn: () => {},
			error: (message: string) => {
				errors.push(message);
			},
		},
	} satisfies NotifyingSinkDeps;
	return { deps, scheduled, errors };
}

const hostWorkspace: HostWorkspaceRow = {
	id: "w-1",
	projectId: "p-git",
	name: "feature",
	branch: "feature",
	worktreePath: "C:/wt/feature",
	type: "worktree",
	createdAt: NOW - 100_000,
};

/** The fire-time probe over a fake mirror, with an injectable clock for the cache. */
function curationProbe(options: {
	mirror: SidebarMirrorSnapshot | (() => SidebarMirrorSnapshot);
	workspace?: HostWorkspaceRow | null;
	question?: PendingQuestion | null;
	now?: () => number;
}): {
	ask: (questionId?: QuestionId) => boolean;
	holds: string[];
	errors: string[];
} {
	const holds: string[] = [];
	const errors: string[] = [];
	const question =
		options.question === undefined
			? pendingQuestionFixture()
			: options.question;
	const probe = createIsCuratedOffProbe({
		questions: { get: () => question },
		db: {
			readSidebarMirror: () =>
				typeof options.mirror === "function"
					? options.mirror()
					: options.mirror,
			findWorkspace: () => options.workspace ?? null,
		} as unknown as HostDbReader,
		organizationId: ORG,
		logger: {
			info: (message: string) => {
				holds.push(message);
			},
			warn: () => {},
			error: (message: string) => {
				errors.push(message);
			},
		},
		now: options.now,
	});
	return {
		ask: (questionId: QuestionId = "q-1" as QuestionId) => probe(questionId),
		holds,
		errors,
	};
}

describe("(PUSH-CURATION-GATE) armPush", () => {
	it("ARMS a question whose thread is off the sidebar — the fence row is what lets a lapsed snooze buzz later", () => {
		const { deps, scheduled } = armDeps();
		armPush(deps, pendingQuestionFixture());
		expect(scheduled).toEqual(["q-1" as QuestionId]);
	});
});

describe("(PUSH-CURATION-GATE) createIsCuratedOffProbe", () => {
	it("holds a push for a binned thread — the notification would open a tree that does not contain it", () => {
		const probe = curationProbe({
			mirror: snapshot(
				[mirrorWorkspace("w-1", { deletedAt: NOW - 50 })],
				[mirrorProject("p-git")],
			),
			workspace: hostWorkspace,
		});
		expect(probe.ask()).toBe(true);
		expect(probe.holds).toHaveLength(1);
	});

	it.each([
		["snoozed until next launch", { snoozeLaunchId: LAUNCH }],
		["snoozed on a timer", { snoozeUntil: NOW + 60_000 }],
		["archived", { archivedAt: NOW - 50 }],
		["completed", { completedAt: NOW - 50 }],
	])("holds a push for a %s thread", (_label, overrides) => {
		const probe = curationProbe({
			mirror: snapshot(
				[mirrorWorkspace("w-1", overrides)],
				[mirrorProject("p-git")],
			),
			workspace: hostWorkspace,
		});
		expect(probe.ask()).toBe(true);
	});

	it("FIRES when host.db has no workspace row — absence is no opinion recorded, everywhere in this feature", () => {
		const probe = curationProbe({
			mirror: snapshot(
				[mirrorWorkspace("w-1", { deletedAt: NOW - 50 })],
				[mirrorProject("p-git")],
			),
			workspace: null,
		});
		expect(probe.ask()).toBe(false);
	});

	it("FIRES when no curation is in force", () => {
		const probe = curationProbe({
			mirror: { meta: null, workspaces: [], projects: [] },
			workspace: hostWorkspace,
		});
		expect(probe.ask()).toBe(false);
	});

	it("FIRES when the mirror aged out, or belongs to another org", () => {
		for (const mirror of [
			snapshot([mirrorWorkspace("w-1", { deletedAt: NOW - 50 })], [], {
				lastFullSyncAtMs: NOW - MIRROR_MAX_AGE_MS - 1,
			}),
			snapshot([mirrorWorkspace("w-1", { deletedAt: NOW - 50 })], [], {
				organizationId: OTHER_ORG,
			}),
		]) {
			expect(curationProbe({ mirror, workspace: hostWorkspace }).ask()).toBe(
				false,
			);
		}
	});

	it("FIRES, loudly, when reading curation throws — a missed buzz for a blocked agent is the worse failure", () => {
		const probe = curationProbe({
			mirror: () => {
				throw new Error("host.db is locked");
			},
			workspace: hostWorkspace,
		});
		expect(probe.ask()).toBe(false);
		expect(probe.errors).toHaveLength(1);
	});

	it("FIRES for a thread that is on the sidebar", () => {
		const probe = curationProbe({
			mirror: snapshot([mirrorWorkspace("w-1")], [mirrorProject("p-git")]),
			workspace: hostWorkspace,
		});
		expect(probe.ask()).toBe(false);
		expect(probe.holds).toEqual([]);
	});

	it("FIRES for a question the store has never seen — that is the RESTART case, and createFireVerdictProbe owns it", () => {
		const probe = curationProbe({
			mirror: snapshot(
				[mirrorWorkspace("w-1", { deletedAt: NOW - 50 })],
				[mirrorProject("p-git")],
			),
			workspace: hostWorkspace,
			question: null,
		});
		expect(probe.ask()).toBe(false);
		expect(probe.holds).toEqual([]);
	});

	it("re-reads the mirror only every CURATION_RECHECK_MS — the sweep asks every 2s for up to 6h", () => {
		let hidden = true;
		let clock = NOW;
		let reads = 0;
		const probe = curationProbe({
			mirror: () => {
				reads++;
				return snapshot(
					[
						mirrorWorkspace(
							"w-1",
							hidden ? { snoozeUntil: NOW + 3_600_000 } : {},
						),
					],
					[mirrorProject("p-git")],
				);
			},
			workspace: hostWorkspace,
			now: () => clock,
		});

		expect(probe.ask()).toBe(true);
		hidden = false;
		// Still inside the window: the cached hold stands, and nothing is re-read.
		clock = NOW + CURATION_RECHECK_MS - 1;
		expect(probe.ask()).toBe(true);
		expect(reads).toBe(1);
		// Past it: the lapsed snooze is seen and the push is released.
		clock = NOW + CURATION_RECHECK_MS;
		expect(probe.ask()).toBe(false);
		expect(reads).toBe(2);
	});

	it("(CLOCK-STEP-FAILS-OPEN) treats a cached row stamped in the future as a MISS — a backwards clock step must not latch a hold", () => {
		let hidden = true;
		let clock = NOW;
		let reads = 0;
		const probe = curationProbe({
			mirror: () => {
				reads++;
				return snapshot(
					[
						mirrorWorkspace(
							"w-1",
							hidden ? { snoozeUntil: NOW + 3_600_000 } : {},
						),
					],
					[mirrorProject("p-git")],
				);
			},
			workspace: hostWorkspace,
			now: () => clock,
		});

		expect(probe.ask()).toBe(true);
		expect(reads).toBe(1);
		hidden = false;
		// NTP corrects an hour of drift out from under the cached row. With only
		// the upper bound checked, the negative age satisfied the window and the
		// hold stood for the whole hour — silencing a question whose snooze had
		// already lapsed. The only thing worth caching here is a hold, so that is
		// the only thing a backwards step could latch.
		clock = NOW - 3_600_000;
		expect(probe.ask()).toBe(false);
		expect(reads).toBe(2);
	});

	it("logs a hold once per EPISODE, not once per sweep — 2s sweeps would otherwise bury the fault lines beside it", () => {
		let hidden = true;
		let clock = NOW;
		const probe = curationProbe({
			mirror: () =>
				snapshot(
					[
						mirrorWorkspace(
							"w-1",
							hidden ? { snoozeUntil: NOW + 3_600_000 } : {},
						),
					],
					[mirrorProject("p-git")],
				),
			workspace: hostWorkspace,
			now: () => clock,
		});

		expect(probe.ask()).toBe(true);
		clock = NOW + CURATION_RECHECK_MS;
		expect(probe.ask()).toBe(true);
		clock = NOW + CURATION_RECHECK_MS * 2;
		expect(probe.ask()).toBe(true);
		expect(probe.holds).toHaveLength(1);

		// The snooze lapses, the push fires, and the thread is snoozed again. A new
		// episode says so.
		hidden = false;
		clock = NOW + CURATION_RECHECK_MS * 3;
		expect(probe.ask()).toBe(false);
		hidden = true;
		clock = NOW + CURATION_RECHECK_MS * 4;
		expect(probe.ask()).toBe(true);
		expect(probe.holds).toHaveLength(2);
	});

	it("prunes cached holds for questions that ended WHILE held — nothing asks about them again", () => {
		let clock = NOW;
		const probe = curationProbe({
			mirror: () =>
				snapshot(
					[mirrorWorkspace("w-1", { snoozeUntil: NOW + 86_400_000 })],
					[mirrorProject("p-git")],
				),
			workspace: hostWorkspace,
			now: () => clock,
		});
		// Past the soft cap, all held, all logged once.
		for (let i = 0; i < 70; i++) {
			expect(probe.ask(`q-${i}` as QuestionId)).toBe(true);
		}
		expect(probe.holds).toHaveLength(70);

		// Long enough that none of those rows can belong to a still-armed question.
		clock = NOW + PUSH_QUESTION_EXPIRY_MS + 1;
		expect(probe.ask("q-fresh" as QuestionId)).toBe(true);

		// `q-0`'s row is gone, so asking again opens a NEW episode and logs (70 + the
		// fresh one + this). Without the prune it would still be cached as held and
		// stay quiet at 71.
		expect(probe.ask("q-0" as QuestionId)).toBe(true);
		expect(probe.holds).toHaveLength(72);
	});
});

// ---------------------------------------------------------------------------
// (PUSH-CURATION-GATE) the hold on the fire path itself
// ---------------------------------------------------------------------------

function presenceStub(present: () => boolean): PresenceStore {
	return {
		record: () => {},
		present: () => ({
			present: present(),
			reason: present() ? "keystroke" : "no-signal",
			humanInputAgeMs: null,
			beaconAgeMs: null,
			idleSeconds: null,
			locked: null,
		}),
		snapshot: () => ({ beacon: null, lastResumeAtMs: null, beaconCount: 0 }),
	};
}

function fakeFence(initial: PushFenceRecord[] = []): {
	fence: PushFence;
	cleared: QuestionId[];
	marked: QuestionId[];
} {
	const rows = new Map<QuestionId, PushFenceRecord>(
		initial.map((record) => [record.questionId, record]),
	);
	const cleared: QuestionId[] = [];
	const marked: QuestionId[] = [];
	return {
		fence: {
			load: () => [...rows.values()],
			arm: (record) => {
				if (rows.has(record.questionId)) return;
				rows.set(record.questionId, {
					...record,
					state: "armed",
					sentAtMs: null,
				});
			},
			markSent: (questionId, sentAtMs) => {
				marked.push(questionId);
				const row = rows.get(questionId);
				if (row !== undefined) {
					rows.set(questionId, { ...row, state: "sent", sentAtMs });
				}
			},
			clear: (questionId) => {
				cleared.push(questionId);
				rows.delete(questionId);
			},
		},
		cleared,
		marked,
	};
}

const HELD_QUESTION = "q-held" as QuestionId;
const HELD_WORKSPACE = "w-handle" as WorkspaceId;

function heldFenceRecord(): PushFenceRecord {
	return {
		questionId: HELD_QUESTION,
		workspaceId: HELD_WORKSPACE,
		questionCount: 1,
		expiresAtMs: Date.now() + PUSH_QUESTION_EXPIRY_MS,
		armedAtMs: Date.now() - 1_000,
		state: "armed",
		sentAtMs: null,
		hostTerminalId: "term-held",
		hostWorkspaceId: "w-1",
		// (PUSH-ARMED-ORPHAN) No transcript pair: "cannot check", which is the
		// production shape whenever host.db could not derive a path, and the one
		// that must still fire.
		transcriptPath: null,
		toolUseId: null,
	};
}

/**
 * A real `createPushSender` driven by a real `createIsCuratedOffProbe` over a
 * mutable mirror, so these exercise the composition rather than a stubbed
 * boolean. No device is ever registered, so nothing reaches FCM: `broadcast`
 * returns at its empty-targets branch, and `inspect().sent` is the record of
 * what fired.
 */
function pushHarness(options: {
	hidden?: boolean;
	present?: boolean;
	fenceRecords?: PushFenceRecord[];
	fireVerdict?: () => PushFireVerdict;
	/** Injected wall clock, so a corroboration window can be crossed without waiting it out. */
	now?: () => number;
	verifyOrphanResolved?: (input: {
		questionId: QuestionId;
		transcriptPath: string;
		toolUseId: string;
	}) => Promise<OrphanTranscriptVerdict>;
}) {
	const state = {
		hidden: options.hidden ?? true,
		present: options.present ?? false,
		/** Bumped past the probe's cache whenever curation is changed. */
		skewMs: 0,
	};
	const fence = fakeFence(options.fenceRecords);
	const isCuratedOff = createIsCuratedOffProbe({
		questions: { get: () => pendingQuestionFixture() },
		db: {
			readSidebarMirror: () =>
				state.hidden
					? snapshot(
							[mirrorWorkspace("w-1", { snoozeUntil: Date.now() + 3_600_000 })],
							[mirrorProject("p-git")],
						)
					: snapshot([mirrorWorkspace("w-1")], [mirrorProject("p-git")]),
			findWorkspace: () => hostWorkspace,
		} as unknown as HostDbReader,
		organizationId: ORG,
		logger: { info: () => {}, warn: () => {}, error: () => {} },
		now: () => Date.now() + state.skewMs,
	});
	const push = createPushSender({
		serviceAccountPath: "C:/nonexistent/fcm-service-account.json",
		devices: {
			list: async () => [],
			setFcmToken: async () => {},
		} as unknown as DeviceStore,
		presence: presenceStub(() => state.present),
		fence: fence.fence,
		fireVerdict: options.fireVerdict ?? (() => "fire"),
		isCuratedOff,
		verifyOrphanResolved: options.verifyOrphanResolved ?? null,
		now: options.now,
		onFault: () => {},
	});
	const clock = options.now ?? (() => Date.now());
	return {
		push,
		fence,
		/** Change curation AND move past the probe's recheck window in one act. */
		setHidden(hidden: boolean) {
			state.hidden = hidden;
			state.skewMs += CURATION_RECHECK_MS * 2;
		},
		setPresent(present: boolean) {
			state.present = present;
		},
		arm() {
			push.schedule({
				questionId: HELD_QUESTION,
				workspaceId: HELD_WORKSPACE,
				questionCount: 1,
				expiresAtMs: clock() + PUSH_QUESTION_EXPIRY_MS,
				hostTerminalId: "term-held",
				hostWorkspaceId: "w-1",
				transcriptPath: null,
				toolUseId: null,
			});
		},
	};
}

/** One real sweep of the sender's own interval. */
async function nextSweep(): Promise<void> {
	await Bun.sleep(PUSH_SWEEP_INTERVAL_MS + 600);
}

/**
 * These wait out REAL sweeps — the point is that the scheduler's own timer
 * releases the hold — so they need more than bun's 5s default.
 */
const SWEEP_TEST_TIMEOUT_MS = 30_000;

describe("(PUSH-CURATION-GATE) the fire-time hold", () => {
	it(
		"HOLDS instead of firing while the thread is off the sidebar, and keeps the entry armed",
		async () => {
			const harness = pushHarness({ hidden: true, present: false });
			harness.arm();
			// The user is away, so presence alone would have fired it on this call.
			expect(harness.push.inspect()).toMatchObject({
				armed: [HELD_QUESTION],
				sent: [],
			});
			await nextSweep();
			expect(harness.push.inspect()).toMatchObject({
				armed: [HELD_QUESTION],
				sent: [],
			});
			expect(harness.fence.cleared).toEqual([]);
			harness.push.stop();
		},
		SWEEP_TEST_TIMEOUT_MS,
	);

	it(
		"fires on the next sweep once the SNOOZE EXPIRES — the whole reason the gate moved off the arm path",
		async () => {
			const harness = pushHarness({ hidden: true, present: false });
			harness.arm();
			expect(harness.push.inspect().sent).toEqual([]);

			harness.setHidden(false);
			await nextSweep();

			expect(harness.push.inspect()).toMatchObject({
				armed: [],
				sent: [HELD_QUESTION],
			});
			expect(harness.fence.marked).toEqual([HELD_QUESTION]);
			harness.push.stop();
		},
		SWEEP_TEST_TIMEOUT_MS,
	);

	it(
		"fires when curation stops being in force mid-hold",
		async () => {
			const state = { enabled: false };
			const push = createPushSender({
				serviceAccountPath: "C:/nonexistent/fcm-service-account.json",
				devices: {
					list: async () => [],
					setFcmToken: async () => {},
				} as unknown as DeviceStore,
				presence: presenceStub(() => false),
				fence: fakeFence().fence,
				fireVerdict: () => "fire",
				// Exactly what the probe answers when the mirror ages out or belongs to
				// another org: curation is not in force, so nothing is held.
				isCuratedOff: () => state.enabled,
				verifyOrphanResolved: null,
				onFault: () => {},
			});
			state.enabled = true;
			push.schedule({
				questionId: HELD_QUESTION,
				workspaceId: HELD_WORKSPACE,
				questionCount: 1,
				expiresAtMs: Date.now() + PUSH_QUESTION_EXPIRY_MS,
				hostTerminalId: "term-held",
				hostWorkspaceId: "w-1",
				transcriptPath: null,
				toolUseId: null,
			});
			expect(push.inspect().sent).toEqual([]);

			state.enabled = false;
			await nextSweep();

			expect(push.inspect().sent).toEqual([HELD_QUESTION]);
			push.stop();
		},
		SWEEP_TEST_TIMEOUT_MS,
	);

	it(
		"HOLDS on presence even when curation releases — the two holds are independent and whichever holds, holds",
		async () => {
			const harness = pushHarness({ hidden: true, present: true });
			harness.arm();
			harness.setHidden(false);
			await nextSweep();
			expect(harness.push.inspect()).toMatchObject({
				armed: [HELD_QUESTION],
				sent: [],
			});
			harness.push.stop();
		},
		SWEEP_TEST_TIMEOUT_MS,
	);

	it(
		"is CANCELLED, never fired, when the question is answered at the desk while held",
		async () => {
			const harness = pushHarness({ hidden: true, present: false });
			harness.arm();
			expect(harness.push.inspect().armed).toEqual([HELD_QUESTION]);

			harness.push.cancelPending(HELD_QUESTION);
			expect(harness.fence.cleared).toEqual([HELD_QUESTION]);

			// Curation lapses afterwards: there is nothing left to release.
			harness.setHidden(false);
			await nextSweep();
			expect(harness.push.inspect()).toMatchObject({ armed: [], sent: [] });
			harness.push.stop();
		},
		SWEEP_TEST_TIMEOUT_MS,
	);

	it(
		"reconstructs a held curated-off row after a restart and goes on holding it",
		async () => {
			const harness = pushHarness({
				hidden: true,
				present: false,
				fenceRecords: [heldFenceRecord()],
			});
			// Reconstructed at construction, before anything was scheduled.
			expect(harness.push.inspect().armed).toEqual([HELD_QUESTION]);
			await nextSweep();
			expect(harness.push.inspect()).toMatchObject({
				armed: [HELD_QUESTION],
				sent: [],
			});

			harness.setHidden(false);
			await nextSweep();
			expect(harness.push.inspect().sent).toEqual([HELD_QUESTION]);
			harness.push.stop();
		},
		SWEEP_TEST_TIMEOUT_MS,
	);
	it(
		"still drops a held entry the store reports as SETTLED — curation holds, it does not resurrect",
		async () => {
			const harness = pushHarness({
				hidden: true,
				present: false,
				fireVerdict: () => "settled",
			});
			harness.arm();
			expect(harness.push.inspect().armed).toEqual([HELD_QUESTION]);
			harness.setHidden(false);
			await nextSweep();
			expect(harness.push.inspect()).toMatchObject({ armed: [], sent: [] });
			expect(harness.fence.cleared).toEqual([HELD_QUESTION]);
			harness.push.stop();
		},
		SWEEP_TEST_TIMEOUT_MS,
	);
});

// ---------------------------------------------------------------------------
// createFireVerdictProbe — item 7
// ---------------------------------------------------------------------------

describe("(QUESTION-EXPIRY) createFireVerdictProbe", () => {
	function probe(options: {
		question: PendingQuestion | null;
		gone?: boolean;
	}) {
		const errors: string[] = [];
		const fn = createFireVerdictProbe({
			questions: { get: () => options.question },
			liveness: { isProvablyGone: () => options.gone ?? false },
			resolveTerminalActivityMs: () => NOW - 1_000,
			logger: {
				error: (message: string) => {
					errors.push(message);
				},
			},
		});
		return { answer: fn("q-1" as QuestionId), errors };
	}

	it("keeps the buzz for a pending question on a terminal that is not provably gone", () => {
		expect(probe({ question: pendingQuestionFixture() }).answer).toBe("fire");
	});

	it("reports a SETTLED question silently — that is the ordinary path and it needs no log line", () => {
		const settled = probe({
			question: pendingQuestionFixture({ state: "resolved" }),
		});
		expect(settled.answer).toBe("settled");
		expect(settled.errors).toEqual([]);
	});

	it("reports `gone` — NOT `settled` — for a provably absent terminal, because the caller has to corroborate one of those and not the other", () => {
		expect(
			probe({ question: pendingQuestionFixture(), gone: true }).answer,
		).toBe("gone");
	});

	it("reports an ABSENT question as `settled` and NAMES the restart — the fence is durable, the store is memory-only, and the lost buzz is otherwise invisible", () => {
		const absent = probe({ question: null });
		expect(absent.answer).toBe("settled");
		expect(absent.errors).toHaveLength(1);
		expect(absent.errors[0]).toContain("restarted");
	});
});

describe("(PUSH-GONE-CORROBORATION) a gone verdict is a hold, not a drop", () => {
	it(
		"HOLDS the entry on the first gone verdict instead of forgetting it — one daemon listing is one fallible observation and `forget()` cannot be undone",
		async () => {
			const harness = pushHarness({
				hidden: false,
				present: false,
				fireVerdict: () => "gone",
			});
			harness.arm();
			// Two real sweeps, well inside the corroboration window. Before this, the
			// first sweep dropped the fence row and the buzz was gone forever.
			await nextSweep();
			await nextSweep();
			expect(harness.push.inspect()).toMatchObject({
				armed: [HELD_QUESTION],
				sent: [],
			});
			expect(harness.fence.cleared).toEqual([]);
			harness.push.stop();
		},
		SWEEP_TEST_TIMEOUT_MS,
	);

	it(
		"FIRES if the terminal reads live again — a flap or a mid-restart daemon resets the clock rather than condemning the question",
		async () => {
			let verdict: PushFireVerdict = "gone";
			const harness = pushHarness({
				hidden: false,
				present: false,
				fireVerdict: () => verdict,
			});
			harness.arm();
			await nextSweep();
			expect(harness.push.inspect().sent).toEqual([]);

			verdict = "fire";
			await nextSweep();
			expect(harness.push.inspect()).toMatchObject({
				armed: [],
				sent: [HELD_QUESTION],
			});
			harness.push.stop();
		},
		SWEEP_TEST_TIMEOUT_MS,
	);

	it(
		"forgets only once the same verdict has stood for the whole window",
		async () => {
			let clock = NOW;
			const harness = pushHarness({
				hidden: false,
				present: false,
				fireVerdict: () => "gone",
				now: () => clock,
			});
			harness.arm();
			expect(harness.push.inspect().armed).toEqual([HELD_QUESTION]);

			// One millisecond short of the window: still a hold, still armed, nothing
			// cleared. Real sweeps, reading the injected clock.
			clock = NOW + PUSH_GONE_CORROBORATION_MS - 1;
			await nextSweep();
			expect(harness.push.inspect().armed).toEqual([HELD_QUESTION]);
			expect(harness.fence.cleared).toEqual([]);

			// Corroborated. The drop is held to the same standard `(QUESTION-EXPIRY)`
			// settles a question stale on: the same verdict, twice, a window apart.
			clock = NOW + PUSH_GONE_CORROBORATION_MS;
			await nextSweep();
			expect(harness.push.inspect()).toMatchObject({ armed: [], sent: [] });
			expect(harness.fence.cleared).toEqual([HELD_QUESTION]);
			harness.push.stop();
		},
		SWEEP_TEST_TIMEOUT_MS,
	);
});

// ---------------------------------------------------------------------------
// (PUSH-ARMED-ORPHAN) reconstruction, against PRODUCTION-SHAPED emptiness
// ---------------------------------------------------------------------------

/**
 * A sender built the way the bridge builds one AFTER A RESTART, which is the
 * only state reconstruction ever runs in: the fence has rows and
 * `QuestionStore` is EMPTY, because it lives in memory and did not survive.
 *
 * The harness above cannot show this. Its probes are handed
 * `questions: { get: () => pendingQuestionFixture() }` and a stubbed
 * `fireVerdict`, so every reconstructed row is judged against a question the
 * production store would not have — and the reconstruction case passed while
 * production discarded every held push on its first away sweep.
 *
 * So both probes here are the REAL ones over `get: () => null`.
 */
function restartedSender(options: {
	fenceRecords: PushFenceRecord[];
	verifyOrphanResolved?: (input: {
		questionId: QuestionId;
		transcriptPath: string;
		toolUseId: string;
	}) => Promise<OrphanTranscriptVerdict>;
}) {
	const fence = fakeFence(options.fenceRecords);
	const emptyStore = { get: () => null };
	const push = createPushSender({
		serviceAccountPath: "C:/nonexistent/fcm-service-account.json",
		devices: {
			list: async () => [],
			setFcmToken: async () => {},
		} as unknown as DeviceStore,
		presence: presenceStub(() => false),
		fence: fence.fence,
		fireVerdict: createFireVerdictProbe({
			questions: emptyStore,
			liveness: { isProvablyGone: () => false },
			resolveTerminalActivityMs: () => NOW - 1_000,
			logger: { error: () => {} },
		}),
		isCuratedOff: createIsCuratedOffProbe({
			questions: emptyStore,
			db: {
				readSidebarMirror: () =>
					snapshot([mirrorWorkspace("w-1")], [mirrorProject("p-git")]),
				findWorkspace: () => hostWorkspace,
			} as unknown as HostDbReader,
			organizationId: ORG,
			logger: { info: () => {}, warn: () => {}, error: () => {} },
		}),
		verifyOrphanResolved: options.verifyOrphanResolved ?? null,
		onFault: () => {},
	});
	return { push, fence };
}

/** A fence row carrying the transcript pair, so the check can actually run. */
function heldFenceRecordWithTranscript(): PushFenceRecord {
	return {
		...heldFenceRecord(),
		transcriptPath: "C:/transcripts/s-1.jsonl",
		toolUseId: "tu-1",
	};
}

describe("(PUSH-ARMED-ORPHAN) a push held across a restart", () => {
	it(
		"FIRES, instead of being discarded because the memory-only store has never heard of it",
		async () => {
			const restarted = restartedSender({
				fenceRecords: [heldFenceRecord()],
			});
			expect(restarted.push.inspect().armed).toEqual([HELD_QUESTION]);

			// The first away sweep. This is exactly where every held push used to be
			// lost: the real probe answers `settled` for a question the empty store
			// cannot produce, and the entry went straight to `forget()`.
			await nextSweep();
			expect(restarted.push.inspect()).toMatchObject({
				armed: [],
				sent: [HELD_QUESTION],
			});
			restarted.push.stop();
		},
		SWEEP_TEST_TIMEOUT_MS,
	);

	it(
		"is CANCELLED when its own transcript proves it was answered while the host-service was down",
		async () => {
			const asked: string[] = [];
			const restarted = restartedSender({
				fenceRecords: [heldFenceRecordWithTranscript()],
				verifyOrphanResolved: async ({ transcriptPath, toolUseId }) => {
					asked.push(`${transcriptPath}|${toolUseId}`);
					return "resolved";
				},
			});
			await nextSweep();
			expect(asked).toEqual(["C:/transcripts/s-1.jsonl|tu-1"]);
			expect(restarted.push.inspect()).toMatchObject({ armed: [], sent: [] });
			expect(restarted.fence.cleared).toEqual([HELD_QUESTION]);
			restarted.push.stop();
		},
		SWEEP_TEST_TIMEOUT_MS,
	);

	it(
		"is RETIRED when its transcript file is gone — the buzz could not be opened or answered",
		async () => {
			// The stale-armed-fence class: a fence row survives, but the transcript
			// its path names does not (a deleted worktree, a cleaned project dir).
			// Nothing can ever corroborate it — the phone's question view reads that
			// same file and would render nothing, and guard 1 reads that same derived
			// path and refuses every answer attempt against it. Left armed, the row is
			// rebuilt and re-held on every restart until its 6-hour expiry.
			const restarted = restartedSender({
				fenceRecords: [heldFenceRecordWithTranscript()],
				verifyOrphanResolved: async () => "gone",
			});
			await nextSweep();
			expect(restarted.push.inspect()).toMatchObject({ armed: [], sent: [] });
			expect(restarted.fence.cleared).toEqual([HELD_QUESTION]);
			restarted.push.stop();
		},
		SWEEP_TEST_TIMEOUT_MS,
	);

	it(
		"FIRES when the transcript check cannot prove anything — unreadable is not resolved",
		async () => {
			const restarted = restartedSender({
				fenceRecords: [heldFenceRecordWithTranscript()],
				verifyOrphanResolved: async () => "unresolved",
			});
			await nextSweep();
			expect(restarted.push.inspect().sent).toEqual([HELD_QUESTION]);
			restarted.push.stop();
		},
		SWEEP_TEST_TIMEOUT_MS,
	);

	it(
		"FIRES when the transcript check THROWS — could-not-check is the same answer as no-proof",
		async () => {
			const restarted = restartedSender({
				fenceRecords: [heldFenceRecordWithTranscript()],
				verifyOrphanResolved: async () => {
					throw new Error("EBUSY");
				},
			});
			await nextSweep();
			expect(restarted.push.inspect().sent).toEqual([HELD_QUESTION]);
			restarted.push.stop();
		},
		SWEEP_TEST_TIMEOUT_MS,
	);

	it(
		"HOLDS while the check is still in flight, so a question about to be proved resolved does not buzz first",
		async () => {
			let settle: ((verdict: OrphanTranscriptVerdict) => void) | null = null;
			const restarted = restartedSender({
				fenceRecords: [heldFenceRecordWithTranscript()],
				verifyOrphanResolved: () =>
					new Promise<OrphanTranscriptVerdict>((resolve) => {
						settle = resolve;
					}),
			});
			await nextSweep();
			expect(restarted.push.inspect()).toMatchObject({
				armed: [HELD_QUESTION],
				sent: [],
			});

			(settle as unknown as (verdict: OrphanTranscriptVerdict) => void)(
				"resolved",
			);
			await nextSweep();
			expect(restarted.push.inspect()).toMatchObject({ armed: [], sent: [] });
			expect(restarted.fence.cleared).toEqual([HELD_QUESTION]);
			restarted.push.stop();
		},
		SWEEP_TEST_TIMEOUT_MS,
	);

	it(
		"ADOPTS a reconstructed entry the hook re-captures, so the ordinary re-check governs it again",
		async () => {
			const restarted = restartedSender({
				fenceRecords: [heldFenceRecordWithTranscript()],
				// Never settles: without adoption the entry would stay held, judged by
				// a check it no longer needs, until the deadline.
				verifyOrphanResolved: () =>
					new Promise<OrphanTranscriptVerdict>(() => {}),
			});
			await nextSweep();
			expect(restarted.push.inspect().armed).toEqual([HELD_QUESTION]);

			restarted.push.schedule({
				questionId: HELD_QUESTION,
				workspaceId: HELD_WORKSPACE,
				questionCount: 1,
				expiresAtMs: Date.now() + PUSH_QUESTION_EXPIRY_MS,
				hostTerminalId: "term-held",
				hostWorkspaceId: "w-1",
				transcriptPath: "C:/transcripts/s-1.jsonl",
				toolUseId: "tu-1",
			});
			await nextSweep();
			// The empty store answers `settled` for it — which is now the governing
			// verdict, so it is dropped rather than held or fired.
			expect(restarted.push.inspect()).toMatchObject({ armed: [], sent: [] });
			expect(restarted.fence.cleared).toEqual([HELD_QUESTION]);
			restarted.push.stop();
		},
		SWEEP_TEST_TIMEOUT_MS,
	);
});

// ---------------------------------------------------------------------------
// handleTree integration over a curated fixture — items 4/8/10/11
// ---------------------------------------------------------------------------

interface TreeFixture {
	projects: HostProjectRow[];
	workspaces: HostWorkspaceRow[];
	terminals: HostTerminalRow[];
	bindings: HostBindingRow[];
	mirror: SidebarMirrorSnapshot;
	pendingByHostTerminal?: Record<string, PendingQuestion>;
}

function treeDeps(fixture: TreeFixture): ReadDeps {
	const db: HostDbReader = {
		listProjects: () => fixture.projects,
		listWorkspaces: () => fixture.workspaces,
		listActiveTerminals: () => fixture.terminals,
		listBindings: () => fixture.bindings,
		findWorkspace: (id) => fixture.workspaces.find((w) => w.id === id) ?? null,
		findBinding: (id) =>
			fixture.bindings.find((b) => b.terminalId === id) ?? null,
		findTerminal: (id) => fixture.terminals.find((t) => t.id === id) ?? null,
		readSidebarMirror: () => fixture.mirror,
		resolveTerminal: () => null,
		resolveActiveTerminal: () => null,
		resolveTranscriptPath: () => null,
		resolveTerminalActivityMs: () => NOW,
		close: () => {},
	};
	const pending = fixture.pendingByHostTerminal ?? {};
	return {
		db,
		questions: {
			byHostTerminal: (hostTerminalId: string) =>
				pending[hostTerminalId] ?? null,
			unanswerableReason: () => null,
			headline: (question: PendingQuestion) =>
				question.questions[0]?.header ?? "",
			reconcile: async () => [],
			oldestPendingAgeMs: () => null,
		} as unknown as ReadDeps["questions"],
		liveness: {
			refresh: async () => {},
			isLive: () => true,
			isProvablyGone: () => false,
			describe: () => ({
				hasSnapshot: true,
				aliveCount: fixture.terminals.length,
				takenAtMs: NOW,
			}),
		},
		organizationId: ORG,
		versions: { appVersion: "0", hostServiceVersion: "0", forkTag: "0" },
		bridgeStartedMs: NOW,
		ledger: { currentEpoch: () => "epoch" } as unknown as ReadDeps["ledger"],
		currentGseq: () => 7,
		onQuestionsSettled: () => {},
	};
}

function terminal(
	id: string,
	originWorkspaceId: string,
	overrides: Partial<HostTerminalRow> = {},
): HostTerminalRow {
	return {
		id,
		originWorkspaceId,
		status: "active",
		createdAt: NOW - 100_000,
		lastAttachedAt: NOW - 1_000,
		endedAt: null,
		...overrides,
	};
}

function workspaceRow(
	id: string,
	projectId: string,
	overrides: Partial<HostWorkspaceRow> = {},
): HostWorkspaceRow {
	return {
		id,
		projectId,
		name: id,
		branch: id,
		worktreePath: `C:/wt/${id}`,
		type: "worktree",
		createdAt: NOW - 200_000,
		...overrides,
	};
}

const FULL_CTX = {
	granted: ["tree.read"],
	device: { revokedAtMs: null, writesDisabledAtMs: null },
} as unknown as SealedRequestContext;

async function tree(fixture: TreeFixture): Promise<TreeResponse> {
	return handleTree(treeDeps(fixture), FULL_CTX, { includeIdle: true });
}

describe("(BRIDGE-SIDEBAR-FILTER) handleTree over a curated fixture", () => {
	const baseProjects: HostProjectRow[] = [
		{ id: "p-git", name: "repo", repoPath: "C:/repo", worktreeBaseDir: null },
	];

	it("drops a binned thread and reports it in the curation provenance", async () => {
		const response = await tree({
			projects: baseProjects,
			workspaces: [
				workspaceRow("w-live", "p-git"),
				workspaceRow("w-binned", "p-git"),
			],
			terminals: [
				terminal("t-live", "w-live"),
				terminal("t-binned", "w-binned"),
			],
			bindings: [],
			mirror: snapshot(
				[
					mirrorWorkspace("w-live", { projectId: "p-git" }),
					mirrorWorkspace("w-binned", {
						projectId: "p-git",
						deletedAt: NOW - 10,
					}),
				],
				[mirrorProject("p-git")],
			),
		});
		const workspaceIds = response.projects
			.flatMap((p) => p.workspaces)
			.map((w) => w.name);
		expect(workspaceIds).toEqual(["w-live"]);
		expect(response.counts.idle).toBe(1);
		expect(response.curation?.enabled).toBe(true);
		expect(response.curation?.hiddenWorkspaces).toBe(1);
		// A real age, measured against the real clock the handler reads. The upper
		// bound is the window that actually means something — a mirror still in
		// force — and NOT a round 60s: `NOW` is captured when this module loads, so
		// a 60s bound was really an assertion about how long the whole suite takes
		// to reach this line, and it started failing when the file grew.
		expect(response.curation?.lastSyncAgeMs).toBeGreaterThanOrEqual(1_000);
		expect(response.curation?.lastSyncAgeMs).toBeLessThan(MIRROR_MAX_AGE_MS);
	});

	it("an EMPTY tree is now distinguishable from an over-filtered one", async () => {
		const overFiltered = await tree({
			projects: baseProjects,
			workspaces: [workspaceRow("w-1", "p-git")],
			terminals: [terminal("t-1", "w-1")],
			bindings: [],
			mirror: snapshot(
				[mirrorWorkspace("w-1", { projectId: "p-git", deletedAt: NOW - 10 })],
				[mirrorProject("p-git")],
			),
		});
		expect(overFiltered.projects).toEqual([]);
		expect(overFiltered.curation?.hiddenWorkspaces).toBe(1);

		const genuinelyEmpty = await tree({
			projects: baseProjects,
			workspaces: [],
			terminals: [],
			bindings: [],
			mirror: snapshot([], [mirrorProject("p-git")]),
		});
		expect(genuinelyEmpty.projects).toEqual([]);
		expect(genuinelyEmpty.curation?.hiddenWorkspaces).toBe(0);
	});

	it("a stale mirror shows everything again, and says so", async () => {
		const response = await tree({
			projects: baseProjects,
			workspaces: [workspaceRow("w-1", "p-git")],
			terminals: [terminal("t-1", "w-1")],
			bindings: [],
			mirror: snapshot(
				[mirrorWorkspace("w-1", { projectId: "p-git", deletedAt: NOW - 10 })],
				[mirrorProject("p-git")],
				{ lastFullSyncAtMs: NOW - MIRROR_MAX_AGE_MS - 60_000 },
			),
		});
		expect(response.projects).toHaveLength(1);
		expect(response.curation?.enabled).toBe(false);
		expect(response.curation?.hiddenWorkspaces).toBe(0);
	});

	it("keeps a project's KIND out of the reach of curation — dragging a git branch onto a non-git project must not make it a git project", async () => {
		const projects: HostProjectRow[] = [
			{ id: "p-git", name: "repo", repoPath: "C:/repo", worktreeBaseDir: null },
			{
				id: "p-plain",
				name: "notes",
				repoPath: "C:/notes",
				worktreeBaseDir: null,
			},
		];
		const workspaces = [
			workspaceRow("w-git", "p-git"),
			// The non-git project's own workspace carries the sentinel branch.
			workspaceRow("w-notes", "p-plain", {
				branch: NON_GIT_BRANCH,
				type: "main",
			}),
		];
		const fixture: TreeFixture = {
			projects,
			workspaces,
			terminals: [terminal("t-git", "w-git"), terminal("t-notes", "w-notes")],
			bindings: [],
			mirror: snapshot(
				[
					// The git branch is PLACED under the non-git project.
					mirrorWorkspace("w-git", { projectId: "p-plain" }),
					mirrorWorkspace("w-notes", { projectId: "p-plain" }),
				],
				[mirrorProject("p-plain")],
			),
		};
		const response = await tree(fixture);
		const plain = response.projects.find((p) => p.name === "notes");
		// Both threads group under it — placement IS curation and must be honoured.
		expect(plain?.workspaces).toHaveLength(2);
		// ...but the repo is still a non-git folder.
		expect(plain?.kind).toBe("plain");
	});

	it("emits the optional fields: pinned, questionCount, multiSelect", async () => {
		const pending = pendingQuestionFixture({
			hostTerminalId: "t-1",
			questions: [
				questionItem({ index: 0, header: "First" }),
				questionItem({ index: 1, header: "Second", multiSelect: true }),
			],
		});
		const response = await tree({
			projects: baseProjects,
			workspaces: [workspaceRow("w-1", "p-git")],
			terminals: [terminal("t-1", "w-1")],
			bindings: [],
			mirror: snapshot(
				[mirrorWorkspace("w-1", { projectId: "p-git", pinnedAt: NOW - 5 })],
				[mirrorProject("p-git", { isPinned: true })],
			),
			pendingByHostTerminal: { "t-1": pending },
		});
		const project = response.projects[0];
		expect(project?.pinned).toBe(true);
		const workspace = project?.workspaces[0];
		expect(workspace?.pinned).toBe(true);
		const ref = workspace?.terminals[0]?.pendingQuestion;
		expect(ref?.questionCount).toBe(2);
		expect(ref?.multiSelect).toBe(true);
		// The headline is still only the FIRST question's header, which is exactly
		// why the count has to be sent alongside it.
		expect(ref?.headline).toBe("First");
	});

	it("OMITS pinned entirely when nothing is curated, rather than asserting not-pinned on the strength of a mirror that was never written", async () => {
		const response = await tree({
			projects: baseProjects,
			workspaces: [workspaceRow("w-1", "p-git")],
			terminals: [terminal("t-1", "w-1")],
			bindings: [],
			mirror: { meta: null, workspaces: [], projects: [] },
		});
		const project = response.projects[0];
		const workspace = project?.workspaces[0];
		// `in`, not `=== undefined`: §7.2 distinguishes a field the bridge does not
		// report from one it reports, and a key present with an undefined value is
		// the shape that reads as "reported" to anything but JSON.stringify.
		expect(project === undefined ? null : "pinned" in project).toBe(false);
		expect(workspace === undefined ? null : "pinned" in workspace).toBe(false);
		// The curation object still SAYS why, which is the honest half: the phone
		// learns pinning is unreported and learns the reason in the same response.
		expect(response.curation).toEqual({
			enabled: false,
			lastSyncAgeMs: null,
			hiddenWorkspaces: 0,
		});
	});

	it("emits pinned with the mirror's value once curation IS enabled — the field is unreported, not removed", async () => {
		const response = await tree({
			projects: baseProjects,
			workspaces: [workspaceRow("w-1", "p-git"), workspaceRow("w-2", "p-git")],
			terminals: [terminal("t-1", "w-1"), terminal("t-2", "w-2")],
			bindings: [],
			mirror: snapshot(
				[
					mirrorWorkspace("w-1", { projectId: "p-git", pinnedAt: NOW - 5 }),
					mirrorWorkspace("w-2", { projectId: "p-git" }),
				],
				[mirrorProject("p-git")],
			),
		});
		const project = response.projects[0];
		expect(project !== undefined && "pinned" in project).toBe(true);
		expect(project?.pinned).toBe(false);
		const byId = new Map(
			(project?.workspaces ?? []).map((w) => [w.name, w] as const),
		);
		// Within an ENABLED curation, false is a real answer: the mirror is a
		// whole-snapshot replace, so an unpinned row is a row the user has not
		// pinned.
		expect([...byId.values()].map((w) => w.pinned).sort()).toEqual([
			false,
			true,
		]);
	});
});

// ---------------------------------------------------------------------------
// countStatuses — the badge must never disagree with the screen behind it
// ---------------------------------------------------------------------------

describe("(BRIDGE-SIDEBAR-FILTER) handleHeartbeat counts the same set the tree renders", () => {
	const projects: HostProjectRow[] = [
		{ id: "p-git", name: "repo", repoPath: "C:/repo", worktreeBaseDir: null },
	];

	function curatedFixture(): TreeFixture {
		return {
			projects,
			workspaces: [
				workspaceRow("w-live", "p-git"),
				workspaceRow("w-binned", "p-git"),
				workspaceRow("w-snoozed", "p-git"),
			],
			terminals: [
				terminal("t-live", "w-live"),
				terminal("t-binned", "w-binned"),
				terminal("t-snoozed", "w-snoozed"),
			],
			bindings: [],
			mirror: snapshot(
				[
					mirrorWorkspace("w-live", { projectId: "p-git" }),
					mirrorWorkspace("w-binned", {
						projectId: "p-git",
						deletedAt: NOW - 10,
					}),
					mirrorWorkspace("w-snoozed", {
						projectId: "p-git",
						snoozeLaunchId: LAUNCH,
					}),
				],
				[mirrorProject("p-git")],
			),
		};
	}

	it("counts only the curated, live terminals — the pre-filter version reported eight blocked agents that had not existed for weeks", async () => {
		const fixture = curatedFixture();
		const deps = treeDeps(fixture);
		const heartbeat = await handleHeartbeat(deps, FULL_CTX, {
			lastEventGseq: null,
			foreground: true,
		});
		expect(heartbeat.counts).toEqual({ needsInput: 0, working: 0, idle: 1 });

		const treeResponse = await handleTree(deps, FULL_CTX, {
			includeIdle: true,
		});
		expect(heartbeat.counts).toEqual(treeResponse.counts);
	});

	it("counts everything again once the mirror ages out, and the tree agrees", async () => {
		const fixture = curatedFixture();
		fixture.mirror = snapshot(
			fixture.mirror.workspaces,
			fixture.mirror.projects,
			{ lastFullSyncAtMs: NOW - MIRROR_MAX_AGE_MS - 60_000 },
		);
		const deps = treeDeps(fixture);
		const heartbeat = await handleHeartbeat(deps, FULL_CTX, {
			lastEventGseq: null,
			foreground: true,
		});
		expect(heartbeat.counts).toEqual({ needsInput: 0, working: 0, idle: 3 });
		const treeResponse = await handleTree(deps, FULL_CTX, {
			includeIdle: true,
		});
		expect(heartbeat.counts).toEqual(treeResponse.counts);
	});
});
