import type { HarnessKind, StopReason } from "@superset/session-protocol";
import type {
	AgentDefinitionId,
	AgentIdentityId,
} from "@superset/shared/agent-catalog";
import type { BranchPrefixMode } from "@superset/shared/workspace-launch";
import { sql } from "drizzle-orm";
import {
	index,
	integer,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const terminalSessions = sqliteTable(
	"terminal_sessions",
	{
		id: text().primaryKey(),
		originWorkspaceId: text("origin_workspace_id").references(
			() => workspaces.id,
			{ onDelete: "set null" },
		),
		status: text().notNull().default("active"),
		createdAt: integer("created_at")
			.notNull()
			.$defaultFn(() => Date.now()),
		lastAttachedAt: integer("last_attached_at"),
		endedAt: integer("ended_at"),
		/**
		 * Set the moment a dispose is requested — durable intent-to-kill. A
		 * failed kill leaves the row `active` with this stamp, and the reaper
		 * retries it regardless of workspace liveness (a one-shot renderer
		 * broadcast must not be the only chance to kill a session).
		 */
		disposeRequestedAt: integer("dispose_requested_at"),
	},
	(table) => [
		index("terminal_sessions_origin_workspace_id_idx").on(
			table.originWorkspaceId,
		),
		index("terminal_sessions_status_idx").on(table.status),
	],
);

export const terminalAgentBindings = sqliteTable(
	"terminal_agent_bindings",
	{
		terminalId: text("terminal_id")
			.primaryKey()
			.references(() => terminalSessions.id, { onDelete: "cascade" }),
		workspaceId: text("workspace_id").notNull(),
		agentId: text("agent_id").notNull().$type<AgentIdentityId>(),
		agentSessionId: text("agent_session_id"),
		definitionId: text("definition_id").$type<AgentDefinitionId>(),
		startedAt: integer("started_at").notNull(),
		lastEventAt: integer("last_event_at").notNull(),
		lastEventType: text("last_event_type").notNull(),
	},
	(table) => [
		index("terminal_agent_bindings_workspace_id_idx").on(table.workspaceId),
	],
);

export const projects = sqliteTable(
	"projects",
	{
		id: text().primaryKey(),
		repoPath: text("repo_path").notNull(),
		repoProvider: text("repo_provider"),
		repoOwner: text("repo_owner"),
		repoName: text("repo_name"),
		repoUrl: text("repo_url"),
		remoteName: text("remote_name"),
		worktreeBaseDir: text("worktree_base_dir"),
		// Per-project branch-prefix override. A null `branchPrefixMode` means
		// "fall back to the host-wide default" in `host_settings`.
		branchPrefixMode: text("branch_prefix_mode").$type<BranchPrefixMode>(),
		branchPrefixCustom: text("branch_prefix_custom"),
		// Empty string means "not yet backfilled" — the startup sweep targets
		// these rows (name from cloud legacy row if reachable, else basename).
		name: text().notNull().default(""),
		// 0 means "predates local ownership"; write paths always set it.
		updatedAt: integer("updated_at").notNull().default(0),
		createdAt: integer("created_at")
			.notNull()
			.$defaultFn(() => Date.now()),
	},
	(table) => [index("projects_repo_path_idx").on(table.repoPath)],
);

/**
 * Single-row host-wide settings (always `id = 1`). The host-service has no
 * generic settings store yet; this row holds host-wide knobs (worktree base
 * dir, branch-prefix default) that projects fall back to when they have no
 * override of their own.
 */
export const hostSettings = sqliteTable("host_settings", {
	id: integer().primaryKey().default(1),
	worktreeBaseDir: text("worktree_base_dir"),
	branchPrefixMode: text("branch_prefix_mode").$type<BranchPrefixMode>(),
	branchPrefixCustom: text("branch_prefix_custom"),
});

export const pullRequests = sqliteTable(
	"pull_requests",
	{
		id: text().primaryKey(),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		repoProvider: text("repo_provider").notNull(),
		repoOwner: text("repo_owner").notNull(),
		repoName: text("repo_name").notNull(),
		prNumber: integer("pr_number").notNull(),
		url: text().notNull(),
		title: text().notNull(),
		state: text().notNull(),
		isDraft: integer("is_draft", { mode: "boolean" }).notNull().default(false),
		headBranch: text("head_branch").notNull(),
		headSha: text("head_sha").notNull(),
		reviewDecision: text("review_decision"),
		checksStatus: text("checks_status").notNull().default("none"),
		checksJson: text("checks_json").notNull().default("[]"),
		lastFetchedAt: integer("last_fetched_at"),
		error: text(),
		createdAt: integer("created_at")
			.notNull()
			.$defaultFn(() => Date.now()),
		updatedAt: integer("updated_at")
			.notNull()
			.$defaultFn(() => Date.now()),
	},
	(table) => [
		index("pull_requests_project_id_idx").on(table.projectId),
		index("pull_requests_repo_branch_idx").on(
			table.repoProvider,
			table.repoOwner,
			table.repoName,
			table.headBranch,
		),
		uniqueIndex("pull_requests_repo_pr_unique").on(
			table.repoProvider,
			table.repoOwner,
			table.repoName,
			table.prNumber,
		),
	],
);

export const hostAgentConfigs = sqliteTable(
	"host_agent_configs",
	{
		id: text().primaryKey(),
		presetId: text("preset_id").notNull(),
		// Optional icon override. When null the client falls back to the icon
		// implied by `presetId`. User-authored ("custom") agents set this to a
		// built-in icon key (e.g. "claude") to pick a recognizable icon.
		iconId: text("icon_id"),
		label: text().notNull(),
		command: text().notNull(),
		argsJson: text("args_json").notNull().default("[]"),
		promptTransport: text("prompt_transport").notNull(),
		promptArgsJson: text("prompt_args_json").notNull().default("[]"),
		envJson: text("env_json").notNull().default("{}"),
		displayOrder: integer("display_order").notNull(),
		createdAt: integer("created_at")
			.notNull()
			.$defaultFn(() => Date.now()),
		updatedAt: integer("updated_at")
			.notNull()
			.$defaultFn(() => Date.now()),
	},
	(table) => [
		index("host_agent_configs_display_order_idx").on(table.displayOrder),
	],
);

export const workspaces = sqliteTable(
	"workspaces",
	{
		id: text().primaryKey(),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		worktreePath: text("worktree_path").notNull(),
		branch: text().notNull(),
		headSha: text("head_sha"),
		upstreamOwner: text("upstream_owner"),
		upstreamRepo: text("upstream_repo"),
		upstreamBranch: text("upstream_branch"),
		pullRequestId: text("pull_request_id").references(() => pullRequests.id, {
			onDelete: "set null",
		}),
		// Empty string means "not yet backfilled from cloud" — the startup
		// backfill sweep targets these rows.
		name: text().notNull().default(""),
		type: text().$type<"main" | "worktree">().notNull().default("worktree"),
		taskId: text("task_id"),
		createdByUserId: text("created_by_user_id"),
		createdAt: integer("created_at")
			.notNull()
			.$defaultFn(() => Date.now()),
		// 0 means "predates local ownership"; write paths always set it.
		updatedAt: integer("updated_at").notNull().default(0),
		// Null = local changes not yet pushed to the cloud mirror (dual-write
		// era only; the column and reconciler go away in R3).
		cloudSyncedAt: integer("cloud_synced_at"),
	},
	(table) => [
		index("workspaces_project_id_idx").on(table.projectId),
		index("workspaces_upstream_ref_idx").on(
			table.upstreamOwner,
			table.upstreamRepo,
			table.upstreamBranch,
		),
		index("workspaces_pull_request_id_idx").on(table.pullRequestId),
		uniqueIndex("workspaces_one_main_per_project")
			.on(table.projectId)
			.where(sql`type = 'main'`),
	],
);

/**
 * Registry of ACP agent sessions (docs/acp-sessions.md). One row per
 * session, kept fresh on every state emit. Rows survive host restarts so the
 * manager can list them as `offline` and resurrect on demand via the
 * adapter's `session/load` — the journal itself is not persisted; transcript
 * replay comes from the agent harness's own on-disk session store.
 */
export const acpSessions = sqliteTable(
	"acp_sessions",
	{
		sessionId: text("session_id").primaryKey(),
		workspaceId: text("workspace_id").notNull(),
		/** Adapter-side ACP session id — the `session/load` key. */
		acpSessionId: text("acp_session_id").notNull(),
		harness: text().notNull().$type<HarnessKind>(),
		cwd: text().notNull(),
		title: text(),
		lastStopReason: text("last_stop_reason").$type<StopReason>(),
		createdAt: integer("created_at").notNull(),
		updatedAt: integer("updated_at").notNull(),
	},
	(table) => [index("acp_sessions_workspace_id_idx").on(table.workspaceId)],
);

/**
 * Tombstones for workspaces deleted while the cloud was unreachable. The
 * reconciler drains this into `v2Workspace.delete` calls; rows are removed
 * once the cloud confirms. Dual-write era only — dropped in R3.
 */
export const workspaceCloudDeletes = sqliteTable("workspace_cloud_deletes", {
	id: text().primaryKey(),
	queuedAt: integer("queued_at")
		.notNull()
		.$defaultFn(() => Date.now()),
});

// ---------------------------------------------------------------------------
// (ANSWER-LEDGER) the companion answer ledger
// ---------------------------------------------------------------------------

/**
 * The closed set of ledger statuses, declared HERE rather than in
 * `src/companion/` because the persisted enum is a property of the table.
 *
 * Direction of dependency matters: the companion bridge consumes what the table
 * can hold, not the other way round. A companion-side union imported into this
 * file would let a wire-shape change silently widen what is on disk.
 *
 * The first four are carried over verbatim from the JSON attempt file this
 * replaces and mean exactly what §11.5 says they mean. `unknown` is deliberately
 * absent: it is the WIRE's degrade-to member for a status the reader does not
 * recognise, and a record the bridge itself wrote always knows which real
 * outcome it is in.
 *
 * `closed_not_received` is the new one — the TOMBSTONE. It is not a synonym for
 * `unconfirmed`: it is a terminal NEGATIVE plus a durable FENCE. It records that
 * the bridge has already told a client "nothing was ever received for this
 * requestId", which is a claim about the FUTURE as much as the past, so the row
 * has to survive to stop the answer path typing afterwards and making that claim
 * retroactively false. See `attempt-ledger.ts` for the compare-and-set that
 * relies on it.
 */
export const answerAttemptStatuses = [
	"in_flight",
	"confirmed",
	"failed",
	"unconfirmed",
	"closed_not_received",
] as const;

export type AnswerAttemptStatus = (typeof answerAttemptStatuses)[number];

/**
 * §11.4/§11.5 — the 24 h idempotency + status record, keyed by `requestId`.
 *
 * WHY THIS IS A TABLE AND NOT THE `answer-attempts.json` IT REPLACES. The JSON
 * store was durable, and durability was never the missing piece. What it could
 * not do is DECIDE: `handleAnswer` read the record, spent ~195 lines and several
 * awaits evaluating guards and taking a lock, and only then durably wrote
 * `in_flight`. A status read landing in that window saw no record and reported
 * "it was not sent" — and then the answer it had just contradicted went on to
 * type itself into the terminal. Absence cannot prove that nothing WILL be
 * typed, because that is a claim about the future, and no amount of durable
 * state attestation fixes a claim made without a fence.
 *
 * A fence needs an atomic compare-and-set between the two paths, which needs a
 * real transaction, which is what SQLite has and a read-modify-rewrite of a JSON
 * file structurally does not.
 *
 * SECOND-ORDER WIN, worth stating because it changes an accepted failure. The
 * JSON file was validated as a WHOLE: one incoherent record failed the file
 * schema and quarantined all 24 h of everyone else's records. Rows validate
 * individually here (`attempt-ledger.ts`), so one corrupt row costs exactly one
 * requestId its status.
 */
export const answerAttempts = sqliteTable(
	"answer_attempts",
	{
		/**
		 * §11.4's idempotency key, and the CAS key. The PRIMARY KEY is doing real
		 * work: it is the uniqueness constraint that makes `INSERT .. ON CONFLICT DO
		 * NOTHING` a decision procedure rather than a race.
		 */
		requestId: text("request_id").primaryKey(),
		/**
		 * Null for a `closed_not_received` tombstone and ONLY for one — a row that
		 * asserts nothing ever arrived has no attempt to describe. Storing a sentinel
		 * instead would be a lie the boundary could not catch, so the nullability is
		 * deliberate and the tombstone/attempt shapes are cross-checked on read.
		 */
		questionId: text("question_id"),
		deviceId: text("device_id"),
		surface: text().$type<"phone" | "watch">(),
		leaseId: text("lease_id"),
		/** The attempt's own start. Null for a tombstone, exactly as above. */
		startedAtMs: integer("started_at_ms"),
		/**
		 * The row's creation instant, always set — including for a tombstone, which
		 * is why it is separate from `startedAtMs`.
		 *
		 * Retention ages on THIS column so pruning has one unambiguous clock for both
		 * row shapes. For a real attempt the two coincide (the claim happens at the
		 * attempt's start); they are still kept apart because a single column that
		 * means "the attempt began" for one shape and "the negative was asserted" for
		 * another is the kind of overload a later reader gets wrong.
		 */
		createdAtMs: integer("created_at_ms").notNull(),
		status: text().notNull().$type<AnswerAttemptStatus>(),
		resolvedAtMs: integer("resolved_at_ms"),
		/**
		 * Plain text, not `$type`d. The authoritative union is
		 * `AttemptFailureCode` in `src/companion/types.ts`, which this file must not
		 * import (see `answerAttemptStatuses`), and duplicating it here would create
		 * two lists to widen together. The ledger's own public write signature takes
		 * `AttemptFailureCode`, so the compile-time check lives at the call site where
		 * it is useful, and the runtime check lives at the read boundary.
		 */
		failureCode: text("failure_code"),
		/** The §11.3 guards this attempt passed, as a JSON array of guard names. */
		guardsPassedJson: text("guards_passed_json").notNull().default("[]"),
		/**
		 * The coverage epoch in force when this row was created.
		 *
		 * Not load-bearing for the status of a PRESENT row — §11.5 serves those
		 * regardless of coverage — so this is deliberately not consulted by the CAS.
		 * It is what makes a degraded window diagnosable after the fact: "this row
		 * predates the rotation the client's stale epoch is complaining about".
		 */
		coverageEpoch: text("coverage_epoch").notNull(),
	},
	(table) => [
		// Pruning scans by age; nothing else queries by anything but the key.
		index("answer_attempts_created_at_ms_idx").on(table.createdAtMs),
	],
);

/**
 * (ANSWER-LEDGER) The single-row coverage epoch (always `id = 1`).
 *
 * WHAT IT IS. An opaque random id, NOT a timestamp, that a client captures
 * BEFORE it submits an answer, echoes back on a status read, and the server
 * compares for EQUALITY. Nothing is subtracted, ordered, or aged.
 *
 * WHY IT REPLACED A WALL CLOCK. §11.5's original coverage proof had the client
 * compute `serverTimeMs - recordsSinceMs > its own monotonic submitAgeMs`. That
 * arithmetic mixes two clocks, and it fails in the one direction that matters: a
 * server clock step FORWARD inflates the apparent coverage age, so a request the
 * bridge cannot actually vouch for satisfies the inequality and the client
 * renders the unrecoverable "it was not sent". An opaque token has no arithmetic
 * to get wrong — equal or not equal, and unequal is never a terminal negative.
 *
 * WHY IT MUST ROTATE. The token means "the coverage you captured is still the
 * coverage I have". Anything that loses continuity — a prune, or any
 * acknowledged gap — must rotate it in the SAME transaction, so a status read
 * carrying the old token is answered with a degrade rather than a negative.
 *
 * WHY A DEDICATED TABLE AND NOT `host_settings`. `host_settings` is documented as
 * host-wide user KNOBS that projects fall back to; every settings write path can
 * touch it and every column there is nullable by design. This is not a knob, it
 * is a safety token: it must be notNull, it must be rotated transactionally with
 * a delete, and its lifecycle must be owned entirely by the ledger. Putting it in
 * `host_settings` would hand an unrelated write path the ability to move it and
 * would force a "no epoch yet" degenerate case into every read. The single-row
 * `id = 1` SHAPE is borrowed from `host_settings`; the ownership is not.
 */
export const answerCoverageEpoch = sqliteTable("answer_coverage_epoch", {
	id: integer().primaryKey().default(1),
	epoch: text().notNull(),
	rotatedAtMs: integer("rotated_at_ms").notNull(),
	/**
	 * How many times this install has rotated. Diagnostic only — the epoch is
	 * compared, never ordered — but it is the number that answers "is something
	 * rotating far more often than a daily prune" when clients report degraded
	 * coverage.
	 */
	rotations: integer().notNull().default(0),
	/** Why the last rotation happened, for the same diagnostic reason. */
	lastRotateReason: text("last_rotate_reason"),
});
