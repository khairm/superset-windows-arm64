/**
 * (REMOTE-CODE-PAIRING) SRP-6a, server side, and nothing else.
 *
 * WHY THIS MODULE EXISTS. The remote pairing flow hands the user an 8-digit code
 * — ~26.6 bits — and asks two devices to agree on a 256-bit key from it. An
 * ordinary kex plus "mix the code into the HKDF" cannot do that safely on a hop
 * whose TLS somebody else terminates: everything needed to check a guess
 * OFFLINE travels on the wire, so one captured exchange turns 10^8 guesses into
 * a few seconds of local compute. SRP-6a is a password-authenticated key
 * exchange, and its whole point is that the transcript is NOT an offline oracle:
 * without running a fresh online exchange per guess, the observer of `A`, `B`
 * and the salt cannot test a candidate password at all.
 *
 * WHAT IS DELIBERATELY NOT HERE:
 *  - the client half. The phone implements it; the desktop is only ever the
 *    server, and a client implementation sitting in the server's module is a
 *    thing a future edit can accidentally call. The tests carry their own
 *    reference client, which also makes them an independent implementation
 *    rather than a mirror of this one.
 *  - RFC 2945 `M1`/`M2`. The key confirmation this protocol uses is the §4.4
 *    transcript MAC, which additionally binds `pid`, `deviceId` and `pairSalt`;
 *    see `buildSrpPairingTranscript` in `pairing.ts`.
 *  - any I/O, logging or protocol state. This module is arithmetic.
 *
 * ---------------------------------------------------------------------------
 * PADDING IS THE WHOLE INTEROP RISK — READ BEFORE CHANGING ANYTHING
 * ---------------------------------------------------------------------------
 * Every value hashed or transmitted is `PAD()`ed to the EXACT byte width of the
 * modulus (384 bytes for the production group), unsigned big-endian, leading
 * zeros included. RFC 5054 requires this and the reason is not cosmetic: a
 * minimal-length encoding makes `u` and `k` depend on how many leading zero
 * bytes a number happened to have, so roughly one exchange in 256 derives a
 * different key on each side and pairing fails with no diagnostic. `srpPad`
 * REFUSES a value that does not fit rather than truncating.
 *
 * ---------------------------------------------------------------------------
 * HONEST LIMITS
 * ---------------------------------------------------------------------------
 *  - `BigInt` cannot be zeroed and its allocations cannot be reached, so `x`,
 *    `u` and the intermediate products live in the heap until the collector
 *    takes them. The byte arrays this module RETURNS are zeroable and the caller
 *    zeroes them; the intermediate bignums are not. This is stated as a
 *    limitation, not defended as a design.
 *  - `BigInt` arithmetic is not constant time, and this module does NOT claim to
 *    close that channel. What it does close is the coarse, remotely observable
 *    part of it: every exponentiation with a SECRET exponent runs through
 *    `srpSecretModPow`, a fixed 4-bit-window ladder that performs the SAME 64
 *    windows of 4 squarings + 1 multiply for every exponent, so the NUMBER and
 *    SHAPE of the operations no longer depend on the exponent's bits. What
 *    remains is per-limb data dependence inside `BigInt` itself, which is real
 *    and not defended against — see `srpSecretModPow` for why that residue is
 *    accepted here rather than paid for with a native engine.
 *  - `srpModPow` (plain square-and-multiply, leaks its exponent through its
 *    operation count) is left for `v^u` alone, whose exponent
 *    `u = H(PAD(A) || PAD(B))` is computed from two values that are public on
 *    the wire. Non-exponent arithmetic (range checks, the `k*v + g^b` addition,
 *    the `A * v^u` product) is also BigInt and also leaks nothing an observer
 *    does not have.
 *  - MAC comparison, which IS attacker-timed on every request, goes through
 *    `crypto.timingSafeEqual` in `crypto.ts`.
 */

import { createHash } from "node:crypto";

/**
 * A bad input to the exchange — a malformed or degenerate `A`, a `u` of zero, a
 * value too wide for its padding.
 *
 * A DISTINCT class so `pairing.ts` can map exactly this to
 * `pair_bad_key_agreement` and let everything else become a 500. A blanket
 * catch would relabel a genuine bug in the key schedule as "your phone sent a
 * bad key", which is the one report that sends everybody looking in the wrong
 * place.
 */
export class SrpError extends Error {
	constructor(message: string) {
		super(`(COMPANION-BRIDGE) SRP: ${message}`);
		this.name = "SrpError";
	}
}

export interface SrpGroup {
	/** For error messages only. */
	readonly name: string;
	/** The safe-prime modulus. */
	readonly N: bigint;
	readonly g: bigint;
	/** Byte width of `N`. EVERY `PAD()` in the protocol is exactly this wide. */
	readonly widthBytes: number;
	/** `node:crypto` digest name. */
	readonly hashAlgorithm: string;
}

// ---------------------------------------------------------------------------
// groups
// ---------------------------------------------------------------------------

/**
 * RFC 5054 Appendix A's 3072-bit group, which is RFC 3526's 3072-bit MODP group
 * (id 15) with `g = 5`. Paired with SHA-256, this is the production profile.
 *
 * The hex is not taken on trust: `srp.test.ts` proves `N` is a safe prime
 * (Miller-Rabin on `N` and on `(N-1)/2`), which no corrupted transcription of it
 * would survive, and the RFC 5054 Appendix B anchor independently pins the
 * 1024-bit group's arithmetic against published values.
 */
const N_3072_HEX =
	"FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD1" +
	"29024E088A67CC74020BBEA63B139B22514A08798E3404DD" +
	"EF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245" +
	"E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED" +
	"EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3D" +
	"C2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F" +
	"83655D23DCA3AD961C62F356208552BB9ED529077096966D" +
	"670C354E4ABC9804F1746C08CA18217C32905E462E36CE3B" +
	"E39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9" +
	"DE2BCBF6955817183995497CEA956AE515D2261898FA0510" +
	"15728E5A8AAAC42DAD33170D04507A33A85521ABDF1CBA64" +
	"ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7" +
	"ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6B" +
	"F12FFA06D98A0864D87602733EC86A64521F2B18177B200C" +
	"BBE117577A615D6C770988C0BAD946E208E24FA074E5AB31" +
	"43DB5BFCE0FD108E4B82D120A93AD2CAFFFFFFFFFFFFFFFF";

/**
 * RFC 5054 Appendix A's 1024-bit group with `g = 2`.
 *
 * TEST PROFILE ONLY, and it is here rather than in the test file for one
 * reason: Appendix B's published `k`, `x`, `v`, `B`, `u` and `S` are the only
 * numbers in the world that check this module's arithmetic against an authority
 * outside this repository, and they are stated for THIS group and SHA-1. A
 * vector that has to be produced by the code it is meant to check is not a
 * vector. Nothing in the production path references it — the whole exchange is
 * parameterised by `SrpGroup` precisely so the anchor can run unmodified.
 */
const N_1024_HEX =
	"EEAF0AB9ADB38DD69C33F80AFA8FC5E86072618775FF3C0B9EA2314C" +
	"9C256576D674DF7496EA81D3383B4813D692C6E0E0D5D8E250B98BE4" +
	"8E495C1D6089DAD15DC7D7B46154D6B6CE8EF4AD69B15D4982559B29" +
	"7BCF1885C529F566660E57EC68EDBC3C05726CC02FD4CBF4976EAA9A" +
	"FD5138FE8376435B9FC61D2FC0EB06E3";

function defineGroup(input: {
	name: string;
	hex: string;
	g: bigint;
	hashAlgorithm: string;
	expectedBits: number;
}): SrpGroup {
	const N = BigInt(`0x${input.hex}`);
	// Structural, not a proof of primality — the safe-prime proof is a test. What
	// this catches is the transcription accident: a dropped or doubled hex digit
	// changes the width, and a width that is not a whole number of bytes would
	// silently change every PAD() in the protocol.
	if (input.hex.length !== input.expectedBits / 4) {
		throw new SrpError(
			`${input.name}: modulus is ${input.hex.length * 4} bits, expected ${input.expectedBits}`,
		);
	}
	if (N % 2n !== 1n || N <= input.g) {
		throw new SrpError(`${input.name}: modulus is not a usable odd prime`);
	}
	return {
		name: input.name,
		N,
		g: input.g,
		widthBytes: input.expectedBits / 8,
		hashAlgorithm: input.hashAlgorithm,
	};
}

/** PRODUCTION. RFC 5054 3072-bit group, SHA-256. */
export const SRP_3072_SHA256: SrpGroup = defineGroup({
	name: "RFC 5054 3072-bit / SHA-256",
	hex: N_3072_HEX,
	g: 5n,
	hashAlgorithm: "sha256",
	expectedBits: 3072,
});

/** TEST ONLY. RFC 5054 1024-bit group, SHA-1 — the Appendix B anchor. */
export const SRP_1024_SHA1: SrpGroup = defineGroup({
	name: "RFC 5054 1024-bit / SHA-1",
	hex: N_1024_HEX,
	g: 2n,
	hashAlgorithm: "sha1",
	expectedBits: 1024,
});

// ---------------------------------------------------------------------------
// bignum <-> bytes, and the one modular exponentiation
// ---------------------------------------------------------------------------

export function srpBytesToBigInt(bytes: Uint8Array): bigint {
	if (bytes.length === 0) return 0n;
	return BigInt(`0x${Buffer.from(bytes).toString("hex")}`);
}

/**
 * I2OSP to EXACTLY `width` bytes, unsigned big-endian. Refuses a value that does
 * not fit; see the padding note in the module header for why silently
 * truncating (or emitting a minimal encoding) breaks roughly one exchange in
 * 256 with no diagnostic.
 */
export function srpBigIntToBytes(value: bigint, width: number): Uint8Array {
	if (value < 0n) {
		throw new SrpError("cannot encode a negative value");
	}
	const hex = value.toString(16);
	if (hex.length > width * 2) {
		throw new SrpError(`value needs more than ${width} bytes`);
	}
	return new Uint8Array(Buffer.from(hex.padStart(width * 2, "0"), "hex"));
}

/** `PAD(value)` for a group: exactly `group.widthBytes` bytes. */
export function srpPad(group: SrpGroup, value: bigint): Uint8Array {
	return srpBigIntToBytes(value, group.widthBytes);
}

/**
 * `base^exponent mod modulus`, right-to-left square-and-multiply.
 *
 * FOR PUBLIC EXPONENTS ONLY. Its operation count is the exponent's Hamming
 * weight, so a secret exponent must go through `srpSecretModPow` instead. The
 * one production caller is `v^u`, whose exponent is a hash of two values that
 * travelled on the wire in cleartext. Tests use it freely, including as the
 * independent implementation that cross-checks the fixed-window path.
 */
export function srpModPow(
	base: bigint,
	exponent: bigint,
	modulus: bigint,
): bigint {
	if (modulus <= 0n) {
		throw new SrpError("modulus must be positive");
	}
	if (exponent < 0n) {
		throw new SrpError("exponent must be non-negative");
	}
	let result = 1n;
	let acc = base % modulus;
	if (acc < 0n) acc += modulus;
	let remaining = exponent;
	while (remaining > 0n) {
		if ((remaining & 1n) === 1n) {
			result = (result * acc) % modulus;
		}
		acc = (acc * acc) % modulus;
		remaining >>= 1n;
	}
	return result;
}

// ---------------------------------------------------------------------------
// the secret-exponent ladder
// ---------------------------------------------------------------------------

/** Secret exponents are always this wide; shorter inputs are zero-extended. */
const SECRET_EXPONENT_BYTES = 32;
const SECRET_WINDOW_BITS = 4;
/** 64 nibbles over 32 bytes — the loop count, and it is a CONSTANT on purpose. */
const SECRET_WINDOWS = (SECRET_EXPONENT_BYTES * 8) / SECRET_WINDOW_BITS;
const SECRET_TABLE_SIZE = 1 << SECRET_WINDOW_BITS;

/**
 * TEST SEAM. Counts the ladder's squarings and multiplies so a test can prove
 * that two exponents of very different Hamming weight cost exactly the same
 * operations. `null` in production; nothing about the arithmetic depends on it.
 */
export interface SrpOperationCounts {
	squarings: number;
	multiplies: number;
}

let operationCounts: SrpOperationCounts | null = null;

/** Install (or clear, with `null`) the counter above. Tests only. */
export function srpSetOperationCounts(counts: SrpOperationCounts | null): void {
	operationCounts = counts;
}

/**
 * `base^exponent mod N` for a SECRET exponent: a FIXED 4-bit-window ladder.
 *
 * WHY THIS SHAPE. `x` (a deterministic function of the 8-digit code) and `b`
 * (this candidate's private value) are the two secret exponents in the exchange,
 * and a textbook square-and-multiply performs one multiply per SET bit — so its
 * total work is the exponent's Hamming weight, which is a coarse leak that
 * survives being measured over a network. This ladder removes that leak by
 * construction: it always walks all 64 nibbles of a zero-extended 32-byte
 * exponent, and every window costs exactly 4 squarings and exactly 1 multiply,
 * whatever the nibble is. `table[0]` is `N + 1` rather than `1` for that last
 * reason — `N + 1` is congruent to 1 but is a full-width operand, so a zero
 * nibble buys a full-width multiply rather than a conspicuously cheap one.
 *
 * WHY NOT A NATIVE ENGINE. The obvious alternative — `node:crypto`'s
 * `DiffieHellman` as an exponentiation engine, reaching OpenSSL's hardened
 * `BN_mod_exp` — was implemented and MEASURED, and it is not shippable here:
 * constructing the group object costs ~2.4 SECONDS on the Electron/BoringSSL
 * runtime this app ships (Electron 41 / Node 24, win-arm64), on the main
 * thread, once per exponent, triggerable by an unauthenticated public request.
 * Reusing one object across exponents is worse, not better: `setPrivateKey`
 * makes it RETAIN the last secret exponent indefinitely. Electron's BoringSSL
 * also rejects the `KeyObject` DH import that would have avoided the
 * constructor (`ERR_OSSL_EVP_UNSUPPORTED_ALGORITHM`). This ladder was measured
 * on that same runtime at ~2.8-3.3 ms per exponentiation, ~10 ms for a whole
 * kex, and it agrees with naive square-and-multiply on every value.
 *
 * HONEST LIMIT — STATED, NOT DEFENDED. This is not constant time. `BigInt`
 * multiplication and `%` are library routines with data-dependent internals, and
 * nothing here changes that; what is fixed is the OPERATION SEQUENCE, not the
 * cost of each operation. That is judged sufficient for these two exponents:
 * `x` is computed once when the window opens, locally, with no attacker request
 * in flight, and a fresh `b` is drawn per candidate and used for exactly two
 * exponentiations before being dropped, so there is no stable secret for a
 * remote attacker to average timings over. Exponent blinding was considered and
 * rejected — at ~100-250 ms per exchange it would buy no protection this
 * threat model can actually spend.
 */
export function srpSecretModPow(
	group: SrpGroup,
	base: bigint,
	exponent: Uint8Array,
): bigint {
	if (exponent.length > SECRET_EXPONENT_BYTES) {
		throw new SrpError(
			`secret exponent must be at most ${SECRET_EXPONENT_BYTES} bytes, got ${exponent.length}`,
		);
	}
	const N = group.N;
	let acc = base % N;
	if (acc < 0n) acc += N;

	// table[i] = base^i mod N, except table[0], which is the full-width 1.
	const table = new Array<bigint>(SECRET_TABLE_SIZE);
	table[0] = N + 1n;
	let power = acc;
	table[1] = power;
	for (let i = 2; i < SECRET_TABLE_SIZE; i += 1) {
		power = (power * acc) % N;
		table[i] = power;
	}

	// Zero-extended on the LEFT: the exponent is an unsigned big-endian integer,
	// so a 20-byte SHA-1 `x` is the same number as its 32-byte form and must walk
	// the same 64 windows.
	const wide = new Uint8Array(SECRET_EXPONENT_BYTES);
	wide.set(exponent, SECRET_EXPONENT_BYTES - exponent.length);

	let result = 1n;
	for (let window = 0; window < SECRET_WINDOWS; window += 1) {
		for (let square = 0; square < SECRET_WINDOW_BITS; square += 1) {
			result = (result * result) % N;
		}
		const byte = wide[window >> 1] as number;
		const nibble = (window & 1) === 0 ? byte >> 4 : byte & 0x0f;
		result = (result * (table[nibble] as bigint)) % N;
		if (operationCounts !== null) {
			operationCounts.squarings += SECRET_WINDOW_BITS;
			operationCounts.multiplies += 1;
		}
	}
	wide.fill(0);
	return result;
}

function digest(group: SrpGroup, ...parts: readonly Uint8Array[]): Uint8Array {
	const hash = createHash(group.hashAlgorithm);
	for (const part of parts) {
		hash.update(Buffer.from(part.buffer, part.byteOffset, part.byteLength));
	}
	return new Uint8Array(hash.digest());
}

// ---------------------------------------------------------------------------
// SRP-6a quantities
// ---------------------------------------------------------------------------

/**
 * `x = H(salt || H(I || ':' || P))` (RFC 5054 §2.4), as its RAW BIG-ENDIAN
 * BYTES — which is exactly what an exponent wants, and deliberately not a
 * `bigint`: `x` is the one long-lived secret exponent in the exchange, and
 * bytes can at least be overwritten when the caller is done with them.
 *
 * `I` and `P` contribute their ASCII bytes with a single `0x3A` between them.
 * The inner hash is what keeps the identity and the password out of the
 * verifier's derivation as separable values.
 */
export function srpComputeX(
	group: SrpGroup,
	salt: Uint8Array,
	identity: string,
	password: string,
): Uint8Array {
	const inner = digest(
		group,
		new Uint8Array(Buffer.from(`${identity}:${password}`, "ascii")),
	);
	const x = digest(group, salt, inner);
	inner.fill(0);
	return x;
}

/**
 * `v = g^x mod N`, with `x` as the secret exponent it is — so this runs on the
 * fixed-window ladder, not on `srpModPow`. See `srpSecretModPow`.
 */
export function srpComputeVerifier(group: SrpGroup, x: Uint8Array): bigint {
	return srpSecretModPow(group, group.g, x);
}

/**
 * `k = H(PAD(N) || PAD(g))` — SRP-6a's multiplier, and the difference between
 * SRP-6a and the SRP-6 that a `k` of 3 would give you. Matching Bouncy Castle
 * and RFC 5054 here is what makes the phone's `B` check agree with this one.
 */
export function srpComputeK(group: SrpGroup): bigint {
	return srpBytesToBigInt(
		digest(group, srpPad(group, group.N), srpPad(group, group.g)),
	);
}

/** `u = H(PAD(A) || PAD(B))`. */
export function srpComputeU(
	group: SrpGroup,
	clientPublic: bigint,
	serverPublic: bigint,
): bigint {
	return srpBytesToBigInt(
		digest(group, srpPad(group, clientPublic), srpPad(group, serverPublic)),
	);
}

/**
 * The §4.9 boundary check on the client's `A`, run BEFORE any derivation.
 *
 * RFC 5054's rule is `A mod N != 0`, and the strict range check below is
 * STRONGER than it: nothing in `(0, N)` is `0 mod N`, and `A >= N` is refused
 * outright rather than reduced — a value outside the group is a broken or
 * hostile peer, never a number to normalise. `A == 1` and `A == N-1` are refused
 * on top, because both collapse `S` to something computable from the PUBLIC
 * transcript plus a guess at the verifier's exponent, which is exactly the
 * offline oracle this exchange exists to deny.
 */
export function srpAssertClientPublic(group: SrpGroup, A: bigint): void {
	if (A <= 0n || A >= group.N) {
		throw new SrpError("client public value is outside (0, N)");
	}
	if (A === 1n || A === group.N - 1n) {
		throw new SrpError("client public value is a degenerate point");
	}
}

export interface SrpServerHandshake {
	/** `PAD(B)`, `group.widthBytes` bytes. Goes on the wire and into the transcript. */
	serverPublic: Uint8Array;
	/**
	 * `PAD(S)`, `group.widthBytes` bytes.
	 *
	 * THE CALLER MUST ZERO THIS as soon as it has extracted a PRK from it. It is
	 * returned rather than kept because this module holds no state; keeping it
	 * anywhere is the caller's decision to get wrong, so the contract is stated
	 * here and enforced by the caller doing it in a `finally`.
	 */
	sharedSecret: Uint8Array;
}

/**
 * One SRP-6a server exchange: validate `A`, derive `B` and `S` from a FRESH
 * `b`, and hand back the two padded byte strings the protocol needs.
 *
 * `b` is supplied rather than minted here so the deterministic vectors can pin
 * an exchange end to end. Production passes 32 CSPRNG bytes and passes fresh
 * ones for EVERY accepted candidate — never per window, never reused. Reusing
 * `b` across two candidates would let the second candidate's `A` be chosen with
 * knowledge of the first's `B`, which is the one freedom SRP does not grant an
 * attacker.
 */
export function srpServerHandshake(input: {
	group: SrpGroup;
	/** `v = g^x mod N`, derived once per window from the displayed code. */
	verifier: bigint;
	/** `PAD(A)` exactly as it arrived, `group.widthBytes` bytes. */
	clientPublic: Uint8Array;
	/** `b`, at least 32 bytes of CSPRNG output. */
	privateExponent: Uint8Array;
}): SrpServerHandshake {
	const { group, verifier, clientPublic, privateExponent } = input;

	if (clientPublic.length !== group.widthBytes) {
		throw new SrpError(
			`client public value must be exactly ${group.widthBytes} bytes, got ${clientPublic.length}`,
		);
	}
	const A = srpBytesToBigInt(clientPublic);
	srpAssertClientPublic(group, A);

	if (srpBytesToBigInt(privateExponent) === 0n) {
		throw new SrpError("server private exponent is zero");
	}
	// ONE `b`, two exponentiations: `g^b` for B and `(A * v^u)^b` for S. Both run
	// on the fixed-window ladder because `b` is secret; the `v^u` in between does
	// not, because `u` is a hash of two values that are public on the wire.
	const k = srpComputeK(group);
	const B =
		(((k * verifier) % group.N) +
			srpSecretModPow(group, group.g, privateExponent)) %
		group.N;
	if (B % group.N === 0n) {
		// Unreachable for any real verifier, and a silent zero here would be a
		// server public value the phone must reject anyway.
		throw new SrpError("server public value is 0 mod N");
	}

	const u = srpComputeU(group, A, B);
	if (u === 0n) {
		// RFC 5054: `u == 0` makes S independent of the verifier, so both sides
		// would agree on a key that proves nothing about the password.
		throw new SrpError("u is zero");
	}

	// S = (A * v^u)^b mod N
	const base = (A * srpModPow(verifier, u, group.N)) % group.N;
	const S = srpSecretModPow(group, base, privateExponent);

	return {
		serverPublic: srpPad(group, B),
		sharedSecret: srpPad(group, S),
	};
}
