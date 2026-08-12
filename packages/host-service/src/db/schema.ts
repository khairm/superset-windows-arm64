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
		// Set when the agent session ended. "detached" = the agent reported its
		// own end (SessionEnd hook) — not resumable; "terminal-exited" = the
		// terminal died under it (kill, crash, reboot) — resume candidate.
		endedAt: integer("ended_at"),
		endReason: text("end_reason"),
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
		// Custom project icon as a small downscaled data-URI. Null falls back to
		// the GitHub owner avatar (when a repo is linked) or a placeholder.
		icon: text("icon"),
		// Accent color as a `#rrggbb` hex. Null means the default (no accent).
		color: text("color"),
		// JSON array of repo-relative folders to cone-mode sparse-checkout into
		// new worktrees. Null (the default) means a full checkout. Read through
		// `parseSparseCheckoutPaths` — the encoding is not part of the API.
		sparseCheckoutPaths: text("sparse_checkout_paths"),
		// Free-text instructions injected into AI workspace/branch naming for
		// this project (e.g. "include the Linear ticket id in the branch name").
		// Null means the default naming behavior.
		namingInstructions: text("naming_instructions"),
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
		// Set when the PR is first observed merged; never cleared. Anchors
		// "merged in the last N days" windows on the workspaces board.
		mergedAt: integer("merged_at"),
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
		// Args that resume a previous session; the session id is appended after
		// them. Empty means the agent has no id-based resume.
		resumeArgsJson: text("resume_args_json").notNull().default("[]"),
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
		// Null = a project-less "session" workspace (managed folder under
		// ~/.superset/sessions, its own standalone git repo).
		projectId: text("project_id").references(() => projects.id, {
			onDelete: "cascade",
		}),
		worktreePath: text("worktree_path").notNull(),
		branch: text().notNull(),
		headSha: text("head_sha"),
		upstreamOwner: text("upstream_owner"),
		upstreamRepo: text("upstream_repo"),
		upstreamBranch: text("upstream_branch"),
		pullRequestId: text("pull_request_id").references(() => pullRequests.id, {
			onDelete: "set null",
		}),
		// Set when the user removes the PR link; the refresh sweep must not
		// re-link this specific PR. A different PR on the branch still links.
		suppressedPullRequestId: text("suppressed_pull_request_id").references(
			() => pullRequests.id,
			{ onDelete: "set null" },
		),
		// Empty string means "not yet backfilled from cloud" — the startup
		// backfill sweep targets these rows.
		name: text().notNull().default(""),
		type: text()
			.$type<"main" | "worktree" | "session">()
			.notNull()
			.default("worktree"),
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
		// Tombstone: null = live. Set at the destroy commit point; rows are
		// kept forever and surface on the board's Merged/Deleted columns.
		archivedAt: integer("archived_at"),
		// "merged" when the linked PR was merged at destroy time.
		archiveReason: text("archive_reason").$type<"merged" | "deleted">(),
	},
	(table) => [
		index("workspaces_project_id_idx").on(table.projectId),
		index("workspaces_archived_at_idx").on(table.archivedAt),
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
 * The four terminal attempt outcomes are carried over verbatim from the JSON
 * attempt file and mean exactly what §11.5 says they mean. `claimed` is the
 * pre-write request fence and `closed_not_received` is the status-read tombstone.
 * `unknown` is deliberately
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
	/** Request-id claimed, but no PTY write can have started yet. */
	"claimed",
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
 * awaits evaluating guards and taking a lock, and only then durably wrote any
 * claim. A status read landing in that window saw no record and reported
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
 * coverage I have". Anything that loses continuity must rotate it in the SAME
 * transaction, so a status read carrying the old token is answered with a degrade
 * rather than a negative. In practice nothing does: `answer_attempts` is never
 * pruned, because every row there is a fence and forgetting one un-decides
 * something already announced to a phone. The token therefore changes only when a
 * database is new or its continuity is genuinely lost — see
 * `(LEDGER-KEEP-ATTEMPTS)` in `companion/attempt-ledger.ts`.
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

/**
 * (REPLAY-CACHE-DB) §3.5's replay cache — every `(deviceId, nonce)` the bridge has
 * admitted inside the retention window.
 *
 * WHY IT IS A TABLE. It was an append-only log next to a compaction that wrote a
 * reduced copy and renamed it into place. The append half was sound; the rename was
 * not. `FlushFileBuffers` is documented as flushing the specified FILE, the durable
 * rename option (`MOVEFILE_WRITE_THROUGH`) is one libuv never passes, and this fork
 * ships only on Windows — so a hard reset could discard the compaction rename and
 * leave the name resolving to the PRE-compaction inode. The old inode is a superset
 * of the admitted nonces only at the instant of compaction, never afterwards, so
 * every nonce admitted since was silently forgotten and a captured sealed request
 * could be admitted a second time. `/v1/answer` survives that (its requestId is
 * fenced by `answer_attempts`), but `/v1/message` keeps its idempotency in memory,
 * so a replay across a restart could retype into a terminal.
 *
 * WHY DELETION IS FINE HERE, unlike `answer_attempts`. A nonce older than the
 * retention is already outside §3.5's freshness window, so a request bearing it is
 * refused on its timestamp whether or not this table remembers it. Forgetting an
 * expired row costs nothing, which is exactly what is NOT true of an attempt row.
 *
 * WHY `key` AND NOT A COMPOSITE PRIMARY KEY. Admission is one statement —
 * `INSERT .. ON CONFLICT DO NOTHING` — and `changes === 1` IS the decision. A single
 * text key makes that one index probe and keeps the value identical to the
 * in-memory map's key, so the two can never disagree about what "the same nonce"
 * means. `device_id` and `nonce` are kept as their own columns for retention
 * queries and for reading the table by hand during an incident.
 */
export const companionReplayNonces = sqliteTable("companion_replay_nonces", {
	/** `base64url(deviceId).base64url(nonce)` — the same key the live map uses. */
	key: text().primaryKey(),
	deviceId: text("device_id").notNull(),
	nonce: text().notNull(),
	/**
	 * The wall clock this nonce was admitted against. NOT the age this process
	 * trusts: a record admitted by the live process is aged on the monotonic clock
	 * so that moving the wall clock cannot expire it. This is the only reference a
	 * REHYDRATED row has, which is why insertion order below also protects the
	 * newest rows regardless of what their timestamps claim.
	 */
	seenAtMs: integer("seen_at_ms").notNull(),
	/**
	 * Insertion sequence. Retention is `age AND order`, never age alone — the newest
	 * `REPLAY_MIN_RETAINED_ENTRIES` rows survive whatever the clock says, which is
	 * what keeps a clock jump in either direction from emptying the cache and
	 * silently reopening the replay window.
	 */
	ord: integer().notNull(),
});

/**
 * (DEVICE-INDEX-DB) §5's paired devices — the record that decides whether a device
 * may act at all.
 *
 * WHY IT IS A TABLE. It was `devices.json`, written durably (tmp -> fsync -> rename
 * -> fsync parent). Content durability was never the problem; the RENAME was. On
 * NTFS the parent fsync is not documented to publish a directory entry, and the
 * durable-rename primitive is one libuv never passes, so a hard reset could revert
 * the index to its previous version. That mattered because revocation deliberately
 * RETAINS key material (§5.1 needs a revoked device to receive a sealed
 * `403 access_denied {reason:"revoked"}`, which it cannot decrypt without its key):
 * an index reverted past a revocation makes a revoked device's terminal writes
 * valid again.
 *
 * Two defences already narrowed that — a tombstone stamped inside the key file, and
 * the anchor binding `(seq, digest, epoch, generation)` — so a revocation survived
 * unless the key, index AND anchor renames were ALL lost together. Narrow is not the
 * same as closed, and a committed row cannot revert at all.
 *
 * The tombstone in the key file STAYS. It is independent evidence written to a file
 * this table does not control, and it is what makes the answer to "restore an older
 * copy of X" not depend on which single X was restored.
 *
 * WHAT IS NOT HERE. Capabilities: §6.3 says a client must not carry them across a
 * restart, so they live in memory and persisting them would make a stale grant
 * survive exactly the restart meant to invalidate it. Key material: it stays in its
 * own per-device file under the devices directory, because the tombstone above has
 * to be somewhere this table is not.
 */
export const companionDevices = sqliteTable("companion_devices", {
	deviceId: text("device_id").primaryKey(),
	label: text().notNull(),
	/** `phone` or `watch`. The watch never pairs; it is recorded for provenance. */
	surface: text().notNull(),
	pairedAtMs: integer("paired_at_ms").notNull(),
	/**
	 * Excluded from the authority digest, and that exclusion is load-bearing:
	 * `touchLastSeen` runs on EVERY sealed request, so attesting this would force a
	 * durable anchor round-trip per request for no authority benefit.
	 */
	lastSeenMs: integer("last_seen_ms"),
	/** Names the key file. 22 chars of base64url, so it cannot collide. */
	keyRef: text("key_ref").notNull(),
	fcmToken: text("fcm_token"),
	/** Excluded from the digest for the same churn reason as `lastSeenMs`. */
	fcmTokenUpdatedMs: integer("fcm_token_updated_ms"),
	writeEnabled: integer("write_enabled", { mode: "boolean" }).notNull(),
	revokedAtMs: integer("revoked_at_ms"),
	/** Always set together with `revokedAtMs`; the loader refuses them out of step. */
	revokeReason: text("revoke_reason"),
});

/**
 * (DEVICE-INDEX-DB) The header that binds the device table to the state anchor.
 *
 * `(generation, epoch, seq)` is what `assertNoRollback` compares. It is a separate
 * single-row table rather than columns on every device row because it describes the
 * INDEX as a whole: one authority sequence, one install generation, one mount epoch,
 * whatever number of devices happen to exist — including zero, which is a state the
 * binding still has to be able to express.
 */
export const companionDeviceIndex = sqliteTable("companion_device_index", {
	id: integer().primaryKey().default(1),
	/** The install that wrote it. A mismatch means the anchor was replaced. */
	generation: text().notNull(),
	/** The mount epoch, as a decimal string — it is a uint64 and exceeds `number`. */
	epoch: text().notNull(),
	/** The authority sequence, decimal string for the same reason. Never lowered. */
	seq: text().notNull(),
});

/**
 * (PUSH-PRESENCE) The armed/sent fence for the companion push scheduler.
 *
 * WHY IT IS PERSISTED AT ALL. It was in-memory, and the reasoning was that a
 * host-service restart also drops the question store, so questions get
 * re-captured from the hook path and re-armed from zero. That reasoning was
 * sound only while every push was DELAYED: re-arming a three-minute timer costs
 * three minutes. Presence-gating changed both halves of it.
 *
 *   - A HELD question is held with no deadline. Losing the armed entry loses the
 *     push entirely unless the hook happens to fire again, which for a question
 *     that was captured once and is still sitting unanswered it will not. The
 *     user's phone then never buzzes for a question nobody is looking at — the
 *     exact failure the feature exists to prevent.
 *   - A SENT question is worse. Without the sent record a re-capture re-arms,
 *     presence says away, and it fires AGAIN. The 30-80 questions a day this
 *     handles would each buzz once per host-service restart.
 *
 * So both states are rows. `state` is the fence: `armed` may still fire, `sent`
 * may never fire again and is the precondition for a retraction carrying the
 * workspaceId the original push actually used.
 *
 * WHY DELETION IS FINE HERE, unlike `answer_attempts`. A row here decides
 * whether a NOTIFICATION goes out, not whether an answer was typed. A forgotten
 * armed row costs one missed buzz for a question that has already outlived
 * `PUSH_QUESTION_EXPIRY_MS`; a forgotten sent row costs one retraction that
 * silently no-ops. Neither can corrupt an agent session, which is what makes an
 * attempt row unforgettable.
 */
export const companionPushFence = sqliteTable("companion_push_fence", {
	/** §0.1 canonical wire id. One row per question, ever. */
	questionId: text("question_id").primaryKey(),
	/**
	 * The workspace handle the push carries. Stored rather than re-derived at
	 * retraction time: the client matches the notification it is holding by this
	 * value, so it must be the one the ORIGINAL push went out with.
	 */
	workspaceId: text("workspace_id").notNull(),
	questionCount: integer("question_count").notNull(),
	/** Wall clock past which buzzing is pure noise; the client discards it unopened. */
	expiresAtMs: integer("expires_at_ms").notNull(),
	armedAtMs: integer("armed_at_ms").notNull(),
	/** `armed` (may still fire) or `sent` (never again; retractable). */
	state: text().notNull(),
	/** Null while `armed`. Set in the same write that moves the row to `sent`. */
	sentAtMs: integer("sent_at_ms"),
	/**
	 * (PUSH-ARMED-ORPHAN) The four columns below are what a HELD push needs after
	 * a restart, and they exist because reconstruction was inert without them.
	 *
	 * The fence is durable and rebuilt `armed` correctly; `QuestionStore` is
	 * memory-only and comes back EMPTY. So the fire-time re-check asked the store
	 * about every reconstructed row, was told the question does not exist, and
	 * discarded it — on the first away sweep, before it could ever buzz. Every
	 * push held across a host-service restart was lost, which is precisely the
	 * failure the durable fence was added to prevent.
	 *
	 * Firing needs none of the question's TEXT (the FCM payload is opaque ids),
	 * so this is the identity a reconstructed row needs to be judged rather than
	 * dropped: `hostTerminalId`/`hostWorkspaceId` say what it is about, and
	 * `transcriptPath`/`toolUseId` are the pair `findToolResultInTranscript`
	 * needs to ask the agent's own transcript whether the question was answered
	 * while the host-service was down.
	 *
	 * ALL FOUR ARE NULLABLE, and that is a statement rather than a convenience: a
	 * row armed by an older build carries none of them, and a question whose
	 * transcript host.db could not derive carries no path. Absent means "cannot
	 * check", which is NOT "resolved" — such a row stays armed and fires. A stale
	 * buzz self-corrects when the user taps it; a lost buzz never does.
	 */
	hostTerminalId: text("host_terminal_id"),
	hostWorkspaceId: text("host_workspace_id"),
	transcriptPath: text("transcript_path"),
	toolUseId: text("tool_use_id"),
});

/**
 * (SIDEBAR-MIRROR) The desktop sidebar's CURATION, projected into host.db.
 *
 * WHY IT EXISTS. `host.db` is a lifecycle-free append store: every project,
 * workspace and terminal session this machine has ever created, with no column
 * for any of the judgements the user makes about them. Sidebar membership,
 * project placement, soft-delete, archive, snooze, complete, hide, pin and
 * manual order all live in renderer `localStorage` collections
 * (`v2WorkspaceLocalState`, `v2SidebarProjects`), and nothing outside the
 * renderer process can read them. Anything that wants to show "the user's
 * sidebar" from outside the renderer — the companion bridge is the first such
 * consumer — is therefore reading a structurally different, strictly larger set
 * than the one on screen: 183 workspace rows where the sidebar shows a curated
 * handful, soft-deleted and archived threads rendering as ordinary live rows.
 *
 * WHAT THIS IS AND IS NOT. The renderer stays the SOURCE OF TRUTH. These tables
 * are a PROJECTION of it, refreshed by a debounced full-state replace from the
 * renderer (`sidebarMirror.sync`), which is what makes them self-healing: any
 * curation change, from any entry point, re-derives the whole snapshot rather
 * than emitting a delta that could be missed. Nothing here is ever written by
 * the host-service itself, and nothing here may be treated as authoritative if
 * it disagrees with the renderer.
 *
 * THE FAILURE DIRECTION IS FIXED, AND ABSENCE IS NOT STALENESS. A mirror can be
 * stale (renderer not running, a sync in flight, a host-service restart between
 * syncs), and the two cases are NOT equally safe:
 *
 *  - ABSENT row = "no opinion recorded" -> SHOW. Every consumer must fail this
 *    way: `LEFT JOIN` with null-tolerant predicates, never `INNER`. A consumer
 *    that hides on absence turns a transient miss into a blocked agent the user
 *    never sees.
 *  - STALE row = the user's LAST RECORDED opinion, which is safe only because
 *    of what the writer guarantees, not because staleness is harmless. A row
 *    still carrying `deleted_at` / `archived_at` / `is_hidden` / `snooze_until`
 *    from before the user restored the thread HIDES something that is no longer
 *    hidden — the forbidden direction. What bounds it lives in the renderer
 *    (`useSidebarMirrorSync`): exactly one push in flight, so a reordered pair
 *    cannot leave an older snapshot installed, and a retry that never gives up
 *    while the app runs, so a failed push cannot become a permanent state. With
 *    the renderer gone the mirror holds the last curation the user actually
 *    made; it never invents one.
 *
 * THERE IS A HEARTBEAT, and `last_full_sync_at_ms` therefore means "a renderer
 * was alive at this moment", not "somebody last dragged a thread". The writer
 * re-pushes the unchanged snapshot every five minutes (`(MIRROR-HEARTBEAT)` in
 * `useSidebarMirrorSync`), which is what makes a hard freshness bound possible
 * at all: `(MIRROR-AGE-OUT)` refuses a mirror older than four of those beats,
 * because past that the timestamp is positive evidence that NO renderer is
 * running and every hiding field in these tables is an opinion from a session
 * that has ended. Ageing out means falling back to SHOWING everything — the
 * uncurated firehose, and the safe direction.
 *
 * This paragraph used to say the opposite ("there is NO heartbeat ... it needs a
 * heartbeat writer first"). It was written before the writer existed and was
 * left behind by the commits that added it; a consumer that believed it would
 * decline to age out a mirror abandoned by a quit desktop.
 */
export const sidebarWorkspaceState = sqliteTable(
	"sidebar_workspace_state",
	{
		/** `v2WorkspaceLocalState` is keyed on this; so is `workspaces.id`. */
		workspaceId: text("workspace_id").primaryKey(),
		/**
		 * The project the row is PLACED under in the sidebar, which is the
		 * renderer's own `sidebarState.projectId` — deliberately not re-derived
		 * from `workspaces.project_id`, because placement is a curation act and
		 * this table records curation.
		 */
		projectId: text("project_id").notNull(),
		/** Optional user-made section within the project. Null = ungrouped. */
		sectionId: text("section_id"),
		/** Manual drag order within its project/section. */
		tabOrder: integer("tab_order").notNull().default(0),
		/**
		 * Removed from the sidebar. NOT the same as archived: the renderer's
		 * classifier treats a hidden NON-main workspace as archived and a hidden
		 * `main` workspace as merely hidden, so a consumer needs
		 * `workspaces.type` to reproduce it. Mirrored raw for that reason.
		 */
		isHidden: integer("is_hidden", { mode: "boolean" })
			.notNull()
			.default(false),
		archivedAt: integer("archived_at"),
		/** Absolute epoch-ms deadline for a timed snooze. */
		snoozeUntil: integer("snooze_until"),
		/**
		 * An "until next launch" snooze stores the renderer's per-launch id here.
		 * It is only still snoozed while this equals the CURRENT launch id, which
		 * is why `sidebar_mirror_meta.app_launch_id` exists — without it the
		 * predicate is unevaluable outside the renderer.
		 */
		snoozeLaunchId: text("snooze_launch_id"),
		completedAt: integer("completed_at"),
		/** (RECYCLE-BIN) soft-delete. Set = the bin is its only surface. */
		deletedAt: integer("deleted_at"),
		pinnedAt: integer("pinned_at"),
		/** When this row was last written by a sync. Freshness, not curation. */
		syncedAtMs: integer("synced_at_ms").notNull(),
	},
	(table) => [
		index("sidebar_workspace_state_project_id_idx").on(table.projectId),
	],
);

/**
 * (SIDEBAR-MIRROR) The project half — `v2SidebarProjects`, which is the
 * desktop's membership gate for repos. A host project with no row here is not
 * in the sidebar at all, however many workspaces it owns.
 *
 * Same staleness rule as above, with one extra trap: this collection is
 * DEVICE-LOCAL localStorage, so a fresh install or cleared storage legitimately
 * has zero rows. A consumer must distinguish "mirror never filled" (fall back
 * to showing everything) from "user curated it down to nothing" — that is what
 * `sidebar_mirror_meta` answers, and why an empty table alone must never be
 * read as "hide every project".
 */
export const sidebarProjectState = sqliteTable("sidebar_project_state", {
	/** `projects.id` — the sidebar row is keyed on the same project key. */
	projectId: text("project_id").primaryKey(),
	/** Manual drag order among sidebar projects. */
	tabOrder: integer("tab_order").notNull().default(0),
	isPinned: integer("is_pinned", { mode: "boolean" }).notNull().default(false),
	isCollapsed: integer("is_collapsed", { mode: "boolean" })
		.notNull()
		.default(false),
	syncedAtMs: integer("synced_at_ms").notNull(),
});

/**
 * (SIDEBAR-MIRROR) One row describing the mirror ITSELF, so a consumer can tell
 * an unfilled mirror from a curated-empty one and a live launch-scoped snooze
 * from an expired one.
 *
 * ABSENCE OF THIS ROW IS THE BOOTSTRAP SIGNAL. No row = the renderer has never
 * synced against this database, so the two tables above carry no information
 * and every consumer must pass everything through. With a row present, an empty
 * `sidebar_project_state` is a real statement: the user's sidebar is empty.
 *
 * `app_launch_id` is the renderer's current per-launch id at sync time. It is
 * the only way to evaluate an "until next launch" snooze from outside the
 * renderer: a workspace is launch-snoozed iff its `snooze_launch_id` equals
 * this value.
 */
export const sidebarMirrorMeta = sqliteTable("sidebar_mirror_meta", {
	/** Always 1. Single row; the mirror describes itself once. */
	id: integer().primaryKey().default(1),
	/** Wall clock of the last completed full replace. */
	lastFullSyncAtMs: integer("last_full_sync_at_ms").notNull(),
	/** The renderer launch that wrote it. See the snooze note above. */
	appLaunchId: text("app_launch_id").notNull(),
	/**
	 * The org whose renderer collections this snapshot came from. `host.db` is
	 * already per-organization, so a mismatch means the mirror and the database
	 * disagree about whose data they hold — a consumer should refuse the mirror
	 * (pass everything through) rather than filter on it.
	 */
	organizationId: text("organization_id").notNull(),
	/** Row counts as written. Lets a reader spot a half-applied snapshot. */
	workspaceCount: integer("workspace_count").notNull(),
	projectCount: integer("project_count").notNull(),
	/**
	 * (MIRROR-CHANGE-GSEQ) A hash of the CONTENT this row describes, so the
	 * writer can tell a curation change from the five-minute heartbeat re-push
	 * of an identical snapshot.
	 *
	 * It exists because the two need opposite treatment. A sync that CHANGED the
	 * mirror has to move the companion event sequence, or the phone's heartbeat
	 * keeps reporting `treeStale: false` and blesses stale pins and membership as
	 * fresh indefinitely — the mirror was the one input to `/v1/tree` that could
	 * change without any event being minted. An UNCHANGED heartbeat re-push must
	 * not move it, or every five-minute beat invalidates every client's cache.
	 *
	 * Nullable: a row written before this column existed has no hash, and the
	 * first sync after that is treated as a change. One spurious refetch on
	 * upgrade is the right side of that trade.
	 */
	contentHash: text("content_hash"),
});
