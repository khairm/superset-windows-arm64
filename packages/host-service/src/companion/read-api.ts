/**
 * (COMPANION-BRIDGE) — read endpoints: hello, tree, transcript, question,
 * heartbeat (§6.2, §7.2, §7.3, §7.4, §7.7).
 *
 * Reads mutate nothing and are therefore safe to retry. Note the naming
 * inversion this module has to live with: in CODE a *project* is the repo row in
 * the sidebar and a *workspace* is a branch/worktree; the user says these the
 * other way round. The protocol uses the CODE names and the client presents the
 * user's labels.
 *
 * Transcript text is sent VERBATIM. The bridge does not scrub secrets — a
 * partial scrub would be a false assurance. The confidentiality control is the
 * sealed envelope, not filtering.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MODULE REFUSES TO INVENT
 * ---------------------------------------------------------------------------
 *  - There is no `green` / "ready for review" status and there never will be.
 *    The review axis lives in renderer storage the bridge cannot reach.
 *    `needs_input` (red), `working` (yellow) and `idle` (neutral) are the whole
 *    vocabulary; a fourth state synthesised from coarse data would be a lie.
 *  - No status decay ON A LIVE TERMINAL. A binding whose last event was `Start`
 *    three days ago is reported as `working`, because that is what the host
 *    actually recorded. Inventing a timeout would manufacture a state
 *    transition that never happened. (`TerminalAgentStore.clearWorkspaceStatuses`
 *    is the existing escape hatch for a wedged agent, and it runs on the host
 *    side.) This says NOTHING about a terminal that no longer exists — see
 *    `(BRIDGE-LIVENESS)` below, which is not decay but existence.
 *  - No guessed transcript when the agent session is unknown: the read fails
 *    loud rather than serving somebody else's conversation.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MODULE FILTERS, AND IN WHICH DIRECTION IT FAILS
 * ---------------------------------------------------------------------------
 * Two filters stand between `host.db` and the phone, and they are independent:
 *
 *  - `(BRIDGE-SIDEBAR-FILTER)` — CURATION. The user's sidebar, projected into
 *    `host.db` by `(SIDEBAR-MIRROR)`: soft-deleted, completed, archived,
 *    snoozed and hidden threads are off the desktop's default sidebar and are
 *    therefore off the phone, and a repo the user removed from their sidebar
 *    takes its threads with it.
 *  - `(BRIDGE-LIVENESS)` — EXISTENCE. `status = 'active'` is not liveness; the
 *    daemon's own listing is. 403 rows on this machine matched the old
 *    predicate, 8 of them frozen on `PermissionRequest` and badging the phone
 *    with permanently-blocked agents that had not existed for weeks.
 *
 * BOTH FAIL TOWARD SHOWING. Uncertainty — an unfilled mirror, a workspace with
 * no mirrored row, an unreachable daemon, a stale snapshot — always renders the
 * row. Hiding a real blocked agent is the only failure this feature cannot
 * absorb. The answer path's guards fail the OTHER way (toward refusing) and
 * deliberately do not consult curation at all: a question captured before its
 * thread was snoozed is still answerable.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { MULTI_REPO_ANCHORS_DIR } from "../runtime/git/multi-repo";
import { NON_GIT_BRANCH } from "../runtime/git/non-git";
import { agentKindFromAgentId } from "./agent-kind";
import type { AttemptLedger } from "./attempt-ledger";
import {
	BRIDGE_CAPABILITIES,
	BRIDGE_PROTOCOL_RANGE,
	HEARTBEAT_INTERVAL_BACKGROUND_MS,
	HEARTBEAT_INTERVAL_FOREGROUND_MS,
	LIMITS,
	SESSION_TTL_MS,
} from "./config";
import { isCanonicalWireId } from "./crypto";
import { WIRE_ID_CHARS } from "./limits";
import type { TerminalLiveness } from "./liveness";
import { errorClassName, logSafely } from "./log-privacy";
import {
	type AnswerabilityContext,
	deriveHandle,
	type PendingQuestion,
	type QuestionSourceResolver,
	type QuestionStore,
	readTranscriptWindow,
} from "./question-store";
import {
	isSessionsProjectId,
	placementProjectId,
	SESSIONS_PROJECT_ID,
	SESSIONS_PROJECT_NAME,
} from "./session-project";
import {
	createSidebarCuration,
	type SidebarCuration,
	type SidebarMirrorMetaRow,
	type SidebarMirrorSnapshot,
	type SidebarProjectMirrorRow,
	type SidebarWorkspaceMirrorRow,
} from "./sidebar-filter";
import {
	type AgentKind,
	type AgentStatus,
	type Capability,
	type ChatPlace,
	type EpochMs,
	type HeartbeatRequest,
	type HeartbeatResponse,
	type HelloRequest,
	type HelloResponse,
	type PendingQuestionRef,
	type PingResponse,
	type Project,
	type ProjectId,
	type ProjectKind,
	type ProtocolVersion,
	type QuestionId,
	type QuestionRequest,
	type QuestionResponse,
	SealedError,
	type SealedRequestContext,
	type StatusCounts,
	type Terminal,
	type TerminalId,
	type TranscriptRequest,
	type TranscriptResponse,
	type TreeRequest,
	type TreeResponse,
	type Workspace,
	type WorkspaceId,
} from "./types";

// ---------------------------------------------------------------------------
// host.db — READ-ONLY, and never `immutable=1`
// ---------------------------------------------------------------------------

export interface HostProjectRow {
	id: string;
	name: string;
	repoPath: string;
	worktreeBaseDir: string | null;
}

export interface HostWorkspaceRow {
	id: string;
	/**
	 * (SESSIONS-PROJECT) NULLABLE, because `workspaces.project_id` is: a session
	 * workspace (`type = "session"`, its worktree under `~/.superset/sessions`)
	 * has no repo. `placementProjectId` maps that NULL onto the synthetic
	 * Sessions group; nothing else in this module may invent a project for it.
	 */
	projectId: string | null;
	name: string;
	branch: string;
	worktreePath: string;
	type: string;
	createdAt: number;
}

export interface HostTerminalRow {
	id: string;
	originWorkspaceId: string | null;
	status: string;
	createdAt: number;
	lastAttachedAt: number | null;
	endedAt: number | null;
}

/** What `QuestionSourceResolver` answers with — the rows that own a terminal. */
export interface TerminalSource {
	hostProjectId: string;
	hostWorkspaceId: string;
	/** `terminal_agent_bindings.agent_id`, or null when the terminal is unbound. */
	agentId: string | null;
}

export interface HostBindingRow {
	terminalId: string;
	workspaceId: string;
	agentId: string;
	agentSessionId: string | null;
	definitionId: string | null;
	startedAt: number;
	lastEventAt: number;
	lastEventType: string;
}

export interface HostDbReader extends QuestionSourceResolver {
	listProjects(): HostProjectRow[];
	listWorkspaces(): HostWorkspaceRow[];
	/**
	 * Rows whose `status = 'active' AND ended_at IS NULL`. That is a DB fact, not
	 * a liveness claim — see `(BRIDGE-LIVENESS)`. Every caller that means "this
	 * terminal exists" goes through `listLiveTerminals` instead.
	 */
	listActiveTerminals(): HostTerminalRow[];
	listBindings(): HostBindingRow[];
	findWorkspace(hostWorkspaceId: string): HostWorkspaceRow | null;
	/**
	 * (ALERT-CONTEXT-NAMES) One project by id, for the alert path's per-send
	 * name lookup. `listProjects` remains the tree's bulk read.
	 */
	findProject(projectId: string): HostProjectRow | null;
	/**
	 * (ALERT-CONTEXT-NAMES) Every terminal id host.db places in one workspace.
	 *
	 * One statement for a whole snapshot's relationship check, rather than a
	 * point lookup per terminal: the renderer syncs a workspace's entire tab
	 * context at once, so the per-terminal form ran N queries to answer one
	 * question about one workspace.
	 */
	listTerminalIdsForWorkspace(hostWorkspaceId: string): string[];
	findBinding(hostTerminalId: string): HostBindingRow | null;
	findTerminal(hostTerminalId: string): HostTerminalRow | null;
	/** (BRIDGE-SIDEBAR-FILTER) The renderer's curation as last mirrored. */
	readSidebarMirror(): SidebarMirrorSnapshot;
	close(): void;
}

/**
 * (SESSIONS-PROJECT) One row of the terminal → workspace → project join, with
 * the NULL project mapped onto the synthetic Sessions group.
 *
 * The join itself already SUCCEEDS for a session: `origin_workspace_id` names a
 * real `workspaces` row (that is what makes attach, adoption and the answer
 * path work on a session at all). What it hands back is `project_id = NULL`,
 * and the consumer of this — `resolveSource`, which every `/v1/question` build
 * and therefore every phone/watch ANSWER goes through — mints
 * `deriveHandle("project", hostProjectId)` from it. A NULL there is not a
 * missing row it can report; it is a crash on the answer path for a question
 * the bridge captured perfectly well.
 *
 * Exported for the tests that pin exactly that: a session question resolves to
 * a real workspace id (never invented) under the synthetic project id.
 */
export function toTerminalSource(row: unknown): TerminalSource | null {
	if (row === undefined || row === null) return null;
	const source = row as {
		hostProjectId: string | null;
		hostWorkspaceId: string;
		agentId: string | null;
	};
	return {
		// The workspace id is passed through UNTOUCHED: it is the id adoption,
		// the terminal lock and the pty write all key on, and inventing one would
		// break every one of them.
		hostWorkspaceId: source.hostWorkspaceId,
		hostProjectId: placementProjectId(source.hostProjectId),
		agentId: source.agentId,
	};
}

/**
 * Open host.db read-only.
 *
 * `readonly: true` maps to SQLite's `mode=ro`. `immutable=1` is FORBIDDEN and
 * is not a tuning option: it tells SQLite the file cannot change, so the
 * connection pins the snapshot it first saw. Measured consequence — the reader
 * froze at stale data for a full 45 s poll, which would ship a phone that
 * silently never updates. WAL readers see committed writes as long as each
 * statement runs in its own implicit transaction, which is exactly what the
 * one-shot `.all()` calls below do; nothing here holds a read transaction open.
 *
 * Fails loud if the file is missing: a bridge that silently serves an empty
 * tree is worse than one that reports itself unavailable.
 */
export function openHostDbReadOnly(dbPath: string): HostDbReader {
	const db = new Database(dbPath, { readonly: true, fileMustExist: true });
	db.pragma("busy_timeout = 5000");

	const projectsStmt = db.prepare(
		"SELECT id, name, repo_path AS repoPath, worktree_base_dir AS worktreeBaseDir FROM projects",
	);
	/**
	 * (ALERT-CONTEXT-NAMES) One project by id. The alert path needs exactly one
	 * name per send and was scanning the whole `listProjects()` result to find
	 * it, which is a full table read plus a linear search on a path that runs
	 * per notification and per retry.
	 */
	const projectByIdStmt = db.prepare(
		"SELECT id, name, repo_path AS repoPath, worktree_base_dir AS worktreeBaseDir FROM projects WHERE id = ?",
	);
	/**
	 * (ALERT-CONTEXT-NAMES) Terminal ids of one workspace. Deliberately NOT
	 * restricted to `status = 'active'`: the caller is validating a renderer's
	 * claim about where a terminal LIVES, and a pane the user still has open on
	 * a terminal the daemon has since ended is exactly the case whose tab title
	 * must keep working.
	 */
	const terminalIdsByWorkspaceStmt = db.prepare(
		"SELECT id FROM terminal_sessions WHERE origin_workspace_id = ?",
	);
	const workspacesStmt = db.prepare(
		"SELECT id, project_id AS projectId, name, branch, worktree_path AS worktreePath, type, created_at AS createdAt FROM workspaces",
	);
	const workspaceByIdStmt = db.prepare(
		"SELECT id, project_id AS projectId, name, branch, worktree_path AS worktreePath, type, created_at AS createdAt FROM workspaces WHERE id = ?",
	);
	const terminalsStmt = db.prepare(
		"SELECT id, origin_workspace_id AS originWorkspaceId, status, created_at AS createdAt, last_attached_at AS lastAttachedAt, ended_at AS endedAt FROM terminal_sessions WHERE status = 'active' AND ended_at IS NULL",
	);
	const terminalByIdStmt = db.prepare(
		"SELECT id, origin_workspace_id AS originWorkspaceId, status, created_at AS createdAt, last_attached_at AS lastAttachedAt, ended_at AS endedAt FROM terminal_sessions WHERE id = ?",
	);
	const bindingsStmt = db.prepare(
		"SELECT terminal_id AS terminalId, workspace_id AS workspaceId, agent_id AS agentId, agent_session_id AS agentSessionId, definition_id AS definitionId, started_at AS startedAt, last_event_at AS lastEventAt, last_event_type AS lastEventType FROM terminal_agent_bindings",
	);
	const bindingByTerminalStmt = db.prepare(
		"SELECT terminal_id AS terminalId, workspace_id AS workspaceId, agent_id AS agentId, agent_session_id AS agentSessionId, definition_id AS definitionId, started_at AS startedAt, last_event_at AS lastEventAt, last_event_type AS lastEventType FROM terminal_agent_bindings WHERE terminal_id = ?",
	);
	const terminalSourceStmt = db.prepare(
		"SELECT w.id AS hostWorkspaceId, w.project_id AS hostProjectId, b.agent_id AS agentId FROM terminal_sessions t JOIN workspaces w ON w.id = t.origin_workspace_id LEFT JOIN terminal_agent_bindings b ON b.terminal_id = t.id WHERE t.id = ?",
	);
	// (CAPTURE-BOUNDED) The SAME join, plus the session predicate, as a SEPARATE
	// statement. It is not a tightening of the one above, deliberately: that one
	// also serves `/v1/question` for SETTLED records, and a phone reopening the
	// question it just answered on a terminal it has since closed must get its
	// record back, not a 500. Two callers, two questions, two statements.
	const activeTerminalSourceStmt = db.prepare(
		"SELECT w.id AS hostWorkspaceId, w.project_id AS hostProjectId, b.agent_id AS agentId FROM terminal_sessions t JOIN workspaces w ON w.id = t.origin_workspace_id LEFT JOIN terminal_agent_bindings b ON b.terminal_id = t.id WHERE t.id = ? AND t.status = 'active' AND t.ended_at IS NULL",
	);
	// (BRIDGE-SIDEBAR-FILTER) The mirror. `sidebar_mirror_meta` is read FIRST
	// and its absence short-circuits the other two: with nothing ever synced,
	// their emptiness carries no information and reading them would invite a
	// consumer to treat "no rows" as "nothing is in the sidebar".
	const sidebarMetaStmt = db.prepare(
		"SELECT last_full_sync_at_ms AS lastFullSyncAtMs, app_launch_id AS appLaunchId, organization_id AS organizationId, workspace_count AS workspaceCount, project_count AS projectCount FROM sidebar_mirror_meta WHERE id = 1",
	);
	const sidebarWorkspacesStmt = db.prepare(
		"SELECT workspace_id AS workspaceId, project_id AS projectId, is_hidden AS isHidden, archived_at AS archivedAt, snooze_until AS snoozeUntil, snooze_launch_id AS snoozeLaunchId, completed_at AS completedAt, deleted_at AS deletedAt, pinned_at AS pinnedAt, tab_order AS tabOrder FROM sidebar_workspace_state",
	);
	const sidebarProjectsStmt = db.prepare(
		"SELECT project_id AS projectId, tab_order AS tabOrder, is_pinned AS isPinned, is_collapsed AS isCollapsed FROM sidebar_project_state",
	);

	const reader: HostDbReader = {
		listProjects: () => projectsStmt.all() as HostProjectRow[],
		listWorkspaces: () => workspacesStmt.all() as HostWorkspaceRow[],
		listActiveTerminals: () => terminalsStmt.all() as HostTerminalRow[],
		listBindings: () => bindingsStmt.all() as HostBindingRow[],
		findWorkspace: (id) =>
			(workspaceByIdStmt.get(id) as HostWorkspaceRow | undefined) ?? null,
		findProject: (id) =>
			(projectByIdStmt.get(id) as HostProjectRow | undefined) ?? null,
		listTerminalIdsForWorkspace: (hostWorkspaceId) =>
			(terminalIdsByWorkspaceStmt.all(hostWorkspaceId) as { id: string }[]).map(
				(row) => row.id,
			),
		findTerminal: (id) =>
			(terminalByIdStmt.get(id) as HostTerminalRow | undefined) ?? null,
		findBinding: (id) =>
			(bindingByTerminalStmt.get(id) as HostBindingRow | undefined) ?? null,
		resolveTerminal: (id) => toTerminalSource(terminalSourceStmt.get(id)),
		resolveActiveTerminal: (id) =>
			toTerminalSource(activeTerminalSourceStmt.get(id)),
		// (QUESTION-EXPIRY) The row's newest known instant, for the liveness
		// activity grace. Deliberately the UNRESTRICTED row lookup: the terminal
		// this has to rescue is the one created seconds ago, which the daemon
		// listing may predate.
		resolveTerminalActivityMs: (id) => {
			const row = reader.findTerminal(id);
			if (row === null) return null;
			return row.lastAttachedAt ?? row.createdAt;
		},
		readSidebarMirror: () => {
			const meta =
				(sidebarMetaStmt.get() as SidebarMirrorMetaRow | undefined) ?? null;
			if (meta === null) {
				return { meta: null, workspaces: [], projects: [] };
			}
			return {
				meta,
				workspaces: sidebarWorkspacesStmt.all() as SidebarWorkspaceMirrorRow[],
				projects: sidebarProjectsStmt.all() as SidebarProjectMirrorRow[],
			};
		},
		// (TRANSCRIPT-PATH-DERIVED) The question store's guard-1 source. Same
		// derivation `/v1/transcript` uses, from the same two host.db columns, so
		// the two can never disagree about which file is this agent's transcript.
		resolveTranscriptPath: (id) => {
			const binding = reader.findBinding(id);
			if (binding === null) return null;
			if (
				binding.agentSessionId === null ||
				binding.agentSessionId.length === 0
			) {
				return null;
			}
			if (agentKindFromAgentId(binding.agentId) !== "claude") return null;
			const workspace = reader.findWorkspace(binding.workspaceId);
			if (workspace === null) return null;
			return deriveClaudeTranscriptPath(
				workspace.worktreePath,
				binding.agentSessionId,
			);
		},
		close: () => db.close(),
	};
	return reader;
}

// ---------------------------------------------------------------------------
// dependencies
// ---------------------------------------------------------------------------

export interface ReadDeps {
	db: HostDbReader;
	questions: QuestionStore;
	/**
	 * (BRIDGE-LIVENESS) Does a `terminal_sessions` row still name a pty that
	 * exists? REQUIRED, with no default: a composition root that cannot supply
	 * it is one whose phone would badge every corpse in `host.db` as a live
	 * agent, and that must fail to compile rather than degrade to noise.
	 */
	liveness: TerminalLiveness;
	/**
	 * (MIRROR-ORG-GATE) The org this host-service serves, compared against
	 * `sidebar_mirror_meta.organization_id` before any curation is applied.
	 * REQUIRED, with no default: `host.db` is per machine and the mirror inside
	 * it is per org, so a reader with nothing to compare against silently serves
	 * a previous sign-in's curation — and since ids never collide across orgs,
	 * that hides the entire tree behind "project not in the sidebar".
	 */
	organizationId: string;
	versions: {
		appVersion: string;
		hostServiceVersion: string;
		forkTag: string;
	};
	/** Bridge boot stamp; a change means the client must re-hello (§6.3). */
	bridgeStartedMs: EpochMs;
	/**
	 * (ANSWER-LEDGER) Read so `hello` can hand the client an epoch up front. Only
	 * `currentEpoch` is used here; the read API never writes to the ledger.
	 */
	ledger: Pick<AttemptLedger, "currentEpoch">;
	/** Highest global event sequence emitted so far (§9.3). Owned by `ws.ts`. */
	currentGseq(): number;
	/**
	 * (RECONCILE-RETRACT) Called with the ids `reconcile()` settled — questions
	 * that were dealt with at the desk but whose `PostToolUse` hook never told the
	 * bridge so.
	 *
	 * REQUIRED, and not optional-with-a-no-op default. Settling a question is
	 * exactly the moment any notification about it must be retracted, and the
	 * hook-driven route (`resolve` -> `push.cancelPending`) is the only route that
	 * ever did it. A dead hook — a DOCUMENTED ARM64 failure mode on this machine —
	 * therefore left an already-delivered phone/watch notification standing for a
	 * question that was answered minutes ago; the sender's fire-time re-check
	 * covers only pushes that have not gone out yet, and the client's foreground
	 * sweep was the sole backstop. A composition root that cannot supply this is a
	 * composition root that has no push retraction, and should fail to compile
	 * rather than degrade to silence.
	 */
	onQuestionsSettled(questionIds: QuestionId[]): void;
	/**
	 * Structured diagnostics, mirroring `AnswerDeps.log`. NEVER carries question
	 * text, option labels or transcript content — identities, shapes and
	 * verdicts only. REQUIRED, not optional-with-a-no-op: a silently absent
	 * logger is the observability failure this field exists to close
	 * (2026-08-09: a watch refusal took an hour to diagnose because the read
	 * path recorded nothing about what `answerable` verdict it served).
	 */
	log(event: Record<string, unknown>): void;
	/**
	 * (CHAT-CONTEXT-NAMES) The renderer's TAB title for one terminal, or `""`.
	 *
	 * Nullable but REQUIRED, the house style for a dep a composition root may
	 * genuinely not have: `null` is an explicit "this bridge has no tab-title
	 * registry", stated at the wiring site, while an omitted field would be a
	 * bridge that silently reports every chat as untitled and no one noticing.
	 *
	 * Tab titles live only in the renderer, so this is a lookup into the
	 * `(ALERT-CONTEXT-NAMES)` snapshot registry rather than anything host.db
	 * knows. It is called on the read path with host.db's OWN ids (never wire
	 * handles, never empty — both are primary keys off a row that was read) and
	 * MAY throw; every caller here wraps it.
	 */
	resolveTabTitle:
		| ((hostWorkspaceId: string, hostTerminalId: string) => string)
		| null;
}

/** Convenience binder so a composition root can hand around one object. */
export interface ReadApi {
	handlePing(): PingResponse;
	handleHello(
		ctx: SealedRequestContext,
		request: HelloRequest,
	): Promise<HelloResponse>;
	handleTree(
		ctx: SealedRequestContext,
		request: TreeRequest,
	): Promise<TreeResponse>;
	handleTranscript(
		ctx: SealedRequestContext,
		request: TranscriptRequest,
	): Promise<TranscriptResponse>;
	handleQuestion(
		ctx: SealedRequestContext,
		request: QuestionRequest,
	): Promise<QuestionResponse>;
	handleHeartbeat(
		ctx: SealedRequestContext,
		request: HeartbeatRequest,
	): Promise<HeartbeatResponse>;
}

export function createReadApi(deps: ReadDeps): ReadApi {
	return {
		handlePing: () => handlePing(),
		handleHello: (ctx, request) => handleHello(deps, ctx, request),
		handleTree: (ctx, request) => handleTree(deps, ctx, request),
		handleTranscript: (ctx, request) => handleTranscript(deps, ctx, request),
		handleQuestion: (ctx, request) => handleQuestion(deps, ctx, request),
		handleHeartbeat: (ctx, request) => handleHeartbeat(deps, ctx, request),
	};
}

// ---------------------------------------------------------------------------
// boundary validation (§0: no optional-with-default fields, ever)
// ---------------------------------------------------------------------------

/**
 * The one §0 boundary-refusal shape. Exported because `index.ts` (the
 * composition root, which already imports this module) validates panic bodies
 * with the identical envelope — one definition, so the two boundaries cannot
 * drift into reporting a bad request differently.
 */
export function badRequest(message: string): SealedError {
	return new SealedError(400, {
		code: "bad_request",
		message,
		retryAfterMs: null,
		detail: null,
	});
}

function requireCapability(
	ctx: SealedRequestContext,
	capability: Capability,
): void {
	if (ctx.granted.includes(capability)) return;
	throw new SealedError(501, {
		code: "capability_unsupported",
		message: `capability ${capability} is not granted for this session`,
		retryAfterMs: null,
		detail: { capability },
	});
}

function requireBooleanField(value: unknown, field: string): boolean {
	if (typeof value !== "boolean") {
		throw badRequest(`${field} must be an explicit boolean`);
	}
	return value;
}

function requireHandle(value: unknown, field: string): string {
	// The canonical §0.1 test, not a `/^[A-Za-z0-9_-]{22}$/`: a regex accepts
	// non-canonical 22-character encodings that decode to the same 16 bytes while
	// comparing unequal as strings, which is exactly the map-key hazard
	// `crypto.base64UrlDecode` was made strict to close.
	if (!isCanonicalWireId(value)) {
		throw badRequest(
			`${field} must be a canonical ${WIRE_ID_CHARS}-character base64url handle`,
		);
	}
	return value;
}

// ---------------------------------------------------------------------------
// §7.1 ping
// ---------------------------------------------------------------------------

/** §7.1. FIXED SHAPE — never add a field here, not even "for diagnostics". */
export function handlePing(): PingResponse {
	return {
		bridge: "superset-companion",
		envelope: [1],
		protocol: BRIDGE_PROTOCOL_RANGE,
		serverTimeMs: Date.now(),
	};
}

// ---------------------------------------------------------------------------
// §6.2 hello
// ---------------------------------------------------------------------------

/**
 * §6.2. Negotiation NEVER refuses a connection; it degrades:
 *   lo = max(client.min, bridge.min); hi = min(client.max, bridge.max)
 *   protocol = (lo <= hi) ? hi : 0;  degraded = (lo > hi)
 * The negotiated number is bound into every subsequent AAD, so a downgrade
 * afterwards produces a tag failure rather than a silent reinterpretation.
 */
export async function handleHello(
	deps: ReadDeps,
	_ctx: SealedRequestContext,
	request: HelloRequest,
): Promise<HelloResponse> {
	const clientRange = request.protocol;
	if (
		typeof clientRange !== "object" ||
		clientRange === null ||
		!Number.isInteger(clientRange.min) ||
		!Number.isInteger(clientRange.max) ||
		clientRange.min > clientRange.max
	) {
		throw badRequest("protocol must be an inclusive integer range, min <= max");
	}
	if (!Array.isArray(request.capabilities)) {
		throw badRequest("capabilities must be an array");
	}

	const lo = Math.max(clientRange.min, BRIDGE_PROTOCOL_RANGE.min);
	const hi = Math.min(clientRange.max, BRIDGE_PROTOCOL_RANGE.max);
	const degraded = lo > hi;
	const protocol: ProtocolVersion = degraded ? 0 : hi;

	const asked = new Set<Capability>(request.capabilities);
	// Protocol 0 is the frozen baseline: ping / hello / baseline tree /
	// heartbeat, and NO write path at all. It therefore grants nothing.
	const granted: Capability[] = degraded
		? []
		: BRIDGE_CAPABILITIES.filter((c) => asked.has(c));
	const grantedSet = new Set(granted);
	const unsupported = [...asked].filter((c) => !grantedSet.has(c));
	const extra = BRIDGE_CAPABILITIES.filter((c) => !asked.has(c));

	return {
		protocol,
		degraded,
		bridge: {
			appVersion: deps.versions.appVersion,
			hostServiceVersion: deps.versions.hostServiceVersion,
			forkTag: deps.versions.forkTag,
			protocol: BRIDGE_PROTOCOL_RANGE,
		},
		capabilities: { granted, unsupported, extra },
		limits: LIMITS,
		serverTimeMs: Date.now(),
		sessionTtlMs: SESSION_TTL_MS,
		// (ANSWER-LEDGER) Handed over at hello so the client's FIRST answer can be
		// fenced. Without it that answer captures null and §11.5 permits only
		// `unconfirmed` for it, which on a platform that kills processes routinely
		// would forfeit the terminal negative for a large share of real answers.
		coverageEpoch: deps.ledger.currentEpoch(),
	};
}

// ---------------------------------------------------------------------------
// §7.2 tree
// ---------------------------------------------------------------------------

/**
 * Coarse status, and only coarse status.
 *
 * `lastEventType` in host.db is already normalized by `mapEventType`, so the
 * vocabulary is the eight `AgentLifecycleEventType` members. The mapping onto
 * the protocol's three states:
 *
 *   PermissionRequest              -> needs_input   (red)
 *   Start | SubagentActive         -> working       (yellow)
 *   Stop | Failed | Attached
 *     | BackgroundRunning          -> idle          (neutral)
 *   anything else                  -> unknown
 *
 * `BackgroundRunning` is idle here on purpose: it means the TURN ENDED with a
 * cloud/background task still running. The renderer paints that blue on a
 * separate axis; this protocol has no blue, and calling it `working` would tell
 * the phone an agent is mid-turn when it is not.
 *
 * `Failed` is idle for the same reason — the turn ended. It ended badly, but
 * "needs your input" is a different claim and this protocol cannot express the
 * difference. A phone that showed red for every API failure would cry wolf.
 */
function statusFromEventType(lastEventType: string): AgentStatus {
	switch (lastEventType) {
		case "PermissionRequest":
			return "needs_input";
		case "Start":
		case "SubagentActive":
			return "working";
		case "Stop":
		case "Failed":
		case "Attached":
		case "BackgroundRunning":
			return "idle";
		default:
			return "unknown";
	}
}

function agentKindFromId(agentId: string): AgentKind {
	return agentKindFromAgentId(agentId);
}

/**
 * (BRIDGE-LIVENESS) The terminals that BOTH satisfy the `host.db` predicate and
 * still name a pty that exists.
 *
 * ONE COPY, and every consumer that means "a terminal the user could be blocked
 * in" uses it: `/v1/tree`, the `/v1/heartbeat` counts, and the wire-handle
 * reverse lookup. They used to call `listActiveTerminals()` directly and each
 * inherited the same 403 corpses.
 *
 * `lastAttachedAt ?? createdAt` is handed to the predicate as the row's newest
 * known instant, which is what stops a terminal created after the daemon
 * snapshot from reading as dead.
 */
export function listLiveTerminals(
	db: Pick<HostDbReader, "listActiveTerminals">,
	liveness: TerminalLiveness,
): HostTerminalRow[] {
	return db
		.listActiveTerminals()
		.filter((row) =>
			liveness.isLive(row.id, row.lastAttachedAt ?? row.createdAt),
		);
}

/**
 * The coarse status of ONE terminal, derived from the two facts the bridge can
 * see: whether a question is pending on it, and what its binding last recorded.
 *
 * ONE COPY, DELIBERATELY. `/v1/tree` and `/v1/heartbeat` both report this — the
 * tree as the thing the phone renders, the heartbeat as the counts the phone
 * badges — and they used to derive it with two hand-written copies of the same
 * ladder. Nothing gates the two against each other, so a change to one would
 * have silently made the badge disagree with the screen behind it.
 *
 * A live question outranks the binding's last event: the question IS the red.
 * The binding's `PermissionRequest` is the same fact arriving by a different
 * route, and either alone is enough to say "needs input".
 */
function deriveSessionStatus(
	pending: PendingQuestion | null,
	binding: HostBindingRow | undefined,
): AgentStatus {
	if (pending !== null) return "needs_input";
	if (binding === undefined) return "idle";
	return statusFromEventType(binding.lastEventType);
}

/**
 * The counts are a projection of `deriveSessionStatus`, so they live next to it:
 * `unknown` tallies as idle, and it must do so identically on both endpoints.
 */
function tallyStatus(counts: StatusCounts, status: AgentStatus): void {
	if (status === "needs_input") counts.needsInput++;
	else if (status === "working") counts.working++;
	else counts.idle++;
}

/**
 * host.db carries no terminal title — the pane title is renderer state. The
 * bridge therefore labels a terminal by what it can actually see: the agent
 * bound to it, or `Shell` when nothing is. This is a display label, not a
 * status claim.
 */
function terminalTitle(binding: HostBindingRow | undefined): string {
	if (binding === undefined) return "Shell";
	if (binding.agentId.length === 0) return "Agent";
	return binding.agentId.charAt(0).toUpperCase() + binding.agentId.slice(1);
}

/**
 * §7.2 reference order. `unknown` ranks LAST, below `idle`.
 *
 * It used to rank above `idle`, and both clients rank it below — and since the
 * client re-sorts everything it receives, the two orders were visibly different
 * lists. The spec never places `unknown`, so neither side was wrong; this is the
 * side that agrees with the rest of this module, which already treats `unknown`
 * as the weakest claim it can make: `tallyStatus` counts it as idle and
 * `rollup()` uses it only as the final fallback. A status the bridge cannot
 * name must not outrank one it can.
 */
const STATUS_RANK: Record<AgentStatus, number> = {
	needs_input: 0,
	working: 1,
	idle: 2,
	unknown: 3,
};

/** Rollup precedence: red > yellow > neutral, matching the desktop's dots. */
function rollup(statuses: AgentStatus[]): AgentStatus {
	if (statuses.length === 0) return "idle";
	if (statuses.includes("needs_input")) return "needs_input";
	if (statuses.includes("working")) return "working";
	if (statuses.includes("idle")) return "idle";
	return "unknown";
}

/**
 * Hoisted: the anchors root never changes, and `path.resolve` on every project
 * of every tree build would be work for nothing.
 */
const MULTI_REPO_ANCHOR_PREFIX = path
	.resolve(MULTI_REPO_ANCHORS_DIR)
	.toLowerCase();

/**
 * The baseline / no-`tree.read` value. A client that has not been granted the
 * enriched tree gets the enum's designated member rather than a fact it was not
 * granted, exactly like `agent.kind` and `lastActivityMs` beside it.
 */
const PROJECT_KIND_UNKNOWN: ProjectKind = "unknown";

/**
 * (BRIDGE-SIDEBAR-FILTER) The workspaces the phone is allowed to see, as a map
 * from `workspaces.id` to its row.
 *
 * ONE COPY for the same reason `deriveSessionStatus` is one copy: `/v1/tree`
 * renders these and `/v1/heartbeat` counts them, and a badge that disagrees with
 * the screen behind it is worse than either being wrong alone.
 */
function visibleWorkspaces(
	rows: readonly HostWorkspaceRow[],
	curation: SidebarCuration,
): Map<string, HostWorkspaceRow> {
	const visible = new Map<string, HostWorkspaceRow>();
	for (const row of rows) {
		if (curation.workspaceVerdict(row) !== "show") continue;
		visible.set(row.id, row);
	}
	return visible;
}

/**
 * The git / plain / multi-repo discriminator, derived from `host.db` alone.
 *
 * This used to be hardcoded `unknown` on the grounds that the discriminator
 * "lives in renderer/project metadata the bridge cannot reach" and that
 * computing it would need a per-project filesystem probe — the blocking-fs
 * pattern that starves the renderer. Both halves were wrong, and the database
 * says so: the host-service marks both kinds itself, with its own sentinels,
 * and reading them is pure string work with no fs call at all.
 *
 *  - MULTI-REPO is the fork-owned ANCHOR DIRECTORY. A multi-repo project's
 *    `repo_path` sits under `~/.superset/multi-repo/`; nothing else does. Same
 *    rule `readMultiRepoConfig` uses, and it is deliberately the path — not the
 *    presence of a config file — for the same reason it is there.
 *  - PLAIN (non-git) is `NON_GIT_BRANCH`, the sentinel the host-service writes
 *    onto a non-git workspace's `branch`. A non-git project has exactly one
 *    workspace and it carries the sentinel.
 *  - Everything else with at least one workspace is a git repo.
 *  - A project with NO workspaces stays `unknown`. There is no evidence either
 *    way, and `unknown` is the enum's designated member for exactly that.
 *
 * Multi-repo is checked first because a multi-repo BRANCH workspace is itself a
 * plain container folder — classifying on the workspace alone would report the
 * group as plain.
 *
 * `workspaces` MUST be the project's OWN rows (`workspaces.project_id`), never
 * the sidebar-placed ones. Kind is a property of the repository; a thread the
 * user dragged under another repo says nothing about either repo's kind, and
 * feeding placement in here made a non-git project display as `git` the moment
 * one git branch was dropped on it.
 */
function deriveProjectKind(
	project: HostProjectRow,
	workspaces: readonly HostWorkspaceRow[],
): ProjectKind {
	const repoPath = path.resolve(project.repoPath || "").toLowerCase();
	if (
		repoPath.startsWith(`${MULTI_REPO_ANCHOR_PREFIX}\\`) ||
		repoPath.startsWith(`${MULTI_REPO_ANCHOR_PREFIX}/`)
	) {
		return "multi_repo";
	}
	if (workspaces.length === 0) return "unknown";
	return workspaces.every((w) => w.branch === NON_GIT_BRANCH) ? "plain" : "git";
}

/**
 * (CHAT-CONTEXT-NAMES) The ONE copy of "what does the user call this project".
 *
 * `/v1/tree` names its project headers with this, `/v1/question` names its
 * `place` with it and the FCM alert path names its push with it, so the sheet's
 * header, the row the user tapped and the notification that opened it can never
 * disagree about a repo. Two copies of a fallback chain is two chances to drift
 * apart, and the drift would show up as the phone contradicting itself.
 *
 * Non-null, like `workspaceDisplayName`: a row that has gone is the CALLER's
 * fact to spell — `""`, the convention `ChatPlace` uses for every unknown — and
 * a helper that swallowed it would let a caller forget it had a null to handle.
 */
export function projectDisplayName(row: HostProjectRow): string {
	return row.name.length > 0 ? row.name : path.basename(row.repoPath || row.id);
}

/**
 * (CHAT-CONTEXT-NAMES) The ONE copy of "what does the user call this
 * workspace". Same argument as `projectDisplayName`.
 */
export function workspaceDisplayName(row: HostWorkspaceRow): string {
	return row.name.length > 0 ? row.name : row.branch;
}

/**
 * (CHAT-CONTEXT-NAMES) One tree read's tab-title failures, counted instead of
 * logged one by one.
 *
 * `/v1/tree` is a POLLED endpoint and it resolves a title per terminal row, so
 * a registry that is broken rather than merely missing an entry produces one
 * log line per terminal per poll — a machine with twenty panes writes twenty
 * lines every few seconds, for one fact. The tally collapses that to one line
 * per read carrying the count, the same shape `push-context` uses for its
 * rejected/ambiguous terminals. The question path keeps its per-call line:
 * there is exactly one terminal on it, and it is not polled.
 */
interface TabTitleFailureTally {
	count: number;
	/** The class of the LAST failure. One class name starts the investigation; N copies do not. */
	lastErrorName: string;
}

/**
 * (CHAT-CONTEXT-NAMES) The renderer's tab title, or `""`. NEVER THROWS.
 *
 * The registry is process-local state owned by another subsystem; a lookup that
 * fails costs the user one word of context, while letting it escape would cost
 * them the whole tree or the whole question. `null` dep is the same answer as a
 * failed lookup, because from the phone's side they are the same fact.
 *
 * Pass a `TabTitleFailureTally` from a loop; omit it and the failure is logged
 * on the spot.
 */
function resolveTabTitleSafely(
	deps: ReadDeps,
	hostWorkspaceId: string,
	hostTerminalId: string,
	tally?: TabTitleFailureTally,
): string {
	const resolve = deps.resolveTabTitle;
	if (resolve === null) return "";
	try {
		return resolve(hostWorkspaceId, hostTerminalId);
	} catch (error) {
		// A class name. NEVER the message, the stack or the error object.
		const errorName = errorClassName(error);
		if (tally !== undefined) {
			tally.count++;
			tally.lastErrorName = errorName;
			return "";
		}
		// Ids and a class name. NEVER the message, the stack or the error object.
		logSafely(deps.log, {
			event: "companion.chat_place.tab_title_unresolved",
			hostWorkspaceId,
			hostTerminalId,
			errorName,
		});
		return "";
	}
}

/**
 * (BRIDGE-SIDEBAR-FILTER) One read's view of what the sidebar shows.
 *
 * Three read paths build this from the same three arguments — the mirror, the
 * read's clock and the org gate — and a fourth that forgot the org gate would
 * apply another machine's curation (`(MIRROR-ORG-GATE)`) while still compiling.
 * The triple is written once so there is nothing to forget.
 */
function curationFor(deps: ReadDeps, nowMs: EpochMs): SidebarCuration {
	return createSidebarCuration(
		deps.db.readSidebarMirror(),
		nowMs,
		deps.organizationId,
	);
}

/**
 * (CHAT-CONTEXT-NAMES) The three names for one terminal. NEVER THROWS, and
 * every field degrades on its own.
 *
 * The project name is the SIDEBAR PLACEMENT's, resolved through the same
 * `createSidebarCuration` + `effectiveProjectId` pair `/v1/tree` groups by, so
 * the question sheet's header names the project the tapped row sits under. That
 * is deliberately NOT `QuestionSource.projectId`, which is the owning project
 * and goes stale as a NAME the moment a thread is dragged elsewhere.
 *
 * Curation is consulted for PLACEMENT ONLY, never for visibility: a hidden,
 * snoozed or archived workspace's question is served exactly as it is today
 * (`(ANSWER-GUARDLESS)`), and this function is incapable of refusing one.
 */
function resolveChatPlace(
	deps: ReadDeps,
	hostWorkspaceId: string,
	hostTerminalId: string,
): ChatPlace {
	let projectName = "";
	let workspaceName = "";
	try {
		const workspace = deps.db.findWorkspace(hostWorkspaceId);
		if (workspace !== null) {
			// Assigned BEFORE the project lookup, so a project read that throws
			// costs the project name only.
			workspaceName = workspaceDisplayName(workspace);
			const curation = curationFor(deps, Date.now());
			const placement = curation.effectiveProjectId(workspace);
			if (isSessionsProjectId(placement)) {
				// (SESSIONS-PROJECT) A session owns no project row to name.
				projectName = SESSIONS_PROJECT_NAME;
			} else {
				const project = deps.db.findProject(placement);
				projectName = project === null ? "" : projectDisplayName(project);
			}
		}
	} catch (error) {
		// Ids and a class name. NEVER the message, the stack or the error object.
		logSafely(deps.log, {
			event: "companion.chat_place.names_unresolved",
			hostWorkspaceId,
			errorName: errorClassName(error),
		});
	}
	return {
		projectName,
		workspaceName,
		tabTitle: resolveTabTitleSafely(deps, hostWorkspaceId, hostTerminalId),
	};
}

/**
 * Curated ordinary threads stay out of both `/v1/tree` and its counts. A live
 * question is the exception: curation also holds its push, so filtering it out
 * would erase every phone/watch discovery path.
 *
 * `/v1/tree` and the badge counts share this predicate so the badge can never
 * disagree with the screen behind it.
 */
function terminalPiercesCuration(
	visible: ReadonlyMap<string, HostWorkspaceRow>,
	workspaceId: string,
	pending: PendingQuestion | null,
): boolean {
	return visible.has(workspaceId) || pending !== null;
}

/** §7.2. `includeIdle` is explicit on every request; there is no server-side default. */
export async function handleTree(
	deps: ReadDeps,
	ctx: SealedRequestContext,
	request: TreeRequest,
): Promise<TreeResponse> {
	const includeIdle = requireBooleanField(request.includeIdle, "includeIdle");
	if (
		request.since !== undefined &&
		request.since !== null &&
		!Number.isInteger(request.since)
	) {
		throw badRequest("since must be an integer epoch-ms or null");
	}

	// Protocol 0 / no `tree.read`: baseline fields only (§6.1, §7.2). The
	// non-baseline fields are still present because the shape is fixed, but they
	// carry the enum's designated `unknown` / `null` members rather than data
	// the client has not been granted.
	const full = ctx.granted.includes("tree.read");

	// (BRIDGE-LIVENESS) Refresh before reading, because this is one of the two
	// handlers that can afford a daemon round trip. Never throws — a failure
	// degrades to "no evidence", which shows everything.
	await deps.liveness.refresh();

	const nowMs = Date.now();
	const answerability: AnswerabilityContext = { granted: ctx.granted };
	const curation = curationFor(deps, nowMs);
	const projects = deps.db.listProjects();
	const allWorkspaces = deps.db.listWorkspaces();
	const visible = visibleWorkspaces(allWorkspaces, curation);
	const terminals = listLiveTerminals(deps.db, deps.liveness);
	const bindings = new Map(
		deps.db.listBindings().map((b) => [b.terminalId, b]),
	);

	const counts: StatusCounts = { needsInput: 0, working: 0, idle: 0 };
	const terminalsByWorkspace = new Map<string, Terminal[]>();
	// (CHAT-CONTEXT-NAMES) One line per read, not one per pane. See TabTitleFailureTally.
	const tabTitleFailures: TabTitleFailureTally = {
		count: 0,
		lastErrorName: "",
	};

	for (const row of terminals) {
		if (row.originWorkspaceId === null) continue;
		const pending = deps.questions.byHostTerminal(row.id);
		if (!terminalPiercesCuration(visible, row.originWorkspaceId, pending))
			continue;
		const binding = bindings.get(row.id);

		const status = deriveSessionStatus(pending, binding);
		tallyStatus(counts, status);

		let pendingRef: PendingQuestionRef | null = null;
		if (pending !== null) {
			pendingRef = {
				questionId: pending.questionId,
				askedAtMs: pending.askedAtMs,
				answerable:
					deps.questions.unanswerableReason(pending, answerability) === null,
				headline: deps.questions.headline(pending),
				// (EMIT-OPTIONAL-FIELDS) The headline is the FIRST question's header
				// only; without the count a 3-question capture renders exactly like a
				// 1-question one, and `multiSelect` changes what answering even means.
				// Pending-question identity is baseline data: a paired device must be able
				// to discover the question even before capability negotiation.
				questionCount: pending.questions.length,
				multiSelect: pending.questions.some((item) => item.multiSelect),
			};
		}

		const tabTitle = resolveTabTitleSafely(
			deps,
			row.originWorkspaceId,
			row.id,
			tabTitleFailures,
		);

		const terminal: Terminal = {
			terminalId: deriveHandle("terminal", row.id) as unknown as TerminalId,
			title: terminalTitle(binding),
			status,
			agent: full
				? {
						kind:
							binding === undefined ? "none" : agentKindFromId(binding.agentId),
						bound: binding !== undefined,
						subagent:
							pending !== null && pending.agentType !== null
								? { agentType: pending.agentType }
								: null,
					}
				: { kind: "unknown", bound: false, subagent: null },
			pendingQuestion: pendingRef,
			lastActivityMs: full
				? (binding?.lastEventAt ?? row.lastAttachedAt ?? row.createdAt)
				: null,
			// (CHAT-CONTEXT-NAMES) (EMIT-OPTIONAL-FIELDS) The pane label the user
			// reads on the desktop, omitted rather than sent empty — the client
			// defaults an absent title to `""`, so the two say the same thing and
			// only one of them costs a key on every terminal of every poll.
			//
			// NOT gated on `full`, exactly like `title` above: it is this row's own
			// name, in the same class of fact as the name of the workspace and the
			// project it is nested under, neither of which is gated either.
			...(tabTitle.length === 0 ? {} : { tabTitle }),
		};

		const list = terminalsByWorkspace.get(row.originWorkspaceId);
		if (list === undefined) {
			terminalsByWorkspace.set(row.originWorkspaceId, [terminal]);
		} else {
			list.push(terminal);
		}
	}

	if (tabTitleFailures.count > 0) {
		logSafely(deps.log, {
			event: "companion.chat_place.tab_title_unresolved",
			// The COUNT, and the class of the last one. No ids: the interesting
			// fact is that the registry is failing at all, and a per-terminal id
			// list would put this line straight back where it started.
			terminals: tabTitleFailures.count,
			errorName: tabTitleFailures.lastErrorName,
		});
	}

	// (BRIDGE-SIDEBAR-FILTER) Grouped by the SIDEBAR's placement, not by
	// `workspaces.project_id`: moving a thread under another repo is a curation
	// act, and the phone mirrors where the user put it.
	const workspacesByProject = new Map<string, Workspace[]>();
	// Keyed on `workspaces.project_id` — the OWNING project — and deliberately
	// NOT on the placement above. Kind is a fact about a repository (is its
	// `repo_path` the multi-repo anchor, do its workspaces carry the non-git
	// branch sentinel), and curation cannot change a repository. Feeding the
	// placement map to `deriveProjectKind` made dragging one git branch under a
	// non-git project flip that project from `plain` to `git` on the phone, and
	// dragging the last workspace out of a project made it `unknown` — a display
	// kind that changed because of where the user dropped a thread.
	const workspaceRowsByOwningProject = new Map<string, HostWorkspaceRow[]>();
	for (const row of allWorkspaces) {
		const placement = curation.effectiveProjectId(row);
		// (SESSIONS-PROJECT) A session owns no project, so its kind rows are filed
		// under the synthetic id. Nothing reads them — the synthetic group reports
		// `unknown` — but the key must be a string for the map to hold it.
		const owningProject = placementProjectId(row.projectId);
		const kindRows = workspaceRowsByOwningProject.get(owningProject);
		if (kindRows === undefined)
			workspaceRowsByOwningProject.set(owningProject, [row]);
		else kindRows.push(row);

		const all = terminalsByWorkspace.get(row.id) ?? [];
		const status = rollup(all.map((t) => t.status));
		const shown = includeIdle ? all : all.filter((t) => t.status !== "idle");
		// A workspace with nothing to show is dropped UNCONDITIONALLY. Emptiness
		// is not an idle question: 63 workspaces on this machine have zero live
		// terminals, and each one rendered an inert header row the user cannot
		// even tap (only terminal rows are answerable). The skip used to sit
		// behind `!includeIdle`, which every automatic client path sets to true —
		// so it never once fired.
		if (shown.length === 0) continue;

		sortTerminals(shown);

		const workspacePinned = curation.workspacePinned(row.id);
		const workspace: Workspace = {
			workspaceId: deriveHandle("workspace", row.id) as unknown as WorkspaceId,
			name: workspaceDisplayName(row),
			branch: full ? (row.branch.length > 0 ? row.branch : null) : null,
			status,
			terminals: shown,
			lastActivityMs: full
				? shown.reduce<number | null>(
						(acc, t) =>
							t.lastActivityMs === null
								? acc
								: acc === null
									? t.lastActivityMs
									: Math.max(acc, t.lastActivityMs),
						null,
					)
				: null,
			// (EMIT-OPTIONAL-FIELDS) Pinning is the one act of curation that changes
			// ORDER rather than membership, so a filter that only decides what to
			// hide could never carry it. Not gated on `full`: it says nothing about
			// content that the row's own name and status do not already say.
			//
			// OMITTED, not `false`, when curation has no opinion (never mirrored,
			// aged out, another org). §7.2 distinguishes a field the bridge does not
			// report from one it reports as false, and emitting `false` there told
			// the phone "this row is not pinned" on the strength of a mirror that was
			// never written.
			...(workspacePinned === null ? {} : { pinned: workspacePinned }),
		};

		const list = workspacesByProject.get(placement);
		if (list === undefined) {
			workspacesByProject.set(placement, [workspace]);
		} else {
			list.push(workspace);
		}
	}

	const outProjects: Project[] = [];
	for (const row of projects) {
		const ws = workspacesByProject.get(row.id) ?? [];
		// A project omitted from the sidebar still carries a pending-question
		// workspace admitted above. The workspace list is the final visibility fact.
		// Same unconditional skip, for the same reason: a project whose every
		// workspace was dropped is a header with nothing under it.
		if (ws.length === 0) continue;
		ws.sort(
			(a, b) =>
				STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
				(b.lastActivityMs ?? 0) - (a.lastActivityMs ?? 0),
		);
		const projectPinned = curation.projectPinned(row.id);
		outProjects.push({
			projectId: deriveHandle("project", row.id) as unknown as ProjectId,
			name: projectDisplayName(row),
			kind: full
				? deriveProjectKind(row, workspaceRowsByOwningProject.get(row.id) ?? [])
				: PROJECT_KIND_UNKNOWN,
			workspaces: ws,
			// (EMIT-OPTIONAL-FIELDS) `sidebar_project_state.is_pinned`, omitted on
			// the same terms as a workspace's.
			...(projectPinned === null ? {} : { pinned: projectPinned }),
		});
	}
	// (SESSIONS-PROJECT) The synthetic group, emitted only when it has rows. It
	// is built AFTER the real projects and from the same placement map, so a
	// session dragged under a real repo groups there instead — placement is
	// curation, and the synthetic id is only the fallback for a workspace that
	// has no project at all.
	const sessionWorkspaces = workspacesByProject.get(SESSIONS_PROJECT_ID) ?? [];
	if (sessionWorkspaces.length > 0) {
		sessionWorkspaces.sort(
			(a, b) =>
				STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
				(b.lastActivityMs ?? 0) - (a.lastActivityMs ?? 0),
		);
		outProjects.push({
			projectId: deriveHandle(
				"project",
				SESSIONS_PROJECT_ID,
			) as unknown as ProjectId,
			name: SESSIONS_PROJECT_NAME,
			// Deliberately `unknown`, even with `tree.read`: kind is a fact about a
			// REPOSITORY and this group is not one. `plain` or `git` would be an
			// invented claim about a project that does not exist in host.db.
			kind: PROJECT_KIND_UNKNOWN,
			workspaces: sessionWorkspaces,
			// No `pinned`: the synthetic project can never have a
			// `sidebar_project_state` row, so the bridge has no opinion to report.
		});
	}

	outProjects.sort((a, b) => {
		const aStatus = rollup(a.workspaces.map((w) => w.status));
		const bStatus = rollup(b.workspaces.map((w) => w.status));
		return STATUS_RANK[aStatus] - STATUS_RANK[bStatus];
	});

	return {
		generatedAtMs: Date.now(),
		// Always a full tree. §7.2 says the bridge MAY answer `since` with a
		// delta; it does not, because a delta the client mis-applies is a silently
		// wrong tree, and the whole payload is small.
		complete: true,
		gseq: full ? deps.currentGseq() : 0,
		projects: outProjects,
		counts,
		// (CURATION-PROVENANCE) Emitted on every tree, not only empty ones: the
		// question "is this tree short because nothing is running, or because the
		// mirror hid it?" is asked of a tree that is merely SMALLER than expected
		// at least as often as of one that is empty.
		curation: {
			enabled: curation.enabled,
			lastSyncAgeMs: curation.lastSyncAgeMs,
			hiddenWorkspaces: allWorkspaces.length - visible.size,
		},
	};
}

/**
 * Reference order (§7.2): `needs_input` first, oldest `askedAtMs` first, then
 * `working`, then `idle`, ties broken by `lastActivityMs` descending.
 */
function sortTerminals(terminals: Terminal[]): void {
	terminals.sort((a, b) => {
		const rank = STATUS_RANK[a.status] - STATUS_RANK[b.status];
		if (rank !== 0) return rank;
		if (a.status === "needs_input") {
			const aAsked = a.pendingQuestion?.askedAtMs ?? Number.MAX_SAFE_INTEGER;
			const bAsked = b.pendingQuestion?.askedAtMs ?? Number.MAX_SAFE_INTEGER;
			if (aAsked !== bAsked) return aAsked - bAsked;
		}
		return (b.lastActivityMs ?? 0) - (a.lastActivityMs ?? 0);
	});
}

// ---------------------------------------------------------------------------
// §7.3 transcript
// ---------------------------------------------------------------------------

interface TranscriptCursor {
	/** Byte offset of the line that produced the oldest entry of the last page. */
	o: number;
}

function encodeCursor(offset: number): string {
	return Buffer.from(JSON.stringify({ o: offset }), "utf8").toString(
		"base64url",
	);
}

function decodeCursor(raw: string): number {
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
	} catch {
		throw badRequest("before is not a cursor issued by this bridge");
	}
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		!Number.isInteger((parsed as TranscriptCursor).o) ||
		(parsed as TranscriptCursor).o < 0
	) {
		throw badRequest("before is not a cursor issued by this bridge");
	}
	return (parsed as TranscriptCursor).o;
}

/**
 * Claude Code stores a session transcript at
 * `<config>/projects/<mangled cwd>/<sessionId>.jsonl`, where the mangling
 * replaces every character outside `[A-Za-z0-9-]` with `-`
 * (`C:\Users\khair` -> `C--Users-khair`).
 *
 * (TRANSCRIPT-PATH-DERIVED) This is the ONLY way the bridge ever names a
 * transcript. It used to be a fallback behind the hook-supplied
 * `transcript_path`, which meant an unauthenticated localhost POST chose which
 * file `/v1/transcript` opened and which file guard 1 read.
 *
 * `sessionId` is attacker-influenceable (`terminal_agent_bindings.agent_session_id`
 * is written by the same unauthenticated hook), so it is CONSTRAINED rather
 * than trusted: anything outside `[A-Za-z0-9_-]` cannot become a path segment,
 * which is what keeps the result inside `<config>/projects/`. `cwd` needs no
 * such check — the mangling already collapses `.` and every separator to `-`.
 *
 * Returns `null` rather than a guess when it cannot be derived; every caller
 * treats `null` as a refusal.
 */
const SAFE_SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function deriveClaudeTranscriptPath(
	cwd: string,
	sessionId: string,
): string | null {
	if (!SAFE_SESSION_ID.test(sessionId)) return null;
	if (typeof cwd !== "string" || cwd.length === 0) return null;
	const configDir =
		process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
	const mangled = cwd.replace(/[^A-Za-z0-9-]/g, "-");
	if (mangled.length === 0) return null;
	const projectsRoot = path.resolve(path.join(configDir, "projects"));
	const candidate = path.resolve(
		path.join(projectsRoot, mangled, `${sessionId}.jsonl`),
	);
	// Belt and braces: the two segments above are constrained, so this can only
	// fire if one of those constraints is ever loosened. It is cheap and it fails
	// loud rather than serving a file from outside the transcript root.
	if (
		candidate !== projectsRoot &&
		!candidate.startsWith(projectsRoot + path.sep)
	) {
		return null;
	}
	return candidate;
}

interface ResolvedTranscript {
	transcriptPath: string;
	/** Monotonic stamp; a CHANGE means the session was replaced (§7.3). */
	sessionGeneration: number;
}

/**
 * (TRANSCRIPT-PATH-DERIVED) Always derived from host.db, for every terminal —
 * with or without a captured question.
 *
 * The previous version preferred `question.transcriptPath`, describing it as
 * "authoritative because the hook told us the exact path". Its authority was an
 * unauthenticated localhost POST: any local process could point `/v1/transcript`
 * at an arbitrary absolute file and have its contents rendered on the phone as
 * the agent's own conversation. `PendingQuestion.transcriptPath` is now itself
 * derived, so there is no second source to prefer and none is consulted.
 */
function resolveTranscript(
	deps: ReadDeps,
	hostTerminalId: string,
): Promise<ResolvedTranscript> {
	const binding = deps.db.findBinding(hostTerminalId);
	if (binding === null) {
		throw badRequest("terminal has no agent binding, so it has no transcript");
	}
	if (binding.agentSessionId === null || binding.agentSessionId.length === 0) {
		throw badRequest(
			"the agent bound to this terminal has not reported a session id yet",
		);
	}
	if (agentKindFromId(binding.agentId) !== "claude") {
		throw badRequest(
			"transcript reading is implemented for Claude Code sessions only",
		);
	}
	const workspace = deps.db.findWorkspace(binding.workspaceId);
	if (workspace === null) {
		throw badRequest("the workspace that owns this terminal no longer exists");
	}
	const candidate = deriveClaudeTranscriptPath(
		workspace.worktreePath,
		binding.agentSessionId,
	);
	if (candidate === null) {
		throw badRequest("the agent transcript for this terminal is unreadable");
	}
	// `fs/promises`, like every other read in this module. The old `existsSync`
	// here was the one synchronous fs call on a REQUEST path in the bridge, and
	// blocking fs on this process is the documented footgun that starves the
	// renderer's `superset-app://` loader. It also asked the question twice: the
	// caller followed it with an `fs.access` on the same path, so the check that
	// actually protects the read is this one, and there is now exactly one.
	return fs.access(candidate).then(
		() => ({ transcriptPath: candidate, sessionGeneration: binding.startedAt }),
		() => {
			throw badRequest("the agent transcript for this terminal is unreadable");
		},
	);
}

export async function handleTranscript(
	deps: ReadDeps,
	ctx: SealedRequestContext,
	request: TranscriptRequest,
): Promise<TranscriptResponse> {
	requireCapability(ctx, "transcript.read");
	const terminalId = requireHandle(request.terminalId, "terminalId");
	if (
		!Number.isInteger(request.limit) ||
		request.limit < 1 ||
		request.limit > LIMITS.transcriptPageMax
	) {
		throw badRequest(
			`limit must be an integer in 1..${LIMITS.transcriptPageMax}`,
		);
	}
	let beforeOffset: number | null = null;
	if (request.before !== undefined && request.before !== null) {
		if (typeof request.before !== "string") {
			throw badRequest("before must be a cursor string or null");
		}
		beforeOffset = decodeCursor(request.before);
	}

	const hostTerminalId = resolveHostTerminalId(deps, terminalId);
	const { transcriptPath, sessionGeneration } = await resolveTranscript(
		deps,
		hostTerminalId,
	);

	// `fs/promises` throughout: a synchronous read on this process starves the
	// renderer's `superset-app://` loader and the window stays blank for minutes.
	// `resolveTranscript` has already proved the path is readable.
	const window = await readTranscriptWindow({
		transcriptPath,
		limit: request.limit,
		beforeOffset,
	});

	return {
		terminalId: terminalId as unknown as TerminalId,
		entries: window.entries,
		nextCursor:
			window.hasMore && window.oldestOffset !== null
				? encodeCursor(window.oldestOffset)
				: null,
		hasMore: window.hasMore,
		sessionGeneration,
	};
}

/**
 * Wire handles are derived one-way (§7.2), so the reverse direction is a lookup
 * over the ids host.db currently holds — never an inversion.
 *
 * (HANDLE-REVERSE-ONE-COPY) THE ENUMERATION IS THE POINT AND IT IS NOT CACHED.
 * The scan runs on EVERY call, so a terminal that has closed stops resolving —
 * which is what lets the answer path re-evaluate its guards before every
 * keystroke without a stale mapping surviving underneath them. Only the per-row
 * hash is memoised, inside `deriveHandle` (HANDLE-MEMO), and that is a pure
 * function of its arguments.
 *
 * (BRIDGE-LIVENESS) The scan is over LIVE terminals, and that correction is
 * what makes the paragraph above true. It used to scan `listActiveTerminals()`,
 * and on the real database "a terminal that has closed stops resolving" was
 * simply false: 403 rows still matched, so every terminal ever killed by a
 * crash, a quit or a host-service restart kept resolving to a live wire handle
 * indefinitely. The freshness this comment claims was being asserted by the
 * comment rather than by the data.
 *
 * CURATION IS DELIBERATELY NOT APPLIED HERE. Whether a thread is on the user's
 * sidebar decides what the phone LISTS, never what it may answer: a question
 * captured before its workspace was snoozed is still a real question on a real
 * terminal, and refusing it would be the "refused a healthy answer" failure.
 * Liveness is applied because a dead terminal cannot be typed into at all — and
 * it fails toward LIVE, so it can never manufacture that refusal either.
 *
 * `null` for an unknown handle. `index.ts`'s guard adapters want the `null`
 * (a handle they cannot resolve is a refusal, never a guess); `/v1/transcript`
 * wants a hard failure and adds it at its own boundary.
 */
export function findActiveHostTerminalId(
	db: Pick<HostDbReader, "listActiveTerminals">,
	liveness: TerminalLiveness,
	handle: string,
): string | null {
	for (const row of listLiveTerminals(db, liveness)) {
		if (deriveHandle("terminal", row.id) === handle) return row.id;
	}
	return null;
}

/**
 * The `/v1/transcript` boundary. An unknown handle is a hard failure, not an
 * empty result: it means the client is asking about a terminal this bridge
 * cannot see.
 */
function resolveHostTerminalId(deps: ReadDeps, handle: string): string {
	const hostTerminalId = findActiveHostTerminalId(
		deps.db,
		deps.liveness,
		handle,
	);
	if (hostTerminalId === null) throw badRequest("unknown terminalId");
	return hostTerminalId;
}

// ---------------------------------------------------------------------------
// §7.4 question
// ---------------------------------------------------------------------------

/** §7.4. Question text is NEVER truncated — truncation is the failure the watch app exists to prevent. */
export async function handleQuestion(
	deps: ReadDeps,
	ctx: SealedRequestContext,
	request: QuestionRequest,
): Promise<QuestionResponse> {
	const questionId = requireHandle(request.questionId, "questionId");
	const question = deps.questions.get(questionId);
	if (question === null) {
		throw badRequest("unknown questionId");
	}
	const response = await deps.questions.toResponse(question, {
		granted: ctx.granted,
	});
	// (CHAT-CONTEXT-NAMES) Which chat this is, in the user's own words, so a
	// sheet opened straight from a notification tap can head itself. Resolved
	// here rather than inside `toResponse` because it needs curation and the
	// read API owns the org gate that curation is only valid behind.
	//
	// It can never fail the request: `resolveChatPlace` does not throw, and a
	// name it could not resolve is `""`.
	response.place = resolveChatPlace(
		deps,
		question.hostWorkspaceId,
		question.hostTerminalId,
	);
	// One line per served detail — the durable record of what verdict this
	// device was shown, and against which granted set. This is the line whose
	// absence turned the 2026-08-09 watch refusal into an hour of forensics.
	deps.log({
		event: "companion.question.served",
		questionId: response.questionId,
		deviceId: ctx.device.deviceId,
		state: response.state,
		agentKind: response.source.agentKind,
		questionCount: response.questions.length,
		multiSelect: response.questions.some((item) => item.multiSelect),
		granted: [...ctx.granted],
		answerable: response.answerable,
		unanswerableReason: response.unanswerableReason,
	});
	return response;
}

// ---------------------------------------------------------------------------
// §7.7 heartbeat
// ---------------------------------------------------------------------------

/**
 * §7.7. Also the client-side liveness watchdog's input: 3 x `nextIntervalMs`
 * without a successful heartbeat, while the last sync showed work outstanding,
 * turns the bridge-died-with-the-app hole into a local notification instead of
 * a silent failure.
 */
export async function handleHeartbeat(
	deps: ReadDeps,
	ctx: SealedRequestContext,
	request: HeartbeatRequest,
): Promise<HeartbeatResponse> {
	if (
		request.lastEventGseq !== null &&
		!Number.isInteger(request.lastEventGseq)
	) {
		throw badRequest("lastEventGseq must be an integer or null");
	}
	if (request.foreground !== null && typeof request.foreground !== "boolean") {
		throw badRequest("foreground must be a boolean or null");
	}
	const nowMs = Date.now();

	// (BRIDGE-LIVENESS) The heartbeat is the other handler that can afford a
	// daemon round trip, and it is the one that runs on a timer — so it is what
	// keeps the snapshot fresh for the synchronous callers between beats.
	await deps.liveness.refresh();

	// Settle anything whose PostToolUse hook died in flight before reporting
	// counts — a stuck "needs input" is what makes the phone cry wolf.
	//
	// (RECONCILE-RETRACT) The ids matter. Each one is a question that is now
	// resolved and that nothing else will ever tell the push sender about, so this
	// is the only place a notification already sitting on the phone gets pulled.
	const settled = await deps.questions.reconcile(nowMs);
	if (settled.length > 0) {
		deps.onQuestionsSettled(settled);
	}

	const counts = countStatuses(deps, nowMs);
	const gseq = deps.currentGseq();

	// §7.7 — the client's liveness watchdog multiplies this, so it must match the
	// cadence the client will actually use. `null` (an older client that does not
	// state foregroundness) gets the foreground value: the shorter window
	// over-reports lost contact rather than under-reporting it.
	const nextIntervalMs =
		request.foreground === false
			? HEARTBEAT_INTERVAL_BACKGROUND_MS
			: HEARTBEAT_INTERVAL_FOREGROUND_MS;

	return {
		serverTimeMs: nowMs,
		nextIntervalMs,
		revoked: ctx.device.revokedAtMs !== null,
		writeEnabled: ctx.device.writeEnabled,
		counts,
		oldestUnansweredMs: deps.questions.oldestPendingAgeMs(nowMs),
		// (TREE-FRESHNESS-GSEQ) THE FRESHNESS CLAIM, and it is only as good as
		// what moves `gseq`.
		//
		// The phone treats `treeStale === false` (plus counts that match the tree
		// it holds) as the desktop asserting, live, that a refetch would hand back
		// what is already on screen — and stamps the list "updated just now" on
		// the strength of it. That inference is sound only because every
		// transition of the PENDING SET now mints a frame: `question.pending` on
		// capture, `question.resolved`/`question.stale` on a settle. It used to be
		// resolutions alone, which left a whole class of change — a capture on a
		// terminal already latched red — invisible to this flag AND to the counts
		// beside it, so the phone confidently asserted freshness over a list with
		// no tappable card for a live blocked agent.
		//
		// `null` means the client has no opinion yet (a fresh session), and the
		// honest answer to "is what you hold stale?" is then `false`: it holds
		// nothing to be stale about, and its own foreground fetch covers it.
		treeStale:
			request.lastEventGseq === null ? false : request.lastEventGseq < gseq,
		bridgeStartedMs: deps.bridgeStartedMs,
	};
}

/**
 * Counts are over TERMINALS — the leaf where a status is an observed fact — and
 * over exactly the terminals `/v1/tree` would render: live (`(BRIDGE-LIVENESS)`)
 * and inside a curated workspace (`(BRIDGE-SIDEBAR-FILTER)`). Before both
 * filters this returned `{needsInput: 8, working: 3, idle: 297}` on a machine
 * whose eight "blocked" agents had last spoken 18-23 days earlier.
 */
function countStatuses(deps: ReadDeps, nowMs: EpochMs): StatusCounts {
	const counts: StatusCounts = { needsInput: 0, working: 0, idle: 0 };
	const curation = curationFor(deps, nowMs);
	const visible = visibleWorkspaces(deps.db.listWorkspaces(), curation);
	const bindings = new Map(
		deps.db.listBindings().map((b) => [b.terminalId, b]),
	);
	for (const row of listLiveTerminals(deps.db, deps.liveness)) {
		if (row.originWorkspaceId === null) continue;
		const pending = deps.questions.byHostTerminal(row.id);
		if (!terminalPiercesCuration(visible, row.originWorkspaceId, pending))
			continue;
		tallyStatus(counts, deriveSessionStatus(pending, bindings.get(row.id)));
	}
	return counts;
}
