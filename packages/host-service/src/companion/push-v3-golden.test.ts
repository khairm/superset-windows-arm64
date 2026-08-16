/**
 * (ALERT-CONTEXT-NAMES) The SHARED golden vectors, mirrored on the host.
 *
 * These are the exact maps `superset-companion`'s
 * `core/.../protocol/PushV3Test.kt` parses. Two independent implementations of
 * one wire format drift silently — the phone keeps parsing, the host keeps
 * sending, and the only symptom is a notification that never arrives — so the
 * literals live in both suites and each one asserts them against its own side.
 *
 * WHY BYTE-EQUALITY AND NOT "compatible". The phone's parser is exact-equality
 * in BOTH directions: a missing key is refused and an extra key is refused,
 * because "absence has a spelling" (`""`) and an unexpected key is exactly how
 * text would arrive. So there is no such thing as a harmless extra field here,
 * and `toEqual` rather than `toMatchObject` is the assertion that says so.
 *
 * If one of these fails, do NOT relax it: change the Kotlin vector and this one
 * together, in the same change, and re-read the rollout order in FINAL.md §5.
 */

import { describe, expect, it } from "bun:test";
import { RETRACT_TTL_MS } from "./config";
import {
	buildEnvelope,
	buildLifecyclePushData,
	buildLifecycleRetractPushData,
	buildQuestionPushData,
} from "./push";
import type { PushAlertContext } from "./push-context";
import type { PushData, QuestionId, WorkspaceId } from "./types";

/** Verbatim from `PushV3Test.kt`'s companion object. */
const EXPIRY = 1_800_000_000_000;
/**
 * (ONE-BUZZ-UNTIL-READ) The outcome instant carried as `gx` — the same instant
 * the deterministic alert id hashes, which is how the phone tells a genuinely
 * newer finish from a replay of one it already showed. Verbatim from the Kotlin
 * fixture; change both or neither.
 */
const OUTCOME_AT_MS = 1_799_999_100_000;
const EVENT_ID = "e1234567890123456789ab";
const QUESTION_ID = "q1234567890123456789ab" as QuestionId;
const WORKSPACE_ID = "w1234567890123456789ab" as WorkspaceId;
const TERMINAL_ID = "t1234567890123456789ab";
const PROJECT = "PX V1 apps";
const WORKSPACE = "super simplify";
const TAB = "Claude Resume";

const CONTEXT: PushAlertContext = {
	terminalHandle: TERMINAL_ID,
	projectName: PROJECT,
	workspaceName: WORKSPACE,
	tabTitle: TAB,
	tabCount: 3,
};

describe("(ALERT-CONTEXT-NAMES) shared v3 golden vectors", () => {
	it("mints the alert map the phone's `alert()` fixture parses", () => {
		expect(
			buildLifecyclePushData({
				alertId: EVENT_ID,
				workspaceId: WORKSPACE_ID,
				kind: "g",
				terminalHandle: TERMINAL_ID,
				outcomeAtMs: OUTCOME_AT_MS,
				expiresAtMs: EXPIRY,
				context: CONTEXT,
			}),
		).toEqual({
			v: "3",
			k: "g",
			i: EVENT_ID,
			w: WORKSPACE_ID,
			x: String(EXPIRY),
			t: TERMINAL_ID,
			gx: String(OUTCOME_AT_MS),
			pn: PROJECT,
			wn: WORKSPACE,
			tn: TAB,
			tc: "3",
		});
	});

	it("mints the error alert with the same shape and a different `k`", () => {
		expect(
			buildLifecyclePushData({
				alertId: EVENT_ID,
				workspaceId: WORKSPACE_ID,
				kind: "e",
				terminalHandle: TERMINAL_ID,
				outcomeAtMs: OUTCOME_AT_MS,
				expiresAtMs: EXPIRY,
				context: CONTEXT,
			}),
		).toEqual({
			v: "3",
			k: "e",
			i: EVENT_ID,
			w: WORKSPACE_ID,
			x: String(EXPIRY),
			t: TERMINAL_ID,
			pn: PROJECT,
			wn: WORKSPACE,
			tn: TAB,
			tc: "3",
		});
	});

	it("mints the question map the phone's `question()` fixture parses", () => {
		expect(
			buildQuestionPushData({
				questionId: QUESTION_ID,
				workspaceId: WORKSPACE_ID,
				questionCount: 2,
				expiresAtMs: EXPIRY,
				context: CONTEXT,
			}),
		).toEqual({
			v: "3",
			k: "q",
			i: QUESTION_ID,
			w: WORKSPACE_ID,
			n: "2",
			x: String(EXPIRY),
			t: TERMINAL_ID,
			pn: PROJECT,
			wn: WORKSPACE,
			tn: TAB,
			tc: "3",
		});
	});

	it("mints the retraction map the phone's `retract()` fixture parses", () => {
		// `x` is the FRAME's own expiry, so it is derived rather than passed: the
		// vector is `nowMs + RETRACT_TTL_MS`, which is what the phone's
		// `isExpired` gate is read against.
		expect(
			buildLifecycleRetractPushData({
				alertId: EVENT_ID,
				workspaceId: WORKSPACE_ID,
				terminalHandle: TERMINAL_ID,
				outcomeAtMs: OUTCOME_AT_MS,
				nowMs: EXPIRY - RETRACT_TTL_MS,
			}),
		).toEqual({
			v: "3",
			k: "c",
			i: EVENT_ID,
			w: WORKSPACE_ID,
			x: String(EXPIRY),
			t: TERMINAL_ID,
			gx: String(OUTCOME_AT_MS),
		});
	});

	it('spells absence as `""` on every context key, never as a missing one', () => {
		// The phone refuses `alert() - key` for every one of these. Emitting a
		// partial map would therefore silence the alert entirely rather than
		// degrading it.
		const unnamed = buildLifecyclePushData({
			alertId: EVENT_ID,
			workspaceId: WORKSPACE_ID,
			kind: "g",
			terminalHandle: TERMINAL_ID,
			outcomeAtMs: OUTCOME_AT_MS,
			expiresAtMs: EXPIRY,
			context: null,
		});
		for (const key of ["pn", "wn", "tn", "tc"]) {
			expect(key in unnamed).toBe(true);
			expect((unnamed as unknown as Record<string, string>)[key]).toBe("");
		}
		// (ONE-BUZZ-UNTIL-READ) `t` and `gx` are NOT context keys — they are the
		// notification's identity and come off the alert row, so a context that
		// resolved to nothing cannot cost them.
		expect(unnamed).toMatchObject({
			t: TERMINAL_ID,
			gx: String(OUTCOME_AT_MS),
		});
	});

	it("never emits a name the phone would have to degrade", () => {
		// The phone drops a name over 256 UTF-8 bytes. 64 four-byte emoji are
		// exactly 256 and survive; one more character does not — so the host's
		// sanitizer has to land on the accepting side of the same boundary.
		const sixtyFourEmoji = "🚀".repeat(64);
		expect(Buffer.byteLength(sixtyFourEmoji, "utf8")).toBe(256);

		const data = buildLifecyclePushData({
			alertId: EVENT_ID,
			workspaceId: WORKSPACE_ID,
			kind: "g",
			terminalHandle: TERMINAL_ID,
			outcomeAtMs: OUTCOME_AT_MS,
			expiresAtMs: EXPIRY,
			context: {
				...CONTEXT,
				projectName: `${sixtyFourEmoji}a`,
			},
		}) as unknown as Record<string, string>;

		expect(Buffer.byteLength(data.pn ?? "", "utf8")).toBeLessThanOrEqual(256);
		expect(data.pn).not.toBe("");
	});

	/**
	 * `AlertContext.isRenderable` refuses a name holding a lone surrogate, so a
	 * frame carrying one would arrive and render its GENERIC wording for that
	 * field — the host having believed it sent a name. Both ends now agree the
	 * answer is "no name", and they agree BEFORE the wire rather than after it.
	 */
	it('emits `""` for a name the phone\'s isRenderable would refuse', () => {
		const data = buildLifecyclePushData({
			alertId: EVENT_ID,
			workspaceId: WORKSPACE_ID,
			kind: "g",
			terminalHandle: TERMINAL_ID,
			outcomeAtMs: OUTCOME_AT_MS,
			expiresAtMs: EXPIRY,
			context: {
				...CONTEXT,
				projectName: "px\uD800apps",
				tabTitle: "trailing\uD800",
			},
		}) as unknown as Record<string, string>;

		expect(data.pn).toBe("");
		expect(data.tn).toBe("");
		// One bad field costs one field — the phone's rule, and the host's.
		expect(data.wn).toBe(WORKSPACE);
	});

	it("keeps `collapse_key` equal to `data.i` on every kind, retraction included", () => {
		const frames = [
			buildQuestionPushData({
				questionId: QUESTION_ID,
				workspaceId: WORKSPACE_ID,
				questionCount: 2,
				expiresAtMs: EXPIRY,
				context: CONTEXT,
			}),
			buildLifecyclePushData({
				alertId: EVENT_ID,
				workspaceId: WORKSPACE_ID,
				kind: "g",
				terminalHandle: TERMINAL_ID,
				outcomeAtMs: OUTCOME_AT_MS,
				expiresAtMs: EXPIRY,
				context: CONTEXT,
			}),
			buildLifecyclePushData({
				alertId: EVENT_ID,
				workspaceId: WORKSPACE_ID,
				kind: "e",
				terminalHandle: TERMINAL_ID,
				outcomeAtMs: OUTCOME_AT_MS,
				expiresAtMs: EXPIRY,
				context: CONTEXT,
			}),
			buildLifecycleRetractPushData({
				alertId: EVENT_ID,
				workspaceId: WORKSPACE_ID,
				terminalHandle: TERMINAL_ID,
				outcomeAtMs: OUTCOME_AT_MS,
				nowMs: EXPIRY - RETRACT_TTL_MS,
			}),
		];
		for (const frame of frames) {
			expect(buildEnvelope("token", frame).android.collapse_key).toBe(frame.i);
		}
	});
});

/**
 * (ONE-BUZZ-UNTIL-READ) The REFUSAL vectors, mirrored from `PushV3Test.kt`.
 *
 * `g` and `e` no longer share a key set: a ready alert carries `gx` and an error
 * never does. The phone refuses both directions of that difference, so the host
 * has to be unable to mint either shape — otherwise a frame the host considers
 * fine is silently dropped on arrival and the alert simply never appears.
 */
describe("(ONE-BUZZ-UNTIL-READ) shared v3 refusal vectors", () => {
	function ready(): Record<string, string> {
		return buildLifecyclePushData({
			alertId: EVENT_ID,
			workspaceId: WORKSPACE_ID,
			kind: "g",
			terminalHandle: TERMINAL_ID,
			outcomeAtMs: OUTCOME_AT_MS,
			expiresAtMs: EXPIRY,
			context: CONTEXT,
		}) as unknown as Record<string, string>;
	}

	it("refuses a ready alert with no `t` — nothing to replace in place", () => {
		const { t: _dropped, ...withoutHandle } = ready();
		expect(() =>
			buildEnvelope("token", withoutHandle as unknown as PushData),
		).toThrow(/key set is not closed/);
	});

	it("refuses a ready alert with no `gx` — nothing to order it by", () => {
		const { gx: _dropped, ...withoutOutcome } = ready();
		expect(() =>
			buildEnvelope("token", withoutOutcome as unknown as PushData),
		).toThrow(/key set is not closed/);
	});

	it("refuses an error alert CARRYING `gx` — that key is the ready set's", () => {
		const error = buildLifecyclePushData({
			alertId: EVENT_ID,
			workspaceId: WORKSPACE_ID,
			kind: "e",
			terminalHandle: TERMINAL_ID,
			outcomeAtMs: OUTCOME_AT_MS,
			expiresAtMs: EXPIRY,
			context: CONTEXT,
		});
		expect(() =>
			buildEnvelope("token", {
				...error,
				gx: String(OUTCOME_AT_MS),
			} as unknown as PushData),
		).toThrow(/key set is not closed/);
	});

	it("refuses a retraction with no `gx` — it would cancel whatever is showing", () => {
		const retract = buildLifecycleRetractPushData({
			alertId: EVENT_ID,
			workspaceId: WORKSPACE_ID,
			terminalHandle: TERMINAL_ID,
			outcomeAtMs: OUTCOME_AT_MS,
			nowMs: EXPIRY - RETRACT_TTL_MS,
		}) as unknown as Record<string, string>;
		const { gx: _dropped, ...withoutOutcome } = retract;
		expect(() =>
			buildEnvelope("token", withoutOutcome as unknown as PushData),
		).toThrow(/key set is not closed/);
	});

	it("refuses to MINT a ready alert missing either identity, ahead of the wire", () => {
		expect(() =>
			buildLifecyclePushData({
				alertId: EVENT_ID,
				workspaceId: WORKSPACE_ID,
				kind: "g",
				terminalHandle: "",
				outcomeAtMs: OUTCOME_AT_MS,
				expiresAtMs: EXPIRY,
				context: CONTEXT,
			}),
		).toThrow(/requires a 22-character terminal handle/);
		expect(() =>
			buildLifecyclePushData({
				alertId: EVENT_ID,
				workspaceId: WORKSPACE_ID,
				kind: "g",
				terminalHandle: TERMINAL_ID,
				outcomeAtMs: 0,
				expiresAtMs: EXPIRY,
				context: CONTEXT,
			}),
		).toThrow(/requires the outcome instant/);
		expect(() =>
			buildLifecycleRetractPushData({
				alertId: EVENT_ID,
				workspaceId: WORKSPACE_ID,
				terminalHandle: TERMINAL_ID,
				outcomeAtMs: 0,
				nowMs: EXPIRY - RETRACT_TTL_MS,
			}),
		).toThrow(/requires the outcome instant it cancels/);
	});
});
