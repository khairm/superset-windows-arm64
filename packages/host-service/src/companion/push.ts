/**
 * (COMPANION-BRIDGE) — FCM push: registration, the delayed timer, retraction (§7.6, §13).
 *
 * HARD CONSTRAINT OF THE FORMAT: no question text, no option text, no workspace
 * name, no branch name, no project name, no file path and no free text of any
 * kind may EVER appear in an FCM message. Google is not in the trust boundary.
 * This is not a guideline — `assertPushDataSafe` THROWS, it never logs and
 * continues.
 *
 * The message is data-only. `message.notification` must be absent: setting it
 * would have Android render text supplied through Google's infrastructure,
 * breaking the constraint by construction. `assertPushDataSafe` enforces a
 * CLOSED key set on the envelope as well as on `data`, so no later edit can add
 * an `apns`/`webpush`/`notification` block carrying text without failing.
 *
 * PRESENCE IS THE FEATURE, AND IT REPLACED A DELAY. A red does not wait three
 * minutes any more; it pushes IMMEDIATELY when the user is away and NEVER while
 * they are at the desk. This module does not own that judgement —
 * `companion/presence.ts` does, from two signals (human keystrokes into a
 * terminal, and the Electron beacon carrying OS idle time and lock state). This
 * module owns what to DO with it:
 *
 *   away at capture      -> fire now, zero latency. The user cannot see the
 *                           question, so every second of delay is a blocked
 *                           agent nobody knows about.
 *   present at capture   -> HOLD, with no deadline. They can see it. A push for
 *                           a question already on their screen is exactly the
 *                           noise that gets a watch muted inside a week, and a
 *                           muted watch is the same as one never built.
 *   present -> away      -> the sweep fires everything still held. Walking away,
 *                           or locking the screen, is the trigger.
 *   answered at the desk -> `cancelPending` disarms it and it never buzzes.
 *
 * There is NO CEILING on a hold. "You have been looking at this question for N
 * minutes, so let me also buzz your wrist" is a notification about something
 * already in front of the user. A hold ends by absence, or by the question
 * expiring (`PUSH_QUESTION_EXPIRY_MS`) — never by a timer.
 *
 * The 30-80 questions a day this handles are mostly answered at the desk within
 * seconds. Under the old delay they cost three minutes of silence each when
 * nobody was there; under presence gating they buzz at once when nobody is
 * there, and not at all when somebody is. The notification's meaning is
 * unchanged and is the whole point: *nobody has dealt with this.*
 *
 * -- Sleep / resume (still no per-question `setTimeout`) ----------------------
 *
 * VERIFIED, not assumed, and the reasoning survives the redesign intact. Node
 * timers are driven by libuv's monotonic clock (`uv_hrtime`), which on Windows
 * is `QueryPerformanceCounter`, and Microsoft documents QPC's suspend behaviour
 * explicitly:
 *
 *   "QueryPerformanceCounter reads the performance counter and returns the
 *    total number of ticks that have occurred since the Windows operating
 *    system was started, INCLUDING THE TIME WHEN THE MACHINE WAS IN A SLEEP
 *    STATE such as standby, hibernate, or connected standby."
 *   -- learn.microsoft.com/windows/win32/sysinfo/acquiring-high-resolution-time-stamps
 *
 * So a `setTimeout` deadline armed before a six-hour suspend does not fire at
 * its deadline and does not fire some grace period after the lid opens: it
 * fires the instant the process thaws, for every question at once, at the exact
 * moment the user sits back down. That is why there is no per-question timer
 * here, only a coarse repeating sweep that re-evaluates presence and therefore
 * has no deadline to miss.
 *
 * The batched-buzz-at-lid-open failure the old awake-time accounting existed to
 * prevent has NOT been forgotten — it moved to where it belongs. A machine that
 * has just woken has a keystroke stamp from before the suspend and no fresh
 * beacon, which reads as "away" and would fire everything held. `presence.ts`
 * opens a ten-second settling window on an Electron `resume`/`unlock` beacon, in
 * which held questions stay held (F7). It delays a correct push by ten seconds;
 * it never cancels one.
 *
 * `Date.now()` is wall-clock, so it is corrected on resume and stepped by NTP in
 * either direction. Every age computed from it in this feature is clamped at
 * zero and discarded past a future tolerance, and both failure directions
 * resolve towards "away" — see `human-input.ts` and `presence.ts`.
 *
 * -- Serialising a send against its own retraction ----------------------------
 *
 * A send takes tens of seconds in the worst case (bounded retries with backoff).
 * The old code committed the sent record, started the broadcast, and let
 * `retract` run independently — so an answer arriving mid-send could complete
 * its retraction while the ORIGINAL push was still in FCM's queue, and the
 * original would then be delivered AFTER the retraction that was supposed to
 * cancel it. The notification outlives its subject, which is the one thing §13.3
 * exists to prevent.
 *
 * So every FCM operation for a questionId runs on a per-question promise chain,
 * and a retraction additionally CANCELS the in-flight send (the cancel is
 * checked between attempts, so a retraction does not wait out four backoffs).
 * Chaining per question is strictly stronger than the per-(questionId, device)
 * ordering that is actually required, and is far simpler to prove.
 *
 * -- Restart (the fence) ------------------------------------------------------
 *
 * Schedule state used to be deliberately in-memory: a restart drops it, but a
 * restart also drops the question store, so questions are re-captured from the
 * hook path and re-armed from zero. True, and harmless for a three-minute delay.
 * Not harmless now — a HELD question has no deadline, so losing it loses the
 * push entirely, and a question already pushed would be re-armed and pushed a
 * SECOND time. Both the armed set and the sent set are therefore rows in host.db
 * (`push-fence.ts`), reconstructed at start.
 *
 * The sweeper still never trusts `cancelPending`: at fire time it re-asks the
 * question store whether the question is still unanswered.
 *
 * ── Trust / secrets ──────────────────────────────────────────────────────────
 *
 * The service account at `~/.superset/companion/fcm-service-account.json` lives
 * OUTSIDE both repos. Its contents are never logged, never included in an error
 * message, and never returned to a caller: failures name the FIELD or the PATH,
 * never a value. Minted OAuth access tokens are held in memory only and are
 * likewise never logged.
 *
 * An auth failure FAILS LOUD. A broken service account must not degrade to
 * silence — silence is indistinguishable from "no questions", which is the one
 * state the user must never be wrong about.
 */

import { createSign, randomInt } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
	FCM_PROJECT_ID,
	PUSH_DATA_HARD_CAP_BYTES,
	PUSH_TTL_MS,
	PUSH_VALUE_PATTERN,
} from "./config";
import { base64UrlEncode, sleep } from "./crypto";
import type { DeviceStore } from "./device-store";
import { MAX_APP_VERSION_CHARS } from "./limits";
import type { PresenceStore, PresenceVerdict } from "./presence";
import type { PushFence } from "./push-fence";
import type {
	DeviceRecord,
	PushData,
	PushEnvelope,
	QuestionId,
	RegisterRequest,
	RegisterResponse,
	SealedRequestContext,
	WorkspaceId,
} from "./types";
import { SealedError } from "./types";

// ---------------------------------------------------------------------------
// Constants. PUSH_TTL_MS / PUSH_DATA_HARD_CAP_BYTES are normative in
// PROTOCOL.md §15 and come from config.ts, as do the two presence windows
// (PRESENCE_WINDOW_MS / BEACON_FRESH_MS) that `presence.ts` reads. The ones
// below are implementation choices of this module — named, not magic.
// ---------------------------------------------------------------------------

/**
 * (PUSH-PRESENCE) How often the scheduler re-evaluates held questions.
 *
 * This is the ONLY timer in the module and it is a repeating coarse tick, never
 * a per-question deadline (see the sleep/resume note above). It was 15 s, sized
 * against a 180 s delay where the granularity was immaterial. It is now the
 * latency between the user walking away and their phone buzzing about a question
 * that was held while they were there, so it is 2 s: fast enough to feel
 * immediate, slow enough to be free (one presence evaluation over a map that is
 * empty almost all the time, on an unref'd timer that only runs while something
 * is actually held).
 *
 * A question captured while the user is ALREADY away does not wait for a tick at
 * all — `schedule` evaluates presence inline and fires on the spot.
 */
export const PUSH_SWEEP_INTERVAL_MS = 2_000;

/**
 * How long a "we pushed this" record is kept after the push, so `retract` knows
 * whether a notification actually exists on the phone.
 *
 * (RETRACT-WINDOW) It used to be one `PUSH_TTL_MS` (15 min), on the reasoning
 * that "after that FCM itself has given up delivering and there is nothing left
 * to retract". That reasoning covers the wrong message. `PUSH_TTL_MS` bounds how
 * long FCM will keep trying to DELIVER an undelivered message; it says nothing
 * about a message that WAS delivered, whose notification then sits on the
 * handset until something dismisses it. Sixteen minutes after the buzz, the
 * record was gone, `sendRetraction` returned silently, and the notification for
 * an answered question stayed on the watch until the phone next came to the
 * foreground and swept.
 *
 * A retraction is meaningful for exactly as long as the notification can still
 * be on the device, so this now matches the question store's own 24 h retention:
 * past that the question itself is gone and there is nothing to be consistent
 * with. Cost is one small record per push, and 30-80 pushes a day is the
 * measured traffic.
 */
export const PUSH_SENT_RECORD_RETENTION_MS = 86_400_000;

/**
 * (RETRACT-WINDOW) Hard ceiling on the sent-record map, so lengthening the
 * retention cannot turn into unbounded growth if the traffic assumption above is
 * ever wrong. Oldest-first eviction, loudly — an evicted record is a retraction
 * that will silently no-op.
 */
export const PUSH_MAX_SENT_RECORDS = 4_096;

/** Google's documented ceiling on an FCM message payload. Ours is 160 bytes. */
export const FCM_PAYLOAD_ABSOLUTE_CAP_BYTES = 4096;

export const FCM_SEND_ENDPOINT = `https://fcm.googleapis.com/v1/projects/${FCM_PROJECT_ID}/messages:send`;
export const FCM_OAUTH_SCOPE =
	"https://www.googleapis.com/auth/firebase.messaging";
export const FCM_OAUTH_AUDIENCE = "https://oauth2.googleapis.com/token";
export const FCM_OAUTH_GRANT_TYPE =
	"urn:ietf:params:oauth:grant-type:jwt-bearer";

/** Lifetime requested for the self-signed JWT assertion. Google's maximum. */
export const OAUTH_ASSERTION_LIFETIME_S = 3600;
/** Refresh this long before the access token actually expires. */
export const OAUTH_REFRESH_SKEW_MS = 300_000;

export const FCM_REQUEST_TIMEOUT_MS = 10_000;
/** Total attempts per device per message, including the first. Bounded, always. */
export const FCM_SEND_MAX_ATTEMPTS = 4;
export const FCM_BACKOFF_BASE_MS = 1_000;
export const FCM_BACKOFF_MAX_MS = 30_000;

/** FCM registration tokens are base64url-ish with a `:` separator. */
const FCM_TOKEN_PATTERN = /^[A-Za-z0-9_:.-]{32,4096}$/;
/**
 * The length comes from `limits.ts` so this cannot drift from the cap
 * `pairing.ts` and `http.ts` enforce on the same value; the CHARACTER SET is
 * this boundary's own and is deliberately stricter than theirs.
 */
const APP_VERSION_PATTERN = new RegExp(
	`^[A-Za-z0-9_.+-]{1,${MAX_APP_VERSION_CHARS}}$`,
);

const LOG = "[companion/push]";

// ---------------------------------------------------------------------------
// Faults
// ---------------------------------------------------------------------------

/**
 * A condition that makes push structurally impossible: a missing or malformed
 * service account, a rejected assertion, a revoked key, the wrong project. It is
 * NOT recoverable by retrying and it must never be swallowed — the user would
 * see a silent watch and read it as "no questions".
 */
export interface PushFault {
	kind: "config" | "auth";
	atMs: number;
	/** Diagnostic. Never contains key material, a token, or question text. */
	message: string;
}

/** Thrown on the synchronous paths; recorded as a `PushFault` on the async ones. */
export class PushConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PushConfigError";
	}
}

export class PushAuthError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PushAuthError";
	}
}

// ---------------------------------------------------------------------------
// §13.1 — the payload, and the runtime assertions that make a text leak throw
// ---------------------------------------------------------------------------

const PUSH_DATA_KEYS = ["v", "k", "i", "w", "n", "x"] as const;
const PUSH_ENVELOPE_KEYS = ["token", "android", "data"] as const;
const PUSH_ANDROID_KEYS = ["priority", "ttl", "collapse_key"] as const;

function assertClosedKeySet(
	value: object,
	expected: readonly string[],
	what: string,
): void {
	const actual = Object.keys(value).sort();
	const wanted = [...expected].sort();
	if (actual.length !== wanted.length) {
		throw new PushConfigError(
			`${what} key set is not closed: expected [${wanted.join(",")}], got [${actual.join(",")}]`,
		);
	}
	for (let i = 0; i < wanted.length; i++) {
		if (actual[i] !== wanted[i]) {
			throw new PushConfigError(
				`${what} key set is not closed: expected [${wanted.join(",")}], got [${actual.join(",")}]`,
			);
		}
	}
}

/**
 * §13.1 runtime assertions, each a THROW, never a log-and-continue:
 *  - the `data` key set is EXACTLY {v,k,i,w,n,x} — an unexpected key is a bug;
 *  - every value matches /^[A-Za-z0-9_-]{1,43}$/, which no natural-language
 *    string satisfies, so a leak cannot be introduced by a later edit without
 *    failing immediately;
 *  - serialised `data` <= 160 bytes (and the whole message <= Google's 4096);
 *  - `message.notification` is absent — enforced by a CLOSED envelope key set,
 *    which also rules out `apns`, `webpush` and `fcm_options`;
 *  - `collapse_key` is the questionId, so a retraction replaces an
 *    original push that is still queued undelivered at FCM (§13.3).
 */
export function assertPushDataSafe(
	data: PushData,
	envelope: PushEnvelope,
): void {
	assertClosedKeySet(data, PUSH_DATA_KEYS, "push data");
	assertClosedKeySet(envelope, PUSH_ENVELOPE_KEYS, "push envelope");
	assertClosedKeySet(envelope.android, PUSH_ANDROID_KEYS, "push android block");

	for (const key of PUSH_DATA_KEYS) {
		const value: unknown = data[key];
		if (typeof value !== "string") {
			throw new PushConfigError(
				`push data.${key} must be a string, got ${typeof value}`,
			);
		}
		if (!PUSH_VALUE_PATTERN.test(value)) {
			// The value is NOT echoed: if the assertion is firing, the value is
			// exactly the thing that must not leave the process.
			throw new PushConfigError(
				`push data.${key} does not match the opaque-id pattern — refusing to send (possible text leak)`,
			);
		}
	}

	if (data.v !== "1") {
		throw new PushConfigError(`push data.v must be "1"`);
	}
	if (data.k !== "q" && data.k !== "r") {
		throw new PushConfigError(`push data.k must be "q" or "r"`);
	}

	const serialisedData = JSON.stringify(data);
	const dataBytes = Buffer.byteLength(serialisedData, "utf8");
	if (dataBytes > PUSH_DATA_HARD_CAP_BYTES) {
		throw new PushConfigError(
			`push data is ${dataBytes} bytes, cap is ${PUSH_DATA_HARD_CAP_BYTES}`,
		);
	}

	const messageBytes = Buffer.byteLength(
		JSON.stringify({ message: envelope }),
		"utf8",
	);
	if (messageBytes > FCM_PAYLOAD_ABSOLUTE_CAP_BYTES) {
		throw new PushConfigError(
			`push message is ${messageBytes} bytes, FCM cap is ${FCM_PAYLOAD_ABSOLUTE_CAP_BYTES}`,
		);
	}

	if (envelope.android.priority !== "high") {
		throw new PushConfigError(
			"push must be high priority or it will not survive Doze",
		);
	}
	if (envelope.android.collapse_key !== data.i) {
		throw new PushConfigError(
			"push collapse_key must be the questionId so a retraction replaces the original",
		);
	}
	if (envelope.token.length === 0) {
		throw new PushConfigError("push token is empty");
	}
}

function buildEnvelope(token: string, data: PushData): PushEnvelope {
	const envelope: PushEnvelope = {
		token,
		android: {
			priority: "high",
			ttl: `${Math.floor(PUSH_TTL_MS / 1000)}s`,
			collapse_key: data.i,
		},
		data,
	};
	assertPushDataSafe(data, envelope);
	return envelope;
}

/** §13.1 — `k: "q"`, a question is pending and nobody has dealt with it. */
export function buildQuestionPushData(input: {
	questionId: QuestionId;
	workspaceId: WorkspaceId;
	questionCount: number;
	expiresAtMs: number;
}): PushData {
	if (
		!Number.isInteger(input.questionCount) ||
		input.questionCount < 1 ||
		input.questionCount > 99
	) {
		throw new PushConfigError(
			`questionCount must be an integer in 1..99, got ${String(input.questionCount)}`,
		);
	}
	if (!Number.isInteger(input.expiresAtMs) || input.expiresAtMs <= 0) {
		throw new PushConfigError("expiresAtMs must be a positive integer");
	}
	return {
		v: "1",
		k: "q",
		i: input.questionId,
		w: input.workspaceId,
		n: String(input.questionCount),
		x: String(input.expiresAtMs),
	};
}

/** §13.3 — `k: "r"`, cancel the notification; a notification must never outlive its subject. */
export function buildRetractPushData(input: {
	questionId: QuestionId;
	workspaceId: WorkspaceId;
	nowMs: number;
}): PushData {
	return {
		v: "1",
		k: "r",
		i: input.questionId,
		w: input.workspaceId,
		n: "0",
		x: String(input.nowMs),
	};
}

// ---------------------------------------------------------------------------
// Service account + OAuth (hand-rolled JWT-bearer; no new dependency)
// ---------------------------------------------------------------------------

/** Only the fields we use. The parsed object NEVER leaves this module. */
interface ServiceAccount {
	projectId: string;
	privateKeyId: string;
	privateKeyPem: string;
	clientEmail: string;
	tokenUri: string;
}

function requireStringField(
	source: Record<string, unknown>,
	field: string,
	path: string,
): string {
	const value = source[field];
	if (typeof value !== "string" || value.length === 0) {
		// Names the FIELD and the PATH. Never a value.
		throw new PushConfigError(
			`service account at ${path} is missing a usable "${field}"`,
		);
	}
	return value;
}

/**
 * Validate at the API boundary. No defaults, no partial acceptance: a service
 * account that cannot mint a token must fail here, loudly, at startup, rather
 * than three minutes into the first unanswered question.
 */
export async function loadServiceAccount(
	path: string,
): Promise<ServiceAccount> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		throw new PushConfigError(
			`cannot read the FCM service account at ${path}: ${(error as NodeJS.ErrnoException).code ?? "unknown error"}`,
		);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new PushConfigError(
			`the FCM service account at ${path} is not valid JSON`,
		);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new PushConfigError(
			`the FCM service account at ${path} is not a JSON object`,
		);
	}
	const source = parsed as Record<string, unknown>;

	if (source.type !== "service_account") {
		throw new PushConfigError(
			`the credential at ${path} is not a service account (expected type "service_account")`,
		);
	}

	const account: ServiceAccount = {
		projectId: requireStringField(source, "project_id", path),
		privateKeyId: requireStringField(source, "private_key_id", path),
		privateKeyPem: requireStringField(source, "private_key", path),
		clientEmail: requireStringField(source, "client_email", path),
		tokenUri: requireStringField(source, "token_uri", path),
	};

	if (account.projectId !== FCM_PROJECT_ID) {
		throw new PushConfigError(
			`the service account at ${path} is for project "${account.projectId}", expected "${FCM_PROJECT_ID}" — pushes would go nowhere`,
		);
	}
	if (!account.privateKeyPem.includes("BEGIN PRIVATE KEY")) {
		throw new PushConfigError(
			`the service account at ${path} has a "private_key" that is not a PKCS#8 PEM`,
		);
	}
	if (!account.tokenUri.startsWith("https://")) {
		throw new PushConfigError(
			`the service account at ${path} has a non-https "token_uri"`,
		);
	}

	return account;
}

function signAssertion(account: ServiceAccount, nowMs: number): string {
	const issuedAtS = Math.floor(nowMs / 1000);
	// `base64UrlEncode` (crypto.ts), never a hand-rolled
	// `.replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"")` chain: this is a
	// JWT signing input, where one wrong character in the encoding is a signature
	// Google rejects with an opaque `invalid_grant`.
	const header = base64UrlEncode(
		Buffer.from(
			JSON.stringify({
				alg: "RS256",
				typ: "JWT",
				kid: account.privateKeyId,
			}),
			"utf8",
		),
	);
	const claims = base64UrlEncode(
		Buffer.from(
			JSON.stringify({
				iss: account.clientEmail,
				scope: FCM_OAUTH_SCOPE,
				aud: FCM_OAUTH_AUDIENCE,
				iat: issuedAtS,
				exp: issuedAtS + OAUTH_ASSERTION_LIFETIME_S,
			}),
			"utf8",
		),
	);
	const signingInput = `${header}.${claims}`;
	const signer = createSign("RSA-SHA256");
	signer.update(signingInput);
	signer.end();
	const signature = base64UrlEncode(signer.sign(account.privateKeyPem));
	return `${signingInput}.${signature}`;
}

/**
 * Caches one access token and mints a new one at most once at a time
 * (single-flight): a burst of pushes after a resume must not fire N concurrent
 * token requests.
 */
export interface AccessTokenSource {
	get(nowMs: number, signal: AbortSignal): Promise<string>;
	/** Drops the cached token after a 401 so the next send re-mints exactly once. */
	invalidate(): void;
}

export function createAccessTokenSource(
	account: ServiceAccount,
): AccessTokenSource {
	let cachedToken: string | null = null;
	let cachedExpiresAtMs = 0;
	let inFlight: Promise<string> | null = null;

	async function mint(nowMs: number, signal: AbortSignal): Promise<string> {
		const assertion = signAssertion(account, nowMs);
		const body = new URLSearchParams({
			grant_type: FCM_OAUTH_GRANT_TYPE,
			assertion,
		});

		let response: Response;
		try {
			response = await fetch(account.tokenUri, {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: body.toString(),
				signal: AbortSignal.any([
					signal,
					AbortSignal.timeout(FCM_REQUEST_TIMEOUT_MS),
				]),
			});
		} catch (error) {
			// Network-level: transient, NOT an auth fault. The caller retries.
			throw new Error(
				`FCM token request failed: ${error instanceof Error ? error.name : "unknown"}`,
			);
		}

		const text = await response.text();
		if (!response.ok) {
			// Only the two documented, non-secret fields are surfaced.
			let code = "unknown";
			let description = "";
			try {
				const parsed: unknown = JSON.parse(text);
				if (typeof parsed === "object" && parsed !== null) {
					const record = parsed as Record<string, unknown>;
					if (typeof record.error === "string") code = record.error;
					if (typeof record.error_description === "string") {
						description = record.error_description.slice(0, 200);
					}
				}
			} catch {
				// keep the defaults; the raw body is deliberately not logged
			}
			if (response.status >= 500 || response.status === 429) {
				throw new Error(
					`FCM token endpoint ${response.status} (${code}) — transient`,
				);
			}
			throw new PushAuthError(
				`FCM token endpoint rejected the service account: HTTP ${response.status} ${code}${description ? ` — ${description}` : ""}`,
			);
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			throw new PushAuthError("FCM token endpoint returned non-JSON");
		}
		if (typeof parsed !== "object" || parsed === null) {
			throw new PushAuthError("FCM token endpoint returned a non-object");
		}
		const record = parsed as Record<string, unknown>;
		const accessToken = record.access_token;
		const expiresIn = record.expires_in;
		if (typeof accessToken !== "string" || accessToken.length === 0) {
			throw new PushAuthError(
				"FCM token endpoint returned no usable access_token",
			);
		}
		if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn)) {
			throw new PushAuthError(
				"FCM token endpoint returned no usable expires_in",
			);
		}

		cachedToken = accessToken;
		cachedExpiresAtMs = nowMs + expiresIn * 1000;
		return accessToken;
	}

	return {
		get(nowMs, signal) {
			if (
				cachedToken !== null &&
				nowMs < cachedExpiresAtMs - OAUTH_REFRESH_SKEW_MS
			) {
				return Promise.resolve(cachedToken);
			}
			if (inFlight !== null) return inFlight;
			const attempt = mint(nowMs, signal).finally(() => {
				inFlight = null;
			});
			inFlight = attempt;
			return attempt;
		},
		invalidate() {
			cachedToken = null;
			cachedExpiresAtMs = 0;
		},
	};
}

// ---------------------------------------------------------------------------
// FCM send + response classification
// ---------------------------------------------------------------------------

export type FcmOutcome =
	/** Accepted by FCM. Delivery to the handset is still best-effort. */
	| { kind: "delivered" }
	/** The token is dead. PRUNE it; never retry against it. */
	| { kind: "token_dead"; errorCode: string }
	/** Retry with backoff, bounded. */
	| { kind: "transient"; errorCode: string; retryAfterMs: number | null }
	/** Configuration is broken. FAIL LOUD; do not degrade to silence. */
	| { kind: "auth_fault"; errorCode: string };

/**
 * Pulls the FCM `errorCode` out of the v1 error envelope
 * (`error.details[].errorCode`), falling back to `error.status`. The body never
 * contains our payload, so it is safe to surface.
 */
function classifyFcmError(status: number, text: string): FcmOutcome {
	let errorCode = "UNKNOWN";
	try {
		const parsed: unknown = JSON.parse(text);
		if (typeof parsed === "object" && parsed !== null) {
			const error = (parsed as Record<string, unknown>).error;
			if (typeof error === "object" && error !== null) {
				const errorRecord = error as Record<string, unknown>;
				if (typeof errorRecord.status === "string") {
					errorCode = errorRecord.status;
				}
				const details = errorRecord.details;
				if (Array.isArray(details)) {
					for (const detail of details) {
						if (typeof detail !== "object" || detail === null) continue;
						const code = (detail as Record<string, unknown>).errorCode;
						if (typeof code === "string" && code.length > 0) {
							errorCode = code;
							break;
						}
					}
				}
			}
		}
	} catch {
		// leave UNKNOWN; status alone decides below
	}

	switch (errorCode) {
		case "UNREGISTERED":
		case "NOT_FOUND":
		case "INVALID_ARGUMENT":
			// Per the contract: prune, do not retry forever. INVALID_ARGUMENT can
			// also mean a malformed message, but every message has already passed
			// assertPushDataSafe, so a bad token is the live explanation — and the
			// caller logs the prune loudly so a systematic payload bug is visible
			// as "every device pruned at once" rather than as silence.
			return { kind: "token_dead", errorCode };
		case "SENDER_ID_MISMATCH":
		case "THIRD_PARTY_AUTH_ERROR":
		case "PERMISSION_DENIED":
		case "UNAUTHENTICATED":
			return { kind: "auth_fault", errorCode };
		case "QUOTA_EXCEEDED":
		case "UNAVAILABLE":
		case "INTERNAL":
			return { kind: "transient", errorCode, retryAfterMs: null };
		default:
			break;
	}

	if (status === 401 || status === 403) {
		return { kind: "auth_fault", errorCode };
	}
	if (status === 404) {
		return { kind: "token_dead", errorCode };
	}
	if (status === 400) {
		return { kind: "token_dead", errorCode };
	}
	return { kind: "transient", errorCode, retryAfterMs: null };
}

function parseRetryAfterMs(headerValue: string | null): number | null {
	if (headerValue === null) return null;
	const seconds = Number(headerValue);
	if (Number.isFinite(seconds) && seconds >= 0) {
		return Math.min(seconds * 1000, FCM_BACKOFF_MAX_MS);
	}
	const asDate = Date.parse(headerValue);
	if (Number.isFinite(asDate)) {
		return Math.max(0, Math.min(asDate - Date.now(), FCM_BACKOFF_MAX_MS));
	}
	return null;
}

/** Full jitter, capped. Never unbounded, never a tight loop. */
function backoffDelayMs(attempt: number): number {
	const ceiling = Math.min(
		FCM_BACKOFF_BASE_MS * 2 ** (attempt - 1),
		FCM_BACKOFF_MAX_MS,
	);
	return randomInt(0, Math.max(1, Math.floor(ceiling)) + 1);
}

async function sendOnce(
	envelope: PushEnvelope,
	accessToken: string,
	signal: AbortSignal,
): Promise<FcmOutcome> {
	let response: Response;
	try {
		response = await fetch(FCM_SEND_ENDPOINT, {
			method: "POST",
			headers: {
				authorization: `Bearer ${accessToken}`,
				"content-type": "application/json; charset=UTF-8",
			},
			body: JSON.stringify({ message: envelope }),
			signal: AbortSignal.any([
				signal,
				AbortSignal.timeout(FCM_REQUEST_TIMEOUT_MS),
			]),
		});
	} catch (error) {
		return {
			kind: "transient",
			errorCode: error instanceof Error ? error.name : "NETWORK",
			retryAfterMs: null,
		};
	}

	if (response.ok) {
		// Drain so the socket is reusable; the body is a message name we ignore.
		await response.text();
		return { kind: "delivered" };
	}

	const text = await response.text();
	const outcome = classifyFcmError(response.status, text);
	if (outcome.kind === "transient") {
		return {
			...outcome,
			retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after")),
		};
	}
	return outcome;
}

// ---------------------------------------------------------------------------
// §7.6 register
// ---------------------------------------------------------------------------

export interface RegisterDeps {
	devices: DeviceStore;
	now(): number;
}

/**
 * §7.6. Idempotent; one token per deviceId, a new token replaces the old.
 *
 * Every field is validated at the boundary and there are no defaults: a
 * malformed registration is a `bad_request`, never a silently-normalised one.
 * The token itself is secret-ish and is never logged.
 */
export async function handleRegister(
	deps: RegisterDeps,
	ctx: SealedRequestContext,
	request: RegisterRequest,
): Promise<RegisterResponse> {
	if (
		typeof request.fcmToken !== "string" ||
		!FCM_TOKEN_PATTERN.test(request.fcmToken)
	) {
		throw new SealedError(400, {
			code: "bad_request",
			message: "fcmToken is not a well-formed FCM registration token",
			retryAfterMs: null,
			detail: null,
		});
	}
	if (request.surface !== ctx.device.surface) {
		// The watch holds no key and never registers on its own; a surface that
		// disagrees with the paired device record is a client bug or an attempt.
		throw new SealedError(400, {
			code: "bad_request",
			message: "surface does not match the paired device record",
			retryAfterMs: null,
			detail: null,
		});
	}
	if (
		typeof request.appVersion !== "string" ||
		!APP_VERSION_PATTERN.test(request.appVersion)
	) {
		throw new SealedError(400, {
			code: "bad_request",
			message: "appVersion is missing or not a well-formed version string",
			retryAfterMs: null,
			detail: null,
		});
	}
	if (
		request.replacesToken !== null &&
		(typeof request.replacesToken !== "string" ||
			!FCM_TOKEN_PATTERN.test(request.replacesToken))
	) {
		throw new SealedError(400, {
			code: "bad_request",
			message: "replacesToken must be null or a well-formed FCM token",
			retryAfterMs: null,
			detail: null,
		});
	}

	const nowMs = deps.now();
	const unchanged =
		ctx.device.fcmToken === request.fcmToken &&
		ctx.device.fcmTokenUpdatedMs !== null;

	if (!unchanged) {
		await deps.devices.setFcmToken(
			ctx.device.deviceId,
			request.fcmToken,
			nowMs,
		);
		console.log(
			`${LOG} registered fcm token deviceId=${ctx.device.deviceId} surface=${request.surface} rotated=${request.replacesToken !== null}`,
		);
	}

	return {
		deviceId: ctx.device.deviceId,
		registeredAtMs: unchanged ? (ctx.device.fcmTokenUpdatedMs ?? nowMs) : nowMs,
		// (PUSH-PRESENCE) WIRE COMPATIBILITY, DELIBERATELY EMITTED AS ZERO.
		//
		// There is no delay any more — the desktop decides per question, from
		// presence, whether to push now or hold indefinitely. The FIELD stays
		// because paired phones consume it (`Session.kt` in
		// superset-companion), and dropping it from the response would break
		// every already-installed client's register parse. Zero is the honest
		// value: it is exactly the delay a client should assume, and a client
		// that renders "you will be notified after N minutes" now correctly
		// renders nothing.
		pushDelayMs: 0,
		pushTtlMs: PUSH_TTL_MS,
	};
}

// ---------------------------------------------------------------------------
// The sender
// ---------------------------------------------------------------------------

export interface PushSender {
	/**
	 * (PUSH-PRESENCE) Arms the push and evaluates presence IMMEDIATELY.
	 *
	 * Away right now -> the push goes out on this call, with no tick of latency.
	 * Present -> the question is HELD with no deadline and fires on the first
	 * sweep that sees presence lapse, provided `isStillUnanswered` still says so
	 * at that moment.
	 *
	 * Idempotent per questionId, and idempotent against the SENT set too: a
	 * question that has already been pushed is never re-armed, which is what
	 * stops a re-capture after a host-service restart from buzzing twice.
	 */
	schedule(input: {
		questionId: QuestionId;
		workspaceId: WorkspaceId;
		questionCount: number;
		expiresAtMs: number;
	}): void;
	/**
	 * Disarms. If a push had already gone out, this ALSO fires a retraction
	 * (fire-and-forget) — a notification must never outlive its subject, and a
	 * question that goes stale is just as resolved from the phone's point of view
	 * as one that was answered.
	 *
	 * This is the desk-answer path: `question-store` settles the record, the
	 * notifying sink in `companion/index.ts` calls this, and a question answered
	 * at the keyboard never buzzes.
	 */
	cancelPending(questionId: QuestionId): void;
	/**
	 * §13.3. Awaited retraction for the answer path, so the audit trail can note
	 * it. Same `collapse_key`, so if the original push is still queued
	 * undelivered at FCM the retraction REPLACES it and the phone never buzzes at
	 * all. No-op when no push was ever sent for this question.
	 *
	 * Takes NO workspaceId: the retraction must carry the workspaceId the
	 * ORIGINAL push carried, or the client cannot match the notification it is
	 * holding, and that value is the one in the sent record — never whatever a
	 * caller happens to pass.
	 *
	 * Ordered against the original send: it cancels an in-flight one and runs
	 * after it on the same per-question chain, so a retraction can never be
	 * overtaken by the push it retracts.
	 */
	retract(questionId: QuestionId): Promise<void>;
	/**
	 * The current fatal fault, or null. Non-null means push is DOWN and the user
	 * must be told: a silent watch reads as "no questions", which is the one
	 * state they must never be wrong about.
	 */
	getFault(): PushFault | null;
	/**
	 * Diagnostics for the boot harness and the probes: what is held, what has been
	 * sent, and why the last presence evaluation decided the way it did. Read-only
	 * — nothing in the product branches on it.
	 */
	inspect(): {
		armed: QuestionId[];
		sent: QuestionId[];
		lastVerdict: PresenceVerdict | null;
	};
	stop(): void;
}

export interface PushSenderDeps {
	/** `~/.superset/companion/fcm-service-account.json`. Read at start, never logged. */
	serviceAccountPath: string;
	devices: DeviceStore;
	/**
	 * (PUSH-PRESENCE) Is the user at the desk? The scheduler asks; it never
	 * decides. See `companion/presence.ts` for the two signals and why an
	 * unusable one resolves towards "away".
	 */
	presence: PresenceStore;
	/**
	 * The durable armed/sent fence. `null` only in tests that are not exercising
	 * restart behaviour — the bridge always supplies one, because without it a
	 * host-service restart loses every held push and re-sends every sent one.
	 */
	fence: PushFence | null;
	/**
	 * Re-checked at fire time. The scheduler NEVER trusts that `cancelPending`
	 * was called: a missed cancel would buzz the watch for a question already
	 * answered, which is exactly the noise presence gating exists to remove.
	 *
	 * MUST FAIL TOWARD `true`. `evaluate` acts on this once and irreversibly —
	 * the entry is already out of `armed` and a `false` goes to `forget()` —
	 * so anything the implementation is merely UNSURE about (an unreachable
	 * daemon, a stale liveness snapshot) has to answer "still unanswered". Only
	 * positive knowledge that the question is settled, or positive evidence that
	 * its terminal is gone, may return `false`. An implementation that reports
	 * uncertainty as `false` silently loses buzzes and nothing downstream can
	 * detect it.
	 */
	isStillUnanswered(questionId: QuestionId): boolean;
	/**
	 * Called on a fatal auth/config fault so the desktop can surface "push is
	 * broken" instead of degrading to silence.
	 */
	onFault(fault: PushFault): void;
	/** Injectable for tests. Wall clock. */
	now?: () => number;
}

interface ArmedQuestion {
	questionId: QuestionId;
	workspaceId: WorkspaceId;
	questionCount: number;
	expiresAtMs: number;
	armedAtWallMs: number;
}

interface SentRecord {
	workspaceId: WorkspaceId;
	sentAtMs: number;
}

/**
 * (PUSH-PRESENCE) A cancellable unit of FCM work.
 *
 * `cancelled` is checked between delivery attempts, so a retraction arriving
 * mid-send does not have to wait out four bounded backoffs before its own
 * message can go. Cancelling does NOT unsend anything already accepted by FCM —
 * that is what the retraction itself is for.
 */
interface SendToken {
	cancelled: boolean;
}

export function createPushSender(deps: PushSenderDeps): PushSender {
	const now = deps.now ?? (() => Date.now());
	if (
		deps.presence === null ||
		deps.presence === undefined ||
		typeof deps.presence.present !== "function"
	) {
		// (PUSH-PRESENCE) Validate at the boundary. Without a presence source the
		// scheduler has no basis for either decision it can make, and the failure
		// would present as a watch that either never buzzes or buzzes for
		// everything — both indistinguishable from a broken phone.
		throw new PushConfigError(
			"createPushSender requires a presence store; without it nothing can decide whether the user is at the desk",
		);
	}

	const armed = new Map<QuestionId, ArmedQuestion>();
	/** Questions a push actually went out for — the retraction's precondition. */
	const sent = new Map<QuestionId, SentRecord>();
	/**
	 * (PUSH-PRESENCE) One promise chain per questionId, so a send and its own
	 * retraction can never overlap or land out of order. Entries are dropped when
	 * the chain drains, so this cannot grow with traffic.
	 */
	const chains = new Map<QuestionId, Promise<void>>();
	/** The cancel token of the send currently on each question's chain. */
	const sendTokens = new Map<QuestionId, SendToken>();

	const abort = new AbortController();
	let sweepTimer: NodeJS.Timeout | null = null;
	let lastVerdict: PresenceVerdict | null = null;
	let fault: PushFault | null = null;
	let tokenSource: AccessTokenSource | null = null;
	let loading: Promise<AccessTokenSource> | null = null;
	let stopped = false;

	function raiseFault(kind: PushFault["kind"], message: string): void {
		const next: PushFault = { kind, atMs: now(), message };
		fault = next;
		// LOUD. A broken service account must never look like "no questions".
		console.error(
			`${LOG} PUSH IS DOWN (${kind}) — the watch will stay silent until this is fixed: ${message}`,
		);
		try {
			deps.onFault(next);
		} catch (error) {
			console.error(`${LOG} onFault handler threw`, error);
		}
	}

	function tokens(): Promise<AccessTokenSource> {
		if (tokenSource !== null) return Promise.resolve(tokenSource);
		if (loading !== null) return loading;
		const attempt = loadServiceAccount(deps.serviceAccountPath)
			.then((account) => {
				const source = createAccessTokenSource(account);
				tokenSource = source;
				return source;
			})
			.finally(() => {
				loading = null;
			});
		loading = attempt;
		return attempt;
	}

	async function targets(): Promise<DeviceRecord[]> {
		const all = await deps.devices.list();
		return all.filter(
			(device) =>
				device.revokedAtMs === null &&
				device.fcmToken !== null &&
				device.fcmToken.length > 0,
		);
	}

	async function deliver(
		device: DeviceRecord,
		data: PushData,
		cancel: SendToken | null,
	): Promise<void> {
		const token = device.fcmToken;
		if (token === null) return;
		const envelope = buildEnvelope(token, data);

		for (let attempt = 1; attempt <= FCM_SEND_MAX_ATTEMPTS; attempt++) {
			if (stopped) return;
			// (PUSH-PRESENCE) A retraction is waiting behind this send on the same
			// chain. Abandoning the remaining retries is not a lost push: whatever
			// FCM already accepted is exactly what the retraction is about to
			// collapse, and the alternative is making the retraction wait out four
			// bounded backoffs while the notification sits on the handset.
			if (cancel?.cancelled === true) {
				console.log(
					`${LOG} abandoning in-flight send for questionId=${data.i} — a retraction is queued behind it`,
				);
				return;
			}

			let accessToken: string;
			try {
				const source = await tokens();
				accessToken = await source.get(now(), abort.signal);
			} catch (error) {
				if (error instanceof PushAuthError) {
					raiseFault("auth", error.message);
					return;
				}
				if (error instanceof PushConfigError) {
					raiseFault("config", error.message);
					return;
				}
				// Transient token failure (network, 5xx). Back off and retry.
				if (attempt === FCM_SEND_MAX_ATTEMPTS) {
					console.error(
						`${LOG} giving up minting an access token after ${attempt} attempts: ${error instanceof Error ? error.message : "unknown"}`,
					);
					return;
				}
				await sleep(backoffDelayMs(attempt), {
					signal: abort.signal,
					unref: true,
				});
				continue;
			}

			const outcome = await sendOnce(envelope, accessToken, abort.signal);

			if (outcome.kind === "delivered") {
				if (fault !== null && fault.kind === "auth") {
					console.log(`${LOG} push recovered — auth fault cleared`);
					fault = null;
				}
				return;
			}

			if (outcome.kind === "token_dead") {
				// Prune. Never retry against a dead token.
				console.error(
					`${LOG} pruning dead FCM token deviceId=${device.deviceId} errorCode=${outcome.errorCode} — device must re-register`,
				);
				await deps.devices.setFcmToken(device.deviceId, null, now());
				return;
			}

			if (outcome.kind === "auth_fault") {
				// One re-mint covers a token that expired mid-flight; a second
				// failure is a real configuration fault and is fatal.
				if (attempt === 1) {
					tokenSource?.invalidate();
					continue;
				}
				raiseFault("auth", `FCM rejected the credential: ${outcome.errorCode}`);
				return;
			}

			if (attempt === FCM_SEND_MAX_ATTEMPTS) {
				console.error(
					`${LOG} push failed after ${attempt} attempts deviceId=${device.deviceId} errorCode=${outcome.errorCode}`,
				);
				return;
			}
			// `unref: true` on every backoff here: a pending retry must never by
			// itself hold host-service open, exactly like the sweep timer.
			await sleep(outcome.retryAfterMs ?? backoffDelayMs(attempt), {
				signal: abort.signal,
				unref: true,
			});
		}
	}

	async function broadcast(
		data: PushData,
		cancel: SendToken | null,
	): Promise<void> {
		const devices = await targets();
		if (devices.length === 0) {
			console.log(
				`${LOG} no registered device with a live token — nothing to ${data.k === "q" ? "push" : "retract"}`,
			);
			return;
		}
		await Promise.all(devices.map((device) => deliver(device, data, cancel)));
	}

	/**
	 * (PUSH-PRESENCE) Run `work` after everything already queued for this
	 * question, and never concurrently with it.
	 *
	 * Serialising per QUESTION is strictly stronger than the per-(questionId,
	 * device) ordering that is actually required — a broadcast fans out to every
	 * device inside one job — and it is the version whose correctness is obvious.
	 * A failure is logged and does NOT poison the chain: the next operation for
	 * the same question must still run, and the most likely next operation after a
	 * failed send is the retraction.
	 */
	function enqueue(
		questionId: QuestionId,
		what: string,
		work: () => Promise<void>,
	): Promise<void> {
		const previous = chains.get(questionId) ?? Promise.resolve();
		const next = previous
			.then(work, work)
			.catch((error: unknown) => {
				console.error(`${LOG} ${what} failed questionId=${questionId}`, error);
			})
			.finally(() => {
				if (chains.get(questionId) === next) chains.delete(questionId);
			});
		chains.set(questionId, next);
		return next;
	}

	function ensureSweeping(): void {
		if (sweepTimer !== null || stopped) return;
		sweepTimer = setInterval(sweep, PUSH_SWEEP_INTERVAL_MS);
		// Never hold host-service open on account of a pending buzz.
		sweepTimer.unref?.();
	}

	function stopSweepingIfIdle(): void {
		if (armed.size > 0 || sweepTimer === null) return;
		clearInterval(sweepTimer);
		sweepTimer = null;
	}

	/** Forgets a question in memory AND on disk, in that order. */
	function forget(questionId: QuestionId): void {
		armed.delete(questionId);
		sent.delete(questionId);
		try {
			deps.fence?.clear(questionId);
		} catch (error) {
			// A fence write failing is not a reason to lose the in-memory decision,
			// but it IS a reason to say so: the row will be re-read at the next
			// start and could resurrect a question that is already resolved.
			console.error(
				`${LOG} could not clear the push fence for questionId=${questionId}`,
				error,
			);
		}
	}

	/**
	 * (PUSH-PRESENCE) THE PRESENCE DECISION. Everything else in this module
	 * serves these fifteen lines.
	 *
	 * Called from two places and they must behave identically: the sweep, and
	 * `schedule` itself so that a question captured while the user is already away
	 * fires on the spot instead of waiting for a tick.
	 *
	 * Accounting is SYNCHRONOUS from end to end, and every entry that fires is
	 * removed from `armed` and recorded in `sent` — in memory AND in the fence —
	 * before any `await` exists. A send can take tens of seconds (bounded
	 * retries), during which further ticks WILL run; if commitment happened after
	 * the await, a slow send would let the next tick collect the same question
	 * again and buzz twice.
	 */
	function evaluate(wallMs: number): void {
		if (stopped) return;

		const verdict = deps.presence.present(wallMs);
		lastVerdict = verdict;

		const due: { entry: ArmedQuestion; data: PushData }[] = [];
		for (const entry of [...armed.values()]) {
			if (wallMs >= entry.expiresAtMs) {
				// The client would discard it unopened; buzzing for it is pure noise.
				forget(entry.questionId);
				continue;
			}
			// HELD. No deadline, no ceiling: the user can see the question, and a
			// notification about something already on their screen is the noise that
			// gets a watch muted. It is released by absence, never by a timer.
			if (verdict.present) continue;

			armed.delete(entry.questionId);

			// NEVER trust that cancelPending was called.
			//
			// This is a ONE-SHOT decision: the entry is already out of `armed`, so
			// `forget()` below is permanent — there is no later tick that
			// reconsiders it. That is only safe because the predicate is contracted
			// to fail toward `true` (see `isStillUnanswered`), so `false` means the
			// question is settled or its terminal is provably gone, never merely
			// "could not tell".
			if (!deps.isStillUnanswered(entry.questionId)) {
				forget(entry.questionId);
				continue;
			}

			due.push({
				entry,
				data: buildQuestionPushData({
					questionId: entry.questionId,
					workspaceId: entry.workspaceId,
					questionCount: entry.questionCount,
					expiresAtMs: entry.expiresAtMs,
				}),
			});
			// Recorded BEFORE the send: a retraction for a push that failed is
			// harmless (a silent data message the client no-ops), whereas a
			// notification with no retraction record outlives its subject.
			sent.set(entry.questionId, {
				workspaceId: entry.workspaceId,
				sentAtMs: wallMs,
			});
			try {
				deps.fence?.markSent(entry.questionId, wallMs);
			} catch (error) {
				// Loud, and the send still happens. A missing `sent` row costs a
				// possible duplicate after a restart; refusing to send costs the buzz
				// this whole feature exists for.
				console.error(
					`${LOG} could not record questionId=${entry.questionId} as sent in the push fence — a restart could re-send it`,
					error,
				);
			}
		}

		for (const [questionId, record] of sent) {
			if (wallMs - record.sentAtMs > PUSH_SENT_RECORD_RETENTION_MS) {
				forget(questionId);
			}
		}
		// (RETRACT-WINDOW) Map iteration is insertion-ordered and entries are
		// inserted in send order, so the first keys are the oldest sends.
		while (sent.size > PUSH_MAX_SENT_RECORDS) {
			const oldest = sent.keys().next();
			if (oldest.done) break;
			forget(oldest.value);
			console.error(
				`${LOG} sent-record table exceeded ${PUSH_MAX_SENT_RECORDS}; dropped the oldest record. A retraction for it will now silently do nothing, and the notification on the handset will survive until the client's foreground sweep.`,
			);
		}

		stopSweepingIfIdle();

		for (const { entry, data } of due) {
			console.log(
				`${LOG} pushing questionId=${entry.questionId} — the user is away (${verdict.reason}, keystrokes ${verdict.humanInputAgeMs === null ? "none" : `${Math.round(verdict.humanInputAgeMs)}ms ago`}, beacon ${verdict.beaconAgeMs === null ? "none" : `${Math.round(verdict.beaconAgeMs)}ms old`}); held ${Math.round(wallMs - entry.armedAtWallMs)}ms`,
			);
			const token: SendToken = { cancelled: false };
			sendTokens.set(entry.questionId, token);
			void enqueue(entry.questionId, "push broadcast", async () => {
				try {
					await broadcast(data, token);
				} finally {
					if (sendTokens.get(entry.questionId) === token) {
						sendTokens.delete(entry.questionId);
					}
				}
			});
		}
	}

	function sweep(): void {
		evaluate(now());
	}

	/**
	 * §13.3. Cancels the in-flight original first, then runs BEHIND it on the same
	 * chain — so the retraction can never be overtaken by the push it retracts.
	 */
	function sendRetraction(questionId: QuestionId): Promise<void> {
		const record = sent.get(questionId);
		if (record === undefined) {
			// (RETRACT-WINDOW) A no-op, and it is SAID. Either no push ever went out
			// for this question — the common, uninteresting case — or one did and its
			// record has been reclaimed, in which case a notification is standing on
			// a handset that nothing here will now pull. Silence made those two
			// indistinguishable.
			console.log(
				`${LOG} no push record for questionId=${questionId} — retraction is a no-op (no push was sent, or its record aged past ${PUSH_SENT_RECORD_RETENTION_MS}ms)`,
			);
			return Promise.resolve();
		}
		forget(questionId);
		const inFlight = sendTokens.get(questionId);
		if (inFlight !== undefined) {
			inFlight.cancelled = true;
			sendTokens.delete(questionId);
		}
		console.log(`${LOG} retracting questionId=${questionId}`);
		return enqueue(questionId, "retraction", () =>
			broadcast(
				buildRetractPushData({
					questionId,
					// The workspaceId we actually pushed with, so the client matches
					// the notification it is holding.
					workspaceId: record.workspaceId,
					nowMs: now(),
				}),
				null,
			),
		);
	}

	/**
	 * (PUSH-PRESENCE) Rebuild the armed and sent sets from host.db.
	 *
	 * Runs at construction, before anything can be scheduled. A reconstructed
	 * ARMED entry is held exactly like a fresh one and is re-checked against
	 * `isStillUnanswered` before it can fire, so a question answered while the
	 * host-service was down never buzzes. A reconstructed SENT entry blocks both
	 * a re-arm and a second send, and is what makes a later retraction able to
	 * carry the original workspaceId.
	 */
	function reconstruct(): void {
		const fence = deps.fence;
		if (fence === null) return;
		const nowMs = now();
		let records: Awaited<ReturnType<PushFence["load"]>>;
		try {
			records = fence.load({
				nowMs,
				sentRetentionMs: PUSH_SENT_RECORD_RETENTION_MS,
			});
		} catch (error) {
			// LOUD, and not fatal: a bridge that refuses to start because it could
			// not read a notification fence is a worse outcome than one that starts
			// having forgotten some pushes.
			console.error(
				`${LOG} could not reconstruct the push fence — held pushes from before the restart are lost and already-sent ones could repeat`,
				error,
			);
			return;
		}

		for (const record of records) {
			if (record.state === "sent") {
				sent.set(record.questionId, {
					workspaceId: record.workspaceId,
					sentAtMs: record.sentAtMs ?? record.armedAtMs,
				});
				continue;
			}
			armed.set(record.questionId, {
				questionId: record.questionId,
				workspaceId: record.workspaceId,
				questionCount: record.questionCount,
				expiresAtMs: record.expiresAtMs,
				armedAtWallMs: record.armedAtMs,
			});
		}
		if (armed.size > 0) {
			console.log(
				`${LOG} reconstructed ${armed.size} held push(es) and ${sent.size} sent record(s) from the fence`,
			);
			ensureSweeping();
		}
	}

	reconstruct();

	return {
		schedule(input) {
			if (stopped) {
				throw new PushConfigError("push sender is stopped");
			}
			const nowMs = now();
			if (input.expiresAtMs <= nowMs) {
				throw new PushConfigError(
					`refusing to arm a push for a question that already expired (${input.expiresAtMs} <= ${nowMs})`,
				);
			}
			// Idempotent against BOTH sets. `sent` matters as much as `armed`: after
			// a host-service restart the hook path re-captures live questions, and
			// re-arming one that has already buzzed would buzz it again.
			if (armed.has(input.questionId) || sent.has(input.questionId)) return;
			// Validate the payload NOW, at the call site that introduced it — a bad
			// questionCount or a text leak must not surface later, from a timer.
			buildQuestionPushData(input);

			armed.set(input.questionId, {
				questionId: input.questionId,
				workspaceId: input.workspaceId,
				questionCount: input.questionCount,
				expiresAtMs: input.expiresAtMs,
				armedAtWallMs: nowMs,
			});
			try {
				deps.fence?.arm({
					questionId: input.questionId,
					workspaceId: input.workspaceId,
					questionCount: input.questionCount,
					expiresAtMs: input.expiresAtMs,
					armedAtMs: nowMs,
				});
			} catch (error) {
				console.error(
					`${LOG} could not persist the armed push for questionId=${input.questionId} — a restart would lose it`,
					error,
				);
			}
			ensureSweeping();
			// (PUSH-PRESENCE) ZERO LATENCY WHEN NOBODY IS THERE. Evaluated inline
			// rather than left to the next tick: if the user is already away, the
			// whole value of the feature is that their phone buzzes NOW.
			evaluate(nowMs);
		},

		cancelPending(questionId) {
			const hadSent = sent.has(questionId);
			armed.delete(questionId);
			if (hadSent) {
				void sendRetraction(questionId);
			} else {
				forget(questionId);
			}
			stopSweepingIfIdle();
		},

		async retract(questionId) {
			// An armed-but-never-sent question is FORGOTTEN here, not merely
			// disarmed. `sendRetraction` clears the fence only when there is a sent
			// record to retract, so without this a retracted hold would leave its row
			// behind and a restart would reconstruct a hold for a question the caller
			// has explicitly given up on.
			const hadSent = sent.has(questionId);
			armed.delete(questionId);
			if (!hadSent) forget(questionId);
			stopSweepingIfIdle();
			await sendRetraction(questionId);
		},

		getFault() {
			return fault;
		},

		inspect() {
			return {
				armed: [...armed.keys()],
				sent: [...sent.keys()],
				lastVerdict,
			};
		},

		stop() {
			stopped = true;
			if (sweepTimer !== null) {
				clearInterval(sweepTimer);
				sweepTimer = null;
			}
			abort.abort();
			for (const token of sendTokens.values()) token.cancelled = true;
			sendTokens.clear();
			chains.clear();
			// The MAPS are cleared, the ROWS are not: the fence is what a restart
			// reads back, and a clean shutdown must not be the thing that loses a
			// held push.
			armed.clear();
			sent.clear();
			// The parsed private key is a JS string and cannot be zeroized; it is
			// dropped and left to GC. Noted, not pretended otherwise.
			tokenSource?.invalidate();
			tokenSource = null;
		},
	};
}
