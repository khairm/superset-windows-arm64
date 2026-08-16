/**
 * (ALERT-CONTEXT-NAMES) The wire contract, asserted from the outside.
 *
 * Every test here is about a rule that, if it broke silently, would either leak
 * text to Google or silence a notification. None of them are about formatting.
 */

import { describe, expect, it } from "bun:test";
import {
	PUSH_DATA_HARD_CAP_BYTES,
	PUSH_DATA_HARD_CAP_BYTES_V3,
	PUSH_NAME_MAX_BYTES,
	PUSH_TTL_MS,
	RETRACT_TTL_MS,
} from "./config";
import {
	assertPushDataSafe,
	buildEnvelope,
	buildLifecyclePushData,
	buildLifecycleRetractPushData,
	buildQuestionPushData,
	buildRetractPushData,
	PUSH_NAME_EXEMPT_KEYS,
	sanitizePushName,
} from "./push";
import type { PushAlertContext } from "./push-context";
import type { PushData, QuestionId, WorkspaceId } from "./types";

const QUESTION = "q".repeat(22) as QuestionId;
const WORKSPACE = "w".repeat(22) as WorkspaceId;
const ALERT = "a".repeat(22);
const TERMINAL = "t".repeat(22);
const TOKEN = "device-token";
const EXPIRY = 1_700_000_000_000;
const OUTCOME = 1_699_999_999_000;

function context(overrides: Partial<PushAlertContext> = {}): PushAlertContext {
	return {
		terminalHandle: TERMINAL,
		projectName: "PX V1 apps",
		workspaceName: "super simplify",
		tabTitle: "Claude Resume",
		tabCount: 3,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// closed key sets per (version, kind)
// ---------------------------------------------------------------------------

describe("(ALERT-CONTEXT-NAMES) v3 key sets are closed per (version, kind)", () => {
	it("gives a question every key, including empty context fields", () => {
		const data = buildQuestionPushData({
			questionId: QUESTION,
			workspaceId: WORKSPACE,
			questionCount: 2,
			expiresAtMs: EXPIRY,
			context: null,
		});
		expect(Object.keys(data).sort()).toEqual(
			["i", "k", "n", "pn", "t", "tc", "tn", "v", "w", "wn", "x"].sort(),
		);
		// ABSENT IS `""`, NEVER A MISSING KEY: the phone's parser is a closed set
		// too, and an optional key would make it a family of shapes.
		expect(data).toMatchObject({ t: "", pn: "", wn: "", tn: "", tc: "" });
	});

	it("gives a lifecycle alert every key but `n`", () => {
		const data = buildLifecyclePushData({
			alertId: ALERT,
			workspaceId: WORKSPACE,
			kind: "g",
			terminalHandle: TERMINAL,
			outcomeAtMs: OUTCOME,
			expiresAtMs: EXPIRY,
			context: context(),
		});
		expect(Object.keys(data).sort()).toEqual(
			["gx", "i", "k", "pn", "t", "tc", "tn", "v", "w", "wn", "x"].sort(),
		);
		expect(data).toMatchObject({
			v: "3",
			k: "g",
			pn: "PX V1 apps",
			wn: "super simplify",
			tn: "Claude Resume",
			tc: "3",
			t: TERMINAL,
		});
	});

	it("gives a lifecycle retraction NO name keys at all", () => {
		const data = buildLifecycleRetractPushData({
			alertId: ALERT,
			workspaceId: WORKSPACE,
			terminalHandle: TERMINAL,
			outcomeAtMs: OUTCOME,
			nowMs: EXPIRY,
		});
		expect(Object.keys(data).sort()).toEqual(
			["gx", "i", "k", "t", "v", "w", "x"].sort(),
		);
		for (const key of PUSH_NAME_EXEMPT_KEYS) {
			expect(key in data).toBe(false);
		}
	});

	it("refuses a v3 frame carrying a key its kind has no room for", () => {
		const data = buildLifecycleRetractPushData({
			alertId: ALERT,
			workspaceId: WORKSPACE,
			terminalHandle: TERMINAL,
			outcomeAtMs: OUTCOME,
			nowMs: EXPIRY,
		});
		const smuggled = { ...data, pn: "a project" } as unknown as PushData;
		expect(() => buildEnvelope(TOKEN, smuggled)).toThrow(
			/key set is not closed/,
		);
	});

	it("refuses a version it has no key set for", () => {
		const data = {
			v: "9",
			k: "q",
			i: QUESTION,
			w: WORKSPACE,
		} as unknown as PushData;
		expect(() => buildEnvelope(TOKEN, data)).toThrow(/no closed key set/);
	});

	it("refuses a kind the version does not carry", () => {
		const data = buildLifecyclePushData({
			alertId: ALERT,
			workspaceId: WORKSPACE,
			kind: "g",
			terminalHandle: TERMINAL,
			outcomeAtMs: OUTCOME,
			expiresAtMs: EXPIRY,
			context: null,
		});
		const wrong = { ...data, k: "r" } as unknown as PushData;
		expect(() => buildEnvelope(TOKEN, wrong)).toThrow(/data.k must be one of/);
	});
});

// ---------------------------------------------------------------------------
// v1 / v2 are frozen
// ---------------------------------------------------------------------------

describe("(ALERT-CONTEXT-NAMES) v1 stays byte-for-byte what installed clients parse", () => {
	it("mints the same retraction it always did", () => {
		expect(
			buildRetractPushData({
				questionId: QUESTION,
				workspaceId: WORKSPACE,
				nowMs: EXPIRY,
			}),
		).toEqual({
			v: "1",
			k: "r",
			i: QUESTION,
			w: WORKSPACE,
			n: "0",
			x: String(EXPIRY + RETRACT_TTL_MS),
		});
	});

	it("still holds v1 to the 160-byte leak tripwire", () => {
		// The cap is not a transport limit, it is the thing that makes a text leak
		// on a nameless version impossible. Raising it for v3 must not raise it
		// here.
		expect(PUSH_DATA_HARD_CAP_BYTES).toBe(160);
		expect(PUSH_DATA_HARD_CAP_BYTES_V3).toBeGreaterThan(
			PUSH_DATA_HARD_CAP_BYTES,
		);
	});

	it("refuses a name smuggled into a v1 frame", () => {
		const data = {
			v: "1",
			k: "q",
			i: QUESTION,
			w: WORKSPACE,
			n: "a project name",
			x: String(EXPIRY),
		} as unknown as PushData;
		expect(() => buildEnvelope(TOKEN, data)).toThrow(/opaque/);
	});
});

// ---------------------------------------------------------------------------
// the exempt list IS the waiver's blast radius
// ---------------------------------------------------------------------------

describe("(ALERT-CONTEXT-NAMES) the plaintext exemption", () => {
	it("covers exactly project, workspace and tab — and nothing else", () => {
		// If this fails, somebody widened the 2026-08-16 waiver. That is a
		// decision for the owner, not a test to update.
		expect([...PUSH_NAME_EXEMPT_KEYS].sort()).toEqual(["pn", "tn", "wn"]);
	});

	it("refuses a name-shaped value in a key that is not exempt", () => {
		const data = buildLifecyclePushData({
			alertId: ALERT,
			workspaceId: WORKSPACE,
			kind: "g",
			terminalHandle: TERMINAL,
			outcomeAtMs: OUTCOME,
			expiresAtMs: EXPIRY,
			context: context(),
		});
		const leaked = { ...data, t: "a terminal called something" } as PushData;
		expect(() => buildEnvelope(TOKEN, leaked)).toThrow();
	});

	it("never echoes a rejected value in the thrown message", () => {
		const secret = "the users private project name";
		const data = buildLifecyclePushData({
			alertId: ALERT,
			workspaceId: WORKSPACE,
			kind: "g",
			terminalHandle: TERMINAL,
			outcomeAtMs: OUTCOME,
			expiresAtMs: EXPIRY,
			context: context(),
		});
		const leaked = { ...data, w: secret } as unknown as PushData;
		let message = "";
		try {
			buildEnvelope(TOKEN, leaked);
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).not.toBe("");
		expect(message).not.toContain(secret);
	});

	it("never echoes a name when the whole frame is over its cap", () => {
		const huge = "n".repeat(PUSH_NAME_MAX_BYTES);
		const data = buildLifecyclePushData({
			alertId: ALERT,
			workspaceId: WORKSPACE,
			kind: "g",
			terminalHandle: TERMINAL,
			outcomeAtMs: OUTCOME,
			expiresAtMs: EXPIRY,
			context: context({
				projectName: huge,
				workspaceName: huge,
				tabTitle: huge,
			}),
		});
		// Three maximal names still fit: that is what the 2048 budget is for.
		expect(() => buildEnvelope(TOKEN, data)).not.toThrow();
		expect(Buffer.byteLength(JSON.stringify(data), "utf8")).toBeLessThanOrEqual(
			PUSH_DATA_HARD_CAP_BYTES_V3,
		);
	});
});

// ---------------------------------------------------------------------------
// the sanitizer
// ---------------------------------------------------------------------------

describe("(ALERT-CONTEXT-NAMES) sanitizePushName is total", () => {
	it("answers for every kind of non-string without throwing", () => {
		for (const value of [null, undefined, 42, {}, [], true, Symbol("x")]) {
			expect(sanitizePushName(value)).toBe("");
		}
	});

	it("strips C0, C1, DEL and the Unicode line separators", () => {
		// Written as escapes, never as literal bytes: a control character pasted
		// into a source file is invisible to review and to every later reader.
		const dirty = "a\u0000b\u001Fc\u007Fd\u009Fe\u2028f\u2029g";
		expect(sanitizePushName(dirty)).toBe("abcdefg");
		expect(sanitizePushName("carriage\r\nreturn")).toBe("carriagereturn");
		expect(sanitizePushName("two\nlines")).toBe("twolines");
		expect(sanitizePushName("tab\there")).toBe("tabhere");
	});

	it("trims outer whitespace and answers empty for whitespace alone", () => {
		expect(sanitizePushName("  spaced  ")).toBe("spaced");
		expect(sanitizePushName("   ")).toBe("");
		expect(sanitizePushName("\n\n")).toBe("");
	});

	/**
	 * The vectors are `PushV3Test.kt`'s "a name carrying a control character or
	 * a line separator degrades" cases, ported. The phone refuses a name holding
	 * a lone surrogate OUTRIGHT (`AlertContext.isRenderable`), so a host that
	 * stripped the half and sent the rest would ship a name the phone accepts
	 * while the two ends disagree about what it says. Matching the stricter side
	 * is what makes that impossible.
	 */
	it("degrades the WHOLE name on a lone surrogate, mirroring the phone", () => {
		expect(sanitizePushName("px\uD800apps")).toBe("");
		expect(sanitizePushName("px\uDC00apps")).toBe("");
		expect(sanitizePushName("px\uD800")).toBe("");
		expect(sanitizePushName("\uDC00")).toBe("");
		expect(sanitizePushName("\uD800\uD800")).toBe("");
		// A low surrogate immediately BEFORE a valid pair is still lone.
		expect(sanitizePushName("\uDC00😀")).toBe("");
	});

	it("leaves a WELL-FORMED pair alone — an emoji is not a defect", () => {
		expect(sanitizePushName("px 😀 apps")).toBe("px 😀 apps");
		expect(sanitizePushName("😀")).toBe("😀");
	});

	it("never emits a name whose bytes stop being the name it read", () => {
		// The concrete harm: `Buffer` substitutes U+FFFD for a lone surrogate, so
		// a stripped-and-sent name would arrive as different text.
		for (const value of ["px\uD800apps", "px\uDC00apps", "trailing\uD800"]) {
			const out = sanitizePushName(value);
			expect(out).toBe("");
			expect(Buffer.from(out, "utf8").toString("utf8")).toBe(out);
		}
	});

	it("leaves a name inside its budget exactly as it was", () => {
		const name = "PX V1 apps · super simplify 🎉";
		expect(sanitizePushName(name)).toBe(name);
	});

	it("truncates on a CODE POINT boundary, never mid surrogate pair", () => {
		// 200 astral code points = 800 UTF-8 bytes, well over budget, and every
		// one of them is a surrogate PAIR in JS — a byte- or unit-wise cut would
		// produce a lone surrogate, which is not valid UTF-8 at all.
		const emoji = "😀".repeat(200);
		const out = sanitizePushName(emoji);
		expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(
			PUSH_NAME_MAX_BYTES,
		);
		expect(out.endsWith("…")).toBe(true);
		// Round-tripping through UTF-8 changes nothing iff no surrogate was split.
		expect(Buffer.from(out, "utf8").toString("utf8")).toBe(out);
		// An emoji IS a surrogate pair, so the assertion is about LONE surrogates:
		// a high with no low after it, or a low with no high before it.
		expect(out).not.toMatch(
			/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
		);
	});

	it("truncates multi-byte scripts by bytes, not characters", () => {
		// Every one of these is 3 bytes; 200 characters is 600 bytes.
		const cjk = "測".repeat(200);
		const out = sanitizePushName(cjk);
		expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(
			PUSH_NAME_MAX_BYTES,
		);
		expect(out.length).toBeLessThan(cjk.length);
	});

	it("keeps a combining sequence's bytes valid when it truncates", () => {
		const combining = "é".repeat(300); // e + U+0301, 3 bytes per pair
		const out = sanitizePushName(combining);
		expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(
			PUSH_NAME_MAX_BYTES,
		);
		expect(Buffer.from(out, "utf8").toString("utf8")).toBe(out);
	});

	it("reserves room for the ellipsis rather than overshooting", () => {
		const out = sanitizePushName("x".repeat(PUSH_NAME_MAX_BYTES + 50));
		expect(Buffer.byteLength(out, "utf8")).toBe(PUSH_NAME_MAX_BYTES);
		expect(out.endsWith("…")).toBe(true);
	});

	it("survives a name that is one over-long code point", () => {
		expect(sanitizePushName("😀".repeat(1000)).length).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// context degradation
// ---------------------------------------------------------------------------

describe("(ALERT-CONTEXT-NAMES) context never fails a send", () => {
	it('drops a malformed terminal handle to `""` instead of throwing', () => {
		const data = buildLifecyclePushData({
			alertId: ALERT,
			workspaceId: WORKSPACE,
			kind: "e",
			terminalHandle: "not a handle",
			outcomeAtMs: OUTCOME,
			expiresAtMs: EXPIRY,
			context: context(),
		});
		expect(data).toMatchObject({ t: "" });
		expect(() => buildEnvelope(TOKEN, data)).not.toThrow();
	});

	// (ONE-BUZZ-UNTIL-READ) The handle is the notification's identity on the
	// phone, so it is read off the alert row, not off the context. A context
	// that resolved to nothing costs names — never the identity.
	it("keeps the row's handle when the context resolved to nothing", () => {
		const data = buildLifecyclePushData({
			alertId: ALERT,
			workspaceId: WORKSPACE,
			kind: "g",
			terminalHandle: TERMINAL,
			outcomeAtMs: OUTCOME,
			expiresAtMs: EXPIRY,
			context: null,
		});
		expect(data).toMatchObject({
			t: TERMINAL,
			gx: String(OUTCOME),
			pn: "",
			wn: "",
			tn: "",
		});
	});

	it("ignores a terminal handle smuggled in through the context", () => {
		const data = buildLifecyclePushData({
			alertId: ALERT,
			workspaceId: WORKSPACE,
			kind: "g",
			terminalHandle: TERMINAL,
			outcomeAtMs: OUTCOME,
			expiresAtMs: EXPIRY,
			context: context({ terminalHandle: "z".repeat(22) }),
		});
		expect(data).toMatchObject({ t: TERMINAL });
	});

	it("refuses a ready alert with no handle to replace in place", () => {
		expect(() =>
			buildLifecyclePushData({
				alertId: ALERT,
				workspaceId: WORKSPACE,
				kind: "g",
				terminalHandle: "not a handle",
				outcomeAtMs: OUTCOME,
				expiresAtMs: EXPIRY,
				context: context(),
			}),
		).toThrow(/requires a 22-character terminal handle/);
	});

	it("refuses a ready alert with no outcome instant", () => {
		expect(() =>
			buildLifecyclePushData({
				alertId: ALERT,
				workspaceId: WORKSPACE,
				kind: "g",
				terminalHandle: TERMINAL,
				outcomeAtMs: 0,
				expiresAtMs: EXPIRY,
				context: context(),
			}),
		).toThrow(/requires the outcome instant/);
	});

	it('drops an implausible tab count to `""`', () => {
		for (const tabCount of [-1, 1.5, Number.NaN, 100_000]) {
			const data = buildQuestionPushData({
				questionId: QUESTION,
				workspaceId: WORKSPACE,
				questionCount: 1,
				expiresAtMs: EXPIRY,
				context: context({ tabCount }),
			});
			expect(data).toMatchObject({ tc: "" });
		}
	});

	it("still sends when a name is unusable", () => {
		const data = buildQuestionPushData({
			questionId: QUESTION,
			workspaceId: WORKSPACE,
			questionCount: 1,
			expiresAtMs: EXPIRY,
			context: context({ projectName: "\u0000\u0001", tabTitle: "   " }),
		});
		expect(data).toMatchObject({ pn: "", tn: "" });
		expect(() => buildEnvelope(TOKEN, data)).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// per-message TTL
// ---------------------------------------------------------------------------

describe("(RETRACT-TTL) the FCM envelope TTL is per message", () => {
	it("keeps 15 minutes for an alert — a stale buzz is noise", () => {
		const alert = buildLifecyclePushData({
			alertId: ALERT,
			workspaceId: WORKSPACE,
			kind: "g",
			terminalHandle: TERMINAL,
			outcomeAtMs: OUTCOME,
			expiresAtMs: EXPIRY,
			context: null,
		});
		expect(buildEnvelope(TOKEN, alert).android.ttl).toBe(
			`${Math.floor(PUSH_TTL_MS / 1000)}s`,
		);
	});

	it("gives a QUESTION retraction 24 h, closing the pre-existing gap", () => {
		// The payload's own `x` has been 24 h since (RETRACT-TTL); the ENVELOPE was
		// still 15 minutes, so a phone off the network for twenty kept the
		// notification for an answered question.
		const retract = buildRetractPushData({
			questionId: QUESTION,
			workspaceId: WORKSPACE,
			nowMs: EXPIRY,
		});
		expect(buildEnvelope(TOKEN, retract).android.ttl).toBe(
			`${Math.floor(RETRACT_TTL_MS / 1000)}s`,
		);
	});

	it("gives a LIFECYCLE retraction 24 h too", () => {
		const retract = buildLifecycleRetractPushData({
			alertId: ALERT,
			workspaceId: WORKSPACE,
			terminalHandle: TERMINAL,
			outcomeAtMs: OUTCOME,
			nowMs: EXPIRY,
		});
		expect(buildEnvelope(TOKEN, retract).android.ttl).toBe(
			`${Math.floor(RETRACT_TTL_MS / 1000)}s`,
		);
		expect(Number(retract.x)).toBe(EXPIRY + RETRACT_TTL_MS);
	});

	it("collapses onto the alert it retracts", () => {
		const retract = buildLifecycleRetractPushData({
			alertId: ALERT,
			workspaceId: WORKSPACE,
			terminalHandle: TERMINAL,
			outcomeAtMs: OUTCOME,
			nowMs: EXPIRY,
		});
		expect(buildEnvelope(TOKEN, retract).android.collapse_key).toBe(ALERT);
	});
});

// ---------------------------------------------------------------------------
// envelope invariants that predate this feature and must survive it
// ---------------------------------------------------------------------------

describe("the envelope stays data-only", () => {
	it("refuses a notification block", () => {
		const data = buildQuestionPushData({
			questionId: QUESTION,
			workspaceId: WORKSPACE,
			questionCount: 1,
			expiresAtMs: EXPIRY,
			context: context(),
		});
		const envelope = buildEnvelope(TOKEN, data);
		const smuggled = {
			...envelope,
			notification: { title: "hello" },
		} as unknown as typeof envelope;
		expect(() => assertPushDataSafe(data, smuggled)).toThrow(
			/envelope key set is not closed/,
		);
	});
});
