import { describe, expect, it } from "bun:test";
import { NON_GIT_BRANCH } from "../runtime/git/non-git";
import {
	armPush,
	createIsStillUnansweredProbe,
	type NotifyingSinkDeps,
} from "./index";
import type { PendingQuestion } from "./question-store";
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

	it("treats a FUTURE stamp as fresh — a clock step backwards is not a reason to stop trusting content that is unaffected by it", () => {
		const future = createSidebarCuration(
			snapshot([], [mirrorProject("p-git")], {
				lastFullSyncAtMs: NOW + 60_000,
			}),
			NOW,
			ORG,
		);
		expect(future.enabled).toBe(true);
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

	it("answers false for everything when no curation is in force", () => {
		const off = createSidebarCuration(
			{ meta: null, workspaces: [], projects: [] },
			NOW,
			ORG,
		);
		expect(off.workspacePinned("w-1")).toBe(false);
		expect(off.projectPinned("p-git")).toBe(false);
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

function armDeps(options: {
	mirror: SidebarMirrorSnapshot | (() => SidebarMirrorSnapshot);
	workspace?: HostWorkspaceRow | null;
}): { deps: NotifyingSinkDeps; scheduled: QuestionId[]; errors: string[] } {
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
		db: {
			readSidebarMirror: () =>
				typeof options.mirror === "function"
					? options.mirror()
					: options.mirror,
			findWorkspace: () => options.workspace ?? null,
		} as unknown as HostDbReader,
		organizationId: ORG,
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

describe("(PUSH-CURATION-GATE)", () => {
	it("does NOT arm a push for a binned thread — the notification would open a tree that does not contain it", () => {
		const { deps, scheduled } = armDeps({
			mirror: snapshot(
				[mirrorWorkspace("w-1", { deletedAt: NOW - 50 })],
				[mirrorProject("p-git")],
			),
			workspace: hostWorkspace,
		});
		armPush(deps, pendingQuestionFixture());
		expect(scheduled).toEqual([]);
	});

	it.each([
		["snoozed until next launch", { snoozeLaunchId: LAUNCH }],
		["snoozed on a timer", { snoozeUntil: NOW + 60_000 }],
		["archived", { archivedAt: NOW - 50 }],
		["completed", { completedAt: NOW - 50 }],
	])("does NOT arm a push for a %s thread", (_label, overrides) => {
		const { deps, scheduled } = armDeps({
			mirror: snapshot(
				[mirrorWorkspace("w-1", overrides)],
				[mirrorProject("p-git")],
			),
			workspace: hostWorkspace,
		});
		armPush(deps, pendingQuestionFixture());
		expect(scheduled).toEqual([]);
	});

	it("STILL arms when host.db has no workspace row — absence is no opinion recorded, everywhere in this feature", () => {
		const { deps, scheduled } = armDeps({
			mirror: snapshot(
				[mirrorWorkspace("w-1", { deletedAt: NOW - 50 })],
				[mirrorProject("p-git")],
			),
			workspace: null,
		});
		armPush(deps, pendingQuestionFixture());
		expect(scheduled).toEqual(["q-1" as QuestionId]);
	});

	it("STILL arms when no curation is in force", () => {
		const { deps, scheduled } = armDeps({
			mirror: { meta: null, workspaces: [], projects: [] },
			workspace: hostWorkspace,
		});
		armPush(deps, pendingQuestionFixture());
		expect(scheduled).toEqual(["q-1" as QuestionId]);
	});

	it("STILL arms when the mirror aged out, or belongs to another org", () => {
		for (const mirror of [
			snapshot([mirrorWorkspace("w-1", { deletedAt: NOW - 50 })], [], {
				lastFullSyncAtMs: NOW - MIRROR_MAX_AGE_MS - 1,
			}),
			snapshot([mirrorWorkspace("w-1", { deletedAt: NOW - 50 })], [], {
				organizationId: OTHER_ORG,
			}),
		]) {
			const { deps, scheduled } = armDeps({ mirror, workspace: hostWorkspace });
			armPush(deps, pendingQuestionFixture());
			expect(scheduled).toEqual(["q-1" as QuestionId]);
		}
	});

	it("STILL arms, loudly, when reading curation throws — a missed buzz for a blocked agent is the worse failure", () => {
		const { deps, scheduled, errors } = armDeps({
			mirror: () => {
				throw new Error("host.db is locked");
			},
			workspace: hostWorkspace,
		});
		armPush(deps, pendingQuestionFixture());
		expect(scheduled).toEqual(["q-1" as QuestionId]);
		expect(errors).toHaveLength(1);
	});

	it("arms normally for a thread that is on the sidebar", () => {
		const { deps, scheduled } = armDeps({
			mirror: snapshot([mirrorWorkspace("w-1")], [mirrorProject("p-git")]),
			workspace: hostWorkspace,
		});
		armPush(deps, pendingQuestionFixture());
		expect(scheduled).toEqual(["q-1" as QuestionId]);
	});
});

// ---------------------------------------------------------------------------
// isStillUnanswered — item 7
// ---------------------------------------------------------------------------

describe("(QUESTION-EXPIRY) createIsStillUnansweredProbe", () => {
	function probe(options: {
		question: PendingQuestion | null;
		gone?: boolean;
	}) {
		const errors: string[] = [];
		const fn = createIsStillUnansweredProbe({
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
		expect(probe({ question: pendingQuestionFixture() }).answer).toBe(true);
	});

	it("drops the buzz for a SETTLED question, silently — that is the ordinary path and it needs no log line", () => {
		const settled = probe({
			question: pendingQuestionFixture({ state: "resolved" }),
		});
		expect(settled.answer).toBe(false);
		expect(settled.errors).toEqual([]);
	});

	it("drops the buzz when the terminal is provably gone", () => {
		expect(
			probe({ question: pendingQuestionFixture(), gone: true }).answer,
		).toBe(false);
	});

	it("drops the buzz for an ABSENT question and NAMES the restart — the fence is durable, the store is memory-only, and the lost buzz is otherwise invisible", () => {
		const absent = probe({ question: null });
		expect(absent.answer).toBe(false);
		expect(absent.errors).toHaveLength(1);
		expect(absent.errors[0]).toContain("restarted");
	});
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
		// A real age, measured against the real clock the handler reads.
		expect(response.curation?.lastSyncAgeMs).toBeGreaterThanOrEqual(1_000);
		expect(response.curation?.lastSyncAgeMs).toBeLessThan(60_000);
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

	it("reports pinned: false rather than omitting it when nothing is curated", async () => {
		const response = await tree({
			projects: baseProjects,
			workspaces: [workspaceRow("w-1", "p-git")],
			terminals: [terminal("t-1", "w-1")],
			bindings: [],
			mirror: { meta: null, workspaces: [], projects: [] },
		});
		expect(response.projects[0]?.pinned).toBe(false);
		expect(response.projects[0]?.workspaces[0]?.pinned).toBe(false);
		expect(response.curation).toEqual({
			enabled: false,
			lastSyncAgeMs: null,
			hiddenWorkspaces: 0,
		});
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
