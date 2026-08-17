/**
 * (COMPANION-BRIDGE) — pairing: the four-step exchange (§4), served two ways.
 *
 * QR / LAN (§4.1-4.8, unchanged and untouchable). A SEPARATE socket
 * (0.0.0.0:47611) with a 120 s lifetime and exactly one successful use. The
 * bridge's own listener stays loopback-only. X25519 kex, `IKM = Z ||
 * pairingCode`, a 117-byte `sc/v1` transcript.
 *
 * (REMOTE-CODE-PAIRING) CODE / REMOTE (§4.9). The same FOUR STEPS over the
 * existing tunnelled listener, but a DIFFERENT key exchange — SRP-6a — with an
 * 8-digit code the user reads off the desktop and types into the phone standing
 * in for the QR's 256-bit code. It exists because "both devices on the same
 * Wi-Fi" is not a requirement every network can satisfy: a network that blocks
 * phone -> PC traffic makes the QR flow physically impossible, and a fresh
 * install then has no way to receive the one secret it is missing.
 *
 * WHY IT IS SRP AND NOT THE QR FLOW WITH A SHORTER CODE. That is what an earlier
 * revision did — X25519 kex, `IKM = Z || code`, 8 digits instead of 32 bytes —
 * and it is unsound for a low-entropy secret on this hop. Cloudflare TERMINATES
 * the TLS, so `pPub`, `dPub` and `pairSalt` are all readable at the edge, and
 * anyone who can complete one kex of their own holds `Z`. With `Z` and a
 * captured `macPhone`, all 10^8 codes are testable OFFLINE at whatever rate the
 * attacker's hardware allows. Every online bound — one window, 120 s, three
 * strikes — becomes irrelevant the moment the check leaves the wire.
 *
 * SRP-6a is a password-authenticated key exchange precisely so that the
 * transcript is NOT an offline oracle. `A`, `B` and `pairSalt` do not let anyone
 * test a candidate code; testing one requires a FRESH ONLINE exchange, which is
 * what the bounds below actually bound. The desktop is the SERVER (it holds the
 * verifier), the phone is the CLIENT (it holds the typed digits).
 *
 * Hard rules this module exists to enforce:
 *  - K_dev is derived, never transmitted.
 *  - The pairing code is never logged, never written to a file, never in a
 *    diagnostic bundle. On the QR flow the desktop renders ONLY the QR;
 *    (PAIR-REF-ONLY) covers `qrUri` in its ENTIRETY, not just the `pc`
 *    parameter, because the URI carries the code in its fragment and a log line
 *    holding the URI holds the code — and a log file outlives the 120 s window
 *    the code's secrecy was bounded by. On the remote flow the code IS rendered
 *    as text (the user has to type it) but goes nowhere else, and NEITHER IT NOR
 *    ANY OFFLINE-CHECKABLE FUNCTION OF IT is ever transmitted: not the code, not
 *    `x`, not the verifier `v`. `pairingRef` exists so a caller that wants a
 *    traceable identifier has one it can log freely.
 *  - Three bad MACs burn the window.
 *  - One window at a time, of EITHER kind, process-wide.
 *  - On close, pairingCode / dPriv / PRK / K_conf_* are zeroed, and every
 *    candidate's derived keys with them.
 *
 * ---------------------------------------------------------------------------
 * Why a cleartext LAN hop is sound here (§4.7), restated so nobody "fixes" it
 * ---------------------------------------------------------------------------
 * `pPub` and `dPub` are public by construction. `K_dev` needs `Z` AND the
 * `pairingCode`, which exists only in the QR fragment. A passive observer has
 * neither. An ACTIVE MITM can obtain its own `Z` but not the code, so its `PRK`
 * is wrong, its `macPhone` fails, and nothing is stored. The one message
 * carrying a secret — step 4, with the Cloudflare service token — is sealed.
 * That is why there is no TLS on this hop and why adding a self-signed
 * certificate would add complexity without adding security.
 *
 * That argument survives on the QR flow because 256 bits is not guessable. It
 * does NOT transfer to 8 digits, which is the whole reason the remote flow uses
 * SRP instead of repeating it.
 *
 * WHAT IS HONESTLY WEAKER on the remote flow: 8 digits is ~26.6 bits, so the
 * code is GRINDABLE — ONLINE only, which is exactly what SRP buys, and bounded
 * by, in order: the endpoint answering 404 unless a window is open, one window
 * at a time, opened only by the person at the desktop, 120 s, single use, three
 * bad MACs burning it, five confirms per window, and per-source request caps.
 * An attacker gets at most three guesses out of 10^8 per window the user
 * deliberately opens. That is the whole of the security argument; it is written
 * down rather than implied so a future change that relaxes any one of those
 * bounds is visibly a change to the argument.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE CONFIRMATION MAC DOES **NOT** COVER — (PAIR-META-UNAUTHENTICATED)
 * ---------------------------------------------------------------------------
 * The §4.4 step-3 transcript is `"sc/v1" || pid || deviceId || pPub || dPub ||
 * pairSalt` — 117 bytes, and nothing else. The remote flow's is the same SHAPE
 * with SRP's values in place of the X25519 ones — `"sc/v3-srp" || pid ||
 * deviceId || PAD(A) || PAD(B) || pairSalt`, 825 bytes — so everything below
 * applies to BOTH.
 * `macPhone` therefore authenticates
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
 * `macPhone` over the identical bytes (there are cross-runtime differential
 * vectors pinning them). Closing it means extending the transcript — or echoing
 * the recorded metadata inside the SEALED step-4 body so the phone can detect a
 * rewrite — on BOTH sides at once. What this module does unilaterally is refuse
 * to let a second kex packet rewrite the metadata of a deviceId that already
 * has a candidate session (see `assertSameKexMetadata`), which removes the
 * after-the-fact rewrite; it does not remove the in-flight one.
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

import { randomInt } from "node:crypto";
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
	HKDF_LABEL_REMOTE_CONFIRM_DESKTOP,
	HKDF_LABEL_REMOTE_CONFIRM_PHONE,
	HKDF_LABEL_REMOTE_DEVICE,
	HKDF_LABEL_SEAL_S2C,
	LOG_PREFIX,
	PAIRING_ATTEMPTS_PER_WINDOW,
	PAIRING_BIND_HOST,
	PAIRING_CODE_BYTES,
	PAIRING_HKDF_SALT_PREFIX,
	PAIRING_MAX_BAD_MACS,
	PAIRING_PORT,
	PAIRING_REMOTE_BURN_MEMO_MS,
	PAIRING_REMOTE_CODE_DIGITS,
	PAIRING_REMOTE_HKDF_SALT_PREFIX,
	PAIRING_REMOTE_TRANSCRIPT_PREFIX,
	PAIRING_REMOTE_WIRE_VERSION,
	PAIRING_SALT_BYTES,
	PAIRING_SRP_IDENTITY,
	PAIRING_TRANSCRIPT_PREFIX,
	PAIRING_WINDOW_MS,
	PUBLIC_ORIGIN,
	REMOTE_PAIR_MAX_REQUESTS_PER_WINDOW,
	REMOTE_PAIR_MAX_SOURCES,
	REMOTE_PAIR_PATH_CONFIRM,
	REMOTE_PAIR_REQUESTS_PER_SOURCE,
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
	SRP_3072_SHA256,
	SrpError,
	srpAssertClientPublic,
	srpBytesToBigInt,
	srpComputeVerifier,
	srpComputeX,
	srpServerHandshake,
} from "./srp";
import {
	ENVELOPE_KIND_RESPONSE,
	type PairConfirmRequest,
	type PairConfirmResponse,
	type PairingErrorCode,
	type PairingWindowState,
	type PairKexRequest,
	type PairKexResponse,
	type ProtocolRange,
	type RemotePairBeginRequest,
	type RemotePairBeginResponse,
	type RemotePairConfirmRequest,
	type RemotePairKexRequest,
	type RemotePairKexResponse,
	type Surface,
} from "./types";

const MAC_BYTES = 32;
/** Everything after the ASCII prefix: pid || deviceId || pPub || dPub || pairSalt. */
const TRANSCRIPT_BODY_BYTES = 112;
/**
 * (REMOTE-CODE-PAIRING) The SRP transcript's body: pid || deviceId || PAD(A) ||
 * PAD(B) || pairSalt. 16 + 16 + 384 + 384 + 16.
 */
const SRP_TRANSCRIPT_BODY_BYTES = 816;
/** (REMOTE-CODE-PAIRING) `b`, per accepted kex candidate. 256 bits. */
const SRP_PRIVATE_EXPONENT_BYTES = 32;
export const MAX_PAIR_BODY_BYTES = 4 * 1024;
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
/**
 * (REMOTE-CODE-PAIRING) How many GENUINELY NEW SRP derivations one remote window
 * may perform, in total, for its whole life.
 *
 * `MAX_KEX_SESSIONS` does not bound this on its own: the candidate table EVICTS
 * rather than refuses, so a flood that keeps introducing deviceIds can keep
 * paying for fresh exponentiations forever. Each one is three 3072-bit modular
 * exponentiations on the main thread, from an unauthenticated public host, so
 * the count needs a ceiling that a window can only walk towards — never back.
 *
 * MONOTONE BY DESIGN: this counter is charged immediately before a new
 * `srpServerHandshake` and is never decremented, evicted or reset while the
 * window lives. A cached exact retry, a refused rewrite, a `begin` flood and
 * every `confirm` cost nothing here, so the real phone's own kex is charged once
 * and 64 leaves it an enormous margin over the one derivation it needs.
 */
const MAX_KEX_COMPUTATIONS_PER_WINDOW = 64;
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
 * What both kinds of window carry. `PairingWindowState` (types.ts) is the
 * wire-visible subset; this adds the bookkeeping the handlers need and still
 * carries NO secret, so the two flows' secrets live only in the interfaces
 * below and nothing generic can reach them.
 */
export interface PairingSessionCommon extends PairingWindowState {
	/**
	 * (REMOTE-CODE-PAIRING) Which exchange this window is running. It selects the
	 * key schedule, the transcript prefix, the step-4 AAD path and the wire error
	 * vocabulary — everything the two flows do not share.
	 */
	profile: PairingProfile;
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

/**
 * The QR/LAN window. `dPriv` and `pairingCode` may never be serialised, which is
 * why they are here and not on `PairingWindowState`.
 *
 * `kind` is the discriminant the compiler narrows on, which is the whole value
 * of splitting these two types: it refuses to hand SRP code a `dPriv` or LAN
 * code a verifier. It is set at the one construction site each.
 */
export interface LanPairingSessionState extends PairingSessionCommon {
	kind: "lan";
	/** 32 raw bytes. Zeroed on close. NEVER rendered, logged, or persisted. */
	pairingCode: Uint8Array;
	dPub: Uint8Array;
	/** 32 raw bytes. Zeroed on close. Never leaves this process. */
	dPriv: Uint8Array;
}

/**
 * (REMOTE-CODE-PAIRING) The remote SRP window.
 *
 * It holds the VERIFIER and not the code's bytes: `v = g^x mod N` is everything
 * the server side of SRP needs, the displayed digits live only in the handle's
 * closure for the dialog to render, and `x` is computed once at open and dropped.
 * There is no X25519 key pair here at all — per-candidate `b`/`B` replace it, and
 * they live on the candidate rather than the window precisely so they cannot be
 * reused across two devices.
 */
export interface RemotePairingSessionState extends PairingSessionCommon {
	kind: "remote";
	/**
	 * SRP-6a's `v = g^x mod N`, derived once per window from the displayed code
	 * and `pairSalt`.
	 *
	 * HONEST LIMIT: a `bigint` cannot be overwritten and its allocation cannot be
	 * reached from JS, so `close()` drops the reference (assigning `0n`) and the
	 * engine keeps the old value until it collects it. That is the same limitation
	 * the immutable `code` string has and it is stated rather than papered over.
	 * It is not load-bearing: the verifier is not the code, and recovering the code
	 * from it is the same offline dictionary attack SRP is designed to make the
	 * ONLY option — which is why the verifier never leaves this process.
	 */
	verifier: bigint;
	/**
	 * (REMOTE-CODE-PAIRING) Per remote source: total `/v1/pair/*` requests this
	 * window. REMOTE ONLY — it lives here rather than on the common state because
	 * a LAN window has no use for it: the LAN hop is bounded by `kexSourceCounts`
	 * and by being a socket that exists for 120 s.
	 *
	 * It exists because the remote hop's "source" is whatever Cloudflare says the
	 * client IP is, and one source can send a great many well-formed requests that
	 * never reach a MAC check. Exceeding the cap refuses THAT source and only that
	 * source; the real phone keeps its full allowance.
	 */
	remoteRequestCounts: Map<string, number>;
	/**
	 * (REMOTE-CODE-PAIRING) Total `/v1/pair/*` requests this window has ADMITTED,
	 * across every source. MONOTONE — see `REMOTE_PAIR_MAX_REQUESTS_PER_WINDOW`.
	 */
	remoteRequests: number;
	/**
	 * (REMOTE-CODE-PAIRING) New SRP derivations performed by this window, ever.
	 * MONOTONE — see `MAX_KEX_COMPUTATIONS_PER_WINDOW`.
	 */
	kexComputations: number;
}

export type PairingSessionState =
	| LanPairingSessionState
	| RemotePairingSessionState;

interface KexSessionCommon {
	deviceId: string;
	deviceIdBytes: Uint8Array;
	label: string;
	surface: Surface;
	appVersion: string;
	protocol: ProtocolRange;
	createdAtMs: number;
	/** Remote address that introduced this candidate. Diagnostics + throttling. */
	sourceKey: string;
}

interface LanKexSession extends KexSessionCommon {
	kind: "lan";
	pPub: Uint8Array;
}

/**
 * (REMOTE-CODE-PAIRING) One SRP candidate, across the three messages.
 *
 * `begin` creates it with metadata only. `kex` fills the three nullable fields
 * in ONE step and never again: `b`, `B`, `u` and `S` are all minted there from
 * this candidate's own `A`, the keys are derived, and `b` and `S` are dropped
 * immediately. What survives is the two padded public values — transcript
 * inputs, and public anyway — and the derived keys. `confirm` reads them and
 * nothing else.
 *
 * The three fields are nullable TOGETHER and are only ever written together, so
 * "this candidate has completed its kex" is one question with one answer. Doing
 * the derivation at kex is what makes "fresh `b` per candidate, never reused"
 * checkable rather than hoped for, and it puts `pair_bad_key_agreement` at the
 * step where the bad value actually arrived.
 */
interface RemoteKexSession extends KexSessionCommon {
	kind: "remote";
	/** `PAD(A)`, 384 bytes, exactly as it arrived. `null` until `kex`. */
	clientPublic: Uint8Array | null;
	/** `PAD(B)`, 384 bytes. This candidate's ONLY B; never reused for another. */
	serverPublic: Uint8Array | null;
	/** Zeroed when this candidate is replaced, evicted, expired or closed. */
	keys: PairingKeys | null;
}

type KexSession = LanKexSession | RemoteKexSession;

/**
 * What EVERY pairing window exposes, whichever way in it is. The secret-bearing
 * member — `qrUri` on the QR flow, `code` on the remote flow — is deliberately
 * NOT here: a caller that only wants to close a window, count it down or log it
 * should not be handed a type that can reach the secret at all.
 */
export interface PairingWindowHandleBase {
	readonly kind: PairingKind;
	/**
	 * (PAIR-REF-ONLY) A non-secret, non-reversible reference to THIS window, safe
	 * to log and to correlate against.
	 *
	 * It is the pairing id (`pid`): 16 independent random bytes that are already
	 * transmitted in cleartext on the pairing hop by design, and that carry no
	 * information about `pairingCode` — the two are drawn from separate CSPRNG
	 * calls and are combined nowhere. Publishing it reveals nothing that an
	 * observer of the wire does not already have.
	 */
	pairingRef: string;
	expiresAtMs: number;
	/**
	 * The window is over — it expired, it was consumed by a successful pairing,
	 * or someone closed it. A holder of this handle CANNOT infer that from
	 * `expiresAtMs` (single-use closes early) and must not have to provoke the
	 * secret getter's 410 to find out, so the fact is stated. Without it a
	 * caller that remembers the handle refuses to open the next window forever.
	 */
	readonly closed: boolean;
	/**
	 * (PAIR-REF-ONLY) Structural containment for the accidental leak: passing the
	 * handle itself to a logger, an error serialiser or `JSON.stringify` yields
	 * the reference and never the secret. It cannot stop a caller that reaches
	 * for `.qrUri` / `.code` explicitly — nothing can — but it removes the whole
	 * class of leaks where the secret travels inside an object somebody logged
	 * for other reasons.
	 */
	toJSON(): {
		kind: PairingKind;
		pairingRef: string;
		expiresAtMs: number;
		closed: boolean;
	};
	close(): Promise<void>;
}

export interface PairingWindowHandle extends PairingWindowHandleBase {
	readonly kind: "lan";
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
}

/**
 * (REMOTE-CODE-PAIRING) The remote window's handle.
 */
export interface RemotePairingWindowHandle extends PairingWindowHandleBase {
	readonly kind: "remote";
	/**
	 * The 8 decimal digits, unseparated ("12345678"). The UI groups them as
	 * `1234-5678` for reading aloud; the grouping is presentation and never
	 * reaches the key schedule.
	 *
	 * (PAIR-REF-ONLY) SECRET-BEARING FOR 120 SECONDS, and MORE fragile than the
	 * QR URI rather than less: 8 digits is ~26.6 bits, so a copy that outlives
	 * its window in a log file is a code someone can simply try. It has exactly
	 * one legitimate destination — the desktop dialog that renders it for the
	 * user to type — and MUST NOT be logged, persisted, put in an error message,
	 * or included in a diagnostic bundle. Log `pairingRef` instead.
	 */
	code: string;
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
// §4.4 / §4.9 — the two key schedules, described once each
// ---------------------------------------------------------------------------

/** Which way in a window was opened. One window of EITHER kind at a time. */
export type PairingKind = "lan" | "remote";

/**
 * (REMOTE-CODE-PAIRING) Everything that DIFFERS between the QR/LAN exchange and
 * the remote 8-digit exchange, in one object, so the difference is a data
 * difference and not two copies of the exchange.
 *
 * DOMAIN SEPARATION IS THE WHOLE JOB HERE. Every string below is distinct
 * between the two profiles, so a key derived from a 256-bit QR code and a key
 * derived from an 8-digit typed code cannot collide even if an implementation
 * confuses the flows — and, more importantly for review, the LAN profile's
 * strings are the ORIGINAL literals, byte for byte, so the QR flow's wire bytes
 * are provably unchanged (there are golden vectors pinning them).
 *
 * What is deliberately NOT in here: `HKDF_LABEL_SEAL_S2C` and its siblings. The
 * steady-state directional keys hang off `K_dev` and are the same in both flows
 * — a device paired either way speaks one protocol afterwards.
 */
export interface PairingProfile {
	/** Prefixed to `pairSalt` to form the HKDF-Extract salt. */
	hkdfSaltPrefix: string;
	/** `info` prefix for K_dev; the raw `pid || deviceId` bytes follow it. */
	deviceLabel: string;
	confirmPhoneLabel: string;
	confirmDesktopLabel: string;
	/** The PATH bound into the step-4 response AAD. */
	confirmPath: string;
}

export const LAN_PAIRING_PROFILE: PairingProfile = {
	hkdfSaltPrefix: PAIRING_HKDF_SALT_PREFIX,
	deviceLabel: HKDF_LABEL_DEVICE,
	confirmPhoneLabel: HKDF_LABEL_CONFIRM_PHONE,
	confirmDesktopLabel: HKDF_LABEL_CONFIRM_DESKTOP,
	confirmPath: PAIR_PATH_CONFIRM,
};

export const REMOTE_PAIRING_PROFILE: PairingProfile = {
	hkdfSaltPrefix: PAIRING_REMOTE_HKDF_SALT_PREFIX,
	deviceLabel: HKDF_LABEL_REMOTE_DEVICE,
	confirmPhoneLabel: HKDF_LABEL_REMOTE_CONFIRM_PHONE,
	confirmDesktopLabel: HKDF_LABEL_REMOTE_CONFIRM_DESKTOP,
	confirmPath: REMOTE_PAIR_PATH_CONFIRM,
};

// ---------------------------------------------------------------------------
// §4.4 step 3 — the transcript
// ---------------------------------------------------------------------------

/**
 * §4.4 step 3 — `prefix || pid || deviceId || pPub || dPub || pairSalt`, fixed
 * order, fixed lengths. 117 bytes, QR/LAN ONLY.
 *
 * The remote flow has its own builder (`buildSrpPairingTranscript`) rather than
 * a widened version of this one, because widening it would mean relaxing the
 * length assertions that are the reason it is safe to concatenate without
 * separators. This function's bytes are frozen and pinned by golden vectors.
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

	// HARDCODED, not a parameter: this function's output is byte-frozen, and a
	// caller-supplied prefix would make that a promise about the caller.
	const prefix = ascii(PAIRING_TRANSCRIPT_PREFIX);
	return concatFixed(
		[prefix, input.pid, input.deviceId, input.pPub, input.dPub, input.pairSalt],
		prefix.length + TRANSCRIPT_BODY_BYTES,
	);
}

/**
 * (REMOTE-CODE-PAIRING) The SRP flow's step-3 transcript:
 * `"sc/v3-srp" || pid(16) || deviceId(16) || PAD(A)(384) || PAD(B)(384) ||
 * pairSalt(16)` — 825 bytes.
 *
 * The SAME SHAPE as the QR flow's with SRP's public values in place of the
 * X25519 ones, so both key confirmations authenticate the same facts: the key
 * material and the two peer identities. It is deliberately NOT RFC 2945's
 * `M1`/`M2`, which bind only the SRP quantities and would leave `pid` and
 * `deviceId` unauthenticated — the desktop would then have no cryptographic
 * link between the exchange it ran and the device record it is about to write.
 *
 * The prefix differs from the QR flow's, so a transcript from one flow can never
 * be a valid transcript in the other; the padded widths are asserted rather than
 * assumed, which is what makes the separator-free concatenation unambiguous.
 */
export function buildSrpPairingTranscript(input: {
	pid: Uint8Array;
	deviceId: Uint8Array;
	/** `PAD(A)`, 384 bytes. */
	clientPublic: Uint8Array;
	/** `PAD(B)`, 384 bytes. */
	serverPublic: Uint8Array;
	pairSalt: Uint8Array;
}): Uint8Array {
	assertLength(input.pid, WIRE_ID_BYTES);
	assertLength(input.deviceId, WIRE_ID_BYTES);
	assertLength(input.clientPublic, SRP_3072_SHA256.widthBytes);
	assertLength(input.serverPublic, SRP_3072_SHA256.widthBytes);
	assertLength(input.pairSalt, PAIRING_SALT_BYTES);

	// HARDCODED for the same reason as the QR builder's: the domain separation
	// between the two flows is a property of these two functions, not of whoever
	// calls them.
	const prefix = ascii(PAIRING_REMOTE_TRANSCRIPT_PREFIX);
	return concatFixed(
		[
			prefix,
			input.pid,
			input.deviceId,
			input.clientPublic,
			input.serverPublic,
			input.pairSalt,
		],
		prefix.length + SRP_TRANSCRIPT_BODY_BYTES,
	);
}

function ascii(value: string): Uint8Array {
	return new Uint8Array(Buffer.from(value, "ascii"));
}

/**
 * The one concatenation both transcripts use: fixed-width parts, no separators,
 * and a total that must land exactly on `expectedBytes`. Every part's length is
 * asserted by the caller before it gets here, so a mismatch means the caller's
 * own arithmetic is wrong — hence a 500 rather than a wire error.
 */
function concatFixed(
	parts: readonly Uint8Array[],
	expectedBytes: number,
): Uint8Array {
	const out = new Uint8Array(expectedBytes);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	if (offset !== expectedBytes) {
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
 * §3.1, QR/LAN ONLY. `IKM = Z || pairingCode` is what makes the exchange sound
 * against an active MITM: the attacker can produce its own `Z` but has no
 * `pairingCode`, so its `PRK` — and therefore every key below — is wrong. That
 * argument rests on the code being 256 random bits; it does NOT carry over to 8
 * typed digits, which is why the remote flow uses SRP and
 * `deriveSrpPairingKeys` instead of this function with a shorter code.
 *
 * `pid` and `deviceId` contribute their RAW 16 BYTES to the K_dev `info`, not
 * their base64url text. That is the convention the Android client implements and
 * the one the §4.4 transcript already uses; the two sides must agree exactly or
 * every derived key differs and pairing fails as `pair_bad_mac` forever. See the
 * INTEROP NOTE in `crypto.ts`.
 */
export function derivePairingKeys(input: {
	dPriv: Uint8Array;
	pPub: Uint8Array;
	pairingCode: Uint8Array;
	pairSalt: Uint8Array;
	pidBytes: Uint8Array;
	deviceIdBytes: Uint8Array;
	profile: PairingProfile;
}): PairingKeys {
	assertLength(input.pidBytes, WIRE_ID_BYTES);
	assertLength(input.deviceIdBytes, WIRE_ID_BYTES);

	// Rejects an all-zero shared secret (small-order peer point) inside x25519().
	const z = x25519(input.dPriv, input.pPub);

	const ikm = new Uint8Array(z.length + input.pairingCode.length);
	ikm.set(z, 0);
	ikm.set(input.pairingCode, z.length);

	const prk = hkdfExtract(buildHkdfSalt(input.profile, input.pairSalt), ikm);
	zero(z);
	zero(ikm);

	return expandPairingKeys(
		prk,
		input.profile,
		input.pidBytes,
		input.deviceIdBytes,
	);
}

/**
 * (REMOTE-CODE-PAIRING) §4.9's key schedule, hanging off SRP's shared secret.
 *
 * `IKM = PAD(S)` — the FULL-WIDTH 384-byte encoding, never a minimal one. A
 * minimal encoding would make the PRK depend on how many leading zero bytes `S`
 * happened to have, so roughly one exchange in 256 would derive different keys
 * on the two sides and fail as `pair_code_wrong` with no diagnostic.
 *
 * `sharedSecret` is ZEROED here, unconditionally, because this is the last place
 * it is needed and leaving that to a caller is a decision somebody eventually
 * gets wrong.
 */
export function deriveSrpPairingKeys(input: {
	/** `PAD(S)`, 384 bytes. ZEROED by this function before it returns. */
	sharedSecret: Uint8Array;
	pairSalt: Uint8Array;
	pidBytes: Uint8Array;
	deviceIdBytes: Uint8Array;
	profile: PairingProfile;
}): PairingKeys {
	assertLength(input.pidBytes, WIRE_ID_BYTES);
	assertLength(input.deviceIdBytes, WIRE_ID_BYTES);
	assertLength(input.sharedSecret, SRP_3072_SHA256.widthBytes);

	try {
		const prk = hkdfExtract(
			buildHkdfSalt(input.profile, input.pairSalt),
			input.sharedSecret,
		);
		return expandPairingKeys(
			prk,
			input.profile,
			input.pidBytes,
			input.deviceIdBytes,
		);
	} finally {
		zero(input.sharedSecret);
	}
}

/** `ascii(prefix) || pairSalt`. One builder, so the two flows cannot drift. */
function buildHkdfSalt(
	profile: PairingProfile,
	pairSalt: Uint8Array,
): Uint8Array {
	const prefix = Buffer.from(profile.hkdfSaltPrefix, "ascii");
	const salt = new Uint8Array(prefix.length + pairSalt.length);
	salt.set(prefix, 0);
	salt.set(pairSalt, prefix.length);
	return salt;
}

/**
 * The three Expands, identical in both flows once a PRK exists. `profile`
 * selects the label set; passing the wrong one produces a completely different
 * key schedule, which is the intended failure mode — the MAC does not verify and
 * nothing is stored.
 */
function expandPairingKeys(
	prk: Uint8Array,
	profile: PairingProfile,
	pidBytes: Uint8Array,
	deviceIdBytes: Uint8Array,
): PairingKeys {
	return {
		prk,
		deviceKey: hkdfExpandInfo(
			prk,
			hkdfInfoWithSuffix(profile.deviceLabel, pidBytes, deviceIdBytes),
			KEY_BYTES,
		),
		confirmPhone: hkdfExpandLabel(prk, profile.confirmPhoneLabel, KEY_BYTES),
		confirmDesktop: hkdfExpandLabel(
			prk,
			profile.confirmDesktopLabel,
			KEY_BYTES,
		),
	};
}

/**
 * (REMOTE-CODE-PAIRING) Wipes EVERY key a candidate holds, `deviceKey` included.
 *
 * Every way a candidate leaves the table — replaced, evicted, expired, burned,
 * closed, or consumed by a successful pairing — is a path where nothing will
 * ever use those keys again, and they all come here.
 *
 * TEST SEAM for the wipe, and the ONLY way it is observable.
 *
 * Zeroization is the kind of property that is trivially claimed in a comment and
 * silently lost in a refactor — a `Map.delete` looks exactly like a wipe at the
 * call site, and nothing downstream ever notices the difference. So every wipe
 * reports itself here, and the tests assert that every path which drops a
 * candidate goes through it.
 *
 * IT HANDS OUT NO KEY MATERIAL. The report is made AFTER the buffer has been
 * overwritten, carrying the now-zero buffer plus the one bit the observer could
 * not otherwise recover: whether it held anything before. Arming this cannot
 * leak a key, and production never arms it.
 */
export interface KexWipeReport {
	/** The buffer, ALREADY overwritten. */
	buffer: Uint8Array;
	/** Whether it was non-zero immediately before being overwritten. */
	wasLive: boolean;
}

let kexWipeObserver: ((report: KexWipeReport) => void) | null = null;

export function setKexWipeObserverForTest(
	observer: ((report: KexWipeReport) => void) | null,
): void {
	kexWipeObserver = observer;
}

function wipe(buffer: Uint8Array): void {
	// The liveness scan exists only to give the observer the one bit it cannot
	// recover after the fact. Production never arms the observer, so production
	// never pays for the scan.
	if (kexWipeObserver === null) {
		zero(buffer);
		return;
	}
	const wasLive = buffer.some((byte) => byte !== 0);
	zero(buffer);
	kexWipeObserver({ buffer, wasLive });
}

/**
 * Overwrites every key in a set, `deviceKey` included. THE one wipe: a caller
 * that needs a key set gone says so once, and cannot forget a field.
 */
function wipeAllPairingKeys(keys: PairingKeys): void {
	wipe(keys.prk);
	wipe(keys.confirmPhone);
	wipe(keys.confirmDesktop);
	wipe(keys.deviceKey);
}

function zeroKexSession(session: KexSession): void {
	if (session.kind !== "remote" || session.keys === null) return;
	wipeAllPairingKeys(session.keys);
	session.keys = null;
}

/** Wipes and drops every candidate. The one way `kexSessions` is emptied. */
function clearKexSessions(state: PairingSessionState): void {
	for (const session of state.kexSessions.values()) {
		zeroKexSession(session);
	}
	state.kexSessions.clear();
}

// ---------------------------------------------------------------------------
// §4.4 step 1 -> step 2
// ---------------------------------------------------------------------------

/**
 * step 1 -> step 2, QR/LAN. Cleartext JSON on the LAN hop; both values are
 * public.
 *
 * `sourceKey` is the remote address the packet arrived from. It is REQUIRED, not
 * optional: it is the only thing that bounds how fast one host can churn the
 * candidate table, and a caller that cannot supply it is a caller whose socket
 * has already gone away.
 */
export function handleKex(
	state: LanPairingSessionState,
	request: PairKexRequest,
	sourceKey: string,
): PairKexResponse {
	assertWindowOpen(state);
	assertWireVersion(request.v, 1);
	assertSourceKey(sourceKey);
	// (PAIR-ATTEMPT-ORDER) Nothing is charged before the request has proved it
	// knows the QR.
	assertPidMatches(state, request.pid);

	const pPub = decodeExact(request.pPub, X25519_KEY_BYTES);
	const metadata = parseKexMetadata(request);

	const existing = state.kexSessions.get(request.deviceId);
	if (existing !== undefined) {
		// (PAIR-JUNK-SURVIVAL) A retransmit — which a lossy LAN produces on its own
		// and which anyone who watched the wire can also produce — changes nothing
		// and therefore costs nothing. This is the whole point: replaying an
		// observed kex must not be able to spend anything the real phone needs.
		assertSameKexMetadata(existing, metadata);
		if (existing.kind !== "lan" || !constantTimeEquals(existing.pPub, pPub)) {
			refuseCandidateRewrite("different key material");
		}
		return lanKexResponse(state);
	}

	chargeKexIntroduction(state, sourceKey);
	state.kexSessions.set(request.deviceId, {
		kind: "lan",
		deviceId: request.deviceId,
		deviceIdBytes: metadata.deviceIdBytes,
		pPub,
		...metadata.described,
		createdAtMs: Date.now(),
		sourceKey,
	});
	evictOldestKexSessionsIfFull(state);

	return lanKexResponse(state);
}

/**
 * (REMOTE-CODE-PAIRING) step 0 — `POST /v1/pair/begin`.
 *
 * It introduces a device and hands back `pid` and `pairSalt`, and that is ALL it
 * does: no `A` has arrived yet, so there is no modular exponentiation here and a
 * flood of `begin` requests buys an attacker nothing but the per-source counters
 * it is already spending.
 *
 * There is no pid check, and it is an absence by construction rather than a
 * relaxation: the phone has no pid before this call (it never scanned anything)
 * and the desktop has exactly one pairing window process-wide, so there is
 * nothing for a selector to select. Nothing is authenticated at this step in
 * EITHER flow. What authenticates is `macPhone` at step 3b, which needs the code.
 *
 * IDEMPOTENT for a deviceId that already has a candidate: the same `pid` and
 * `pairSalt` come back and no new introduction is charged, so a retry over a
 * flaky link costs nothing. (PAIR-META-UNAUTHENTICATED) Metadata that DIFFERS is
 * refused and the first candidate stands.
 */
export function handleRemoteBegin(
	state: RemotePairingSessionState,
	request: RemotePairBeginRequest,
	sourceKey: string,
): RemotePairBeginResponse {
	assertWindowOpen(state);
	assertWireVersion(request.v, PAIRING_REMOTE_WIRE_VERSION);
	assertSourceKey(sourceKey);

	const metadata = parseKexMetadata(request);

	const existing = state.kexSessions.get(request.deviceId);
	if (existing !== undefined) {
		assertCandidateSource(existing, sourceKey);
		assertSameKexMetadata(existing, metadata);
		return remoteBeginResponse(state);
	}

	chargeKexIntroduction(state, sourceKey);
	state.kexSessions.set(request.deviceId, {
		kind: "remote",
		deviceId: request.deviceId,
		deviceIdBytes: metadata.deviceIdBytes,
		...metadata.described,
		createdAtMs: Date.now(),
		sourceKey,
		clientPublic: null,
		serverPublic: null,
		keys: null,
	});
	evictOldestKexSessionsIfFull(state);

	return remoteBeginResponse(state);
}

/**
 * (REMOTE-CODE-PAIRING) step 1 — `POST /v1/pair/kex`. The SRP exchange, run in
 * full, once per candidate.
 *
 * ORDER IS THE POINT OF THIS FUNCTION. A 3072-bit modular exponentiation is the
 * most expensive thing an unauthenticated caller can make this process do, and
 * the pairing host is public, so everything cheap happens first: the window
 * check, the version check, the per-source charge (already spent by the
 * endpoint wrapper before this is reached), the pid check, the candidate lookup,
 * the retry short-circuit and the canonical range check on `A`. Only a request
 * that has passed all of them reaches `srpServerHandshake`.
 *
 * That leaves the number of exponentiations one window can be made to perform
 * bounded twice over: a candidate derives exactly once, an identical retry
 * replays the cached answer, and a different `A` is refused outright — and on
 * top of that, `MAX_KEX_COMPUTATIONS_PER_WINDOW` is a MONOTONE ceiling on new
 * derivations for the window's whole life, which `MAX_KEX_SESSIONS` alone cannot
 * give because the candidate table evicts rather than refuses.
 *
 * `b`, `S` and the transcript inputs are handled the way the design requires:
 * `b` is fresh for this candidate and is dropped when `srpServerHandshake`
 * returns, `S` is zeroed inside `deriveSrpPairingKeys`, and what survives is the
 * two padded PUBLIC values plus the derived keys.
 */
export function handleRemoteKex(
	state: RemotePairingSessionState,
	request: RemotePairKexRequest,
	sourceKey: string,
): RemotePairKexResponse {
	assertWindowOpen(state);
	assertWireVersion(request.v, PAIRING_REMOTE_WIRE_VERSION);
	assertSourceKey(sourceKey);
	assertPidMatches(state, request.pid);

	const session = requireRemoteCandidate(state, request.deviceId);
	assertCandidateSource(session, sourceKey);
	const clientPublic = decodeClientPublic(request.A);

	if (session.clientPublic !== null) {
		// An EXACT retry replays the answer this candidate already committed to.
		// Anything else is somebody trying to move a candidate onto key material
		// of their choosing after the fact; the first `A` stands, exactly as the
		// first metadata does.
		if (!constantTimeEquals(session.clientPublic, clientPublic)) {
			refuseCandidateRewrite("a different SRP client public value");
		}
		if (session.serverPublic === null || session.keys === null) {
			throw new PairingError(500, "unknown");
		}
		return remoteKexResponse(session.serverPublic);
	}

	chargeKexComputation(state);
	const privateExponent = randomBytes(SRP_PRIVATE_EXPONENT_BYTES);
	let handshake: { serverPublic: Uint8Array; sharedSecret: Uint8Array };
	try {
		handshake = srpServerHandshake({
			group: SRP_3072_SHA256,
			verifier: state.verifier,
			clientPublic,
			privateExponent,
		});
	} catch (error) {
		if (error instanceof SrpError) {
			// The one refusal on this hop that is NOT about the code. A phone told
			// "wrong code" here would have its user retyping correct digits forever.
			console.warn(
				`${LOG_PREFIX} remote pairing SRP key agreement refused (${error.message}) pairingRef=${state.pid}`,
			);
			throw new PairingError(400, "pair_bad_key_agreement");
		}
		throw error;
	} finally {
		zero(privateExponent);
	}

	// COMMIT ALL THREE OR NONE. Deriving first and assigning afterwards is the
	// difference between a candidate that is either untouched or complete and one
	// that can be left holding an `A` and a `B` with no keys behind them — a state
	// in which the retry short-circuit above would hand back a `B` this process
	// can no longer confirm against, and the phone would fail at step 3b with a
	// `pair_code_wrong` that has nothing to do with the code.
	// `sharedSecret` is zeroed inside this call, whatever it does.
	const keys = deriveSrpPairingKeys({
		sharedSecret: handshake.sharedSecret,
		pairSalt: state.pairSalt,
		pidBytes: base64UrlDecode(state.pid),
		deviceIdBytes: session.deviceIdBytes,
		profile: state.profile,
	});
	session.clientPublic = clientPublic;
	session.serverPublic = handshake.serverPublic;
	session.keys = keys;

	return remoteKexResponse(session.serverPublic);
}

/**
 * A `kex` or `confirm` for a deviceId that never ran `begin`, or whose candidate
 * has since been evicted.
 *
 * (PAIR-EVICTION-HONEST) Remote-only, and `pair_unknown_candidate` rather than
 * `pair_wrong_peer`: the window itself may still be open and usable, so the true
 * advice is "repeat begin", not "something else answered instead of the desktop".
 * `evictOldestKexSessionsIfFull` makes this reachable without any attack on the
 * phone at all. The missing candidate is itself the proof that `begin` must be
 * repeated, so nothing is tombstoned to remember it.
 *
 * The BODY carries the meaning, not the status: the phone matches this code and
 * never the `400`, since a public edge can emit a 4xx of its own and must not be
 * able to tell a user their code is still good.
 *
 * `pair_wrong_peer` is kept for the case that genuinely earns it — a deviceId that
 * EXISTS and is being rewritten. The LAN flow's equivalent path keeps
 * `pair_wrong_peer`, because v1 is frozen.
 *
 * Reached only AFTER the window, wire version, source and `pid` have all checked
 * out, so a wrong `pid` or a wrong source can never be reported as this.
 *
 * (PAIR-JUNK-SURVIVAL) It is NOT charged against the 3-strike anti-grind budget
 * or the confirm budget: no MAC was verified and no code was guessed, so
 * treating it as an attempt would let crypto-free packets burn a 120 s window on
 * demand.
 */
function requireRemoteCandidate(
	state: RemotePairingSessionState,
	deviceId: unknown,
): RemoteKexSession {
	if (typeof deviceId !== "string") {
		// A malformed body, not a lost candidate — no correct client reaches this,
		// and telling one to start again would be as untrue as telling it a peer
		// answered for it.
		noteUnattributedAttempt(state);
		throw new PairingError(400, "unknown");
	}
	const session = state.kexSessions.get(deviceId);
	if (session === undefined || session.kind !== "remote") {
		noteUnattributedAttempt(state);
		throw new PairingError(400, "pair_unknown_candidate");
	}
	return session;
}

function assertWireVersion(version: unknown, expected: number): void {
	if (version !== expected) {
		throw new PairingError(400, "pair_version_unsupported");
	}
}

/**
 * (PAIR-JUNK-SURVIVAL) The source is REQUIRED, not optional: it is the only
 * thing that bounds how fast one host can churn the candidate table, and a
 * caller that cannot supply it is a caller we cannot throttle.
 */
function assertSourceKey(sourceKey: string): void {
	if (typeof sourceKey !== "string" || sourceKey.length === 0) {
		throw new PairingError(400, "unknown");
	}
}

interface KexMetadata {
	deviceIdBytes: Uint8Array;
	described: {
		label: string;
		surface: Surface;
		appVersion: string;
		protocol: ProtocolRange;
	};
}

/** The four (PAIR-META-UNAUTHENTICATED) fields plus the deviceId, validated. */
function parseKexMetadata(request: {
	deviceId: string;
	label: unknown;
	surface: unknown;
	appVersion: unknown;
	protocol: unknown;
}): KexMetadata {
	return {
		deviceIdBytes: decodeExact(request.deviceId, WIRE_ID_BYTES),
		described: {
			label: assertLabel(request.label),
			surface: assertSurface(request.surface),
			appVersion: assertAppVersion(request.appVersion),
			protocol: assertProtocolRange(request.protocol),
		},
	};
}

/**
 * (PAIR-META-UNAUTHENTICATED) A packet that reuses a deviceId but carries
 * DIFFERENT metadata is not a retransmit. A deviceId is 128 phone-minted random
 * bits, so a collision is not a thing that happens; somebody is rewriting
 * another device's candidate. Refuse, and keep the first one — the alternative,
 * last-write-wins, hands an observer a free edit on the label the desktop is
 * about to store.
 */
function assertSameKexMetadata(
	existing: KexSession,
	incoming: KexMetadata,
): void {
	const { label, surface, appVersion, protocol } = incoming.described;
	if (
		existing.label !== label ||
		existing.surface !== surface ||
		existing.appVersion !== appVersion ||
		existing.protocol.min !== protocol.min ||
		existing.protocol.max !== protocol.max
	) {
		refuseCandidateRewrite("different metadata");
	}
}

function refuseCandidateRewrite(what: string): never {
	console.warn(
		`${LOG_PREFIX} pairing request reused a deviceId with ${what} — refused, the first candidate stands`,
	);
	throw new PairingError(400, "pair_wrong_peer");
}

/**
 * A candidate belongs to the address that opened it, for its whole life.
 *
 * Without this a second caller who learns a deviceId — which travels in the
 * clear — can drive somebody else's candidate: spend its confirm attempts,
 * burn the window on three wrong MACs, or race the real phone's `begin` with
 * different metadata. None of that gets them the code, but all of it is a
 * denial of service against a window the user is standing in front of, and it
 * costs one comparison to deny.
 */
function assertCandidateSource(session: KexSession, sourceKey: string): void {
	if (session.sourceKey !== sourceKey) {
		refuseCandidateRewrite("a different source address");
	}
}

/**
 * `A` off the wire: canonical base64url, EXACTLY the group width, and IN RANGE.
 *
 * Every failure here is `pair_bad_key_agreement` rather than the generic
 * `unknown` that `decodeExact` gives the QR flow's fields. A wrong-width `A`, a
 * non-canonical one and an out-of-range one are the same mistake wearing
 * different clothes — a public value this server cannot use — and the phone
 * that has to act on the answer should not have to guess which of its two
 * failure modes it is in.
 *
 * The RANGE check lives here, not inside `srpServerHandshake`, because of where
 * the derivation charge sits. `srpServerHandshake` asserts it too — and must keep
 * doing so, since it is the arithmetic's own precondition — but by then
 * `chargeKexComputation` has already been spent. A width-correct degenerate `A`
 * (`PAD(1)`, `PAD(N-1)`, `PAD(0)`) is free to produce and would have burned one of
 * the window's 64 new derivations per packet without ever performing one. Rejecting
 * it here makes the order validate -> charge -> derive.
 */
function decodeClientPublic(value: unknown): Uint8Array {
	if (typeof value !== "string") {
		throw new PairingError(400, "pair_bad_key_agreement");
	}
	let decoded: Uint8Array;
	try {
		decoded = base64UrlDecode(value);
	} catch {
		throw new PairingError(400, "pair_bad_key_agreement");
	}
	if (decoded.length !== SRP_3072_SHA256.widthBytes) {
		throw new PairingError(400, "pair_bad_key_agreement");
	}
	try {
		srpAssertClientPublic(SRP_3072_SHA256, srpBytesToBigInt(decoded));
	} catch (error) {
		if (error instanceof SrpError) {
			throw new PairingError(400, "pair_bad_key_agreement");
		}
		throw error;
	}
	return decoded;
}

function lanKexResponse(state: LanPairingSessionState): PairKexResponse {
	return {
		v: 1,
		pid: state.pid,
		dPub: base64UrlEncode(state.dPub),
		pairSalt: base64UrlEncode(state.pairSalt),
		serverTimeMs: Date.now(),
	};
}

function remoteBeginResponse(
	state: RemotePairingSessionState,
): RemotePairBeginResponse {
	return {
		v: PAIRING_REMOTE_WIRE_VERSION,
		pid: state.pid,
		pairSalt: base64UrlEncode(state.pairSalt),
		serverTimeMs: Date.now(),
	};
}

function remoteKexResponse(serverPublic: Uint8Array): RemotePairKexResponse {
	return {
		v: PAIRING_REMOTE_WIRE_VERSION,
		B: base64UrlEncode(serverPublic),
		serverTimeMs: Date.now(),
	};
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
	chargePerSource(state.kexSourceCounts, sourceKey, {
		perSource: MAX_KEX_PER_SOURCE,
		maxSources: MAX_KEX_SOURCES,
		floodMessage: `pairing kex flood from one source (${MAX_KEX_PER_SOURCE} distinct deviceIds this window)`,
	});
}

/**
 * The one bounded per-source counter, used by both ceilings.
 *
 * TWO bounds, and they are different things: `perSource` is how much ONE address
 * may spend, and `maxSources` bounds the TABLE — without it, an attacker rotating
 * addresses grows a map inside a 120 s window. Eviction is oldest-first (Map
 * iteration is insertion-ordered), which can only ever refund an old address, and
 * refusal names the offending source alone so a flood cannot lock out the real
 * phone.
 */
function chargePerSource(
	counts: Map<string, number>,
	sourceKey: string,
	limits: { perSource: number; maxSources: number; floodMessage: string },
): void {
	const used = counts.get(sourceKey) ?? 0;
	if (used >= limits.perSource) {
		console.warn(
			`${LOG_PREFIX} ${limits.floodMessage} — refusing that source only; other sources are unaffected`,
		);
		throw new PairingError(429, "pair_rate_limited");
	}
	if (!counts.has(sourceKey) && counts.size >= limits.maxSources) {
		const oldest = counts.keys().next();
		if (!oldest.done) counts.delete(oldest.value);
	}
	counts.set(sourceKey, used + 1);
}

/**
 * (PAIR-JUNK-SURVIVAL) Evict oldest-first, never refuse. See `MAX_KEX_SESSIONS`.
 * Loud, because a window in which this fires is a window somebody is flooding.
 *
 * An evicted candidate's derived keys are WIPED before the entry is dropped. A
 * `Map.delete` only drops a reference, and on a flooded window that would leave
 * a trail of live `K_dev`-shaped material in the heap that nothing can reach and
 * nothing will ever clear.
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
		const evicted = state.kexSessions.get(oldestKey);
		if (evicted !== undefined) zeroKexSession(evicted);
		state.kexSessions.delete(oldestKey);
		console.warn(
			`${LOG_PREFIX} pairing candidate table full (${MAX_KEX_SESSIONS}) — evicted the oldest candidate; if the real phone was evicted its next request gets pair_unknown_candidate on the remote flow (pair_wrong_peer on the QR flow) and it can simply begin again`,
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
 * step 3b -> step 4, QR/LAN. Recomputes `macPhone` in CONSTANT TIME; a mismatch
 * stores nothing and increments the burn counter.
 *
 * The key schedule runs HERE on this flow, because the LAN exchange has nothing
 * to do at kex but record a public key. On the remote flow it has already run —
 * see `handleRemoteConfirm`.
 */
export async function handleConfirm(
	state: LanPairingSessionState,
	request: PairConfirmRequest,
	deps: PairingDeps,
): Promise<PairConfirmResult> {
	assertWindowOpen(state);
	assertWireVersion(request.v, 1);
	// (PAIR-ATTEMPT-ORDER) After the pid check, exactly as in `handleKex`.
	assertPidMatches(state, request.pid);

	const session = state.kexSessions.get(request.deviceId);
	if (session === undefined || session.kind !== "lan") {
		// (PAIR-JUNK-SURVIVAL) This request never reached a MAC check, so it is NOT
		// a grinding attempt and must not spend the 3-strike anti-grind budget.
		// Charging it there meant three packets naming a made-up deviceId — no
		// crypto, no guess, nothing learned either way — burned the whole 120 s
		// window, repeatably, for anyone who had seen the pid. Nor does it spend the
		// confirm budget, for the same reason `handleKex` does not spend it.
		noteUnattributedAttempt(state);
		throw new PairingError(400, "pair_wrong_peer");
	}

	// (PAIR-ATTEMPT-ORDER) Decode BEFORE charging: a body whose `macPhone` is not
	// 32 canonical base64url bytes never reaches the comparison, so it is malformed
	// noise, not an attempt. From here the request has a candidate session and a
	// MAC will actually be verified, which is the only thing §12's budget protects.
	const macPhone = decodeExact(request.macPhone, MAC_BYTES);
	chargeConfirmAttempt(state);

	const pidBytes = base64UrlDecode(state.pid);

	const keys = derivePairingKeys({
		dPriv: state.dPriv,
		pPub: session.pPub,
		pairingCode: state.pairingCode,
		pairSalt: state.pairSalt,
		pidBytes,
		deviceIdBytes: session.deviceIdBytes,
		profile: state.profile,
	});

	const transcript = buildPairingTranscript({
		pid: pidBytes,
		deviceId: session.deviceIdBytes,
		pPub: session.pPub,
		dPub: state.dPub,
		pairSalt: state.pairSalt,
	});

	if (
		!constantTimeEquals(hmacSha256(keys.confirmPhone, transcript), macPhone)
	) {
		// These keys were derived FOR this attempt and nothing else holds them.
		wipeAllPairingKeys(keys);
		burnMac(state);
		throw new PairingError(401, "pair_bad_mac");
	}

	return completePairing(state, session, keys, transcript, deps);
}

/**
 * (REMOTE-CODE-PAIRING) step 3b -> step 4 on the REMOTE hop.
 *
 * Cheap by construction: the SRP exchange and the key schedule both ran at
 * `kex`, so all this does is rebuild the 825-byte transcript from the
 * candidate's own `A` and `B` and compare one HMAC in constant time. There is no
 * modular exponentiation on this path at all, which is what keeps the five
 * confirm attempts a window allows from being five more chances to spend CPU.
 *
 * A failed MAC does NOT wipe the candidate's keys, and that is deliberate: the
 * candidate is still live and §4.7 allows three attempts against it. The keys go
 * when the window does — burned, expired, closed or consumed.
 */
export async function handleRemoteConfirm(
	state: RemotePairingSessionState,
	request: RemotePairConfirmRequest,
	sourceKey: string,
	deps: PairingDeps,
): Promise<PairConfirmResult> {
	assertWindowOpen(state);
	assertWireVersion(request.v, PAIRING_REMOTE_WIRE_VERSION);
	assertSourceKey(sourceKey);
	assertPidMatches(state, request.pid);

	const session = requireRemoteCandidate(state, request.deviceId);
	assertCandidateSource(session, sourceKey);
	if (
		session.clientPublic === null ||
		session.serverPublic === null ||
		session.keys === null
	) {
		// `begin` ran but `kex` did not, so there is no key material to check a MAC
		// against. Costs nothing, exactly like a made-up deviceId.
		//
		// (PAIR-EVICTION-HONEST) NOT `pair_unknown_candidate`: the candidate is right
		// here. The desktop forgot nothing, so telling the phone to start over would
		// invent a cause. A correct client cannot reach this state at all — it is an
		// out-of-order confirm — and a client bug should stay loud.
		noteUnattributedAttempt(state);
		throw new PairingError(400, "pair_wrong_peer");
	}

	// (PAIR-ATTEMPT-ORDER) Same ordering as the LAN hop: a malformed `macPhone`
	// cannot reach the comparison, so it costs no attempt and no strike.
	const macPhone = decodeExact(request.macPhone, MAC_BYTES);
	chargeConfirmAttempt(state);

	const transcript = buildSrpPairingTranscript({
		pid: base64UrlDecode(state.pid),
		deviceId: session.deviceIdBytes,
		clientPublic: session.clientPublic,
		serverPublic: session.serverPublic,
		pairSalt: state.pairSalt,
	});

	if (
		!constantTimeEquals(
			hmacSha256(session.keys.confirmPhone, transcript),
			macPhone,
		)
	) {
		burnMac(state);
		// Nothing is stored, and no detail is disclosed about WHY. The remote flow
		// says `pair_code_wrong` instead of `pair_bad_mac` because on that flow a
		// failed MAC has exactly one ordinary cause — the user mistyped the digits
		// — and telling them "bad MAC" would be true and useless.
		throw new PairingError(401, "pair_code_wrong");
	}

	const keys = session.keys;
	// The candidate no longer owns them: `completePairing` wipes them in its
	// `finally`, and leaving the reference here would let a later sweep wipe
	// already-wiped memory or, worse, read it.
	session.keys = null;
	return completePairing(state, session, keys, transcript, deps);
}

/**
 * Everything after a `macPhone` has verified, identical in both flows.
 *
 * Ordering that is not negotiable: the device record is PERSISTED BEFORE the
 * response is sealed. A crash between the two leaves the desktop holding a key
 * the phone never received — recoverable by re-pairing. The reverse order would
 * leave the phone holding a key the desktop has no record of, which presents as
 * a silently broken pairing.
 *
 * (PAIR-TOKEN-BEFORE-PERSIST) The Access token is read before EITHER of those,
 * so the one fallible read in the sequence cannot strand a persisted device
 * behind a burned window. See `sealPairedResponse`.
 *
 * The response body is SEALED and is the only message in the protocol carrying
 * the Access service-token secret.
 */
async function completePairing(
	state: PairingSessionState,
	session: KexSession,
	keys: PairingKeys,
	transcript: Uint8Array,
	deps: PairingDeps,
): Promise<PairConfirmResult> {
	const macDesktop = hmacSha256(keys.confirmDesktop, transcript);
	// THE OUTERMOST `finally` OWNS THE WIPE, from the first byte derived to the
	// last statement of the function. `onPaired` writes to disk and
	// `loadAccessToken` reads from it, so either can throw for reasons that have
	// nothing to do with this exchange; a wipe scoped only to the sealing step
	// would leave K_dev and both confirmation keys live in the heap on exactly
	// those failures, with the candidate that owned them already detached and
	// nothing left holding a reference to clean up.
	try {
		return await sealPairedResponse(state, session, keys, macDesktop, deps);
	} finally {
		wipeAllPairingKeys(keys);
		zero(macDesktop);
	}
}

async function sealPairedResponse(
	state: PairingSessionState,
	session: KexSession,
	keys: PairingKeys,
	macDesktop: Uint8Array,
	deps: PairingDeps,
): Promise<PairConfirmResult> {
	// (PAIR-TOKEN-BEFORE-PERSIST) The Access token is read FIRST, before anything
	// about this window or this device has changed. It is the only remaining step in
	// this function that touches the filesystem, so it is the only one that can fail
	// for reasons that have nothing to do with the exchange — a missing, unreadable
	// or malformed token file. Reading it after `consumed` and `onPaired` made that
	// failure the worst shape available: the desktop kept a persisted device and a
	// burned window while the phone was told `500 unknown` and honestly reported
	// that nothing had been stored, leaving an orphan record only a manual revoke
	// could clear. Failing here instead leaves NOTHING changed — no device row, an
	// unconsumed window the user can still finish once the token file is fixed — and
	// the refusal is not a wrong code, so it costs no MAC strike.
	//
	// Everything after this line is in-process, deterministic crypto (HKDF, JSON,
	// AES-GCM). There is no post-persist failure left that is not a programming bug,
	// which is why `500 unknown` remains the right answer for one and no new wire
	// code is introduced — the wire is frozen and a code the phone cannot act on
	// differently would be churn.
	const access = await deps.loadAccessToken();

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
				// METHOD "POST", PATH the path this exchange is actually served on
				// ("/pair/confirm" on the LAN listener, "/v1/pair/confirm" on the
				// remote one), protocolVersion 0x01 — and nothing further. That is
				// the REQUEST form.
				//
				// Binding the REAL path is what stops a step-4 envelope captured on
				// one flow from opening on the other.
				//
				// It is deliberately NOT the §3.3 response form. There is no client
				// request nonce on this hop (the pairing messages are cleartext JSON,
				// not envelopes) and no status code the client can bind before it has
				// read the body, so the response form would have to invent a
				// twelve-zero-byte placeholder nonce and a literal 200. An earlier
				// revision did exactly that; the client follows the spec, so the two
				// AADs differed by 16 bytes and every pairing failed the GCM tag and
				// reported `pair_bad_mac` — indistinguishable from a real MITM.
				buildRequestAad(headerBytes, {
					method: "POST",
					path: state.profile.confirmPath,
					protocolVersion: PROTOCOL_VERSION_AT_PAIRING,
				}),
		);
	} finally {
		// The secret's lifetime ends here regardless of outcome. The pairing keys
		// and `macDesktop` are wiped one frame out, by `completePairing`, so that
		// they are covered on the paths that never reach this statement at all.
		// HONEST LIMIT: `plaintextBytes` and every key are genuinely overwritten,
		// but `access.clientSecret` and the `plaintext` object hold it as immutable
		// JS strings that cannot be zeroed — all we can do is drop the references
		// and never hand them to a caller (see `PairConfirmResult`, which
		// deliberately omits the plaintext).
		zero(plaintextBytes);
		zero(sendKey);
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
 * (REMOTE-CODE-PAIRING) Charge one GENUINELY NEW SRP derivation against the
 * window's monotone ceiling, immediately before it is performed.
 *
 * Only the derivation itself is charged. A cached exact retry returns the stored
 * `B` without reaching here; a candidate trying to rewrite its `A` is refused
 * before here; an `A` that is the wrong width, non-canonical, out of range or
 * degenerate is refused by `decodeClientPublic` before here, so a free-to-forge
 * `PAD(1)` cannot spend a derivation it never causes; `begin` and `confirm` never
 * come here at all. So the phone's own kex costs exactly 1, and 64 is a ceiling
 * only a flood can approach — at which point every further NEW derivation is
 * refused for the rest of the window while candidates that already derived can
 * still confirm.
 */
function chargeKexComputation(state: RemotePairingSessionState): void {
	if (state.kexComputations >= MAX_KEX_COMPUTATIONS_PER_WINDOW) {
		console.warn(
			`${LOG_PREFIX} remote pairing window reached its ceiling of ${MAX_KEX_COMPUTATIONS_PER_WINDOW} SRP key derivations — refusing every further new key agreement for the rest of this window; candidates that already completed kex can still confirm pairingRef=${state.pid}`,
		);
		throw new PairingError(429, "pair_rate_limited");
	}
	state.kexComputations += 1;
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
 * A RESENT confirm cannot reach here either. The phone's HTTP client may replay
 * a confirm whose response it never saw — Android found OkHttp's default
 * connection-failure retry sending three for one user tap — and a replay that
 * lands after `state.consumed` finds no window at all (404), while one that
 * lands before is the same valid MAC and pairs. Neither is a guess, so neither
 * costs the user a strike. A malformed `macPhone` is rejected before the compare
 * for the same reason: nothing was guessed, so nothing is charged.
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

/**
 * §4.2 — at most one pairing window may be open at a time, PROCESS-WIDE and
 * ACROSS BOTH KINDS.
 *
 * (REMOTE-CODE-PAIRING) One slot, not one per flow. Two concurrent windows would
 * mean two live codes and two ways for a device to arrive, and the remote flow's
 * whole anti-grind story is "one 120 s window at a time, opened by the person at
 * the machine" — a second window would double an attacker's guesses for free and
 * make "which window did this confirm belong to?" a question the wire cannot
 * answer.
 *
 * The state is the DISCRIMINATED UNION itself rather than a `kind` repeated on
 * the slot: `state.kind` is the one discriminant, so reaching the remote
 * window's state still proves at compile time that it IS the remote window's
 * state, and there is no second copy of that fact to drift.
 */
interface OpenPairingWindow {
	handle: PairingWindowHandleBase;
	state: PairingSessionState;
	deps: PairingDeps;
}

let openWindow: OpenPairingWindow | null = null;

/**
 * (PAIR-ONE-WINDOW-ATOMIC) The slot is RESERVED before either opener awaits
 * anything, and only filled once that opener has actually succeeded.
 *
 * WHY. `openPairingWindow` awaits `server.listen` before it can claim
 * `openWindow`, and an `await` is a place another caller gets to run. Two opens
 * racing — the desktop dialog switching modes, a double click, a retry landing
 * on top of a slow bind — could therefore BOTH pass the "is one already open?"
 * check and both proceed: the code window claimed the slot, the QR window
 * finished its bind and overwrote it, and the code window was left LIVE but
 * unreachable (`currentRemotePairing` reads the slot) and unclosable
 * (`closePairing` reads the slot too). A window nobody can see or close, ticking
 * with a real verifier in it, is the exact state the one-window rule exists to
 * prevent.
 *
 * A boolean is enough because this process is single-threaded: reserving and
 * checking happen with no `await` between them, so the reservation is atomic
 * with respect to every other opener. A failed open RELEASES it, so a bind
 * failure does not wedge pairing until restart.
 */
let openReservedBy: PairingKind | null = null;

/**
 * (REMOTE-CODE-PAIRING) Why a window that is no longer open is remembered, and
 * for exactly 60 s.
 *
 * A burned remote window and a window that never existed both leave nothing
 * behind, so both would answer the phone with the same bare 404 — and the user
 * who mistyped their code three times would be told "there is nothing here"
 * rather than "you burned it, ask for a new one". The memo is the difference. It
 * holds the pairing REFERENCE and a deadline, never the code (which is zeroed at
 * the burn), and it is forgotten on the deadline so it cannot become a
 * permanent record that a pairing was attempted.
 */
interface RemoteBurnMemo {
	forgetAtMs: number;
}

let remoteBurnMemo: RemoteBurnMemo | null = null;

function rememberRemoteBurn(): void {
	remoteBurnMemo = {
		forgetAtMs: Date.now() + PAIRING_REMOTE_BURN_MEMO_MS,
	};
}

/** True while a remote window that BURNED is still within its memo window. */
export function remoteWindowWasBurned(): boolean {
	if (remoteBurnMemo === null) return false;
	if (Date.now() >= remoteBurnMemo.forgetAtMs) {
		remoteBurnMemo = null;
		return false;
	}
	return true;
}

function describeOpenWindow(existing: OpenPairingWindow): string {
	return existing.state.kind === "lan"
		? "a QR pairing window is already open"
		: "a code pairing window is already open";
}

/**
 * THE one-window refusal, stated once.
 *
 * This module's `openWindow` slot is the authoritative guard — it is the state
 * that actually decides — so the message a user sees for "you already have one
 * open" is minted here rather than re-derived by every caller. `index.ts` used
 * to repeat the check against its own remembered handle, which could disagree
 * with this one (a window that expired here still looked open there) and had to
 * be kept in sync by hand.
 *
 * A plain `Error`, not a `PairingError`: nothing on the wire can reach this. It
 * is raised only when the DESKTOP asks for a second window, and the desktop
 * dialog shows the text.
 */
const ONE_WINDOW_MESSAGE = `${LOG_PREFIX} a pairing window is already open — close it before opening another`;

/**
 * (PAIR-ONE-WINDOW-ATOMIC) Take the process-wide slot, or refuse. NO `await` may
 * appear between the check and the reservation, which is why they are one call.
 */
function reserveWindowSlot(wanted: PairingKind): void {
	if (openWindow) {
		console.warn(
			`${LOG_PREFIX} refusing to open a ${wanted === "lan" ? "QR" : "code"} pairing window: ${describeOpenWindow(openWindow)}`,
		);
		throw new Error(ONE_WINDOW_MESSAGE);
	}
	if (openReservedBy !== null) {
		console.warn(
			`${LOG_PREFIX} refusing to open a ${wanted === "lan" ? "QR" : "code"} pairing window: a ${openReservedBy === "lan" ? "QR" : "code"} pairing window is still opening`,
		);
		throw new Error(ONE_WINDOW_MESSAGE);
	}
	openReservedBy = wanted;
}

/** Fill the reserved slot. Loud if the reservation went missing under us. */
function claimWindowSlot(window: OpenPairingWindow): void {
	if (openReservedBy !== window.state.kind || openWindow !== null) {
		// Unreachable unless someone adds an `await` between the reservation and
		// this call, or a second claim. Refuse to publish a window into a slot
		// whose ownership is not what this opener reserved.
		throw new Error(
			`${LOG_PREFIX} pairing window slot was taken while a ${window.state.kind} window was opening — refusing to publish two windows`,
		);
	}
	openWindow = window;
	openReservedBy = null;
}

/** Give the reservation back after a failed open. */
function releaseWindowSlot(wanted: PairingKind): void {
	if (openReservedBy === wanted) {
		openReservedBy = null;
	}
}

/**
 * (PAIR-ONE-WINDOW-ATOMIC) Claim the slot, or destroy the window that cannot have
 * it. A refusal here means the invariant is already broken, and the one thing
 * worse than failing loud is failing loud while leaving a listener bound, an
 * expiry timer armed and a private key live with no handle to reach them by.
 */
async function claimOrTearDown(
	window: OpenPairingWindow,
	tearDown: () => void | Promise<void>,
): Promise<void> {
	try {
		claimWindowSlot(window);
	} catch (error) {
		await tearDown();
		throw error;
	}
}

/**
 * Opens the single process-wide pairing window. Fails loud if one is already
 * open (of EITHER kind), or if 47611 is taken.
 */
export async function openPairingWindow(
	deps: PairingDeps,
): Promise<PairingWindowHandle> {
	reserveWindowSlot("lan");
	try {
		return await openPairingWindowReserved(deps);
	} catch (error) {
		releaseWindowSlot("lan");
		throw error;
	}
}

async function openPairingWindowReserved(
	deps: PairingDeps,
): Promise<PairingWindowHandle> {
	const host = deps.lanHost ?? discoverLanHost();
	const { privateKey: dPriv, publicKey: dPub } = generateX25519KeyPair();
	const pidBytes = randomBytes(WIRE_ID_BYTES);
	const pairingCode = randomBytes(PAIRING_CODE_BYTES);
	const pairSalt = randomBytes(PAIRING_SALT_BYTES);
	const openedAtMs = Date.now();

	const state: LanPairingSessionState = {
		kind: "lan",
		profile: LAN_PAIRING_PROFILE,
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
		kind: "lan",
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
		toJSON() {
			return {
				kind: "lan" as const,
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
		if (openWindow?.handle === handle) {
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
		clearKexSessions(state);
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

	// (PAIR-ONE-WINDOW-ATOMIC) The window is fully built and its expiry armed, so a
	// refused claim has to take it down. Nothing else can: the handle this function
	// never returned is unreachable, and the reservation the outer wrapper gives
	// back is neither the bound port nor this window's key material.
	await claimOrTearDown({ handle, state, deps }, close);
	// (PAIR-REF-ONLY) The ONLY line this module logs about an open window, and it
	// carries the reference, the host and the deadline — never the URI. A caller
	// that wants to say more should say it about `pairingRef`.
	console.log(
		`${LOG_PREFIX} pairing window open on ${host} for ${PAIRING_WINDOW_MS}ms pairingRef=${state.pid} — the QR is the only place the code is rendered`,
	);
	return handle;
}

// ---------------------------------------------------------------------------
// §4.9 the remote code window (REMOTE-CODE-PAIRING)
// ---------------------------------------------------------------------------

/**
 * (REMOTE-CODE-PAIRING) The remote flow's deps. Identical to the LAN flow's
 * minus `lanHost`: there is no LAN address to advertise, which is the entire
 * reason this flow exists.
 */
export type RemotePairingDeps = Omit<PairingDeps, "lanHost">;

/**
 * (REMOTE-CODE-PAIRING) Opens the single process-wide pairing window in CODE
 * mode. No socket is bound: the three remote paths are served by the bridge's
 * existing 47610 listener (see `http.ts`), which is already behind the tunnel.
 *
 * Fails loud if a window of either kind is already open.
 *
 * WHAT THIS WINDOW KEEPS, AND WHAT IT IMMEDIATELY DESTROYS. The SRP verifier and
 * the salt are the only long-lived crypto state; there is no key pair, because
 * SRP's per-candidate `b` replaces it. The code's BYTES are overwritten as soon
 * as `x` and the verifier have been computed from them — nothing after this
 * function needs the password itself, and a mutable copy of it lying in the heap
 * for 120 s is a copy that can be read.
 *
 * HONEST LIMIT: the code is ALSO held as a JS string, because the dialog has to
 * render it for the user to type. A string is immutable and cannot be
 * overwritten; `close()` drops the reference and the engine keeps it until it
 * collects. That is unavoidable for a code a human must read, and it is the same
 * limitation `qrUri` carries on the QR flow.
 */
export async function openRemotePairing(
	deps: RemotePairingDeps,
): Promise<RemotePairingWindowHandle> {
	reserveWindowSlot("remote");
	try {
		return await openRemotePairingReserved(deps);
	} catch (error) {
		releaseWindowSlot("remote");
		throw error;
	}
}

async function openRemotePairingReserved(
	deps: RemotePairingDeps,
): Promise<RemotePairingWindowHandle> {
	const pidBytes = randomBytes(WIRE_ID_BYTES);
	let code: string | null = mintRemotePairingCode();
	const pairSalt = randomBytes(PAIRING_SALT_BYTES);
	const openedAtMs = Date.now();

	// `x` and the password bytes both die here; only the verifier survives.
	const x = srpComputeX(SRP_3072_SHA256, pairSalt, PAIRING_SRP_IDENTITY, code);
	let verifier: bigint;
	try {
		verifier = srpComputeVerifier(SRP_3072_SHA256, x);
	} finally {
		zero(x);
	}

	const state: RemotePairingSessionState = {
		kind: "remote",
		profile: REMOTE_PAIRING_PROFILE,
		pid: base64UrlEncode(pidBytes),
		pairSalt,
		verifier,
		openedAtMs,
		expiresAtMs: openedAtMs + PAIRING_WINDOW_MS,
		failedMacAttempts: 0,
		consumed: false,
		kexSessions: new Map(),
		confirmAttempts: 0,
		kexSourceCounts: new Map(),
		unattributedAttempts: 0,
		remoteRequestCounts: new Map(),
		remoteRequests: 0,
		kexComputations: 0,
	};

	let closed = false;
	let timer: NodeJS.Timeout | null = null;

	const handle: RemotePairingWindowHandle = {
		kind: "remote",
		get code(): string {
			if (code === null) {
				// Fail loud rather than render a dead code the user would type and
				// watch fail with no explanation.
				throw new PairingError(410, "pair_window_closed");
			}
			return code;
		},
		pairingRef: state.pid,
		expiresAtMs: state.expiresAtMs,
		get closed(): boolean {
			return closed;
		},
		toJSON() {
			return {
				kind: "remote" as const,
				pairingRef: state.pid,
				expiresAtMs: state.expiresAtMs,
				closed,
			};
		},
		close,
	};

	async function close(): Promise<void> {
		if (closed) return;
		closed = true;
		if (openWindow?.handle === handle) {
			openWindow = null;
		}
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
		// HONEST LIMIT: `code` is a JS string and `verifier` is a `bigint`; neither
		// can be overwritten, so dropping the reference is all there is, and the
		// engine may keep a copy until GC. `pairSalt` and every candidate's derived
		// keys below ARE genuinely overwritten.
		code = null;
		state.verifier = 0n;
		zero(state.pairSalt);
		clearKexSessions(state);
		state.consumed = true;
	}

	timer = setTimeout(() => {
		void close();
	}, PAIRING_WINDOW_MS);

	// (PAIR-ONE-WINDOW-ATOMIC) The window is fully built and its expiry armed, so a
	// refused claim has to take it down. Nothing else can: the handle this function
	// never returned is unreachable, and the reservation the outer wrapper gives
	// back is neither the bound port nor this window's key material.
	await claimOrTearDown({ handle, state, deps }, close);
	// A fresh window supersedes any memory of the previous one's burn: the phone
	// asking about THIS window must not be told about the last one.
	remoteBurnMemo = null;
	// (PAIR-REF-ONLY) The ONLY line this module logs about an open remote window.
	// It carries the reference and the deadline — never the code.
	console.log(
		`${LOG_PREFIX} remote pairing window open for ${PAIRING_WINDOW_MS}ms pairingRef=${state.pid} — the code is rendered only in the desktop dialog`,
	);
	return handle;
}

/**
 * (REMOTE-CODE-PAIRING) 8 decimal digits from the CSPRNG, uniform over
 * 00000000..99999999 — leading zeros included, because dropping them would make
 * some codes shorter and the code space smaller.
 *
 * `randomInt` is rejection-sampled by Node, so there is no modulo bias. The
 * returned string is a secret from this line onwards.
 *
 * (PAIR-CODE-ASCII) The width/charset assertion is not defensive noise about
 * today's generator, which cannot produce anything else. `srpComputeX` encodes
 * the password as `"ascii"`, so any future code containing a non-ASCII digit
 * would be silently mangled into a verifier no phone could ever match, and the
 * user would see "wrong code" while typing the right one. The companion hit
 * exactly this on its side: `Char.isDigit` accepts Arabic-Indic and fullwidth
 * digits that ASCII encoding then destroys. Fail here instead, before a window
 * opens.
 */
function mintRemotePairingCode(): string {
	const ceiling = 10 ** PAIRING_REMOTE_CODE_DIGITS;
	const code = String(randomInt(0, ceiling)).padStart(
		PAIRING_REMOTE_CODE_DIGITS,
		"0",
	);
	assertAsciiDigitCode(code);
	return code;
}

/** (PAIR-CODE-ASCII) Exactly `PAIRING_REMOTE_CODE_DIGITS` ASCII digits, or throw. */
function assertAsciiDigitCode(code: string): void {
	if (code.length !== PAIRING_REMOTE_CODE_DIGITS) {
		throw new Error(
			`${LOG_PREFIX} remote pairing code must be exactly ${PAIRING_REMOTE_CODE_DIGITS} digits, got ${code.length}`,
		);
	}
	for (let index = 0; index < code.length; index += 1) {
		const point = code.charCodeAt(index);
		if (point < 0x30 || point > 0x39) {
			throw new Error(
				`${LOG_PREFIX} remote pairing code must be ASCII digits 0-9; character ${index} is not one (the code itself is not logged)`,
			);
		}
	}
}

/**
 * (REMOTE-CODE-PAIRING) What `http.ts` is allowed to do with the open remote
 * window: the three steps, and the reference for logging. Nothing else — in
 * particular the transport can reach neither the code nor the verifier.
 */
export interface RemotePairingEndpoint {
	/** (PAIR-REF-ONLY) Non-secret. Safe to log. */
	readonly pairingRef: string;
	/**
	 * Spend this source's per-window allowance ONCE, then hand back the three
	 * steps.
	 *
	 * The charge is HERE rather than inside the steps so it cannot be spent twice
	 * for one request, and cannot be skipped: there is no way to reach a handler
	 * without passing through it, so a future caller — a test seam, a second
	 * transport — inherits the ceiling instead of having to remember it. The
	 * transport calls this after it knows the route and the source and before it
	 * reads a byte of body, which is what keeps `kex`'s modular exponentiation
	 * behind a bound.
	 */
	admit(sourceKey: string): RemotePairingSteps;
}

export interface RemotePairingSteps {
	begin(request: RemotePairBeginRequest): RemotePairBeginResponse;
	kex(request: RemotePairKexRequest): RemotePairKexResponse;
	confirm(request: RemotePairConfirmRequest): Promise<PairConfirmResult>;
}

/**
 * (REMOTE-CODE-PAIRING) The open remote window, or `null`.
 *
 * `null` is what makes `/v1/pair/*` answer 404 — byte-identical to an unknown
 * path — whenever the user is not standing at the desktop with a window open.
 * That is the outermost bound on grinding an 8-digit code: the endpoint does not
 * exist except during a 120 s window a human deliberately opened.
 *
 * A LAN window returns `null` too. The two flows never share a window even
 * though they share the slot.
 */
export function currentRemotePairing(): RemotePairingEndpoint | null {
	const current = openWindow;
	if (current === null || current.state.kind !== "remote") return null;
	const { handle, deps } = current;
	const state = current.state;
	if (handle.closed || state.consumed) return null;
	if (Date.now() >= state.expiresAtMs) return null;

	return {
		pairingRef: state.pid,
		admit(sourceKey) {
			// CHARGED ONCE, BEFORE ANY EXPENSIVE WORK — the body has not been read
			// yet and `kex`'s 3072-bit modular exponentiation is still ahead. The
			// pairing host is public, so this ceiling is the only thing standing
			// between one source and unbounded work inside the window.
			chargeRemoteRequest(state, sourceKey);
			return {
				begin(request) {
					return handleRemoteBegin(state, request, sourceKey);
				},
				kex(request) {
					return handleRemoteKex(state, request, sourceKey);
				},
				async confirm(request) {
					try {
						const result = await handleRemoteConfirm(
							state,
							request,
							sourceKey,
							deps,
						);
						// Single use. The window is over the moment a device pairs; the
						// sealed body is already built and held by the caller, so closing
						// here cannot lose it.
						await closeQuietly(handle.close);
						return result;
					} catch (error) {
						if (state.consumed) {
							// Three bad MACs burned it. Remember that for a minute so the
							// phone can be told WHY, then take the window down.
							if (state.failedMacAttempts >= PAIRING_MAX_BAD_MACS) {
								rememberRemoteBurn();
								console.warn(
									`${LOG_PREFIX} remote pairing window burned after ${state.failedMacAttempts} wrong codes pairingRef=${state.pid}`,
								);
							}
							await closeQuietly(handle.close);
						}
						throw error;
					}
				},
			};
		},
	};
}

/**
 * (REMOTE-CODE-PAIRING) The admission charge for one `/v1/pair/*` request: a
 * MONOTONE per-window total first, then the per-source ceiling.
 *
 * WHY BOTH. The per-source table is bounded (`REMOTE_PAIR_MAX_SOURCES`) and
 * evicts its oldest bucket to stay bounded, which means a source that comes back
 * after being evicted arrives with a FRESH allowance. That is the right
 * behaviour for the per-source rule — the real phone must never be locked out by
 * somebody else's flood — but it makes "32 sources x 32 requests" untrue as an
 * aggregate bound: an attacker cycling more than 32 addresses can refund itself
 * forever, and every admitted request buys a body read and a JSON parse.
 *
 * So the aggregate bound is stated separately and cannot be refunded:
 * `REMOTE_PAIR_MAX_REQUESTS_PER_WINDOW` counts every request this window has
 * ADMITTED, is never decremented or evicted, and is charged BEFORE the body is
 * read — so it bounds body reads and parses too, not just handler work. It sits
 * far above the three requests a real pairing spends.
 *
 * ORDER WITHIN THIS FUNCTION IS LOAD-BEARING. The per-source ceiling is charged
 * FIRST and the aggregate only once that succeeded, so a request the per-source
 * rule refuses costs the window nothing. Incrementing the aggregate first turned
 * the two rules against each other: ONE address sending
 * `REMOTE_PAIR_MAX_REQUESTS_PER_WINDOW` requests had all but its first
 * `REMOTE_PAIR_REQUESTS_PER_SOURCE` refused as a flood and still consumed the
 * whole window aggregate, locking out the real phone — which is exactly the
 * lockout the per-source rule exists to prevent.
 */
function chargeRemoteRequest(
	state: RemotePairingSessionState,
	sourceKey: string,
): void {
	assertSourceKey(sourceKey);
	if (state.remoteRequests >= REMOTE_PAIR_MAX_REQUESTS_PER_WINDOW) {
		console.warn(
			`${LOG_PREFIX} remote pairing window reached its ceiling of ${REMOTE_PAIR_MAX_REQUESTS_PER_WINDOW} total requests — refusing every further request for the rest of this window pairingRef=${state.pid}`,
		);
		throw new PairingError(429, "pair_rate_limited");
	}
	chargePerSource(state.remoteRequestCounts, sourceKey, {
		perSource: REMOTE_PAIR_REQUESTS_PER_SOURCE,
		maxSources: REMOTE_PAIR_MAX_SOURCES,
		floodMessage: `remote pairing flood from one source (${REMOTE_PAIR_REQUESTS_PER_SOURCE} requests this window)`,
	});
	state.remoteRequests += 1;
}

async function route(
	req: IncomingMessage,
	res: ServerResponse,
	state: LanPairingSessionState,
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
