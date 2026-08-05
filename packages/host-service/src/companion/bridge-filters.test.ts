import { describe, expect, it } from "bun:test";
import {
	agentKindFromAgentId,
	agentKindFromDefinitionId,
	resolveAgentKind,
} from "./agent-kind";
import {
	createTerminalLiveness,
	LIVENESS_ACTIVITY_GRACE_MS,
	LIVENESS_DAEMON_WARMUP_MS,
	LIVENESS_REFRESH_TIMEOUT_MS,
	LIVENESS_SNAPSHOT_MAX_TRUST_MS,
} from "./liveness";
import {
	createSidebarCuration,
	type SidebarMirrorSnapshot,
	type SidebarWorkspaceMirrorRow,
} from "./sidebar-filter";

// ---------------------------------------------------------------------------
// (BRIDGE-AGENT-KIND) — the live refusal this fixes
// ---------------------------------------------------------------------------

describe("(BRIDGE-AGENT-KIND) resolveAgentKind", () => {
	it("accepts a Claude binding whose definitionId is absent — the shape of EVERY persisted binding on this machine, and the reason three consecutive wrist answers were refused as 'unsupported agent kind: unknown'", () => {
		expect(
			resolveAgentKind({ agentId: "claude", definitionId: undefined }),
		).toBe("claude");
		expect(resolveAgentKind({ agentId: "claude", definitionId: null })).toBe(
			"claude",
		);
	});

	it("accepts a Claude binding whose definitionId is a custom-config UUID — present but unrecognisable, which the old rule also read as unknown", () => {
		expect(
			resolveAgentKind({
				agentId: "claude",
				definitionId: "0d2c2b1e-6f0e-4d1a-9f3c-5b1a7c8d9e0f",
			}),
		).toBe("claude");
	});

	it("still refuses a binding whose definitionId AND agentId are both unrecognised", () => {
		expect(
			resolveAgentKind({ agentId: "weird", definitionId: undefined }),
		).toBe("unknown");
		expect(
			resolveAgentKind({ agentId: undefined, definitionId: undefined }),
		).toBe("unknown");
	});

	it("prefers the definition id when it says something", () => {
		expect(
			resolveAgentKind({ agentId: "claude", definitionId: "codex-cli" }),
		).toBe("codex");
	});

	it("matches agent_id EXACTLY — a custom agent id merely CONTAINING 'claude' must not inherit Claude's byte contract", () => {
		expect(agentKindFromAgentId("claude-ish")).toBe("unknown");
		expect(agentKindFromAgentId("myclaude")).toBe("unknown");
		expect(agentKindFromAgentId("claude")).toBe("claude");
		expect(agentKindFromAgentId("codex")).toBe("codex");
	});

	it("matches definition_id by substring, because catalog ids are compound", () => {
		expect(agentKindFromDefinitionId("claude-code")).toBe("claude");
		expect(agentKindFromDefinitionId("CODEX-CLI")).toBe("codex");
		expect(agentKindFromDefinitionId("gemini")).toBe("unknown");
	});
});

// ---------------------------------------------------------------------------
// (BRIDGE-SIDEBAR-FILTER)
// ---------------------------------------------------------------------------

const LAUNCH = "launch-abc";
const NOW = 1_700_000_000_000;

function mirrorWorkspace(
	workspaceId: string,
	overrides: Partial<SidebarWorkspaceMirrorRow> = {},
): SidebarWorkspaceMirrorRow {
	return {
		workspaceId,
		projectId: "p1",
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

function snapshot(
	workspaces: SidebarWorkspaceMirrorRow[],
	projectIds: string[],
): SidebarMirrorSnapshot {
	return {
		meta: {
			lastFullSyncAtMs: NOW - 1000,
			appLaunchId: LAUNCH,
			organizationId: "org",
			workspaceCount: workspaces.length,
			projectCount: projectIds.length,
		},
		workspaces,
		projects: projectIds.map((projectId) => ({
			projectId,
			tabOrder: 0,
			isPinned: false,
			isCollapsed: false,
		})),
	};
}

const branch = { id: "w1", projectId: "p1", type: "worktree" };
const main = { id: "w1", projectId: "p1", type: "main" };

describe("(BRIDGE-SIDEBAR-FILTER) createSidebarCuration", () => {
	it("filters NOTHING when no renderer has ever synced — a fresh install must not fail closed and blank the phone", () => {
		const curation = createSidebarCuration(
			{ meta: null, workspaces: [], projects: [] },
			NOW,
		);
		expect(curation.enabled).toBe(false);
		expect(curation.workspaceVerdict(branch)).toBe("show");
		expect(curation.projectVerdict("p-never-mirrored")).toBe("show");
	});

	it("shows a workspace with NO mirrored row — absence is 'no opinion recorded', never 'hidden'", () => {
		const curation = createSidebarCuration(snapshot([], ["p1"]), NOW);
		expect(curation.workspaceVerdict(branch)).toBe("show");
	});

	it("hides each curated-away bucket, in the renderer's own precedence", () => {
		const cases: [string, Partial<SidebarWorkspaceMirrorRow>, string][] = [
			["deleted", { deletedAt: NOW - 5 }, "deleted"],
			["completed", { completedAt: NOW - 5 }, "completed"],
			["archived", { archivedAt: NOW - 5 }, "archived"],
			["timed snooze", { snoozeUntil: NOW + 60_000 }, "snoozed"],
			["launch snooze", { snoozeLaunchId: LAUNCH }, "snoozed"],
		];
		for (const [label, overrides, expected] of cases) {
			const curation = createSidebarCuration(
				snapshot([mirrorWorkspace("w1", overrides)], ["p1"]),
				NOW,
			);
			expect(`${label}:${curation.workspaceVerdict(branch)}`).toBe(
				`${label}:${expected}`,
			);
		}
	});

	it("deleted outranks every other mark — the bin is a binned thread's only surface", () => {
		const curation = createSidebarCuration(
			snapshot(
				[
					mirrorWorkspace("w1", {
						deletedAt: NOW - 5,
						completedAt: NOW - 5,
						archivedAt: NOW - 5,
					}),
				],
				["p1"],
			),
			NOW,
		);
		expect(curation.workspaceVerdict(branch)).toBe("deleted");
	});

	it("shows a thread whose timed snooze has EXPIRED", () => {
		const curation = createSidebarCuration(
			snapshot([mirrorWorkspace("w1", { snoozeUntil: NOW - 1 })], ["p1"]),
			NOW,
		);
		expect(curation.workspaceVerdict(branch)).toBe("show");
	});

	it("shows a thread whose launch snooze belongs to a PREVIOUS launch", () => {
		const curation = createSidebarCuration(
			snapshot(
				[mirrorWorkspace("w1", { snoozeLaunchId: "older-launch" })],
				["p1"],
			),
			NOW,
		);
		expect(curation.workspaceVerdict(branch)).toBe("show");
	});

	it("treats a hidden NON-main thread as archived and a hidden main as merely hidden — both off the sidebar, and both need workspaces.type to tell apart", () => {
		const curation = createSidebarCuration(
			snapshot([mirrorWorkspace("w1", { isHidden: true })], ["p1"]),
			NOW,
		);
		expect(curation.workspaceVerdict(branch)).toBe("archived");
		expect(curation.workspaceVerdict(main)).toBe("hidden");
	});

	it("accepts SQLite's integer booleans as well as real ones", () => {
		const curation = createSidebarCuration(
			snapshot([mirrorWorkspace("w1", { isHidden: 1 })], ["p1"]),
			NOW,
		);
		expect(curation.workspaceVerdict(branch)).toBe("archived");
	});

	it("drops a project with no placement row, and its threads with it — PROJECT absence IS a statement once the mirror is filled", () => {
		const curation = createSidebarCuration(snapshot([], ["p-other"]), NOW);
		expect(curation.projectVerdict("p1")).toBe("project_not_in_sidebar");
		expect(curation.workspaceVerdict(branch)).toBe("project_not_in_sidebar");
	});

	it("reproduces isAutoIncludedLocalMainWorkspace from ABSENCE plus a placed project, without synthesising a row", () => {
		const placed = createSidebarCuration(snapshot([], ["p1"]), NOW);
		expect(placed.workspaceVerdict(main)).toBe("show");
		const unplaced = createSidebarCuration(snapshot([], ["p-other"]), NOW);
		expect(unplaced.workspaceVerdict(main)).toBe("project_not_in_sidebar");
	});

	it("groups a thread under the project the user PLACED it in, not workspaces.project_id", () => {
		const curation = createSidebarCuration(
			snapshot([mirrorWorkspace("w1", { projectId: "p2" })], ["p2"]),
			NOW,
		);
		expect(curation.effectiveProjectId(branch)).toBe("p2");
		expect(curation.workspaceVerdict(branch)).toBe("show");
	});
});

// ---------------------------------------------------------------------------
// (BRIDGE-LIVENESS)
// ---------------------------------------------------------------------------

function livenessHarness(options: {
	inProcess?: Set<string>;
	daemon?: () => Promise<string[]>;
	startedAtMs?: number;
	clock: { now: number };
}) {
	const inProcess = options.inProcess ?? new Set<string>();
	return createTerminalLiveness({
		hasInProcessSession: (id) => inProcess.has(id),
		listDaemonAliveIds: options.daemon ?? (async () => []),
		now: () => options.clock.now,
		startedAtMs: options.startedAtMs ?? 0,
		log: () => {},
	});
}

describe("(BRIDGE-LIVENESS) createTerminalLiveness", () => {
	it("reports live before any snapshot exists — no evidence must never hide a blocked agent", () => {
		const clock = { now: 1_000_000 };
		const liveness = livenessHarness({ clock });
		expect(liveness.isLive("t-unknown")).toBe(true);
	});

	it("reports dead only once a fresh listing positively lacks the id", async () => {
		const clock = { now: 1_000_000 };
		const liveness = livenessHarness({
			clock,
			daemon: async () => ["t-alive"],
		});
		await liveness.refresh();
		expect(liveness.isLive("t-alive", 0)).toBe(true);
		expect(liveness.isLive("t-corpse", 0)).toBe(false);
	});

	it("keeps an in-process session live even when the daemon does not list it — an adopted session is absent from one of the two sources by design", async () => {
		const clock = { now: 1_000_000 };
		const liveness = livenessHarness({
			clock,
			inProcess: new Set(["t-attached"]),
			daemon: async () => ["t-other"],
		});
		await liveness.refresh();
		expect(liveness.isLive("t-attached", 0)).toBe(true);
	});

	it("keeps a row touched inside the activity grace live — it may be newer than the snapshot", async () => {
		const clock = { now: 1_000_000 };
		const liveness = livenessHarness({
			clock,
			daemon: async () => ["t-other"],
		});
		await liveness.refresh();
		expect(
			liveness.isLive("t-newborn", clock.now - LIVENESS_ACTIVITY_GRACE_MS + 1),
		).toBe(true);
		expect(
			liveness.isLive("t-old", clock.now - LIVENESS_ACTIVITY_GRACE_MS - 1),
		).toBe(false);
	});

	it("stops trusting a snapshot older than the trust window", async () => {
		const clock = { now: 1_000_000 };
		const liveness = livenessHarness({
			clock,
			daemon: async () => ["t-other"],
		});
		await liveness.refresh();
		expect(liveness.isLive("t-corpse", 0)).toBe(false);
		clock.now += LIVENESS_SNAPSHOT_MAX_TRUST_MS + 1;
		expect(liveness.isLive("t-corpse", 0)).toBe(true);
	});

	it("treats an EMPTY daemon listing as no evidence during the adoption warm-up, and as evidence after it", async () => {
		const clock = { now: 10_000 };
		const warm = livenessHarness({
			clock,
			startedAtMs: 0,
			daemon: async () => [],
		});
		await warm.refresh();
		expect(warm.describe().hasSnapshot).toBe(false);
		expect(warm.isLive("t-corpse", 0)).toBe(true);

		const clock2 = { now: LIVENESS_DAEMON_WARMUP_MS + 1 };
		const settled = livenessHarness({
			clock: clock2,
			startedAtMs: 0,
			daemon: async () => [],
		});
		await settled.refresh();
		expect(settled.describe().hasSnapshot).toBe(true);
		expect(settled.isLive("t-corpse", 0)).toBe(false);
	});

	it("drops its snapshot when the daemon is unreachable, so every terminal reads live rather than serving a stale listing", async () => {
		const clock = { now: 1_000_000 };
		let fail = false;
		const liveness = livenessHarness({
			clock,
			daemon: async () => {
				if (fail) throw new Error("daemon down");
				return ["t-alive"];
			},
		});
		await liveness.refresh();
		expect(liveness.isLive("t-corpse", 0)).toBe(false);
		fail = true;
		clock.now += LIVENESS_SNAPSHOT_MAX_TRUST_MS;
		await liveness.refresh();
		expect(liveness.describe().hasSnapshot).toBe(false);
		expect(liveness.isLive("t-corpse", 0)).toBe(true);
	});
});

describe("(BRIDGE-LIVENESS) refresh is bounded", () => {
	it("stops waiting on a daemon listing that has not landed, and proceeds showing everything", async () => {
		const clock = { now: 1_000_000 };
		const liveness = livenessHarness({
			clock,
			// `getDaemonClient` blocks on the daemon bootstrap by design, so this is
			// the real shape of a tree request arriving during an adoption.
			daemon: () => new Promise<string[]>(() => {}),
		});
		const started = Date.now();
		await liveness.refresh();
		const waited = Date.now() - started;
		expect(waited).toBeGreaterThanOrEqual(LIVENESS_REFRESH_TIMEOUT_MS - 100);
		expect(waited).toBeLessThan(LIVENESS_REFRESH_TIMEOUT_MS + 2_000);
		// No evidence yet, so nothing is hidden.
		expect(liveness.describe().hasSnapshot).toBe(false);
		expect(liveness.isLive("t-anything")).toBe(true);
	});
});
