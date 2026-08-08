/**
 * (COMPANION-BRIDGE) — the loopback HTTP listener and sealed dispatch (§1, §3, §12).
 *
 * Binds 127.0.0.1:47610 ONLY. It must never bind 0.0.0.0 (the LAN pairing
 * listener in pairing.ts is a different socket with a 120 s lifetime). If 47610
 * is occupied at startup the bridge FAILS LOUD and marks the companion feature
 * unavailable — it never picks another port, because cloudflared's static
 * ingress rule would then point at nothing and the user would see an
 * unexplained "phone says offline".
 *
 * Fixed pipeline order, NORMATIVE:
 *   Access JWT (§2.1, fails closed)
 *     -> pre-auth rate tier keyed on the Access client id (§12)
 *     -> bound the body BEFORE reading it (§0 -> 413)
 *     -> parse envelope header (§3.2)
 *     -> freshness window (§3.5)
 *     -> nonce cache admit, fsync'd BEFORE dispatch (§3.5)
 *     -> device lookup + AES-GCM open (§3.1)
 *     -> post-auth rate tier keyed on the authenticated deviceId (§12)
 *     -> revocation / protocol-0 / write-disable gates (§5.1, §6.1)
 *     -> schema validation at the boundary (§7, §11.2)
 *     -> capability check (§6.4)
 *     -> free-text user-presence policy (§7.5, §11.2)
 *     -> handler
 *     -> seal the response with the request nonce + status in its AAD (§3.3)
 *
 * A replayed nonce therefore costs no crypto, and an attacker holding only the
 * Access token can exhaust tier 1 but never tier 2.
 *
 * WRITES ARE HTTP-ONLY. `/v1/events` is registered from here but its handler
 * lives entirely in ws.ts, which imports nothing from answer.ts, read-api.ts or
 * push.ts — the socket has no reachable path to a desktop write, structurally,
 * not by convention (§1.3).
 */

import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import { z } from "zod";
import type { AccessValidator } from "./access-jwt";
import {
	BRIDGE_HOST,
	BRIDGE_PORT,
	ENVELOPE_HEADER_BYTES,
	FRESHNESS_WINDOW_MS,
	GCM_TAG_BYTES,
	LIMITS,
	MAX_SEALED_PLAINTEXT_BYTES,
	PANIC_PER_MIN,
	PING_PER_MIN,
	PREAUTH_PER_MIN,
	SESSION_TTL_MS,
} from "./config";
import type { ReplayCache } from "./crypto";
import {
	BoundedStreamOverflowError,
	base64UrlEncode,
	buildRequestAad,
	buildResponseAad,
	isCanonicalWireId,
	openSealed,
	parseEnvelope,
	randomBytes,
	readBoundedStream,
	seal,
	zero,
} from "./crypto";
import type { DeviceStore } from "./device-store";
import type { KeyStore, SendNonceSource } from "./keys";
import { deriveDirectionalKeys, zeroDirectionalKeys } from "./keys";
import {
	MAX_APP_VERSION_CHARS,
	MAX_LABEL_CHARS,
	PANIC_REASON_MAX_CHARS,
	WIRE_ID_CHARS,
} from "./limits";
import type {
	AnswerRequest,
	AnswerResponse,
	AnswerStatusRequest,
	AnswerStatusResponse,
	Capability,
	CleartextErrorBody,
	DeviceId,
	DeviceRecord,
	DirectionalKeys,
	EventTicketRequest,
	EventTicketResponse,
	HeartbeatRequest,
	HeartbeatResponse,
	HelloRequest,
	HelloResponse,
	MessageRequest,
	MessageResponse,
	OperationClass,
	PanicRequest,
	PanicResponse,
	ParsedEnvelope,
	PingResponse,
	ProtocolVersion,
	QuestionRequest,
	QuestionResponse,
	RateLimitDecision,
	RegisterRequest,
	RegisterResponse,
	SealedPath,
	SealedRequestContext,
	SealedResult,
	TranscriptRequest,
	TranscriptResponse,
	TreeRequest,
	TreeResponse,
} from "./types";
import {
	CleartextError,
	ENVELOPE_KIND_REQUEST,
	ENVELOPE_KIND_RESPONSE,
	SealedError,
} from "./types";
import type { EventStreamServer } from "./ws";
import { registerEventStreamRoute, selectCompanionSubprotocol } from "./ws";

// ---------------------------------------------------------------------------
// transport constants
// ---------------------------------------------------------------------------

/**
 * §3.2 — GCM ciphertext is the same length as its plaintext, so a wire body is
 * `39 (header) + N (plaintext) + 16 (tag)` = `N + 55`.
 *
 * NOTE: PROTOCOL.md §0 states the on-wire maximum as "256 KiB + 54 bytes", one
 * byte short of the byte layout in §3.2. The layout is the authoritative
 * description and wins; the prose is a documentation bug and is reported as one.
 * Being a byte more permissive than the prose can never reject a conforming
 * client.
 */
const MAX_WIRE_BODY_BYTES =
	MAX_SEALED_PLAINTEXT_BYTES + ENVELOPE_HEADER_BYTES + GCM_TAG_BYTES;

/**
 * §6.1 — protocol 0 is frozen forever and has NO write path at all: no
 * answering, no messaging, no push registration, no WebSocket. A session that
 * negotiated 0 may reach exactly these sealed paths (plus unsealed `GET /v1/ping`).
 */
const PROTOCOL_0_PATHS: ReadonlySet<SealedPath> = new Set<SealedPath>([
	"/v1/session/hello",
	"/v1/tree",
	"/v1/heartbeat",
]);

/**
 * §3.3 — the protocol byte bound into the request AAD.
 *
 * With a live session, EXACTLY that session's negotiated version is accepted.
 * That is what makes §6.2's "the negotiation cannot be silently downgraded
 * afterwards" true rather than aspirational: a client that negotiated 1 and then
 * sends `0x00` gets a tag failure.
 *
 * With no live session — first contact, or the bridge restarted under a client
 * that has not re-`hello`'d yet (§6.3) — the bridge cannot know which byte the
 * client used, so it tries the versions it supports. In that state no session
 * exists, so `granted` is empty and only the always-available baseline paths are
 * reachable anyway. Without this fallback a bridge restart would deadlock: the
 * heartbeat that carries `bridgeStartedMs` (the client's signal to re-`hello`)
 * could not itself be decrypted.
 */
const UNNEGOTIATED_PROTOCOL_CANDIDATES: readonly ProtocolVersion[] = [1, 0];

/** All buckets in §12 are per minute. */
const RATE_WINDOW_MS = 60_000;

/** Buckets idle longer than this are dropped so the maps cannot grow without bound. */
const RATE_BUCKET_IDLE_EVICT_MS = 10 * RATE_WINDOW_MS;

// ---------------------------------------------------------------------------
// logging — full detail locally, a stable code on the wire (§10)
// ---------------------------------------------------------------------------

export interface BridgeLogger {
	info(message: string, fields?: Record<string, unknown>): void;
	warn(message: string, fields?: Record<string, unknown>): void;
	/** Carries the real cause. It MUST NOT reach the wire. */
	error(message: string, fields?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// the sealed handler surface
// ---------------------------------------------------------------------------

/**
 * The endpoint implementations the transport dispatches to. They live in
 * read-api.ts / answer.ts / push.ts / ws.ts and are injected so this module owns
 * validation, gating and sealing and nothing else.
 *
 * `panic` (§7.8) has no implementation module yet. It is a REQUIRED member
 * precisely so the gap is a compile error at the composition root rather than a
 * silently missing kill switch. That is also why this stays a named interface
 * rather than collapsing into the route table below: the table says which
 * handler a path dispatches to, this says the handler must EXIST and have the
 * right shape, and only the second one fails the composition root's build.
 */
export interface SealedHandlers {
	/** §7.1 — fixed shape, no state, no secrets, no per-device information. */
	ping(): PingResponse;
	hello(ctx: SealedRequestContext, body: HelloRequest): Promise<HelloResponse>;
	tree(ctx: SealedRequestContext, body: TreeRequest): Promise<TreeResponse>;
	transcript(
		ctx: SealedRequestContext,
		body: TranscriptRequest,
	): Promise<TranscriptResponse>;
	question(
		ctx: SealedRequestContext,
		body: QuestionRequest,
	): Promise<QuestionResponse>;
	answer(
		ctx: SealedRequestContext,
		body: AnswerRequest,
	): Promise<AnswerResponse>;
	answerStatus(
		ctx: SealedRequestContext,
		body: AnswerStatusRequest,
	): Promise<AnswerStatusResponse>;
	message(
		ctx: SealedRequestContext,
		body: MessageRequest,
	): Promise<MessageResponse>;
	register(
		ctx: SealedRequestContext,
		body: RegisterRequest,
	): Promise<RegisterResponse>;
	heartbeat(
		ctx: SealedRequestContext,
		body: HeartbeatRequest,
	): Promise<HeartbeatResponse>;
	panic(ctx: SealedRequestContext, body: PanicRequest): Promise<PanicResponse>;
	eventsTicket(
		ctx: SealedRequestContext,
		body: EventTicketRequest,
	): Promise<EventTicketResponse>;
}

// ---------------------------------------------------------------------------
// free-text user-presence policy (§7.5, §11.2)
// ---------------------------------------------------------------------------

/**
 * Free text — a `/v1/message`, or any `freetext` answer item — requires the user
 * to have authenticated on the device. An option tap does not.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * READ THIS BEFORE WRITING A POLICY.
 *
 * `confirmedBiometric` is a BARE CLIENT BOOLEAN. It is a statement, not
 * evidence: a modified client sets it to `true` for free. The bridge therefore
 * treats it as a REQUIRED PRECONDITION — a request that does not even claim
 * presence is refused at the boundary — and NEVER as proof that a human
 * authenticated.
 *
 * Protocol 1 carries no field a bridge can verify. The only server-relevant
 * fact available today is indirect: on the phone `K_dev` is wrapped under an
 * `AndroidKeyStore` KEK with `setUserAuthenticationRequired(true)` (§3.1), so a
 * *conforming* client cannot produce ANY valid envelope without a recent user
 * authentication. The bridge cannot verify the client was configured that way,
 * so that is a property of the honest client, not a control this code enforces.
 *
 * Closing the gap is a PROTOCOL CHANGE — a presence assertion signed by a
 * `setUserAuthenticationRequired(true)` Keystore key registered at pairing, over
 * `requestId || questionId || fingerprint`, verified here. That change is out of
 * this module's scope: it is reported, not invented.
 * ───────────────────────────────────────────────────────────────────────────
 */
export interface FreeTextAuthorizationPolicy {
	/**
	 * Refuse by THROWING a `SealedError`. Returning normally authorises the write.
	 * `evidence` is recorded with the write so the audit trail never claims
	 * stronger proof than was actually presented.
	 */
	authorize(input: {
		ctx: SealedRequestContext;
		kind: "answer.freetext" | "message.send";
		/** `confirmedBiometric`, exactly as the client sent it. */
		claimedByClient: boolean;
	}): Promise<{ evidence: string }>;
}

/**
 * The only policy protocol 1 can express, named so its limitation cannot be
 * misread. It refuses a request that does not claim presence, labels every
 * authorised free-text write `client_flag_only`, and warns once per process so
 * the limitation appears in the log of every run rather than only in a comment.
 */
export function createUnverifiedClientFlagPolicy(
	logger: BridgeLogger,
): FreeTextAuthorizationPolicy {
	let warned = false;
	return {
		async authorize({ ctx, kind, claimedByClient }) {
			if (!warned) {
				warned = true;
				logger.warn(
					"[companion] free-text writes are gated on an UNVERIFIED client flag; " +
						"protocol 1 defines no server-verifiable presence assertion",
				);
			}
			if (claimedByClient !== true) {
				throw new SealedError(400, {
					code: "bad_request",
					message: "free text requires confirmedBiometric = true",
					retryAfterMs: null,
					detail: { field: "confirmedBiometric" },
				});
			}
			logger.info("[companion] free-text write authorised", {
				deviceId: ctx.device.deviceId,
				surface: ctx.device.surface,
				kind,
				evidence: "client_flag_only",
			});
			return { evidence: "client_flag_only" };
		},
	};
}

// ---------------------------------------------------------------------------
// session registry — the negotiated protocol byte lives in the AAD (§3.3, §6.2)
// ---------------------------------------------------------------------------

export interface NegotiatedSession {
	protocolVersion: ProtocolVersion;
	granted: readonly Capability[];
	expiresAtMs: number;
}

interface SessionRegistry {
	get(deviceId: DeviceId, nowMs: number): NegotiatedSession | null;
	record(deviceId: DeviceId, session: NegotiatedSession): void;
	drop(deviceId: DeviceId): void;
}

function createSessionRegistry(): SessionRegistry {
	const sessions = new Map<DeviceId, NegotiatedSession>();
	return {
		get(deviceId, nowMs) {
			const session = sessions.get(deviceId);
			if (!session) return null;
			if (session.expiresAtMs <= nowMs) {
				sessions.delete(deviceId);
				return null;
			}
			return session;
		},
		record(deviceId, session) {
			sessions.set(deviceId, session);
		},
		drop(deviceId) {
			sessions.delete(deviceId);
		},
	};
}

// ---------------------------------------------------------------------------
// §12 — two-tier token buckets
// ---------------------------------------------------------------------------

/** §12 — tier 1 pre-auth on the Access client id, tier 2 on the authenticated deviceId. */
export interface RateLimiter {
	/** Coarse flood absorption, before any decryption. 600/min. */
	preauth(accessClientId: string, nowMs: number): RateLimitDecision;
	/** `GET /v1/ping`, keyed on the Access client id — there is no device yet. 30/min. */
	ping(accessClientId: string, nowMs: number): RateLimitDecision;
	/** writes 10/min, reads 120/min, panic 3/min — panic is EXEMPT from writes. */
	perDevice(
		deviceId: DeviceId,
		operation: OperationClass,
		nowMs: number,
	): RateLimitDecision;
}

interface TokenBucket {
	tokens: number;
	lastRefillMs: number;
	touchedAtMs: number;
}

function takeToken(
	buckets: Map<string, TokenBucket>,
	key: string,
	capacity: number,
	nowMs: number,
): { allowed: boolean; retryAfterMs: number | null } {
	const perMs = capacity / RATE_WINDOW_MS;
	let bucket = buckets.get(key);
	if (!bucket) {
		bucket = { tokens: capacity, lastRefillMs: nowMs, touchedAtMs: nowMs };
		buckets.set(key, bucket);
	}
	const elapsed = Math.max(0, nowMs - bucket.lastRefillMs);
	bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * perMs);
	bucket.lastRefillMs = nowMs;
	bucket.touchedAtMs = nowMs;

	if (bucket.tokens >= 1) {
		bucket.tokens -= 1;
		return { allowed: true, retryAfterMs: null };
	}
	// Authoritative (§12): how long until exactly one token exists.
	return {
		allowed: false,
		retryAfterMs: Math.ceil((1 - bucket.tokens) / perMs),
	};
}

export function createRateLimiter(): RateLimiter {
	const preauthBuckets = new Map<string, TokenBucket>();
	const pingBuckets = new Map<string, TokenBucket>();
	const deviceBuckets = new Map<string, TokenBucket>();
	let lastEvictMs = 0;

	const maybeEvict = (nowMs: number) => {
		if (nowMs - lastEvictMs < RATE_WINDOW_MS) return;
		lastEvictMs = nowMs;
		for (const map of [preauthBuckets, pingBuckets, deviceBuckets]) {
			for (const [key, bucket] of map) {
				if (nowMs - bucket.touchedAtMs > RATE_BUCKET_IDLE_EVICT_MS) {
					map.delete(key);
				}
			}
		}
	};

	return {
		preauth(accessClientId, nowMs) {
			maybeEvict(nowMs);
			const taken = takeToken(
				preauthBuckets,
				accessClientId,
				PREAUTH_PER_MIN,
				nowMs,
			);
			return {
				allowed: taken.allowed,
				bucket: "preauth",
				retryAfterMs: taken.retryAfterMs,
			};
		},
		ping(accessClientId, nowMs) {
			maybeEvict(nowMs);
			const taken = takeToken(pingBuckets, accessClientId, PING_PER_MIN, nowMs);
			return {
				allowed: taken.allowed,
				bucket: "ping",
				retryAfterMs: taken.retryAfterMs,
			};
		},
		perDevice(deviceId, operation, nowMs) {
			maybeEvict(nowMs);
			const capacity =
				operation === "write"
					? LIMITS.writesPerMin
					: operation === "panic"
						? PANIC_PER_MIN
						: LIMITS.readsPerMin;
			const taken = takeToken(
				deviceBuckets,
				`${deviceId} ${operation}`,
				capacity,
				nowMs,
			);
			return {
				allowed: taken.allowed,
				bucket:
					operation === "write"
						? "writes"
						: operation === "panic"
							? "panic"
							: "reads",
				retryAfterMs: taken.retryAfterMs,
			};
		},
	};
}

// ---------------------------------------------------------------------------
// §3.6 cleartext errors — a CLOSED set, and nothing else, ever
// ---------------------------------------------------------------------------

/**
 * §3.6 — emits one of the CLOSED set of cleartext codes. No other code may ever
 * appear unsealed: `already_resolved`, `lease_held`, `guard_failed` and
 * `stale_question` disclose the existence and state of real questions.
 *
 * "device id not known" and "device id known but tag failed" are deliberately
 * indistinguishable — both return 401 `unknown_device`.
 */
export function writeCleartextError(
	statusCode: number,
	body: CleartextErrorBody,
): Response {
	return new Response(JSON.stringify(body), {
		status: statusCode,
		headers: { "content-type": "application/json; charset=utf-8" },
	});
}

function cleartextResponse(error: CleartextError, nowMs: number): Response {
	return writeCleartextError(error.statusCode, {
		code: error.code,
		// §0.2 — carried so a client whose clock is wrong can resynchronise and
		// retry its `hello`, the only retry-after-error the protocol permits.
		serverTimeMs: nowMs,
		retryAfterMs: error.retryAfterMs,
	});
}

// ---------------------------------------------------------------------------
// bounded body read — the cap applies BEFORE anything is parsed
// ---------------------------------------------------------------------------

/**
 * `Content-Length` is checked first, so an oversized declared body is refused
 * without being read at all. A chunked body without a length is capped while
 * streaming by `readBoundedStream`, so an unbounded upload cannot exhaust memory
 * before validation gets a chance to run.
 *
 * The content-length policy and the overflow mapping stay HERE and are not
 * shared: a non-numeric header is `400 envelope_invalid` on this boundary and
 * means something else entirely on the other caller of the shared reader.
 */
async function readBoundedBody(
	request: Request,
	maxBytes: number,
): Promise<Uint8Array> {
	const declared = request.headers.get("content-length");
	if (declared !== null) {
		if (!/^\d+$/.test(declared)) {
			throw new CleartextError(400, "envelope_invalid");
		}
		if (Number(declared) > maxBytes) {
			throw new CleartextError(413, "body_too_large");
		}
	}

	const body = request.body;
	if (!body) return new Uint8Array(0);

	try {
		// `cancelOnOverflow: false`, DELIBERATELY. This is an inbound REQUEST body
		// and the same connection still owes a 413; cancelling the reader destroys
		// the request stream, and on some HTTP/1.1 stacks that takes the
		// not-yet-written error response with it.
		return await readBoundedStream(body, maxBytes, { cancelOnOverflow: false });
	} catch (error) {
		if (error instanceof BoundedStreamOverflowError) {
			throw new CleartextError(413, "body_too_large");
		}
		throw error;
	}
}

// ---------------------------------------------------------------------------
// §7 / §11.2 — boundary schemas.
//
// Unknown keys are STRIPPED, never rejected: "unknown JSON fields MUST be
// ignored" is the forward-compatibility mechanism (§0). A MISSING required field
// is a hard error and is NEVER defaulted.
// ---------------------------------------------------------------------------

const UUID_V4 =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * §0.1 — a 16-byte id is exactly 22 base64url characters, CANONICALLY encoded.
 *
 * `isCanonicalWireId`, not a `length(22)` + alphabet regex. base64url's 22nd
 * character carries only 4 significant bits, so a regex ACCEPTS non-canonical
 * strings that decode to the same 16 bytes while comparing unequal as strings.
 * `device-store.ts` has always refused those, so the regex form made an id legal
 * at this boundary and refused at the inner one — an id that passes an outer
 * gate and then fails an inner one is the failure shape this protocol can least
 * afford (see `limits.ts` on the label cap).
 */
const id22 = z.string().refine(isCanonicalWireId, {
	message: `must be a canonical ${WIRE_ID_CHARS}-character base64url id`,
});
const requestIdSchema = z.string().regex(UUID_V4);
const surfaceSchema = z.enum(["phone", "watch"]);
const nonNegativeInt = z.number().int().min(0);

const protocolRangeSchema = z
	.object({ min: z.number().int().min(0), max: z.number().int().min(0) })
	.refine((range) => range.min <= range.max, {
		message: "protocol.min must be <= protocol.max",
	});

const helloSchema = z.object({
	client: z.object({
		app: z.literal("superset-companion"),
		// The SAME cap `pairing.ts` accepts an `appVersion` under and `push.ts`
		// re-validates it against (`limits.ts`). Pairing runs first and used to be
		// stricter, so a longer `versionName` killed pairing with a bare
		// `400 unknown`.
		version: z.string().min(1).max(MAX_APP_VERSION_CHARS),
		platform: z.literal("android"),
		sdkInt: z.number().int().min(1),
		surface: surfaceSchema,
		// The SAME cap `pairing.ts` MAC-accepts a label under and
		// `device-store.ts` re-validates it against (`limits.ts`). Three copies of
		// a literal 128 is how a device pairs successfully and then fails to be
		// recorded.
		label: z.string().min(1).max(MAX_LABEL_CHARS),
	}),
	protocol: protocolRangeSchema,
	capabilities: z.array(z.string().min(1).max(64)).max(64),
}) satisfies z.ZodType<HelloRequest>;

const treeSchema = z.object({
	since: z.number().int().min(0).nullable().optional(),
	// Explicit on every request; there is no server-side default (§7.2).
	includeIdle: z.boolean(),
}) satisfies z.ZodType<TreeRequest>;

const transcriptSchema = z.object({
	terminalId: id22,
	before: z.string().min(1).max(512).nullable().optional(),
	limit: z.number().int().min(1).max(LIMITS.transcriptPageMax),
}) satisfies z.ZodType<TranscriptRequest>;

const questionSchema = z.object({
	questionId: id22,
}) satisfies z.ZodType<QuestionRequest>;

const answerItemSchema = z.discriminatedUnion("kind", [
	z.object({
		questionIndex: nonNegativeInt,
		kind: z.literal("select"),
		optionIndex: nonNegativeInt,
	}),
	z.object({
		questionIndex: nonNegativeInt,
		kind: z.literal("multiselect"),
		// MAY be empty — "select nothing" is a real answer.
		optionIndexes: z.array(nonNegativeInt).max(64),
	}),
	z.object({
		questionIndex: nonNegativeInt,
		kind: z.literal("freetext"),
		text: z.string().min(1).max(4096),
	}),
]);

const answerSchema = z
	.object({
		questionId: id22,
		fingerprint: id22,
		requestId: requestIdSchema,
		answers: z.array(answerItemSchema).min(1).max(32),
		confirmedBiometric: z.boolean(),
		surface: surfaceSchema,
	})
	.superRefine((value, ctx) => {
		// §11.2 — `questionIndex` values MUST be exactly 0..N-1, each present once,
		// ascending. N here is `answers.length`; that it also equals the STORED
		// question's item count is checked by the answer path, the only layer that
		// holds the question.
		value.answers.forEach((item, position) => {
			if (item.questionIndex !== position) {
				ctx.addIssue({
					code: "custom",
					path: ["answers", position, "questionIndex"],
					message: "questionIndex must be 0..N-1, each once, ascending",
				});
			}
			if (item.kind !== "multiselect") return;
			// §11.2 — duplicates would toggle twice and silently deselect, so they
			// are REFUSED rather than normalised: normalising is guessing at intent.
			for (let i = 1; i < item.optionIndexes.length; i += 1) {
				const previous = item.optionIndexes[i - 1];
				const current = item.optionIndexes[i];
				if (previous === undefined || current === undefined) continue;
				if (current <= previous) {
					ctx.addIssue({
						code: "custom",
						path: ["answers", position, "optionIndexes"],
						message:
							"optionIndexes must be sorted ascending and free of duplicates",
					});
					return;
				}
			}
		});
	}) satisfies z.ZodType<AnswerRequest>;

/**
 * (STATUS-EPOCH-BOUNDARY) The coverage epoch MUST be declared here, because Zod
 * strips what it does not declare.
 *
 * It was omitted once, and the omission was invisible: the handler is reached
 * through `body as AnswerStatusRequest`, so TypeScript cheerfully asserted a
 * field that had already been deleted from the object. `resolveStatus` then read
 * `undefined`, failed its equality check, and answered every single poll
 * `unconfirmed` — which looks exactly like healthy conservatism and silently made
 * the terminal-negative path unreachable in live traffic. The `satisfies` below
 * is what makes that class of mistake a compile error rather than a quiet feature
 * amputation; it is on every sealed schema for the same reason.
 *
 * NOT pinned to the exact 22 chars the bridge mints. A bounded base64url string
 * is validated (no unbounded input reaches the ledger) but a wrong-SHAPED epoch
 * is answered rather than rejected: it cannot equal the current epoch, so it
 * degrades to `unconfirmed`, whereas a 400 would leave a phone holding a token
 * from another build unable to poll at all. Refusing to answer is worse here than
 * answering "cannot say".
 */
const answerStatusSchema = z.object({
	requestId: requestIdSchema,
	coverageEpoch: z
		.string()
		.regex(/^[A-Za-z0-9_-]{1,64}$/)
		.nullable(),
}) satisfies z.ZodType<AnswerStatusRequest>;

const messageSchema = z.object({
	terminalId: id22,
	text: z.string().min(1).max(8192),
	requestId: requestIdSchema,
	confirmedBiometric: z.boolean(),
}) satisfies z.ZodType<MessageRequest>;

const registerSchema = z.object({
	fcmToken: z.string().min(1).max(4096),
	surface: surfaceSchema,
	appVersion: z.string().min(1).max(MAX_APP_VERSION_CHARS),
	replacesToken: z.string().min(1).max(4096).nullable(),
}) satisfies z.ZodType<RegisterRequest>;

const heartbeatSchema = z.object({
	lastEventGseq: z.number().int().min(0).nullable(),
	// §7.7. A client that omits it is an older build and is normalised to the
	// explicit "unstated" member; a client that sends the WRONG TYPE is rejected,
	// because that is a bug rather than an older contract.
	foreground: z.boolean().nullable().default(null),
}) satisfies z.ZodType<HeartbeatRequest>;

const panicSchema = z.object({
	mode: z.enum(["write_disable", "unpair_device", "unpair_all"]),
	// The same cap the desktop-only tRPC panic switch enforces — both write the
	// same audit log, so both are held to the same shape (`limits.ts`).
	reason: z.string().max(PANIC_REASON_MAX_CHARS),
	requestId: requestIdSchema,
}) satisfies z.ZodType<PanicRequest>;

const eventsTicketSchema = z.object({
	since: z.number().int().min(0).nullable(),
}) satisfies z.ZodType<EventTicketRequest>;

// ---------------------------------------------------------------------------
// THE route table
// ---------------------------------------------------------------------------

/** One route, described ONCE. */
interface SealedRoute {
	/** §7 / §11.2 — validated at the boundary, before anything else runs. */
	schema: z.ZodType;
	/** §7 — the route-level capability. `null` = always available, incl. protocol 0. */
	capability: Capability | null;
	/** §12 — which per-device token bucket the request is drawn from. */
	operation: OperationClass;
	/**
	 * The implementation, selected out of the injected `SealedHandlers`. `body` is
	 * the schema's already-validated output, and the cast naming which member of
	 * the request union it is happens HERE and nowhere else.
	 */
	handler(
		handlers: SealedHandlers,
		ctx: SealedRequestContext,
		body: unknown,
	): Promise<unknown>;
}

/**
 * (ROUTE-TABLE-ONE-PLACE) The complete sealed surface — schema, capability,
 * rate-limit class and handler — in ONE entry per path. Iterating this is also
 * what registers the routes.
 *
 * `Record<SealedPath, SealedRoute>` makes the coverage exhaustive in BOTH
 * directions: a `SealedPath` with no entry, an entry for a path that is not a
 * `SealedPath`, and an entry missing any of the four fields are all compile
 * errors.
 *
 * WHY IT IS ONE TABLE. Every route used to be described five separate times — a
 * schema map, a capability map, an operation map, a `SealedHandlers` member and
 * a case in a 60-line dispatch switch whose every arm had the identical shape.
 * Adding an endpoint meant five edits, and a miss in any one of them was a
 * RUNTIME hole rather than a type error: `/v1/device/register` answered a sealed
 * 501 forever because `push.fcm` was gated but never granted, and the only
 * symptom was a feature that silently never happened.
 *
 * `SealedHandlers` deliberately survives as a separate named interface — it is
 * what makes a missing implementation fail the composition root's BUILD (see the
 * note on `panic` there). This table says which handler a path uses; that
 * interface says the handler has to exist.
 */
/**
 * Exported so a boundary test can parse against THE table rather than a copy of
 * it. A copy is what let `coverageEpoch` go missing for a whole review cycle: the
 * schema under test agreed with the wire contract while the one actually serving
 * traffic did not.
 */
export const ROUTES: Record<SealedPath, SealedRoute> = {
	"/v1/session/hello": {
		schema: helloSchema,
		capability: null,
		operation: "read",
		handler: (h, ctx, body) => h.hello(ctx, body as HelloRequest),
	},
	/**
	 * `capability: null` is deliberate: `/v1/tree`'s baseline field subset is
	 * ALWAYS available (§6.1) and the read layer restricts the non-baseline fields
	 * instead. Refusing the route would break "degrade, never refuse".
	 */
	"/v1/tree": {
		schema: treeSchema,
		capability: null,
		operation: "read",
		handler: (h, ctx, body) => h.tree(ctx, body as TreeRequest),
	},
	"/v1/transcript": {
		schema: transcriptSchema,
		capability: "transcript.read",
		operation: "read",
		handler: (h, ctx, body) => h.transcript(ctx, body as TranscriptRequest),
	},
	"/v1/question": {
		schema: questionSchema,
		capability: "question.read",
		operation: "read",
		handler: (h, ctx, body) => h.question(ctx, body as QuestionRequest),
	},
	"/v1/answer": {
		schema: answerSchema,
		capability: "answer.single",
		operation: "write",
		handler: (h, ctx, body) => h.answer(ctx, body as AnswerRequest),
	},
	"/v1/answer/status": {
		schema: answerStatusSchema,
		capability: "answer.single",
		operation: "read",
		handler: (h, ctx, body) => h.answerStatus(ctx, body as AnswerStatusRequest),
	},
	"/v1/message": {
		schema: messageSchema,
		capability: "message.send",
		operation: "write",
		handler: (h, ctx, body) => h.message(ctx, body as MessageRequest),
	},
	"/v1/device/register": {
		schema: registerSchema,
		capability: "push.fcm",
		operation: "write",
		handler: (h, ctx, body) => h.register(ctx, body as RegisterRequest),
	},
	"/v1/heartbeat": {
		schema: heartbeatSchema,
		capability: null,
		operation: "read",
		handler: (h, ctx, body) => h.heartbeat(ctx, body as HeartbeatRequest),
	},
	/**
	 * `/v1/panic` is `capability: null` AND is excluded from
	 * `contentCapabilities`. The kill switch must not be reachable only through a
	 * successful capability negotiation: a bridge whose grant set comes back
	 * empty — a mis-populated `BRIDGE_CAPABILITIES`, a protocol-0 degrade, a
	 * client that asked for the wrong tokens — would answer `501
	 * capability_unsupported` to the one request whose whole purpose is to work
	 * when something has gone wrong. The documented client action for 501 is
	 * "re-hello", which re-negotiates to the same empty set, so the phone loops
	 * and the only remaining revocation path is physical access to the desktop,
	 * which is exactly the situation panic exists to cover.
	 *
	 * §7.8 — `operation: "panic"` is its own bucket, exempt from `writes`: being
	 * rate-limited out of your own kill switch would be the wrong failure. Panic
	 * is still bounded by that bucket, still refused from a revoked device, and
	 * still cannot raise privilege — every mode it accepts is strictly more
	 * restrictive.
	 */
	"/v1/panic": {
		schema: panicSchema,
		capability: null,
		operation: "panic",
		handler: (h, ctx, body) => h.panic(ctx, body as PanicRequest),
	},
	"/v1/events/ticket": {
		schema: eventsTicketSchema,
		capability: "events.ws",
		operation: "read",
		handler: (h, ctx, body) => h.eventsTicket(ctx, body as EventTicketRequest),
	},
};

/**
 * (CAPABILITY-WIRING-ASSERT) Every capability the route table gates on, in one
 * place, so the composition root can assert at BOOT that each one is either
 * granted or listed as deliberately withheld.
 *
 * The failure this prevents: a token that is gated here but missing from
 * `BRIDGE_CAPABILITIES` makes its route return a sealed 501 forever, and the
 * only symptom is a feature that never happens. `push.fcm` was in exactly that
 * state — `/v1/device/register` 501'd on every call, so no device could ever
 * store an FCM token and the push sender had nothing to send to.
 */
export const ROUTE_GATED_CAPABILITIES: readonly Capability[] = Array.from(
	new Set(
		Object.values(ROUTES)
			.map((route) => route.capability)
			.filter((capability): capability is Capability => capability !== null),
	),
);

function parseBody(path: SealedPath, plaintext: Uint8Array): unknown {
	// §3.2 — an empty plaintext (N = 0) is legal and means "no fields". It is not
	// the same as `{}` and is defined ONLY for /v1/heartbeat. This mapping is the
	// protocol's own definition of the empty form, not a default invented here;
	// every other path rejects it.
	if (plaintext.byteLength === 0) {
		if (path !== "/v1/heartbeat") {
			throw new SealedError(400, {
				code: "bad_request",
				message: "an empty plaintext is only defined for /v1/heartbeat",
				retryAfterMs: null,
				detail: { path },
			});
		}
		return {
			lastEventGseq: null,
			foreground: null,
		} satisfies HeartbeatRequest;
	}

	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
	} catch {
		throw new SealedError(400, {
			code: "bad_request",
			message: "body is not valid UTF-8",
			retryAfterMs: null,
			detail: null,
		});
	}

	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		throw new SealedError(400, {
			code: "bad_request",
			message: "body is not valid JSON",
			retryAfterMs: null,
			detail: null,
		});
	}

	const parsed = ROUTES[path].schema.safeParse(json);
	if (!parsed.success) {
		const first = parsed.error.issues[0];
		const field = first ? first.path.join(".") || "<root>" : "<unknown>";
		// The field path is the CLIENT's own data, so naming it discloses nothing
		// about the desktop. The offending VALUE is never echoed.
		throw new SealedError(400, {
			code: "bad_request",
			message: `invalid field: ${field}`,
			retryAfterMs: null,
			detail: first ? { field, issue: first.code } : null,
		});
	}
	return parsed.data;
}

// ---------------------------------------------------------------------------
// content-derived capabilities (§6.4)
// ---------------------------------------------------------------------------

/**
 * Capabilities the request's CONTENT requires on top of the route's. The shape
 * of an answer decides which `answer.*` capability it needs; that is not
 * knowable from the path.
 *
 * `/v1/panic` deliberately requires NOTHING. See its entry in `ROUTES` above:
 * the `panic.*` tokens exist so a client can discover the switch, never so the
 * bridge can withhold it.
 */
function contentCapabilities(path: SealedPath, body: unknown): Capability[] {
	const required: Capability[] = [];
	if (path === "/v1/answer") {
		const answer = body as AnswerRequest;
		if (answer.answers.length > 1) required.push("answer.multi_question");
		for (const item of answer.answers) {
			if (item.kind === "multiselect") required.push("answer.multiselect");
			if (item.kind === "freetext") required.push("answer.freetext");
		}
	}
	return required;
}

/**
 * (SESSION-EXPIRED-VERDICT) A dead session is its own verdict, not an empty
 * grant set.
 *
 * `sessions` is in-memory and per-mount, so a bridge restart or a TTL lapse
 * silently turns every device back into "no session". `granted` then degrades to
 * `[]` and `requireCapabilities` answers `501 capability_unsupported` — the same
 * bytes a deliberately withheld capability produces. The phone cannot tell the
 * two apart, so it takes the documented 501 action, re-`hello`s once, and if
 * that races or fails renders "answer at the desk" for a bridge that would have
 * accepted the write immediately after one successful negotiation.
 *
 * So: no live session + a capability-GATED route = `409 session_expired`, which
 * says re-negotiate, the grant set is unknown. Ungated routes (`capability:
 * null` — `/v1/session/hello`, which CREATES the session, plus `/v1/tree`,
 * `/v1/heartbeat` and `/v1/panic`) are unchanged and still work sessionless;
 * `/v1/panic` in particular must never acquire a session precondition, for the
 * reason spelled out on its route entry above.
 *
 * A session that exists and lacks the asked capability still gets 501.
 *
 * Exported so the boundary test judges THE gating rule rather than a copy of it:
 * which paths are gated is read off `ROUTES` here, so a route that later gains
 * or loses a capability changes both the server and the test at once.
 */
export function requireLiveSession(
	path: SealedPath,
	session: NegotiatedSession | null,
): void {
	if (session !== null) return;
	if (ROUTES[path].capability === null) return;
	throw new SealedError(409, {
		code: "session_expired",
		message: "no live session for this device; re-hello and retry",
		retryAfterMs: null,
		detail: { path },
	});
}

export function requireCapabilities(
	granted: readonly Capability[],
	required: readonly (Capability | null)[],
): void {
	for (const capability of required) {
		if (capability === null) continue;
		if (granted.includes(capability)) continue;
		// §10 — 501; the client's documented action is to re-`hello` and, if still
		// ungranted, show "answer at the desk".
		throw new SealedError(501, {
			code: "capability_unsupported",
			message: `capability not granted: ${capability}`,
			retryAfterMs: null,
			detail: { capability },
		});
	}
}

// ---------------------------------------------------------------------------
// the server
// ---------------------------------------------------------------------------

export interface BridgeHttpServer {
	start(): Promise<void>;
	stop(): Promise<void>;
	readonly startedAtMs: number;
}

export interface BridgeHttpServerDeps {
	accessValidator: AccessValidator;
	devices: DeviceStore;
	keys: KeyStore;
	nonceCache: ReplayCache;
	/** The bridge's own send-side nonce state for K_s2c (§3.4). */
	sendNonce: SendNonceSource;
	handlers: SealedHandlers;
	/** Registered read-only. ws.ts can reach no write path (§1.3). */
	events: EventStreamServer;
	freeText: FreeTextAuthorizationPolicy;
	logger: BridgeLogger;
	/** Test seam only. Production passes nothing and gets the wall clock. */
	now?: () => number;
}

/** Everything the pipeline learns once an envelope has actually opened. */
interface OpenedRequest {
	envelope: ParsedEnvelope;
	device: DeviceRecord;
	/**
	 * BOTH directional keys, not just `s2c`.
	 *
	 * The request path needs `c2s` to open the envelope and `s2c` to seal the
	 * reply, and whoever owns the request has to wipe both when it ends. Carrying
	 * only `s2c` here left `c2s` reachable from nothing and wiped by nobody.
	 */
	keys: DirectionalKeys;
	protocolVersion: ProtocolVersion;
	plaintext: Uint8Array;
}

export function createBridgeHttpServer(
	deps: BridgeHttpServerDeps,
): BridgeHttpServer {
	const now = deps.now ?? (() => Date.now());
	const rateLimiter = createRateLimiter();
	const sessions = createSessionRegistry();
	const startedAtMs = now();
	/**
	 * (OPEN-TIMING-EQUALISE) A real 32-byte key that backs no device, minted once
	 * per process. `openRequest` derives from it when the named device does not
	 * exist, so an unknown deviceId costs the same HKDF and the same AES-GCM open
	 * as a known one — see the note there for what this does and does not cover.
	 *
	 * It is never persisted, never zeroed (it lives as long as the server) and
	 * never leaves this closure. A tag that verifies against it is impossible, and
	 * `openRequest` treats it as a fatal invariant breach rather than a success.
	 */
	const decoyDeviceKey = randomBytes(32);

	const app = new Hono();
	const nodeWs = createNodeWebSocket({ app });

	// §9.1 — the bridge echoes `sc.v1` as the selected subprotocol and never
	// echoes the ticket. `ws` decides that through `handleProtocols`, which
	// @hono/node-ws constructs its WebSocketServer without. Installing it here
	// reaches into that object, so it is asserted LOUDLY: if a future version
	// stops exposing `options`, the bridge fails at startup rather than quietly
	// serving sockets that never negotiate a subprotocol.
	const wssOptions = (
		nodeWs.wss as unknown as { options?: Record<string, unknown> }
	).options;
	if (!wssOptions || typeof wssOptions !== "object") {
		throw new Error(
			"(COMPANION-BRIDGE) @hono/node-ws no longer exposes wss.options; the " +
				"`sc.v1` subprotocol (PROTOCOL §9.1) cannot be negotiated",
		);
	}
	wssOptions.handleProtocols = selectCompanionSubprotocol;

	// -- §7.1 GET /v1/ping — the only unsealed endpoint ----------------------
	app.get("/v1/ping", async (c) => {
		const nowMs = now();
		try {
			const claims = await deps.accessValidator.validate(headersOf(c.req.raw));
			const decision = rateLimiter.ping(claims.common_name, nowMs);
			if (!decision.allowed) {
				throw new CleartextError(429, "rate_limited", decision.retryAfterMs);
			}
			// FIXED SHAPE. No per-device, per-workspace or per-question information
			// may ever be added here, not even "for diagnostics" (§7.1).
			return c.json(deps.handlers.ping());
		} catch (error) {
			if (error instanceof CleartextError)
				return cleartextResponse(error, nowMs);
			deps.logger.error("[companion] /v1/ping failed", { error });
			return cleartextResponse(
				new CleartextError(503, "bridge_unavailable"),
				nowMs,
			);
		}
	});

	// -- the eleven sealed POST routes ---------------------------------------
	for (const path of Object.keys(ROUTES) as SealedPath[]) {
		app.post(path, (c) => handleSealed(path, c.req.raw));
	}

	// -- §9 GET /v1/events — read-only, handled entirely inside ws.ts ---------
	registerEventStreamRoute({
		app,
		upgradeWebSocket: nodeWs.upgradeWebSocket,
		events: deps.events,
		accessValidator: deps.accessValidator,
		logger: deps.logger,
		now,
	});

	// Anything else is a bodyless 404: the surface is a closed set of paths.
	app.all("*", (c) => c.body(null, 404));

	/**
	 * The normative pipeline. Every failure is a specific loud rejection; there is
	 * no partial success anywhere in it.
	 */
	async function handleSealed(
		path: SealedPath,
		request: Request,
	): Promise<Response> {
		const nowMs = now();
		let opened: OpenedRequest | null = null;
		try {
			// 1. the edge is not trusted (§2.1); an unreachable JWKS fails CLOSED
			const claims = await deps.accessValidator.validate(headersOf(request));

			// 2. tier 1: coarse, pre-auth, absorbs a flood without spending AES (§12)
			const preauth = rateLimiter.preauth(claims.common_name, nowMs);
			if (!preauth.allowed) {
				throw new CleartextError(429, "rate_limited", preauth.retryAfterMs);
			}

			// 3. bound the body BEFORE parsing it
			const wire = await readBoundedBody(request, MAX_WIRE_BODY_BYTES);

			// 4. header (§3.2) — a reserved flag bit is never tolerated
			const envelope = parseEnvelope(wire);
			if (envelope.header.kind !== ENVELOPE_KIND_REQUEST) {
				throw new CleartextError(400, "envelope_invalid");
			}

			// 5. freshness (§3.5). The cleartext body carries `serverTimeMs` so the
			//    client can resynchronise (§0.2).
			if (Math.abs(nowMs - envelope.header.timestampMs) > FRESHNESS_WINDOW_MS) {
				throw new CleartextError(401, "stale_timestamp");
			}

			// 6. replay cache (§3.5) — durable, fsync'd BEFORE dispatch, checked
			//    before decryption so a replayed nonce costs no crypto. It is
			//    handed the SAME `nowMs` the freshness check above used, so the
			//    two §3.5 rules judge one instant rather than two clock reads
			//    either side of an await.
			const admitted = await deps.nonceCache.admit(
				envelope.header.deviceId,
				envelope.header.nonce,
				nowMs,
			);
			if (!admitted) {
				deps.logger.warn("[companion] replay detected", {
					deviceId: envelope.header.deviceId,
					nonce: base64UrlEncode(envelope.header.nonce),
					path,
				});
				throw new CleartextError(409, "replay_detected");
			}

			// 7. device lookup + open. An unknown device and a tag failure are
			//    DELIBERATELY indistinguishable (§3.6).
			opened = await openRequest(path, envelope, nowMs);

			// 8. tier 2: keyed on the AUTHENTICATED deviceId, so an attacker holding
			//    only the Access token cannot rate-limit a real device out of
			//    existence by claiming its id (§12).
			const operation = ROUTES[path].operation;
			const perDevice = rateLimiter.perDevice(
				opened.device.deviceId,
				operation,
				nowMs,
			);
			if (!perDevice.allowed) {
				// §10 marks `rate_limited` as an unsealed code.
				throw new CleartextError(429, "rate_limited", perDevice.retryAfterMs);
			}

			// 9. revocation (§5.1) — SEALED, because the device still holds a valid
			//    key and must be able to tell the user why it stopped working.
			if (opened.device.revokedAtMs !== null) {
				sessions.drop(opened.device.deviceId);
				throw new SealedError(403, {
					code: "access_denied",
					message: "device revoked",
					retryAfterMs: null,
					detail: { reason: "revoked" },
				});
			}

			const session = sessions.get(opened.device.deviceId, nowMs);
			const granted: readonly Capability[] = session?.granted ?? [];

			// 10. protocol 0 has NO write path at all (§6.1)
			if (
				session !== null &&
				session.protocolVersion === 0 &&
				!PROTOCOL_0_PATHS.has(path)
			) {
				throw new SealedError(501, {
					code: "capability_unsupported",
					message: "operation is not part of protocol 0",
					retryAfterMs: null,
					detail: { capability: path },
				});
			}

			// 11. panic write-disable (§5.1). Panic ITSELF is accepted from a
			//     write-disabled device — you can always make things more
			//     restrictive — and is refused from a revoked one, handled above.
			if (operation === "write" && !opened.device.writeEnabled) {
				throw new SealedError(403, {
					code: "write_disabled",
					message: "writes are disabled for this device",
					retryAfterMs: null,
					detail: null,
				});
			}

			// 12. schema at the boundary, before anything else happens
			const body = parseBody(path, opened.plaintext);

			// 13. capabilities: route-level plus whatever the content requires.
			//     A dead session is separated out FIRST (SESSION-EXPIRED-VERDICT) —
			//     it degrades `granted` to `[]`, which would otherwise answer the
			//     same 501 a deliberately withheld capability does.
			requireLiveSession(path, session);
			requireCapabilities(granted, [
				ROUTES[path].capability,
				...contentCapabilities(path, body),
			]);

			const ctx: SealedRequestContext = {
				path,
				device: opened.device,
				protocolVersion: opened.protocolVersion,
				granted,
				requestNonce: envelope.header.nonce,
				receivedAtMs: nowMs,
				access: claims,
			};

			// 14. free text requires user presence; an option tap does not (§7.5)
			await enforceFreeTextPolicy(ctx, path, body);

			// 15. dispatch
			const result = await dispatch(ctx, path, body);

			// 16. record the negotiated session — the protocol byte it fixes is bound
			//     into every subsequent AAD (§3.3, §6.2)
			if (path === "/v1/session/hello") {
				const hello = result.body as HelloResponse;
				sessions.record(opened.device.deviceId, {
					protocolVersion: hello.protocol,
					granted: hello.capabilities.granted,
					expiresAtMs: nowMs + (hello.sessionTtlMs || SESSION_TTL_MS),
				});
			}

			await touchLastSeen(opened.device.deviceId, nowMs);
			return sealResponse(path, opened, result, nowMs);
		} catch (error) {
			if (error instanceof CleartextError) {
				return cleartextResponse(error, nowMs);
			}
			if (opened === null) {
				// No key is available, so nothing can be sealed. Log the real cause
				// locally and emit the only cleartext code that fits.
				deps.logger.error("[companion] pre-key failure", { path, error });
				return cleartextResponse(
					new CleartextError(503, "bridge_unavailable"),
					nowMs,
				);
			}
			const sealed = toSealedError(error, path, deps.logger);
			return sealResponse(
				path,
				opened,
				{ statusCode: sealed.statusCode, body: sealed.body },
				nowMs,
			);
		} finally {
			// The request is over on EVERY path — success, sealed error, cleartext
			// error — and this is the last line that can reach the directional pair.
			// `finally` runs after the return value is computed, so `sealResponse`
			// above has already used `s2c`. K_dev itself was wiped in `openRequest`
			// the moment these were derived from it.
			if (opened !== null) zeroDirectionalKeys(opened.keys);
		}
	}

	async function openRequest(
		path: SealedPath,
		envelope: ParsedEnvelope,
		nowMs: number,
	): Promise<OpenedRequest> {
		const device = await deps.devices.get(envelope.header.deviceId);
		if (!device) {
			// §8 — `not_paired` and `unpaired` are different user-facing states, so
			// the distinction is worth making; neither reveals anything about a
			// device the caller does not already name.
			const anyPaired = await deps.devices.anyPaired();
			if (!anyPaired) {
				// A bridge with no devices at all leaks nothing by answering fast: the
				// answer itself already says there is nothing to probe for.
				throw new CleartextError(401, "not_paired");
			}
		}
		const storedKey =
			device === null ? null : await deps.keys.load(device.keyRef);
		if (device !== null && storedKey === null) {
			// The record exists but its key material does not: a broken install, not
			// a client error. Log it loudly; still answer with the indistinguishable
			// code, and still do the work below so it stays indistinguishable in
			// TIME as well as in content.
			deps.logger.error("[companion] device record has no key material", {
				deviceId: device.deviceId,
				keyRef: device.keyRef,
			});
		}

		// (OPEN-TIMING-EQUALISE) An unknown deviceId and a known one presenting a
		// bad tag are supposed to be indistinguishable (§3.6), and they were — on
		// the wire. They were NOT indistinguishable in time: the unknown one
		// returned before any HKDF or any GCM open, so an attacker could time the
		// response and enumerate which device ids this bridge has paired, which is
		// exactly the fact the shared `unknown_device` code exists to hide.
		//
		// So every request that gets past `anyPaired` now runs the same shape of
		// work. The decoy is a real random 32-byte key minted once per process: the
		// derivation and the GCM open cost what they cost, and the tag fails.
		//
		// HONEST BOUND, because this is a timing claim and an overstated one is
		// worse than none: this equalises the CPU-bound crypto (two HKDF expansions
		// plus one AES-GCM open per candidate). It does NOT equalise the fs access
		// — an unknown device does no `keys.load` at all, and there is no honest way
		// to fake one without a decoy key file on disk. It also does not equalise a
		// device that HAS a live session (one candidate) against one that does not
		// (two), but reaching that state requires already holding a valid key, so it
		// is not a channel an enumerating attacker can stand in.
		const deviceKey = storedKey ?? decoyDeviceKey;
		const directional = deriveDirectionalKeys(deviceKey);
		// K_dev's only job here was to produce the directional pair. Everything
		// downstream uses `directional`, so the master key goes now rather than
		// living as long as the request. Never the decoy — that one is process-wide.
		if (storedKey !== null) zero(storedKey);

		const session =
			device === null ? null : sessions.get(device.deviceId, nowMs);
		const candidates: readonly ProtocolVersion[] =
			session !== null
				? [session.protocolVersion]
				: UNNEGOTIATED_PROTOCOL_CANDIDATES;

		for (const protocolVersion of candidates) {
			const aad = buildRequestAad(envelope.headerBytes, {
				method: "POST",
				path,
				protocolVersion,
			});
			let plaintext: Uint8Array;
			try {
				plaintext = openSealed(directional.c2s, envelope, aad);
			} catch {
				continue;
			}
			if (device === null || storedKey === null) {
				// Unreachable at 2^-128: the decoy key cannot produce a valid tag.
				// Loud rather than `assert`, because reaching it would mean the decoy
				// leaked or the branch above was rewritten wrong, and silently serving
				// a request for a device that does not exist is not a recoverable bug.
				zeroDirectionalKeys(directional);
				throw new Error(
					"(COMPANION-BRIDGE) a sealed envelope opened against the decoy key — refusing to serve a request for a device with no key material",
				);
			}
			if (plaintext.byteLength > MAX_SEALED_PLAINTEXT_BYTES) {
				zeroDirectionalKeys(directional);
				throw new CleartextError(413, "body_too_large");
			}
			return {
				envelope,
				device,
				keys: directional,
				protocolVersion,
				plaintext,
			};
		}
		// Tag failure — indistinguishable from an unknown device (§3.6).
		zeroDirectionalKeys(directional);
		throw new CleartextError(401, "unknown_device");
	}

	async function enforceFreeTextPolicy(
		ctx: SealedRequestContext,
		path: SealedPath,
		body: unknown,
	): Promise<void> {
		if (path === "/v1/message") {
			// §7.5 — every message is free text, so presence is always required.
			const message = body as MessageRequest;
			await deps.freeText.authorize({
				ctx,
				kind: "message.send",
				claimedByClient: message.confirmedBiometric,
			});
			return;
		}
		if (path !== "/v1/answer") return;
		const answer = body as AnswerRequest;
		// §11.2 — `confirmedBiometric` MUST be true if any item is `freetext`; for a
		// pure option tap it MAY be false and the bridge does not require it.
		if (!answer.answers.some((item) => item.kind === "freetext")) return;
		await deps.freeText.authorize({
			ctx,
			kind: "answer.freetext",
			claimedByClient: answer.confirmedBiometric,
		});
	}

	async function dispatch(
		ctx: SealedRequestContext,
		path: SealedPath,
		body: unknown,
	): Promise<SealedResult<unknown>> {
		// Every sealed SUCCESS is a 200. Any other status leaves its handler as a
		// thrown `SealedError` and is sealed by the catch in `handleSealed`, so
		// there is no per-route status to state.
		return {
			statusCode: 200,
			body: await ROUTES[path].handler(deps.handlers, ctx, body),
		};
	}

	function sealResponse(
		path: SealedPath,
		opened: OpenedRequest,
		result: SealedResult<unknown>,
		nowMs: number,
	): Response {
		try {
			const plaintext = new TextEncoder().encode(JSON.stringify(result.body));
			const body = seal(
				opened.keys.s2c,
				ENVELOPE_KIND_RESPONSE,
				opened.envelope.header.deviceIdBytes,
				deps.sendNonce.next(),
				nowMs,
				plaintext,
				(headerBytes) =>
					buildResponseAad(headerBytes, {
						method: "POST",
						path,
						protocolVersion: opened.protocolVersion,
						// Binding the request nonce means a captured response can never
						// be re-served against a different request; binding the status
						// means nothing on the path can flip a 200 into a 403 (§3.3).
						requestNonce: opened.envelope.header.nonce,
						statusCode: result.statusCode,
					}),
			);
			// `seal` returns a bare `Uint8Array` (i.e. `Uint8Array<ArrayBufferLike>`),
			// but `BodyInit` only accepts an ArrayBuffer-backed view — a
			// SharedArrayBuffer-backed one is not a valid body. Copy into a view
			// that owns its own ArrayBuffer so the type is exact, not asserted.
			// Envelopes are small; the copy is not on any hot path.
			const responseBytes = new Uint8Array(body.length);
			responseBytes.set(body);
			return new Response(responseBytes, {
				status: result.statusCode,
				headers: { "content-type": "application/octet-stream" },
			});
		} catch (error) {
			// Sealing failed AFTER authentication: a bridge fault, never the client's.
			// Log the cause; the wire gets a code and nothing else.
			deps.logger.error("[companion] failed to seal response", { path, error });
			return cleartextResponse(
				new CleartextError(503, "bridge_unavailable"),
				nowMs,
			);
		}
	}

	async function touchLastSeen(
		deviceId: DeviceId,
		nowMs: number,
	): Promise<void> {
		try {
			await deps.devices.touchLastSeen(deviceId, nowMs);
		} catch (error) {
			// Loud, but not fatal to a request already authorised and executed.
			// Swallowing silently is what is forbidden; this is recorded.
			deps.logger.error("[companion] failed to record lastSeen", {
				deviceId,
				error,
			});
		}
	}

	let server: ReturnType<typeof serve> | null = null;

	return {
		startedAtMs,
		async start() {
			if (server) throw new Error("(COMPANION-BRIDGE) server already started");
			server = await listenOrFail(app, deps.logger);
			nodeWs.injectWebSocket(server);
			deps.logger.info("[companion] bridge listening", {
				host: BRIDGE_HOST,
				port: BRIDGE_PORT,
			});
		},
		async stop() {
			const current = server;
			server = null;
			await deps.events.stop();
			if (!current) return;
			await new Promise<void>((resolve, reject) => {
				current.close((error) => (error ? reject(error) : resolve()));
			});
		},
	};
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * §1.1 — the port is FIXED. If 47610 is occupied the bridge fails loud rather
 * than picking another: cloudflared's static ingress rule would otherwise point
 * at nothing, which presents to the user as "phone says offline" with no
 * explanation.
 */
function listenOrFail(
	app: Hono,
	logger: BridgeLogger,
): Promise<ReturnType<typeof serve>> {
	return new Promise((resolve, reject) => {
		const onError = (error: unknown) => {
			const code = (error as NodeJS.ErrnoException | undefined)?.code;
			logger.error("[companion] bridge listener failed to bind", {
				host: BRIDGE_HOST,
				port: BRIDGE_PORT,
				code,
			});
			reject(
				new Error(
					`(COMPANION-BRIDGE) cannot bind ${BRIDGE_HOST}:${BRIDGE_PORT}` +
						`${code ? ` (${code})` : ""} — the port is fixed and the bridge ` +
						"never falls back to another one",
					{ cause: error },
				),
			);
		};
		const server = serve(
			{ fetch: app.fetch, hostname: BRIDGE_HOST, port: BRIDGE_PORT },
			() => {
				server.removeListener("error", onError);
				resolve(server);
			},
		);
		server.once("error", onError);
	});
}

/**
 * Header names lowercased into a plain object, which is the shape every
 * validator on this bridge takes.
 *
 * Exported for `ws.ts`'s `/v1/events` guard, which validates the SAME Access
 * token off the SAME `Request` and used to lowercase them itself. Two copies of
 * "how this bridge presents headers to `AccessValidator`" is one copy too many
 * for a pre-auth path.
 *
 * (`ws.ts` importing a value from here closes the module cycle `http -> ws`.
 * Safe by construction: this is a hoisted function DECLARATION, so it is
 * initialised at instantiation time rather than during evaluation, and `ws.ts`
 * only ever calls it from inside a request handler.)
 */
export function headersOf(request: Request): Readonly<Record<string, string>> {
	const out: Record<string, string> = {};
	request.headers.forEach((value, key) => {
		out[key.toLowerCase()] = value;
	});
	return out;
}

/**
 * Maps an unexpected throw onto a stable wire code. The real error is logged
 * with a correlation id and is NEVER serialised into the response (§10).
 */
function toSealedError(
	error: unknown,
	path: SealedPath,
	logger: BridgeLogger,
): SealedError {
	if (error instanceof SealedError) return error;
	const ref = base64UrlEncode(randomBytes(6));
	logger.error("[companion] unhandled handler failure", { path, ref, error });
	return new SealedError(500, {
		code: "internal",
		message: `internal error (ref ${ref})`,
		retryAfterMs: null,
		detail: null,
	});
}
