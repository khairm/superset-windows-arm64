/**
 * (COMPANION-BRIDGE) — Cloudflare Access JWT validation (§2.1).
 *
 * The bridge does NOT trust the edge. A policy misconfiguration, an accidental
 * bypass rule, or a future second application on the same hostname could
 * otherwise let requests through untouched, so all six checks run here.
 *
 * If the JWKS endpoint is unreachable the bridge FAILS CLOSED
 * (`503 edge_unverifiable`). It never falls back to trusting the header.
 *
 * ---------------------------------------------------------------------------
 * Scope, stated so nobody over-reads this module
 * ---------------------------------------------------------------------------
 * Access is NOT the security boundary (§2.2). It stops scanners and brute force
 * at the edge and is independently revocable from Cloudflare. What authenticates
 * a device is the sealed envelope. A stolen service token yields nothing but
 * `unknown_device`, because the token is not a device key.
 *
 * Consequence for this file: every failure here is a refusal, never a downgrade
 * to a "less trusted" path. There is no such path.
 */

import { createPublicKey, type KeyObject, verify } from "node:crypto";
import {
	ACCESS_AUD,
	ACCESS_CLIENT_ID,
	ACCESS_CLOCK_LEEWAY_MS,
	ACCESS_ISSUER,
	ACCESS_JWKS_CACHE_MS,
	ACCESS_JWKS_REFETCH_MIN_INTERVAL_MS,
	ACCESS_JWKS_URL,
} from "./config";
import {
	BoundedStreamOverflowError,
	base64UrlDecode,
	monotonicNowMs,
	readBoundedStream,
} from "./crypto";
import { type AccessClaims, CleartextError } from "./types";

// ---------------------------------------------------------------------------
// bounds — an unauthenticated caller must not be able to make us do work
// ---------------------------------------------------------------------------

/** Cloudflare publishes a handful of keys. Anything near this is an anomaly. */
const JWKS_MAX_KEYS = 32;
/** A JWKS document is ~2 KiB. This is a hard ceiling on what we will read. */
const JWKS_MAX_BYTES = 64 * 1024;
const JWKS_FETCH_TIMEOUT_MS = 5_000;
/** An assertion is ~1 KiB. Refuse anything absurd before parsing it. */
const MAX_ASSERTION_CHARS = 8 * 1024;
/** `iat` may not be further ahead than this (plus leeway). */
const MAX_IAT_SKEW_AHEAD_MS = 60_000;

const ACCESS_HEADER = "cf-access-jwt-assertion";
const ACCESS_COOKIE = "CF_Authorization";

function denied(): never {
	throw new CleartextError(403, "access_denied");
}

function unverifiable(): never {
	throw new CleartextError(503, "edge_unverifiable");
}

// ---------------------------------------------------------------------------
// JWT structure
// ---------------------------------------------------------------------------

interface JwtHeader {
	alg: string;
	kid?: string;
	typ?: string;
}

interface JwtPayload {
	iss?: unknown;
	aud?: unknown;
	exp?: unknown;
	iat?: unknown;
	nbf?: unknown;
	common_name?: unknown;
}

function decodeJsonSegment(segment: string): unknown {
	let raw: Uint8Array;
	try {
		raw = base64UrlDecode(segment);
	} catch {
		// A padded or non-canonical segment is not an RFC 7515 JWT. Fail closed
		// rather than being liberal about what we accept from the edge.
		denied();
	}
	try {
		return JSON.parse(Buffer.from(raw).toString("utf8"));
	} catch {
		denied();
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredNumber(value: unknown): number {
	// Missing required claim is a hard error, never defaulted.
	if (typeof value !== "number" || !Number.isFinite(value)) {
		denied();
	}
	return value;
}

// ---------------------------------------------------------------------------
// JWKS cache
// ---------------------------------------------------------------------------

interface JwksKey {
	kid: string;
	key: KeyObject;
}

interface JwksSnapshot {
	keys: Map<string, KeyObject>;
	/**
	 * MONOTONIC, not wall clock.
	 *
	 * Cache freshness used to be `Date.now() - fetchedAtMs < CACHE_MS`, which
	 * moving the clock BACKWARDS turns into a permanently satisfied condition:
	 * the elapsed time goes negative, the snapshot never expires, and a signing
	 * key Cloudflare has since retired stays trusted indefinitely. A monotonic
	 * reference cannot be moved, so the one-hour bound on trusting a JWKS
	 * snapshot is a bound rather than a suggestion.
	 */
	fetchedAtMonoMs: number;
}

interface RsaJwk {
	kty?: unknown;
	alg?: unknown;
	use?: unknown;
	kid?: unknown;
	n?: unknown;
	e?: unknown;
}

/**
 * Imports only RSA keys usable for RS256 verification. An `EC`, `oct` or
 * unusable entry is skipped rather than adapted: this bridge verifies RS256 and
 * nothing else, and silently widening the accepted algorithm set is precisely
 * the misconfiguration §2.1 exists to survive.
 */
function importJwks(document: unknown): JwksKey[] {
	if (!isRecord(document) || !Array.isArray(document.keys)) {
		unverifiable();
	}
	if (document.keys.length > JWKS_MAX_KEYS) {
		unverifiable();
	}

	const imported: JwksKey[] = [];
	for (const entry of document.keys) {
		if (!isRecord(entry)) {
			continue;
		}
		const jwk = entry as RsaJwk;
		if (jwk.kty !== "RSA") {
			continue;
		}
		if (jwk.alg !== undefined && jwk.alg !== "RS256") {
			continue;
		}
		if (jwk.use !== undefined && jwk.use !== "sig") {
			continue;
		}
		if (
			typeof jwk.kid !== "string" ||
			typeof jwk.n !== "string" ||
			typeof jwk.e !== "string"
		) {
			continue;
		}
		try {
			imported.push({
				kid: jwk.kid,
				key: createPublicKey({
					key: { kty: "RSA", n: jwk.n, e: jwk.e },
					format: "jwk",
				}),
			});
		} catch {
			// A malformed key in an otherwise-good document must not take the
			// whole document down; the missing kid simply fails to match later.
		}
	}
	return imported;
}

// ---------------------------------------------------------------------------
// validator
// ---------------------------------------------------------------------------

export interface AccessValidator {
	/**
	 * Validates `Cf-Access-Jwt-Assertion` (or the `CF_Authorization` cookie).
	 * Throws `CleartextError(403, "access_denied")` on any failed check and
	 * `CleartextError(503, "edge_unverifiable")` when the JWKS is unreachable.
	 *
	 * Checks, all required: header present; RS256 signature against the JWKS
	 * (`alg: none` and HMAC algorithms rejected BEFORE any key lookup); `iss`;
	 * `aud` contains the configured AUD; `exp`/`iat`/`nbf` within leeway;
	 * `common_name` equals the service-token client id (absent for an
	 * interactive login, which is therefore rejected).
	 */
	validate(
		headers: Readonly<Record<string, string | undefined>>,
	): Promise<AccessClaims>;
}

/** Injection points exist for tests only; production uses the §15 constants. */
export interface AccessValidatorOptions {
	jwksUrl?: string;
	issuer?: string;
	aud?: string;
	clientId?: string;
	fetchImpl?: typeof fetch;
	/** Wall clock. ONLY for JWT claim arithmetic, which is defined in wall time. */
	now?: () => number;
	/** Monotonic clock. Everything about how long we may keep trusting a key. */
	monotonicNow?: () => number;
}

export function createAccessValidator(
	options: AccessValidatorOptions = {},
): AccessValidator {
	const jwksUrl = options.jwksUrl ?? ACCESS_JWKS_URL;
	const issuer = options.issuer ?? ACCESS_ISSUER;
	const expectedAud = options.aud ?? ACCESS_AUD;
	const expectedClientId = options.clientId ?? ACCESS_CLIENT_ID;
	const doFetch = options.fetchImpl ?? fetch;
	const now = options.now ?? Date.now;
	const monotonicNow = options.monotonicNow ?? monotonicNowMs;

	let snapshot: JwksSnapshot | null = null;
	/**
	 * Monotonic, and NEGATIVE_INFINITY rather than 0 so the very first fetch is
	 * never mistaken for one that just happened — `monotonicNow()` starts near
	 * zero at process start, and a `0` sentinel would rate-limit the first
	 * genuine fetch for the first 60 s of the process's life.
	 */
	let lastFetchAttemptMonoMs = Number.NEGATIVE_INFINITY;
	/** Single-flight: a burst must not open N connections to Cloudflare. */
	let inFlight: Promise<JwksSnapshot> | null = null;

	async function fetchJwks(): Promise<JwksSnapshot> {
		if (inFlight) {
			return inFlight;
		}
		lastFetchAttemptMonoMs = monotonicNow();
		const run = (async (): Promise<JwksSnapshot> => {
			let response: Response;
			try {
				response = await doFetch(jwksUrl, {
					signal: AbortSignal.timeout(JWKS_FETCH_TIMEOUT_MS),
					redirect: "error",
					headers: { accept: "application/json" },
				});
			} catch {
				// Unreachable JWKS => FAIL CLOSED. There is deliberately no branch
				// here that trusts the header instead.
				unverifiable();
			}
			if (!response.ok) {
				unverifiable();
			}
			const text = await readBoundedBody(response, JWKS_MAX_BYTES);
			let document: unknown;
			try {
				document = JSON.parse(text);
			} catch {
				unverifiable();
			}
			const keys = new Map<string, KeyObject>();
			for (const entry of importJwks(document)) {
				keys.set(entry.kid, entry.key);
			}
			if (keys.size === 0) {
				unverifiable();
			}
			const fresh: JwksSnapshot = {
				keys,
				fetchedAtMonoMs: monotonicNow(),
			};
			snapshot = fresh;
			return fresh;
		})();
		inFlight = run;
		try {
			return await run;
		} finally {
			inFlight = null;
		}
	}

	/**
	 * Resolves a `kid` to a key.
	 *
	 * EVERY fetch — cache expiry as well as unknown-kid — is rate-limited to once
	 * per 60 s. That is what stops an unauthenticated caller from using a stream
	 * of invented `kid` values, or a JWKS outage plus ordinary traffic, to make
	 * the bridge hammer Cloudflare at the pre-auth request rate.
	 *
	 * When a refetch is due but rate-limited we return `edge_unverifiable`
	 * (transient — the client backs off and retries) rather than `access_denied`
	 * (permanent). Both refuse the request; only the client's next move differs.
	 * A genuine key rotation therefore self-heals within 60 s.
	 *
	 * BOTH clocks here are monotonic. Neither the cache lifetime nor the refetch
	 * interval may be extended by moving the system clock.
	 */
	async function resolveKey(kid: string): Promise<KeyObject> {
		// A NEGATIVE age is treated as stale, not as fresh.
		//
		// `performance.now()` cannot go backwards, so in production this is
		// unreachable — but `monotonicNow` is an injection point, and the plain
		// `age < CACHE_MS` test it replaces classifies every negative age as fresh.
		// That is the same shape of bug as the wall-clock one this module already
		// fixed: the one input that must never be permissive is "I cannot tell how
		// old this is". An age that cannot be computed forwards is not evidence the
		// snapshot is current, so it forces a refetch.
		const snapshotAgeMs =
			snapshot === null ? null : monotonicNow() - snapshot.fetchedAtMonoMs;
		const fresh =
			snapshotAgeMs !== null &&
			snapshotAgeMs >= 0 &&
			snapshotAgeMs < ACCESS_JWKS_CACHE_MS;
		if (
			!fresh &&
			monotonicNow() - lastFetchAttemptMonoMs <
				ACCESS_JWKS_REFETCH_MIN_INTERVAL_MS
		) {
			// Stale (or absent) JWKS and we are inside the refetch window: fail
			// closed. Serving from an expired snapshot would be trusting a key we
			// can no longer confirm is current.
			unverifiable();
		}
		const current = fresh && snapshot ? snapshot : await fetchJwks();

		const hit = current.keys.get(kid);
		if (hit) {
			return hit;
		}
		if (
			monotonicNow() - lastFetchAttemptMonoMs <
			ACCESS_JWKS_REFETCH_MIN_INTERVAL_MS
		) {
			unverifiable();
		}
		const refreshed = await fetchJwks();
		const retried = refreshed.keys.get(kid);
		if (!retried) {
			// Fresh JWKS, still no such key: this is not our issuer's token.
			denied();
		}
		return retried;
	}

	return {
		async validate(headers) {
			const assertion = readAssertion(headers);
			if (!assertion || assertion.length > MAX_ASSERTION_CHARS) {
				denied();
			}

			const parts = assertion.split(".");
			if (parts.length !== 3) {
				denied();
			}
			const [encodedHeader, encodedPayload, encodedSignature] = parts as [
				string,
				string,
				string,
			];
			if (
				encodedHeader.length === 0 ||
				encodedPayload.length === 0 ||
				encodedSignature.length === 0
			) {
				denied();
			}

			const rawHeader = decodeJsonSegment(encodedHeader);
			if (!isRecord(rawHeader)) {
				denied();
			}
			const header = rawHeader as unknown as JwtHeader;

			// ALGORITHM FIRST, BEFORE ANY KEY LOOKUP. `alg: none` and the HMAC
			// family are the two classic JWT confusion attacks; rejecting them
			// here means no code path downstream ever sees a non-RS256 token.
			if (header.alg !== "RS256") {
				denied();
			}
			if (typeof header.kid !== "string" || header.kid.length === 0) {
				denied();
			}

			const key = await resolveKey(header.kid);

			let signature: Uint8Array;
			try {
				signature = base64UrlDecode(encodedSignature);
			} catch {
				denied();
			}
			const signingInput = Buffer.from(
				`${encodedHeader}.${encodedPayload}`,
				"ascii",
			);
			// RSASSA-PKCS1-v1_5 over SHA-256; Node's default padding for an RSA key.
			const signatureValid = verify(
				"sha256",
				signingInput,
				key,
				Buffer.from(signature),
			);
			if (!signatureValid) {
				denied();
			}

			const rawPayload = decodeJsonSegment(encodedPayload);
			if (!isRecord(rawPayload)) {
				denied();
			}
			const payload = rawPayload as JwtPayload;

			if (payload.iss !== issuer) {
				denied();
			}

			const audience = normaliseAud(payload.aud);
			if (!audience.includes(expectedAud)) {
				denied();
			}

			// Cloudflare emits `exp`/`iat`/`nbf` in SECONDS (RFC 7519 NumericDate).
			const nowMs = now();
			const expMs = requiredNumber(payload.exp) * 1000;
			const iatMs = requiredNumber(payload.iat) * 1000;
			if (expMs <= nowMs - ACCESS_CLOCK_LEEWAY_MS) {
				denied();
			}
			if (iatMs > nowMs + MAX_IAT_SKEW_AHEAD_MS + ACCESS_CLOCK_LEEWAY_MS) {
				denied();
			}
			if (payload.nbf !== undefined) {
				const nbfMs = requiredNumber(payload.nbf) * 1000;
				if (nbfMs > nowMs + ACCESS_CLOCK_LEEWAY_MS) {
					denied();
				}
			}

			// The sixth check. `common_name` is what Access sets for non-identity
			// (service token) authentication. A human who somehow authenticated
			// has no `common_name`, so this rejects them — which is the intent:
			// the application carries exactly one Service-Auth policy and an
			// interactive session reaching the origin means something changed.
			if (payload.common_name !== expectedClientId) {
				denied();
			}

			const claims: AccessClaims = {
				iss: issuer,
				aud: audience,
				exp: expMs / 1000,
				iat: iatMs / 1000,
				common_name: expectedClientId,
			};
			if (payload.nbf !== undefined) {
				claims.nbf = payload.nbf as number;
			}
			return claims;
		},
	};
}

/**
 * Reads a response body with the size cap enforced DURING the read.
 *
 * `await response.text()` buffers the whole body first and only then compares
 * its length, so the cap described nothing an attacker had to respect: a
 * compromised or impersonated JWKS host could stream gigabytes and the bridge
 * would allocate all of it before deciding it was too big. `readBoundedStream`
 * stops at the first chunk that crosses the limit.
 *
 * WHAT STAYS HERE, because it is this caller's policy and not the reader's: the
 * `Content-Length` pre-check acts only on a FINITE oversized value (an absent or
 * unparsable header is not evidence of anything, and the streaming cap catches
 * the body regardless); an absent body is `edge_unverifiable`, not zero bytes;
 * and overflow maps to `edge_unverifiable` rather than a 413. The reader is asked
 * to CANCEL on overflow — this is a response being abandoned, and cancelling
 * closes the socket instead of leaving a hostile host draining into it.
 */
async function readBoundedBody(
	response: Response,
	maxBytes: number,
): Promise<string> {
	const declared = response.headers.get("content-length");
	if (declared !== null) {
		const length = Number(declared);
		if (Number.isFinite(length) && length > maxBytes) {
			unverifiable();
		}
	}
	const body = response.body;
	if (body === null) {
		unverifiable();
	}
	let bytes: Uint8Array;
	try {
		bytes = await readBoundedStream(body, maxBytes, {
			cancelOnOverflow: true,
		});
	} catch (error) {
		if (error instanceof BoundedStreamOverflowError) {
			unverifiable();
		}
		// A socket or stream failure is NOT an overflow and must not be laundered
		// into one — it propagates to `fetchJwks`, which already fails closed.
		throw error;
	}
	return Buffer.from(bytes).toString("utf8");
}

function normaliseAud(value: unknown): string[] {
	if (typeof value === "string") {
		return [value];
	}
	if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
		return value as string[];
	}
	denied();
}

/**
 * Header first; the `CF_Authorization` cookie is the documented fallback. The
 * phone never uses the cookie — it is accepted so a browser diagnostic session
 * is not silently a different code path from the one that runs in production.
 */
function readAssertion(
	headers: Readonly<Record<string, string | undefined>>,
): string | null {
	for (const [name, value] of Object.entries(headers)) {
		if (name.toLowerCase() === ACCESS_HEADER && value) {
			return value.trim();
		}
	}
	for (const [name, value] of Object.entries(headers)) {
		if (name.toLowerCase() !== "cookie" || !value) {
			continue;
		}
		for (const pair of value.split(";")) {
			const eq = pair.indexOf("=");
			if (eq < 0) {
				continue;
			}
			if (pair.slice(0, eq).trim() === ACCESS_COOKIE) {
				return pair.slice(eq + 1).trim();
			}
		}
	}
	return null;
}
