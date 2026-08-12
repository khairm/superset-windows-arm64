/**
 * (COMPANION-BRIDGE) — wire contract types for the superset-companion bridge.
 *
 * Source of truth: `superset-companion/PROTOCOL.md`, protocol 1 / envelope v1.
 * Where this file and PROTOCOL.md disagree, PROTOCOL.md wins and this file is
 * the bug. Every other module in this directory imports its shapes from here;
 * nothing re-declares a wire type locally.
 *
 * Conventions carried over from the document and enforced here by typing:
 *  - all times are integer milliseconds since the Unix epoch, field names end `Ms`
 *  - all binary-in-JSON is base64url WITHOUT padding
 *  - every enum has an `"unknown"` member; unknown values degrade, never throw
 *  - there are no optional-with-default fields: a missing required field is a
 *    hard error (`bad_request` / `envelope_invalid`), never defaulted
 */

// ---------------------------------------------------------------------------
// §0 primitives
// ---------------------------------------------------------------------------

/** base64url, RFC 4648 §5, NO padding. Never standard base64. */
export type Base64Url = string;

/** Integer milliseconds since the Unix epoch, UTC. */
export type EpochMs = number;

/** Integer milliseconds. */
export type DurationMs = number;

/** 16 raw bytes -> 22 chars. Minted by the phone at pairing. */
export type DeviceId = Base64Url;
/** 16 raw bytes -> 22 chars. Minted by the desktop. */
export type PairingId = Base64Url;
/** 16 raw bytes -> 22 chars. Minted by the bridge. */
export type QuestionId = Base64Url;
/** 16 bytes of a truncated SHA-256 -> 22 chars. Minted by the bridge. */
export type Fingerprint = Base64Url;
/** 12 raw bytes -> 16 chars. Minted by the bridge. */
export type EventId = Base64Url;
/** 16 raw bytes -> 22 chars. Minted by the bridge. */
export type LeaseId = Base64Url;
/** 32 raw bytes -> 43 chars. Minted by the bridge, single use, 60 s. */
export type Ticket = Base64Url;
/** 16 raw bytes -> 22 chars each, bridge-minted opaque handles (§7.2). */
export type ProjectId = Base64Url;
export type WorkspaceId = Base64Url;
export type TerminalId = Base64Url;
/** UUIDv4, lowercase, hyphenated, 36 chars. Minted by the client. */
export type RequestId = string;

/** Which physical surface an action came from. */
export type Surface = "phone" | "watch";

/** Provenance of a resolution — includes the desktop, which never pairs. */
export type ResolverSurface = "phone" | "watch" | "desktop" | "unknown";

/** §6: JSON-shape version axis. `0` is the frozen baseline. */
export type ProtocolVersion = number;

/** §3.2 byte 0. Frozen; a mismatch is a hard `envelope_invalid`. */
export type EnvelopeVersion = 1;

// ---------------------------------------------------------------------------
// §3 the sealed envelope
// ---------------------------------------------------------------------------

/** §3.2 byte 2. */
export const ENVELOPE_KIND_REQUEST = 0x01;
export const ENVELOPE_KIND_RESPONSE = 0x02;
export const ENVELOPE_KIND_EVENT = 0x03;

export type EnvelopeKind =
	| typeof ENVELOPE_KIND_REQUEST
	| typeof ENVELOPE_KIND_RESPONSE
	| typeof ENVELOPE_KIND_EVENT;

/**
 * The 39 cleartext header bytes of §3.2, parsed. `deviceId`/`timestampMs` are
 * readable before decryption on purpose (key selection + freshness); both are
 * inside the AAD, so editing either yields a tag failure, not a reinterpretation.
 */
export interface EnvelopeHeader {
	version: EnvelopeVersion;
	/** MUST be 0x00. A non-zero flags byte is `envelope_invalid`. */
	flags: number;
	kind: EnvelopeKind;
	/** 16 raw bytes. */
	deviceIdBytes: Uint8Array;
	/** Same 16 bytes, base64url, for map keys and logging. */
	deviceId: DeviceId;
	timestampMs: EpochMs;
	/** 12 raw bytes: 4-byte prefix || 8-byte big-endian counter (§3.4). */
	nonce: Uint8Array;
}

/** A parsed inbound envelope: header plus the still-sealed remainder. */
export interface ParsedEnvelope {
	header: EnvelopeHeader;
	/** Bytes [39, end) — ciphertext with the 16-byte GCM tag appended. */
	ciphertextWithTag: Uint8Array;
	/** The exact 39 header bytes, needed verbatim for AAD construction. */
	headerBytes: Uint8Array;
}

/** §3.3 — the non-header AAD suffix for a client -> bridge request. */
export interface RequestAadParts {
	method: "POST" | "GET";
	/** Exact path, leading slash, no query, no fragment. */
	path: string;
	protocolVersion: ProtocolVersion;
}

/** §3.3 — response AAD additionally binds the request nonce and the status code. */
export interface ResponseAadParts extends RequestAadParts {
	/** The 12 nonce bytes of the request being answered. */
	requestNonce: Uint8Array;
	statusCode: number;
}

/** §3.3 — event-frame AAD binds the ticket's stream seed and the per-socket sequence. */
export interface EventAadParts {
	protocolVersion: ProtocolVersion;
	/** 12 bytes from the ticket (§9.1). */
	streamSeed: Uint8Array;
	/** Monotonic from 1 on this socket. */
	frameSeq: number;
}

/** §3.1 — the two steady-state directional keys plus the per-stream event key. */
export interface DirectionalKeys {
	/** client -> bridge */
	c2s: Uint8Array;
	/** bridge -> client */
	s2c: Uint8Array;
}

// ---------------------------------------------------------------------------
// §10 errors
// ---------------------------------------------------------------------------

/**
 * §3.6 — the CLOSED set of codes permitted in a cleartext body. Adding a member
 * here is a disclosure decision, not a refactor.
 */
export type CleartextErrorCode =
	| "envelope_invalid"
	| "unknown_device"
	| "not_paired"
	| "stale_timestamp"
	| "replay_detected"
	| "body_too_large"
	| "rate_limited"
	| "access_denied"
	| "edge_unverifiable"
	| "bridge_unavailable";

/** §10 — codes that are ALWAYS sealed; they disclose real question state. */
export type SealedErrorCode =
	| "stale_question"
	| "already_resolved"
	| "lease_held"
	| "guard_failed"
	| "picker_open"
	| "capability_unsupported"
	/**
	 * (ANSWER-LEDGER) A status read already reported this `requestId` as never
	 * received, and durably FENCED it, so the answer will never be typed.
	 *
	 * Distinct from `already_resolved` on purpose. That one means a question was
	 * answered — by another device or at the desk — and a client renders it as
	 * "already answered", which for a fenced request is false in the direction that
	 * matters: nothing was answered, this request was closed out. Reusing it would
	 * have the client's chip contradict the very message explaining what happened.
	 *
	 * The remedy differs too. `already_resolved` means stop, the question is done.
	 * This means the question may well still be open — submit a NEW request.
	 */
	| "request_closed"
	/**
	 * (SESSION-EXPIRED-VERDICT) The device has no live §6.3 session — it never
	 * `hello`'d on this bridge mount, or the one it had aged out — and the route
	 * it called is capability-gated.
	 *
	 * Distinct from `capability_unsupported` on purpose. Capabilities are session
	 * state, so a dead session degrades to an EMPTY grant set, and every gated
	 * route then answers the 501 that means "this bridge will not do that for
	 * you". The two are indistinguishable on the wire, and the documented client
	 * action for 501 is "re-hello, and if still ungranted show answer at the
	 * desk" — so a phone whose session died across a bridge restart showed the
	 * terminal message for a condition one `hello` would have fixed.
	 *
	 * The remedy differs: this one says re-negotiate and retry, the grant set is
	 * unknown rather than known-empty. A session that IS live and lacks the asked
	 * capability still gets `capability_unsupported`.
	 */
	| "session_expired"
	| "write_disabled"
	| "access_denied"
	| "bad_request"
	| "internal";

export type ErrorCode = CleartextErrorCode | SealedErrorCode;

/** §3.6 — the only shape a pre-key failure may emit. */
export interface CleartextErrorBody {
	code: CleartextErrorCode;
	serverTimeMs: EpochMs;
	retryAfterMs: DurationMs | null;
}

/** §10 — sealed error body. */
export interface ErrorBody {
	code: ErrorCode;
	/** Human-readable, for diagnostics. NEVER parsed by a client. */
	message: string;
	retryAfterMs: DurationMs | null;
	detail: Record<string, unknown> | null;
}

/**
 * (LEDGER-COHERENCE) The closed set of answer-guard names.
 *
 * `(ANSWER-GUARDLESS)` writes no `guardsPassed` / `guardsAbstained` entries, so
 * for the answer path this is now purely a READ boundary: persisted ledger and
 * audit rows written by older bridge versions still name these guards, and
 * removing the value set would make those rows unreadable. `session` remains
 * live in the other direction — `/v1/message` emits it as a `GuardFailedDetail`
 * — so this is not dead code that can be deleted with the ledger's history.
 *
 * It is a VALUE as well as a type so `attempt-ledger.ts` can check MEMBERSHIP,
 * not merely "is a string", when it reads a stored `guardsPassed`.
 */
export const ANSWER_GUARD_NAMES = [
	"transcript",
	"binding",
	"session",
	"permission_axis",
	"screen",
	"askq_marker",
] as const;

export type AnswerGuardName = (typeof ANSWER_GUARD_NAMES)[number];

/**
 * The message path's own guard name. §7.5's table called the session failure
 * `session_inactive`, but §10's `guard_failed` detail enum — the one the client
 * actually decodes — lists `session`, and there is no `session_inactive` member
 * in the client's `GuardName`. Emitting it resolved to `unknown` on the phone
 * and lost the one fact worth showing ("that terminal's session ended"), so the
 * message path now emits `session` like the answer path and the two §7.5 tokens
 * collapse to the one §10 has never had: `no_agent_binding`.
 */
export type MessageGuardName = "no_agent_binding";

export type GuardName = AnswerGuardName | MessageGuardName;

/** `detail` shapes, per §10. Each is `ErrorBody["detail"]` narrowed. */
export interface AlreadyResolvedDetail {
	resolvedBy: ResolvedBy;
	resolvedAtMs: EpochMs;
	outcome: QuestionOutcome;
}

export interface LeaseHeldDetail {
	leaseHolderLabel: string | null;
	expiresInMs: DurationMs;
}

export interface GuardFailedDetail {
	guard: GuardName;
}

export interface CapabilityUnsupportedDetail {
	capability: Capability;
}

export interface AccessDeniedDetail {
	reason: "revoked";
}

// ---------------------------------------------------------------------------
// §4 pairing (LAN listener only, 0.0.0.0:47611, 120 s, single use)
// ---------------------------------------------------------------------------

/** §4.3 — parsed from the QR fragment. `pc` never leaves the fragment. */
export interface PairingQrPayload {
	v: 1;
	/** percent-decoded `host:port` of the LAN listener; IP literal only. */
	h: string;
	pid: PairingId;
	/** 32 bytes of CSPRNG output. Never rendered as text, never logged. */
	pc: Base64Url;
	/** SHA-256(dPub)[0..16], base64url. */
	fp: Base64Url;
}

/** step 1: phone -> desktop, `POST /pair/kex`, cleartext JSON. */
export interface PairKexRequest {
	v: 1;
	pid: PairingId;
	/** 32-byte X25519 public key. */
	pPub: Base64Url;
	deviceId: DeviceId;
	label: string;
	surface: Surface;
	appVersion: string;
	protocol: ProtocolRange;
}

/** step 2: desktop -> phone, 200, cleartext JSON. */
export interface PairKexResponse {
	v: 1;
	pid: PairingId;
	/** 32-byte X25519 public key. */
	dPub: Base64Url;
	/** 16 bytes. */
	pairSalt: Base64Url;
	serverTimeMs: EpochMs;
}

/** step 3b: phone -> desktop, `POST /pair/confirm`, cleartext JSON. */
export interface PairConfirmRequest {
	v: 1;
	pid: PairingId;
	deviceId: DeviceId;
	/** HMAC-SHA256(K_conf_p, transcript), 32 bytes. Compared in CONSTANT TIME. */
	macPhone: Base64Url;
}

/**
 * step 4: desktop -> phone, 200, body is a SEALED envelope
 * (kind 0x02, K_s2c, METHOD "POST", PATH "/pair/confirm", protocolVersion 0x01).
 * This is the ONLY message in the protocol that carries the Access secret.
 */
export interface PairConfirmResponse {
	/** HMAC-SHA256(K_conf_d, transcript). The phone verifies this BEFORE trusting the body. */
	macDesktop: Base64Url;
	deviceId: DeviceId;
	access: {
		clientId: string;
		/** SECRET. Never logged, never written to a repo file, never in a diagnostic bundle. */
		clientSecret: string;
	};
	bridge: {
		origin: string;
		teamDomain: string;
		aud: string;
	};
	protocol: ProtocolRange;
	issuedAtMs: EpochMs;
	serverTimeMs: EpochMs;
}

/** Errors specific to the LAN pairing hop. Never sealed; they precede key agreement. */
export type PairingErrorCode =
	| "pair_version_unsupported"
	| "pair_wrong_peer"
	| "pair_bad_mac"
	| "pair_unreachable"
	| "pair_host_not_private"
	| "pair_window_closed"
	| "pair_rate_limited"
	| "unknown";

/** Ephemeral, in-memory-only state of the single open pairing window (§4.2). */
export interface PairingWindowState {
	pid: PairingId;
	/** 32 raw bytes. Zeroed on close. NEVER rendered, logged, or persisted. */
	pairingCode: Uint8Array;
	/** 16 raw bytes. */
	pairSalt: Uint8Array;
	dPub: Uint8Array;
	openedAtMs: EpochMs;
	expiresAtMs: EpochMs;
	/** 3 bad MACs burn the window. */
	failedMacAttempts: number;
	consumed: boolean;
}

// ---------------------------------------------------------------------------
// §5 device lifecycle
// ---------------------------------------------------------------------------

export type RevokeReason = "user" | "panic" | "repair" | "unknown";

export interface DeviceRecord {
	deviceId: DeviceId;
	/** User-visible on the desktop. */
	label: string;
	surface: Surface;
	pairedAtMs: EpochMs;
	lastSeenMs: EpochMs | null;
	/** Handle to the stored K_dev. NEVER the key itself. */
	keyRef: string;
	fcmToken: string | null;
	fcmTokenUpdatedMs: EpochMs | null;
	/** false after a panic `write_disable`. Re-enable is desktop-only. */
	writeEnabled: boolean;
	revokedAtMs: EpochMs | null;
	revokeReason: RevokeReason | null;
}

// ---------------------------------------------------------------------------
// §6 capability negotiation
// ---------------------------------------------------------------------------

/** Inclusive range, `min <= max`. */
export interface ProtocolRange {
	min: ProtocolVersion;
	max: ProtocolVersion;
}

/**
 * §6.4 — closed vocabulary for protocol 1. Unknown tokens are ignored by both
 * sides and are never an error (see `Capability`).
 */
export type KnownCapability =
	| "tree.read"
	| "transcript.read"
	| "question.read"
	| "events.ws"
	| "push.fcm"
	| "answer.single"
	| "answer.multi_question"
	| "answer.multiselect"
	| "answer.freetext"
	| "message.send"
	| "panic.write_disable"
	| "panic.unpair"
	| "agent.claude"
	/** NEVER granted in v1 — the Codex byte contract is not established. */
	| "agent.codex";

/**
 * §6.4 — closed vocabulary for protocol 1. Unknown tokens are ignored by both
 * sides and are never an error, hence the open tail.
 */
export type Capability = KnownCapability | (string & Record<never, never>);

export interface HelloRequest {
	client: {
		app: "superset-companion";
		/** semver of the Android app. */
		version: string;
		platform: "android";
		/** Build.VERSION.SDK_INT */
		sdkInt: number;
		surface: Surface;
		label: string;
	};
	protocol: ProtocolRange;
	/** What the CLIENT can do. */
	capabilities: Capability[];
}

export interface NegotiatedLimits {
	writesPerMin: number;
	readsPerMin: number;
	maxBodyBytes: number;
	transcriptPageMax: number;
	answerLeaseTtlMs: DurationMs;
	heartbeatIntervalMs: DurationMs;
}

export interface HelloResponse {
	/** Negotiated. `0` = the frozen degraded baseline (§6.1). */
	protocol: ProtocolVersion;
	/** true iff the ranges did not overlap. */
	degraded: boolean;
	bridge: {
		appVersion: string;
		hostServiceVersion: string;
		/** e.g. "desktop-v1.18.0" */
		forkTag: string;
		protocol: ProtocolRange;
	};
	capabilities: {
		/** intersection, in the bridge's ordering. */
		granted: Capability[];
		/** client asked, bridge cannot — the client hides those features. */
		unsupported: Capability[];
		/** bridge can, client did not ask — the client ignores these. */
		extra: Capability[];
	};
	limits: NegotiatedLimits;
	serverTimeMs: EpochMs;
	/** Re-hello required after this. 3 600 000. */
	sessionTtlMs: DurationMs;
	/**
	 * (ANSWER-LEDGER) The coverage epoch in force, so a client has one BEFORE its
	 * first answer rather than only after its first status read.
	 *
	 * This is not a convenience. Without it a freshly started process captures
	 * `null` for its first submit, and §11.5 is explicit that a null epoch can only
	 * ever yield `unconfirmed` — so that answer could never be resolved to the
	 * actionable "it was not sent". Android kills the phone process routinely, so
	 * "the first answer after a start" is a large share of real answers, not an edge
	 * case.
	 *
	 * Opaque: compared for equality by the bridge and never parsed by the client.
	 */
	coverageEpoch: string;
}

// ---------------------------------------------------------------------------
// §7.1 ping (the only unsealed endpoint)
// ---------------------------------------------------------------------------

/**
 * FIXED SHAPE. No per-device, per-workspace or per-question information may
 * ever be added here, not even "for diagnostics" (§7.1).
 */
export interface PingResponse {
	bridge: "superset-companion";
	envelope: EnvelopeVersion[];
	protocol: ProtocolRange;
	serverTimeMs: EpochMs;
}

// ---------------------------------------------------------------------------
// §7.2 tree
// ---------------------------------------------------------------------------

/**
 * §7.2 — three states only. There is no `green` / "ready for review" and there
 * never will be: the review axis lives in renderer storage the bridge cannot
 * reach, and synthesising it would be a lie.
 */
export type AgentStatus = "needs_input" | "working" | "idle" | "unknown";

export type ProjectKind = "git" | "multi_repo" | "plain" | "unknown";

export type AgentKind = "claude" | "codex" | "none" | "unknown";

/** The agent kind a question can originate from (never `none`). */
export type QuestionAgentKind = "claude" | "codex" | "unknown";

export interface TreeRequest {
	/**
	 * `generatedAtMs` of a previously held tree; the bridge MAY answer with a
	 * delta. `null` / absent = full tree.
	 */
	since?: EpochMs | null;
	/**
	 * Explicit on every request. There is no server-side default (no sensible
	 * defaults for missing values).
	 */
	includeIdle: boolean;
}

export interface StatusCounts {
	needsInput: number;
	working: number;
	idle: number;
}

export interface TreeResponse {
	generatedAtMs: EpochMs;
	/** false => this is a delta against the request's `since`. */
	complete: boolean;
	/** The global event sequence this tree is consistent with (§9.3). */
	gseq: number;
	projects: Project[];
	counts: StatusCounts;
	/**
	 * (CURATION-PROVENANCE) Why the tree looks the way it does.
	 *
	 * An empty `projects` array has two completely different causes that the
	 * payload could not previously tell apart: nothing on this machine is running
	 * an agent, or the sidebar mirror filtered everything out. The second is a
	 * BUG SHAPE — an over-broad mirror, a project set that lost its rows, a
	 * launch id that never advanced — and diagnosing it from the phone meant
	 * guessing, because the filter's inputs never crossed the wire.
	 *
	 * OPTIONAL, and it must stay optional: both shipped clients parse this
	 * response with unknown fields ignored and no field required beyond the ones
	 * they already read, so an older phone must keep parsing a newer bridge's
	 * tree. Nothing in the protocol may come to depend on it.
	 */
	curation?: TreeCurationInfo;
}

/** (CURATION-PROVENANCE) Diagnostic provenance for a `TreeResponse`. */
export interface TreeCurationInfo {
	/** false => the mirror was not filtering at all (never synced, aged out, other org). */
	enabled: boolean;
	/** Age of `sidebar_mirror_meta.last_full_sync_at_ms`, or null if there is no meta row. */
	lastSyncAgeMs: number | null;
	/** How many of this machine's workspaces the curation removed from the tree. */
	hiddenWorkspaces: number;
}

export interface Project {
	projectId: ProjectId;
	/** Repo / folder display name. NOTE the code-vs-user naming inversion (§7.2). */
	name: string;
	kind: ProjectKind;
	workspaces: Workspace[];
	/**
	 * (EMIT-OPTIONAL-FIELDS) `sidebar_project_state.is_pinned`. OPTIONAL, like
	 * every field added after a client shipped: both clients already parse this
	 * object ignoring unknown keys, and nothing in the protocol may come to
	 * depend on it. ABSENT when no curation is in force — absence of a mirrored
	 * row is absence of an opinion, and §7.2 distinguishes a field the bridge
	 * does not report from one it reports as `false`.
	 */
	pinned?: boolean;
}

export interface Workspace {
	workspaceId: WorkspaceId;
	/** Branch name, or the folder name when non-git. */
	name: string;
	branch: string | null;
	/** Rollup over this workspace's terminals. */
	status: AgentStatus;
	terminals: Terminal[];
	lastActivityMs: EpochMs | null;
	/**
	 * (EMIT-OPTIONAL-FIELDS) `sidebar_workspace_state.pinned_at != null`. Absent,
	 * never `false`, when no curation is in force.
	 */
	pinned?: boolean;
}

export interface TerminalAgentBinding {
	kind: AgentKind;
	/** false => a plain shell. Never writable (§7.5, §11.3). */
	bound: boolean;
	/** Present when the BLOCKING actor is a subagent. */
	subagent: { agentType: string } | null;
}

/** Present iff `status === "needs_input"` AND the question is readable (§7.4). */
export interface PendingQuestionRef {
	questionId: QuestionId;
	askedAtMs: EpochMs;
	/** false => needs an ungranted capability, or it is a Codex terminal. */
	answerable: boolean;
	/** The first question's `header`, <= 80 chars. NOT the question body. */
	headline: string;
	/**
	 * (EMIT-OPTIONAL-FIELDS) How many questions this one capture carries. The
	 * headline is the FIRST question's header only, so a client showing just the
	 * headline for a 3-question capture is quietly misrepresenting what answering
	 * it involves. OPTIONAL, like every field added after a client shipped.
	 */
	questionCount?: number;
	/**
	 * (EMIT-OPTIONAL-FIELDS) True when ANY item is multi-select. It changes what
	 * answering means — a multi-select item takes a set and has its own byte
	 * contract (§11.3) — so a client that renders single-select affordances for
	 * one is offering an interaction the bridge will refuse.
	 */
	multiSelect?: boolean;
}

export interface Terminal {
	terminalId: TerminalId;
	title: string;
	status: AgentStatus;
	agent: TerminalAgentBinding;
	pendingQuestion: PendingQuestionRef | null;
	lastActivityMs: EpochMs | null;
}

// ---------------------------------------------------------------------------
// §7.3 transcript
// ---------------------------------------------------------------------------

export type TranscriptRole =
	| "user"
	| "assistant"
	| "tool"
	| "system"
	| "unknown";

export interface TranscriptToolDetail {
	name: string;
	/** One line, for the collapsed chip. */
	summary: string;
	/** Full payload; MAY be omitted on large entries. */
	detail: string | null;
	detailTruncated: boolean;
}

export interface TranscriptEntry {
	/** Opaque, stable, the client's de-dup key. */
	entryId: string;
	tsMs: EpochMs;
	role: TranscriptRole;
	/** Markdown source, VERBATIM. The bridge never truncates and never scrubs. */
	text: string | null;
	/** Present iff `role === "tool"`. */
	tool: TranscriptToolDetail | null;
	/** true => the agent was mid-stream when this was read. */
	partial: boolean;
}

export interface TranscriptRequest {
	terminalId: TerminalId;
	/** Cursor from a previous page; `null` = newest page. */
	before?: string | null;
	/** 1..limits.transcriptPageMax. Explicit; no default. */
	limit: number;
}

export interface TranscriptResponse {
	terminalId: TerminalId;
	/** Oldest -> newest within the page. */
	entries: TranscriptEntry[];
	/** Pass as `before` for the previous (older) page. */
	nextCursor: string | null;
	hasMore: boolean;
	/**
	 * Increments on `/resume` or agent restart. A change means the client MUST
	 * discard cached entries for this terminal rather than merge across it.
	 */
	sessionGeneration: number;
}

// ---------------------------------------------------------------------------
// §7.4 question
// ---------------------------------------------------------------------------

export type QuestionState = "pending" | "resolved" | "stale" | "unknown";

export type QuestionOutcome = "answered" | "cancelled" | "expired" | "unknown";

export type UnanswerableReason =
	| "codex_agent"
	| "capability_missing"
	| "no_agent_binding"
	| "resolved"
	| "stale";

export interface ResolvedBy {
	deviceLabel: string | null;
	surface: ResolverSurface;
}

export interface QuestionOption {
	index: number;
	label: string;
	description: string;
}

export interface QuestionItem {
	/** 0-based, matches the picker's order. */
	index: number;
	header: string;
	/** FULL text. NEVER truncated by the bridge — median 1 412 chars. */
	question: string;
	multiSelect: boolean;
	options: QuestionOption[];
	/** The "other" slot; `index` === `options.length`. */
	freeTextOption: { index: number; label: string } | null;
}

export interface QuestionSource {
	projectId: ProjectId;
	workspaceId: WorkspaceId;
	terminalId: TerminalId;
	agentKind: QuestionAgentKind;
	subagent: { agentType: string } | null;
}

export interface QuestionRequest {
	questionId: QuestionId;
}

export interface QuestionResponse {
	questionId: QuestionId;
	/** Echo this on `/v1/answer`; a mismatch is `stale_question`. */
	fingerprint: Fingerprint;
	state: QuestionState;
	askedAtMs: EpochMs;
	resolvedAtMs: EpochMs | null;
	resolvedBy: ResolvedBy | null;
	source: QuestionSource;
	answerable: boolean;
	unanswerableReason: UnanswerableReason | null;
	/** 1..N. N > 1 is 59% of real traffic. */
	questions: QuestionItem[];
	/** The last 10 transcript entries, newest last, for the sheet. */
	context: TranscriptEntry[];
}

/** §9.4 — carried on the event stream. NO question body, NO option text. */
export interface QuestionSummary {
	questionId: QuestionId;
	fingerprint: Fingerprint;
	terminalId: TerminalId;
	workspaceId: WorkspaceId;
	projectId: ProjectId;
	askedAtMs: EpochMs;
	/** N in "several questions in one prompt". */
	questionCount: number;
	/** true if ANY item in the prompt is multi-select. */
	multiSelect: boolean;
	answerable: boolean;
	/** The first item's `header`, <= 80 chars. */
	headline: string;
}

// ---------------------------------------------------------------------------
// §7.5 message
// ---------------------------------------------------------------------------

export interface MessageRequest {
	terminalId: TerminalId;
	/**
	 * 1..8 192 chars, UTF-8.
	 *
	 * Validated at the boundary by the bridge (`assertMessageText`), not merely
	 * length-checked. The text must be well-formed Unicode (a lone surrogate would
	 * reach the pty as U+FFFD — silently mutated), must not be whitespace-only
	 * (there would be nothing to verify on screen and nothing worth sending), and
	 * must carry no CONTROL CHARACTER other than LF and TAB — where "control"
	 * means C0 (U+0000..U+001F), DEL (U+007F) and C1 (U+0080..U+009F), per
	 * PROTOCOL §0.3. Writing "C0" alone here would be incomplete rather than
	 * merely lenient: the scan refuses DEL and C1 too, and a client that trusted
	 * a C0-only reading would collect a `400 bad_request` after its user had
	 * already passed a biometric prompt.
	 *
	 * CR is refused because it would submit early, ESC because it would drive the
	 * TUI directly. LF and TAB are permitted HERE AND ONLY HERE because this path
	 * frames the body as a bracketed paste (`writeFramedInputToSession`), which is
	 * what carries them to a composer as literal content; the picker's inline
	 * editor is driven by raw keystrokes, so an `AnswerItem` free-text body
	 * permits no control character at all (`FREETEXT_ALLOWED_C0` is empty).
	 */
	text: string;
	/** UUIDv4, client-minted, idempotency key. */
	requestId: RequestId;
	/** MUST be true — free text requires biometric confirmation. */
	confirmedBiometric: boolean;
}

export interface MessageResponse {
	/**
	 * `unconfirmed` is REACHABLE and terminal for the client (§7.5: never
	 * re-send). It covers the case where the text was framed into the composer but
	 * the trailing submit was withheld or failed — the message may be sitting
	 * unsent in the composer, which only the desk can resolve.
	 */
	status: "sent" | "unconfirmed";
	requestId: RequestId;
	sentAtMs: EpochMs | null;
}

// ---------------------------------------------------------------------------
// §7.6 device register
// ---------------------------------------------------------------------------

export interface RegisterRequest {
	/** Secret-ish. Only ever inside a sealed body. */
	fcmToken: string;
	surface: Surface;
	appVersion: string;
	/** The token being rotated out, if known. */
	replacesToken: string | null;
}

export interface RegisterResponse {
	deviceId: DeviceId;
	registeredAtMs: EpochMs;
	/**
	 * (PUSH-PRESENCE) ALWAYS 0, AND THE FIELD IS KEPT ON PURPOSE.
	 *
	 * §13.2's 180 000 ms delay is gone: the desktop now decides per question,
	 * from presence, whether to push immediately or hold indefinitely, so there
	 * is no delay left to advertise. The field stays on the wire because paired
	 * phones already parse it (`Session.kt` in superset-companion), and removing
	 * it would break every installed client's register response for a value they
	 * can simply be told is zero.
	 *
	 * Zero is the honest answer rather than a placeholder: it is exactly the delay
	 * a client should assume before a notification can arrive.
	 */
	pushDelayMs: DurationMs;
	/** 900 000. */
	pushTtlMs: DurationMs;
}

// ---------------------------------------------------------------------------
// §7.7 heartbeat
// ---------------------------------------------------------------------------

export interface HeartbeatRequest {
	/** Highest `gseq` the client has processed. */
	lastEventGseq: number | null;
	/**
	 * Whether the app is in the FOREGROUND right now.
	 *
	 * §7.7's `nextIntervalMs` is specified as "60 000 foreground / 300 000
	 * background", which makes the choice the bridge's — but the bridge has no
	 * other way to know which the client is in, so without this field the 300 000
	 * value is unreachable by construction and the client's liveness watchdog
	 * (3 x the bridge-supplied interval) tightens to 180 s while a backgrounded
	 * phone heartbeats every 300 s: a structurally guaranteed false "lost contact
	 * with the desktop".
	 *
	 * `null` means the client did not state it — an older build. The bridge then
	 * answers with the FOREGROUND interval, which is the strict direction (a
	 * shorter watchdog window over-reports rather than under-reports), and logs
	 * it. It is not a default standing in for a value the client had: `null` is
	 * the explicit "unstated" member of the domain.
	 */
	foreground: boolean | null;
}

export interface HeartbeatResponse {
	serverTimeMs: EpochMs;
	/** 60 000 foreground / 300 000 background. */
	nextIntervalMs: DurationMs;
	revoked: boolean;
	writeEnabled: boolean;
	counts: StatusCounts;
	/** Age of the oldest pending question. */
	oldestUnansweredMs: DurationMs | null;
	/** true => the client's gseq is behind; refetch the tree. */
	treeStale: boolean;
	/** A change means the bridge restarted => the client must re-hello (§6.3). */
	bridgeStartedMs: EpochMs;
}

// ---------------------------------------------------------------------------
// §7.8 panic
// ---------------------------------------------------------------------------

/** There is deliberately no `write_enable`: the phone can only reduce its own privilege. */
export type PanicMode = "write_disable" | "unpair_device" | "unpair_all";

export interface PanicRequest {
	mode: PanicMode;
	/** Free text, 0..200 chars, recorded in the audit log. */
	reason: string;
	/** UUIDv4, idempotency key. */
	requestId: RequestId;
}

export interface PanicResponse {
	mode: PanicMode;
	appliedAtMs: EpochMs;
	devicesAffected: number;
}

// ---------------------------------------------------------------------------
// §11 answer
// ---------------------------------------------------------------------------

export type AnswerItem =
	| { questionIndex: number; kind: "select"; optionIndex: number }
	| { questionIndex: number; kind: "multiselect"; optionIndexes: number[] }
	| { questionIndex: number; kind: "freetext"; text: string };

export type AnswerItemKind = AnswerItem["kind"];

export interface AnswerRequest {
	questionId: QuestionId;
	/** From §7.4. A mismatch is `stale_question` and NOTHING is written. */
	fingerprint: Fingerprint;
	/** UUIDv4, client-minted, STABLE for this answer attempt. */
	requestId: RequestId;
	/** One per QuestionItem, in `index` order, ALL of them. Partial answers do not exist. */
	answers: AnswerItem[];
	/** Legacy client claim. Accepted when present, but never required or trusted. */
	confirmedBiometric?: boolean;
	surface: Surface;
}

export interface AnswerResponse {
	status: "confirmed" | "unconfirmed";
	requestId: RequestId;
	questionId: QuestionId;
	leaseId: LeaseId;
	/** Set iff `status === "confirmed"`. */
	resolvedAtMs: EpochMs | null;
	/**
	 * The guards that passed, for the audit trail the client shows.
	 *
	 * `(ANSWER-GUARDLESS)` evaluates no guards, so a response this build
	 * produces carries `[]`. A §11.4 replay of a row written by an older
	 * bridge still reports that row's stored list verbatim.
	 */
	guardsPassed: AnswerGuardName[];
	/**
	 * Guards that were CARRIED without reading positively — disjoint from
	 * `guardsPassed`, and never folded into it. `(ANSWER-GUARDLESS)` never
	 * populates it; the field stays on the wire because installed clients
	 * decode it and because a replay must still be able to describe a legacy row.
	 *
	 * NULLABLE, and the null is load-bearing: it means THIS RESPONSE CANNOT SAY,
	 * which a §11.4 replay reconstructed from a non-`confirmed` ledger row
	 * genuinely cannot (see `replayedGuardsAbstained`). `[]` is reserved for the
	 * positive claim "nothing abstained" — using it for "unknown" is how the
	 * replay path came to assert, on every reconstructed response, something it
	 * had no evidence for.
	 */
	guardsAbstained: AnswerGuardName[] | null;
}

export interface AnswerStatusRequest {
	requestId: RequestId;
	/**
	 * (ANSWER-LEDGER) The coverage epoch the client captured BEFORE it submitted.
	 *
	 * Opaque to the client: it is compared for equality and never parsed, ordered
	 * or aged. Null from a client that holds none — an older build, or one whose
	 * process died since the write — which can then only be answered with
	 * `unconfirmed` for a missing record. Safe, and the reason the field is NULLABLE.
	 *
	 * It is nullable but NOT optional, and the distinction is load-bearing: the Zod
	 * schema once omitted the field entirely, so it was stripped from every request
	 * while a cast told TypeScript it had survived, and the whole terminal-negative
	 * path became unreachable in live traffic without a single test failing. A body
	 * that omits the key is now a 400 — `(STATUS-EPOCH-BOUNDARY)` in `http.ts` — so
	 * the wire contract stays explicit and the client sends `null` deliberately
	 * rather than by absence. Do not add `.optional()` to that schema.
	 */
	coverageEpoch: string | null;
}

/**
 * §11.5 — a READ. Safe to retry and poll. It is what replaces a write retry.
 *
 * (COVERAGE-CONTRACT) THE SERVER DECIDES; THE CLIENT RENDERS. This used to publish
 * three instants — `serverTimeMs`, `recordsSinceMs`, `bridgeStartedMs` — and leave
 * the client to prove "nothing was ever sent" by comparing a server-derived
 * wall-clock age against its own monotonic elapsed time. Two things were wrong
 * with that, and neither was fixable by better arithmetic:
 *
 *  - the arithmetic mixed clocks. A FORWARD step of the desktop clock inflated the
 *    apparent coverage, so a request the bridge could not vouch for satisfied the
 *    inequality and the client rendered the unrecoverable "it was not sent".
 *  - more fundamentally, no arithmetic over the PAST can license that claim at all.
 *    A status read can overtake an answer that was already admitted but has not yet
 *    recorded itself, and absence then says nothing about whether it is about to
 *    type. See `attempt-ledger.ts`.
 *
 * So the verdict is now computed where the state is, behind a durable fence, and
 * arrives as ONE discriminated `outcome`. A client that renders `outcome` verbatim
 * cannot construct a wrong verdict, because it is no longer doing the proving.
 */
export type AnswerStatusOutcome =
	/**
	 * The bridge holds a record. `status` is its own, reported regardless of
	 * coverage — a present record never depended on any of this.
	 */
	| {
			kind: "known";
			status: "claimed" | "in_flight" | "confirmed" | "failed" | "unconfirmed";
			questionId: QuestionId | null;
			resolvedAtMs: EpochMs | null;
			failureCode: AttemptFailureCode | null;
	  }
	/**
	 * PROVEN never received, and terminal. Only ever returned after the bridge has
	 * durably fenced the requestId, so the answer path is now bound to refuse it —
	 * which is what makes this honest rather than a guess about the future.
	 */
	| { kind: "not_received" }
	/**
	 * Nothing can be asserted. The client MUST render this as unconfirmed and never
	 * as failed: §11.4 records a second answer against a picker as unrecoverable,
	 * so "I cannot tell" is always the safe verdict. `why` is diagnostic text for
	 * the log, never a verdict to show.
	 */
	| { kind: "unconfirmed"; why: string };

export interface AnswerStatusResponse {
	requestId: RequestId;
	/** The whole verdict. Render it; do not re-derive it. */
	outcome: AnswerStatusOutcome;
	/**
	 * The epoch in force NOW, so a client whose captured token has gone stale can
	 * adopt the current one for subsequent submissions without a second round trip.
	 */
	coverageEpoch: string;
}

/** §11.3 — the six guards, as evaluated, inside the one critical section. */
export type GuardEvaluation = Record<AnswerGuardName, boolean>;

/** §11.4 — one lease per `questionId`, covering EVERY keystroke of the prompt. */
export interface AnswerLease {
	leaseId: LeaseId;
	questionId: QuestionId;
	deviceId: DeviceId;
	surface: Surface;
	acquiredAtMs: EpochMs;
	/** Extended to `now + answerLeaseTtlMs` after each successful keystroke. */
	expiresAtMs: EpochMs;
}

/**
 * The failure codes an attempt record may carry, as a TYPE.
 *
 * WIDENED FROM TWO CODES TO THE SEALED SET, and the reason is the fence. When the
 * durable claim moved to the top of `handleAnswer` (ANSWER-LEDGER), a request became
 * recordable for reasons the old store never saw: the panic write-disable, a stale
 * question, a lost lease, an unusable agent binding. §11.4 says a replay returns the
 * RECORDED outcome, so storing `internal` for a `write_disabled` refusal would make
 * that replay lie about why it failed.
 *
 * The old narrowness bought something real and it is worth recording what was given
 * up: the JSON store validated its file as a WHOLE, so one unrecognised code
 * quarantined every OTHER record's 24 h, which made "widen this at a call site" a
 * change whose cost landed on a different request hours later. The ledger validates
 * ROW BY ROW, so an unrecognised code now costs exactly the one requestId that
 * carries it — which is what makes widening safe rather than merely convenient.
 *
 * `LEDGER_FAILURE_CODES` in `attempt-ledger.ts` is the runtime half and must be
 * widened with this union; `satisfies readonly SealedErrorCode[]` ties both to §10.
 */
export type AttemptFailureCode = Extract<
	ErrorCode,
	| "stale_question"
	| "already_resolved"
	| "request_closed"
	| "lease_held"
	| "guard_failed"
	| "picker_open"
	| "capability_unsupported"
	| "write_disabled"
	| "bad_request"
	| "internal"
>;

/** §11.5 — the 24 h idempotency + outcome record keyed by `requestId`. */
export interface AnswerAttemptRecord {
	requestId: RequestId;
	questionId: QuestionId;
	deviceId: DeviceId;
	surface: Surface;
	leaseId: LeaseId;
	startedAtMs: EpochMs;
	/**
	 * The four real outcomes, and only those.
	 *
	 * This used to be derived from the wire response's `status` minus `"unknown"`.
	 * It no longer can be: (ANSWER-LEDGER) replaced that field with a discriminated
	 * `outcome`, and the persisted set now also carries `closed_not_received`, which
	 * is a FENCE rather than an outcome and must never be written here. Stating the
	 * four explicitly is what keeps a record the bridge wrote unambiguous — writing
	 * `unknown` or a tombstone into one would manufacture the ambiguity §11.5 exists
	 * to remove.
	 */
	status: "in_flight" | "confirmed" | "failed" | "unconfirmed";
	resolvedAtMs: EpochMs | null;
	failureCode: AttemptFailureCode | null;
	guardsPassed: AnswerGuardName[];
	/** Disjoint from `guardsPassed`. See `AnswerResponse`. */
	guardsAbstained: AnswerGuardName[];
}

// ---------------------------------------------------------------------------
// §9 event stream
// ---------------------------------------------------------------------------

export interface EventTicketRequest {
	/** Resume point; `null` = no replay wanted. */
	since: number | null;
}

export interface EventTicketResponse {
	ticket: Ticket;
	/** 12 bytes, bound into every frame's AAD (§3.3). */
	streamSeed: Base64Url;
	/** 22 chars, feeds the K_evt derivation (§3.1). */
	ticketId: Base64Url;
	expiresInMs: DurationMs;
	/** 1. A second live socket closes the OLDER one with 1008. */
	maxConnections: number;
}

export type EventType =
	| "snapshot"
	| "status"
	| "question.pending"
	| "question.resolved"
	| "question.stale"
	| "terminal.added"
	| "terminal.removed"
	| "workspace.changed"
	| "tree.curation"
	| "capability.changed"
	| "revoked"
	| "heartbeat";

export type SnapshotEventData = TreeResponse & {
	pendingQuestions: QuestionSummary[];
	/** true => the missed events since the ticket's `since` follow this frame. */
	replayed: boolean;
};

export interface StatusEventData {
	terminalId: TerminalId;
	workspaceId: WorkspaceId;
	status: AgentStatus;
	prevStatus: AgentStatus;
}

export interface QuestionResolvedEventData {
	questionId: QuestionId;
	resolvedAtMs: EpochMs;
	resolvedBy: ResolvedBy;
	outcome: QuestionOutcome;
}

export interface QuestionStaleEventData {
	questionId: QuestionId;
	reason: string;
}

export type TerminalAddedEventData = Terminal & { workspaceId: WorkspaceId };

export interface TerminalRemovedEventData {
	terminalId: TerminalId;
}

export type WorkspaceChangedEventData = Workspace & { projectId: ProjectId };

/**
 * (MIRROR-CHANGE-GSEQ) The desktop sidebar's curation changed, so the tree the
 * client is holding may no longer describe what the sidebar shows.
 *
 * Deliberately CARRIES NO CURATION. The mirror is a whole-snapshot replace of
 * membership, placement, pinning and five hiding fields across every thread;
 * a delta on the wire would be a second, independently wrong description of it.
 * The frame's job is to move `gseq`, which is what makes the next heartbeat
 * report `treeStale` and the client refetch `/v1/tree` — the one surface that
 * reads the mirror.
 *
 * The counts are diagnostic only: they say how big the snapshot that changed
 * was, which is what distinguishes "the user binned a thread" from "the
 * renderer just came up and published its first snapshot".
 */
export interface TreeCurationEventData {
	syncedAtMs: EpochMs;
	workspaceCount: number;
	projectCount: number;
}

export interface CapabilityChangedEventData {
	granted: Capability[];
	unsupported: Capability[];
}

export interface RevokedEventData {
	reason: RevokeReason;
}

export interface HeartbeatEventData {
	serverTimeMs: EpochMs;
	counts: StatusCounts;
}

/** Discriminated by `t`. The FIRST frame of every socket is always `snapshot`, `seq: 1`. */
export type EventFrame =
	| EventFrameOf<"snapshot", SnapshotEventData>
	| EventFrameOf<"status", StatusEventData>
	| EventFrameOf<"question.pending", QuestionSummary>
	| EventFrameOf<"question.resolved", QuestionResolvedEventData>
	| EventFrameOf<"question.stale", QuestionStaleEventData>
	| EventFrameOf<"terminal.added", TerminalAddedEventData>
	| EventFrameOf<"terminal.removed", TerminalRemovedEventData>
	| EventFrameOf<"workspace.changed", WorkspaceChangedEventData>
	| EventFrameOf<"tree.curation", TreeCurationEventData>
	| EventFrameOf<"capability.changed", CapabilityChangedEventData>
	| EventFrameOf<"revoked", RevokedEventData>
	| EventFrameOf<"heartbeat", HeartbeatEventData>;

export interface EventFrameOf<T extends EventType, D> {
	/** 16 chars — the client's de-duplication key. */
	eid: EventId;
	/** Global, monotonic per bridge boot, GAP-FREE. A jump > 1 means the client must refetch. */
	gseq: number;
	/** Per-socket, monotonic from 1, gap-free. Also bound into the AAD. */
	seq: number;
	tsMs: EpochMs;
	t: T;
	d: D;
}

/**
 * §1.3 — the ONLY two client -> server frames the bridge may accept. Anything
 * else closes the socket with 1008 and is never parsed or dispatched.
 */
export type ClientFrame = { t: "ack"; seq: number } | { t: "pong"; ts: number };

// ---------------------------------------------------------------------------
// §12 rate limits
// ---------------------------------------------------------------------------

export type RateBucket =
	| "writes"
	| "reads"
	| "panic"
	| "ping"
	| "pairing"
	| "preauth";

export interface RateLimitDecision {
	allowed: boolean;
	bucket: RateBucket;
	/** Authoritative when `allowed === false`. */
	retryAfterMs: DurationMs | null;
}

// ---------------------------------------------------------------------------
// §13 push (FCM)
// ---------------------------------------------------------------------------

/**
 * §13.1 — the CLOSED key set. No question text, no option text, no workspace,
 * branch, project or file name, and no free text of any kind may EVER appear
 * here. Every value must match /^[A-Za-z0-9_-]{1,43}$/, which no natural-language
 * string satisfies; the bridge asserts that at runtime and THROWS on violation.
 */
export interface PushData {
	/** payload version, `"1"`. */
	v: "1";
	/** `"q"` = question pending, `"r"` = retract. */
	k: "q" | "r";
	/** questionId, 22 chars, opaque. */
	i: QuestionId;
	/** workspaceId, 22 chars, opaque. */
	w: WorkspaceId;
	/** number of questions in the prompt, `"0"`..`"99"` (`"0"` on a retraction). */
	n: string;
	/** expiry, 13 digits. */
	x: string;
}

/** Data-only. `message.notification` MUST be absent (§13.1). */
export interface PushEnvelope {
	token: string;
	android: {
		priority: "high";
		ttl: string;
		/** questionId — the retraction reuses it. */
		collapse_key: string;
	};
	data: PushData;
}

// ---------------------------------------------------------------------------
// §14 audit log
// ---------------------------------------------------------------------------

export type AuditKind = "answer" | "message" | "panic" | "pair" | "revoke";

export type AuditOutcome = "attempted" | "confirmed" | "failed" | "unconfirmed";

/**
 * Appended BEFORE the write executes, then again with the terminal outcome —
 * two lines per write, fsync'd. The plaintext body is HASHED, never stored: the
 * log must not become a transcript of everything typed into terminals.
 */
export interface AuditEntry {
	tsMs: EpochMs;
	kind: AuditKind;
	deviceId: DeviceId;
	surface: Surface;
	requestId: RequestId;
	leaseId: LeaseId | null;
	questionId: QuestionId | null;
	terminalId: TerminalId | null;
	/**
	 * The guards, as evaluated. `(ANSWER-GUARDLESS)` always writes `null` —
	 * there is no stack to evaluate — and the field is retained so lines written
	 * by older bridge versions stay readable.
	 */
	guards: GuardEvaluation | null;
	/**
	 * Which of them were carried on a non-positive reading, or `null` for a line
	 * written without a stack at all — which is every line this build writes. It
	 * is stated rather than inferred from `guards`, because "read false and
	 * abstained" and "read false and refused" produce the same `guards` and only
	 * one of them wrote bytes.
	 */
	guardsAbstained: AnswerGuardName[] | null;
	/** SHA-256 of the plaintext body, base64url. */
	payloadHash: Base64Url;
	outcome: AuditOutcome;
	failureCode: ErrorCode | null;
}

// ---------------------------------------------------------------------------
// dispatch plumbing (bridge-internal, not on the wire)
// ---------------------------------------------------------------------------

/** Every sealed operation is a POST; the path IS the operation (§1.2). */
export type SealedPath =
	| "/v1/session/hello"
	| "/v1/tree"
	| "/v1/transcript"
	| "/v1/question"
	| "/v1/answer"
	| "/v1/answer/status"
	| "/v1/message"
	| "/v1/device/register"
	| "/v1/heartbeat"
	| "/v1/panic"
	| "/v1/events/ticket";

/** §1.3 — reads mutate nothing and may be retried; writes may NEVER be retried. */
export type OperationClass = "read" | "write" | "panic";

/** Validated Cloudflare Access assertion (§2.1). All six checks passed. */
export interface AccessClaims {
	iss: string;
	aud: string[];
	exp: number;
	iat: number;
	nbf?: number;
	/** The service-token client id. Absent for interactive logins, which are rejected. */
	common_name: string;
}

/** The authenticated context every sealed handler runs with. */
export interface SealedRequestContext {
	path: SealedPath;
	device: DeviceRecord;
	protocolVersion: ProtocolVersion;
	/** Granted capabilities for this device's current session (§6.2). */
	granted: readonly Capability[];
	/** The request's 12 nonce bytes — bound into the response AAD (§3.3). */
	requestNonce: Uint8Array;
	receivedAtMs: EpochMs;
	access: AccessClaims;
}

/** What a handler returns; the transport seals it and builds the response AAD. */
export interface SealedResult<T> {
	statusCode: number;
	body: T;
}

/** A failure that must be sealed before it leaves the bridge (§3.6). */
export class SealedError extends Error {
	constructor(
		readonly statusCode: number,
		readonly body: ErrorBody,
	) {
		super(`${body.code}: ${body.message}`);
		this.name = "SealedError";
	}
}

/** A failure that happens before a key is available and is emitted in cleartext (§3.6). */
export class CleartextError extends Error {
	constructor(
		readonly statusCode: number,
		readonly code: CleartextErrorCode,
		readonly retryAfterMs: DurationMs | null = null,
	) {
		super(code);
		this.name = "CleartextError";
	}
}
