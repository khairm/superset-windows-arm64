/**
 * Test fixtures for the companion READ path — `handleTree`, the badge counts and
 * `/v1/question`'s `place`.
 *
 * Six suites were each carrying their own copy of the same `HostDbReader` stub
 * and the same `ReadDeps` tail, so every field added to either meant six
 * identical edits and a suite that missed one failed to compile for a reason
 * that had nothing to do with what it tests. One copy lives here.
 *
 * NOT a test file: nothing here asserts, and the name keeps it out of bun's
 * `*.test.ts` glob.
 */

import type { PendingQuestion } from "./question-store";
import type {
	HostBindingRow,
	HostDbReader,
	HostProjectRow,
	HostTerminalRow,
	HostWorkspaceRow,
	ReadDeps,
} from "./read-api";
import type {
	SidebarMirrorSnapshot,
	SidebarProjectMirrorRow,
	SidebarWorkspaceMirrorRow,
} from "./sidebar-filter";

/**
 * Real wall time: `handleTree`, `armPush` and the push probe all call
 * `Date.now()` themselves, so a fixture clock in the far future would read as a
 * mirror written after the fact. Pure `createSidebarCuration` cases pass their
 * own `now` in and are unaffected either way.
 */
export const NOW = Date.now();
export const ORG = "org-this-machine";
export const LAUNCH = "launch-1";

// ---------------------------------------------------------------------------
// rows
// ---------------------------------------------------------------------------

export function projectRow(
	id: string,
	name: string,
	repoPath = `C:/repos/${id}`,
): HostProjectRow {
	return { id, name, repoPath, worktreeBaseDir: null };
}

export function workspaceRow(
	id: string,
	projectId: string | null,
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

export function terminalRow(
	id: string,
	originWorkspaceId: string | null,
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

// ---------------------------------------------------------------------------
// (SIDEBAR-MIRROR) rows
// ---------------------------------------------------------------------------

export function mirrorWorkspace(
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

export function mirrorProject(
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

export function snapshot(
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

// ---------------------------------------------------------------------------
// host.db and the read deps
// ---------------------------------------------------------------------------

export interface TreeFixture {
	projects: HostProjectRow[];
	workspaces: HostWorkspaceRow[];
	terminals: HostTerminalRow[];
	bindings: HostBindingRow[];
	mirror: SidebarMirrorSnapshot;
	pendingByHostTerminal?: Record<string, PendingQuestion>;
	/** Absent = read from `workspaces`. Present to make one read THROW. */
	findWorkspace?: (id: string) => HostWorkspaceRow | null;
	/** Absent = read from `projects`. Present to make one read THROW. */
	findProject?: (id: string) => HostProjectRow | null;
}

export function hostDbReader(fixture: TreeFixture): HostDbReader {
	return {
		listProjects: () => fixture.projects,
		listWorkspaces: () => fixture.workspaces,
		listActiveTerminals: () => fixture.terminals,
		listBindings: () => fixture.bindings,
		findWorkspace:
			fixture.findWorkspace ??
			((id) => fixture.workspaces.find((w) => w.id === id) ?? null),
		findProject:
			fixture.findProject ??
			((id) => fixture.projects.find((p) => p.id === id) ?? null),
		listTerminalIdsForWorkspace: (workspaceId) =>
			fixture.terminals
				.filter((t) => t.originWorkspaceId === workspaceId)
				.map((t) => t.id),
		findBinding: (id) =>
			fixture.bindings.find((b) => b.terminalId === id) ?? null,
		findTerminal: (id) => fixture.terminals.find((t) => t.id === id) ?? null,
		readSidebarMirror: () => fixture.mirror,
		resolveTerminal: () => null,
		resolveActiveTerminal: () => null,
		resolveTranscriptPath: async () => null,
		transcriptPathFor: async () => null,
		resolveTerminalActivityMs: () => NOW,
		close: () => {},
	};
}

/**
 * The whole `ReadDeps` over a fixture. `overrides` is applied LAST, so a suite
 * that needs a richer `questions` store, a capturing `log` or a real
 * `resolveTabTitle` replaces exactly that member and inherits the rest.
 */
export function treeDeps(
	fixture: TreeFixture,
	overrides: Partial<ReadDeps> = {},
): ReadDeps {
	const pending = fixture.pendingByHostTerminal ?? {};
	return {
		db: hostDbReader(fixture),
		log: () => {},
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
		// (CHAT-CONTEXT-NAMES) No tab-title registry unless a suite asks for one:
		// `null` is the composition root that has none, and it pins that its
		// absence costs a read nothing.
		resolveTabTitle: null,
		...overrides,
	};
}
