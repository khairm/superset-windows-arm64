/**
 * (REMOTE-CODE-PAIRING) The remote 8-digit pairing flow, end to end, plus the
 * four properties the whole design rests on:
 *
 *  - the QR/LAN key schedule is UNCHANGED, byte for byte (golden vectors);
 *  - the two flows are domain-separated, so a code-derived key and a
 *    QR-derived key can never collide;
 *  - the SRP transcript is not an OFFLINE oracle for the 8 digits; and
 *  - the pairing paths are reachable on the public pairing host and NOWHERE
 *    else, while every other path is reachable on the main host and nowhere
 *    else.
 *
 * The golden vectors are pinned hex. If a change to `pairing.ts` moves them,
 * that change has altered the wire contract with an Android client that has its
 * own frozen copy of the same numbers, and the test failing is the point.
 *
 * The SRP arithmetic itself is checked in `srp.test.ts`, against RFC 5054
 * Appendix B's published values rather than against itself.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	BRIDGE_PUBLIC_HOST,
	HKDF_LABEL_REMOTE_CONFIRM_DESKTOP,
	HKDF_LABEL_REMOTE_CONFIRM_PHONE,
	HKDF_LABEL_REMOTE_DEVICE,
	HKDF_LABEL_SEAL_C2S,
	HKDF_LABEL_SEAL_S2C,
	loadPublicPairHost,
	PAIRING_PUBLIC_HOST,
	PAIRING_REMOTE_HKDF_SALT_PREFIX,
	PAIRING_REMOTE_TRANSCRIPT_PREFIX,
	PAIRING_SRP_IDENTITY,
	PAIRING_TRANSCRIPT_PREFIX,
	REMOTE_PAIR_MAX_REQUESTS_PER_WINDOW,
	REMOTE_PAIR_PATH_BEGIN,
	REMOTE_PAIR_PATH_CONFIRM,
	REMOTE_PAIR_PATH_KEX,
	REMOTE_PAIR_REQUESTS_PER_SOURCE,
	resolveCompanionPaths,
} from "./config";
import {
	base64UrlDecode,
	base64UrlEncode,
	buildRequestAad,
	hkdfExpandInfo,
	hkdfExpandLabel,
	hkdfExtract,
	hkdfInfoWithSuffix,
	hmacSha256,
	openSealed,
	parseEnvelope,
	randomBytes,
} from "./crypto";
import {
	type BridgeHttpServerDeps,
	type BridgeLogger,
	createBridgeHttpServer,
	handleRemotePairRequest,
	type RemotePairRouteDeps,
	routeByHost,
} from "./http";
import { KEY_BYTES, WIRE_ID_BYTES } from "./limits";
import {
	buildPairingTranscript,
	buildSrpPairingTranscript,
	currentRemotePairing,
	derivePairingKeys,
	type KexWipeReport,
	LAN_PAIRING_PROFILE,
	MAX_PAIR_BODY_BYTES,
	openPairingWindow,
	openRemotePairing,
	type PairingWindowHandleBase,
	type RemotePairingDeps,
	type RemotePairingWindowHandle,
	setKexWipeObserverForTest,
} from "./pairing";
import {
	SRP_3072_SHA256,
	srpBytesToBigInt,
	srpComputeK,
	srpComputeU,
	srpComputeVerifier,
	srpComputeX,
	srpModPow,
	srpPad,
	srpServerHandshake,
} from "./srp";
import { CleartextError } from "./types";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const ACCESS_SECRET = "a".repeat(64);
const SRP_WIDTH = SRP_3072_SHA256.widthBytes;

function fill(length: number, start: number): Uint8Array {
	const out = new Uint8Array(length);
	for (let i = 0; i < length; i += 1) out[i] = (start + i) & 0xff;
	return out;
}

function hex(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("hex");
}

function fromHex(value: string): Uint8Array {
	return new Uint8Array(Buffer.from(value, "hex"));
}

function ascii(value: string): Uint8Array {
	return new Uint8Array(Buffer.from(value, "ascii"));
}

function concat(...parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

const openHandles: PairingWindowHandleBase[] = [];

async function openCodeWindow(
	overrides: Partial<RemotePairingDeps> = {},
): Promise<RemotePairingWindowHandle> {
	const handle = await openRemotePairing({
		loadAccessToken: async () => ({
			clientId: "c6d1295b4ed520de15de3446b9ec736b.access",
			clientSecret: ACCESS_SECRET,
		}),
		onPaired: async () => undefined,
		...overrides,
	});
	openHandles.push(handle);
	return handle;
}

afterEach(async () => {
	for (const handle of openHandles.splice(0)) {
		await handle.close();
	}
});

function recordingLogger(): BridgeLogger & { lines: string[] } {
	const lines: string[] = [];
	const write = (level: string) => (message: string, fields?: unknown) => {
		lines.push(`${level} ${message} ${JSON.stringify(fields ?? null)}`);
	};
	return {
		lines,
		info: write("info"),
		warn: write("warn"),
		error: write("error"),
	};
}

function routeDeps(
	overrides: Partial<RemotePairRouteDeps> = {},
): RemotePairRouteDeps {
	return {
		logger: recordingLogger(),
		// The burn memo is module state with a 60 s life, so every test that is not
		// ABOUT the memo pins it off rather than inheriting the previous test's.
		burned: () => false,
		...overrides,
	};
}

function pairRequest(
	path: string,
	body: unknown,
	source: string | null = "203.0.113.7",
): Request {
	const headers: Record<string, string> = {
		"content-type": "application/json",
		// EXPLICIT. A `Request` built in a test carries no `Host` header of its own,
		// and the host gate reads the HEADER — deliberately, since that is the only
		// thing a real listener sees. Leaving it off would make every assembled-app
		// request a bare 404 and the whole matrix vacuously green.
		host: PAIRING_PUBLIC_HOST,
	};
	if (source !== null) headers["cf-connecting-ip"] = source;
	return new Request(`https://${PAIRING_PUBLIC_HOST}${path}`, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	});
}

// ---------------------------------------------------------------------------
// golden vectors — the QR flow must not have moved
// ---------------------------------------------------------------------------

const VECTOR_D_PRIV = fill(32, 1);
const VECTOR_P_PUB = fromHex(
	"eaa91977e3fffdf299dc8172f6ccbd96a7b364ae4c7ddfc36bdc562129aed94d",
);
const VECTOR_D_PUB = fill(32, 0x60);
const VECTOR_PAIR_SALT = fill(16, 0x40);
const VECTOR_PID = fill(16, 0x10);
const VECTOR_DEVICE_ID = fill(16, 0x20);
const VECTOR_QR_CODE = fill(32, 0x80);

describe("(REMOTE-CODE-PAIRING) the QR flow's bytes are frozen", () => {
	it("derives the pinned QR-flow key schedule", () => {
		const keys = derivePairingKeys({
			dPriv: VECTOR_D_PRIV,
			pPub: VECTOR_P_PUB,
			pairingCode: VECTOR_QR_CODE,
			pairSalt: VECTOR_PAIR_SALT,
			pidBytes: VECTOR_PID,
			deviceIdBytes: VECTOR_DEVICE_ID,
			profile: LAN_PAIRING_PROFILE,
		});
		expect(hex(keys.deviceKey)).toBe(
			"321e4ae94deb892e65734915f75a3fca27ecbe8209d2161eda5afc31129457a3",
		);
		expect(hex(keys.confirmPhone)).toBe(
			"6164a3270ebfd4c1cacc4e71c9735215e7a7683a73ed29166676f9daabd97135",
		);
		expect(hex(keys.confirmDesktop)).toBe(
			"f7fd747ab2af08d96455fe05a8a9321dab529e322d2389bb205a40bd5a86c880",
		);
	});

	it("builds the pinned 117-byte QR-flow transcript", () => {
		const transcript = buildPairingTranscript({
			pid: VECTOR_PID,
			deviceId: VECTOR_DEVICE_ID,
			pPub: VECTOR_P_PUB,
			dPub: VECTOR_D_PUB,
			pairSalt: VECTOR_PAIR_SALT,
		});
		expect(transcript.length).toBe(117);
		expect(hex(transcript)).toBe(
			"73632f7631101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2feaa91977e3fffdf299dc8172f6ccbd96a7b364ae4c7ddfc36bdc562129aed94d606162636465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f404142434445464748494a4b4c4d4e4f",
		);
	});

	it("has no caller-supplied prefix to get wrong", () => {
		// The prefix is hardcoded inside the builder, so there is no second way to
		// build a QR transcript and nothing a caller can pass that changes these
		// bytes. This asserts the shape the golden vector above pins.
		const built = buildPairingTranscript({
			pid: VECTOR_PID,
			deviceId: VECTOR_DEVICE_ID,
			pPub: VECTOR_P_PUB,
			dPub: VECTOR_D_PUB,
			pairSalt: VECTOR_PAIR_SALT,
		});
		expect(built.length).toBe(ascii(PAIRING_TRANSCRIPT_PREFIX).length + 112);
		expect(hex(built).startsWith(hex(ascii(PAIRING_TRANSCRIPT_PREFIX)))).toBe(
			true,
		);
	});
});

// ---------------------------------------------------------------------------
// the SRP profile's frozen vectors — shared with the Android client
// ---------------------------------------------------------------------------

/**
 * A complete SRP-6a exchange from FIXED inputs, computed the long way round —
 * primitives only, no call into `pairing.ts`'s handlers.
 *
 * This is the reference the Android client is checked against and it doubles as
 * the reference client: the `a` side is computed here exactly as a phone would
 * (`S = (B - k*g^x)^(a + u*x) mod N`), so a green run proves the two sides agree
 * rather than proving the desktop agrees with itself.
 */
function srpVectorCase(input: {
	code: string;
	pairSalt: Uint8Array;
	pid: Uint8Array;
	deviceId: Uint8Array;
	/** Client private value. */
	a: bigint;
	/** Server private value, raw bytes. */
	b: Uint8Array;
}) {
	const group = SRP_3072_SHA256;
	const { N, g } = group;

	const xBytes = srpComputeX(
		group,
		input.pairSalt,
		PAIRING_SRP_IDENTITY,
		input.code,
	);
	const x = srpBytesToBigInt(xBytes);
	const verifier = srpComputeVerifier(group, xBytes);
	const k = srpComputeK(group);

	const A = srpModPow(g, input.a, N);
	const B =
		(((k * verifier) % N) + srpModPow(g, srpBytesToBigInt(input.b), N)) % N;
	const u = srpComputeU(group, A, B);

	const serverS = srpModPow(
		(A * srpModPow(verifier, u, N)) % N,
		srpBytesToBigInt(input.b),
		N,
	);
	// The PHONE's half, independently: S = (B - k*g^x)^(a + u*x) mod N.
	const clientS = srpModPow(
		(((B - ((k * srpModPow(g, x, N)) % N)) % N) + N) % N,
		input.a + u * x,
		N,
	);

	const padA = srpPad(group, A);
	const padB = srpPad(group, B);
	const padS = srpPad(group, serverS);

	const salt = concat(ascii(PAIRING_REMOTE_HKDF_SALT_PREFIX), input.pairSalt);
	const prk = hkdfExtract(salt, padS);
	const deviceKey = hkdfExpandInfo(
		prk,
		hkdfInfoWithSuffix(HKDF_LABEL_REMOTE_DEVICE, input.pid, input.deviceId),
		KEY_BYTES,
	);
	const confirmPhone = hkdfExpandLabel(
		prk,
		HKDF_LABEL_REMOTE_CONFIRM_PHONE,
		KEY_BYTES,
	);
	const confirmDesktop = hkdfExpandLabel(
		prk,
		HKDF_LABEL_REMOTE_CONFIRM_DESKTOP,
		KEY_BYTES,
	);
	const transcript = buildSrpPairingTranscript({
		pid: input.pid,
		deviceId: input.deviceId,
		clientPublic: padA,
		serverPublic: padB,
		pairSalt: input.pairSalt,
	});

	return {
		x: xBytes,
		verifier,
		A: padA,
		B: padB,
		u,
		S: padS,
		clientS,
		serverS,
		prk,
		deviceKey,
		confirmPhone,
		confirmDesktop,
		transcript,
		macPhone: hmacSha256(confirmPhone, transcript),
		macDesktop: hmacSha256(confirmDesktop, transcript),
	};
}

/**
 * CROSS-RUNTIME DIFFERENTIAL VECTORS, frozen jointly with the Android client.
 *
 * Both sides hold these same numbers, and both sides reached them INDEPENDENTLY
 * — these bytes came out of this TypeScript (node:crypto, OpenSSL modexp) and
 * out of a standalone Java program on the phone side (BouncyCastle for the SRP
 * math, hand-written RFC 5869 HKDF), and they agreed on every value with no
 * shared code between them. If either side ever moves, pairing fails as
 * `pair_code_wrong` forever and neither end can say why, which is what makes
 * this the most load-bearing test in the file.
 *
 * CASE 2's code has LEADING ZEROS on purpose: it is the case that catches a
 * runtime treating the 8-digit code as a number rather than as 8 ASCII bytes.
 */
const CASE_1 = {
	code: "12345678",
	pairSalt: fromHex("a0a1a2a3a4a5a6a7a8a9aaabacadaeaf"),
	pid: fromHex("101112131415161718191a1b1c1d1e1f"),
	deviceId: fromHex("202122232425262728292a2b2c2d2e2f"),
	a: srpBytesToBigInt(
		fromHex("808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f"),
	),
	b: fromHex(
		"c0c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcdddedf",
	),
} as const;

const CASE_2 = {
	code: "00000042",
	pairSalt: fromHex("0102030405060708090a0b0c0d0e0f10"),
	pid: fromHex("f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff"),
	deviceId: fromHex("7778797a7b7c7d7e7f80818283848586"),
	a: srpBytesToBigInt(
		fromHex("0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20"),
	),
	b: fromHex(
		"2122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f40",
	),
} as const;

describe("(REMOTE-CODE-PAIRING) the SRP profile's frozen vectors", () => {
	const vector = srpVectorCase(CASE_1);
	const vector2 = srpVectorCase(CASE_2);

	it("both sides agree on S", () => {
		expect(vector.clientS).toBe(vector.serverS);
		expect(vector2.clientS).toBe(vector2.serverS);
	});

	it("pins every derived value — case 1", () => {
		expect(hex(vector.x)).toBe(
			"f300ea7df6383be171c9a365b5d35a9cfbfbe2f64316f711457ff92578c56401",
		);
		expect(vector.A.length).toBe(SRP_WIDTH);
		expect(vector.B.length).toBe(SRP_WIDTH);
		expect(vector.S.length).toBe(SRP_WIDTH);
		expect(vector.transcript.length).toBe(825);
		expect(hex(srpPad(SRP_3072_SHA256, vector.u)).slice(-64)).toBe(
			"2543571270b40a18735495b91ffaa22bf15313c82e18106254599eff07846f83",
		);
		expect(hex(vector.prk)).toBe(
			"7d5080647a179ec9823cbddb859b3fbff95066b2c0092281ee6eae164e3e6756",
		);
		expect(hex(vector.deviceKey)).toBe(
			"3636fd4362401a9d9325103ad1f75df4ffbd152ec01cf364325a59830238bd04",
		);
		expect(hex(vector.confirmPhone)).toBe(
			"69c10ce79675ee513934e3c2b3743af22f344bb70c85c6a9148bf3e950bf96b7",
		);
		expect(hex(vector.confirmDesktop)).toBe(
			"d188415293772cfd09a7dfff192402e32e4b5c5a07eb5d5c2b230906ce092386",
		);
		expect(hex(vector.macPhone)).toBe(
			"678815db4ef47d0f9576bb551005a6d879b41976b669d33ddab4f8aba1022248",
		);
		expect(hex(vector.macDesktop)).toBe(
			"9b2ffbafa03094dea2e79914bbded1b4dd1c93fb7b0cbf0021b707506b8a11c8",
		);
	});

	it("pins the padded public values — case 1", () => {
		// First and last 32 bytes of each, which is what the phone side published;
		// a padding bug shows up at exactly these two ends.
		expect(hex(vector.A.slice(0, 32))).toBe(
			"ccca32f3b34e28414ef721be45fd36a3cff2fda6d28237d3b5769850cc4ac93c",
		);
		expect(hex(vector.A.slice(-32))).toBe(
			"29aa3deab6e854c03f7520cd5d0f446818914b06d41a5a68b42619fedf09dcd3",
		);
		expect(hex(vector.B.slice(0, 32))).toBe(
			"e2ac91b45dc17709aaec802e1a104bb787de2c9fdb973d39deb226cfc1fcdb93",
		);
		expect(hex(vector.B.slice(-32))).toBe(
			"e962fc4176d9defb44d533d1ceee132a1fc5b62e428b940bba5f733745149726",
		);
		expect(hex(vector.S.slice(0, 32))).toBe(
			"b81eae5cdf0d62cd25466ff8ebb0bfe08d88868fbc30ad3e9e737c736d146a40",
		);
		expect(hex(vector.S.slice(-32))).toBe(
			"afe182480d46d7252e05f24a531dff55c25bfccc8d9022493b817858d6353391",
		);
	});

	it("pins every derived value — case 2, a code with leading zeros", () => {
		expect(hex(vector2.x)).toBe(
			"d46cfbe56b9158e7994339367c8b89039a0302ca33b99f8488b15da8b0aebf65",
		);
		expect(vector2.transcript.length).toBe(825);
		expect(hex(srpPad(SRP_3072_SHA256, vector2.u)).slice(-64)).toBe(
			"f1032305eaa5027190767dd6cab2bf7b191c273a2cbf138a426a02aec98418c4",
		);
		expect(hex(vector2.prk)).toBe(
			"c923080b3faf9c6217ee1694bfd209d0beb988afd0bdebd62d2115e883498580",
		);
		expect(hex(vector2.deviceKey)).toBe(
			"ef304b78a65c83baed98fce4d85854f47000126b825212500f52ce66a9059119",
		);
		expect(hex(vector2.confirmPhone)).toBe(
			"91410a9aa7642b133d2d0e57ec57b784c9987f1731996414eea1e130756df2fe",
		);
		expect(hex(vector2.confirmDesktop)).toBe(
			"4ba194102688ee7342eb10853d133869f8307116bf90ba89d4747df757b5d6e9",
		);
		expect(hex(vector2.macPhone)).toBe(
			"97acacb133c63b3f5e71aaad4f8aaafe9e4b1b480cb2258f5cfccb236739124d",
		);
		expect(hex(vector2.macDesktop)).toBe(
			"90573a21b0d6da3b114b9b63d2be4ec17789d403ac7e3432134188096090e53f",
		);
		expect(hex(vector2.S.slice(0, 32))).toBe(
			"f91ffaa67de56fd827155c1070411b30f0f84bd2aed123141540d88b24a15664",
		);
		expect(hex(vector2.S.slice(-32))).toBe(
			"e1a507041613e2bdfd203996f95cb1751206f89b2442d5723aa5fbf82591489f",
		);
	});

	it("the code is 8 ASCII BYTES, so 00000042 is not 42", () => {
		const asNumber = srpVectorCase({ ...CASE_2, code: "42" });
		expect(hex(asNumber.x)).not.toBe(hex(vector2.x));
		expect(hex(asNumber.macPhone)).not.toBe(hex(vector2.macPhone));
	});

	it("the production handshake reproduces the frozen B and S", () => {
		// The vector above is computed the long way round with pure BigInt; this is
		// the code path that actually runs in production, with OpenSSL doing the
		// secret exponentiations. A divergence here is a runtime bug, not a
		// protocol one, and it would be invisible until a real phone failed.
		for (const [input, expected] of [
			[CASE_1, vector],
			[CASE_2, vector2],
		] as const) {
			const handshake = srpServerHandshake({
				group: SRP_3072_SHA256,
				verifier: expected.verifier,
				clientPublic: expected.A,
				privateExponent: input.b,
			});
			expect(hex(handshake.serverPublic)).toBe(hex(expected.B));
			expect(hex(handshake.sharedSecret)).toBe(hex(expected.S));
		}
	});

	it("the steady-state keys still hang off K_dev with the sc/v1 seal labels", () => {
		// A device paired by code speaks exactly the same protocol afterwards as
		// one paired by QR.
		expect(
			hex(hkdfExpandLabel(vector.deviceKey, HKDF_LABEL_SEAL_S2C, KEY_BYTES)),
		).toBe("5bf3c2d88eee82cc7eb2d3bea3888e11adcb9239b862add155a72d96869a5230");
		expect(
			hex(hkdfExpandLabel(vector.deviceKey, HKDF_LABEL_SEAL_C2S, KEY_BYTES)),
		).toBe("b317f17d73c7bf8676c420386b2e425f2429e72008ca93f31c350690802f5f6c");
		expect(
			hex(hkdfExpandLabel(vector2.deviceKey, HKDF_LABEL_SEAL_S2C, KEY_BYTES)),
		).toBe("b02ea599f6d693b65f90be815aacdf1b763b906e85b7d480fee3a347393eb176");
		expect(
			hex(hkdfExpandLabel(vector2.deviceKey, HKDF_LABEL_SEAL_C2S, KEY_BYTES)),
		).toBe("ea5dd464b2570f9b7a66b2a86a35e2949f94964a70ec922c26ac2d9e1c179b3e");
	});

	it("the transcript prefix domain-separates the two flows", () => {
		expect(PAIRING_REMOTE_TRANSCRIPT_PREFIX).toBe("sc/v3-srp");
		expect(PAIRING_TRANSCRIPT_PREFIX).toBe("sc/v1");
		expect(hex(vector.transcript).startsWith(hex(ascii("sc/v3-srp")))).toBe(
			true,
		);
	});

	it("a different code gives a completely different key schedule", () => {
		const other = srpVectorCase({ ...CASE_1, code: "12345679" });
		expect(hex(other.deviceKey)).not.toBe(hex(vector.deviceKey));
		expect(hex(other.macPhone)).not.toBe(hex(vector.macPhone));
	});
});

// ---------------------------------------------------------------------------
// route isolation — the whole host x method x path matrix
// ---------------------------------------------------------------------------

describe("(REMOTE-CODE-PAIRING) the two hosts serve disjoint surfaces", () => {
	const PAIR_PATHS = [
		REMOTE_PAIR_PATH_BEGIN,
		REMOTE_PAIR_PATH_KEX,
		REMOTE_PAIR_PATH_CONFIRM,
	] as const;
	const OTHER_PATHS = [
		"/v1/ping",
		"/v1/hello",
		"/v1/answer",
		"/v1/events",
		"/v1/panic",
		"/",
		"/v1/pair",
		"/v1/pair/",
		"/v1/pair/kex/",
		"/v1/pair/begin/x",
	];
	const METHODS = ["GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS", "PATCH"];

	function verdict(hostHeader: string | null, method: string, path: string) {
		return routeByHost({
			hostHeader,
			method,
			path,
			publicPairHost: PAIRING_PUBLIC_HOST,
		});
	}

	it("the pairing host serves the three pairing paths by POST and nothing else", () => {
		for (const path of PAIR_PATHS) {
			for (const method of METHODS) {
				const result = verdict(PAIRING_PUBLIC_HOST, method, path);
				if (method === "POST") {
					expect(result).toEqual({ kind: "pair", path });
				} else {
					expect(result.kind).toBe("not-found");
				}
			}
		}
		for (const path of OTHER_PATHS) {
			for (const method of METHODS) {
				expect(verdict(PAIRING_PUBLIC_HOST, method, path).kind).toBe(
					"not-found",
				);
			}
		}
	});

	it("the main host 404s the pairing paths and keeps everything else", () => {
		for (const path of PAIR_PATHS) {
			for (const method of METHODS) {
				expect(verdict(BRIDGE_PUBLIC_HOST, method, path).kind).toBe(
					"not-found",
				);
			}
		}
		for (const path of OTHER_PATHS) {
			for (const method of METHODS) {
				// `main` means "carry on into the ordinary Access-validated router".
				expect(verdict(BRIDGE_PUBLIC_HOST, method, path).kind).toBe("main");
			}
		}
	});

	it("an unknown or missing Host reaches nothing at all", () => {
		for (const host of [
			null,
			"",
			"   ",
			"localhost",
			"127.0.0.1",
			"[::1]",
			"evil.example",
			`${PAIRING_PUBLIC_HOST}.evil.example`,
			`evil.example,${PAIRING_PUBLIC_HOST}`,
			`${BRIDGE_PUBLIC_HOST},${PAIRING_PUBLIC_HOST}`,
		]) {
			for (const path of [...PAIR_PATHS, ...OTHER_PATHS]) {
				expect(verdict(host, "POST", path).kind).toBe("not-found");
			}
		}
	});

	it("normalises port, case and the root dot, and nothing else", () => {
		for (const host of [
			PAIRING_PUBLIC_HOST,
			`${PAIRING_PUBLIC_HOST}:47610`,
			PAIRING_PUBLIC_HOST.toUpperCase(),
			`${PAIRING_PUBLIC_HOST}.`,
			`  ${PAIRING_PUBLIC_HOST}:443  `,
		]) {
			expect(verdict(host, "POST", REMOTE_PAIR_PATH_KEX).kind).toBe("pair");
		}
		expect(verdict(`${BRIDGE_PUBLIC_HOST}:47610`, "GET", "/v1/ping").kind).toBe(
			"main",
		);
	});

	it("with remote pairing off, the pairing host reaches nothing", () => {
		for (const path of PAIR_PATHS) {
			expect(
				routeByHost({
					hostHeader: PAIRING_PUBLIC_HOST,
					method: "POST",
					path,
					publicPairHost: null,
				}).kind,
			).toBe("not-found");
			// ...and the main host still refuses them, so they exist NOWHERE.
			expect(
				routeByHost({
					hostHeader: BRIDGE_PUBLIC_HOST,
					method: "POST",
					path,
					publicPairHost: null,
				}).kind,
			).toBe("not-found");
		}
		// The main host is otherwise untouched by the feature being off.
		expect(
			routeByHost({
				hostHeader: BRIDGE_PUBLIC_HOST,
				method: "GET",
				path: "/v1/ping",
				publicPairHost: null,
			}).kind,
		).toBe("main");
	});
});

// ---------------------------------------------------------------------------
// the window: one at a time, single use, burned, gone
// ---------------------------------------------------------------------------

describe("(REMOTE-CODE-PAIRING) one window at a time, across both kinds", () => {
	it("mints 8 digits and a reference that is not the code", async () => {
		const handle = await openCodeWindow();
		expect(handle.code).toMatch(/^\d{8}$/);
		// (PAIR-CODE-ASCII) By code point, not by digit class: `srpComputeX` encodes
		// the password as ASCII, so a non-ASCII digit would silently become a
		// verifier no phone could match. The minter asserts this too.
		for (const character of handle.code) {
			const point = character.codePointAt(0) as number;
			expect(point).toBeGreaterThanOrEqual(0x30);
			expect(point).toBeLessThanOrEqual(0x39);
		}
		expect(handle.kind).toBe("remote");
		expect(handle.closed).toBe(false);
		expect(JSON.stringify(handle)).not.toContain(handle.code);
		expect(handle.pairingRef).not.toContain(handle.code);
	});

	it("refuses a second code window", async () => {
		await openCodeWindow();
		await expect(openCodeWindow()).rejects.toThrow(
			"a pairing window is already open",
		);
	});

	it("refuses a QR window while a code window is open", async () => {
		await openCodeWindow();
		await expect(
			openPairingWindow({
				lanHost: "192.168.1.2:47611",
				loadAccessToken: async () => ({
					clientId: "c6d1295b4ed520de15de3446b9ec736b.access",
					clientSecret: ACCESS_SECRET,
				}),
				onPaired: async () => undefined,
			}),
		).rejects.toThrow("a pairing window is already open");
	});

	it("a closed window is no longer reachable and its code is dead", async () => {
		const handle = await openCodeWindow();
		expect(currentRemotePairing()).not.toBeNull();
		await handle.close();
		expect(currentRemotePairing()).toBeNull();
		expect(handle.closed).toBe(true);
		expect(() => handle.code).toThrow("pair_window_closed");
	});

	/**
	 * (PAIR-ONE-WINDOW-ATOMIC) The QR opener AWAITS its bind before it can claim
	 * the slot, and an `await` is where a second opener gets to run. Before the
	 * reservation existed, both opens passed the "already open?" check: the code
	 * window claimed the slot, the QR window overwrote it on bind, and the code
	 * window was left live-but-invisible — unreachable through
	 * `currentRemotePairing` and unclosable through the slot.
	 *
	 * The refusal below is deterministic whether or not the bind succeeds:
	 * `listen` always defers, so the QR open is ALWAYS still pending when the code
	 * open is attempted. What the bind's outcome changes is only which invariant
	 * is checked afterwards, and both are checked.
	 */
	it("refuses a second open while the first is still binding, and frees the slot if that bind fails", async () => {
		const lanOpening = openPairingWindow({
			lanHost: "192.168.1.2:47611",
			loadAccessToken: async () => ({
				clientId: "c6d1295b4ed520de15de3446b9ec736b.access",
				clientSecret: ACCESS_SECRET,
			}),
			onPaired: async () => undefined,
		});

		await expect(openCodeWindow()).rejects.toThrow(
			"a pairing window is already open",
		);
		// The refused open must not have left a half-registered remote window.
		expect(currentRemotePairing()).toBeNull();

		const outcome = await lanOpening.then(
			(handle) => handle,
			(error: Error) => error,
		);
		if (outcome instanceof Error) {
			// 47611 was taken on this machine, so the QR open failed — the
			// reservation must have been RELEASED rather than wedging pairing until
			// the process restarts.
			const recovered = await openCodeWindow();
			expect(recovered.closed).toBe(false);
			expect(currentRemotePairing()).not.toBeNull();
		} else {
			openHandles.push(outcome);
			// The QR window owns the slot, and no remote window is reachable.
			expect(currentRemotePairing()).toBeNull();
			await expect(openCodeWindow()).rejects.toThrow(
				"a pairing window is already open",
			);
		}
	});
});

describe("(REMOTE-CODE-PAIRING) the endpoint does not exist without a window", () => {
	it("answers a bodyless 404, exactly as an unknown path does", async () => {
		const response = await handleRemotePairRequest(
			REMOTE_PAIR_PATH_BEGIN,
			pairRequest(REMOTE_PAIR_PATH_BEGIN, { v: 2 }),
			routeDeps(),
		);
		expect(response.status).toBe(404);
		expect(await response.text()).toBe("");
	});

	it("refuses a request with no single valid source address, unread", async () => {
		await openCodeWindow();
		// `bodyUsed` is the observable for "the handler consumed the body". A
		// throwing ReadableStream cannot be used here: Bun pulls a streaming body
		// at Request CONSTRUCTION, so it would fire before the handler ran and
		// prove nothing. The control case below is what makes `bodyUsed` a signal
		// rather than a constant.
		const control = pairRequest(REMOTE_PAIR_PATH_BEGIN, { v: 2 });
		await handleRemotePairRequest(REMOTE_PAIR_PATH_BEGIN, control, routeDeps());
		expect(control.bodyUsed).toBe(true);

		for (const source of [
			null,
			"",
			"  ",
			"203.0.113.7, 198.51.100.1",
			"nope",
		]) {
			const request = pairRequest(REMOTE_PAIR_PATH_BEGIN, { v: 2 }, source);
			const response = await handleRemotePairRequest(
				REMOTE_PAIR_PATH_BEGIN,
				request,
				routeDeps(),
			);
			expect(response.status).toBe(400);
			expect(request.bodyUsed).toBe(false);
		}
	});
});

// ---------------------------------------------------------------------------
// the exchange
// ---------------------------------------------------------------------------

interface PhoneSide {
	deviceId: string;
	deviceIdBytes: Uint8Array;
	a: bigint;
}

function newPhone(): PhoneSide {
	const deviceIdBytes = randomBytes(WIRE_ID_BYTES);
	return {
		deviceId: base64UrlEncode(deviceIdBytes),
		deviceIdBytes,
		a: srpBytesToBigInt(randomBytes(32)),
	};
}

async function post(
	path: typeof REMOTE_PAIR_PATH_BEGIN | typeof REMOTE_PAIR_PATH_KEX,
	body: unknown,
	deps: RemotePairRouteDeps,
	source?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
	const response = await handleRemotePairRequest(
		path,
		pairRequest(path, body, source),
		deps,
	);
	return {
		status: response.status,
		body: (await response.json()) as Record<string, unknown>,
	};
}

function begin(
	phone: PhoneSide,
	deps: RemotePairRouteDeps,
	source?: string,
	overrides: Record<string, unknown> = {},
) {
	return post(
		REMOTE_PAIR_PATH_BEGIN,
		{
			v: 2,
			deviceId: phone.deviceId,
			label: "Pixel",
			surface: "phone",
			appVersion: "1.0.0",
			protocol: { min: 0, max: 1 },
			...overrides,
		},
		deps,
		source,
	);
}

/** The phone's `A`, from its own `a`. */
function clientPublic(phone: PhoneSide): Uint8Array {
	return srpPad(
		SRP_3072_SHA256,
		srpModPow(SRP_3072_SHA256.g, phone.a, SRP_3072_SHA256.N),
	);
}

function kex(
	phone: PhoneSide,
	pid: string,
	deps: RemotePairRouteDeps,
	A: Uint8Array = clientPublic(phone),
	source?: string,
) {
	return post(
		REMOTE_PAIR_PATH_KEX,
		{ v: 2, pid, deviceId: phone.deviceId, A: base64UrlEncode(A) },
		deps,
		source,
	);
}

/** The PHONE's side of the key schedule, computed the way the Android client does. */
function phoneSession(input: {
	phone: PhoneSide;
	code: string;
	pid: string;
	pairSalt: string;
	B: string;
}) {
	const group = SRP_3072_SHA256;
	const pairSalt = base64UrlDecode(input.pairSalt);
	const pidBytes = base64UrlDecode(input.pid);
	const padB = base64UrlDecode(input.B);
	const B = srpBytesToBigInt(padB);
	const xBytes = srpComputeX(group, pairSalt, PAIRING_SRP_IDENTITY, input.code);
	const x = srpBytesToBigInt(xBytes);
	const k = srpComputeK(group);
	const padA = clientPublic(input.phone);
	const A = srpBytesToBigInt(padA);
	const u = srpComputeU(group, A, B);
	const S = srpModPow(
		(((B - ((k * srpModPow(group.g, x, group.N)) % group.N)) % group.N) +
			group.N) %
			group.N,
		input.phone.a + u * x,
		group.N,
	);

	const prk = hkdfExtract(
		concat(ascii(PAIRING_REMOTE_HKDF_SALT_PREFIX), pairSalt),
		srpPad(group, S),
	);
	const transcript = buildSrpPairingTranscript({
		pid: pidBytes,
		deviceId: input.phone.deviceIdBytes,
		clientPublic: padA,
		serverPublic: padB,
		pairSalt,
	});
	return {
		transcript,
		deviceKey: hkdfExpandInfo(
			prk,
			hkdfInfoWithSuffix(
				HKDF_LABEL_REMOTE_DEVICE,
				pidBytes,
				input.phone.deviceIdBytes,
			),
			KEY_BYTES,
		),
		confirmPhone: hkdfExpandLabel(
			prk,
			HKDF_LABEL_REMOTE_CONFIRM_PHONE,
			KEY_BYTES,
		),
		confirmDesktop: hkdfExpandLabel(
			prk,
			HKDF_LABEL_REMOTE_CONFIRM_DESKTOP,
			KEY_BYTES,
		),
	};
}

function confirm(
	phone: PhoneSide,
	pid: string,
	macPhone: Uint8Array,
	deps: RemotePairRouteDeps,
	source?: string,
): Promise<Response> {
	return handleRemotePairRequest(
		REMOTE_PAIR_PATH_CONFIRM,
		pairRequest(
			REMOTE_PAIR_PATH_CONFIRM,
			{
				v: 2,
				pid,
				deviceId: phone.deviceId,
				macPhone: base64UrlEncode(macPhone),
			},
			source,
		),
		deps,
	);
}

/** begin -> kex -> the phone's derived session, for a given code. */
async function runToKex(
	phone: PhoneSide,
	deps: RemotePairRouteDeps,
	code: string,
	source?: string,
) {
	const started = await begin(phone, deps, source);
	expect(started.status).toBe(200);
	const kexed = await kex(
		phone,
		started.body.pid as string,
		deps,
		undefined,
		source,
	);
	expect(kexed.status).toBe(200);
	const session = phoneSession({
		phone,
		code,
		pid: started.body.pid as string,
		pairSalt: started.body.pairSalt as string,
		B: kexed.body.B as string,
	});
	return { pid: started.body.pid as string, started, kexed, session };
}

describe("(REMOTE-CODE-PAIRING) the happy path, with a typed 8-digit code", () => {
	it("delivers the sealed access token to a phone that knew the code", async () => {
		let paired: { deviceId: string; deviceKey: Uint8Array } | null = null;
		const handle = await openCodeWindow({
			onPaired: async (input) => {
				paired = {
					deviceId: input.deviceId,
					deviceKey: new Uint8Array(input.deviceKey),
				};
			},
		});
		const deps = routeDeps();
		const phone = newPhone();

		const { pid, started, kexed, session } = await runToKex(
			phone,
			deps,
			handle.code,
		);
		expect(started.body.v).toBe(2);
		expect(base64UrlDecode(started.body.pairSalt as string).length).toBe(16);
		expect(kexed.body.v).toBe(2);
		expect(base64UrlDecode(kexed.body.B as string).length).toBe(SRP_WIDTH);
		// The kex response carries B and the clock, and nothing the phone already
		// has: pid and the salt came from `begin`.
		expect(kexed.body.pid).toBeUndefined();
		expect(kexed.body.pairSalt).toBeUndefined();

		const response = await confirm(
			phone,
			pid,
			hmacSha256(session.confirmPhone, session.transcript),
			deps,
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe(
			"application/octet-stream",
		);

		// The desktop stored the key it derived, and the phone derived the same one.
		expect(paired).not.toBeNull();
		const storedKey = (paired as unknown as { deviceKey: Uint8Array })
			.deviceKey;
		expect(hex(storedKey)).toBe(hex(session.deviceKey));

		// The step-4 body opens under K_s2c with the REMOTE path in its AAD.
		const envelope = parseEnvelope(
			new Uint8Array(await response.arrayBuffer()),
		);
		const sendKey = hkdfExpandLabel(
			session.deviceKey,
			HKDF_LABEL_SEAL_S2C,
			KEY_BYTES,
		);
		const plaintext = openSealed(
			sendKey,
			envelope,
			buildRequestAad(envelope.headerBytes, {
				method: "POST",
				path: REMOTE_PAIR_PATH_CONFIRM,
				protocolVersion: 1,
			}),
		);
		const payload = JSON.parse(new TextDecoder().decode(plaintext)) as {
			macDesktop: string;
			deviceId: string;
			access: { clientId: string; clientSecret: string };
			bridge: { origin: string };
		};
		expect(payload.deviceId).toBe(phone.deviceId);
		expect(payload.access.clientSecret).toBe(ACCESS_SECRET);
		expect(payload.bridge.origin).toBe("https://superset.khaira.family");
		expect(base64UrlDecode(payload.macDesktop)).toEqual(
			hmacSha256(session.confirmDesktop, session.transcript),
		);

		// SINGLE USE: the window is gone the instant the device paired.
		expect(currentRemotePairing()).toBeNull();
		expect(handle.closed).toBe(true);
	});

	it("a step-4 envelope does not open under the QR flow's AAD path", async () => {
		const handle = await openCodeWindow();
		const deps = routeDeps();
		const phone = newPhone();
		const { pid, session } = await runToKex(phone, deps, handle.code);
		const response = await confirm(
			phone,
			pid,
			hmacSha256(session.confirmPhone, session.transcript),
			deps,
		);
		const envelope = parseEnvelope(
			new Uint8Array(await response.arrayBuffer()),
		);
		const sendKey = hkdfExpandLabel(
			session.deviceKey,
			HKDF_LABEL_SEAL_S2C,
			KEY_BYTES,
		);
		expect(() =>
			openSealed(
				sendKey,
				envelope,
				buildRequestAad(envelope.headerBytes, {
					method: "POST",
					path: "/pair/confirm",
					protocolVersion: 1,
				}),
			),
		).toThrow();
	});
});

describe("(REMOTE-CODE-PAIRING) the three-message state machine", () => {
	it("refuses remote wire version 1 with no fallback", async () => {
		await openCodeWindow();
		const deps = routeDeps();
		const phone = newPhone();
		const started = await begin(phone, deps, undefined, { v: 1 });
		expect(started.status).toBe(400);
		expect(started.body.code).toBe("pair_version_unsupported");
	});

	it("refuses a kex for a deviceId that never began", async () => {
		await openCodeWindow();
		const deps = routeDeps();
		const phone = newPhone();
		const other = newPhone();
		const started = await begin(phone, deps);
		const result = await kex(other, started.body.pid as string, deps);
		expect(result.status).toBe(400);
		// (PAIR-EVICTION-HONEST) No candidate, so no peer conflict to report.
		expect(result.body.code).toBe("pair_unknown_candidate");
	});

	it("refuses a kex whose pid is not this window's", async () => {
		await openCodeWindow();
		const deps = routeDeps();
		const phone = newPhone();
		await begin(phone, deps);
		const result = await kex(
			phone,
			base64UrlEncode(randomBytes(WIRE_ID_BYTES)),
			deps,
		);
		expect(result.status).toBe(400);
		expect(result.body.code).toBe("pair_wrong_peer");
	});

	it("begin is idempotent and refuses a metadata rewrite", async () => {
		await openCodeWindow();
		const deps = routeDeps();
		const phone = newPhone();
		const first = await begin(phone, deps);
		const again = await begin(phone, deps);
		expect(again.status).toBe(200);
		expect(again.body.pid).toBe(first.body.pid);
		expect(again.body.pairSalt).toBe(first.body.pairSalt);

		const rewritten = await begin(phone, deps, undefined, { label: "Evil" });
		expect(rewritten.status).toBe(400);
		expect(rewritten.body.code).toBe("pair_wrong_peer");
	});

	it("an identical kex retry returns the SAME B, and a different A is refused", async () => {
		await openCodeWindow();
		const deps = routeDeps();
		const phone = newPhone();
		const started = await begin(phone, deps);
		const pid = started.body.pid as string;

		const first = await kex(phone, pid, deps);
		const retry = await kex(phone, pid, deps);
		expect(retry.status).toBe(200);
		expect(retry.body.B).toBe(first.body.B);

		const other = newPhone();
		const rewritten = await kex(phone, pid, deps, clientPublic(other));
		expect(rewritten.status).toBe(400);
		expect(rewritten.body.code).toBe("pair_wrong_peer");
		// The first A/B still stand.
		expect((await kex(phone, pid, deps)).body.B).toBe(first.body.B);
	});

	it("two candidates get two different B values from the same window", async () => {
		await openCodeWindow();
		const deps = routeDeps();
		const one = newPhone();
		const two = newPhone();
		const startedOne = await begin(one, deps);
		const startedTwo = await begin(two, deps, "198.51.100.9");
		// Same window, so the same pid and the same salt...
		expect(startedTwo.body.pid).toBe(startedOne.body.pid);
		expect(startedTwo.body.pairSalt).toBe(startedOne.body.pairSalt);
		// ...but `b` is fresh per candidate, so B is not.
		const kexOne = await kex(one, startedOne.body.pid as string, deps);
		const kexTwo = await kex(
			two,
			startedTwo.body.pid as string,
			deps,
			clientPublic(two),
			"198.51.100.9",
		);
		expect(kexTwo.body.B).not.toBe(kexOne.body.B);
	});

	it("refuses a confirm before the kex has happened", async () => {
		await openCodeWindow();
		const deps = routeDeps();
		const phone = newPhone();
		const started = await begin(phone, deps);
		const response = await confirm(
			phone,
			started.body.pid as string,
			randomBytes(32),
			deps,
		);
		expect(response.status).toBe(400);
		expect(((await response.json()) as { code: string }).code).toBe(
			"pair_wrong_peer",
		);
	});
});

/**
 * (PAIR-EVICTION-HONEST) The candidate table evicts oldest-first rather than
 * refusing a newcomer, so a phone can lose its `begin` through no fault of its
 * own — a flood arriving inside its `begin` -> `kex` gap displaces it while the
 * window stays open and usable. That is its own code, `pair_unknown_candidate`,
 * because the phone's advice has to be "repeat begin", not "something else
 * answered instead of the desktop".
 *
 * The phone matches the BODY literal and never the status, so these tests pin the
 * body shape as tightly as the code itself: one known field, uncacheable.
 *
 * Recovery is USER-INITIATED on the phone by design: `begin` is unauthenticated,
 * so an automatic re-begin would be an amplifier aimed at the public pairing
 * host. What the desktop owes is a truthful code, on both steps eviction can land
 * between, and a window that still works — which is what these tests pin.
 */
describe("(PAIR-EVICTION-HONEST) a candidate the desktop evicted", () => {
	/**
	 * Displaces every candidate in the table. 16 introductions, and 4 sources
	 * because one source may only introduce 4 distinct deviceIds per window —
	 * that per-source ceiling is exactly what makes this expensive to aim at a
	 * specific phone.
	 */
	async function floodCandidateTable(deps: RemotePairRouteDeps): Promise<void> {
		for (let source = 0; source < 4; source += 1) {
			for (let device = 0; device < 4; device += 1) {
				const filler = await begin(
					newPhone(),
					deps,
					`198.51.100.${source + 1}`,
				);
				expect(filler.status).toBe(200);
			}
		}
	}

	it("gets pair_unknown_candidate at kex, and a fresh begin still pairs in the same window", async () => {
		const handle = await openCodeWindow();
		const deps = routeDeps();
		const phone = newPhone();
		const started = await begin(phone, deps);
		expect(started.status).toBe(200);

		await floodCandidateTable(deps);

		const evicted = await kex(phone, started.body.pid as string, deps);
		expect(evicted.status).toBe(400);
		expect(evicted.body.code).toBe("pair_unknown_candidate");
		expect(Object.keys(evicted.body)).toEqual(["code"]);

		// The window itself is untouched: the user presses the phone's retry, which
		// runs a whole fresh begin -> kex -> confirm, and pairing completes.
		const source = "203.0.113.8";
		const restarted = newPhone();
		const { pid, session } = await runToKex(
			restarted,
			deps,
			handle.code,
			source,
		);
		const sealed = await confirm(
			restarted,
			pid,
			hmacSha256(session.confirmPhone, session.transcript),
			deps,
			source,
		);
		expect(sealed.status).toBe(200);
	});

	it("spends neither a confirm attempt nor a MAC strike when it confirms", async () => {
		const handle = await openCodeWindow();
		const deps = routeDeps();
		const doomedSource = "203.0.113.7";
		const doomed = newPhone();
		const doomedRun = await runToKex(doomed, deps, handle.code, doomedSource);
		const doomedMac = hmacSha256(
			doomedRun.session.confirmPhone,
			doomedRun.session.transcript,
		);

		// `doomed` is the oldest candidate, so it is the one that goes.
		await floodCandidateTable(deps);

		const survivorSource = "203.0.113.9";
		const survivor = newPhone();
		const survivorRun = await runToKex(
			survivor,
			deps,
			handle.code,
			survivorSource,
		);
		const survivorMac = hmacSha256(
			survivorRun.session.confirmPhone,
			survivorRun.session.transcript,
		);

		// Two real wrong-code confirms: 2 of 3 MAC strikes, 2 of 5 attempts spent.
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const wrong = await confirm(
				survivor,
				survivorRun.pid,
				randomBytes(32),
				deps,
				survivorSource,
			);
			expect(wrong.status).toBe(401);
			expect(((await wrong.json()) as { code: string }).code).toBe(
				"pair_code_wrong",
			);
		}

		// Three confirms from the evicted candidate — eviction can land in the
		// kex -> confirm gap too, so confirm answers the same code. If any of them
		// counted as a strike the window would burn here; if any counted as an
		// attempt the survivor's confirm below would be rate-limited past 5.
		for (let ignored = 0; ignored < 3; ignored += 1) {
			const lost = await confirm(
				doomed,
				doomedRun.pid,
				doomedMac,
				deps,
				doomedSource,
			);
			expect(lost.status).toBe(400);
			// The BODY is the contract: the phone keys on the code and never on the
			// status, so the shape has to be exactly one known field, uncacheable.
			expect(lost.headers.get("cache-control")).toBe("no-store");
			const body = (await lost.json()) as Record<string, unknown>;
			expect(Object.keys(body)).toEqual(["code"]);
			expect(body.code).toBe("pair_unknown_candidate");
		}

		expect(currentRemotePairing()).not.toBeNull();
		const sealed = await confirm(
			survivor,
			survivorRun.pid,
			survivorMac,
			deps,
			survivorSource,
		);
		expect(sealed.status).toBe(200);
	});

	/**
	 * The code means "repeat begin", so anything that is NOT a missing candidate
	 * must not be able to produce it — otherwise the phone offers Try again for a
	 * refusal a retry cannot fix. A wrong `pid`, a candidate driven from a second
	 * source, and a rewrite of an existing candidate are all still
	 * `pair_wrong_peer`.
	 */
	it("is never the answer to a wrong pid, a wrong source, or a rewrite", async () => {
		await openCodeWindow();
		const deps = routeDeps();
		const phone = newPhone();
		const started = await begin(phone, deps);
		const pid = started.body.pid as string;

		const wrongPid = await kex(
			phone,
			base64UrlEncode(randomBytes(WIRE_ID_BYTES)),
			deps,
		);
		expect(wrongPid.status).toBe(400);
		expect(wrongPid.body.code).toBe("pair_wrong_peer");

		const wrongSource = await kex(
			phone,
			pid,
			deps,
			clientPublic(phone),
			"198.51.100.200",
		);
		expect(wrongSource.status).toBe(400);
		expect(wrongSource.body.code).toBe("pair_wrong_peer");

		expect((await kex(phone, pid, deps)).status).toBe(200);
		const rewrite = await kex(phone, pid, deps, clientPublic(newPhone()));
		expect(rewrite.status).toBe(400);
		expect(rewrite.body.code).toBe("pair_wrong_peer");
	});

	/**
	 * The QR flow's v1 codes are frozen and its phone builds have no mapping for
	 * this one, so the new code must be unreachable from the LAN handlers. Proven
	 * statically because the alternative is binding the LAN listener, whose port
	 * belongs to whatever desktop happens to be running on this machine.
	 */
	it("is a remote-only code — the LAN handlers cannot reach it", () => {
		const source = readFileSync(
			fileURLToPath(new URL("./pairing.ts", import.meta.url)),
			"utf8",
		);
		const literal = '"pair_unknown_candidate"';
		expect(source.split(literal).length - 1).toBe(1);

		const helper = source.slice(
			source.indexOf("function requireRemoteCandidate("),
		);
		const bodyEnd = helper.indexOf("\n}\n");
		expect(bodyEnd).toBeGreaterThan(0);
		expect(helper.slice(0, bodyEnd)).toContain(literal);
	});
});

describe("(REMOTE-CODE-PAIRING) new key derivations are capped per window", () => {
	/** Mirrors `MAX_KEX_COMPUTATIONS_PER_WINDOW` in `pairing.ts`. */
	const MAX_NEW_DERIVATIONS = 64;

	/**
	 * A filler candidate with a SMALL private exponent. `newPhone()` draws 256
	 * random bits and this suite needs 60-odd candidates; the desktop's work is
	 * identical either way, and the phone's `A` is only ever a public value here.
	 */
	function fillerPhone(index: number): PhoneSide {
		const deviceIdBytes = new Uint8Array(WIRE_ID_BYTES);
		deviceIdBytes[0] = index & 0xff;
		deviceIdBytes[1] = (index >> 8) & 0xff;
		deviceIdBytes[15] = 0x5a;
		return {
			deviceId: base64UrlEncode(deviceIdBytes),
			deviceIdBytes,
			a: BigInt(0x10001 + index),
		};
	}

	/** Four deviceIds per source keeps `MAX_KEX_PER_SOURCE` out of the way. */
	function fillerSource(index: number): string {
		return `198.51.100.${Math.floor(index / 4) + 1}`;
	}

	async function deriveFiller(
		deps: RemotePairRouteDeps,
		index: number,
	): Promise<number> {
		const phone = fillerPhone(index);
		const source = fillerSource(index);
		const started = await begin(phone, deps, source);
		expect(started.status).toBe(200);
		const kexed = await kex(
			phone,
			started.body.pid as string,
			deps,
			clientPublic(phone),
			source,
		);
		return kexed.status;
	}

	it("spends 64 on genuinely new key agreements and refuses the 65th", async () => {
		const handle = await openCodeWindow();
		const deps = routeDeps();

		// 62 fresh candidates, each paying for exactly one derivation.
		for (let index = 0; index < MAX_NEW_DERIVATIONS - 2; index += 1) {
			expect(await deriveFiller(deps, index)).toBe(200);
		}

		// #63. Its retries and its refused rewrite must cost NOTHING, which the
		// next candidate proves by still finding the 64th slot free.
		const phone = newPhone();
		const source = "203.0.113.40";
		const started = await begin(phone, deps, source);
		const pid = started.body.pid as string;
		const first = await kex(phone, pid, deps, clientPublic(phone), source);
		expect(first.status).toBe(200);

		const retry = await kex(phone, pid, deps, clientPublic(phone), source);
		expect(retry.status).toBe(200);
		expect(retry.body.B).toBe(first.body.B);

		const rewrite = await kex(
			phone,
			pid,
			deps,
			clientPublic(fillerPhone(9_000)),
			source,
		);
		expect(rewrite.status).toBe(400);
		expect(rewrite.body.code).toBe("pair_wrong_peer");

		// #64 — the last slot, still there.
		expect(await deriveFiller(deps, MAX_NEW_DERIVATIONS - 2)).toBe(200);

		// #65 — refused, and `begin` still answers: the ceiling is on the
		// EXPONENTIATION, not on the endpoint.
		const late = fillerPhone(MAX_NEW_DERIVATIONS - 1);
		const lateSource = fillerSource(MAX_NEW_DERIVATIONS - 1);
		const lateBegin = await begin(late, deps, lateSource);
		expect(lateBegin.status).toBe(200);
		const refused = await kex(
			late,
			lateBegin.body.pid as string,
			deps,
			clientPublic(late),
			lateSource,
		);
		expect(refused.status).toBe(429);
		expect(refused.body.code).toBe("pair_rate_limited");

		// A candidate that already derived is unaffected by the ceiling: its
		// cached B still replays, and its confirm still pairs.
		const cached = await kex(phone, pid, deps, clientPublic(phone), source);
		expect(cached.status).toBe(200);
		expect(cached.body.B).toBe(first.body.B);

		const session = phoneSession({
			phone,
			code: handle.code,
			pid,
			pairSalt: started.body.pairSalt as string,
			B: first.body.B as string,
		});
		const paired = await confirm(
			phone,
			pid,
			hmacSha256(session.confirmPhone, session.transcript),
			deps,
			source,
		);
		expect(paired.status).toBe(200);
	}, 30_000);

	/**
	 * A degenerate `A` is FREE to forge — `PAD(0)`, `PAD(1)`, `PAD(N-1)` are
	 * constants — and no key agreement can be performed with one. Validating range
	 * only inside `srpServerHandshake` meant the derivation charge had already been
	 * spent by the time it was rejected, so a few dozen constant packets could
	 * exhaust the window's 64 new derivations without the desktop ever performing
	 * one. Order is now validate -> charge -> derive, so they cost nothing.
	 */
	it("charges no derivation for a degenerate A", async () => {
		const handle = await openCodeWindow();
		const deps = routeDeps();
		const degenerate = [
			srpPad(SRP_3072_SHA256, 0n),
			srpPad(SRP_3072_SHA256, 1n),
			srpPad(SRP_3072_SHA256, SRP_3072_SHA256.N - 1n),
		];

		// Spread over 3 sources because one source may only send 32 requests a
		// window; 75 attempts is comfortably past the 64-derivation ceiling.
		let attempts = 0;
		for (let bucket = 0; bucket < 3; bucket += 1) {
			const source = `192.0.2.${bucket + 1}`;
			const attacker = newPhone();
			const started = await begin(attacker, deps, source);
			expect(started.status).toBe(200);
			for (let index = 0; index < 25; index += 1) {
				const refused = await kex(
					attacker,
					started.body.pid as string,
					deps,
					degenerate[index % degenerate.length] as Uint8Array,
					source,
				);
				expect(refused.status).toBe(400);
				expect(refused.body.code).toBe("pair_bad_key_agreement");
				attempts += 1;
			}
		}
		expect(attempts).toBeGreaterThan(MAX_NEW_DERIVATIONS);

		// The window's derivations are all still there: the real phone pairs.
		const source = "203.0.113.71";
		const phone = newPhone();
		const { pid, session } = await runToKex(phone, deps, handle.code, source);
		const sealed = await confirm(
			phone,
			pid,
			hmacSha256(session.confirmPhone, session.transcript),
			deps,
			source,
		);
		expect(sealed.status).toBe(200);
	}, 30_000);
});

describe("(REMOTE-CODE-PAIRING) the per-window request total cannot be refunded", () => {
	/**
	 * The per-source table evicts its oldest bucket to stay bounded, which hands
	 * the evicted source a FRESH allowance — deliberately, so a flood cannot lock
	 * the real phone out. That makes "32 sources x 32 requests" false as an
	 * aggregate bound: cycling addresses refunds forever, and every admitted
	 * request buys a body read and a JSON parse. The monotone total is what makes
	 * the documented bound true, and this walks a source cycle right through it.
	 */
	it("admits the documented total across cycling sources, then refuses every further request", async () => {
		await openCodeWindow();
		const deps = routeDeps();
		// A body that is admitted and then refused as cheaply as possible: the
		// charge happens before the body is even read, so what it says does not
		// matter — only that the request was admitted.
		const junk = { v: 99 };
		const sourceFor = (index: number): string =>
			`10.${Math.floor(index / 62_500) % 250}.${Math.floor(index / 250) % 250}.${(index % 250) + 1}`;

		let refusedEarly: number | null = null;
		for (
			let index = 0;
			index < REMOTE_PAIR_MAX_REQUESTS_PER_WINDOW;
			index += 1
		) {
			const result = await post(
				REMOTE_PAIR_PATH_BEGIN,
				junk,
				deps,
				sourceFor(index),
			);
			if (result.status === 429) {
				refusedEarly = index;
				break;
			}
		}
		// Every one of the documented total was admitted (and refused on its
		// contents, not on rate).
		expect(refusedEarly).toBeNull();

		const overflow = await post(
			REMOTE_PAIR_PATH_BEGIN,
			junk,
			deps,
			sourceFor(REMOTE_PAIR_MAX_REQUESTS_PER_WINDOW),
		);
		expect(overflow.status).toBe(429);
		expect(overflow.body.code).toBe("pair_rate_limited");

		// A brand-new source does not reset it, which is the whole point.
		const fresh = await post(REMOTE_PAIR_PATH_BEGIN, junk, deps, "172.16.9.9");
		expect(fresh.status).toBe(429);
		expect(fresh.body.code).toBe("pair_rate_limited");
	}, 30_000);

	/**
	 * The two ceilings must not turn on each other. ONE address is capped at
	 * `REMOTE_PAIR_REQUESTS_PER_SOURCE`, so everything it sends past that is refused
	 * as a flood — and a refused request must cost the WINDOW nothing. Charging the
	 * aggregate before the per-source rule let a single IP spend the whole window
	 * total on requests it was simultaneously being denied, locking out the real
	 * phone: exactly the lockout the per-source rule exists to prevent.
	 */
	it("does not let one flooding source spend the window total", async () => {
		const handle = await openCodeWindow();
		const deps = routeDeps();
		const junk = { v: 99 };
		const floodSource = "198.51.100.77";

		let floodRefusals = 0;
		for (
			let index = 0;
			index < REMOTE_PAIR_MAX_REQUESTS_PER_WINDOW;
			index += 1
		) {
			const result = await post(
				REMOTE_PAIR_PATH_BEGIN,
				junk,
				deps,
				floodSource,
			);
			if (result.status === 429) floodRefusals += 1;
		}
		// It really did exceed its own ceiling, so the request total was under
		// pressure from something the window should not have been charged for.
		expect(floodRefusals).toBe(
			REMOTE_PAIR_MAX_REQUESTS_PER_WINDOW - REMOTE_PAIR_REQUESTS_PER_SOURCE,
		);

		// The real phone, from its own address, still pairs.
		const source = "203.0.113.44";
		const phone = newPhone();
		const { pid, session } = await runToKex(phone, deps, handle.code, source);
		const sealed = await confirm(
			phone,
			pid,
			hmacSha256(session.confirmPhone, session.transcript),
			deps,
			source,
		);
		expect(sealed.status).toBe(200);
	}, 30_000);
});

describe("(REMOTE-CODE-PAIRING) a refused body answers in the pairing shape", () => {
	/**
	 * The bounded read is SHARED with the sealed protocol, so an oversized body
	 * used to leave this host answering with the SEALED protocol's error shape:
	 * `body_too_large` / `envelope_invalid`, a `serverTimeMs`, a `retryAfterMs`,
	 * and — because that constructor is not the pairing one — no `no-store`. The
	 * pairing client parses a closed set of pairing codes, and a cacheable
	 * sealed-protocol code from an unauthenticated host is both unparseable to it
	 * and a free hint about a surface it never reached.
	 */
	async function refuseBody(
		body: string | ReadableStream<Uint8Array>,
		headers: Record<string, string>,
	): Promise<{
		status: number;
		body: Record<string, unknown>;
		cache: string | null;
	}> {
		const request = new Request(
			`https://${PAIRING_PUBLIC_HOST}${REMOTE_PAIR_PATH_BEGIN}`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					host: PAIRING_PUBLIC_HOST,
					"cf-connecting-ip": "203.0.113.7",
					...headers,
				},
				body,
			},
		);
		const response = await handleRemotePairRequest(
			REMOTE_PAIR_PATH_BEGIN,
			request,
			routeDeps(),
		);
		return {
			status: response.status,
			body: (await response.json()) as Record<string, unknown>,
			cache: response.headers.get("cache-control"),
		};
	}

	it("refuses an oversized declared body as 413 with a pairing code and no-store", async () => {
		await openCodeWindow();
		const oversized = JSON.stringify({
			v: 2,
			label: "x".repeat(MAX_PAIR_BODY_BYTES + 64),
		});
		const result = await refuseBody(oversized, {});
		expect(result.status).toBe(413);
		expect(result.body).toEqual({ code: "unknown" });
		expect(result.cache).toBe("no-store");
	});

	it("refuses an oversized streamed body the same way, with no declared length", async () => {
		await openCodeWindow();
		const chunk = new TextEncoder().encode("x".repeat(1024));
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (let i = 0; i < 8; i += 1) controller.enqueue(chunk);
				controller.close();
			},
		});
		const result = await refuseBody(stream, {});
		expect(result.status).toBe(413);
		expect(result.body).toEqual({ code: "unknown" });
		expect(result.cache).toBe("no-store");
	});

	it("keeps a syntactically broken body on the pairing shape too", async () => {
		await openCodeWindow();
		const result = await refuseBody("{not json", {});
		expect(result.status).toBe(400);
		expect(result.body).toEqual({ code: "unknown" });
		expect(result.cache).toBe("no-store");
	});
});

describe("(REMOTE-CODE-PAIRING) A is validated at the canonical boundary", () => {
	let sourceCounter = 0;

	async function kexWith(
		A: Uint8Array,
	): Promise<{ status: number; code: string }> {
		const deps = routeDeps();
		const phone = newPhone();
		// A FRESH SOURCE per case, deliberately. Every case here is a distinct
		// deviceId, and one source may only open so many candidates per window —
		// reusing one address would make the later cases fail as a per-source
		// flood and the boundary check under test would never run.
		sourceCounter += 1;
		const source = `198.51.100.${sourceCounter}`;
		const started = await begin(phone, deps, source);
		const result = await kex(
			phone,
			started.body.pid as string,
			deps,
			A,
			source,
		);
		return { status: result.status, code: result.body.code as string };
	}

	it("refuses 0, 1, N-1, N and N+1 without reducing them", async () => {
		await openCodeWindow();
		const { N } = SRP_3072_SHA256;
		for (const value of [0n, 1n, N - 1n]) {
			const result = await kexWith(srpPad(SRP_3072_SHA256, value));
			expect(result.status).toBe(400);
			expect(result.code).toBe("pair_bad_key_agreement");
		}
		// N and N+1 are 384 bytes wide but out of range: refused, NOT reduced to
		// 0 and 1 — a server that reduced would accept a caller's chosen residue.
		for (const value of [N, N + 1n]) {
			const result = await kexWith(srpPad(SRP_3072_SHA256, value));
			expect(result.status).toBe(400);
			expect(result.code).toBe("pair_bad_key_agreement");
		}
	});

	it("refuses an A that is not exactly 384 bytes", async () => {
		await openCodeWindow();
		for (const length of [0, 1, 32, 383, 385, 512]) {
			const result = await kexWith(new Uint8Array(length).fill(7));
			expect(result.status).toBe(400);
			// A wrong LENGTH is a key-agreement refusal like every other bad `A`,
			// NOT a generic `unknown`: the phone gets one actionable code for
			// "your public value is unusable" whatever is wrong with it.
			expect(result.code).toBe("pair_bad_key_agreement");
		}
	});
});

describe("(REMOTE-CODE-PAIRING) a wrong code burns the window after three", () => {
	it("answers pair_code_wrong twice, then burns and reports it", async () => {
		const handle = await openCodeWindow();
		const deps = routeDeps();
		const wrongCode = handle.code === "00000000" ? "11111111" : "00000000";

		let lastStatus = 0;
		let lastCode = "";
		for (let attempt = 0; attempt < 3; attempt += 1) {
			const phone = newPhone();
			// One address per attempt, used for ALL THREE hops: a candidate belongs
			// to the address that opened it, so confirming from a second address
			// would be refused as a rewrite before the MAC was ever checked.
			const source = `198.51.100.${attempt + 1}`;
			const { pid, session } = await runToKex(phone, deps, wrongCode, source);
			const response = await confirm(
				phone,
				pid,
				hmacSha256(session.confirmPhone, session.transcript),
				deps,
				source,
			);
			lastStatus = response.status;
			lastCode = ((await response.json()) as { code: string }).code;
			if (attempt < 2) {
				expect(lastStatus).toBe(401);
				expect(lastCode).toBe("pair_code_wrong");
				expect(currentRemotePairing()).not.toBeNull();
			}
		}

		expect(lastStatus).toBe(401);
		expect(lastCode).toBe("pair_code_wrong");
		// Burned: the window is gone, and the memo says WHY rather than 404.
		expect(currentRemotePairing()).toBeNull();
		expect(handle.closed).toBe(true);

		const afterBurn = await handleRemotePairRequest(
			REMOTE_PAIR_PATH_BEGIN,
			pairRequest(REMOTE_PAIR_PATH_BEGIN, { v: 2 }),
			// The real memo, not the pinned-off one every other test uses.
			routeDeps({ burned: undefined }),
		);
		expect(afterBurn.status).toBe(403);
		expect(((await afterBurn.json()) as { code: string }).code).toBe(
			"pair_code_burned",
		);
	});

	it("a tampered B makes the phone's MAC fail, exactly as a wrong code does", async () => {
		const handle = await openCodeWindow();
		const deps = routeDeps();
		const phone = newPhone();
		const started = await begin(phone, deps);
		const pid = started.body.pid as string;
		const kexed = await kex(phone, pid, deps);

		// An on-path attacker flips one byte of B on the way to the phone. The
		// phone derives against the tampered value; the desktop still holds its own.
		const tampered = base64UrlDecode(kexed.body.B as string);
		tampered[0] = (tampered[0] ?? 0) ^ 0x01;
		const session = phoneSession({
			phone,
			code: handle.code,
			pid,
			pairSalt: started.body.pairSalt as string,
			B: base64UrlEncode(tampered),
		});

		const response = await confirm(
			phone,
			pid,
			hmacSha256(session.confirmPhone, session.transcript),
			deps,
		);
		expect(response.status).toBe(401);
		expect(((await response.json()) as { code: string }).code).toBe(
			"pair_code_wrong",
		);
	});

	it("a tampered transcript fails even with the right code", async () => {
		const handle = await openCodeWindow();
		const deps = routeDeps();
		const phone = newPhone();
		const { pid, session } = await runToKex(phone, deps, handle.code);
		const tampered = new Uint8Array(session.transcript);
		tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff;
		const response = await confirm(
			phone,
			pid,
			hmacSha256(session.confirmPhone, tampered),
			deps,
		);
		expect(response.status).toBe(401);
		expect(((await response.json()) as { code: string }).code).toBe(
			"pair_code_wrong",
		);
	});
});

// ---------------------------------------------------------------------------
// the property the whole replacement exists for
// ---------------------------------------------------------------------------

describe("(REMOTE-CODE-PAIRING) the transcript is not an offline oracle", () => {
	/**
	 * WHAT THIS ASSERTS, AND WHAT IT DELIBERATELY DOES NOT.
	 *
	 * It does NOT brute-force 10^8 codes and report that none worked — that would
	 * be a slow test that proves nothing, since a broken design would be broken
	 * for the FIRST candidate too, not the hundred-millionth.
	 *
	 * It asserts the PROTOCOL property that makes offline testing impossible:
	 * verifying a candidate code requires `S`, and on the client side `S =
	 * (B - k*g^x)^(a + u*x) mod N` needs `a` — the phone's private value, which
	 * never appears on the wire in any form. An observer at the Cloudflare edge
	 * holds exactly `A`, `B`, `pairSalt`, `pid`, `deviceId` and `macPhone`, and
	 * this test hands a candidate-checker ALL of them and shows the check cannot
	 * be completed: every quantity it can derive from a guessed code is
	 * independent of the MAC it is trying to explain.
	 *
	 * The contrast is with what the previous X25519 design leaked: there, `Z` was
	 * computable by anyone who ran their own kex, and `IKM = Z || code` made every
	 * guess checkable with two hashes.
	 */
	it("everything the edge sees is independent of the code", async () => {
		const handle = await openCodeWindow();
		const deps = routeDeps();
		const phone = newPhone();
		const started = await begin(phone, deps);
		const pid = started.body.pid as string;
		const pairSalt = started.body.pairSalt as string;
		const kexed = await kex(phone, pid, deps);
		const session = phoneSession({
			phone,
			code: handle.code,
			pid,
			pairSalt,
			B: kexed.body.B as string,
		});
		const macPhone = hmacSha256(session.confirmPhone, session.transcript);

		// Everything an observer of the hop has. Note what is NOT here: `a`, `b`,
		// `x`, the verifier, `S`, and the code itself.
		const observed = {
			A: base64UrlEncode(clientPublic(phone)),
			B: kexed.body.B as string,
			pairSalt,
			pid,
			deviceId: phone.deviceId,
			macPhone: base64UrlEncode(macPhone),
		};

		// The transcript is fully reconstructible from the observation — it is all
		// public values, by design. That is not the secret.
		const transcript = buildSrpPairingTranscript({
			pid: base64UrlDecode(observed.pid),
			deviceId: base64UrlDecode(observed.deviceId),
			clientPublic: base64UrlDecode(observed.A),
			serverPublic: base64UrlDecode(observed.B),
			pairSalt: base64UrlDecode(observed.pairSalt),
		});
		expect(hex(transcript)).toBe(hex(session.transcript));

		// The best an observer can do per candidate code is compute `x` and the
		// verifier. NEITHER yields the confirm key: the client's S needs `a` and
		// the server's needs `b`, and no function of the observation produces
		// either. Concretely, the two quantities a guesser CAN form are unrelated
		// to the MAC it is trying to explain.
		for (const guess of [handle.code, "00000000", "99999999"]) {
			const guessedX = srpComputeX(
				SRP_3072_SHA256,
				base64UrlDecode(observed.pairSalt),
				PAIRING_SRP_IDENTITY,
				guess,
			);
			const guessedVerifier = srpComputeVerifier(SRP_3072_SHA256, guessedX);
			// A verifier-shaped value, and nothing that can be fed to HKDF as `S`.
			// The only S-shaped quantity derivable without `a` or `b` is `v^u`, and
			// it is not S — proven here for the CORRECT code, which is the strongest
			// form of the statement: even knowing the password does not let the
			// observer finish.
			const u = srpComputeU(
				SRP_3072_SHA256,
				srpBytesToBigInt(base64UrlDecode(observed.A)),
				srpBytesToBigInt(base64UrlDecode(observed.B)),
			);
			const bestEffort = srpModPow(guessedVerifier, u, SRP_3072_SHA256.N);
			const forgedPrk = hkdfExtract(
				concat(
					ascii(PAIRING_REMOTE_HKDF_SALT_PREFIX),
					base64UrlDecode(observed.pairSalt),
				),
				srpPad(SRP_3072_SHA256, bestEffort),
			);
			const forgedMac = hmacSha256(
				hkdfExpandLabel(forgedPrk, HKDF_LABEL_REMOTE_CONFIRM_PHONE, KEY_BYTES),
				transcript,
			);
			expect(hex(forgedMac)).not.toBe(hex(macPhone));
		}
	});
});

describe("(REMOTE-CODE-PAIRING) the code never reaches a log or an error", () => {
	it("keeps 8 digits out of console output, logger fields and messages", async () => {
		const captured: string[] = [];
		const original = {
			log: console.log,
			warn: console.warn,
			error: console.error,
		};
		const capture =
			(...prefix: string[]) =>
			(...args: unknown[]) => {
				captured.push([...prefix, ...args.map(String)].join(" "));
			};
		console.log = capture("log");
		console.warn = capture("warn");
		console.error = capture("error");

		let code = "";
		const logger = recordingLogger();
		try {
			const handle = await openCodeWindow();
			code = handle.code;
			const deps = routeDeps({ logger });
			const phone = newPhone();
			const { pid, session } = await runToKex(phone, deps, "99999999");
			const response = await confirm(
				phone,
				pid,
				hmacSha256(session.confirmPhone, session.transcript),
				deps,
			);
			// The refusal body is a bare code, and the code is not in it.
			expect(await response.text()).not.toContain(code);
			await handle.close();
		} finally {
			console.log = original.log;
			console.warn = original.warn;
			console.error = original.error;
		}

		expect(code).toMatch(/^\d{8}$/);
		expect(captured.length).toBeGreaterThan(0);
		for (const line of captured) {
			expect(line).not.toContain(code);
		}
		for (const line of logger.lines) {
			expect(line).not.toContain(code);
		}
	});
});

// ---------------------------------------------------------------------------
// the assembled listener — gate ordering, not just the gate
// ---------------------------------------------------------------------------

/**
 * (REMOTE-CODE-PAIRING) The ORDER the registrations happen in, proven through
 * the real application rather than through `routeByHost` alone.
 *
 * Ops confirmed the installed origin answers 403 `access_denied` before route
 * handling when no Access JWT is present. That is exactly the behaviour the
 * pairing host must NOT have — a phone has no Access token and never will — and
 * it is also exactly the behaviour every other route must KEEP. Both facts live
 * in the same middleware chain, and only one of them can be checked without
 * building the app.
 *
 * The fakes below implement only what these three requests touch. Everything
 * else throws rather than returning a plausible value, so a future route that
 * quietly starts depending on one of them fails here instead of passing on a
 * stub.
 */
function unusedDep(name: string): never {
	throw new Error(
		`(TEST) ${name} is not part of the routing surface under test`,
	);
}

function serverDeps(
	overrides: Partial<BridgeHttpServerDeps> = {},
): BridgeHttpServerDeps {
	const logger = recordingLogger();
	return {
		// The MAIN validator, behaving as the installed origin does: no
		// `cf-access-jwt-assertion` header means 403 access_denied, before anything
		// else runs.
		accessValidator: {
			async validate(headers) {
				if (!headers["cf-access-jwt-assertion"]) {
					throw new CleartextError(403, "access_denied");
				}
				return {
					iss: "https://khaira.cloudflareaccess.com",
					aud: ["aud"],
					exp: Math.floor(Date.now() / 1000) + 600,
					iat: Math.floor(Date.now() / 1000),
					common_name: "c6d1295b4ed520de15de3446b9ec736b.access",
				};
			},
		},
		publicPairHost: PAIRING_PUBLIC_HOST,
		devices: new Proxy(
			{},
			{ get: (_t, p) => () => unusedDep(`devices.${String(p)}`) },
		) as BridgeHttpServerDeps["devices"],
		keys: new Proxy(
			{},
			{ get: (_t, p) => () => unusedDep(`keys.${String(p)}`) },
		) as BridgeHttpServerDeps["keys"],
		nonceCache: new Proxy(
			{},
			{ get: (_t, p) => () => unusedDep(`nonceCache.${String(p)}`) },
		) as BridgeHttpServerDeps["nonceCache"],
		sendNonce: new Proxy(
			{},
			{ get: (_t, p) => () => unusedDep(`sendNonce.${String(p)}`) },
		) as BridgeHttpServerDeps["sendNonce"],
		handlers: new Proxy(
			{},
			{ get: (_t, p) => () => unusedDep(`handlers.${String(p)}`) },
		) as BridgeHttpServerDeps["handlers"],
		events: new Proxy(
			{},
			{ get: (_t, p) => () => unusedDep(`events.${String(p)}`) },
		) as BridgeHttpServerDeps["events"],
		freeText: new Proxy(
			{},
			{ get: (_t, p) => () => unusedDep(`freeText.${String(p)}`) },
		) as BridgeHttpServerDeps["freeText"],
		logger,
		...overrides,
	};
}

describe("(REMOTE-CODE-PAIRING) the assembled listener gates in the right order", () => {
	it("serves pairing on the pairing host with NO Access JWT, and nothing else", async () => {
		await openCodeWindow();
		const server = createBridgeHttpServer(serverDeps());

		// 1. A pairing POST on the pairing host, carrying no Cf-Access-Jwt-Assertion
		//    at all, reaches the PAKE handler and gets a real answer.
		const paired = await server.fetch(
			pairRequest(REMOTE_PAIR_PATH_BEGIN, {
				v: 2,
				deviceId: base64UrlEncode(randomBytes(WIRE_ID_BYTES)),
				label: "Pixel",
				surface: "phone",
				appVersion: "1.0.0",
				protocol: { min: 0, max: 1 },
			}),
		);
		expect(paired.status).toBe(200);
		const body = (await paired.json()) as Record<string, string>;
		expect(body.pid).toBeString();
		expect(body.pairSalt).toBeString();

		// 2. An ordinary route on the PAIRING host does not exist, with or without
		//    a token — the pairing host reveals nothing about what else runs here.
		for (const headers of [
			{},
			{ "cf-access-jwt-assertion": "a.b.c" },
		] as Record<string, string>[]) {
			const ping = await server.fetch(
				new Request(`https://${PAIRING_PUBLIC_HOST}/v1/ping`, {
					headers: { host: PAIRING_PUBLIC_HOST, ...headers },
				}),
			);
			expect(ping.status).toBe(404);
			expect(await ping.text()).toBe("");
		}
	});

	it("keeps Access on every main-host route, unchanged", async () => {
		const server = createBridgeHttpServer(serverDeps());

		const denied = await server.fetch(
			new Request(`https://${BRIDGE_PUBLIC_HOST}/v1/ping`, {
				headers: { host: BRIDGE_PUBLIC_HOST },
			}),
		);
		expect(denied.status).toBe(403);
		expect(((await denied.json()) as { code: string }).code).toBe(
			"access_denied",
		);
	});

	it("404s the pairing paths on the main host, token or no token", async () => {
		await openCodeWindow();
		const server = createBridgeHttpServer(serverDeps());

		for (const path of [
			REMOTE_PAIR_PATH_BEGIN,
			REMOTE_PAIR_PATH_KEX,
			REMOTE_PAIR_PATH_CONFIRM,
		]) {
			for (const extra of [
				{},
				{ "cf-access-jwt-assertion": "a.b.c" },
			] as Record<string, string>[]) {
				const response = await server.fetch(
					new Request(`https://${BRIDGE_PUBLIC_HOST}${path}`, {
						method: "POST",
						headers: {
							"content-type": "application/json",
							"cf-connecting-ip": "203.0.113.7",
							host: BRIDGE_PUBLIC_HOST,
							...extra,
						},
						body: JSON.stringify({ v: 2 }),
					}),
				);
				// A BARE 404 — not 403, which would confirm the path exists, and not
				// 200, which would mean the pairing surface is reachable behind the
				// main host's token.
				expect(response.status).toBe(404);
				expect(await response.text()).toBe("");
			}
		}
	});

	it("with remote pairing unconfigured, the pairing host is not a host at all", async () => {
		await openCodeWindow();
		const server = createBridgeHttpServer(serverDeps({ publicPairHost: null }));

		const response = await server.fetch(
			pairRequest(REMOTE_PAIR_PATH_BEGIN, { v: 2 }),
		);
		expect(response.status).toBe(404);
		expect(await response.text()).toBe("");
	});
});

// ---------------------------------------------------------------------------
// the fail-closed public-pair-host configuration
// ---------------------------------------------------------------------------

/**
 * (REMOTE-CODE-PAIRING) `~/.superset/companion/public-pair-host.json`.
 *
 * ABSENT means remote pairing is OFF, which is the safe default and the state a
 * machine that has never been configured is in. PRESENT means it must name
 * exactly the pairing host — anything else is a misconfiguration that would
 * either do nothing or, in the one case worth a dedicated message, put an
 * unauthenticated surface on the Access-protected host.
 */
describe("(REMOTE-CODE-PAIRING) the public pairing host is configured fail-closed", () => {
	function withConfigDir(
		write: ((file: string) => void) | null,
	): ReturnType<typeof resolveCompanionPaths> {
		const home = mkdtempSync(join(tmpdir(), "sc-pairhost-"));
		tempHomes.push(home);
		const paths = resolveCompanionPaths(home);
		mkdirSync(dirname(paths.publicPairHost), { recursive: true });
		write?.(paths.publicPairHost);
		return paths;
	}

	const tempHomes: string[] = [];
	afterEach(() => {
		for (const home of tempHomes.splice(0)) {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("is OFF when the file does not exist", () => {
		expect(loadPublicPairHost(withConfigDir(null))).toBeNull();
	});

	it("accepts exactly the pairing host", () => {
		const paths = withConfigDir((file) => {
			writeFileSync(file, JSON.stringify({ host: PAIRING_PUBLIC_HOST }));
		});
		expect(loadPublicPairHost(paths)).toBe(PAIRING_PUBLIC_HOST);
	});

	it("refuses the MAIN host by name, loudly", () => {
		const paths = withConfigDir((file) => {
			writeFileSync(file, JSON.stringify({ host: BRIDGE_PUBLIC_HOST }));
		});
		// The main host is refused like any other wrong name. What makes putting
		// pairing on it impossible is not this branch but the module-load assertion
		// that the two hosts differ — so there is nothing here to keep in sync.
		expect(() => loadPublicPairHost(paths)).toThrow(BRIDGE_PUBLIC_HOST);
		expect(() => loadPublicPairHost(paths)).toThrow(PAIRING_PUBLIC_HOST);
	});

	it("the two hosts are different names, which the module asserts at load", () => {
		expect(PAIRING_PUBLIC_HOST).not.toBe(BRIDGE_PUBLIC_HOST);
	});

	it("refuses any other host, a missing field and a wrong type", () => {
		for (const body of [
			JSON.stringify({ host: "pair.superset.khaira.family" }),
			JSON.stringify({ host: "evil.example" }),
			JSON.stringify({ host: "" }),
			JSON.stringify({}),
			JSON.stringify({ host: 42 }),
			"not json at all",
		]) {
			const paths = withConfigDir((file) => writeFileSync(file, body));
			expect(() => loadPublicPairHost(paths)).toThrow();
		}
	});
});

// ---------------------------------------------------------------------------
// the wipe — every way a candidate can leave the table
// ---------------------------------------------------------------------------

/**
 * (REMOTE-CODE-PAIRING) Derived key material is overwritten on EVERY exit, not
 * just the happy one.
 *
 * A candidate that reached kex holds K_dev and both confirmation keys. Dropping
 * the map entry does not erase them — it makes them unreachable, which is the
 * one state in which nothing can ever clean them up. These tests observe the
 * same buffers the implementation holds, through the wipe seam, and assert each
 * one was live before the exit and all-zero after it.
 */
describe("(REMOTE-CODE-PAIRING) candidate keys are wiped on every exit", () => {
	function recordWipes(): { reports: KexWipeReport[]; stop: () => void } {
		const reports: KexWipeReport[] = [];
		setKexWipeObserverForTest((report) => reports.push(report));
		return { reports, stop: () => setKexWipeObserverForTest(null) };
	}

	afterEach(() => setKexWipeObserverForTest(null));

	function assertAllWiped(reports: KexWipeReport[]): void {
		// FOUR buffers per candidate: prk, confirmPhone, confirmDesktop, deviceKey.
		expect(reports.length).toBeGreaterThanOrEqual(4);
		for (const report of reports) {
			expect(report.wasLive).toBe(true);
			expect(report.buffer.every((byte) => byte === 0)).toBe(true);
		}
	}

	it("wipes them when the window closes with the candidate still open", async () => {
		const handle = await openCodeWindow();
		const deps = routeDeps();
		await runToKex(newPhone(), deps, handle.code);

		const { reports, stop } = recordWipes();
		await handle.close();
		stop();

		assertAllWiped(reports);
	});

	it("wipes them when a successful pairing consumes the window", async () => {
		const handle = await openCodeWindow();
		const deps = routeDeps();
		const phone = newPhone();
		const { pid, session } = await runToKex(phone, deps, handle.code);

		const { reports, stop } = recordWipes();
		const response = await confirm(
			phone,
			pid,
			hmacSha256(session.confirmPhone, session.transcript),
			deps,
		);
		stop();

		expect(response.status).toBe(200);
		// The keys that SEALED the reply are wiped too, not merely the ones left
		// sitting in the candidate table.
		assertAllWiped(reports);
	});

	it("wipes them when three wrong codes burn the window", async () => {
		const handle = await openCodeWindow();
		const deps = routeDeps();
		const wrongCode = handle.code === "00000000" ? "11111111" : "00000000";

		const { reports, stop } = recordWipes();
		for (let attempt = 0; attempt < 3; attempt += 1) {
			const phone = newPhone();
			const source = `198.51.100.${attempt + 1}`;
			const { pid, session } = await runToKex(phone, deps, wrongCode, source);
			await confirm(
				phone,
				pid,
				hmacSha256(session.confirmPhone, session.transcript),
				deps,
				source,
			);
		}
		stop();

		expect(currentRemotePairing()).toBeNull();
		assertAllWiped(reports);
	});
});

// ---------------------------------------------------------------------------
// (PAIR-ATTEMPT-ORDER) what a confirm actually costs
//
// The phone's client CANNOT be trusted to send exactly one confirm per user tap:
// the Android side found OkHttp's default `retryOnConnectionFailure` turning one
// tap into THREE confirms at the desktop when the socket died before the
// response arrived. They pinned it off, but the desktop must not depend on that
// — a lost response, a proxy retry or a user re-tap must never spend the user's
// three strikes. A strike is evidence of a CODE GUESS and nothing else.
// ---------------------------------------------------------------------------

/** A confirm carrying an arbitrary `macPhone` field, malformed ones included. */
function confirmRaw(
	phone: PhoneSide,
	pid: string,
	macPhone: unknown,
	deps: RemotePairRouteDeps,
	source?: string,
): Promise<Response> {
	return handleRemotePairRequest(
		REMOTE_PAIR_PATH_CONFIRM,
		pairRequest(
			REMOTE_PAIR_PATH_CONFIRM,
			{ v: 2, pid, deviceId: phone.deviceId, macPhone },
			source,
		),
		deps,
	);
}

describe("(REMOTE-CODE-PAIRING) a confirm costs a strike only for a wrong MAC", () => {
	it("charges neither budget nor strike for a macPhone that cannot be compared", async () => {
		const handle = await openCodeWindow();
		const deps = routeDeps();
		const phone = newPhone();
		const { pid, session } = await runToKex(phone, deps, handle.code);

		// Six unusable bodies: more than the 5-attempt budget AND twice the 3-strike
		// burn, so if either counter moved this test could not end in a pairing.
		const unusable: unknown[] = [
			42,
			base64UrlEncode(new Uint8Array(31)),
			base64UrlEncode(new Uint8Array(33)),
			`${base64UrlEncode(new Uint8Array(32))}=`,
			"not base64url!!",
			"",
		];
		for (const macPhone of unusable) {
			const response = await confirmRaw(phone, pid, macPhone, deps);
			expect(response.status).toBe(400);
			expect(((await response.json()) as { code: string }).code).toBe(
				"unknown",
			);
			// Open, every time: nothing here reached a comparison, so nothing here is
			// evidence of a guess.
			expect(currentRemotePairing()).not.toBeNull();
		}

		// The budget is untouched, so the phone's first real MAC still pairs.
		const response = await confirm(
			phone,
			pid,
			hmacSha256(session.confirmPhone, session.transcript),
			deps,
		);
		expect(response.status).toBe(200);
	});

	it("answers a resent confirm with a closed window, not a bad MAC", async () => {
		let pairedCount = 0;
		const handle = await openCodeWindow({
			onPaired: async () => {
				pairedCount += 1;
			},
		});
		const deps = routeDeps();
		const phone = newPhone();
		const { pid, session } = await runToKex(phone, deps, handle.code);
		const mac = hmacSha256(session.confirmPhone, session.transcript);

		expect((await confirm(phone, pid, mac, deps)).status).toBe(200);

		// The phone never saw that response and sends the SAME body again.
		const retry = await confirm(phone, pid, mac, deps);
		// 404, because a consumed window is not a window. Crucially NOT 401
		// `pair_code_wrong`: the retry is not a guess and must not read as one.
		expect(retry.status).toBe(404);
		// Single use survives the retry — the device was stored exactly once.
		expect(pairedCount).toBe(1);
		expect(handle.closed).toBe(true);
	});

	it("treats a persist failure as a spent window, not as a wrong code", async () => {
		const handle = await openCodeWindow({
			onPaired: async () => {
				throw new Error("device store unavailable");
			},
		});
		const deps = routeDeps();
		const phone = newPhone();
		const { pid, session } = await runToKex(phone, deps, handle.code);
		const mac = hmacSha256(session.confirmPhone, session.transcript);

		const first = await confirm(phone, pid, mac, deps);
		// Loud and generic: the operator gets the reason in a log, the caller does
		// not get a hint about the code.
		expect(first.status).toBe(500);
		expect(((await first.json()) as { code: string }).code).toBe("unknown");

		// Persist-before-seal spends the window either way, so the retry finds
		// nothing — but it is still not a strike, and the window is not "burned".
		const retry = await confirm(phone, pid, mac, deps);
		expect(retry.status).toBe(404);
		expect(currentRemotePairing()).toBeNull();
		expect(handle.closed).toBe(true);
	});

	/**
	 * (PAIR-TOKEN-BEFORE-PERSIST) The Access token file is the one thing in the
	 * completion path that can fail for reasons unrelated to the exchange, and it
	 * used to be read AFTER the window was consumed and the device persisted. That
	 * made a missing or unreadable token file the worst outcome in the protocol: the
	 * phone was told `500 unknown` and honestly reported that nothing had been
	 * stored, while the desktop kept a device row nothing would ever use and a
	 * window nothing could reopen. Now the failure changes nothing at all, and the
	 * user can finish once the file is fixed — the code on screen is still live.
	 */
	it("a token-load failure stores no device and leaves the window usable", async () => {
		let tokenReadable = false;
		let paired = 0;
		const handle = await openCodeWindow({
			loadAccessToken: async () => {
				if (!tokenReadable) throw new Error("token file unreadable");
				return {
					clientId: "c6d1295b4ed520de15de3446b9ec736b.access",
					clientSecret: ACCESS_SECRET,
				};
			},
			onPaired: async () => {
				paired += 1;
			},
		});
		const deps = routeDeps();

		const doomedSource = "203.0.113.61";
		const doomed = newPhone();
		const doomedRun = await runToKex(doomed, deps, handle.code, doomedSource);
		const failed = await confirm(
			doomed,
			doomedRun.pid,
			hmacSha256(doomedRun.session.confirmPhone, doomedRun.session.transcript),
			deps,
			doomedSource,
		);
		expect(failed.status).toBe(500);
		expect(((await failed.json()) as { code: string }).code).toBe("unknown");

		// NOTHING happened: no device row, no consumed window, no burn. The correct
		// code was typed, so this is not a strike either.
		expect(paired).toBe(0);
		expect(currentRemotePairing()).not.toBeNull();
		expect(handle.closed).toBe(false);

		// The operator fixes the token file; the same window still pairs.
		tokenReadable = true;
		const source = "203.0.113.62";
		const phone = newPhone();
		const { pid, session } = await runToKex(phone, deps, handle.code, source);
		const sealed = await confirm(
			phone,
			pid,
			hmacSha256(session.confirmPhone, session.transcript),
			deps,
			source,
		);
		expect(sealed.status).toBe(200);
		expect(paired).toBe(1);
	});
});
