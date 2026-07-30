/**
 * (COMPANION-BRIDGE) — AES-256-GCM sealed envelope + HKDF key derivation (§3).
 *
 * One primitive provides confidentiality, integrity, request binding and (with
 * the nonce cache) replay protection. There is no second signature layer and
 * therefore no second canonicalisation format to mismatch.
 *
 * Order of operations on an inbound envelope is NORMATIVE and must not be
 * rearranged: parse header -> freshness -> nonce cache -> decrypt. A replayed
 * nonce must cost no crypto.
 *
 * Node's built-in `node:crypto` only. No third-party crypto dependency, ever.
 *
 * ---------------------------------------------------------------------------
 * INTEROP NOTE — HKDF `info` encoding (PROTOCOL.md §3.1 is ambiguous here)
 * ---------------------------------------------------------------------------
 * §3.1 writes `K_dev = HKDF-Expand(PRK, "sc/v1 device " || pid || deviceId, 32)`
 * and `K_evt = HKDF-Expand-Label(K_dev, "sc/v1 seal evt " || ticketId, 32)`
 * without saying whether `pid` / `deviceId` / `ticketId` are the raw 16-byte
 * values or their canonical base64url text. Both are unambiguous (fixed
 * lengths) and equally secure, but they are NOT interchangeable — picking
 * differently on the two sides yields two different keys and every request
 * fails as `unknown_device` with no diagnostic.
 *
 * RESOLVED: the id suffixes contribute their RAW BYTES, never their base64url
 * text.
 *     K_dev  info = utf8("sc/v1 device ")   || pid(16)      || deviceId(16)  = 45
 *     K_evt  info = utf8("sc/v1 seal evt ") || ticketId(16)                  = 31
 *
 * Raw bytes, not text, because:
 *  - it is what the Android client already implements
 *    (`KeyDerivation.ID_ENCODING_IS_RAW_BYTES = true`), so this side is the one
 *    that had to move;
 *  - it matches the §4.4 pairing TRANSCRIPT, which is unambiguously raw and
 *    byte-length-specified (117 bytes), so the whole pairing exchange now uses
 *    ONE convention rather than two;
 *  - it has no charset dependency.
 *
 * An earlier revision of this file declared the base64url-text form "normative
 * for the Android client" while the client declared the raw-byte form normative
 * for the bridge. The two never agreed, so pairing could never succeed. Use
 * `hkdfExpandInfo` (raw `info` bytes) for anything carrying an id suffix;
 * `hkdfExpandLabel` remains correct for the four fixed labels that carry none.
 */

import {
	createCipheriv,
	createDecipheriv,
	createHash,
	createHmac,
	createPrivateKey,
	createPublicKey,
	diffieHellman,
	generateKeyPairSync,
	type KeyObject,
	randomBytes as nodeRandomBytes,
	timingSafeEqual,
} from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { inArray } from "drizzle-orm";
import type { HostDb } from "../db";
import { companionReplayNonces } from "../db";
import {
	ENVELOPE_HEADER_BYTES,
	FRESHNESS_WINDOW_MS,
	GCM_TAG_BYTES,
	LOG_PREFIX,
	MAX_SEALED_PLAINTEXT_BYTES,
	MIN_ENVELOPE_BYTES,
	NONCE_BYTES,
	NONCE_CACHE_RETENTION_MS,
	ENVELOPE_VERSION as PROTOCOL_ENVELOPE_VERSION,
} from "./config";
import {
	KEY_BYTES,
	WIRE_ID_BYTES,
	WIRE_ID_CHARS,
	X25519_KEY_BYTES,
} from "./limits";
import {
	CleartextError,
	type DeviceId,
	ENVELOPE_KIND_EVENT,
	ENVELOPE_KIND_REQUEST,
	ENVELOPE_KIND_RESPONSE,
	type EnvelopeKind,
	type EventAadParts,
	type ParsedEnvelope,
	type RequestAadParts,
	type ResponseAadParts,
} from "./types";

// ---------------------------------------------------------------------------
// invariants
// ---------------------------------------------------------------------------

const SHA256_BYTES = 32;
const AAD_SEPARATOR = 0x00;
const HKDF_MAX_BLOCKS = 255;

/**
 * §3.5 says the cache is "unbounded within retention", with a steady-state
 * ceiling of ~1 950 entries at the enforced rate limits. "Unbounded" is not
 * implementable — a flood that outruns compaction would grow the process until
 * it dies. This hard cap is ~33x the pre-auth ceiling (600 req/min x 15 min
 * retention = 9 000) and is therefore unreachable by legal traffic.
 *
 * On reaching it the cache COMPACTS, and if it is still over the cap it
 * REFUSES the request (`503 bridge_unavailable`). It does NOT evict live
 * entries: eviction would silently re-open the replay window that this cache
 * exists to close, which is exactly the class of failure the global rules
 * forbid. Fail loud instead.
 */
export const REPLAY_CACHE_MAX_ENTRIES = 65_536;

/**
 * The newest N records are retained NO MATTER WHAT THE CLOCK SAYS.
 *
 * Age alone is not a safe retention rule, because age is measured against a
 * clock the bridge does not control. A forward jump makes every live record look
 * expired, compaction drops them, and after the correction a request captured
 * inside the freshness window replays successfully — the exact hole this cache
 * exists to close. Retention is therefore `age AND insertion order`: a record
 * only leaves once it is BOTH older than the retention AND outside the newest
 * `REPLAY_MIN_RETAINED_ENTRIES`.
 *
 * The floor is derived, not guessed: the pre-auth rate cap is 600 req/min (§12)
 * and the accepted freshness window is 120 s wide, so at most 1 200 records can
 * be admitted inside one window. 8 192 is ~6.8x that, and one eighth of
 * `REPLAY_CACHE_MAX_ENTRIES`, so the floor can never stop compaction from
 * clearing the cap.
 */
export const REPLAY_MIN_RETAINED_ENTRIES = 8_192;

/**
 * (REPLAY-CACHE-DB) The PRE-DATABASE record layout, kept only to read a
 * `replay.log` an older build left behind: 16 deviceId || 12 nonce || 8 big-endian
 * seenAtMs. Nothing writes this shape any more — admissions are rows in host.db —
 * and these three go away once no installation can still be carrying that file.
 */
const REPLAY_RECORD_BYTES = WIRE_ID_BYTES + NONCE_BYTES + 8;
const REPLAY_LOG_FILENAME = "replay.log";
const REPLAY_LOG_TMP_FILENAME = "replay.log.tmp";

/** RFC 8410 PKCS#8 prefix for an X25519 private key (16 bytes, then the scalar). */
const X25519_PKCS8_PREFIX = Uint8Array.from([
	0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04,
	0x22, 0x04, 0x20,
]);
/** RFC 8410 SPKI prefix for an X25519 public key (12 bytes, then the point). */
const X25519_SPKI_PREFIX = Uint8Array.from([
	0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x03, 0x21, 0x00,
]);

/**
 * A bug in this module, not a protocol failure. Distinct from `CleartextError`
 * and `SealedError` so a caller can never accidentally turn a programming
 * mistake into a wire code.
 */
export class CryptoInvariantError extends Error {
	constructor(message: string) {
		super(`(COMPANION-BRIDGE) crypto invariant: ${message}`);
		this.name = "CryptoInvariantError";
	}
}

function invariant(condition: boolean, message: string): asserts condition {
	if (!condition) {
		throw new CryptoInvariantError(message);
	}
}

function requireLength(
	value: Uint8Array,
	expected: number,
	what: string,
): void {
	invariant(
		value.length === expected,
		`${what} must be ${expected} bytes, got ${value.length}`,
	);
}

/** Node accepts `Uint8Array` everywhere; this is a zero-copy view, not a copy. */
function view(bytes: Uint8Array): Buffer {
	return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

// ---------------------------------------------------------------------------
// §3.1 HKDF (RFC 5869)
// ---------------------------------------------------------------------------

/**
 * RFC 5869 Extract. `PRK = HMAC-SHA256(salt, IKM)`.
 *
 * NOTE: this is deliberately NOT `crypto.hkdfSync`, which performs Extract AND
 * Expand in one call. §3.1 needs the two halves separately because `PRK` is
 * reused for four different Expand calls, and because `HKDF-Expand-Label` in
 * steady state uses an already-uniform key directly as the PRK with no second
 * extraction.
 */
export function hkdfExtract(salt: Uint8Array, ikm: Uint8Array): Uint8Array {
	return new Uint8Array(
		createHmac("sha256", view(salt)).update(view(ikm)).digest(),
	);
}

/**
 * RFC 5869 Expand with `PRK = key` and `info = utf8(label)` — no length prefix,
 * no null terminator.
 *
 * Correct ONLY for the four fixed labels that carry no id suffix
 * (`sc/v1 confirm-phone`, `sc/v1 confirm-desktop`, `sc/v1 seal c2s`,
 * `sc/v1 seal s2c`). Anything that appends a pid / deviceId / ticketId MUST use
 * `hkdfExpandInfo` with the RAW BYTES of that id — see the INTEROP NOTE above.
 */
export function hkdfExpandLabel(
	key: Uint8Array,
	label: string,
	length: number,
): Uint8Array {
	return hkdfExpandInfo(
		key,
		new Uint8Array(Buffer.from(label, "utf8")),
		length,
	);
}

/**
 * RFC 5869 Expand with `PRK = key` and a caller-built `info` byte string.
 *
 * This is the form every derivation with an id suffix uses, because an id
 * contributes its raw bytes and not its base64url text (INTEROP NOTE above).
 */
export function hkdfExpandInfo(
	key: Uint8Array,
	info: Uint8Array,
	length: number,
): Uint8Array {
	requireLength(key, SHA256_BYTES, "HKDF PRK");
	invariant(
		Number.isInteger(length) && length > 0,
		`HKDF output length must be a positive integer, got ${length}`,
	);
	const blocks = Math.ceil(length / SHA256_BYTES);
	invariant(
		blocks <= HKDF_MAX_BLOCKS,
		`HKDF output length ${length} exceeds 255 * HashLen`,
	);

	const infoView = view(info);
	const out = Buffer.allocUnsafe(blocks * SHA256_BYTES);
	let previous = Buffer.alloc(0);
	for (let i = 1; i <= blocks; i += 1) {
		previous = createHmac("sha256", view(key))
			.update(previous)
			.update(infoView)
			.update(Buffer.from([i]))
			.digest();
		previous.copy(out, (i - 1) * SHA256_BYTES);
	}
	const result = new Uint8Array(out.subarray(0, length));
	out.fill(0);
	return result;
}

/**
 * `utf8(label) || suffix` as one `info` byte string. The single place the
 * label-plus-raw-id concatenation is built, so the two derivations that need it
 * (`K_dev`, `K_evt`) cannot drift apart.
 */
export function hkdfInfoWithSuffix(
	label: string,
	...suffixes: readonly Uint8Array[]
): Uint8Array {
	return concatBytes([new Uint8Array(Buffer.from(label, "utf8")), ...suffixes]);
}

// ---------------------------------------------------------------------------
// §15.1 hashes and MACs
// ---------------------------------------------------------------------------

export function sha256(bytes: Uint8Array): Uint8Array {
	return new Uint8Array(createHash("sha256").update(view(bytes)).digest());
}

/** §4.4 key confirmation. Compared with `constantTimeEquals`, never with `===`. */
export function hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
	return new Uint8Array(
		createHmac("sha256", view(key)).update(view(data)).digest(),
	);
}

// ---------------------------------------------------------------------------
// §15.1 X25519
// ---------------------------------------------------------------------------

function x25519PrivateKeyObject(raw: Uint8Array): KeyObject {
	requireLength(raw, X25519_KEY_BYTES, "X25519 private key");
	const der = Buffer.concat([view(X25519_PKCS8_PREFIX), view(raw)]);
	return createPrivateKey({ key: der, format: "der", type: "pkcs8" });
}

function x25519PublicKeyObject(raw: Uint8Array): KeyObject {
	requireLength(raw, X25519_KEY_BYTES, "X25519 public key");
	const der = Buffer.concat([view(X25519_SPKI_PREFIX), view(raw)]);
	return createPublicKey({ key: der, format: "der", type: "spki" });
}

function rawFromDer(der: Buffer, prefix: Uint8Array, what: string): Uint8Array {
	invariant(
		der.length === prefix.length + X25519_KEY_BYTES,
		`unexpected ${what} DER length ${der.length}`,
	);
	return new Uint8Array(der.subarray(prefix.length));
}

/**
 * X25519 ECDH. Rejects an all-zero shared secret, which is what a small-order
 * peer point produces (RFC 7748 §6.1 "check whether the output is all zero").
 * Anything else here would silently agree on a key an attacker also knows.
 */
export function x25519(
	privateKey: Uint8Array,
	peerPublicKey: Uint8Array,
): Uint8Array {
	requireLength(privateKey, X25519_KEY_BYTES, "X25519 private key");
	invariant(
		peerPublicKey.length === X25519_KEY_BYTES,
		`peer X25519 public key must be ${X25519_KEY_BYTES} bytes, got ${peerPublicKey.length}`,
	);

	const shared = new Uint8Array(
		diffieHellman({
			privateKey: x25519PrivateKeyObject(privateKey),
			publicKey: x25519PublicKeyObject(peerPublicKey),
		}),
	);
	requireLength(shared, X25519_KEY_BYTES, "X25519 shared secret");

	if (isAllZero(shared)) {
		zero(shared);
		throw new CryptoInvariantError(
			"X25519 produced an all-zero shared secret (small-order peer point) — rejected",
		);
	}
	return shared;
}

export function generateX25519KeyPair(): {
	privateKey: Uint8Array;
	publicKey: Uint8Array;
} {
	const pair = generateKeyPairSync("x25519");
	return {
		privateKey: rawFromDer(
			pair.privateKey.export({ format: "der", type: "pkcs8" }),
			X25519_PKCS8_PREFIX,
			"X25519 private",
		),
		publicKey: rawFromDer(
			pair.publicKey.export({ format: "der", type: "spki" }),
			X25519_SPKI_PREFIX,
			"X25519 public",
		),
	};
}

// ---------------------------------------------------------------------------
// §3.2 envelope parsing
// ---------------------------------------------------------------------------

const KIND_VALUES: ReadonlySet<number> = new Set([
	ENVELOPE_KIND_REQUEST,
	ENVELOPE_KIND_RESPONSE,
	ENVELOPE_KIND_EVENT,
]);

function envelopeInvalid(): never {
	throw new CleartextError(400, "envelope_invalid");
}

/**
 * Splits the 39-byte cleartext header off an inbound body.
 *
 * Throws `CleartextError(400, "envelope_invalid")` on a bad version, a non-zero
 * flags byte, an unknown kind, or a body under 55 bytes; and
 * `CleartextError(413, "body_too_large")` when the plaintext would exceed
 * §15's 262 144-byte cap. A reserved bit is NEVER tolerated: `flags` is
 * reserved in full and a future meaning for it is a protocol change, so
 * ignoring an unknown bit would let a later version's semantics through
 * unimplemented.
 *
 * This function performs NO cryptography. It runs before freshness and before
 * the replay cache, so a malformed or replayed request costs nothing.
 */
export function parseEnvelope(body: Uint8Array): ParsedEnvelope {
	if (body.length < MIN_ENVELOPE_BYTES) {
		envelopeInvalid();
	}
	const plaintextLength = body.length - ENVELOPE_HEADER_BYTES - GCM_TAG_BYTES;
	if (plaintextLength > MAX_SEALED_PLAINTEXT_BYTES) {
		throw new CleartextError(413, "body_too_large");
	}

	const header = body.subarray(0, ENVELOPE_HEADER_BYTES);
	const version = header[0];
	const flags = header[1];
	const kind = header[2];

	if (version !== PROTOCOL_ENVELOPE_VERSION) {
		envelopeInvalid();
	}
	if (flags !== 0x00) {
		envelopeInvalid();
	}
	if (kind === undefined || !KIND_VALUES.has(kind)) {
		envelopeInvalid();
	}

	const headerView = view(header);
	const timestamp = headerView.readBigUInt64BE(19);
	if (timestamp > BigInt(Number.MAX_SAFE_INTEGER)) {
		envelopeInvalid();
	}

	const deviceIdBytes = new Uint8Array(header.subarray(3, 19));

	return {
		header: {
			version: PROTOCOL_ENVELOPE_VERSION,
			flags: 0,
			kind: kind as EnvelopeKind,
			deviceIdBytes,
			deviceId: base64UrlEncode(deviceIdBytes),
			timestampMs: Number(timestamp),
			nonce: new Uint8Array(header.subarray(27, ENVELOPE_HEADER_BYTES)),
		},
		ciphertextWithTag: new Uint8Array(body.subarray(ENVELOPE_HEADER_BYTES)),
		headerBytes: new Uint8Array(header),
	};
}

// ---------------------------------------------------------------------------
// §3.3 AAD
// ---------------------------------------------------------------------------

const ASCII_PRINTABLE = /^[\x21-\x7e]+$/;

function assertHeaderBytes(headerBytes: Uint8Array): void {
	requireLength(headerBytes, ENVELOPE_HEADER_BYTES, "AAD header");
}

function assertMethod(method: string): void {
	invariant(
		method === "POST" || method === "GET",
		`AAD method must be POST or GET, got ${JSON.stringify(method)}`,
	);
}

function assertPath(path: string): void {
	invariant(
		ASCII_PRINTABLE.test(path) &&
			path.startsWith("/") &&
			!path.includes("?") &&
			!path.includes("#"),
		`AAD path must be an exact printable-ASCII path with no query or fragment, got ${JSON.stringify(path)}`,
	);
}

function protocolVersionByte(protocolVersion: number): number {
	invariant(
		Number.isInteger(protocolVersion) &&
			protocolVersion >= 0 &&
			protocolVersion <= 0xff,
		`AAD protocolVersion must fit one byte, got ${protocolVersion}`,
	);
	return protocolVersion;
}

/**
 * §3.3 — `header(39) || 0x00 || METHOD || 0x00 || PATH || 0x00 || protocolVersion`.
 *
 * The `0x00` separators are why `("POST","/v1/ab")` and `("POST/","/v1ab")`
 * cannot collide. They are load-bearing; do not "tidy" them away.
 */
export function buildRequestAad(
	headerBytes: Uint8Array,
	parts: RequestAadParts,
): Uint8Array {
	assertHeaderBytes(headerBytes);
	assertMethod(parts.method);
	assertPath(parts.path);
	const version = protocolVersionByte(parts.protocolVersion);

	return concatBytes([
		headerBytes,
		Uint8Array.of(AAD_SEPARATOR),
		Buffer.from(parts.method, "ascii"),
		Uint8Array.of(AAD_SEPARATOR),
		Buffer.from(parts.path, "ascii"),
		Uint8Array.of(AAD_SEPARATOR),
		Uint8Array.of(version),
	]);
}

/**
 * §3.3 — request AAD plus the answered request's 12 nonce bytes and the uint16
 * big-endian status code. Binding the nonce stops a captured response being
 * re-served against a different request; binding the status stops a proxy
 * flipping a 200 into a 403 (or the reverse) undetected.
 */
export function buildResponseAad(
	headerBytes: Uint8Array,
	parts: ResponseAadParts,
): Uint8Array {
	requireLength(parts.requestNonce, NONCE_BYTES, "response AAD request nonce");
	invariant(
		Number.isInteger(parts.statusCode) &&
			parts.statusCode >= 0 &&
			parts.statusCode <= 0xffff,
		`AAD statusCode must fit uint16, got ${parts.statusCode}`,
	);

	const status = Buffer.allocUnsafe(2);
	status.writeUInt16BE(parts.statusCode, 0);

	return concatBytes([
		buildRequestAad(headerBytes, parts),
		Uint8Array.of(AAD_SEPARATOR),
		parts.requestNonce,
		Uint8Array.of(AAD_SEPARATOR),
		status,
	]);
}

/**
 * §3.3 — `GET /v1/events`, the ticket's 12-byte stream seed, and the uint64
 * big-endian per-socket frame sequence. Binding `frameSeq` is what makes a
 * dropped or reordered frame a tag failure rather than a silent gap.
 */
export function buildEventAad(
	headerBytes: Uint8Array,
	parts: EventAadParts,
): Uint8Array {
	requireLength(parts.streamSeed, NONCE_BYTES, "event AAD stream seed");
	invariant(
		Number.isInteger(parts.frameSeq) &&
			parts.frameSeq >= 1 &&
			parts.frameSeq <= Number.MAX_SAFE_INTEGER,
		`AAD frameSeq must be a positive safe integer, got ${parts.frameSeq}`,
	);

	const seq = Buffer.allocUnsafe(8);
	seq.writeBigUInt64BE(BigInt(parts.frameSeq), 0);

	return concatBytes([
		buildRequestAad(headerBytes, {
			method: "GET",
			path: "/v1/events",
			protocolVersion: parts.protocolVersion,
		}),
		Uint8Array.of(AAD_SEPARATOR),
		parts.streamSeed,
		Uint8Array.of(AAD_SEPARATOR),
		seq,
	]);
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
	let total = 0;
	for (const part of parts) {
		total += part.length;
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

// ---------------------------------------------------------------------------
// §3.2 AEAD
// ---------------------------------------------------------------------------

/**
 * Decrypts a parsed envelope.
 *
 * A tag failure throws `CleartextError(401, "unknown_device")` — the SAME code
 * and status an unknown device id produces, per §3.6. That is deliberate and
 * must not be "improved": the two cases are indistinguishable on the wire on
 * purpose, and mapping them at the call site would eventually diverge. Callers
 * therefore cannot leak the difference even by accident.
 */
export function openSealed(
	key: Uint8Array,
	envelope: ParsedEnvelope,
	aad: Uint8Array,
): Uint8Array {
	requireLength(key, KEY_BYTES, "AES-256-GCM key");
	requireLength(envelope.header.nonce, NONCE_BYTES, "GCM nonce");

	const sealed = envelope.ciphertextWithTag;
	if (sealed.length < GCM_TAG_BYTES) {
		envelopeInvalid();
	}
	const ciphertext = sealed.subarray(0, sealed.length - GCM_TAG_BYTES);
	const tag = sealed.subarray(sealed.length - GCM_TAG_BYTES);

	const decipher = createDecipheriv(
		"aes-256-gcm",
		view(key),
		view(envelope.header.nonce),
		{ authTagLength: GCM_TAG_BYTES },
	);
	decipher.setAAD(view(aad));
	decipher.setAuthTag(view(tag));

	try {
		return new Uint8Array(
			Buffer.concat([decipher.update(view(ciphertext)), decipher.final()]),
		);
	} catch {
		// Authentication failed. Indistinguishable from "device id not known",
		// by design (§3.6). No detail is logged from here — the caller logs the
		// deviceId at a single site so the two paths look identical.
		throw new CleartextError(401, "unknown_device");
	}
}

/**
 * Builds a complete outbound sealed body: `header(39) || ciphertext || tag(16)`.
 *
 * The AAD is built by a callback rather than passed in, because it must be
 * computed over the exact header bytes this function just assembled — handing
 * the caller a second chance to construct them is how a header/AAD mismatch is
 * introduced.
 */
export function seal(
	key: Uint8Array,
	kind: EnvelopeKind,
	deviceIdBytes: Uint8Array,
	nonce: Uint8Array,
	timestampMs: number,
	plaintext: Uint8Array,
	buildAad: (headerBytes: Uint8Array) => Uint8Array,
): Uint8Array {
	requireLength(key, KEY_BYTES, "AES-256-GCM key");
	requireLength(deviceIdBytes, WIRE_ID_BYTES, "deviceId");
	requireLength(nonce, NONCE_BYTES, "GCM nonce");
	invariant(
		KIND_VALUES.has(kind),
		`envelope kind must be 0x01/0x02/0x03, got ${kind}`,
	);
	invariant(
		Number.isInteger(timestampMs) &&
			timestampMs >= 0 &&
			timestampMs <= Number.MAX_SAFE_INTEGER,
		`envelope timestampMs must be a non-negative safe integer, got ${timestampMs}`,
	);
	invariant(
		plaintext.length <= MAX_SEALED_PLAINTEXT_BYTES,
		`sealed plaintext ${plaintext.length} exceeds the ${MAX_SEALED_PLAINTEXT_BYTES}-byte cap`,
	);

	const header = Buffer.allocUnsafe(ENVELOPE_HEADER_BYTES);
	header[0] = PROTOCOL_ENVELOPE_VERSION;
	header[1] = 0x00;
	header[2] = kind;
	header.set(deviceIdBytes, 3);
	header.writeBigUInt64BE(BigInt(timestampMs), 19);
	header.set(nonce, 27);

	const headerBytes = new Uint8Array(header);
	const aad = buildAad(headerBytes);

	const cipher = createCipheriv("aes-256-gcm", view(key), view(nonce), {
		authTagLength: GCM_TAG_BYTES,
	});
	cipher.setAAD(view(aad));
	const ciphertext = Buffer.concat([
		cipher.update(view(plaintext)),
		cipher.final(),
	]);
	const tag = cipher.getAuthTag();
	requireLength(new Uint8Array(tag), GCM_TAG_BYTES, "GCM tag");

	return concatBytes([headerBytes, ciphertext, tag]);
}

// ---------------------------------------------------------------------------
// comparison, encoding, RNG
// ---------------------------------------------------------------------------

/**
 * `crypto.timingSafeEqual`, length-safe. Every MAC, tag and id comparison in
 * this bridge goes through here — `===` on a MAC is a timing oracle.
 *
 * Unequal lengths return `false` without a timing-safe compare: all values
 * compared here (32-byte MACs, 16-byte ids) have lengths that are public by
 * construction, so length is not secret.
 */
export function constantTimeEquals(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length || a.length === 0) {
		return false;
	}
	return timingSafeEqual(view(a), view(b));
}

/**
 * Constant-time "is every byte zero?".
 *
 * OR every byte into an accumulator and compare once, so the answer costs the
 * same time whichever byte is non-zero. A short-circuiting `some(b => b !== 0)`
 * leaks the position of the first non-zero byte through timing.
 *
 * ONE COPY, DELIBERATELY. This test guards two different disasters — a
 * small-order X25519 peer point (`x25519`, below) and an already-wiped `K_dev`
 * being used as an HKDF PRK (`keys.assertDeviceKey`) — and constant-time code is
 * the worst possible place to keep two hand-written copies: a subtlety fixed in
 * one silently misses the other. Callers supply their own error; this function
 * only answers the question.
 */
export function isAllZero(bytes: Uint8Array): boolean {
	let accumulator = 0;
	for (const byte of bytes) {
		accumulator |= byte;
	}
	return accumulator === 0;
}

const BASE64URL_ALPHABET = /^[A-Za-z0-9_-]*$/;

export function base64UrlEncode(bytes: Uint8Array): string {
	return view(bytes).toString("base64url");
}

/**
 * Strict: rejects padding, non-alphabet characters, and non-canonical encodings
 * (trailing bits that are not zero). Node's `Buffer.from(x, "base64url")` is
 * lenient about all three and would silently accept two distinct strings that
 * decode to the same bytes — which is a de-duplication and cache-key hazard for
 * ids that this protocol uses as map keys.
 */
export function base64UrlDecode(value: string): Uint8Array {
	if (!BASE64URL_ALPHABET.test(value)) {
		throw new CryptoInvariantError("base64url: non-alphabet character");
	}
	if (value.length % 4 === 1) {
		throw new CryptoInvariantError("base64url: impossible length");
	}
	const decoded = new Uint8Array(Buffer.from(value, "base64url"));
	if (base64UrlEncode(decoded) !== value) {
		throw new CryptoInvariantError("base64url: non-canonical encoding");
	}
	return decoded;
}

/**
 * THE canonical §0.1 wire-id test: 22 base64url characters that decode to
 * exactly 16 bytes AND re-encode to the same string.
 *
 * WHY THIS EXISTS AS ONE FUNCTION. The 22-character id shape used to be checked
 * four different ways with three different strictnesses — a bare
 * `/^[A-Za-z0-9_-]{22}$/` in `keys.ts` and `read-api.ts`, a zod `length(22)` plus
 * the same regex in `http.ts`, and a full canonical decode in `device-store.ts`.
 * The regex forms ACCEPT what the decode REJECTS: base64url's 22nd character
 * carries only 4 significant bits, so `...A`, `...B`, `...C` and `...D` all
 * decode to the same 16 bytes while comparing unequal as strings. That is the
 * exact map-key / de-duplication hazard `base64UrlDecode` was made strict to
 * close, so the same id was legal at one boundary and refused at another —
 * ids that pass an outer gate and then fail an inner one is the failure mode
 * this protocol can least afford (see `limits.ts` on the label cap).
 *
 * A type predicate, so a caller that validates `unknown` gets `string` back.
 */
export function isCanonicalWireId(value: unknown): value is string {
	if (typeof value !== "string" || value.length !== WIRE_ID_CHARS) {
		return false;
	}
	try {
		return decodeWireId(value).length === WIRE_ID_BYTES;
	} catch {
		// Non-alphabet or non-canonical. The CALLER decides what a rejected id
		// means on its own boundary; this is a predicate, not a policy.
		return false;
	}
}

/**
 * The bytes behind a canonical wire id, or a throw.
 *
 * For the callers that need the decoded 16 bytes anyway (or that want to report
 * WHY an id was refused — `base64UrlDecode` distinguishes non-alphabet from
 * non-canonical). `isCanonicalWireId` is the boolean form of exactly this test.
 */
export function decodeWireId(value: string): Uint8Array {
	const decoded = base64UrlDecode(value);
	if (decoded.length !== WIRE_ID_BYTES) {
		throw new CryptoInvariantError(
			`wire id must decode to ${WIRE_ID_BYTES} bytes, got ${decoded.length}`,
		);
	}
	return decoded;
}

/** `crypto.randomBytes`. Never `Math.random` (§15.1). */
export function randomBytes(length: number): Uint8Array {
	invariant(
		Number.isInteger(length) && length > 0,
		`randomBytes length must be a positive integer, got ${length}`,
	);
	return new Uint8Array(nodeRandomBytes(length));
}

/**
 * Best-effort overwrite of key material before it is dropped.
 *
 * HONEST LIMIT: this cannot reach copies the runtime made — a GC'd `Buffer`
 * slice, a moved allocation, a page swapped to disk. It reduces the window in
 * which `K_dev` or a pairing code sits in a live heap; it is not a guarantee of
 * erasure, and nothing in this design depends on it being one.
 */
export function zero(bytes: Uint8Array): void {
	bytes.fill(0);
}

// ---------------------------------------------------------------------------
// shared async primitives
//
// Not cryptography, but used by the modules that are, and previously copied into
// each of them. They live here because this module is the one every other
// companion module already depends on, so re-homing them creates no new edge in
// the import graph — and no cycle, since `crypto.ts` imports none of them back.
// ---------------------------------------------------------------------------

/**
 * A tail-promise mutex: every `work` runs strictly after the previous one has
 * settled, whether it resolved or rejected.
 *
 * WHY A TAIL PROMISE AND NOT A LOCK LIBRARY. The property callers need is
 * "check-then-write is atomic", and the failure it prevents is two concurrent
 * read-modify-writes both reading the same pre-state. `tail.then(work, work)`
 * gives exactly that in five lines with no timers, no lock leases and nothing to
 * release — and critically, the SAME `work` is passed to both arms, so a rejected
 * predecessor cannot wedge the chain. The `run.then(noop, noop)` that follows is
 * what stops that swallowing from becoming an unhandled rejection while still
 * letting the CALLER see its own error.
 *
 * Three byte-identical copies of this existed (`crypto.ts`, `keys.ts`,
 * `device-store.ts`), each guarding a durable read-modify-write. Each serialiser
 * owns its own chain: call this once per resource, never share one across two.
 *
 * It is a MUTEX, not a queue with fairness or a timeout. A `work` that never
 * settles stops the chain forever — which is the correct outcome for a durable
 * write that has not finished, and the reason every `work` passed to it must be
 * bounded by its own I/O.
 */
export function createSerialiser(): <T>(work: () => Promise<T>) => Promise<T> {
	let tail: Promise<unknown> = Promise.resolve();
	return <T>(work: () => Promise<T>): Promise<T> => {
		const run = tail.then(work, work);
		tail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	};
}

/**
 * A `readBoundedStream` read stopped because the body crossed `maxBytes`.
 *
 * A distinct type because the two callers must map it to two DIFFERENT wire
 * outcomes — `413 body_too_large` on the bridge's own inbound request, an
 * unverifiable-token refusal on a JWKS fetch — and neither may inherit the
 * other's. Anything else thrown out of the read (a socket error, a stream error)
 * is NOT this type and must not be mapped as an overflow.
 */
export class BoundedStreamOverflowError extends Error {
	constructor(readonly maxBytes: number) {
		super(
			`(COMPANION-BRIDGE) stream exceeded the ${maxBytes}-byte cap before it ended`,
		);
		this.name = "BoundedStreamOverflowError";
	}
}

export interface BoundedStreamOptions {
	/**
	 * Cancel the reader before throwing on overflow. DELIBERATELY REQUIRED, not
	 * defaulted: the right answer differs per caller and getting it wrong is
	 * invisible.
	 *
	 * `true` for a response body being abandoned (a JWKS host streaming garbage —
	 * cancelling closes the socket instead of leaving it draining). `false` for an
	 * inbound REQUEST body that still owes a response on the same connection:
	 * cancelling there destroys the request stream, and on some HTTP/1.1 stacks
	 * that takes the not-yet-written error response with it.
	 */
	cancelOnOverflow: boolean;
}

/**
 * Reads a whole `ReadableStream` into memory with the cap enforced DURING the
 * read, not after it.
 *
 * This is the part that must not be re-implemented: `await response.text()` (or
 * any buffer-then-measure) makes the cap describe nothing an attacker has to
 * respect — a hostile peer streams gigabytes and the process allocates all of it
 * before deciding it was too big. The running total is checked per chunk, so the
 * read stops at the first chunk that crosses the line.
 *
 * DELIBERATELY NOT INCLUDED, because the callers differ by design and unifying
 * them would be a behaviour change, not a cleanup:
 *  - the `Content-Length` pre-check (one caller refuses a non-numeric header
 *    outright, the other only acts on a finite oversized one);
 *  - the empty/absent-body case (one returns zero bytes, the other refuses);
 *  - the mapping of an overflow to a wire error.
 * Callers keep all three and catch `BoundedStreamOverflowError`.
 */
export async function readBoundedStream(
	body: ReadableStream<Uint8Array>,
	maxBytes: number,
	options: BoundedStreamOptions,
): Promise<Uint8Array> {
	invariant(
		Number.isInteger(maxBytes) && maxBytes >= 0,
		`readBoundedStream maxBytes must be a non-negative integer, got ${maxBytes}`,
	);

	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			total += value.byteLength;
			if (total > maxBytes) {
				if (options.cancelOnOverflow) {
					await reader.cancel();
				}
				throw new BoundedStreamOverflowError(maxBytes);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

export interface SleepOptions {
	/**
	 * RESOLVES — never rejects — the moment the signal aborts. That is the whole
	 * reason this is not `node:timers/promises setTimeout`, which REJECTS on abort:
	 * every caller here uses the sleep as a backoff between attempts and treats
	 * "we are shutting down" as "stop waiting", not as an error to propagate up a
	 * retry loop that is itself being torn down.
	 */
	signal?: AbortSignal;
	/**
	 * `unref()` the timer so a pending sleep cannot by itself hold the process
	 * open. Defaults to FALSE, which is the semantics of a plain `setTimeout`.
	 * Only the background push sender wants `true`; a sleep inside a request that
	 * still owes a response does not.
	 */
	unref?: boolean;
}

/** `setTimeout` as a promise. See `SleepOptions` for the two behaviours it covers. */
export function sleep(ms: number, options?: SleepOptions): Promise<void> {
	const signal = options?.signal;
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve();
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		if (options?.unref) {
			timer.unref?.();
		}
		function onAbort(): void {
			clearTimeout(timer);
			resolve();
		}
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

// ---------------------------------------------------------------------------
// durable state I/O + a clock that cannot be moved
// ---------------------------------------------------------------------------

/**
 * A clock that only ever moves forward, for ages that MUST NOT be affected by
 * the wall clock.
 *
 * Every retention/staleness decision in this bridge that an attacker (or NTP, or
 * a VM resume) could otherwise influence by moving `Date.now()` is measured with
 * this instead. `performance.now()` is process-relative and monotonic, so it is
 * only meaningful WITHIN one process — anything that must survive a restart
 * still has to fall back to the wall clock, and every such site says so.
 */
export function monotonicNowMs(): number {
	return performance.now();
}

/**
 * fsync the DIRECTORY, so a `rename` is durable and not merely ordered.
 *
 * A `tmp -> fsync -> rename` sequence makes the file's CONTENT durable, but the
 * directory entry that names it is separate metadata: without this, a crash can
 * leave the old name resolving to the old inode even though the new file was
 * fully synced. For an anti-rollback high-water mark that is the difference
 * between "burned some counters" and "silently went backwards".
 *
 * WINDOWS — STATED GAP, NOT A SWALLOWED ERROR. On win32 the content fsync and
 * the rename ORDER still hold, but the directory entry is not forced. This is the
 * fork's own platform, so it is recorded here rather than pretended away.
 *
 * THE REASON THIS GAP EXISTS IS NOT THE ONE PREVIOUSLY WRITTEN HERE. This comment
 * used to claim that Node cannot open a directory handle on win32 (`fs.open` on a
 * directory failing EISDIR/EPERM). That is measurably false on this platform —
 * `tmp/dirsync-probe.ts` under Bun 1.3.14 on win32 arm64 opens a directory with
 * `r`, `r+` and `a` (only `w` gives EISDIR), and while `sync()` on the READ-ONLY
 * handle fails EPERM, `sync()` on an `r+` handle SUCCEEDS — including immediately
 * after a rename in that directory. The early return below was most likely
 * concluded from trying `"r"`, the mode the POSIX path uses, and generalising.
 *
 * The early return nevertheless stays, because a successful `FlushFileBuffers` on
 * a directory handle is not evidence that NTFS persisted the directory entry:
 * Microsoft documents that call as flushing the specified FILE, and exposes
 * `MoveFileEx(MOVEFILE_WRITE_THROUGH)` as the separate durable-rename primitive.
 * A `syncDirectory` that returns success without persisting anything would be
 * WORSE than this honest no-op, because every mechanism above it would stop
 * compensating. Removing the early return therefore needs real evidence — an
 * authoritative statement about directory handles on NTFS, or a crash-consistency
 * test showing a rename surviving with the sync and lost without it.
 *
 * WHAT THAT GAP COSTS, AND WHY THIS STILL RETURNS RATHER THAN THROWS. A hard
 * reset can discard the most recent rename, which reverts a file to its previous
 * version. Throwing here would be honest and would also end the feature on the
 * only platform it ships to, so the gap is answered where it actually bites
 * instead. THE TWO CALLERS THAT CANNOT TOLERATE IT NO LONGER USE A RENAME; TWO
 * THAT STILL DO ARE NAMED HERE RATHER THAN LEFT TO BE DISCOVERED:
 *
 *  - THE SEND-NONCE COUNTER DOES NOT RELY ON A RENAME AT ALL. A rewound counter
 *    repeats a nonce, so `keys.ts` keeps its high-water mark in an append-only
 *    journal (SEND-JOURNAL) written with `appendDurable`. An append has no
 *    directory entry to lose, so this no-op cannot cost it anything; the mark's
 *    durability no longer depends on any property this function fails to provide.
 *    It is the shape to copy for anything else whose rollback is unacceptable.
 *  - THE ANSWER LEDGER DOES NOT RELY ON A RENAME EITHER, ANY MORE. It used to:
 *    `answer.ts` kept a JSON attempts file with a rise-only witness renamed before
 *    it. It is now a table in host.db (ANSWER-LEDGER) whose durability is SQLite's
 *    documented `synchronous = FULL`, asserted at open, rather than an inference
 *    about NTFS.
 *  - THE REPLAY CACHE DOES NOT ANY MORE EITHER (REPLAY-CACHE-DB, §3.5 below). It
 *    did, at compaction: a reduced log was written and renamed into place, and any
 *    nonce admitted to the REPLACEMENT after that rename was lost if the rename
 *    was — the old inode is a superset only at the instant of compaction, never
 *    afterwards. That let a captured sealed request be admitted a second time.
 *    (`/v1/answer` survived it, because its requestId is fenced by the
 *    ANSWER-LEDGER; `/v1/message` keeps its idempotency in memory and would have
 *    retyped.) It is now a host.db table, where compaction is a DELETE and losing
 *    that transaction brings expired rows BACK rather than dropping live ones.
 *  - DEVICE AUTHORITY DOES NOT ANY MORE (DEVICE-INDEX-DB). Its index was
 *    `devices.json`, and reverting it re-authorised a revoked device whose key
 *    material revocation deliberately retains. It is a host.db table now. The
 *    revocation tombstone stamped inside the key file — which IS still written
 *    through a rename — stays exactly where it is: it is the second, independent
 *    record, and losing its rename now costs nothing, because the row is the one
 *    that decides.
 *
 * So nothing whose rollback would be unsafe depends on this function any more.
 * That sentence has been wrong here twice; the way to keep it true is to check
 * every `writeFileDurable` caller when adding one, rather than to trust it. What
 * remains on renames is state where a lost write costs a retry: the anchor file
 * (witnessed by the append-only SEND-JOURNAL), the key files (witnessed by the
 * device rows), and `pending-destroy.json` (re-derived from the index by a sweep).
 * Each of those has a second record somewhere a rename cannot reach, and that
 * pattern — not this function — is what makes them safe.
 *
 * The Android half (`FileBlobStore`) refuses to construct without directory fsync;
 * the two halves answer the same question differently ON PURPOSE, because the
 * phone has a platform that provides it and the bridge does not. Anything added
 * here whose rollback would be unsafe gets one of the first two treatments, not a
 * comment.
 */
export async function syncDirectory(dir: string): Promise<void> {
	if (process.platform === "win32") return;
	const handle = await open(dir, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

/**
 * `tmp -> write -> fsync -> close -> rename -> fsync(parent)`.
 *
 * The ONLY way state that must not roll back is written. Callers serialise their
 * own writes; the temp name is derived from the target so two different targets
 * in one directory cannot collide.
 *
 * THE CONTENT FSYNC ALSO ORDERS EARLIER RENAMES ON WIN32. DO NOT REMOVE IT.
 * `syncDirectory` is a no-op there, so nothing forces a directory entry — but
 * `handle.sync()` on the tmp file is a FlushFileBuffers, and that forces NTFS's
 * volume metadata log, which by then carries every rename this process has
 * already issued. That is the only thing that makes two durable writes ORDERED
 * relative to each other on the fork's platform.
 *
 * NOTHING DEPENDS ON THAT ORDERING ANY MORE, AND THAT IS THE POINT OF THIS
 * PARAGRAPH NOW. Both dependents were removed deliberately rather than argued
 * about, because the ordering was never a guarantee the platform offers — see
 * below — and a correctness property resting on an inference is a property you do
 * not have.
 *
 * `answer.ts` was the survivable one: a rise-only witness renamed before a JSON
 * attempts file, where a lost pair cost only idempotency and status records. It is
 * now a table in host.db (ANSWER-LEDGER) with SQLite's documented durability
 * asserted at open. And `keys.ts` was the unsurvivable one. `keys.ts` used to rename a send-nonce witness before the
 * anchor and rely on the anchor's content fsync to publish it before any nonce was
 * issued. A lost pair there was NOT survivable: both files roll back to matching
 * values, which looks healthy, logs nothing, and silently rewinds the send-nonce
 * counter into counters already handed out — a repeated (key, nonce) pair, which
 * destroys AES-GCM outright. That mechanism has been replaced by (SEND-JOURNAL),
 * an append-only journal built on `appendDurable`, whose durability involves no
 * rename and therefore no inference. So this ordering no longer stands between the
 * fork and a nonce repeat; it now guards only a window that narrows.
 *
 * HOW STRONG THAT ORDERING ACTUALLY IS — READ BEFORE RELYING ON IT FURTHER.
 * Microsoft documents FlushFileBuffers as flushing THE SPECIFIED FILE, and says a
 * volume handle is required to flush every modified file on a volume; the
 * documented durable-rename primitive is `MoveFileEx(MOVEFILE_WRITE_THROUGH)`,
 * which Node does not surface (libuv issues `MoveFileExW` with
 * `MOVEFILE_REPLACE_EXISTING` only). So the paragraph above describes observed
 * NTFS behaviour and an inference from how its metadata log works — NOT a
 * guarantee the platform offers this code in writing. Treat it as an open question
 * rather than a settled property. DO NOT ADD A SECOND DEPENDENT: if the state
 * being ordered must not roll back, use `appendDurable` and an append-only record,
 * which is what the counter that could not tolerate this risk now does.
 */
/**
 * Writes ALL of `bytes`, or throws. One definition, every durable write site.
 *
 * Node returns a byte count because a write is permitted to be short. Discarding
 * it makes a partial write indistinguishable from a complete one, and the two
 * kinds of write here fail differently and both badly:
 *
 *  - a whole-file rewrite (`writeFileDurable`) would fsync and rename truncated
 *    JSON into place as though complete, and the next start would find a file that
 *    fails its schema, quarantine it, and lose every record it held;
 *  - an APPEND is worse, and the send-nonce journal is the caller that has to care.
 *    Its records are FIXED WIDTH and replay reads from offset 0, trimming only a
 *    trailing partial. A short append followed by any successful one misaligns
 *    every record after it — so the mark replay computes is not the mark that was
 *    written, with no error and no schema failure to notice it by. §3.5's replay
 *    cache used to be the second such caller and had the same shape; its records
 *    are rows in host.db now, where a partial row is not expressible.
 *
 * Short writes to a local NTFS volume are rare. That is equally true of the
 * whole-file path, so checking one and not the others was inconsistency rather
 * than a judgement about risk.
 */
export async function writeAll(
	handle: FileHandle,
	bytes: Uint8Array,
	position: number | null,
	what: string,
): Promise<void> {
	const { bytesWritten } = await handle.write(
		view(bytes),
		0,
		bytes.length,
		position,
	);
	if (bytesWritten !== bytes.length) {
		throw new Error(
			`${LOG_PREFIX} short write to ${what}: wrote ${bytesWritten} of ${bytes.length} bytes. Refusing to continue with a partial write.`,
		);
	}
}

/**
 * Writes one record IN FULL and fsyncs THE SAME FILE. The durable primitive that
 * involves no rename, and therefore has no directory entry to lose.
 *
 * WHY THIS IS STRICTLY STRONGER THAN `writeFileDurable` ON WIN32, AND NOT MERELY
 * BY DEGREE. `writeFileDurable` publishes its result by renaming a tmp file over
 * the target, and a rename mutates a DIRECTORY — a different file from the one
 * whose handle was flushed. `syncDirectory` cannot force that directory on win32,
 * so the ordering paragraph on `writeFileDurable` has to INFER, from how NTFS's
 * metadata log is understood to work, that an earlier rename gets published by a
 * later file's fsync. This function needs no such inference: an append changes
 * the specified file's data and its own size, and `FlushFileBuffers` is
 * documented to flush exactly the specified file. Once the file's own directory
 * entry exists, nothing about a record written this way rests on a rename.
 *
 * THE ONE MECHANISM LEFT THAT NEEDS THIS IS `keys.ts`'s (SEND-JOURNAL), which
 * appends the send-nonce high-water mark and is NEVER rewritten — not even to
 * compact, which that file records as a deliberate correctness decision rather than
 * an omission. §3.5's replay cache used to be the second caller, appending
 * fixed-width nonce records to a file it compacted by rename; it is rows in host.db
 * now (REPLAY-CACHE-DB), so its compaction is a DELETE and this function has one
 * caller for records whose rollback is unacceptable, not two.
 *
 * `position` is `null` to write at the handle's own offset (an `"a"` handle) or an
 * explicit byte offset, which is what a caller needs when the previous mount left
 * a torn tail that must be OVERWRITTEN rather than grown past — appending after
 * torn bytes would misalign every fixed-width record that follows.
 */
export async function appendDurable(
	handle: FileHandle,
	record: Uint8Array,
	position: number | null,
	what: string,
): Promise<void> {
	await writeAll(handle, record, position, what);
	await handle.sync();
}

export async function writeFileDurable(
	target: string,
	bytes: Uint8Array,
	mode: number,
): Promise<void> {
	const tmp = `${target}.tmp`;
	const handle = await open(tmp, "w", mode);
	try {
		await writeAll(handle, bytes, 0, tmp);
		await handle.sync();
	} finally {
		await handle.close();
	}
	await rename(tmp, target);
	await syncDirectory(dirname(target));
}

// ---------------------------------------------------------------------------
// §3.5 freshness + the persisted replay cache
// ---------------------------------------------------------------------------

/**
 * §3.5 — `|nowMs - timestampMs| <= 60 000`. Throws
 * `CleartextError(401, "stale_timestamp")` outside the window.
 *
 * This runs BEFORE the replay cache and before any decryption. A timestamp
 * alone does not stop replay; it only bounds the window that the cache must
 * cover. Both are required.
 */
export function assertFresh(timestampMs: number, nowMs: number): void {
	if (!Number.isFinite(timestampMs)) {
		envelopeInvalid();
	}
	if (Math.abs(nowMs - timestampMs) > FRESHNESS_WINDOW_MS) {
		throw new CleartextError(401, "stale_timestamp");
	}
}

/**
 * §3.5 — the replay cache.
 *
 * This is the ONLY implementation: the admit/compact/retention rules exist here
 * and nowhere else, and every caller passes its own request-instant clock.
 *
 * It is declared here rather than in `keys.ts` only to avoid an import cycle:
 * `keys.ts` needs this module's HKDF.
 */
export interface ReplayCache {
	/**
	 * `true` => `(deviceId, nonce)` was NOT seen before and has been DURABLY
	 * recorded (fsync'd) — the caller may now act on the request.
	 * `false` => already seen; the caller must answer `409 replay_detected`
	 * without decrypting.
	 */
	admit(deviceId: DeviceId, nonce: Uint8Array, nowMs: number): Promise<boolean>;
	/** Drops records older than the retention. At start and every 5 minutes. */
	compact(nowMs: number): Promise<void>;
	/** Live entry count, for the health surface. */
	size(): number;
	close(): Promise<void>;
}

interface ReplayCacheOptions {
	/**
	 * (REPLAY-CACHE-DB) The LIVE drizzle handle — this cache writes.
	 *
	 * It used to take a directory and keep an append-only log there beside a
	 * compaction that renamed a reduced copy into place. The append was sound; the
	 * rename was not, on the only platform this ships to. See the table's docblock
	 * in `db/schema.ts` for the failure it produced.
	 */
	db: HostDb;
	/**
	 * Where the PRE-DATABASE `replay.log` lives. Read once, at open, and retired —
	 * nothing steady-state uses it.
	 *
	 * Kept rather than dropped because ignoring it would forget nonces this install
	 * has already admitted, and "legacy state skipped, then deleted" is precisely the
	 * bug that was found in the send-nonce counter's migration. The records are the
	 * same fixed-width shape the table wants, so importing them is cheap and the
	 * alternative is a replay window that reopens for the length of the retention on
	 * the one upgrade.
	 */
	noncesDir: string;
	retentionMs?: number;
	maxEntries?: number;
	minRetainedEntries?: number;
}

/**
 * (SQLITE-DURABLE-ASSERT) The two pragmas every durable companion claim rests on,
 * asserted rather than assumed.
 *
 * Both the answer ledger and the replay cache say "committed before the caller may
 * act", and that sentence is only true at `synchronous = FULL` in WAL mode:
 *
 *  - at `NORMAL`, a WAL commit is durable against a process crash but NOT against
 *    power loss — the WAL write may still be in the OS page cache, and everything
 *    committed since the last checkpoint can be lost. For the ledger that loses a
 *    claim after keystrokes landed; for the replay cache it forgets an admitted
 *    nonce and reopens §3.5's window;
 *  - `createDb` REQUESTS WAL and ignores the answer. SQLite documents that a
 *    journal-mode change can fail — another connection in a transaction is enough —
 *    and that it then returns the mode still in force rather than raising. Under a
 *    rollback journal, FULL means something different: the commit ends with a
 *    directory operation whose durability is exactly the NTFS inference this whole
 *    area exists to stop depending on.
 *
 * It FAILS LOUD instead of quietly setting either one, because this connection is
 * shared with the rest of the host service: lowering `synchronous` for write
 * throughput is a decision someone may legitimately want to make, and it must be
 * made knowing it breaks both of the above — not silently undone here.
 *
 * Callers pass `when` so the message says which claim was about to be made.
 */
export function assertDurableSqlite(db: HostDb, when: string): void {
	const synchronous = db.$client.pragma("synchronous", { simple: true });
	if (Number(synchronous) !== 2) {
		throw new Error(
			`(COMPANION-BRIDGE) requires PRAGMA synchronous = FULL (2), found ${String(synchronous)} ${when}. At NORMAL a committed row can be lost to power loss, which is the exact rollback these records exist to prevent.`,
		);
	}
	const journalMode = db.$client.pragma("journal_mode", { simple: true });
	if (String(journalMode).toLowerCase() !== "wal") {
		throw new Error(
			`(COMPANION-BRIDGE) requires journal_mode = wal, found ${String(journalMode)} ${when}. \`createDb\` asks for WAL but the request can fail silently, and FULL durability under a rollback journal rests on the same undocumented directory-ordering assumption these records replaced.`,
		);
	}
}

/**
 * Keys per `DELETE .. WHERE key IN (...)` statement during compaction.
 *
 * SQLite's bound-parameter limit is finite (999 by default on older builds) and
 * `REPLAY_CACHE_MAX_ENTRIES` is far above it, so a single statement would fail
 * exactly when the cache is fullest — the moment compaction matters most. Chunked
 * inside one transaction, so it is still all-or-nothing.
 */
const DELETE_CHUNK = 500;

function replayKey(deviceIdBytes: Uint8Array, nonce: Uint8Array): string {
	return `${base64UrlEncode(deviceIdBytes)}.${base64UrlEncode(nonce)}`;
}

/**
 * One admitted `(deviceId, nonce)`.
 *
 * `monoAtMs` is the ONLY age this process trusts; it is `null` for records
 * rehydrated from disk, whose only available reference is the wall clock they
 * were written against. `order` is the insertion sequence and is what keeps the
 * newest records alive when the clock is unusable in either direction.
 */
interface ReplayEntry {
	seenAtMs: number;
	monoAtMs: number | null;
	order: number;
}

/**
 * (REPLAY-CACHE-DB) Creates the DURABLE replay cache.
 *
 * Durable, not only in memory: Superset restarts often, and an in-memory cache is
 * empty afterwards — a request captured 40 s before a restart would replay
 * successfully after it. Every admission commits BEFORE `admit` resolves, so a
 * crash can never lose a nonce it already vouched for.
 *
 * WHAT MOVED, AND WHAT DELIBERATELY DID NOT. Only PERSISTENCE moved into host.db.
 * Every policy rule stayed exactly where it was, because each one exists for a
 * failure that was actually observed:
 *
 *  - the live map is still the presence test, and a record still leaves it exactly
 *    one way (compaction). An earlier revision re-admitted a record whose recorded
 *    time looked older than the retention, which handed a forward clock jump the
 *    ability to un-see a nonce;
 *  - records admitted by THIS process are still aged on the MONOTONIC clock, which
 *    a database column cannot hold. Rehydrated rows fall back to the wall clock,
 *    and the insertion-order floor still protects the newest `minRetained` of them
 *    regardless of what their timestamps claim;
 *  - the cap still REFUSES rather than evicting. Evicting a live entry to make room
 *    would silently reopen the window this cache exists to close.
 *
 * What the database adds is that admission is now ONE STATEMENT that both decides
 * and records: `INSERT .. ON CONFLICT DO NOTHING`, where `changes === 1` is the
 * admission. The old code decided from the map and recorded separately, so the two
 * could in principle disagree; now they cannot.
 *
 * Durability is SQLite's documented `synchronous = FULL` in WAL mode — both
 * asserted at the answer ledger's open, which shares this connection — rather than
 * an inference about when NTFS publishes a directory entry.
 */
export async function createReplayCache(
	options: ReplayCacheOptions,
): Promise<ReplayCache> {
	const retentionMs = options.retentionMs ?? NONCE_CACHE_RETENTION_MS;
	const maxEntries = options.maxEntries ?? REPLAY_CACHE_MAX_ENTRIES;
	const minRetained = options.minRetainedEntries ?? REPLAY_MIN_RETAINED_ENTRIES;
	invariant(
		retentionMs >= 2 * FRESHNESS_WINDOW_MS && retentionMs >= 300_000,
		`replay retention ${retentionMs}ms violates §3.5 (>= 2x window, >= 300 000)`,
	);
	invariant(
		minRetained > 0 && minRetained < maxEntries,
		`replay min-retained ${minRetained} must be positive and below the ${maxEntries} cap, or compaction could never free space`,
	);

	const db = options.db;
	if (!db || typeof db.insert !== "function") {
		throw new Error(
			"(COMPANION-BRIDGE) the replay cache requires the live host.db handle; a read-only reader would fail at the first admission, after the request had already been accepted",
		);
	}
	// Asserted HERE rather than relying on the ledger having been opened first. The
	// two subsystems share this connection and either may be constructed first;
	// depending on that order would make this cache's durability claim true only by
	// accident of wiring.
	assertDurableSqlite(db, "when opening the replay cache");

	const entries = new Map<string, ReplayEntry>();
	let nextOrder = 0;
	let closed = false;
	/** Serialises every mutation: check-then-append must be atomic. */
	const serialise = createSerialiser();

	/**
	 * Retention is `age AND insertion order`, never age alone.
	 *
	 * A record admitted by THIS process is aged on the monotonic clock, so moving
	 * the wall clock cannot expire it. A record rehydrated from disk has no
	 * monotonic reference and falls back to the wall clock — but the insertion
	 * floor still protects the newest `minRetained` of them, which covers more
	 * than a full freshness window of legal traffic.
	 */
	function isExpired(
		entry: ReplayEntry,
		nowMs: number,
		monoNowMs: number,
		orderFloor: number,
	): boolean {
		if (entry.order >= orderFloor) {
			return false;
		}
		const ageMs =
			entry.monoAtMs !== null
				? monoNowMs - entry.monoAtMs
				: nowMs - entry.seenAtMs;
		// A negative age means the clock moved backwards under us. That is never a
		// reason to forget a nonce.
		return ageMs > retentionMs;
	}

	/**
	 * Rehydrates the live map, in insertion order.
	 *
	 * `ORDER BY ord` is load-bearing rather than tidy: the age-exempt window is
	 * defined as the newest `minRetained` ROWS, so reading them out of order would
	 * exempt the wrong ones. A torn-record concern does not exist here — a row is
	 * either committed or it is not — which is one of the two reasons this moved.
	 *
	 * Rows are renumbered from 0 as they load, so `ord` is dense per lifetime and
	 * the floor arithmetic below cannot drift after many compactions.
	 */
	function loadFromDb(nowMs: number): void {
		const rows = db
			.select()
			.from(companionReplayNonces)
			.orderBy(companionReplayNonces.ord)
			.all();
		// The newest `minRetained` rows survive regardless of what their timestamps
		// claim, for the same reason compaction keeps them.
		const ageExemptFrom = Math.max(0, rows.length - minRetained);
		rows.forEach((row, index) => {
			if (index < ageExemptFrom && nowMs - row.seenAtMs > retentionMs) {
				return;
			}
			entries.set(row.key, {
				seenAtMs: row.seenAtMs,
				monoAtMs: null,
				order: nextOrder,
			});
			nextOrder += 1;
		});
	}

	/**
	 * Drops the expired rows. A DELETE, where this used to be a whole-file rewrite
	 * plus a rename.
	 *
	 * The map decides WHAT is expired, because only the map holds the monotonic ages
	 * and the insertion floor; the database is then told which keys went. Both in one
	 * transaction so a crash cannot leave the map and the table disagreeing about
	 * what has been admitted — and note the direction of the remaining risk: if this
	 * transaction is lost, expired rows come BACK, which costs nothing. The dangerous
	 * direction — a live nonce forgotten — is not reachable from here at all, which
	 * is the second reason this moved off a rename.
	 */
	function rewrite(nowMs: number): void {
		const monoNowMs = monotonicNowMs();
		const orderFloor = nextOrder - minRetained;
		const dead: string[] = [];
		for (const [key, entry] of entries) {
			if (isExpired(entry, nowMs, monoNowMs, orderFloor)) {
				dead.push(key);
			}
		}
		if (dead.length === 0) {
			return;
		}
		db.transaction((tx) => {
			// Chunked: SQLite's parameter limit is finite and `maxEntries` is not
			// small. One statement per chunk, all inside the one transaction.
			for (let i = 0; i < dead.length; i += DELETE_CHUNK) {
				tx.delete(companionReplayNonces)
					.where(
						inArray(companionReplayNonces.key, dead.slice(i, i + DELETE_CHUNK)),
					)
					.run();
			}
		});
		for (const key of dead) {
			entries.delete(key);
		}
	}

	/**
	 * (REPLAY-CACHE-DB) Carries the pre-database log into the table, once.
	 *
	 * Order matters and is the same as the send-nonce journal's: IMPORT first, then
	 * retire. A lost `unlink` is harmless — the file reappears, its rows go through
	 * the same `ON CONFLICT DO NOTHING` next start, and it is deleted again — whereas
	 * deleting first and crashing before the insert would forget admitted nonces with
	 * nothing left to notice.
	 *
	 * A record that cannot be read is DROPPED rather than fatal, which is the opposite
	 * of the send counter's rule and correct here for the same reason deletion is
	 * allowed at all: forgetting one admitted nonce narrows the replay window by one
	 * request for the length of the retention, where forgetting a counter mark repeats
	 * a nonce and breaks the cipher. Refusing to start over a damaged replay log would
	 * be a worse trade than the exposure.
	 *
	 * ASYNC fs, like everything else in this module. The fork's first live footgun is
	 * that blocking fs on the main thread at startup starves the renderer's
	 * `superset-app://` loader and leaves the window blank for minutes; a small file
	 * read is not an exception to that, it is how the rule gets eroded.
	 */
	async function importLegacyLog(nowMs: number): Promise<void> {
		const legacyPath = join(options.noncesDir, REPLAY_LOG_FILENAME);
		const tmpPath = join(options.noncesDir, REPLAY_LOG_TMP_FILENAME);
		// A temp file left by a compaction that never completed under the old design
		// can only be a partial copy, and nothing reads it either way.
		const dropQuietly = async (path: string): Promise<void> => {
			try {
				await unlink(path);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		};
		let raw: Buffer;
		try {
			raw = await readFile(legacyPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				await dropQuietly(tmpPath);
				return;
			}
			throw error;
		}
		// Fixed width, so anything past the last whole record is a torn append.
		const total = Math.floor(raw.length / REPLAY_RECORD_BYTES);
		let carried = 0;
		db.transaction((tx) => {
			for (let index = 0; index < total; index += 1) {
				const offset = index * REPLAY_RECORD_BYTES;
				const seenAtMs = Number(
					raw.readBigUInt64BE(offset + WIRE_ID_BYTES + NONCE_BYTES),
				);
				// Expired rows are not worth carrying: a request bearing one is already
				// refused on its own timestamp.
				if (nowMs - seenAtMs > retentionMs) {
					continue;
				}
				const deviceIdBytes = new Uint8Array(
					raw.subarray(offset, offset + WIRE_ID_BYTES),
				);
				const nonce = new Uint8Array(
					raw.subarray(
						offset + WIRE_ID_BYTES,
						offset + WIRE_ID_BYTES + NONCE_BYTES,
					),
				);
				tx.insert(companionReplayNonces)
					.values({
						key: replayKey(deviceIdBytes, nonce),
						deviceId: base64UrlEncode(deviceIdBytes),
						nonce: base64UrlEncode(nonce),
						seenAtMs,
						ord: carried,
					})
					.onConflictDoNothing({ target: companionReplayNonces.key })
					.run();
				carried += 1;
			}
		});
		console.error(
			`(COMPANION-BRIDGE) carried ${carried} unexpired replay record(s) of ${total} from ${legacyPath} into host.db, then retired the file. Expected exactly once per install.`,
		);
		await dropQuietly(legacyPath);
		await dropQuietly(tmpPath);
	}

	await importLegacyLog(Date.now());
	loadFromDb(Date.now());

	return {
		admit(deviceId, nonce, nowMs) {
			return serialise(async () => {
				if (closed) {
					throw new CleartextError(503, "bridge_unavailable");
				}
				requireLength(nonce, NONCE_BYTES, "replay cache nonce");
				const deviceIdBytes = base64UrlDecode(deviceId);
				requireLength(deviceIdBytes, WIRE_ID_BYTES, "replay cache deviceId");

				const key = replayKey(deviceIdBytes, nonce);
				// PRESENCE is the whole test. An earlier revision re-admitted a record
				// whose recorded time looked older than the retention, which handed a
				// forward clock jump the ability to un-see a nonce without compaction
				// ever running. A record leaves this map exactly one way: compaction.
				if (entries.has(key)) {
					return false;
				}

				if (entries.size >= maxEntries) {
					rewrite(nowMs);
					if (entries.size >= maxEntries) {
						// Never evict a live entry to make room: that would silently
						// re-open the replay window this cache exists to close. Refuse
						// the request instead and let the operator see it.
						throw new CleartextError(503, "bridge_unavailable");
					}
				}

				// ONE STATEMENT DECIDES AND RECORDS. `changes === 1` means this nonce was
				// not present and now is, durably; `0` means a row already existed, which
				// is a replay the live map had somehow lost sight of. The old shape
				// decided from the map and appended separately, so a divergence between
				// the two was expressible; here it is not.
				//
				// Committed BEFORE the caller is allowed to act on the request, at
				// `synchronous = FULL` in WAL mode.
				const inserted = db
					.insert(companionReplayNonces)
					.values({
						key,
						deviceId: base64UrlEncode(deviceIdBytes),
						nonce: base64UrlEncode(nonce),
						seenAtMs: nowMs,
						ord: nextOrder,
					})
					.onConflictDoNothing({ target: companionReplayNonces.key })
					.run();
				if (inserted.changes === 0) {
					// A row exists that the map did not know about — a compaction that
					// dropped it from memory while the DELETE was lost, or a second
					// process. Either way it has been seen, so it is a replay, and the map
					// is corrected so the next probe answers from memory.
					entries.set(key, {
						seenAtMs: nowMs,
						monoAtMs: monotonicNowMs(),
						order: nextOrder,
					});
					nextOrder += 1;
					return false;
				}

				entries.set(key, {
					seenAtMs: nowMs,
					monoAtMs: monotonicNowMs(),
					order: nextOrder,
				});
				nextOrder += 1;
				return true;
			});
		},

		compact(nowMs) {
			return serialise(async () => {
				if (closed) {
					return;
				}
				rewrite(nowMs);
			});
		},

		size() {
			return entries.size;
		},

		close() {
			return serialise(async () => {
				if (closed) {
					return;
				}
				// No handle and no temp file to clean up any more. The connection is
				// owned by host-service and outlives this cache, so closing it here
				// would take the rest of the application's database with it.
				closed = true;
			});
		},
	};
}
