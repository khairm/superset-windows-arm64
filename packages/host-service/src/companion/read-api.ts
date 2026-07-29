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
 *  - No enrichment layer in v1: snooze, archive, pin and the sidebar's manual
 *    drag order are renderer state and are not mirrored here.
 *  - No status decay. A binding whose last event was `Start` three days ago is
 *    reported as `working`, because that is what the host actually recorded.
 *    Inventing a timeout would manufacture a state transition that never
 *    happened. (`TerminalAgentStore.clearWorkspaceStatuses` is the existing
 *    escape hatch for a wedged agent, and it runs on the host side.)
 *  - No guessed transcript when the agent session is unknown: the read fails
 *    loud rather than serving somebody else's conversation.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
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
import {
	type AnswerabilityContext,
	deriveHandle,
	type PendingQuestion,
	type QuestionSourceResolver,
	type QuestionStore,
	readTranscriptWindow,
} from "./question-store";
import {
	type AgentKind,
	type AgentStatus,
	type Capability,
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
	projectId: string;
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
	listActiveTerminals(): HostTerminalRow[];
	listBindings(): HostBindingRow[];
	findWorkspace(hostWorkspaceId: string): HostWorkspaceRow | null;
	findBinding(hostTerminalId: string): HostBindingRow | null;
	findTerminal(hostTerminalId: string): HostTerminalRow | null;
	close(): void;
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

	const reader: HostDbReader = {
		listProjects: () => projectsStmt.all() as HostProjectRow[],
		listWorkspaces: () => workspacesStmt.all() as HostWorkspaceRow[],
		listActiveTerminals: () => terminalsStmt.all() as HostTerminalRow[],
		listBindings: () => bindingsStmt.all() as HostBindingRow[],
		findWorkspace: (id) =>
			(workspaceByIdStmt.get(id) as HostWorkspaceRow | undefined) ?? null,
		findTerminal: (id) =>
			(terminalByIdStmt.get(id) as HostTerminalRow | undefined) ?? null,
		findBinding: (id) =>
			(bindingByTerminalStmt.get(id) as HostBindingRow | undefined) ?? null,
		resolveTerminal: (id) =>
			(terminalSourceStmt.get(id) as
				| {
						hostProjectId: string;
						hostWorkspaceId: string;
						agentId: string | null;
				  }
				| undefined) ?? null,
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
			if (agentKindFromId(binding.agentId) !== "claude") return null;
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
	versions: {
		appVersion: string;
		hostServiceVersion: string;
		forkTag: string;
	};
	/** Bridge boot stamp; a change means the client must re-hello (§6.3). */
	bridgeStartedMs: EpochMs;
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
	if (agentId === "claude") return "claude";
	if (agentId === "codex") return "codex";
	return "unknown";
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

const STATUS_RANK: Record<AgentStatus, number> = {
	needs_input: 0,
	working: 1,
	unknown: 2,
	idle: 3,
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
 * host.db does not record whether a project row is a plain folder, a git repo
 * or a multi-repo group — that discriminator lives in renderer/project metadata
 * the bridge cannot reach, and probing the filesystem per project on every tree
 * build is exactly the blocking-fs pattern that starves the renderer. Rather
 * than guess a kind we would have to invent, report the enum's designated
 * `unknown`. Filling this in needs a host-side source, not a heuristic.
 */
const PROJECT_KIND_UNKNOWN: ProjectKind = "unknown";

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

	const answerability: AnswerabilityContext = { granted: ctx.granted };
	const projects = deps.db.listProjects();
	const workspaces = deps.db.listWorkspaces();
	const terminals = deps.db.listActiveTerminals();
	const bindings = new Map(
		deps.db.listBindings().map((b) => [b.terminalId, b]),
	);

	const counts: StatusCounts = { needsInput: 0, working: 0, idle: 0 };
	const terminalsByWorkspace = new Map<string, Terminal[]>();

	for (const row of terminals) {
		if (row.originWorkspaceId === null) continue;
		const binding = bindings.get(row.id);
		const pending = deps.questions.byHostTerminal(row.id);

		const status = deriveSessionStatus(pending, binding);
		tallyStatus(counts, status);

		let pendingRef: PendingQuestionRef | null = null;
		if (full && pending !== null) {
			pendingRef = {
				questionId: pending.questionId,
				askedAtMs: pending.askedAtMs,
				answerable:
					deps.questions.unanswerableReason(pending, answerability) === null,
				headline: deps.questions.headline(pending),
			};
		}

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
		};

		const list = terminalsByWorkspace.get(row.originWorkspaceId);
		if (list === undefined) {
			terminalsByWorkspace.set(row.originWorkspaceId, [terminal]);
		} else {
			list.push(terminal);
		}
	}

	const workspacesByProject = new Map<string, Workspace[]>();
	for (const row of workspaces) {
		const all = terminalsByWorkspace.get(row.id) ?? [];
		const status = rollup(all.map((t) => t.status));
		const shown = includeIdle ? all : all.filter((t) => t.status !== "idle");
		if (!includeIdle && shown.length === 0) continue;

		sortTerminals(shown);

		const workspace: Workspace = {
			workspaceId: deriveHandle("workspace", row.id) as unknown as WorkspaceId,
			name: row.name.length > 0 ? row.name : row.branch,
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
		};

		const list = workspacesByProject.get(row.projectId);
		if (list === undefined) {
			workspacesByProject.set(row.projectId, [workspace]);
		} else {
			list.push(workspace);
		}
	}

	const outProjects: Project[] = [];
	for (const row of projects) {
		const ws = workspacesByProject.get(row.id) ?? [];
		if (!includeIdle && ws.length === 0) continue;
		ws.sort(
			(a, b) =>
				STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
				(b.lastActivityMs ?? 0) - (a.lastActivityMs ?? 0),
		);
		outProjects.push({
			projectId: deriveHandle("project", row.id) as unknown as ProjectId,
			name:
				row.name.length > 0 ? row.name : path.basename(row.repoPath || row.id),
			kind: PROJECT_KIND_UNKNOWN,
			workspaces: ws,
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
 * The scan runs against `listActiveTerminals()` on EVERY call, so a terminal
 * that has closed stops resolving immediately — which is what lets the answer
 * path re-evaluate its guards before every keystroke without a stale mapping
 * surviving underneath them. Only the per-row hash is memoised, inside
 * `deriveHandle` (HANDLE-MEMO), and that is a pure function of its arguments.
 *
 * `null` for an unknown handle. `index.ts`'s guard adapters want the `null`
 * (a handle they cannot resolve is a refusal, never a guess); `/v1/transcript`
 * wants a hard failure and adds it at its own boundary.
 */
export function findActiveHostTerminalId(
	db: Pick<HostDbReader, "listActiveTerminals">,
	handle: string,
): string | null {
	for (const row of db.listActiveTerminals()) {
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
	const hostTerminalId = findActiveHostTerminalId(deps.db, handle);
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
	requireCapability(ctx, "question.read");
	const questionId = requireHandle(request.questionId, "questionId");
	const question = deps.questions.get(questionId);
	if (question === null) {
		throw badRequest("unknown questionId");
	}
	return deps.questions.toResponse(question, { granted: ctx.granted });
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

	const counts = countStatuses(deps);
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
		treeStale:
			request.lastEventGseq === null ? false : request.lastEventGseq < gseq,
		bridgeStartedMs: deps.bridgeStartedMs,
	};
}

/** Counts are over TERMINALS — the leaf where a status is an observed fact. */
function countStatuses(deps: ReadDeps): StatusCounts {
	const counts: StatusCounts = { needsInput: 0, working: 0, idle: 0 };
	const bindings = new Map(
		deps.db.listBindings().map((b) => [b.terminalId, b]),
	);
	for (const row of deps.db.listActiveTerminals()) {
		if (row.originWorkspaceId === null) continue;
		// The SAME derivation `/v1/tree` reports, so the badge can never disagree
		// with the screen behind it.
		tallyStatus(
			counts,
			deriveSessionStatus(
				deps.questions.byHostTerminal(row.id),
				bindings.get(row.id),
			),
		);
	}
	return counts;
}
