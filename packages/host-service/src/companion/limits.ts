/**
 * (COMPANION-BRIDGE) — the single home for the caps and id shapes that MORE THAN
 * ONE boundary enforces.
 *
 * WHY THIS FILE EXISTS. Every value here was previously re-declared per file and
 * kept in step by a comment saying the copies "must be changed together". That is
 * not a mechanism, it is a hope, and at least one of these pairs is load-bearing
 * in a way a comment cannot cover: `pairing.ts` MAC-ACCEPTS a device label it
 * considers legal and only then hands it to `device-store.create()`, which
 * re-validates it. If those two caps ever drift, the store refuses a label the
 * pairing exchange has ALREADY cryptographically accepted — a failure AFTER the
 * acceptance point, where the phone has a confirmed session and the desktop has
 * no record of it.
 *
 * WHAT BELONGS HERE: a constant that at least two independent boundaries must
 * agree on, character for character.
 *
 * WHAT DOES NOT: anything one file alone enforces (keep it local, next to the
 * code that uses it), and anything §12/§15 negotiates on the wire — that is
 * `config.ts`'s job, and the split is deliberate: `config.ts` answers "what did
 * this deployment agree to", this file answers "what shape is structurally legal
 * anywhere".
 *
 * DUAL VALIDATION IS NOT DUPLICATION. Sharing a constant does NOT mean one of the
 * two checks may now be deleted. The router validating a capture and the store
 * re-validating it are two boundaries, and both must keep asserting. Only the
 * NUMBER is unified here, never the assertion.
 *
 * This module imports nothing, on purpose: every other companion module may
 * depend on it without any possibility of an import cycle.
 */

// ---------------------------------------------------------------------------
// §0.1 id shapes
// ---------------------------------------------------------------------------

/**
 * Every id on this wire — `pid`, `deviceId`, `ticketId` — is exactly 16 raw
 * bytes. They are distinct ids with one shared width; that width is fixed by
 * §0.1 and is what makes the HKDF `info` strings unambiguous without a length
 * prefix (see the INTEROP NOTE in `crypto.ts`).
 */
export const WIRE_ID_BYTES = 16;

/**
 * §0.1 — 16 raw bytes are exactly 22 unpadded base64url characters.
 *
 * A length check alone does NOT establish that a 22-character string is a legal
 * id: base64url's last character carries only 4 significant bits, so 22 chars can
 * encode trailing bits that are not zero. Those non-canonical forms decode to the
 * same 16 bytes as a canonical id while comparing unequal as strings, which is a
 * map-key and de-duplication hazard for a protocol that uses ids as map keys.
 * Use `isCanonicalWireId` / `decodeWireId` from `crypto.ts`; this constant exists
 * for the message text and for schemas that also want a cheap length gate.
 */
export const WIRE_ID_CHARS = 22;

// ---------------------------------------------------------------------------
// §15.1 key material widths
// ---------------------------------------------------------------------------

/**
 * The symmetric key width used everywhere in this bridge: AES-256-GCM keys,
 * `K_dev`, and the derived directional keys `K_c2s` / `K_s2c`. One constant
 * because they are one width by construction — HKDF-SHA256 output.
 */
export const KEY_BYTES = 32;

/** X25519 scalars and points are both 32 bytes (RFC 7748). */
export const X25519_KEY_BYTES = 32;

// ---------------------------------------------------------------------------
// §4 pairing / device record shapes
// ---------------------------------------------------------------------------

/**
 * Ceiling on a device label, in CHARACTERS (JS string length, not UTF-8 bytes —
 * both validators have always measured `.length`, and unifying the constant must
 * not quietly change the unit).
 *
 * LOAD-BEARING ACROSS TWO FILES. `pairing.ts` checks this before it completes the
 * key-confirmation exchange; `device-store.ts` checks it again when the record is
 * created. The second check runs after the first has already MAC-accepted the
 * pairing, so a drift between them is not a validation difference — it is a
 * device that paired successfully and then failed to be recorded.
 */
export const MAX_LABEL_CHARS = 128;

/**
 * Ceiling on a client's reported app version, in CHARACTERS.
 *
 * LOAD-BEARING ACROSS FOUR BOUNDARIES, AND IT WAS DIVERGENT. The phone sends ONE
 * value — `BuildConfig.VERSION_NAME` — down every one of them: `/pair/kex`
 * (`appVersion`), `/v1/session/hello` (`client.version`), `/v1/device/register`
 * (`appVersion`) and `push.ts`'s re-validation of that same field. Three capped
 * at 64 and `pairing.ts` capped at 32.
 *
 * Pairing is both the STRICTER boundary and the FIRST one to run, and it fails
 * with a bare `400 unknown` that names nothing, so a 33-to-64-character
 * `versionName` — which is a plain gradle string, and one CI suffix away — would
 * have made pairing impossible with no way to see why.
 *
 * 64 is the winner because it is what the three later boundaries already
 * enforce, so widening pairing to match cannot let through anything a request
 * path would then reject. It is a bridge-side shape rule, not a protocol
 * constant: PROTOCOL.md documents `appVersion` as a string and fixes no length.
 */
export const MAX_APP_VERSION_CHARS = 64;

// ---------------------------------------------------------------------------
// §7.8 panic switch
// ---------------------------------------------------------------------------

/**
 * §7.8 — a panic reason is 0..200 characters on the wire.
 *
 * The desktop-only tRPC panic switch writes to the SAME audit log as the wire
 * path, so it is held to the same shape; that is why this cap has two boundaries
 * and therefore lives here.
 */
export const PANIC_REASON_MAX_CHARS = 200;

// ---------------------------------------------------------------------------
// (CAPTURE-BOUNDED) — hard caps on the untrusted question capture
// ---------------------------------------------------------------------------

/**
 * The capture arrives on a `publicProcedure` over an UNAUTHENTICATED localhost
 * endpoint. Both the tRPC input schema and `question-store.validateCapture`
 * enforce these, and both must keep doing so: without the schema cap the router
 * materialises an arbitrarily large body before the store is ever consulted;
 * without the store cap a future non-tRPC producer bypasses the router entirely.
 * Two boundaries, one set of numbers.
 */

/** `toolUseId`, `sessionId`, `agentId`, `agentType`. */
export const MAX_ID_CHARS = 256;
/** `transcriptPath`, `cwd`. */
export const MAX_PATH_CHARS = 4_096;
/** One question's `header`. */
export const MAX_HEADER_CHARS = 512;
/** One question's body text. */
export const MAX_QUESTION_TEXT_CHARS = 262_144;
/** One option's `label`. */
export const MAX_OPTION_LABEL_CHARS = 512;
/** One option's `description`. */
export const MAX_OPTION_DESCRIPTION_CHARS = 4_096;
/** Options in one question. Also bounds a legal `option.index`. */
export const MAX_OPTIONS_PER_QUESTION = 32;
/** Questions in one captured prompt. Also bounds a legal `question.index`. */
export const MAX_QUESTIONS_PER_PROMPT = 32;
