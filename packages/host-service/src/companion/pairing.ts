/**
 * (COMPANION-BRIDGE) — LAN pairing listener and the four-step exchange (§4).
 *
 * Runs on a SEPARATE socket (0.0.0.0:47611) with a 120 s lifetime and exactly
 * one successful use. The bridge's own listener stays loopback-only.
 *
 * Hard rules this module exists to enforce:
 *  - K_dev is derived, never transmitted.
 *  - The desktop renders ONLY the QR. The pairing code is never rendered as
 *    text, never logged, never written to a file, never in a diagnostic bundle.
 *    (PAIR-REF-ONLY) That rule covers `qrUri` in its ENTIRETY, not just the `pc`
 *    parameter: the URI carries the code in its fragment, so a log line holding
 *    the URI holds the code, and a log file outlives the 120 s window the code's
 *    secrecy was bounded by. `PairingWindowHandle.pairingRef` exists so a caller
 *    that wants a traceable identifier has one it can log freely; `qrUri` has
 *    exactly one legitimate consumer, the QR encoder.
 *  - Three bad MACs burn the window.
 *  - On close, pairingCode / dPriv / PRK / K_conf_* are zeroed.
 *
 * ---------------------------------------------------------------------------
 * Why a cleartext LAN hop is sound here (§4.7), restated so nobody "fixes" it
 * ---------------------------------------------------------------------------
 * `pPub` and `dPub` are public by construction. `K_dev` needs `Z` AND the
 * 256-bit `pairingCode`, which exists only in the QR fragment. A passive
 * observer has neither. An ACTIVE MITM can obtain its own `Z` but not the
 * code, so its `PRK` is wrong, its `macPhone` fails, and nothing is stored.
 * The one message carrying a secret — step 4, with the Cloudflare service
 * token — is sealed. That is why there is no TLS on this hop and why adding a
 * self-signed certificate would add complexity without adding security.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE CONFIRMATION MAC DOES **NOT** COVER — (PAIR-META-UNAUTHENTICATED)
 * ---------------------------------------------------------------------------
 * The §4.4 step-3 transcript is `"sc/v1" || pid || deviceId || pPub || dPub ||
 * pairSalt` — 117 bytes, and nothing else. `macPhone` therefore authenticates
 * the KEY MATERIAL and the peer identities, and NOT the four descriptive fields
 * the same cleartext kex packet carries: `label`, `surface`, `appVersion` and
 * `protocol`.
 *
 * Consequence, stated so nobody reads a successful pairing as covering more than
 * it does: an ACTIVE on-path attacker cannot obtain `K_dev` (that still needs the
 * code), but it CAN rewrite those four fields in flight. The phone's MAC still
 * verifies, the desktop still stores a working key, and the desktop ends up
 * holding a device record whose LABEL and SURFACE were chosen by the attacker
 * while every downstream surface treats them as facts established by a
 * cryptographic exchange.
 *
 * `appVersion` is validated and then dropped here, so it cannot mislead anyone.
 * `protocol` is returned to the caller and is a negotiation input, not an
 * authorisation input. `label` and `surface` DO outlive this module, via
 * `PairConfirmResult` -> the device record. They are marked there.
 *
 * This is a WIRE-LEVEL gap and it cannot be closed from this file alone: the
 * transcript is normative in PROTOCOL.md §4.4 and the Android client computes
 * `macPhone` over the identical 117 bytes (there are cross-runtime differential
 * vectors pinning them). Closing it means extending the transcript — or echoing
 * the recorded metadata inside the SEALED step-4 body so the phone can detect a
 * rewrite — on BOTH sides at once. What this module does unilaterally is refuse
 * to let a second kex packet rewrite the metadata of a deviceId that already
 * has a candidate session (see `handleKex`), which removes the after-the-fact
 * rewrite; it does not remove the in-flight one.
 *
 * ---------------------------------------------------------------------------
 * NONCE RESERVATION — normative, and load-bearing
 * ---------------------------------------------------------------------------
 * The step-4 response is sealed under a BRAND NEW `K_s2c` whose steady-state
 * counter has not started yet. To make nonce reuse under that key impossible
 * rather than improbable, the pairing response uses counter **0**, which §3.4
 * excludes from steady state ("counter ... starts at 1"). Collision is then
 * ruled out by construction, not by trusting 32 random prefix bits.
 * `keys.ts`'s `SendNonceSource` MUST start at 1. Do not change either half.
 */

import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import { networkInterfaces } from "node:os";
import {
	ACCESS_AUD,
	ACCESS_TEAM_DOMAIN,
	BRIDGE_PROTOCOL_RANGE,
	HKDF_LABEL_CONFIRM_DESKTOP,
	HKDF_LABEL_CONFIRM_PHONE,
	HKDF_LABEL_DEVICE,
	HKDF_LABEL_SEAL_S2C,
	LOG_PREFIX,
	PAIRING_ATTEMPTS_PER_WINDOW,
	PAIRING_BIND_HOST,
	PAIRING_CODE_BYTES,
	PAIRING_HKDF_SALT_PREFIX,
	PAIRING_MAX_BAD_MACS,
	PAIRING_PORT,
	PAIRING_SALT_BYTES,
	PAIRING_TRANSCRIPT_PREFIX,
	PAIRING_WINDOW_MS,
	PUBLIC_ORIGIN,
} from "./config";
import {
	base64UrlDecode,
	base64UrlEncode,
	buildRequestAad,
	constantTimeEquals,
	generateX25519KeyPair,
	hkdfExpandInfo,
	hkdfExpandLabel,
	hkdfExtract,
	hkdfInfoWithSuffix,
	hmacSha256,
	randomBytes,
	seal,
	sha256,
	x25519,
	zero,
} from "./crypto";
import {
	KEY_BYTES,
	MAX_APP_VERSION_CHARS,
	MAX_LABEL_CHARS,
	WIRE_ID_BYTES,
	X25519_KEY_BYTES,
} from "./limits";
import {
	ENVELOPE_KIND_RESPONSE,
	type PairConfirmRequest,
	type PairConfirmResponse,
	type PairingErrorCode,
	type PairingWindowState,
	type PairKexRequest,
	type PairKexResponse,
	type ProtocolRange,
	type Surface,
} from "./types";

const MAC_BYTES = 32;
const TRANSCRIPT_BYTES = 117;
const MAX_PAIR_BODY_BYTES = 4 * 1024;
/**
 * (PAIR-JUNK-SURVIVAL) Ceiling on candidate kex sessions. Reaching it EVICTS the
 * oldest candidate rather than refusing the newcomer: a refusal here is a
 * lockout of whoever arrives last, and the phone always arrives after the
 * attacker who is already flooding. An evicted candidate loses nothing it cannot
 * recreate — it re-kexes and tries again — whereas a refused one is simply told
 * "no" for the rest of the window.
 */
const MAX_KEX_SESSIONS = 16;
/**
 * (PAIR-JUNK-SURVIVAL) How many DISTINCT deviceIds one remote address may
 * introduce per window. This is what makes the eviction above hard to weaponise:
 * evicting the real phone's candidate out from under it requires
 * `MAX_KEX_SESSIONS` introductions inside its sub-second kex->confirm gap, and
 * this caps how fast a single source can produce them.
 */
const MAX_KEX_PER_SOURCE = 4;
/** Bounds the per-source table itself; oldest bucket is evicted when full. */
const MAX_KEX_SOURCES = 32;
/** §3.4 reserves counter 0 for this one message. Steady state starts at 1. */
const PAIRING_NONCE_COUNTER = 0n;

const PAIR_PATH_KEX = "/pair/kex";
const PAIR_PATH_CONFIRM = "/pair/confirm";
const PROTOCOL_VERSION_AT_PAIRING = 1;

export class PairingError extends Error {
	constructor(
		readonly statusCode: number,
		readonly code: PairingErrorCode,
	) {
		super(code);
		this.name = "PairingError";
	}
}

/**
 * The full window state. `PairingWindowState` (types.ts) is the wire-visible
 * subset; it deliberately does NOT carry `dPriv` or the per-kex candidates,
 * neither of which may ever be serialised. This type extends it so the exported
 * handlers keep the documented shape while having what they actually need.
 */
export interface PairingSessionState extends PairingWindowState {
	/** 32 raw bytes. Zeroed on close. Never leaves this process. */
	dPriv: Uint8Array;
	/** Candidate devices that completed step 1, keyed by deviceId. */
	kexSessions: Map<string, KexSession>;
	/**
	 * §12 — 5 attempts per window, charged ONLY on `/pair/confirm`, and only for
	 * a confirm that reached the MAC check. See `chargeConfirmAttempt`.
	 */
	confirmAttempts: number;
	/** (PAIR-JUNK-SURVIVAL) Per remote address: distinct deviceIds introduced. */
	kexSourceCounts: Map<string, number>;
	/**
	 * (PAIR-ATTEMPT-ORDER) Requests that failed the pid check, or that named a
	 * deviceId with no candidate session. Counted for visibility ONLY; deliberately
	 * not compared against any limit, so unauthenticated LAN noise can never lock
	 * the real device out.
	 */
	unattributedAttempts: number;
}

interface KexSession {
	deviceId: string;
	deviceIdBytes: Uint8Array;
	pPub: Uint8Array;
	label: string;
	surface: Surface;
	appVersion: string;
	protocol: ProtocolRange;
	createdAtMs: number;
	/** Remote address that introduced this candidate. Diagnostics + throttling. */
	sourceKey: string;
}

export interface PairingWindowHandle {
	/**
	 * The QR URI.
	 *
	 * (PAIR-REF-ONLY) SECRET-BEARING FOR 120 SECONDS. The single-use pairing code
	 * is in the FRAGMENT, so this whole string is the code. It has exactly one
	 * legitimate destination — a QR encoder — and MUST NOT be logged, printed,
	 * persisted, put in an error message, or included in a diagnostic bundle. A
	 * log file is precisely the place a 120-second secret goes to outlive its
	 * window. Log `pairingRef` instead.
	 */
	qrUri: string;
	/**
	 * (PAIR-REF-ONLY) A non-secret, non-reversible reference to THIS window, safe
	 * to log and to correlate against.
	 *
	 * It is the pairing id (`pid`): 16 independent random bytes that are already
	 * transmitted in cleartext on the LAN hop by design, and that carry no
	 * information about `pairingCode` — the two are drawn from separate
	 * `randomBytes` calls and are combined nowhere. Publishing it reveals nothing
	 * that an observer of the wire does not already have.
	 */
	pairingRef: string;
	expiresAtMs: number;
	/**
	 * The window is over — it expired, it was consumed by a successful pairing,
	 * or someone closed it. A holder of this handle CANNOT infer that from
	 * `expiresAtMs` (single-use closes early) and must not have to provoke the
	 * `qrUri` getter's 410 to find out, so the fact is stated. Without it a
	 * caller that remembers the handle refuses to open the next window forever.
	 */
	readonly closed: boolean;
	/**
	 * (PAIR-REF-ONLY) Structural containment for the accidental leak: passing the
	 * handle itself to a logger, an error serialiser or `JSON.stringify` yields
	 * the reference and never the URI. It cannot stop a caller that reaches for
	 * `.qrUri` explicitly — nothing can — but it removes the whole class of leaks
	 * where the URI travels inside an object somebody logged for other reasons.
	 */
	toJSON(): { pairingRef: string; expiresAtMs: number; closed: boolean };
	close(): Promise<void>;
}

export interface PairingDeps {
	/** Called once a device is fully confirmed, inside step 5. */
	onPaired(input: {
		deviceId: string;
		label: string;
		surface: Surface;
		deviceKey: Uint8Array;
	}): Promise<void>;
	/**
	 * Reads the Cloudflare service token from `~/.superset/companion/` at the
	 * last possible moment. It is held only for the microseconds it takes to
	 * seal step 4 and is never returned to any caller of this module.
	 */
	loadAccessToken(): Promise<{ clientId: string; clientSecret: string }>;
	/**
	 * Optional override for the LAN address advertised in the QR. Supply it only
	 * when the machine has several private addresses and the user picked one;
	 * otherwise this module discovers it and FAILS LOUD if it cannot.
	 */
	lanHost?: string;
}

// ---------------------------------------------------------------------------
// §4.4 step 3 — the transcript
// ---------------------------------------------------------------------------

/**
 * §4.4 step 3 — `"sc/v1" || pid || deviceId || pPub || dPub || pairSalt`
 * = 117 bytes, fixed order, fixed lengths.
 *
 * RAW BYTES, and so is every id suffix in the HKDF `info` strings (see the
 * INTEROP NOTE in crypto.ts) — the whole exchange uses one convention. Every
 * length is fixed, so the concatenation is unambiguous without separators —
 * which is exactly why the lengths are asserted here rather than assumed.
 */
export function buildPairingTranscript(input: {
	pid: Uint8Array;
	deviceId: Uint8Array;
	pPub: Uint8Array;
	dPub: Uint8Array;
	pairSalt: Uint8Array;
}): Uint8Array {
	assertLength(input.pid, WIRE_ID_BYTES);
	assertLength(input.deviceId, WIRE_ID_BYTES);
	assertLength(input.pPub, X25519_KEY_BYTES);
	assertLength(input.dPub, X25519_KEY_BYTES);
	assertLength(input.pairSalt, PAIRING_SALT_BYTES);

	const prefix = Buffer.from(PAIRING_TRANSCRIPT_PREFIX, "ascii");
	const out = new Uint8Array(TRANSCRIPT_BYTES);
	let offset = 0;
	for (const part of [
		new Uint8Array(prefix),
		input.pid,
		input.deviceId,
		input.pPub,
		input.dPub,
		input.pairSalt,
	]) {
		out.set(part, offset);
		offset += part.length;
	}
	if (offset !== TRANSCRIPT_BYTES) {
		throw new PairingError(500, "unknown");
	}
	return out;
}

function assertLength(value: Uint8Array, expected: number): void {
	if (value.length !== expected) {
		throw new PairingError(400, "unknown");
	}
}

// ---------------------------------------------------------------------------
// §3.1 — the pairing key schedule
// ---------------------------------------------------------------------------

interface PairingKeys {
	prk: Uint8Array;
	deviceKey: Uint8Array;
	confirmPhone: Uint8Array;
	confirmDesktop: Uint8Array;
}

/**
 * §3.1. `IKM = Z || pairingCode` is what makes the exchange sound against an
 * active MITM: the attacker can produce its own `Z` but has no `pairingCode`,
 * so its `PRK` — and therefore every key below — is wrong.
 *
 * `pid` and `deviceId` contribute their RAW 16 BYTES to the K_dev `info`, not
 * their base64url text. That is the convention the Android client implements and
 * the one the §4.4 transcript already uses; the two sides must agree exactly or
 * every derived key differs and pairing fails as `pair_bad_mac` forever. See the
 * INTEROP NOTE in `crypto.ts`.
 */
function derivePairingKeys(input: {
	dPriv: Uint8Array;
	pPub: Uint8Array;
	pairingCode: Uint8Array;
	pairSalt: Uint8Array;
	pidBytes: Uint8Array;
	deviceIdBytes: Uint8Array;
}): PairingKeys {
	assertLength(input.pidBytes, WIRE_ID_BYTES);
	assertLength(input.deviceIdBytes, WIRE_ID_BYTES);

	// Rejects an all-zero shared secret (small-order peer point) inside x25519().
	const z = x25519(input.dPriv, input.pPub);

	const ikm = new Uint8Array(z.length + input.pairingCode.length);
	ikm.set(z, 0);
	ikm.set(input.pairingCode, z.length);

	const saltPrefix = Buffer.from(PAIRING_HKDF_SALT_PREFIX, "ascii");
	const salt = new Uint8Array(saltPrefix.length + input.pairSalt.length);
	salt.set(saltPrefix, 0);
	salt.set(input.pairSalt, saltPrefix.length);

	const prk = hkdfExtract(salt, ikm);
	zero(z);
	zero(ikm);

	return {
		prk,
		deviceKey: hkdfExpandInfo(
			prk,
			hkdfInfoWithSuffix(
				HKDF_LABEL_DEVICE,
				input.pidBytes,
				input.deviceIdBytes,
			),
			KEY_BYTES,
		),
		confirmPhone: hkdfExpandLabel(prk, HKDF_LABEL_CONFIRM_PHONE, KEY_BYTES),
		confirmDesktop: hkdfExpandLabel(prk, HKDF_LABEL_CONFIRM_DESKTOP, KEY_BYTES),
	};
}

function zeroKeys(keys: PairingKeys): void {
	zero(keys.prk);
	zero(keys.confirmPhone);
	zero(keys.confirmDesktop);
	// `deviceKey` is zeroed by the caller AFTER it has been persisted.
}

// ---------------------------------------------------------------------------
// §4.4 step 1 -> step 2
// ---------------------------------------------------------------------------

/**
 * step 1 -> step 2. Cleartext JSON on the LAN hop; both values are public.
 *
 * `sourceKey` is the remote address the packet arrived from. It is REQUIRED, not
 * optional: it is the only thing that bounds how fast one host can churn the
 * candidate table, and a caller that cannot supply it is a caller whose socket
 * has already gone away.
 */
export function handleKex(
	state: PairingSessionState,
	request: PairKexRequest,
	sourceKey: string,
): PairKexResponse {
	assertWindowOpen(state);

	if (request.v !== 1) {
		throw new PairingError(400, "pair_version_unsupported");
	}
	if (typeof sourceKey !== "string" || sourceKey.length === 0) {
		throw new PairingError(400, "unknown");
	}
	// (PAIR-ATTEMPT-ORDER) Nothing is charged before the request has proved it
	// knows the QR.
	assertPidMatches(state, request.pid);

	const deviceIdBytes = decodeExact(request.deviceId, WIRE_ID_BYTES);
	const pPub = decodeExact(request.pPub, X25519_KEY_BYTES);
	const label = assertLabel(request.label);
	const surface = assertSurface(request.surface);
	const appVersion = assertAppVersion(request.appVersion);
	const protocol = assertProtocolRange(request.protocol);

	const existing = state.kexSessions.get(request.deviceId);
	if (existing !== undefined) {
		// (PAIR-JUNK-SURVIVAL) A retransmit — which a lossy LAN produces on its own
		// and which anyone who watched the wire can also produce — changes nothing
		// and therefore costs nothing. This is the whole point: replaying an
		// observed kex must not be able to spend anything the real phone needs.
		//
		// (PAIR-META-UNAUTHENTICATED) A packet that reuses a deviceId but carries
		// DIFFERENT key material or different metadata is not a retransmit. A
		// deviceId is 128 phone-minted random bits, so a collision is not a thing
		// that happens; somebody is rewriting another device's candidate. Refuse,
		// and keep the first one — the alternative, last-write-wins, hands an
		// observer a free edit on the label the desktop is about to store.
		if (
			!sameKexCandidate(existing, {
				pPub,
				label,
				surface,
				appVersion,
				protocol,
			})
		) {
			console.warn(
				`${LOG_PREFIX} pairing kex reused deviceId with different key material or metadata — refused, the first candidate stands`,
			);
			throw new PairingError(400, "pair_wrong_peer");
		}
		return kexResponse(state);
	}

	chargeKexIntroduction(state, sourceKey);

	state.kexSessions.set(request.deviceId, {
		deviceId: request.deviceId,
		deviceIdBytes,
		pPub,
		label,
		surface,
		appVersion,
		protocol,
		createdAtMs: Date.now(),
		sourceKey,
	});
	evictOldestKexSessionsIfFull(state);

	return kexResponse(state);
}

function kexResponse(state: PairingSessionState): PairKexResponse {
	return {
		v: 1,
		pid: state.pid,
		dPub: base64UrlEncode(state.dPub),
		pairSalt: base64UrlEncode(state.pairSalt),
		serverTimeMs: Date.now(),
	};
}

function sameKexCandidate(
	existing: KexSession,
	incoming: {
		pPub: Uint8Array;
		label: string;
		surface: Surface;
		appVersion: string;
		protocol: ProtocolRange;
	},
): boolean {
	return (
		constantTimeEquals(existing.pPub, incoming.pPub) &&
		existing.label === incoming.label &&
		existing.surface === incoming.surface &&
		existing.appVersion === incoming.appVersion &&
		existing.protocol.min === incoming.protocol.min &&
		existing.protocol.max === incoming.protocol.max
	);
}

/**
 * (PAIR-JUNK-SURVIVAL) Per-source bound on NEW candidates. Exceeding it refuses
 * that source, and only that source; every other address — including the phone
 * that has not spoken yet — still has its full allowance.
 */
function chargeKexIntroduction(
	state: PairingSessionState,
	sourceKey: string,
): void {
	const used = state.kexSourceCounts.get(sourceKey) ?? 0;
	if (used >= MAX_KEX_PER_SOURCE) {
		console.warn(
			`${LOG_PREFIX} pairing kex flood from one source (${MAX_KEX_PER_SOURCE} distinct deviceIds this window) — refusing that source only; other sources are unaffected`,
		);
		throw new PairingError(429, "pair_rate_limited");
	}
	if (
		!state.kexSourceCounts.has(sourceKey) &&
		state.kexSourceCounts.size >= MAX_KEX_SOURCES
	) {
		// Bound the table itself. Map iteration is insertion-ordered, so the first
		// key is the oldest bucket.
		const oldest = state.kexSourceCounts.keys().next();
		if (!oldest.done) state.kexSourceCounts.delete(oldest.value);
	}
	state.kexSourceCounts.set(sourceKey, used + 1);
}

/**
 * (PAIR-JUNK-SURVIVAL) Evict oldest-first, never refuse. See `MAX_KEX_SESSIONS`.
 * Loud, because a window in which this fires is a window somebody is flooding.
 */
function evictOldestKexSessionsIfFull(state: PairingSessionState): void {
	while (state.kexSessions.size > MAX_KEX_SESSIONS) {
		let oldestKey: string | null = null;
		let oldestAtMs = Number.POSITIVE_INFINITY;
		for (const [key, session] of state.kexSessions) {
			if (session.createdAtMs < oldestAtMs) {
				oldestAtMs = session.createdAtMs;
				oldestKey = key;
			}
		}
		if (oldestKey === null) return;
		state.kexSessions.delete(oldestKey);
		console.warn(
			`${LOG_PREFIX} pairing candidate table full (${MAX_KEX_SESSIONS}) — evicted the oldest candidate; if the real phone was evicted it can simply kex again`,
		);
	}
}

// ---------------------------------------------------------------------------
// §4.4 step 3b -> step 4
// ---------------------------------------------------------------------------

/**
 * Result of a successful confirm.
 *
 * DELIBERATE DEVIATION FROM THE STUB SIGNATURE: this does NOT return the
 * step-4 plaintext. That plaintext contains the Cloudflare service-token
 * secret, and handing it back to a caller creates a permanent risk that some
 * future log line, error report or diagnostic bundle serialises it. The secret
 * exists inside this function for the length of one `seal()` call and nowhere
 * else. Callers get the sealed bytes plus the non-secret facts they need.
 */
export interface PairConfirmResult {
	/** The step-4 body: a sealed envelope. Write it to the socket verbatim. */
	sealedBody: Uint8Array;
	deviceId: string;
	/**
	 * (PAIR-META-UNAUTHENTICATED) UNAUTHENTICATED. The confirmation MAC covers the
	 * 117-byte transcript and this string is not in it, so an on-path attacker can
	 * choose it. Store it, show it as the name the device SAID it had, and never
	 * present it as an identity the exchange established. See the module header.
	 */
	label: string;
	/**
	 * (PAIR-META-UNAUTHENTICATED) UNAUTHENTICATED, exactly as `label` is. A
	 * rewritten surface presents later as `/v1/register` refusing the device's own
	 * token with `surface does not match the paired device record`.
	 */
	surface: Surface;
	/** (PAIR-META-UNAUTHENTICATED) UNAUTHENTICATED. A negotiation input only. */
	protocol: ProtocolRange;
}

/**
 * step 3b -> step 4. Recomputes `macPhone` in CONSTANT TIME; a mismatch stores
 * nothing and increments the burn counter. The response body is SEALED and is
 * the only message in the protocol carrying the Access service-token secret.
 *
 * Ordering that is not negotiable: the device record is PERSISTED BEFORE the
 * response is sealed. A crash between the two leaves the desktop holding a key
 * the phone never received — recoverable by re-pairing. The reverse order would
 * leave the phone holding a key the desktop has no record of, which presents as
 * a silently broken pairing.
 */
export async function handleConfirm(
	state: PairingSessionState,
	request: PairConfirmRequest,
	deps: PairingDeps,
): Promise<PairConfirmResult> {
	assertWindowOpen(state);

	if (request.v !== 1) {
		throw new PairingError(400, "pair_version_unsupported");
	}
	// (PAIR-ATTEMPT-ORDER) After the pid check, exactly as in `handleKex`.
	assertPidMatches(state, request.pid);

	const session = state.kexSessions.get(request.deviceId);
	if (!session) {
		// (PAIR-JUNK-SURVIVAL) This request never reached a MAC check, so it is NOT
		// a grinding attempt and must not spend the 3-strike anti-grind budget.
		// Charging it there meant three packets naming a made-up deviceId — no
		// crypto, no guess, nothing learned either way — burned the whole 120 s
		// window, repeatably, for anyone who had seen the pid. Nor does it spend the
		// confirm budget, for the same reason `handleKex` does not spend it.
		noteUnattributedAttempt(state);
		throw new PairingError(400, "pair_wrong_peer");
	}

	// From here the request has a candidate session and a MAC will actually be
	// verified, which is the only thing the §12 budget is protecting.
	chargeConfirmAttempt(state);

	const macPhone = decodeExact(request.macPhone, MAC_BYTES);

	const pidBytes = base64UrlDecode(state.pid);

	const keys = derivePairingKeys({
		dPriv: state.dPriv,
		pPub: session.pPub,
		pairingCode: state.pairingCode,
		pairSalt: state.pairSalt,
		pidBytes,
		deviceIdBytes: session.deviceIdBytes,
	});

	const transcript = buildPairingTranscript({
		pid: pidBytes,
		deviceId: session.deviceIdBytes,
		pPub: session.pPub,
		dPub: state.dPub,
		pairSalt: state.pairSalt,
	});

	const expectedPhone = hmacSha256(keys.confirmPhone, transcript);
	if (!constantTimeEquals(expectedPhone, macPhone)) {
		zeroKeys(keys);
		zero(keys.deviceKey);
		burnMac(state);
		// Nothing is stored, and no detail is disclosed about WHY.
		throw new PairingError(401, "pair_bad_mac");
	}

	const macDesktop = hmacSha256(keys.confirmDesktop, transcript);

	// The window is consumed the instant a MAC verifies: a second confirm on
	// this pid can no longer do anything, even if it arrives microseconds later.
	state.consumed = true;

	// Persist first (see the ordering note above).
	await deps.onPaired({
		deviceId: session.deviceId,
		label: session.label,
		surface: session.surface,
		deviceKey: keys.deviceKey,
	});

	const sendKey = hkdfExpandLabel(
		keys.deviceKey,
		HKDF_LABEL_SEAL_S2C,
		KEY_BYTES,
	);
	const access = await deps.loadAccessToken();

	const plaintext: PairConfirmResponse = {
		macDesktop: base64UrlEncode(macDesktop),
		deviceId: session.deviceId,
		access: { clientId: access.clientId, clientSecret: access.clientSecret },
		bridge: {
			origin: PUBLIC_ORIGIN,
			teamDomain: ACCESS_TEAM_DOMAIN,
			aud: ACCESS_AUD,
		},
		protocol: { ...BRIDGE_PROTOCOL_RANGE },
		issuedAtMs: Date.now(),
		serverTimeMs: Date.now(),
	};

	const plaintextBytes = new TextEncoder().encode(JSON.stringify(plaintext));
	const nonce = pairingResponseNonce();
	const timestampMs = Date.now();

	let sealedBody: Uint8Array;
	try {
		sealedBody = seal(
			sendKey,
			ENVELOPE_KIND_RESPONSE,
			session.deviceIdBytes,
			nonce,
			timestampMs,
			plaintextBytes,
			(headerBytes) =>
				// §4.4 step 4 enumerates the AAD exactly: kind 0x02, key K_s2c,
				// METHOD "POST", PATH "/pair/confirm", protocolVersion 0x01 — and
				// nothing further. That is the REQUEST form.
				//
				// It is deliberately NOT the §3.3 response form. There is no client
				// request nonce on this hop (the LAN messages are cleartext JSON, not
				// envelopes) and no status code the client can bind before it has
				// read the body, so the response form would have to invent a
				// twelve-zero-byte placeholder nonce and a literal 200. An earlier
				// revision did exactly that; the client follows the spec, so the two
				// AADs differed by 16 bytes and every pairing failed the GCM tag and
				// reported `pair_bad_mac` — indistinguishable from a real MITM.
				buildRequestAad(headerBytes, {
					method: "POST",
					path: PAIR_PATH_CONFIRM,
					protocolVersion: PROTOCOL_VERSION_AT_PAIRING,
				}),
		);
	} finally {
		// The secret's lifetime ends here regardless of outcome.
		// HONEST LIMIT: `plaintextBytes` and every key below are genuinely
		// overwritten, but `access.clientSecret` and the `plaintext` object hold
		// it as immutable JS strings that cannot be zeroed — all we can do is
		// drop the references and never hand them to a caller (see
		// `PairConfirmResult`, which deliberately omits the plaintext).
		zero(plaintextBytes);
		zero(sendKey);
		zeroKeys(keys);
		zero(keys.deviceKey);
		zero(macDesktop);
	}

	return {
		sealedBody,
		deviceId: session.deviceId,
		label: session.label,
		surface: session.surface,
		protocol: session.protocol,
	};
}

/** §3.4 counter 0, reserved for exactly this message. See the header note. */
function pairingResponseNonce(): Uint8Array {
	const nonce = new Uint8Array(12);
	nonce.set(randomBytes(4), 0);
	Buffer.from(nonce.buffer, nonce.byteOffset, 12).writeBigUInt64BE(
		PAIRING_NONCE_COUNTER,
		4,
	);
	return nonce;
}

// ---------------------------------------------------------------------------
// window guards
// ---------------------------------------------------------------------------

function assertWindowOpen(state: PairingSessionState): void {
	if (state.consumed) {
		throw new PairingError(410, "pair_window_closed");
	}
	if (Date.now() >= state.expiresAtMs) {
		throw new PairingError(410, "pair_window_closed");
	}
}

/**
 * §12 — 5 attempts per 120 s window, charged on `/pair/confirm` ONLY, and only
 * once the request has produced a candidate session whose MAC is about to be
 * verified.
 *
 * (PAIR-ATTEMPT-ORDER) CALL THIS ONLY AFTER `assertPidMatches`. The listener
 * binds 0.0.0.0:47611 for the whole window and `route()` reaches the handlers
 * for ANY well-formed JSON POST — no pid, no code, no credential. Charged first,
 * five bodies of `{}` from anything on the LAN exhausted the budget in under a
 * second and every subsequent request, INCLUDING THE REAL PHONE'S, got
 * `429 pair_rate_limited`.
 *
 * (PAIR-JUNK-SURVIVAL) DELIBERATE DEVIATION FROM §12's WORDING, which says "5
 * attempts per window" across `/pair/*` as one pool. One pool cannot survive
 * junk: `deviceId` is chosen by the CALLER, so five kex packets carrying five
 * made-up deviceIds — reproducible by anyone who has seen the pid, on a hop that
 * is cleartext by design — emptied the pool before the legitimate phone got to
 * confirm. The pid check does not help; an observer of one kex packet has the
 * pid. The result was a deterministic, silent, repeatable "the phone can't find
 * the desktop", which is exactly what §4.7 promises an attacker cannot do
 * ("cannot rate-limit a legitimate device out of existence").
 *
 * So the pool is split by endpoint. `/pair/kex` is bounded by `MAX_KEX_SESSIONS`
 * (with eviction, never refusal) and `MAX_KEX_PER_SOURCE`; `/pair/confirm` keeps
 * the §12 count of 5, which it can now never lose to kex noise. Total work per
 * window is still hard-bounded. PROTOCOL.md §12 needs the same amendment.
 *
 * The confirm budget is in practice belt-and-braces: reaching it requires a
 * candidate session, and three failed MACs burn the window first.
 */
function chargeConfirmAttempt(state: PairingSessionState): void {
	state.confirmAttempts += 1;
	if (state.confirmAttempts > PAIRING_ATTEMPTS_PER_WINDOW) {
		throw new PairingError(429, "pair_rate_limited");
	}
}

/**
 * §4.7 — three bad MACs burn the window, so an attacker gets no grinding room.
 *
 * (PAIR-JUNK-SURVIVAL) Reached ONLY from a real `macPhone` verification failure.
 * A strike means "somebody produced a MAC over the right transcript and it was
 * wrong", which is the only event that is evidence of a code guess. Requests
 * that never got that far — wrong pid, unknown deviceId — are unattributed noise
 * and go to `noteUnattributedAttempt`; charging them here let three
 * crypto-free packets burn a 120 s window on demand.
 *
 * RESIDUAL, and inherent to §4.7: an attacker that completed its own kex holds a
 * candidate session, so it can still spend three strikes and burn the window.
 * That is the accepted flip side of the anti-grind rule — the burn is what
 * denies grinding — and it cannot be narrowed without making strikes per-device,
 * which would let a grinder rotate deviceIds for unlimited guesses.
 */
function burnMac(state: PairingSessionState): void {
	state.failedMacAttempts += 1;
	if (state.failedMacAttempts >= PAIRING_MAX_BAD_MACS) {
		// Burn the window. An attacker gets no grinding room (§4.7).
		state.consumed = true;
	}
}

function assertPidMatches(state: PairingSessionState, pid: string): void {
	let given: Uint8Array;
	try {
		given = base64UrlDecode(pid);
	} catch {
		noteUnattributedAttempt(state);
		throw new PairingError(400, "pair_wrong_peer");
	}
	if (!constantTimeEquals(given, base64UrlDecode(state.pid))) {
		noteUnattributedAttempt(state);
		throw new PairingError(400, "pair_wrong_peer");
	}
}

/**
 * (PAIR-ATTEMPT-ORDER) A request that could not prove it knows the QR, or that
 * named a deviceId with no candidate session. Counted and logged, never charged
 * against `PAIRING_ATTEMPTS_PER_WINDOW` and never a MAC strike — see
 * `chargeConfirmAttempt` and `burnMac`. The log line is what turns "the phone
 * can't find the desktop" from unattributable into diagnosable.
 */
function noteUnattributedAttempt(state: PairingSessionState): void {
	state.unattributedAttempts += 1;
	console.warn(
		`${LOG_PREFIX} unattributable pairing request (${state.unattributedAttempts} this window) — ignored, and it did NOT consume the pairing budget or a MAC strike`,
	);
}

function decodeExact(value: unknown, expected: number): Uint8Array {
	if (typeof value !== "string") {
		throw new PairingError(400, "unknown");
	}
	let decoded: Uint8Array;
	try {
		decoded = base64UrlDecode(value);
	} catch {
		throw new PairingError(400, "unknown");
	}
	if (decoded.length !== expected) {
		throw new PairingError(400, "unknown");
	}
	return decoded;
}

function assertLabel(label: unknown): string {
	if (
		typeof label !== "string" ||
		label.length === 0 ||
		label.length > MAX_LABEL_CHARS
	) {
		throw new PairingError(400, "unknown");
	}
	return label;
}

function assertSurface(surface: unknown): Surface {
	if (surface !== "phone" && surface !== "watch") {
		throw new PairingError(400, "unknown");
	}
	return surface;
}

function assertAppVersion(version: unknown): string {
	if (
		typeof version !== "string" ||
		version.length === 0 ||
		version.length > MAX_APP_VERSION_CHARS
	) {
		throw new PairingError(400, "unknown");
	}
	return version;
}

function assertProtocolRange(range: unknown): ProtocolRange {
	if (typeof range !== "object" || range === null) {
		throw new PairingError(400, "unknown");
	}
	const { min, max } = range as { min: unknown; max: unknown };
	if (
		!Number.isInteger(min) ||
		!Number.isInteger(max) ||
		(min as number) < 0 ||
		(max as number) < (min as number) ||
		(max as number) > 0xff
	) {
		throw new PairingError(400, "unknown");
	}
	return { min: min as number, max: max as number };
}

// ---------------------------------------------------------------------------
// §4.2 the listener
// ---------------------------------------------------------------------------

/** §4.2 — at most one pairing window may be open at a time, process-wide. */
let openWindow: PairingWindowHandle | null = null;

/**
 * Opens the single process-wide pairing window. Fails loud if one is already
 * open, or if 47611 is taken.
 */
export async function openPairingWindow(
	deps: PairingDeps,
): Promise<PairingWindowHandle> {
	if (openWindow) {
		throw new PairingError(409, "pair_window_closed");
	}

	const host = deps.lanHost ?? discoverLanHost();
	const { privateKey: dPriv, publicKey: dPub } = generateX25519KeyPair();
	const pidBytes = randomBytes(WIRE_ID_BYTES);
	const pairingCode = randomBytes(PAIRING_CODE_BYTES);
	const pairSalt = randomBytes(PAIRING_SALT_BYTES);
	const openedAtMs = Date.now();

	const state: PairingSessionState = {
		pid: base64UrlEncode(pidBytes),
		pairingCode,
		pairSalt,
		dPub,
		dPriv,
		openedAtMs,
		expiresAtMs: openedAtMs + PAIRING_WINDOW_MS,
		failedMacAttempts: 0,
		consumed: false,
		kexSessions: new Map(),
		confirmAttempts: 0,
		kexSourceCounts: new Map(),
		unattributedAttempts: 0,
	};

	const fingerprint = base64UrlEncode(sha256(dPub).subarray(0, 16));
	// The code lives in the FRAGMENT. Fragments are never transmitted in an HTTP
	// request by any conforming client, so pasting this URI anywhere does not
	// leak it. It is rendered ONLY as a QR bitmap — never as text, never logged.
	let qrUri: string | null =
		`superset-companion://pair#v=1&h=${encodeURIComponent(host)}` +
		`&pid=${state.pid}&pc=${base64UrlEncode(pairingCode)}&fp=${fingerprint}`;

	let server: Server | null = null;
	let closed = false;
	let timer: NodeJS.Timeout | null = null;

	const handle: PairingWindowHandle = {
		get qrUri(): string {
			if (qrUri === null) {
				// Fail loud rather than render a burned code into a QR the user
				// would then scan and watch fail with no explanation.
				throw new PairingError(410, "pair_window_closed");
			}
			return qrUri;
		},
		pairingRef: state.pid,
		expiresAtMs: state.expiresAtMs,
		get closed(): boolean {
			return closed;
		},
		toJSON(): { pairingRef: string; expiresAtMs: number; closed: boolean } {
			return {
				pairingRef: state.pid,
				expiresAtMs: state.expiresAtMs,
				closed,
			};
		},
		close,
	};

	async function close(): Promise<void> {
		if (closed) {
			return;
		}
		closed = true;
		// Release the process-wide slot and destroy the secrets FIRST. Socket
		// teardown can fail; the window must still be gone and the code must
		// still be zeroed if it does, or a failed close would wedge pairing for
		// the lifetime of the process.
		if (openWindow === handle) {
			openWindow = null;
		}
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
		qrUri = null;
		// HONEST LIMIT: `qrUri` is a JS string and therefore immutable — dropping
		// the reference is all we can do, and the engine may keep a copy until GC.
		// The byte arrays below are genuinely overwritten.
		zero(state.pairingCode);
		zero(state.dPriv);
		state.kexSessions.clear();
		state.consumed = true;
		if (server) {
			const toClose = server;
			server = null;
			toClose.closeAllConnections?.();
			await new Promise<void>((resolve, reject) => {
				toClose.close((error) => {
					// ERR_SERVER_NOT_RUNNING means the listener is already down —
					// which is precisely the state this function is asking for, so it
					// is the idempotent success case, not a swallowed failure.
					// Anything else is real and is rethrown.
					if (
						error &&
						(error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING"
					) {
						reject(error);
						return;
					}
					resolve();
				});
			});
		}
	}

	server = createServer((req, res) => {
		void route(req, res, state, deps, close);
	});
	server.headersTimeout = 10_000;
	server.requestTimeout = 15_000;

	await new Promise<void>((resolve, reject) => {
		const onError = (error: Error): void => {
			// 47611 taken, or the address is unavailable: FAIL LOUD. Silently
			// picking another port would produce a QR the phone cannot reach.
			reject(error);
		};
		server?.once("error", onError);
		server?.listen(PAIRING_PORT, PAIRING_BIND_HOST, () => {
			server?.off("error", onError);
			resolve();
		});
	}).catch(async (error: Error) => {
		await close();
		throw error;
	});

	timer = setTimeout(() => {
		void close();
	}, PAIRING_WINDOW_MS);

	openWindow = handle;
	// (PAIR-REF-ONLY) The ONLY line this module logs about an open window, and it
	// carries the reference, the host and the deadline — never the URI. A caller
	// that wants to say more should say it about `pairingRef`.
	console.log(
		`${LOG_PREFIX} pairing window open on ${host} for ${PAIRING_WINDOW_MS}ms pairingRef=${state.pid} — the QR is the only place the code is rendered`,
	);
	return handle;
}

async function route(
	req: IncomingMessage,
	res: ServerResponse,
	state: PairingSessionState,
	deps: PairingDeps,
	close: () => Promise<void>,
): Promise<void> {
	try {
		if (req.method !== "POST") {
			writeJson(res, 405, { code: "unknown" satisfies PairingErrorCode });
			return;
		}
		const path = (req.url ?? "").split("?")[0];
		if (path !== PAIR_PATH_KEX && path !== PAIR_PATH_CONFIRM) {
			writeJson(res, 404, { code: "unknown" satisfies PairingErrorCode });
			return;
		}

		const body = await readBody(req);
		let parsed: unknown;
		try {
			parsed = JSON.parse(body);
		} catch {
			writeJson(res, 400, { code: "unknown" satisfies PairingErrorCode });
			return;
		}
		if (typeof parsed !== "object" || parsed === null) {
			writeJson(res, 400, { code: "unknown" satisfies PairingErrorCode });
			return;
		}

		if (path === PAIR_PATH_KEX) {
			// (PAIR-JUNK-SURVIVAL) The source is REQUIRED. An active request whose
			// socket has no remote address is not a request we can throttle, and
			// exempting it would hand a flooder the exemption.
			const sourceKey = req.socket.remoteAddress;
			if (sourceKey === undefined || sourceKey.length === 0) {
				writeJson(res, 400, { code: "unknown" satisfies PairingErrorCode });
				return;
			}
			writeJson(
				res,
				200,
				handleKex(state, parsed as PairKexRequest, sourceKey),
			);
			return;
		}

		const result = await handleConfirm(
			state,
			parsed as PairConfirmRequest,
			deps,
		);
		res.writeHead(200, {
			"content-type": "application/octet-stream",
			"content-length": String(result.sealedBody.length),
			"cache-control": "no-store",
			connection: "close",
		});
		res.end(Buffer.from(result.sealedBody));
		// §4.4 step 5 — one successful pairing, then the socket closes. Wait for
		// the body to reach the socket first: `close()` destroys connections, and
		// tearing down before the flush would lose the ONLY copy of the sealed
		// step-4 body — the phone would have no key and no way to ask again.
		await flushed(res);
		await closeQuietly(close);
	} catch (error) {
		if (error instanceof PairingError) {
			writeJson(res, error.statusCode, { code: error.code });
			if (state.consumed) {
				// Three bad MACs (or an expiry) burned the window: tear it down now
				// rather than leaving a dead socket listening.
				await flushed(res);
				await closeQuietly(close);
			}
			return;
		}
		// Never swallow an unexpected failure, and never leak its text to the
		// LAN: the operator sees it, the caller sees a generic refusal.
		console.error("(COMPANION-BRIDGE) pairing failed", error);
		writeJson(res, 500, { code: "unknown" satisfies PairingErrorCode });
		await flushed(res);
		await closeQuietly(close);
	}
}

/**
 * By the time `close()` reaches socket teardown the window is already consumed
 * and every secret already zeroed, so a teardown failure must not be turned
 * into a second write on a socket that has already been answered. The operator
 * sees it; the exchange does not change shape because of it.
 */
async function closeQuietly(close: () => Promise<void>): Promise<void> {
	try {
		await close();
	} catch (error) {
		console.error("(COMPANION-BRIDGE) pairing listener teardown failed", error);
	}
}

/** Resolves once the response body has been handed to the socket. */
function flushed(res: ServerResponse): Promise<void> {
	if (res.writableFinished) {
		return Promise.resolve();
	}
	return new Promise<void>((resolve) => {
		res.once("finish", resolve);
		res.once("close", resolve);
	});
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
	if (res.headersSent) {
		// The socket has already been answered. Writing again would throw over a
		// response that is on the wire; the mistake is reported, not hidden, and
		// the client keeps the answer it already has.
		console.error(
			"(COMPANION-BRIDGE) pairing: response already sent, dropping a second write",
		);
		return;
	}
	const payload = Buffer.from(JSON.stringify(body), "utf8");
	res.writeHead(status, {
		"content-type": "application/json",
		"content-length": String(payload.length),
		"cache-control": "no-store",
	});
	res.end(payload);
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let total = 0;
		req.on("data", (chunk: Buffer) => {
			total += chunk.length;
			if (total > MAX_PAIR_BODY_BYTES) {
				reject(new PairingError(413, "unknown"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

/**
 * §4.3 — `h` must be an IP LITERAL that is site-local or link-local. The phone
 * enforces the same rule in code (§4.6), because a manifest exception cannot
 * express a CIDR range; this side simply never advertises anything else.
 *
 * Fails loud when there is no private address: "pair over the LAN" has no
 * degraded path that transmits a credential over a channel we do not control.
 */
export function discoverLanHost(): string {
	const candidates: string[] = [];
	for (const entries of Object.values(networkInterfaces())) {
		for (const entry of entries ?? []) {
			if (entry.internal || entry.family !== "IPv4") {
				continue;
			}
			if (isPrivateIpv4(entry.address)) {
				candidates.push(entry.address);
			}
		}
	}
	const first = candidates[0];
	if (first === undefined) {
		throw new PairingError(503, "pair_unreachable");
	}
	return `${first}:${PAIRING_PORT}`;
}

function isPrivateIpv4(address: string): boolean {
	const parts = address.split(".").map(Number);
	if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p))) {
		return false;
	}
	const [a, b] = parts as [number, number, number, number];
	if (a === 10) {
		return true;
	}
	if (a === 172 && b >= 16 && b <= 31) {
		return true;
	}
	if (a === 192 && b === 168) {
		return true;
	}
	// 169.254/16 link-local — accepted, matching the phone's
	// `isLinkLocalAddress()` half of the §4.6 check.
	return a === 169 && b === 254;
}
