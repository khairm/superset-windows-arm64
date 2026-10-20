import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
	HKDF_LABEL_SEAL_C2S,
	HKDF_LABEL_SEAL_EVT,
	HKDF_LABEL_SEAL_S2C,
} from "../src/companion/config";
import {
	base64UrlDecode,
	base64UrlEncode,
	buildEventAad,
	buildRequestAad,
	buildResponseAad,
	CryptoInvariantError,
	decodeWireId,
	hkdfExtract,
	hkdfInfoWithSuffix,
	hmacSha256,
	openSealed,
	parseEnvelope,
	seal,
	sha256,
	x25519,
} from "../src/companion/crypto";
import {
	createSendNonceSource,
	deriveDirectionalKeys,
	deriveEventKey,
	openStateAnchor,
} from "../src/companion/keys";
import {
	buildHkdfSalt,
	buildPairingIkm,
	buildPairingTranscript,
	expandPairingKeys,
	LAN_PAIRING_PROFILE,
} from "../src/companion/pairing";
import {
	ENVELOPE_KIND_EVENT,
	ENVELOPE_KIND_REQUEST,
	ENVELOPE_KIND_RESPONSE,
	type EnvelopeKind,
} from "../src/companion/types";

const args = process.argv.slice(2);
if (args.length !== 1 || args[0] === undefined || args[0].length === 0) {
	console.error(
		"usage: bun run scripts/write-companion-bridge-vectors.ts <output-path>",
	);
	process.exit(2);
}
const outputPath = resolve(args[0]);

function sequence(start: number, length: number): Uint8Array {
	return Uint8Array.from({ length }, (_, index) => (start + index) & 0xff);
}

function bytes(hexText: string): Uint8Array {
	if (!/^(?:[0-9a-f]{2})*$/.test(hexText)) {
		throw new Error(`not canonical lowercase hex: ${hexText}`);
	}
	return new Uint8Array(Buffer.from(hexText, "hex"));
}

function hex(value: Uint8Array): string {
	return Buffer.from(value).toString("hex");
}

function utf8(text: string): Uint8Array {
	return new Uint8Array(Buffer.from(text, "utf8"));
}

function rejectedByStrictDecoder(decode: () => Uint8Array): boolean {
	try {
		decode();
		return false;
	} catch (error) {
		if (error instanceof CryptoInvariantError) return true;
		throw error;
	}
}

const PROTOCOL_VERSION = 1;
const TREE_PATH = "/v1/tree";

const sharedSecret = sequence(0x00, 32);
const pairingCode = sequence(0x20, 32);
const pairSalt = sequence(0x40, 16);
const pairingId = sequence(0x50, 16);
const deviceId = sequence(0x60, 16);
const phonePublicKey = sequence(0x70, 32);
const desktopPublicKey = sequence(0x90, 32);
const ticketId = sequence(0xb0, 16);
const streamSeed = sequence(0xc0, 12);
const rfcAlicePrivate = bytes(
	"77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a",
);
const rfcAlicePublic = bytes(
	"8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a",
);
const rfcBobPublic = bytes(
	"de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f",
);
const rfcShared = x25519(rfcAlicePrivate, rfcBobPublic);

// derivePairingKeys computes Z by X25519 itself, so a fixed Z goes through the
// salt, Extract and Expand steps it runs, with the LAN profile.
const salt = buildHkdfSalt(LAN_PAIRING_PROFILE, pairSalt);
const pairSaltPrefix = salt.subarray(0, salt.length - pairSalt.length);
// A copy: production zeroes `Z` once the IKM is built.
const ikm = buildPairingIkm(sharedSecret.slice(), pairingCode);
const prk = hkdfExtract(salt, ikm);
const {
	deviceKey,
	confirmPhone: confirmPhoneKey,
	confirmDesktop: confirmDesktopKey,
} = expandPairingKeys(prk, LAN_PAIRING_PROFILE, pairingId, deviceId);
const deviceInfo = hkdfInfoWithSuffix(
	LAN_PAIRING_PROFILE.deviceLabel,
	pairingId,
	deviceId,
);
const confirmPhoneInfo = hkdfInfoWithSuffix(
	LAN_PAIRING_PROFILE.confirmPhoneLabel,
);
const confirmDesktopInfo = hkdfInfoWithSuffix(
	LAN_PAIRING_PROFILE.confirmDesktopLabel,
);
const c2sInfo = hkdfInfoWithSuffix(HKDF_LABEL_SEAL_C2S);
const s2cInfo = hkdfInfoWithSuffix(HKDF_LABEL_SEAL_S2C);
const eventInfo = hkdfInfoWithSuffix(HKDF_LABEL_SEAL_EVT, ticketId);
const { c2s, s2c } = deriveDirectionalKeys(deviceKey);
const eventKey = deriveEventKey(deviceKey, ticketId);
const transcript = buildPairingTranscript({
	pid: pairingId,
	deviceId,
	pPub: phonePublicKey,
	dPub: desktopPublicKey,
	pairSalt,
});
const transcriptHash = sha256(transcript);
const macPhone = hmacSha256(confirmPhoneKey, transcript);
const macDesktop = hmacSha256(confirmDesktopKey, transcript);

const timestampMs = 1_785_000_000_123;
const requestNonce = bytes("a1b2c3d40001020304050607");
const responseNonce = bytes("d1d2d3d40000000000000002");
const eventNonce = bytes("e1e2e3e40000000000000003");
const pairingResponseNonce = bytes("f1f2f3f40000000000000000");
const frameSeq = 0x0001_0203_0405_0607;

const requestPlaintext = utf8(
	'{"probe":"c2s","line":"A\\r\\nB","snowman":"☃"}',
);
const responsePlaintext = utf8('{"probe":"s2c","status":"ok","n":200}');
const eventPlaintext = utf8('{"probe":"evt","seq":283686952306183}');
const pairingPlaintext = utf8(
	'{"probe":"pair-confirm","macDesktop":"synthetic"}',
);

function sealAndReopen(input: {
	key: Uint8Array;
	kind: EnvelopeKind;
	nonce: Uint8Array;
	timestampMs: number;
	plaintext: Uint8Array;
	buildAad: (headerBytes: Uint8Array) => Uint8Array;
	what: string;
}): { body: Uint8Array; header: Uint8Array; aad: Uint8Array } {
	const body = seal(
		input.key,
		input.kind,
		deviceId,
		input.nonce,
		input.timestampMs,
		input.plaintext,
		input.buildAad,
	);
	const parsed = parseEnvelope(body);
	const aad = input.buildAad(parsed.headerBytes);
	const reopened = openSealed(input.key, parsed, aad);
	if (!Buffer.from(reopened).equals(Buffer.from(input.plaintext))) {
		throw new Error(`${input.what} envelope did not reopen to its plaintext`);
	}
	return { body, header: parsed.headerBytes, aad };
}

const request = sealAndReopen({
	key: c2s,
	kind: ENVELOPE_KIND_REQUEST,
	nonce: requestNonce,
	timestampMs,
	plaintext: requestPlaintext,
	buildAad: (header) =>
		buildRequestAad(header, {
			method: "POST",
			path: TREE_PATH,
			protocolVersion: PROTOCOL_VERSION,
		}),
	what: "request",
});
const response = sealAndReopen({
	key: s2c,
	kind: ENVELOPE_KIND_RESPONSE,
	nonce: responseNonce,
	timestampMs: timestampMs + 1,
	plaintext: responsePlaintext,
	buildAad: (header) =>
		buildResponseAad(header, {
			method: "POST",
			path: TREE_PATH,
			protocolVersion: PROTOCOL_VERSION,
			requestNonce,
			statusCode: 200,
		}),
	what: "response",
});
const event = sealAndReopen({
	key: eventKey,
	kind: ENVELOPE_KIND_EVENT,
	nonce: eventNonce,
	timestampMs: timestampMs + 2,
	plaintext: eventPlaintext,
	buildAad: (header) =>
		buildEventAad(header, {
			protocolVersion: PROTOCOL_VERSION,
			streamSeed,
			frameSeq,
		}),
	what: "event",
});
const pairingResponse = sealAndReopen({
	key: s2c,
	kind: ENVELOPE_KIND_RESPONSE,
	nonce: pairingResponseNonce,
	timestampMs: timestampMs + 3,
	plaintext: pairingPlaintext,
	buildAad: (header) =>
		buildRequestAad(header, {
			method: "POST",
			path: LAN_PAIRING_PROFILE.confirmPath,
			protocolVersion: PROTOCOL_VERSION,
		}),
	what: "pairing response",
});

// Kotlin's store mark is the last counter RESERVED (1000); the anchor's
// high-water mark is the first counter never handed out, so the same state is
// 1001. The temp anchor holds only this throwaway state.
async function resumedSendNonce(prefix: Uint8Array): Promise<Uint8Array> {
	const anchorDir = mkdtempSync(join(tmpdir(), "sc-bridge-vectors-"));
	try {
		const anchor = await openStateAnchor(anchorDir);
		try {
			await anchor.claimSend(prefix, 1001n);
			const source = await createSendNonceSource(anchor);
			try {
				return source.next();
			} finally {
				await source.close();
			}
		} finally {
			await anchor.close();
		}
	} finally {
		rmSync(anchorDir, { recursive: true, force: true });
	}
}
const resumedNonce = await resumedSendNonce(bytes("11223344"));

const properties = new Map<string, string>();
function set(name: string, value: string): void {
	if (properties.has(name)) throw new Error(`duplicate vector key ${name}`);
	properties.set(name, value);
}
function setBytes(name: string, value: Uint8Array): void {
	set(name, hex(value));
	set(`${name}_len`, String(value.length));
}
function setNumber(name: string, value: number): void {
	if (!Number.isSafeInteger(value)) {
		throw new Error(`vector ${name} is not a safe integer`);
	}
	set(name, String(value));
}

setBytes("shared_secret", sharedSecret);
setBytes("pairing_code", pairingCode);
setBytes("pair_salt_prefix", pairSaltPrefix);
setBytes("pair_salt", pairSalt);
setBytes("hkdf_salt", salt);
setBytes("hkdf_ikm", ikm);
setBytes("hkdf_prk", prk);
setBytes("k_dev_info", deviceInfo);
setNumber("k_dev_output_len", deviceKey.length);
setBytes("k_dev", deviceKey);
setBytes("k_conf_phone_info", confirmPhoneInfo);
setNumber("k_conf_phone_output_len", confirmPhoneKey.length);
setBytes("k_conf_phone", confirmPhoneKey);
setBytes("k_conf_desktop_info", confirmDesktopInfo);
setNumber("k_conf_desktop_output_len", confirmDesktopKey.length);
setBytes("k_conf_desktop", confirmDesktopKey);
setBytes("k_c2s_info", c2sInfo);
setNumber("k_c2s_output_len", c2s.length);
setBytes("k_c2s", c2s);
setBytes("k_s2c_info", s2cInfo);
setNumber("k_s2c_output_len", s2c.length);
setBytes("k_s2c", s2c);
setBytes("ticket_id", ticketId);
set("ticket_id_b64url", base64UrlEncode(ticketId));
setBytes("k_evt_info", eventInfo);
setNumber("k_evt_output_len", eventKey.length);
setBytes("k_evt", eventKey);
setBytes("pairing_id", pairingId);
set("pairing_id_b64url", base64UrlEncode(pairingId));
setBytes("device_id", deviceId);
set("device_id_b64url", base64UrlEncode(deviceId));
setBytes("phone_public_key", phonePublicKey);
setBytes("desktop_public_key", desktopPublicKey);
setBytes("pairing_transcript", transcript);
setBytes("pairing_transcript_sha256", transcriptHash);
setBytes("pairing_mac_phone", macPhone);
setBytes("pairing_mac_desktop", macDesktop);
setBytes("x25519_bridge_private", rfcAlicePrivate);
setBytes("x25519_bridge_public", rfcAlicePublic);
setBytes("x25519_rfc_peer_public", rfcBobPublic);
setBytes("x25519_rfc_shared", rfcShared);

setNumber("timestamp_ms", timestampMs);
setBytes("request_nonce", requestNonce);
setBytes("request_nonce_prefix", requestNonce.subarray(0, 4));
setBytes("request_nonce_counter_be", requestNonce.subarray(4, 12));
setBytes("request_header", request.header);
setBytes("request_header_version", request.header.subarray(0, 1));
setBytes("request_header_flags", request.header.subarray(1, 2));
setBytes("request_header_kind", request.header.subarray(2, 3));
setBytes("request_header_device_id", request.header.subarray(3, 19));
setBytes("request_header_timestamp_be", request.header.subarray(19, 27));
setBytes("request_header_nonce", request.header.subarray(27, 39));
setBytes("request_aad", request.aad);
setBytes("request_plaintext", requestPlaintext);
setBytes("request_envelope", request.body);
set("request_envelope_b64url", base64UrlEncode(request.body));

setBytes("response_nonce", responseNonce);
setBytes("response_header", response.header);
setBytes("response_aad", response.aad);
setBytes("response_plaintext", responsePlaintext);
setBytes("response_envelope", response.body);
set("response_envelope_b64url", base64UrlEncode(response.body));

setBytes("stream_seed", streamSeed);
setNumber("event_frame_seq", frameSeq);
setBytes("event_nonce", eventNonce);
setBytes("event_header", event.header);
setBytes("event_aad", event.aad);
setBytes("event_plaintext", eventPlaintext);
setBytes("event_envelope", event.body);
set("event_envelope_b64url", base64UrlEncode(event.body));

setBytes("pairing_response_nonce", pairingResponseNonce);
setBytes("pairing_response_header", pairingResponse.header);
setBytes("pairing_response_aad", pairingResponse.aad);
setBytes("pairing_response_plaintext", pairingPlaintext);
setBytes("pairing_response_envelope", pairingResponse.body);
set("pairing_response_envelope_b64url", base64UrlEncode(pairingResponse.body));

setBytes("resumed_nonce", resumedNonce);
setBytes("resumed_nonce_prefix", resumedNonce.subarray(0, 4));
setBytes("resumed_nonce_counter_be", resumedNonce.subarray(4, 12));

const base64Sample = bytes("fbffef000102");
setBytes("base64_sample", base64Sample);
set("base64_sample_encoded", base64UrlEncode(base64Sample));
set(
	"base64_sample_roundtrip",
	hex(base64UrlDecode(base64UrlEncode(base64Sample))),
);
set(
	"base64_padded_rejected",
	String(rejectedByStrictDecoder(() => base64UrlDecode("AA=="))),
);
set(
	"base64_standard_alphabet_rejected",
	String(rejectedByStrictDecoder(() => base64UrlDecode("+/8"))),
);
const noncanonicalDeviceIdAlias = `${base64UrlEncode(deviceId).slice(0, -1)}x`;
set(
	"base64_noncanonical_tail_rejected",
	String(
		rejectedByStrictDecoder(() => decodeWireId(noncanonicalDeviceIdAlias)),
	),
);

const text = `${[...properties.keys()]
	.sort()
	.map((key) => `${key}=${properties.get(key)}`)
	.join("\n")}\n`;
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, text, "utf8");
console.log(`wrote ${properties.size} vectors to ${outputPath}`);
