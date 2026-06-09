import type { AppRouter } from "@superset/host-service";
import type { WorkspaceState } from "@superset/panes";
import type { inferRouterInputs } from "@trpc/server";
import { z } from "zod";

const persistedDateSchema = z
	.union([z.string(), z.date()])
	.transform((value) => (typeof value === "string" ? new Date(value) : value));

export const dashboardSidebarProjectSchema = z.object({
	projectId: z.string().uuid(),
	createdAt: persistedDateSchema,
	isCollapsed: z.boolean().default(false),
	// (ACTIVE-FIRST) Manual right-click pin. Pinned projects form the top sort
	// tier (pinned > active > idle); within the tier they keep their manual drag
	// order. Local-only like every other sidebar preference; legacy rows lack the
	// key and read back undefined, so the data hook heals it to false.
	isPinned: z.boolean().default(false),
	tabOrder: z.number().int().default(0),
	defaultOpenInApp: z.string().nullable().default(null),
	// Per-project reveal state for the Snoozed / Archived sections. Each
	// section is hidden until the user explicitly reveals it (right-click the
	// project), and once revealed can be collapsed independently. Remembered
	// across restarts (local-only, like every other sidebar preference).
	showSnoozed: z.boolean().default(false),
	showArchived: z.boolean().default(false),
	snoozedCollapsed: z.boolean().default(false),
	archivedCollapsed: z.boolean().default(false),
});

const paneWorkspaceStateSchema = z.custom<WorkspaceState<unknown>>();

const changesFilterSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("all") }),
	z.object({ kind: z.literal("uncommitted") }),
	z.object({ kind: z.literal("commit"), hash: z.string() }),
	z.object({
		kind: z.literal("range"),
		fromHash: z.string(),
		toHash: z.string(),
	}),
]);

export type ChangesFilter = z.infer<typeof changesFilterSchema>;

export type ChangesViewMode = "folders" | "tree";

const workspaceRunStateSchema = z.enum([
	"running",
	"stopped-by-user",
	"stopped-by-exit",
]);

export const workspaceRunTerminalStateSchema = z.object({
	terminalId: z.string(),
	workspaceId: z.string().uuid(),
	state: workspaceRunStateSchema,
	command: z.string(),
	definitionSource: z.enum(["project-config", "terminal-preset"]),
	definitionId: z.string().optional(),
	startedAt: z.number(),
	stoppedAt: z.number().optional(),
	exitCode: z.number().optional(),
	signal: z.number().optional(),
	stopRequestedAt: z.number().optional(),
});

export const workspaceLocalStateSchema = z.object({
	workspaceId: z.string().uuid(),
	createdAt: persistedDateSchema,
	sidebarState: z.object({
		projectId: z.string().uuid(),
		tabOrder: z.number().int().default(0),
		sectionId: z.string().uuid().nullable().default(null),
		changesFilter: changesFilterSchema.default({ kind: "all" }),
		changesViewMode: z.enum(["folders", "tree"]).default("folders"),
		// "card" (KANBAN) is the right-panel Task/Card tab added alongside
		// Files/Changes/Review. Additive enum widening — older rows still read
		// "changes". Default stays "changes" (the Card tab never auto-selects).
		activeTab: z.enum(["changes", "files", "review", "card"]).default("changes"),
		// `isHidden` doubles as the ARCHIVED flag — an archived thread is hidden
		// from the active lane and surfaced under the project's Archived section.
		// `archivedAt` orders that section (most-recently-archived first); legacy
		// hidden rows have no timestamp and sort last. `snooze*` is the timed-hide
		// state (mutually exclusive with archived): a thread is snoozed while
		// `snoozeUntil` is in the future, or `snoozeLaunchId` matches the current
		// app launch ("until next launch"). All local-only, visual-only.
		isHidden: z.boolean().default(false),
		archivedAt: z.number().nullable().default(null),
		snoozeUntil: z.number().nullable().default(null),
		snoozeLaunchId: z.string().nullable().default(null),
	}),
	paneLayout: paneWorkspaceStateSchema,
	viewedFiles: z.array(z.string()).default([]),
	recentlyViewedFiles: z
		.array(
			z.object({
				relativePath: z.string(),
				absolutePath: z.string(),
				lastAccessedAt: z.number(),
			}),
		)
		.default([]),
	workspaceRunTerminals: z
		.record(z.string(), workspaceRunTerminalStateSchema)
		.default({}),
});

// Defaults for fields heal can synthesize. Identity fields (workspaceId,
// createdAt, paneLayout, sidebarState.projectId) intentionally absent — they
// must come from the stored row.
const SIDEBAR_STATE_DEFAULTS = {
	tabOrder: 0,
	sectionId: null,
	changesFilter: { kind: "all" },
	changesViewMode: "folders",
	activeTab: "changes",
	isHidden: false,
	archivedAt: null,
	snoozeUntil: null,
	snoozeLaunchId: null,
} as const;

const WORKSPACE_LOCAL_STATE_OPTIONAL_DEFAULTS = {
	viewedFiles: [] as string[],
	recentlyViewedFiles: [] as Array<{
		relativePath: string;
		absolutePath: string;
		lastAccessedAt: number;
	}>,
	workspaceRunTerminals: {} as Record<
		string,
		z.infer<typeof workspaceRunTerminalStateSchema>
	>,
};

export const dashboardSidebarSectionSchema = z.object({
	sectionId: z.string().uuid(),
	projectId: z.string().uuid(),
	name: z.string().trim().min(1),
	createdAt: persistedDateSchema,
	tabOrder: z.number().int().default(0),
	isCollapsed: z.boolean().default(false),
	color: z.string().nullable().default(null),
});

const v2ExecutionModeSchema = z.enum([
	"split-pane",
	"new-tab",
	"new-tab-split-pane",
	"sequential",
]);

// projectIds uses plain z.string() (not uuid) because v1 accepts arbitrary
// string IDs and the migration copies them verbatim.
export const v2TerminalPresetSchema = z.object({
	id: z.string().uuid(),
	name: z.string(),
	description: z.string().optional(),
	cwd: z.string().default(""),
	commands: z.array(z.string()).default([]),
	projectIds: z.array(z.string()).nullable().default(null),
	pinnedToBar: z.boolean().optional(),
	useAsWorkspaceRun: z.boolean().optional(),
	applyOnWorkspaceCreated: z.boolean().optional(),
	applyOnNewTab: z.boolean().optional(),
	executionMode: v2ExecutionModeSchema.default("new-tab"),
	tabOrder: z.number().int().default(0),
	createdAt: persistedDateSchema,
	// When set, the preset is live-linked to a host-service agent config id.
	// Older rows may still contain a builtin preset id; the launcher/editor
	// support that as a fallback. The stored `commands` array is a snapshot
	// fallback for when the agent is missing or disabled.
	agentId: z.string().optional(),
});

export type DashboardSidebarProjectRow = z.infer<
	typeof dashboardSidebarProjectSchema
>;
export type WorkspaceLocalStateRow = z.infer<typeof workspaceLocalStateSchema>;
export type WorkspaceRunState = z.infer<typeof workspaceRunStateSchema>;
export type WorkspaceRunTerminalState = z.infer<
	typeof workspaceRunTerminalStateSchema
>;
export type DashboardSidebarSectionRow = z.infer<
	typeof dashboardSidebarSectionSchema
>;
export type V2TerminalPresetRow = z.infer<typeof v2TerminalPresetSchema>;

/**
 * Singleton row of v2 user-scoped preferences.
 *
 * fileLinks / urlLinks / sidebarFileLinks map click tiers
 * (plain, ⇧, ⌘, ⌘⇧) to an action:
 *   - null        → tier is unbound (surfaces show a hint or no-op)
 *   - "pane"      → open in current tab/pane (file viewer, in-app browser)
 *   - "newTab"    → open in a new tab/pane
 *   - "external"  → open in the external app (editor / system browser)
 *
 * Surfaces:
 *   - fileLinks / urlLinks: links embedded in terminal output and markdown.
 *     Terminal reads all 4 tiers; 2-tier surfaces (chat, task markdown)
 *     collapse shift→plain and metaShift→meta.
 *   - sidebarFileLinks: file rows in the sidebar (tree, changes, diff header)
 *     and similar in-app surfaces (port badges).
 *
 * Resolution and labels live in src/renderer/lib/clickPolicy.
 */
const linkActionSchema = z.enum(["pane", "newTab", "external"]);

export type LinkAction = z.infer<typeof linkActionSchema>;

const linkTierMapSchema = z.object({
	plain: linkActionSchema.nullable(),
	shift: linkActionSchema.nullable(),
	meta: linkActionSchema.nullable(),
	metaShift: linkActionSchema.nullable(),
});

export type LinkTierMap = z.infer<typeof linkTierMapSchema>;
export type LinkTier = keyof LinkTierMap;

const DEFAULT_LINK_TIER_MAP: LinkTierMap = {
	plain: null,
	shift: null,
	meta: "pane",
	metaShift: "external",
};

const LEGACY_SIDEBAR_FILE_LINKS: LinkTierMap = {
	plain: "pane",
	shift: "newTab",
	meta: "external",
	metaShift: "external",
};

const DEFAULT_SIDEBAR_FILE_LINKS: LinkTierMap = {
	plain: "pane",
	shift: "newTab",
	meta: "pane",
	metaShift: "external",
};

function isSameLinkTierMap(a: LinkTierMap, b: LinkTierMap): boolean {
	return (
		a.plain === b.plain &&
		a.shift === b.shift &&
		a.meta === b.meta &&
		a.metaShift === b.metaShift
	);
}

function isCompleteLinkTierMap(
	value: Partial<LinkTierMap>,
): value is LinkTierMap {
	return (
		"plain" in value &&
		"shift" in value &&
		"meta" in value &&
		"metaShift" in value
	);
}

export const v2UserPreferencesSchema = z.object({
	id: z.literal("preferences"),
	fileLinks: linkTierMapSchema.default(DEFAULT_LINK_TIER_MAP),
	urlLinks: linkTierMapSchema.default(DEFAULT_LINK_TIER_MAP),
	sidebarFileLinks: linkTierMapSchema.default(DEFAULT_SIDEBAR_FILE_LINKS),
	terminalPresetsInitialized: z.boolean().default(false),
	rightSidebarOpen: z.boolean().default(true),
	rightSidebarTab: z.enum(["changes", "files"]).default("changes"),
	rightSidebarWidth: z.number().default(340),
	deleteLocalBranch: z.boolean().default(false),
	showPresetsBar: z.boolean().default(true),
});

export type V2UserPreferencesRow = z.infer<typeof v2UserPreferencesSchema>;

export const V2_USER_PREFERENCES_ID = "preferences" as const;

export const DEFAULT_V2_USER_PREFERENCES: V2UserPreferencesRow = {
	id: V2_USER_PREFERENCES_ID,
	fileLinks: DEFAULT_LINK_TIER_MAP,
	urlLinks: DEFAULT_LINK_TIER_MAP,
	sidebarFileLinks: DEFAULT_SIDEBAR_FILE_LINKS,
	terminalPresetsInitialized: false,
	rightSidebarOpen: true,
	rightSidebarTab: "changes",
	rightSidebarWidth: 340,
	deleteLocalBranch: false,
	showPresetsBar: true,
};

/**
 * Heal a stored workspaceLocalState row against current defaults. Identity
 * fields (workspaceId, projectId, paneLayout, createdAt) pass through from
 * the stored row — they have no synthesizable default. Optional fields with
 * intrinsic defaults get filled at both the top level and inside sidebarState.
 */
export function healWorkspaceLocalState(raw: unknown): WorkspaceLocalStateRow {
	const r = (
		raw && typeof raw === "object" ? raw : {}
	) as Partial<WorkspaceLocalStateRow>;
	const sidebar = (
		r.sidebarState && typeof r.sidebarState === "object" ? r.sidebarState : {}
	) as Partial<WorkspaceLocalStateRow["sidebarState"]>;
	return {
		...r,
		viewedFiles:
			r.viewedFiles ?? WORKSPACE_LOCAL_STATE_OPTIONAL_DEFAULTS.viewedFiles,
		recentlyViewedFiles:
			r.recentlyViewedFiles ??
			WORKSPACE_LOCAL_STATE_OPTIONAL_DEFAULTS.recentlyViewedFiles,
		workspaceRunTerminals:
			r.workspaceRunTerminals ??
			WORKSPACE_LOCAL_STATE_OPTIONAL_DEFAULTS.workspaceRunTerminals,
		sidebarState: {
			...SIDEBAR_STATE_DEFAULTS,
			...sidebar,
		} as WorkspaceLocalStateRow["sidebarState"],
	} as WorkspaceLocalStateRow;
}

/**
 * Heal a stored v2 user-preferences row against current defaults. Used by the
 * localStorage collection's read-time parser so rows persisted before a field
 * was added (top-level or nested in a LinkTierMap) don't surface as undefined
 * to consumers. Per-tier defaults vary by map, so we deep-merge each tier map
 * against its own default rather than relying on a single Zod default.
 */
export function healV2UserPreferences(raw: unknown): V2UserPreferencesRow {
	const r = (
		raw && typeof raw === "object" ? raw : {}
	) as Partial<V2UserPreferencesRow>;
	const sidebarFileLinks = r.sidebarFileLinks
		? {
				...DEFAULT_V2_USER_PREFERENCES.sidebarFileLinks,
				...r.sidebarFileLinks,
			}
		: DEFAULT_V2_USER_PREFERENCES.sidebarFileLinks;
	const shouldMigrateLegacySidebarFileLinks =
		r.sidebarFileLinks &&
		isCompleteLinkTierMap(r.sidebarFileLinks) &&
		isSameLinkTierMap(r.sidebarFileLinks, LEGACY_SIDEBAR_FILE_LINKS);
	return {
		...DEFAULT_V2_USER_PREFERENCES,
		...r,
		fileLinks: { ...DEFAULT_V2_USER_PREFERENCES.fileLinks, ...r.fileLinks },
		urlLinks: { ...DEFAULT_V2_USER_PREFERENCES.urlLinks, ...r.urlLinks },
		sidebarFileLinks: shouldMigrateLegacySidebarFileLinks
			? DEFAULT_V2_USER_PREFERENCES.sidebarFileLinks
			: sidebarFileLinks,
	};
}

export type WorkspacesCreateInput =
	inferRouterInputs<AppRouter>["workspaces"]["create"];

export const failedWorkspaceCreateSchema = z.object({
	id: z.string().uuid(),
	hostId: z.string(),
	input: z.custom<WorkspacesCreateInput>(),
	error: z.string(),
	failedAt: persistedDateSchema,
});

export type FailedWorkspaceCreateRow = z.infer<
	typeof failedWorkspaceCreateSchema
>;

// ---------------------------------------------------------------------------
// (KANBAN) Local-only board: columns + cards.
//
// A single device-local Kanban that mirrors every branch (workspace) as a card
// plus user-created "Queued" task cards. Local-only like every other v2 sidebar
// UI-state collection — no server/Electric/Drizzle, created on first use, healed
// on read. See feature_plan_kanban-board.html.
//
// Snooze/archive: for a BOUND card (workspaceId set) the visibility comes from
// the branch's sidebarState (one source of truth) — the card's own snooze/
// archive fields are used ONLY for unbound (Queued) cards.
// ---------------------------------------------------------------------------

export const kanbanColumnSchema = z.object({
	id: z.string(),
	name: z.string().default(""),
	tabOrder: z.number().int().default(0),
	// Exactly one column is the fixed first "Queued" column (unbound tasks only).
	// Healed/seeded with a deterministic id (see kanbanQueueColumnId).
	isQueue: z.boolean().default(false),
	// Display-only sort. NEVER rewrites card tabOrder — flipping back to "manual"
	// restores the manual drag order untouched.
	sortMode: z.enum(["manual", "deadline"]).default("manual"),
	// Per-column Snoozed / Archived section reveal + collapse (mirrors the
	// project-level section flags on dashboardSidebarProjectSchema).
	showSnoozed: z.boolean().default(false),
	showArchived: z.boolean().default(false),
	snoozedCollapsed: z.boolean().default(false),
	archivedCollapsed: z.boolean().default(false),
	createdAt: z.number().default(0),
});

export type KanbanColumnRow = z.infer<typeof kanbanColumnSchema>;

export const kanbanCardSchema = z.object({
	// BOUND cards use a deterministic id `workspace:<workspaceId>` so reconcile /
	// promote / merge can never create two cards for one branch. Queued
	// (unbound) cards use a uuid.
	id: z.string(),
	columnId: z.string(),
	tabOrder: z.number().int().default(0),
	title: z.string().default(""),
	description: z.string().nullable().default(null),
	// Date-only deadline stored as local-midnight epoch-ms (null = none).
	deadline: z.number().nullable().default(null),
	// null = Queued / unbound; set = bound to a branch (workspace).
	workspaceId: z.string().nullable().default(null),
	// Used ONLY when unbound. Bound cards derive snooze/archive from the branch's
	// sidebarState — these stay null for them.
	snoozeUntil: z.number().nullable().default(null),
	snoozeLaunchId: z.string().nullable().default(null),
	archivedAt: z.number().nullable().default(null),
	createdAt: z.number().default(0),
});

export type KanbanCardRow = z.infer<typeof kanbanCardSchema>;

// Deterministic ids — the invariants ("exactly one queue", "one card per
// branch") are enforced by id, not just Zod defaults (localStorage reads skip
// defaults; see withReadHeal).
export const KANBAN_BOUND_CARD_PREFIX = "workspace:";

export function kanbanBoundCardId(workspaceId: string): string {
	return `${KANBAN_BOUND_CARD_PREFIX}${workspaceId}`;
}

/** The fixed first "Queued" column id. Constant (not per-org) because the
 * collection's storageKey is already org-scoped, so this is unique within each
 * org's board. Seeded/healed to exactly one. */
export const KANBAN_QUEUE_COLUMN_ID = "queue";

/** tabOrder reserved for the Queued column — always sorts first. */
export const KANBAN_QUEUE_TAB_ORDER = -1_000_000;

const KANBAN_COLUMN_DEFAULTS = {
	name: "",
	tabOrder: 0,
	isQueue: false,
	sortMode: "manual",
	showSnoozed: false,
	showArchived: false,
	snoozedCollapsed: false,
	archivedCollapsed: false,
	createdAt: 0,
} as const;

const KANBAN_CARD_DEFAULTS = {
	tabOrder: 0,
	title: "",
	description: null,
	deadline: null,
	workspaceId: null,
	snoozeUntil: null,
	snoozeLaunchId: null,
	archivedAt: null,
	createdAt: 0,
} as const;

/** Heal a stored Kanban column row — merges defaults so rows persisted before a
 * field existed read back normalized (identity field `id` passes through). */
export function healKanbanColumn(raw: unknown): KanbanColumnRow {
	const r = (
		raw && typeof raw === "object" ? raw : {}
	) as Partial<KanbanColumnRow>;
	const merged = { ...KANBAN_COLUMN_DEFAULTS, ...r } as KanbanColumnRow;
	// Derive the queue flag from the deterministic id (don't trust the stored
	// flag): guarantees exactly one queue and stops a stale row hydrating as the
	// wrong kind. The Queue column also always sorts first.
	merged.isQueue = merged.id === KANBAN_QUEUE_COLUMN_ID;
	if (merged.isQueue) merged.tabOrder = KANBAN_QUEUE_TAB_ORDER;
	return merged;
}

/** Heal a stored Kanban card row — merges defaults (identity fields `id` /
 * `columnId` pass through from the stored row). */
export function healKanbanCard(raw: unknown): KanbanCardRow {
	const r = (raw && typeof raw === "object" ? raw : {}) as Partial<KanbanCardRow>;
	return { ...KANBAN_CARD_DEFAULTS, ...r } as KanbanCardRow;
}
