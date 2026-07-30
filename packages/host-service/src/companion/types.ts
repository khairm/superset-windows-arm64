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

/** §11.3 guard 1..6, plus the two message-path guards of §7.5. */
export type AnswerGuardName =
	| "transcript"
	| "binding"
	| "session"
	| "permission_axis"
	| "screen"
	| "askq_marker";

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
}

export interface Project {
	projectId: ProjectId;
	/** Repo / folder display name. NOTE the code-vs-user naming inversion (§7.2). */
	name: string;
	kind: ProjectKind;
	workspaces: Workspace[];
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
	/** 180 000 — see §13.2. */
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
	/** MUST be true if any item is `freetext`. */
	confirmedBiometric: boolean;
	surface: Surface;
}

export interface AnswerResponse {
	status: "confirmed" | "unconfirmed";
	requestId: RequestId;
	questionId: QuestionId;
	leaseId: LeaseId;
	/** Set iff `status === "confirmed"`. */
	resolvedAtMs: EpochMs | null;
	/** The guards that passed, for the audit trail the client shows. */
	guardsPassed: AnswerGuardName[];
}

export interface AnswerStatusRequest {
	requestId: RequestId;
}

/** §11.5 — a READ. Safe to retry and poll. It is what replaces a write retry. */
export interface AnswerStatusResponse {
	requestId: RequestId;
	/**
	 * false => this bridge has no record of that requestId.
	 *
	 * §11.5 makes it an assertion that NOTHING WAS SENT. That assertion is only
	 * true for a request the bridge would still have a record of, so the range in
	 * which it holds is stated on the wire rather than assumed: see
	 * `recordsSinceMs`. Outside that range `known: false` means "no record", and
	 * §11.5 requires the client to render it as `unconfirmed` — never as failed.
	 *
	 * The attempt store used to be an in-memory Map built in `start()`, so a
	 * desktop restart emptied it and every earlier requestId came back false and
	 * was rendered "it was not sent". It is now written `tmp -> fsync -> rename`
	 * on every put and hydrated at start, with the `in_flight` put awaited BEFORE
	 * the terminal lock — so no answer can reach a terminal without a durable
	 * record, and the 24 h retention §11.5 promises is real.
	 */
	known: boolean;
	/**
	 * The answer's outcome so far. This table is PROTOCOL.md §11.5's, reproduced
	 * rather than paraphrased — an earlier paraphrase here said `unconfirmed` was
	 * terminal and `unknown` meant "keep polling", which is the inverse of §11.5
	 * on both rows and of what the shipped client implements. Two normative tables
	 * that disagree cannot both be satisfied, so this one quotes:
	 *
	 *  | value         | terminal? | the client MUST                            |
	 *  |---------------|-----------|--------------------------------------------|
	 *  | `confirmed`   | **yes**   | show confirmed (§11.6)                      |
	 *  | `failed`      | **yes**   | show failed, with `failureCode`             |
	 *  | `in_flight`   | **no**    | show pending and KEEP POLLING               |
	 *  | `unconfirmed` | no        | show unconfirmed verbatim; NEVER re-send    |
	 *  | `unknown`     | no        | treat exactly as `unconfirmed`; never failed|
	 *
	 * "Terminal" here means "renderable as a final outcome". `unconfirmed` and
	 * `unknown` are not terminal in the sense that a later read may still resolve
	 * them, but neither obliges continued polling and NEITHER may ever be rendered
	 * as `failed`. `in_flight` is the one row that obliges the client to keep
	 * reading.
	 *
	 * (ANSWER-INFLIGHT) `in_flight` means the lease is held and keystrokes are
	 * being typed into the picker RIGHT NOW. It exists because the attempt record
	 * used to be written only AFTER the injection returned, so for up to
	 * `LOCK_WAIT_TIMEOUT_MS + SEQUENCE_DEADLINE_MS` (~15 s) this endpoint answered
	 * `known: false` — documented and rendered as "not sent" — for an answer that
	 * was actively landing. That is the one window §11.5 exists to cover, and it
	 * lied in it.
	 *
	 * Do NOT collapse `in_flight` into `unconfirmed`: the client treats
	 * `unconfirmed` as an end state and stops reading, so collapsing it
	 * re-introduces the exact lie §11.5 exists to prevent, in the direction that
	 * makes the user re-answer a question that already succeeded.
	 *
	 * FORWARD COMPATIBILITY, normative for every client. This union is the set a
	 * CURRENT build understands, not the set that will ever be sent — protocol 1's
	 * global rule is that an unknown enum value degrades to the documented
	 * `unknown` member, which §11.6 resolves to `unconfirmed`. A client that maps
	 * an unrecognised status onto a terminal `failed` is not failing loud, it is
	 * failing WRONG: it reports a hard failure for a status meaning "this build
	 * does not understand the answer", and sends the user to re-answer a question
	 * that may already have landed. Any future member this build does not know
	 * MUST degrade to `unknown` — never to a terminal failure.
	 */
	status: "confirmed" | "failed" | "unconfirmed" | "in_flight" | "unknown";
	questionId: QuestionId | null;
	resolvedAtMs: EpochMs | null;
	/** A §10 code when `status === "failed"`. */
	failureCode: ErrorCode | null;
	/**
	 * The bridge's wall clock when this response was built. Same meaning as
	 * `HeartbeatResponse.serverTimeMs`, and present here so the two fields below
	 * can be compared as AGES rather than against a phone clock that is allowed
	 * to disagree with the desktop's.
	 */
	serverTimeMs: EpochMs;
	/**
	 * The instant from which `known: false` PROVES the request never arrived.
	 *
	 * (COVERAGE-CONTRACT) THIS IS THE CANONICAL STATEMENT of these semantics on the
	 * TypeScript side, and `PROTOCOL.md` §11.5 is the canonical one for the wire —
	 * it has to stand alone, because a client author reads the spec, not this file.
	 * `answer.ts` and `index.ts` deliberately POINT HERE rather than restating it.
	 * That is not stylistic: the same explanation previously existed in four places
	 * and five copies of one sentence went stale inside the very commit that
	 * corrected it. If these semantics change, this comment and §11.5 are the two
	 * that must be rewritten; anything else should be a pointer.
	 *
	 * THE BRIDGE'S GUARANTEE. For every answer attempt this bridge admitted whose
	 * attempt began at or after `recordsSinceMs`, a record exists — the record is
	 * written durably before the terminal lock is taken, so no keystroke can reach
	 * a terminal without one. The value is `max(the store's PROVEN coverage start,
	 * serverTimeMs − 24 h retention)`, so it also moves forward as old records are
	 * pruned.
	 *
	 * IT REACHES BACK PAST THE CURRENT LIFETIME WHENEVER THE STORE CAN PROVE ITS
	 * OWN FILE IS CURRENT — AND IT IS THE `known: false` BRANCH THAT NEEDS THIS,
	 * NOT THE OTHER ONE. Be exact about that, because the intuitive reading is
	 * wrong and was written down wrong here for a while: a PRESENT record already
	 * survived a restart without any of this, since the store is durable and
	 * `handleAnswerStatus` returns the record's own `status` whenever it finds one.
	 * Nothing about the witness makes a landed answer read `confirmed`; it already
	 * did. What this field governs is the ABSENT record — the claim that nothing
	 * was ever sent — and before the witness that claim could only be made about
	 * the current lifetime, so a pre-restart request with no record decayed to
	 * `unconfirmed` even when it genuinely never arrived.
	 *
	 * What reaching back required is a second file: `writeFileDurable` cannot force
	 * a directory entry on win32 (see `syncDirectory`), so a hard reset can discard
	 * the store's most recent rename and revert the file to an earlier version —
	 * and the reverted file carries the same first-recording stamp as the version
	 * that was lost, so it cannot declare its own gap. The missing records would sit
	 * INSIDE a window still claiming to cover them, which is the "it was not sent"
	 * lie this field exists to remove. `(ATTEMPT-WITNESS)` in `answer.ts` is the
	 * rise-only witness that makes that revert DETECTABLE rather than believed,
	 * which is the only reason the file's own stamp may be published.
	 *
	 * WHEN THE WITNESS CANNOT PROVE IT — the file was rolled back, the witness is
	 * missing, unreadable, or bound to another install, or the file predates the
	 * witness and so was never witnessable — this value DEGRADES to the instant the
	 * current lifetime opened the store, which is exactly what it always
	 * used to be: a rollback needs a crash and therefore a restart, so a window
	 * starting at this mount is one a rollback can never reach behind. Records
	 * already in the file are still returned in every case; degrading narrows what a
	 * MISSING record proves, never what a present one says. The client's rule below
	 * is unchanged either way — it reads this field and does not need to know which
	 * case produced it.
	 *
	 * THE CLIENT'S OBLIGATION. `known: false` may be rendered as "it was not
	 * sent" ONLY if the client can show its own submit happened at or after this
	 * instant. The skew-free comparison is on ages:
	 *
	 *     coverageAgeMs = serverTimeMs - recordsSinceMs
	 *     submitAgeMs   = (client's own elapsed time since it sent the answer)
	 *     provably-not-sent  <=>  coverageAgeMs > submitAgeMs
	 *
	 * Otherwise the correct outcome is `unconfirmed` ("the desktop's records do
	 * not reach back to when this was sent"), NEVER `failed`: a request older
	 * than the coverage may well have landed, and §11.4 says a second answer
	 * against a picker is unrecoverable.
	 */
	recordsSinceMs: EpochMs;
	/**
	 * When this bridge lifetime began (§6.3, identical to
	 * `HeartbeatResponse.bridgeStartedMs`).
	 *
	 * A CONSERVATIVE version of the same proof: if the client's submit predates it,
	 * the bridge has restarted since, and gating "not sent" on this alone is always
	 * SAFE. It is no longer EQUIVALENT, and that is the one thing a client author
	 * has to know: `recordsSinceMs` may now be EARLIER than this field, because the
	 * durable store proves coverage across restarts (see `recordsSinceMs`). What a
	 * client that gates on `bridgeStartedMs` alone forfeits is NOT any `confirmed`
	 * status — those come back whenever the record exists, restart or not — but the
	 * ability to resolve a MISSING pre-restart record. Such a request stays
	 * `unconfirmed` ("I cannot tell you") rather than resolving to the actionable
	 * terminal "it never arrived": wrong in the harmless direction, but the exact
	 * loss the durable store and its witness were built to end. Prefer
	 * `recordsSinceMs`; this field remains on the response for a client that gates
	 * on lifetime continuity alone, and as the §6.3 re-hello trigger.
	 */
	bridgeStartedMs: EpochMs;
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
 * The only failure codes an attempt record may carry, as a TYPE.
 *
 * The on-disk schema validates against the same two values (`ATTEMPT_FAILURE_CODES`
 * in `answer.ts`), and a record carrying anything else fails the whole-file parse
 * at the next start — which quarantines the file and costs every OTHER record its
 * 24 h of coverage. That made "widen `failureCode` at a call site" a change whose
 * cost lands on a different request, hours later, so it is a COMPILE error here
 * rather than a runtime discovery: a new code has to be added to this union and to
 * `ATTEMPT_FAILURE_CODES` together, or nothing builds.
 */
export type AttemptFailureCode = Extract<
	ErrorCode,
	"guard_failed" | "internal"
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
	 * `unknown` is deliberately NOT storable. It is the wire's degrade-to member
	 * for a status the READER does not recognise; a record that the bridge itself
	 * wrote always knows which of the four real outcomes it is in, and writing
	 * `unknown` into one would manufacture the ambiguity §11.5 exists to remove.
	 */
	status: Exclude<AnswerStatusResponse["status"], "unknown">;
	resolvedAtMs: EpochMs | null;
	failureCode: AttemptFailureCode | null;
	guardsPassed: AnswerGuardName[];
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
	/** The six guards, as evaluated. */
	guards: GuardEvaluation | null;
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
