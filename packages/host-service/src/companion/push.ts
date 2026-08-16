/**
 * (COMPANION-BRIDGE) — FCM push: registration, the delayed timer, retraction (§7.6, §13).
 *
 * HARD CONSTRAINT OF THE FORMAT, AS AMENDED 2026-08-16. No question text, no
 * option text, no branch name, no file path, no error message and no free text
 * of any kind may EVER appear in an FCM message. Google is not in the trust
 * boundary. This is not a guideline — `assertPushDataSafe` THROWS, it never logs
 * and continues.
 *
 * (ALERT-CONTEXT-NAMES) THE ONE EXEMPTION, AND ITS EXACT SCOPE. On 2026-08-16
 * the owner waived Google-visibility for THREE names and no others: the PROJECT
 * name, the WORKSPACE name and the TAB title, carried plaintext in the v3 keys
 * `pn`, `wn` and `tn`. The waiver was recorded twice — verbatim ("i dont care if
 * google sees it") and re-confirmed through an explicit question — and it is a
 * decision about USEFULNESS: an alert that cannot say WHICH chat finished is an
 * alert the user has to open the laptop to act on, which is the whole thing the
 * companion exists to avoid. The notification must also be self-contained, so
 * the names travel with it rather than being fetched from a PC that may be
 * asleep when it lands.
 *
 * NOTHING ELSE MOVED. The exempt list is exactly {pn, wn, tn}, it is pinned by
 * a test that enumerates it, and every other key on every version still has to
 * match the opaque-id pattern or the send throws. v1 and v2 are FROZEN and
 * carry no names at all; only v3 may. A later edit that wants a fourth name
 * changes this paragraph, that test, and the owner's mind — in that order.
 *
 * The message is data-only. `message.notification` must be absent: setting it
 * would have Android render text supplied through Google's infrastructure —
 * text this process never chose — so the constraint holds by construction.
 * `assertPushDataSafe` enforces a CLOSED key set on the envelope as well as on
 * `data`, so no later edit can add an `apns`/`webpush`/`notification` block
 * carrying text without failing.
 *
 * PRESENCE IS THE FEATURE, AND IT REPLACED A DELAY. A red does not wait three
 * minutes any more; it pushes IMMEDIATELY when the user is away and NEVER while
 * they are at the desk. This module does not own that judgement —
 * `companion/presence.ts` does, from two signals (human keystrokes into a
 * terminal, and the Electron beacon carrying OS idle time and lock state). This
 * module owns what to DO with it:
 *
 *   away at capture      -> fire now, zero latency. The user cannot see the
 *                           question, so every second of delay is a blocked
 *                           agent nobody knows about.
 *   present at capture   -> HOLD, with no deadline. They can see it. A push for
 *                           a question already on their screen is exactly the
 *                           noise that gets a watch muted inside a week, and a
 *                           muted watch is the same as one never built.
 *   present -> away      -> the sweep fires everything still held. Walking away,
 *                           or locking the screen, is the trigger.
 *   answered at the desk -> `cancelPending` disarms it and it never buzzes.
 *
 * There is NO CEILING on a hold. "You have been looking at this question for N
 * minutes, so let me also buzz your wrist" is a notification about something
 * already in front of the user. A hold ends by absence, or by the question
 * expiring (`PUSH_QUESTION_EXPIRY_MS`) — never by a timer.
 *
 * The 30-80 questions a day this handles are mostly answered at the desk within
 * seconds. Under the old delay they cost three minutes of silence each when
 * nobody was there; under presence gating they buzz at once when nobody is
 * there, and not at all when somebody is. The notification's meaning is
 * unchanged and is the whole point: *nobody has dealt with this.*
 *
 * -- Sleep / resume (still no per-question `setTimeout`) ----------------------
 *
 * VERIFIED, not assumed, and the reasoning survives the redesign intact. Node
 * timers are driven by libuv's monotonic clock (`uv_hrtime`), which on Windows
 * is `QueryPerformanceCounter`, and Microsoft documents QPC's suspend behaviour
 * explicitly:
 *
 *   "QueryPerformanceCounter reads the performance counter and returns the
 *    total number of ticks that have occurred since the Windows operating
 *    system was started, INCLUDING THE TIME WHEN THE MACHINE WAS IN A SLEEP
 *    STATE such as standby, hibernate, or connected standby."
 *   -- learn.microsoft.com/windows/win32/sysinfo/acquiring-high-resolution-time-stamps
 *
 * So a `setTimeout` deadline armed before a six-hour suspend does not fire at
 * its deadline and does not fire some grace period after the lid opens: it
 * fires the instant the process thaws, for every question at once, at the exact
 * moment the user sits back down. That is why there is no per-question timer
 * here, only a coarse repeating sweep that re-evaluates presence and therefore
 * has no deadline to miss.
 *
 * The batched-buzz-at-lid-open failure the old awake-time accounting existed to
 * prevent has NOT been forgotten — it moved to where it belongs. A machine that
 * has just woken has a keystroke stamp from before the suspend and no fresh
 * beacon, which reads as "away" and would fire everything held. `presence.ts`
 * opens a ten-second settling window on an Electron `resume`/`unlock` beacon, in
 * which held questions stay held (F7). It delays a correct push by ten seconds;
 * it never cancels one.
 *
 * `Date.now()` is wall-clock, so it is corrected on resume and stepped by NTP in
 * either direction. Every age computed from it in this feature is clamped at
 * zero and discarded past a future tolerance, and both failure directions
 * resolve towards "away" — see `human-input.ts` and `presence.ts`.
 *
 * -- Serialising a send against its own retraction ----------------------------
 *
 * A send takes tens of seconds in the worst case (bounded retries with backoff).
 * The old code committed the sent record, started the broadcast, and let
 * `retract` run independently — so an answer arriving mid-send could complete
 * its retraction while the ORIGINAL push was still in FCM's queue, and the
 * original would then be delivered AFTER the retraction that was supposed to
 * cancel it. The notification outlives its subject, which is the one thing §13.3
 * exists to prevent.
 *
 * So every FCM operation for a questionId runs on a per-question promise chain,
 * and a retraction additionally CANCELS the in-flight send (the cancel is
 * checked between attempts, so a retraction does not wait out four backoffs).
 * Chaining per question is strictly stronger than the per-(questionId, device)
 * ordering that is actually required, and is far simpler to prove.
 *
 * -- Restart (the fence) ------------------------------------------------------
 *
 * Schedule state used to be deliberately in-memory: a restart drops it, but a
 * restart also drops the question store, so questions are re-captured from the
 * hook path and re-armed from zero. True, and harmless for a three-minute delay.
 * Not harmless now — a HELD question has no deadline, so losing it loses the
 * push entirely, and a question already pushed would be re-armed and pushed a
 * SECOND time. Both the armed set and the sent set are therefore rows in host.db
 * (`push-fence.ts`), reconstructed at start.
 *
 * The sweeper still never trusts `cancelPending`: at fire time it re-asks the
 * question store whether the question is still unanswered.
 *
 * ── Trust / secrets ──────────────────────────────────────────────────────────
 *
 * The service account at `~/.superset/companion/fcm-service-account.json` lives
 * OUTSIDE both repos. Its contents are never logged, never included in an error
 * message, and never returned to a caller: failures name the FIELD or the PATH,
 * never a value. Minted OAuth access tokens are held in memory only and are
 * likewise never logged.
 *
 * An auth failure FAILS LOUD. A broken service account must not degrade to
 * silence — silence is indistinguishable from "no questions", which is the one
 * state the user must never be wrong about.
 */

import { createSign, randomInt } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
	FCM_PROJECT_ID,
	ORPHAN_VERIFY_DEADLINE_MS,
	PUSH_DATA_HARD_CAP_BYTES,
	PUSH_DATA_HARD_CAP_BYTES_V3,
	PUSH_GONE_CORROBORATION_MS,
	PUSH_NAME_MAX_BYTES,
	PUSH_TTL_MS,
	PUSH_VALUE_PATTERN,
	RETRACT_TTL_MS,
} from "./config";
import { base64UrlEncode, sleep } from "./crypto";
import type { DeviceStore } from "./device-store";
import { findUnpairedSurrogate } from "./keystrokes";
import { MAX_APP_VERSION_CHARS } from "./limits";
import type { PresenceStore, PresenceVerdict } from "./presence";
import type { PushAlertContext } from "./push-context";
import type { PushFence, PushFenceRecord } from "./push-fence";
import type { OrphanTranscriptVerdict } from "./question-store";
import type {
	DeviceRecord,
	PushData,
	PushEnvelope,
	QuestionId,
	RegisterRequest,
	RegisterResponse,
	SealedRequestContext,
	WorkspaceId,
} from "./types";
import { SealedError } from "./types";

// ---------------------------------------------------------------------------
// Constants. PUSH_TTL_MS / PUSH_DATA_HARD_CAP_BYTES are normative in
// PROTOCOL.md §15 and come from config.ts, as do the two presence windows
// (PRESENCE_WINDOW_MS / BEACON_FRESH_MS) that `presence.ts` reads. The ones
// below are implementation choices of this module — named, not magic.
// ---------------------------------------------------------------------------

/**
 * (PUSH-PRESENCE) How often the scheduler re-evaluates held questions.
 *
 * This is the ONLY timer in the module and it is a repeating coarse tick, never
 * a per-question deadline (see the sleep/resume note above). It was 15 s, sized
 * against a 180 s delay where the granularity was immaterial. It is now the
 * latency between the user walking away and their phone buzzing about a question
 * that was held while they were there, so it is 2 s: fast enough to feel
 * immediate, slow enough to be free (one presence evaluation over a map that is
 * empty almost all the time, on an unref'd timer that only runs while something
 * is actually held).
 *
 * A question captured while the user is ALREADY away does not wait for a tick at
 * all — `schedule` evaluates presence inline and fires on the spot.
 */
export const PUSH_SWEEP_INTERVAL_MS = 2_000;

/**
 * How long a "we pushed this" record is kept after the push, so `retract` knows
 * whether a notification actually exists on the phone.
 *
 * (RETRACT-WINDOW) It used to be one `PUSH_TTL_MS` (15 min), on the reasoning
 * that "after that FCM itself has given up delivering and there is nothing left
 * to retract". That reasoning covers the wrong message. `PUSH_TTL_MS` bounds how
 * long FCM will keep trying to DELIVER an undelivered message; it says nothing
 * about a message that WAS delivered, whose notification then sits on the
 * handset until something dismisses it. Sixteen minutes after the buzz, the
 * record was gone, `sendRetraction` returned silently, and the notification for
 * an answered question stayed on the watch until the phone next came to the
 * foreground and swept.
 *
 * A retraction is meaningful for exactly as long as the notification can still
 * be on the device, so this now matches the question store's own 24 h retention:
 * past that the question itself is gone and there is nothing to be consistent
 * with. Cost is one small record per push, and 30-80 pushes a day is the
 * measured traffic.
 */
export const PUSH_SENT_RECORD_RETENTION_MS = 86_400_000;

/**
 * (RETRACT-WINDOW) Hard ceiling on the sent-record map, so lengthening the
 * retention cannot turn into unbounded growth if the traffic assumption above is
 * ever wrong. Oldest-first eviction, loudly — an evicted record is a retraction
 * that will silently no-op.
 */
export const PUSH_MAX_SENT_RECORDS = 4_096;

/** Google's documented ceiling on an FCM message payload. Ours is 160 bytes. */
export const FCM_PAYLOAD_ABSOLUTE_CAP_BYTES = 4096;

export const FCM_SEND_ENDPOINT = `https://fcm.googleapis.com/v1/projects/${FCM_PROJECT_ID}/messages:send`;
export const FCM_OAUTH_SCOPE =
	"https://www.googleapis.com/auth/firebase.messaging";
export const FCM_OAUTH_AUDIENCE = "https://oauth2.googleapis.com/token";
export const FCM_OAUTH_GRANT_TYPE =
	"urn:ietf:params:oauth:grant-type:jwt-bearer";

/** Lifetime requested for the self-signed JWT assertion. Google's maximum. */
export const OAUTH_ASSERTION_LIFETIME_S = 3600;
/** Refresh this long before the access token actually expires. */
export const OAUTH_REFRESH_SKEW_MS = 300_000;

export const FCM_REQUEST_TIMEOUT_MS = 10_000;
/** Total attempts per device per message, including the first. Bounded, always. */
export const FCM_SEND_MAX_ATTEMPTS = 4;
export const FCM_BACKOFF_BASE_MS = 1_000;
export const FCM_BACKOFF_MAX_MS = 30_000;

/** FCM registration tokens are base64url-ish with a `:` separator. */
const FCM_TOKEN_PATTERN = /^[A-Za-z0-9_:.-]{32,4096}$/;
/**
 * The length comes from `limits.ts` so this cannot drift from the cap
 * `pairing.ts` and `http.ts` enforce on the same value; the CHARACTER SET is
 * this boundary's own and is deliberately stricter than theirs.
 */
const APP_VERSION_PATTERN = new RegExp(
	`^[A-Za-z0-9_.+-]{1,${MAX_APP_VERSION_CHARS}}$`,
);
/**
 * (LIFECYCLE-ALERT) The EXACT identity shape a lifecycle alert carries: a
 * generated 22-character opaque base64url id. That is what `lifecycleAlertId`
 * mints (a truncated SHA-256 digest) and what `deriveHandle` mints for a
 * workspace handle — the two are produced differently, and the 22-character
 * base64url form is the property they share and the only one asserted here.
 *
 * Stricter than `PUSH_VALUE_PATTERN` on purpose. That one is the last-line leak
 * guard at the FCM boundary and admits anything opaque up to 43 chars; this one
 * is the boundary contract of `buildLifecyclePushData`, where the only correct
 * values are those two generated identities. Anything else is a caller bug and
 * must throw at the call site that introduced it.
 */
const LIFECYCLE_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

const LOG = "[companion/push]";

// ---------------------------------------------------------------------------
// Faults
// ---------------------------------------------------------------------------

/**
 * A condition that makes push structurally impossible: a missing or malformed
 * service account, a rejected assertion, a revoked key, the wrong project. It is
 * NOT recoverable by retrying and it must never be swallowed — the user would
 * see a silent watch and read it as "no questions".
 */
export interface PushFault {
	kind: "config" | "auth";
	atMs: number;
	/** Diagnostic. Never contains key material, a token, or question text. */
	message: string;
}

/** Thrown on the synchronous paths; recorded as a `PushFault` on the async ones. */
export class PushConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PushConfigError";
	}
}

export class PushAuthError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PushAuthError";
	}
}

// ---------------------------------------------------------------------------
// §13.1 — the payload, and the runtime assertions that make a text leak throw
// ---------------------------------------------------------------------------

/**
 * §13.1 / §13.4 / §13.5 — the closed key set PER (VERSION, KIND).
 *
 * (LIFECYCLE-ALERT) Two shapes, never one widened shape. v1 carries `n` (how
 * many questions are pending) and v2 does not, because a lifecycle alert is not
 * about a count of anything; making `n` optional across both would have turned
 * two exact contracts into one vague one that neither the Android client nor
 * this assertion could check. `v` is read first and decides which set applies,
 * so v1 stays FROZEN as every already-installed client parses it.
 *
 * (ALERT-CONTEXT-NAMES) v3 needed a second axis. Its three kinds are not one
 * shape: an alert carries names, a retraction carries none (the phone already
 * holds them), and a question additionally carries `n`. Keying by version alone
 * would have forced the union of all three onto every kind and made `n` and the
 * name fields meaningless-but-present on a retraction — exactly the vagueness
 * the per-version split was introduced to end. v1 and v2 keep their single
 * per-version set, expressed here as every kind mapping to the same array, so
 * NOTHING about their validation changed.
 */
const PUSH_DATA_KEYS_BY_VERSION_KIND: Readonly<
	Record<string, Readonly<Record<string, readonly string[]>>>
> = {
	"1": {
		q: ["v", "k", "i", "w", "n", "x"],
		r: ["v", "k", "i", "w", "n", "x"],
	},
	"2": {
		g: ["v", "k", "i", "w", "x"],
		e: ["v", "k", "i", "w", "x"],
	},
	"3": {
		q: ["v", "k", "i", "w", "n", "x", "t", "pn", "wn", "tn", "tc"],
		g: ["v", "k", "i", "w", "x", "gx", "t", "pn", "wn", "tn", "tc"],
		e: ["v", "k", "i", "w", "x", "t", "pn", "wn", "tn", "tc"],
		c: ["v", "k", "i", "w", "x", "gx", "t"],
	},
};

/**
 * (ALERT-CONTEXT-NAMES) What each key's VALUE may be.
 *
 *  - `opaque` — the original rule: `/^[A-Za-z0-9_-]{1,43}$/`, which no
 *    natural-language string satisfies. Everything on v1 and v2 is this, and
 *    that is why those two versions cannot leak text by construction.
 *  - `opaque-or-empty` — the same, plus `""` for "absent". v3 keys only.
 *  - `digits-or-empty` — a decimal count, or `""`. `tc` only.
 *  - `name` — THE EXEMPTION. Plaintext UTF-8, bounded in BYTES, free of
 *    controls and line separators. `pn`/`wn`/`tn` only, and this list is
 *    enumerated by a test so widening it is a deliberate, visible act.
 *
 * ONE TABLE, NOT ONE PER VERSION. A key means the same thing wherever it
 * appears — `i` is an opaque id on every version, `n` a count on both that
 * carry it — so a per-version table was three copies of one fact, and the only
 * thing it could express that this cannot is a key whose rule CHANGES between
 * versions, which would be a redefinition rather than a version. What actually
 * keeps v1 and v2 free of names is not this table but
 * `PUSH_DATA_KEYS_BY_VERSION_KIND`: `pn`/`wn`/`tn` are not in their key sets, so
 * a v1 frame carrying one is refused as an unexpected key before any value rule
 * is consulted.
 */
type PushValueRule =
	| "opaque"
	| "opaque-or-empty"
	| "digits"
	| "digits-or-empty"
	| "name";

const PUSH_VALUE_RULES: Readonly<Record<string, PushValueRule>> = {
	v: "opaque",
	k: "opaque",
	i: "opaque",
	w: "opaque",
	n: "opaque",
	x: "opaque",
	t: "opaque-or-empty",
	gx: "digits",
	pn: "name",
	wn: "name",
	tn: "name",
	tc: "digits-or-empty",
};

/**
 * (ONE-BUZZ-UNTIL-READ) The one place a KIND is stricter than its key's general
 * rule.
 *
 * A ready alert's `t` is not optional the way a question's is: the phone keys
 * ready notifications BY TERMINAL so a later finish replaces the standing card
 * in place, and a `g` with `t: ""` is a card that can never be replaced. That
 * is the exact failure `(ONE-BUZZ-UNTIL-READ)` exists to prevent, so it is
 * refused at the boundary rather than degraded.
 *
 * An override table rather than a per-version one: this is a single deliberate
 * exception, and spelling it out is clearer than three near-identical copies of
 * every other key.
 */
const PUSH_VALUE_RULE_OVERRIDES: Readonly<
	Record<string, Readonly<Record<string, PushValueRule>>>
> = {
	g: { t: "opaque" },
};

/**
 * (ALERT-CONTEXT-NAMES) The ONLY keys any version may carry plaintext in.
 *
 * Exported and enumerated by a test on purpose: this list IS the blast radius
 * of the 2026-08-16 waiver, and a fourth entry appearing in it must fail a test
 * rather than ship quietly.
 */
export const PUSH_NAME_EXEMPT_KEYS: readonly string[] = ["pn", "wn", "tn"];

/** Per-version `data` byte cap. v1/v2 keep the 160-byte leak tripwire intact. */
const PUSH_DATA_CAP_BY_VERSION: Readonly<Record<string, number>> = {
	"1": PUSH_DATA_HARD_CAP_BYTES,
	"2": PUSH_DATA_HARD_CAP_BYTES,
	"3": PUSH_DATA_HARD_CAP_BYTES_V3,
};

const DIGITS_PATTERN = /^[0-9]+$/;
/**
 * C0 (incl. every newline), DEL + C1, and the two Unicode line/paragraph
 * separators. Android renders U+2028 as a line break inside a notification
 * title, so a tab title containing one would silently restructure the layout.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const FORBIDDEN_NAME_CHARS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;

const ELLIPSIS = "…";
const ELLIPSIS_BYTES = Buffer.byteLength(ELLIPSIS, "utf8");

const PUSH_ENVELOPE_KEYS = ["token", "android", "data"] as const;
const PUSH_ANDROID_KEYS = ["priority", "ttl", "collapse_key"] as const;

/**
 * (ALERT-CONTEXT-NAMES) Make ANY string safe to put in `pn`/`wn`/`tn`.
 *
 * TOTAL BY CONSTRUCTION — it takes `unknown`, it never throws, and there is no
 * input for which it has no answer. That is a requirement rather than a
 * convenience: this runs on the send path of an alert about a blocked or
 * finished agent, and a name that could fail a send would let a workspace
 * called something unexpected silence the notification entirely. Anything it
 * cannot use becomes `""`, which the phone reads as "no context" and answers
 * with its generic strings.
 *
 * BYTES, NOT CHARACTERS, AND CODE POINTS, NOT UNITS. The budget is UTF-8 bytes
 * because that is what the wire and the phone both measure; the truncation
 * walks CODE POINTS because `slice` on a JS string cuts UTF-16 units and can
 * split a surrogate pair, producing a lone surrogate that is not valid UTF-8 at
 * all — an emoji in a tab title is not exotic. Three bytes are reserved for the
 * ellipsis so a truncated name is visibly truncated and still inside budget.
 *
 * A LONE SURROGATE DEGRADES THE WHOLE FIELD, IT IS NOT STRIPPED OUT, and that
 * asymmetry with the control characters above is not an inconsistency — it is
 * the phone's rule, copied. `AlertContext.name()` refuses a name containing one
 * outright (`isRenderable`), so a host that stripped the half and sent the rest
 * would send a name the phone accepts while the two ends disagree about what
 * the name IS. Matching the stricter side means the two implementations can
 * never render different text for the same input. Control characters are
 * different only because the host strips them BEFORE sending, so the phone
 * never sees a name containing one.
 *
 * The well-formedness test is `findUnpairedSurrogate` from `keystrokes.ts`,
 * shared rather than re-derived: its own doc forbids a second drifting copy,
 * and it already encodes the exact unit-by-unit walk this needs.
 *
 * It never logs. Not the input, not the output, not a length: this function
 * exists at the boundary where a value stops being private, and a diagnostic
 * that echoed one would defeat every other rule in this module.
 */
export function sanitizePushName(value: unknown): string {
	if (typeof value !== "string" || value.length === 0) return "";
	// Checked on the RAW value, before anything is stripped or truncated, for
	// the same reason the phone checks the raw value it received: the defect is
	// a property of the string as it stands, and later edits could only hide it.
	if (findUnpairedSurrogate(value) !== null) return "";

	let stripped = "";
	for (const codePoint of value) {
		if (FORBIDDEN_NAME_CHARS.test(codePoint)) continue;
		stripped += codePoint;
	}
	const trimmed = stripped.trim();
	if (trimmed.length === 0) return "";
	if (Buffer.byteLength(trimmed, "utf8") <= PUSH_NAME_MAX_BYTES) return trimmed;

	const budget = PUSH_NAME_MAX_BYTES - ELLIPSIS_BYTES;
	let kept = "";
	let used = 0;
	for (const codePoint of trimmed) {
		const size = Buffer.byteLength(codePoint, "utf8");
		if (used + size > budget) break;
		kept += codePoint;
		used += size;
	}
	// A name that is entirely one over-long code point still has to say
	// something, and the ellipsis alone is inside budget.
	const head = kept.trimEnd();
	return head.length === 0 ? ELLIPSIS : `${head}${ELLIPSIS}`;
}

function assertClosedKeySet(
	value: object,
	expected: readonly string[],
	what: string,
): void {
	const actual = Object.keys(value).sort();
	const wanted = [...expected].sort();
	if (actual.length !== wanted.length) {
		throw new PushConfigError(
			`${what} key set is not closed: expected [${wanted.join(",")}], got [${actual.join(",")}]`,
		);
	}
	for (let i = 0; i < wanted.length; i++) {
		if (actual[i] !== wanted[i]) {
			throw new PushConfigError(
				`${what} key set is not closed: expected [${wanted.join(",")}], got [${actual.join(",")}]`,
			);
		}
	}
}

/**
 * Does one value satisfy its rule? The VALUE IS NEVER RETURNED OR ECHOED — the
 * caller only learns yes or no, because when the answer is no the value is
 * exactly the thing that must not leave the process.
 */
function valueSatisfiesRule(value: string, rule: PushValueRule): boolean {
	switch (rule) {
		case "opaque":
			return PUSH_VALUE_PATTERN.test(value);
		case "opaque-or-empty":
			return value.length === 0 || PUSH_VALUE_PATTERN.test(value);
		case "digits":
			return DIGITS_PATTERN.test(value);
		case "digits-or-empty":
			return value.length === 0 || DIGITS_PATTERN.test(value);
		case "name":
			return (
				!FORBIDDEN_NAME_CHARS.test(value) &&
				Buffer.byteLength(value, "utf8") <= PUSH_NAME_MAX_BYTES
			);
	}
}

/**
 * §13.1 runtime assertions, each a THROW, never a log-and-continue:
 *  - `data.v` names a version this build knows AND `data.k` a kind that version
 *    may carry, and the `data` key set is EXACTLY that (version, kind)'s — an
 *    unexpected key is a bug;
 *  - every value satisfies its version's rule for that key: opaque by default,
 *    which no natural-language string satisfies, so a leak cannot be introduced
 *    by a later edit without failing immediately. (ALERT-CONTEXT-NAMES) The
 *    three exempt v3 name keys are bounded in BYTES and refused any control
 *    character instead — see `PUSH_NAME_EXEMPT_KEYS` and the doctrine above;
 *  - serialised `data` is inside its VERSION's cap (v1/v2 160 bytes, the leak
 *    tripwire; v3 2048), and the whole message inside Google's 4096;
 *  - `message.notification` is absent — enforced by a CLOSED envelope key set,
 *    which also rules out `apns`, `webpush` and `fcm_options`;
 *  - `collapse_key` is `data.i` — the questionId on a question, the alert id on
 *    a lifecycle alert — so a retraction replaces an original push that is still
 *    queued undelivered at FCM (§13.3), and two messages about the same subject
 *    can never both stand.
 */
export function assertPushDataSafe(
	data: PushData,
	envelope: PushEnvelope,
): void {
	// `v` is read BEFORE the key-set check, because it is what SELECTS the key
	// set. An unknown version cannot be validated at all and must never be sent:
	// the client would not know how to read it either.
	// `data.v` is a declared union, but this is the boundary that must hold for a
	// value the type system only THINKS it knows — read it through `unknown`
	// rather than casting the union to an index-signature type it is not.
	const version: unknown = data.v;
	if (typeof version !== "string") {
		throw new PushConfigError(
			`push data.v must be a string, got ${typeof version}`,
		);
	}
	const keysByKind = PUSH_DATA_KEYS_BY_VERSION_KIND[version];
	const cap = PUSH_DATA_CAP_BY_VERSION[version];
	if (keysByKind === undefined || cap === undefined) {
		throw new PushConfigError(
			`push data.v is "${version}", which this build has no closed key set for — refusing to send`,
		);
	}
	// (ALERT-CONTEXT-NAMES) `k` selects the key set on v3, so it is read second
	// and before anything else — an unknown kind has no shape to check against.
	const kind: unknown = data.k;
	const kinds = Object.keys(keysByKind).sort();
	if (typeof kind !== "string" || keysByKind[kind] === undefined) {
		throw new PushConfigError(
			`push data.k must be one of ${kinds.map((k) => `"${k}"`).join(" or ")} for v${version}`,
		);
	}
	const dataKeys = keysByKind[kind];

	assertClosedKeySet(data, dataKeys, `push data (v${version} k=${kind})`);
	assertClosedKeySet(envelope, PUSH_ENVELOPE_KEYS, "push envelope");
	assertClosedKeySet(envelope.android, PUSH_ANDROID_KEYS, "push android block");

	const record = data as unknown as Record<string, unknown>;
	for (const key of dataKeys) {
		const value: unknown = record[key];
		if (typeof value !== "string") {
			throw new PushConfigError(
				`push data.${key} must be a string, got ${typeof value}`,
			);
		}
		const rule =
			PUSH_VALUE_RULE_OVERRIDES[kind]?.[key] ?? PUSH_VALUE_RULES[key];
		if (rule === undefined) {
			throw new PushConfigError(
				`push data.${key} has no value rule — refusing to send`,
			);
		}
		if (rule === "name" && !PUSH_NAME_EXEMPT_KEYS.includes(key)) {
			// Belt and braces on the waiver's blast radius: a key can only be
			// plaintext if BOTH tables agree it may be.
			throw new PushConfigError(
				`push data.${key} claims the plaintext-name rule but is not in the exempt key set — refusing to send`,
			);
		}
		if (!valueSatisfiesRule(value, rule)) {
			// The value is NOT echoed: if the assertion is firing, the value is
			// exactly the thing that must not leave the process.
			throw new PushConfigError(
				`push data.${key} does not satisfy the "${rule}" rule for v${version} — refusing to send (possible text leak)`,
			);
		}
	}

	const serialisedData = JSON.stringify(data);
	const dataBytes = Buffer.byteLength(serialisedData, "utf8");
	if (dataBytes > cap) {
		throw new PushConfigError(
			`push data is ${dataBytes} bytes, cap is ${cap} on v${version}`,
		);
	}

	const messageBytes = Buffer.byteLength(
		JSON.stringify({ message: envelope }),
		"utf8",
	);
	if (messageBytes > FCM_PAYLOAD_ABSOLUTE_CAP_BYTES) {
		throw new PushConfigError(
			`push message is ${messageBytes} bytes, FCM cap is ${FCM_PAYLOAD_ABSOLUTE_CAP_BYTES}`,
		);
	}

	if (envelope.android.priority !== "high") {
		throw new PushConfigError(
			"push must be high priority or it will not survive Doze",
		);
	}
	if (envelope.android.collapse_key !== data.i) {
		throw new PushConfigError(
			"push collapse_key must be data.i (the questionId on a question, the alert id on a lifecycle alert) so a later message about the same subject replaces the original",
		);
	}
	if (envelope.token.length === 0) {
		throw new PushConfigError("push token is empty");
	}
}

/**
 * (ALERT-CONTEXT-NAMES) Is this frame a RETRACTION? Read off the frame itself
 * rather than passed in beside it, so a caller cannot get the pairing wrong.
 */
function isRetractionFrame(data: PushData): boolean {
	return data.k === "r" || data.k === "c";
}

/**
 * (RETRACT-TTL) The FCM envelope's own TTL, per message.
 *
 * It used to be `PUSH_TTL_MS` (15 min) for everything, and for an ALERT that is
 * right: a "somebody is blocked" buzz that arrives an hour late is noise about a
 * moment that has passed. A RETRACTION is the exact opposite kind of message and
 * had been inheriting the alert's number, which is a latent hole the question
 * path had carried since it shipped: a handset off the network, in Doze, or
 * powered down for more than fifteen minutes never received the frame at all,
 * and the notification it was sent to clear survived on the device. `x` inside
 * the payload was already 24 h for exactly that reason (`RETRACT_TTL_MS`) — the
 * ENVELOPE now agrees with it, so FCM keeps trying for as long as the frame is
 * still meaningful.
 */
function envelopeTtlMs(data: PushData): number {
	return isRetractionFrame(data) ? RETRACT_TTL_MS : PUSH_TTL_MS;
}

/**
 * The FCM message this process will actually send, asserted before it exists as
 * a value a caller could hold. Exported so the TTL choice — the one part of the
 * envelope that differs per message — is assertable without a network.
 */
export function buildEnvelope(token: string, data: PushData): PushEnvelope {
	const envelope: PushEnvelope = {
		token,
		android: {
			priority: "high",
			ttl: `${Math.floor(envelopeTtlMs(data) / 1000)}s`,
			collapse_key: data.i,
		},
		data,
	};
	assertPushDataSafe(data, envelope);
	return envelope;
}

/**
 * (ALERT-CONTEXT-NAMES) The NAME keys every v3 alert carries, derived once so
 * the question builder and the lifecycle builders cannot disagree about what
 * "absent" looks like.
 *
 * TOTAL. A missing context and an unusable name both resolve to `""` rather
 * than to a throw. The alert is the product; the names are a courtesy, and a
 * courtesy may never be able to cancel the product.
 *
 * (ONE-BUZZ-UNTIL-READ) `t` IS NOT IN HERE ANY MORE. The terminal handle used
 * to ride along with the names, which meant a context resolution that failed —
 * a deleted workspace row, a locked db — silently degraded the handle to `""`
 * along with them. For a ready alert that is not a cosmetic loss: `t` is the
 * notification's identity on the phone, and a `g` without it can never be
 * replaced in place. The handle is now derived from the alert's own terminal id
 * by each lifecycle builder's caller and passed explicitly, so it cannot share
 * a failure mode with the names.
 */
function contextNameKeys(context: PushAlertContext | null): {
	pn: string;
	wn: string;
	tn: string;
	tc: string;
} {
	if (context === null || context === undefined) {
		return { pn: "", wn: "", tn: "", tc: "" };
	}
	const tabCount = context.tabCount;
	return {
		pn: sanitizePushName(context.projectName),
		wn: sanitizePushName(context.workspaceName),
		tn: sanitizePushName(context.tabTitle),
		tc:
			typeof tabCount === "number" &&
			Number.isInteger(tabCount) &&
			tabCount >= 0 &&
			tabCount <= 9_999
				? String(tabCount)
				: "",
	};
}

/**
 * (ALERT-CONTEXT-NAMES) A terminal handle, or `""`.
 *
 * TOTAL, like the name sanitiser beside it and for the same reason: `t` is
 * addressing information for a watch dismissal, not the alert itself, so a
 * handle this process cannot vouch for costs the frame its `t` and nothing
 * more. The shape is the generated 22-character opaque id — anything else is
 * either absent or a caller bug, and both answer `""`.
 */
function sanitizeTerminalHandle(handle: unknown): string {
	return typeof handle === "string" && LIFECYCLE_ID_PATTERN.test(handle)
		? handle
		: "";
}

/**
 * §13.1 / §13.5 — `k: "q"`, a question is pending and nobody has dealt with it.
 *
 * (ALERT-CONTEXT-NAMES) EMITS v3, and stays a SEPARATE builder from the
 * lifecycle one. They share the same context keys and nothing else: a question
 * carries `n`, a lifecycle alert never does, and folding them together would
 * reintroduce exactly the "one vague contract" the per-version split exists to
 * prevent. The retraction for a question is still v1 `r` — see
 * `buildRetractPushData`, which is FROZEN.
 */
export function buildQuestionPushData(input: {
	questionId: QuestionId;
	workspaceId: WorkspaceId;
	questionCount: number;
	expiresAtMs: number;
	/** `null` when nothing could be resolved. Never a reason to fail the send. */
	context: PushAlertContext | null;
}): PushData {
	if (
		!Number.isInteger(input.questionCount) ||
		input.questionCount < 1 ||
		input.questionCount > 99
	) {
		throw new PushConfigError(
			`questionCount must be an integer in 1..99, got ${String(input.questionCount)}`,
		);
	}
	if (!Number.isInteger(input.expiresAtMs) || input.expiresAtMs <= 0) {
		throw new PushConfigError("expiresAtMs must be a positive integer");
	}
	const { pn, wn, tn, tc } = contextNameKeys(input.context);
	return {
		v: "3",
		k: "q",
		i: input.questionId,
		w: input.workspaceId,
		n: String(input.questionCount),
		x: String(input.expiresAtMs),
		// A question's handle stays OPTIONAL: it is a deep-link hint, not the
		// notification's identity, and a pre-upgrade fence row genuinely has none.
		t: sanitizeTerminalHandle(input.context?.terminalHandle),
		pn,
		wn,
		tn,
		tc,
	};
}

/**
 * §13.3 — `k: "r"`, cancel the notification; a notification must never outlive
 * its subject.
 *
 * v1, AND FROZEN THERE. (ALERT-CONTEXT-NAMES) moved the question ALERT to v3
 * and deliberately left its retraction where it was: the phone matches a
 * retraction to a notification by `i` alone, every already-installed client
 * parses this exact shape, and a retraction carries no context worth versioning
 * — the notification it cancels already holds the names.
 *
 * (RETRACT-TTL) `x` is the frame's OWN expiry, not the question's. The client
 * checks `isExpired(now)` before it looks at `k`, so stamping `nowMs` here made
 * every retraction expired on arrival and the notification it named survived on
 * the handset. See `RETRACT_TTL_MS` for why the window is a day — and
 * `envelopeTtlMs` for the FCM-side half of the same fix.
 */
export function buildRetractPushData(input: {
	questionId: QuestionId;
	workspaceId: WorkspaceId;
	nowMs: number;
}): PushData {
	if (!Number.isInteger(input.nowMs) || input.nowMs <= 0) {
		throw new PushConfigError("nowMs must be a positive integer");
	}
	return {
		v: "1",
		k: "r",
		i: input.questionId,
		w: input.workspaceId,
		n: "0",
		x: String(input.nowMs + RETRACT_TTL_MS),
	};
}

/**
 * (LIFECYCLE-ALERT) §13.4 / §13.5 — `k: "g"` a work-cycle ended cleanly and
 * there is something to review; `k: "e"` the terminal agent itself failed.
 *
 * (ALERT-CONTEXT-NAMES) THESE DO RETRACT NOW, and the paragraph that used to
 * stand here saying they never would has been deleted rather than worked
 * around. The argument it made — a lifecycle alert reports an instant that
 * already happened, so it cannot stop being true — was answered by the owner on
 * 2026-08-16 with the thing the argument leaves out: the user READ the chat.
 * The green dot clearing on the desktop is precisely the fact that makes the
 * buzz on the wrist stale, and a notification the user has already acted on is
 * noise of exactly the kind that gets a watch muted. `buildLifecycleRetractPushData`
 * is the frame; `lifecycle-alerts.ts` owns when it is sent. `x` still bounds how
 * long the client will render an alert, which remains the freshness contract for
 * an alert nobody retracts.
 *
 * Every field is validated at this boundary rather than at the send: a bad
 * expiry or an id that could carry text must throw at the call site that
 * introduced it, not hours later from inside a timer.
 *
 * THE IDS ARE CHECKED HERE, NOT DOWNSTREAM, and that is the whole point of the
 * paragraph above. `assertPushDataSafe` does catch a text-carrying id, but only
 * once a device envelope is built — so a malformed id reached the caller as a
 * throw from inside a broadcast, and on an install with NO registered device
 * `broadcast` returns before any envelope exists and the same id was never
 * rejected at all. Both ids are generated 22-character opaque base64url
 * identifiers, so the exact shape is knowable right here.
 */
export function buildLifecyclePushData(input: {
	alertId: string;
	workspaceId: WorkspaceId;
	kind: "g" | "e";
	expiresAtMs: number;
	/**
	 * (ONE-BUZZ-UNTIL-READ) The terminal handle, derived from the ALERT ROW's
	 * own terminal id — never read out of `context`. REQUIRED and non-empty for
	 * a ready alert (it is the notification's identity on the phone); optional
	 * for an error, which is never replaced in place.
	 */
	terminalHandle: string;
	/**
	 * (ONE-BUZZ-UNTIL-READ) The outcome event's instant — the same one the alert
	 * id hashes. Required for `g`, ignored for `e`.
	 */
	outcomeAtMs: number;
	/** `null` when nothing could be resolved. Never a reason to fail the send. */
	context: PushAlertContext | null;
}): PushData {
	if (input.kind !== "g" && input.kind !== "e") {
		throw new PushConfigError(
			`lifecycle alert kind must be "g" or "e", got ${String(input.kind)}`,
		);
	}
	assertLifecycleIdentity(input.alertId, input.workspaceId);
	if (!Number.isInteger(input.expiresAtMs) || input.expiresAtMs <= 0) {
		throw new PushConfigError("expiresAtMs must be a positive integer");
	}
	const names = contextNameKeys(input.context);
	const handle = sanitizeTerminalHandle(input.terminalHandle);

	if (input.kind === "e") {
		return {
			v: "3",
			k: "e",
			i: input.alertId,
			w: input.workspaceId,
			x: String(input.expiresAtMs),
			t: handle,
			...names,
		};
	}

	// (ONE-BUZZ-UNTIL-READ) A ready alert without a handle is one the phone can
	// never replace in place, which is the whole mechanism. The value is NOT
	// echoed, for the same reason no other id is.
	if (handle.length === 0) {
		throw new PushConfigError(
			"a ready lifecycle alert requires a 22-character terminal handle — refusing to build a notification the phone could never replace",
		);
	}
	if (!Number.isInteger(input.outcomeAtMs) || input.outcomeAtMs <= 0) {
		throw new PushConfigError(
			"a ready lifecycle alert requires the outcome instant it was minted from (gx)",
		);
	}
	return {
		v: "3",
		k: "g",
		i: input.alertId,
		w: input.workspaceId,
		x: String(input.expiresAtMs),
		gx: String(input.outcomeAtMs),
		t: handle,
		...names,
	};
}

/**
 * (ALERT-CONTEXT-NAMES) §13.5 — `k: "c"`, take a lifecycle alert back off the
 * phone and the watch.
 *
 * NO NAMES BY CONTRACT. The notification being cancelled already carries them,
 * so re-sending them would widen the waiver for no gain. It carries `t` because
 * the watch dismissal is addressed per terminal, and `x` is the FRAME's own
 * expiry (`RETRACT_TTL_MS`), never the alert's: the client checks `isExpired`
 * before it switches on `k`, so a retraction stamped `now` is discarded on
 * arrival and the notification it named survives — the same trap `k: "r"` fell
 * into once already.
 */
export function buildLifecycleRetractPushData(input: {
	alertId: string;
	workspaceId: WorkspaceId;
	terminalHandle: string;
	/**
	 * (ONE-BUZZ-UNTIL-READ) The retired alert's outcome instant, or — on the
	 * blind restart path, where no row survives to read one off — the instant
	 * the user read through. Either way it names the finish being cancelled.
	 */
	outcomeAtMs: number;
	nowMs: number;
}): PushData {
	assertLifecycleIdentity(input.alertId, input.workspaceId);
	if (!Number.isInteger(input.nowMs) || input.nowMs <= 0) {
		throw new PushConfigError("nowMs must be a positive integer");
	}
	if (!Number.isInteger(input.outcomeAtMs) || input.outcomeAtMs <= 0) {
		throw new PushConfigError(
			"a lifecycle retraction requires the outcome instant it cancels (gx)",
		);
	}
	return {
		v: "3",
		k: "c",
		i: input.alertId,
		w: input.workspaceId,
		x: String(input.nowMs + RETRACT_TTL_MS),
		gx: String(input.outcomeAtMs),
		t: sanitizeTerminalHandle(input.terminalHandle),
	};
}

/**
 * The two generated 22-char identities every lifecycle frame carries. The
 * values are NOT echoed, for the same reason `assertPushDataSafe` does not echo
 * one: if this is firing, the value is exactly the thing that must not leave
 * the process.
 */
function assertLifecycleIdentity(alertId: string, workspaceId: string): void {
	if (typeof alertId !== "string" || !LIFECYCLE_ID_PATTERN.test(alertId)) {
		throw new PushConfigError(
			"lifecycle alertId must be 22 base64url characters — refusing to build (possible text leak)",
		);
	}
	if (
		typeof workspaceId !== "string" ||
		!LIFECYCLE_ID_PATTERN.test(workspaceId)
	) {
		throw new PushConfigError(
			"lifecycle workspaceId must be 22 base64url characters — refusing to build (possible text leak)",
		);
	}
}

// ---------------------------------------------------------------------------
// Service account + OAuth (hand-rolled JWT-bearer; no new dependency)
// ---------------------------------------------------------------------------

/** Only the fields we use. The parsed object NEVER leaves this module. */
interface ServiceAccount {
	projectId: string;
	privateKeyId: string;
	privateKeyPem: string;
	clientEmail: string;
	tokenUri: string;
}

function requireStringField(
	source: Record<string, unknown>,
	field: string,
	path: string,
): string {
	const value = source[field];
	if (typeof value !== "string" || value.length === 0) {
		// Names the FIELD and the PATH. Never a value.
		throw new PushConfigError(
			`service account at ${path} is missing a usable "${field}"`,
		);
	}
	return value;
}

/**
 * Validate at the API boundary. No defaults, no partial acceptance: a service
 * account that cannot mint a token must fail here, loudly, at startup, rather
 * than three minutes into the first unanswered question.
 */
export async function loadServiceAccount(
	path: string,
): Promise<ServiceAccount> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		throw new PushConfigError(
			`cannot read the FCM service account at ${path}: ${(error as NodeJS.ErrnoException).code ?? "unknown error"}`,
		);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new PushConfigError(
			`the FCM service account at ${path} is not valid JSON`,
		);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new PushConfigError(
			`the FCM service account at ${path} is not a JSON object`,
		);
	}
	const source = parsed as Record<string, unknown>;

	if (source.type !== "service_account") {
		throw new PushConfigError(
			`the credential at ${path} is not a service account (expected type "service_account")`,
		);
	}

	const account: ServiceAccount = {
		projectId: requireStringField(source, "project_id", path),
		privateKeyId: requireStringField(source, "private_key_id", path),
		privateKeyPem: requireStringField(source, "private_key", path),
		clientEmail: requireStringField(source, "client_email", path),
		tokenUri: requireStringField(source, "token_uri", path),
	};

	if (account.projectId !== FCM_PROJECT_ID) {
		throw new PushConfigError(
			`the service account at ${path} is for project "${account.projectId}", expected "${FCM_PROJECT_ID}" — pushes would go nowhere`,
		);
	}
	if (!account.privateKeyPem.includes("BEGIN PRIVATE KEY")) {
		throw new PushConfigError(
			`the service account at ${path} has a "private_key" that is not a PKCS#8 PEM`,
		);
	}
	if (!account.tokenUri.startsWith("https://")) {
		throw new PushConfigError(
			`the service account at ${path} has a non-https "token_uri"`,
		);
	}

	return account;
}

function signAssertion(account: ServiceAccount, nowMs: number): string {
	const issuedAtS = Math.floor(nowMs / 1000);
	// `base64UrlEncode` (crypto.ts), never a hand-rolled
	// `.replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"")` chain: this is a
	// JWT signing input, where one wrong character in the encoding is a signature
	// Google rejects with an opaque `invalid_grant`.
	const header = base64UrlEncode(
		Buffer.from(
			JSON.stringify({
				alg: "RS256",
				typ: "JWT",
				kid: account.privateKeyId,
			}),
			"utf8",
		),
	);
	const claims = base64UrlEncode(
		Buffer.from(
			JSON.stringify({
				iss: account.clientEmail,
				scope: FCM_OAUTH_SCOPE,
				aud: FCM_OAUTH_AUDIENCE,
				iat: issuedAtS,
				exp: issuedAtS + OAUTH_ASSERTION_LIFETIME_S,
			}),
			"utf8",
		),
	);
	const signingInput = `${header}.${claims}`;
	const signer = createSign("RSA-SHA256");
	signer.update(signingInput);
	signer.end();
	const signature = base64UrlEncode(signer.sign(account.privateKeyPem));
	return `${signingInput}.${signature}`;
}

/**
 * Caches one access token and mints a new one at most once at a time
 * (single-flight): a burst of pushes after a resume must not fire N concurrent
 * token requests.
 */
export interface AccessTokenSource {
	get(nowMs: number, signal: AbortSignal): Promise<string>;
	/** Drops the cached token after a 401 so the next send re-mints exactly once. */
	invalidate(): void;
}

export function createAccessTokenSource(
	account: ServiceAccount,
): AccessTokenSource {
	let cachedToken: string | null = null;
	let cachedExpiresAtMs = 0;
	let inFlight: Promise<string> | null = null;

	async function mint(nowMs: number, signal: AbortSignal): Promise<string> {
		const assertion = signAssertion(account, nowMs);
		const body = new URLSearchParams({
			grant_type: FCM_OAUTH_GRANT_TYPE,
			assertion,
		});

		let response: Response;
		try {
			response = await fetch(account.tokenUri, {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: body.toString(),
				signal: AbortSignal.any([
					signal,
					AbortSignal.timeout(FCM_REQUEST_TIMEOUT_MS),
				]),
			});
		} catch (error) {
			// Network-level: transient, NOT an auth fault. The caller retries.
			throw new Error(
				`FCM token request failed: ${error instanceof Error ? error.name : "unknown"}`,
			);
		}

		const text = await response.text();
		if (!response.ok) {
			// Only the two documented, non-secret fields are surfaced.
			let code = "unknown";
			let description = "";
			try {
				const parsed: unknown = JSON.parse(text);
				if (typeof parsed === "object" && parsed !== null) {
					const record = parsed as Record<string, unknown>;
					if (typeof record.error === "string") code = record.error;
					if (typeof record.error_description === "string") {
						description = record.error_description.slice(0, 200);
					}
				}
			} catch {
				// keep the defaults; the raw body is deliberately not logged
			}
			if (response.status >= 500 || response.status === 429) {
				throw new Error(
					`FCM token endpoint ${response.status} (${code}) — transient`,
				);
			}
			throw new PushAuthError(
				`FCM token endpoint rejected the service account: HTTP ${response.status} ${code}${description ? ` — ${description}` : ""}`,
			);
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			throw new PushAuthError("FCM token endpoint returned non-JSON");
		}
		if (typeof parsed !== "object" || parsed === null) {
			throw new PushAuthError("FCM token endpoint returned a non-object");
		}
		const record = parsed as Record<string, unknown>;
		const accessToken = record.access_token;
		const expiresIn = record.expires_in;
		if (typeof accessToken !== "string" || accessToken.length === 0) {
			throw new PushAuthError(
				"FCM token endpoint returned no usable access_token",
			);
		}
		if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn)) {
			throw new PushAuthError(
				"FCM token endpoint returned no usable expires_in",
			);
		}

		cachedToken = accessToken;
		cachedExpiresAtMs = nowMs + expiresIn * 1000;
		return accessToken;
	}

	return {
		get(nowMs, signal) {
			if (
				cachedToken !== null &&
				nowMs < cachedExpiresAtMs - OAUTH_REFRESH_SKEW_MS
			) {
				return Promise.resolve(cachedToken);
			}
			if (inFlight !== null) return inFlight;
			const attempt = mint(nowMs, signal).finally(() => {
				inFlight = null;
			});
			inFlight = attempt;
			return attempt;
		},
		invalidate() {
			cachedToken = null;
			cachedExpiresAtMs = 0;
		},
	};
}

// ---------------------------------------------------------------------------
// FCM send + response classification
// ---------------------------------------------------------------------------

export type FcmOutcome =
	/** Accepted by FCM. Delivery to the handset is still best-effort. */
	| { kind: "delivered" }
	/** The token is dead. PRUNE it; never retry against it. */
	| { kind: "token_dead"; errorCode: string }
	/** Retry with backoff, bounded. */
	| { kind: "transient"; errorCode: string; retryAfterMs: number | null }
	/** Configuration is broken. FAIL LOUD; do not degrade to silence. */
	| { kind: "auth_fault"; errorCode: string };

/**
 * Pulls the FCM `errorCode` out of the v1 error envelope
 * (`error.details[].errorCode`), falling back to `error.status`. The body never
 * contains our payload, so it is safe to surface.
 */
function classifyFcmError(status: number, text: string): FcmOutcome {
	let errorCode = "UNKNOWN";
	try {
		const parsed: unknown = JSON.parse(text);
		if (typeof parsed === "object" && parsed !== null) {
			const error = (parsed as Record<string, unknown>).error;
			if (typeof error === "object" && error !== null) {
				const errorRecord = error as Record<string, unknown>;
				if (typeof errorRecord.status === "string") {
					errorCode = errorRecord.status;
				}
				const details = errorRecord.details;
				if (Array.isArray(details)) {
					for (const detail of details) {
						if (typeof detail !== "object" || detail === null) continue;
						const code = (detail as Record<string, unknown>).errorCode;
						if (typeof code === "string" && code.length > 0) {
							errorCode = code;
							break;
						}
					}
				}
			}
		}
	} catch {
		// leave UNKNOWN; status alone decides below
	}

	switch (errorCode) {
		case "UNREGISTERED":
		case "NOT_FOUND":
		case "INVALID_ARGUMENT":
			// Per the contract: prune, do not retry forever. INVALID_ARGUMENT can
			// also mean a malformed message, but every message has already passed
			// assertPushDataSafe, so a bad token is the live explanation — and the
			// caller logs the prune loudly so a systematic payload bug is visible
			// as "every device pruned at once" rather than as silence.
			return { kind: "token_dead", errorCode };
		case "SENDER_ID_MISMATCH":
		case "THIRD_PARTY_AUTH_ERROR":
		case "PERMISSION_DENIED":
		case "UNAUTHENTICATED":
			return { kind: "auth_fault", errorCode };
		case "QUOTA_EXCEEDED":
		case "UNAVAILABLE":
		case "INTERNAL":
			return { kind: "transient", errorCode, retryAfterMs: null };
		default:
			break;
	}

	if (status === 401 || status === 403) {
		return { kind: "auth_fault", errorCode };
	}
	if (status === 404) {
		return { kind: "token_dead", errorCode };
	}
	if (status === 400) {
		return { kind: "token_dead", errorCode };
	}
	return { kind: "transient", errorCode, retryAfterMs: null };
}

function parseRetryAfterMs(headerValue: string | null): number | null {
	if (headerValue === null) return null;
	const seconds = Number(headerValue);
	if (Number.isFinite(seconds) && seconds >= 0) {
		return Math.min(seconds * 1000, FCM_BACKOFF_MAX_MS);
	}
	const asDate = Date.parse(headerValue);
	if (Number.isFinite(asDate)) {
		return Math.max(0, Math.min(asDate - Date.now(), FCM_BACKOFF_MAX_MS));
	}
	return null;
}

/** Full jitter, capped. Never unbounded, never a tight loop. */
function backoffDelayMs(attempt: number): number {
	const ceiling = Math.min(
		FCM_BACKOFF_BASE_MS * 2 ** (attempt - 1),
		FCM_BACKOFF_MAX_MS,
	);
	return randomInt(0, Math.max(1, Math.floor(ceiling)) + 1);
}

async function sendOnce(
	envelope: PushEnvelope,
	accessToken: string,
	signal: AbortSignal,
): Promise<FcmOutcome> {
	let response: Response;
	try {
		response = await fetch(FCM_SEND_ENDPOINT, {
			method: "POST",
			headers: {
				authorization: `Bearer ${accessToken}`,
				"content-type": "application/json; charset=UTF-8",
			},
			body: JSON.stringify({ message: envelope }),
			signal: AbortSignal.any([
				signal,
				AbortSignal.timeout(FCM_REQUEST_TIMEOUT_MS),
			]),
		});
	} catch (error) {
		return {
			kind: "transient",
			errorCode: error instanceof Error ? error.name : "NETWORK",
			retryAfterMs: null,
		};
	}

	if (response.ok) {
		// Drain so the socket is reusable; the body is a message name we ignore.
		await response.text();
		return { kind: "delivered" };
	}

	const text = await response.text();
	const outcome = classifyFcmError(response.status, text);
	if (outcome.kind === "transient") {
		return {
			...outcome,
			retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after")),
		};
	}
	return outcome;
}

// ---------------------------------------------------------------------------
// §7.6 register
// ---------------------------------------------------------------------------

export interface RegisterDeps {
	devices: DeviceStore;
	now(): number;
}

/**
 * §7.6. Idempotent; one token per deviceId, a new token replaces the old.
 *
 * Every field is validated at the boundary and there are no defaults: a
 * malformed registration is a `bad_request`, never a silently-normalised one.
 * The token itself is secret-ish and is never logged.
 */
export async function handleRegister(
	deps: RegisterDeps,
	ctx: SealedRequestContext,
	request: RegisterRequest,
): Promise<RegisterResponse> {
	if (
		typeof request.fcmToken !== "string" ||
		!FCM_TOKEN_PATTERN.test(request.fcmToken)
	) {
		throw new SealedError(400, {
			code: "bad_request",
			message: "fcmToken is not a well-formed FCM registration token",
			retryAfterMs: null,
			detail: null,
		});
	}
	if (request.surface !== ctx.device.surface) {
		// The watch holds no key and never registers on its own; a surface that
		// disagrees with the paired device record is a client bug or an attempt.
		throw new SealedError(400, {
			code: "bad_request",
			message: "surface does not match the paired device record",
			retryAfterMs: null,
			detail: null,
		});
	}
	if (
		typeof request.appVersion !== "string" ||
		!APP_VERSION_PATTERN.test(request.appVersion)
	) {
		throw new SealedError(400, {
			code: "bad_request",
			message: "appVersion is missing or not a well-formed version string",
			retryAfterMs: null,
			detail: null,
		});
	}
	if (
		request.replacesToken !== null &&
		(typeof request.replacesToken !== "string" ||
			!FCM_TOKEN_PATTERN.test(request.replacesToken))
	) {
		throw new SealedError(400, {
			code: "bad_request",
			message: "replacesToken must be null or a well-formed FCM token",
			retryAfterMs: null,
			detail: null,
		});
	}

	const nowMs = deps.now();
	const unchanged =
		ctx.device.fcmToken === request.fcmToken &&
		ctx.device.fcmTokenUpdatedMs !== null;

	if (!unchanged) {
		await deps.devices.setFcmToken(
			ctx.device.deviceId,
			request.fcmToken,
			nowMs,
		);
		console.log(
			`${LOG} registered fcm token deviceId=${ctx.device.deviceId} surface=${request.surface} rotated=${request.replacesToken !== null}`,
		);
	}

	return {
		deviceId: ctx.device.deviceId,
		registeredAtMs: unchanged ? (ctx.device.fcmTokenUpdatedMs ?? nowMs) : nowMs,
		// (PUSH-PRESENCE) WIRE COMPATIBILITY, DELIBERATELY EMITTED AS ZERO.
		//
		// There is no delay any more — the desktop decides per question, from
		// presence, whether to push now or hold indefinitely. The FIELD stays
		// because paired phones consume it (`Session.kt` in
		// superset-companion), and dropping it from the response would break
		// every already-installed client's register parse. Zero is the honest
		// value: it is exactly the delay a client should assume, and a client
		// that renders "you will be notified after N minutes" now correctly
		// renders nothing.
		pushDelayMs: 0,
		pushTtlMs: PUSH_TTL_MS,
	};
}

// ---------------------------------------------------------------------------
// The sender
// ---------------------------------------------------------------------------

export interface PushSender {
	/**
	 * (PUSH-PRESENCE) Arms the push and evaluates presence IMMEDIATELY.
	 *
	 * Away right now -> the push goes out on this call, with no tick of latency.
	 * Present -> the question is HELD with no deadline and fires on the first
	 * sweep that sees presence lapse, provided `fireVerdict` still says so
	 * at that moment and `(PUSH-CURATION-GATE)`'s `isCuratedOff` is not holding it
	 * for a thread the user has taken off their sidebar.
	 *
	 * Idempotent per questionId, and idempotent against the SENT set too: a
	 * question that has already been pushed is never re-armed, which is what
	 * stops a re-capture after a host-service restart from buzzing twice.
	 */
	schedule(input: {
		questionId: QuestionId;
		workspaceId: WorkspaceId;
		questionCount: number;
		expiresAtMs: number;
		/**
		 * (PUSH-ARMED-ORPHAN) The identity a HELD push needs after a restart. None
		 * of it reaches FCM — the payload is opaque ids — it is persisted so a
		 * reconstructed row can be judged instead of discarded. `null` is allowed
		 * everywhere and always means "cannot check", never "resolved".
		 */
		hostTerminalId: string | null;
		hostWorkspaceId: string | null;
		transcriptPath: string | null;
		toolUseId: string | null;
	}): void;
	/**
	 * Disarms. If a push had already gone out, this ALSO fires a retraction
	 * (fire-and-forget) — a notification must never outlive its subject, and a
	 * question that goes stale is just as resolved from the phone's point of view
	 * as one that was answered.
	 *
	 * This is the desk-answer path: `question-store` settles the record, the
	 * notifying sink in `companion/index.ts` calls this, and a question answered
	 * at the keyboard never buzzes.
	 */
	cancelPending(questionId: QuestionId): void;
	/**
	 * §13.3. Awaited retraction for the answer path, so the audit trail can note
	 * it. Same `collapse_key`, so if the original push is still queued
	 * undelivered at FCM the retraction REPLACES it and the phone never buzzes at
	 * all. No-op when no push was ever sent for this question.
	 *
	 * Takes NO workspaceId: the retraction must carry the workspaceId the
	 * ORIGINAL push carried, or the client cannot match the notification it is
	 * holding, and that value is the one in the sent record — never whatever a
	 * caller happens to pass.
	 *
	 * Ordered against the original send: it cancels an in-flight one and runs
	 * after it on the same per-question chain, so a retraction can never be
	 * overtaken by the push it retracts.
	 */
	retract(questionId: QuestionId): Promise<void>;
	/**
	 * (LIFECYCLE-ALERT) §13.4 — deliver ONE lifecycle alert now.
	 *
	 * Deliberately DUMB: it takes an already-decided alert and puts it on the
	 * wire. Every judgement — is a work-cycle armed, did the agent fail, is the
	 * user at the desk, is this thread still on their sidebar, has this exact
	 * alert already gone out — belongs to `lifecycle-alerts.ts`, which owns the
	 * cycle state machine. That state is PROCESS-LOCAL and BOUNDED, not durable
	 * like the question path's fence: held alerts, the alert-id set and the
	 * bounded window of already-applied producer ids live in memory, expire with
	 * the six-hour alert TTL, and are retried in place with capped exponential
	 * backoff. A host-service restart therefore drops whatever was still held —
	 * accepted, because an alert is a fact about an instant that has passed and
	 * the next work cycle raises a fresh one, whereas a pending question outlives
	 * a restart and must not.
	 *
	 * This method exists so that the
	 * OAuth token cache, the bounded retry/backoff, the dead-token pruning and
	 * the fatal-fault surface are shared with the question path rather than
	 * reimplemented beside it: two independent FCM clients in one process is two
	 * places for "the watch went silent" to hide.
	 *
	 * Awaited, so the caller can order its own bookkeeping around delivery. It is
	 * queued on the same per-id chain the question path uses, so two alerts with
	 * the same id can never overlap or land out of order.
	 *
	 * (LIFECYCLE-ALERT-RETRY) IT REJECTS unless at least one registered device
	 * accepted the alert. That is the one push in this module whose caller can act
	 * on a failure — the alert is still held, and still valid until its TTL — so
	 * the failure is handed to it rather than logged and dropped. Every device
	 * refusing REJECTS, and so does having no registered device at all: pairing
	 * and token rotation happen inside the six hours the alert stays valid, so
	 * "nobody to send to" is a reason to keep holding. Only a deliberate cancel
	 * (shutdown) resolves without a delivery.
	 */
	sendLifecycleAlert(input: {
		alertId: string;
		workspaceId: WorkspaceId;
		kind: "g" | "e";
		expiresAtMs: number;
		/**
		 * (ONE-BUZZ-UNTIL-READ) Derived from the alert row's own terminal id, so
		 * a failed context resolution can cost the NAMES without ever costing the
		 * handle a ready notification is addressed by.
		 */
		terminalHandle: string;
		/** The outcome instant the alert id was hashed from. */
		outcomeAtMs: number;
		/**
		 * (ALERT-CONTEXT-NAMES) Resolved by the CALLER, immediately before this
		 * call, and never cached in the held alert. A retry a quarter of an hour
		 * later re-resolves, so a workspace renamed in the meantime buzzes with
		 * its new name.
		 */
		context: PushAlertContext | null;
	}): Promise<void>;
	/**
	 * (ALERT-CONTEXT-NAMES) §13.5 — take a lifecycle alert back off the devices.
	 *
	 * BEST EFFORT, AND DELIBERATELY UNLIKE `sendLifecycleAlert`. That one rejects
	 * so its caller can hold the alert and try again; this one resolves whatever
	 * happens, because there is nothing useful for a caller to do with a failed
	 * retraction: the alert it names is already on the phone, the frame's own
	 * 24 h TTL means FCM keeps trying long after this returns, and the client's
	 * `x` check plus its foreground sweep are the backstops. Failing loudly here
	 * would turn "the buzz stayed on the watch a bit longer" into an error path
	 * the lifecycle manager would have to invent a retry policy for.
	 *
	 * Queued on the SAME per-id chain as the alert it retracts, so it can never
	 * be overtaken by the send it is cancelling.
	 */
	sendLifecycleRetraction(input: {
		alertId: string;
		workspaceId: WorkspaceId;
		terminalHandle: string;
		/** The outcome instant this retraction cancels. */
		outcomeAtMs: number;
	}): Promise<void>;
	/**
	 * The current fatal fault, or null. Non-null means push is DOWN and the user
	 * must be told: a silent watch reads as "no questions", which is the one
	 * state they must never be wrong about.
	 */
	getFault(): PushFault | null;
	/**
	 * Diagnostics for the boot harness and the probes: what is held, what has been
	 * sent, and why the last presence evaluation decided the way it did. Read-only
	 * — nothing in the product branches on it.
	 */
	inspect(): {
		armed: QuestionId[];
		sent: QuestionId[];
		lastVerdict: PresenceVerdict | null;
	};
	stop(): void;
}

export interface PushSenderDeps {
	/** `~/.superset/companion/fcm-service-account.json`. Read at start, never logged. */
	serviceAccountPath: string;
	devices: DeviceStore;
	/**
	 * (PUSH-PRESENCE) Is the user at the desk? The scheduler asks; it never
	 * decides. See `companion/presence.ts` for the two signals and why an
	 * unusable one resolves towards "away".
	 */
	presence: PresenceStore;
	/**
	 * The durable armed/sent fence. `null` only in tests that are not exercising
	 * restart behaviour — the bridge always supplies one, because without it a
	 * host-service restart loses every held push and re-sends every sent one.
	 */
	fence: PushFence | null;
	/**
	 * Re-checked at fire time. The scheduler NEVER trusts that `cancelPending`
	 * was called: a missed cancel would buzz the watch for a question already
	 * answered, which is exactly the noise presence gating exists to remove.
	 *
	 * MUST FAIL TOWARD `"fire"`. Anything the implementation is merely UNSURE
	 * about (an unreachable daemon, a stale liveness snapshot) has to answer
	 * `"fire"`. Only positive knowledge may answer otherwise. An implementation
	 * that reports uncertainty as a drop silently loses buzzes and nothing
	 * downstream can detect it.
	 *
	 * THE TWO NON-FIRING ANSWERS ARE NOT INTERCHANGEABLE, which is why this is a
	 * verdict rather than a boolean:
	 *
	 *  - `"settled"` is a FACT ABOUT THE RECORD and needs no corroboration: it
	 *    is either no longer `pending`, or absent from a memory-only store that
	 *    a restart emptied. Absence is a legitimate `"settled"` — the record
	 *    carrying the terminal id and the options is gone, so `/v1/question`
	 *    would 404 — and the implementation is expected to LOG it and name the
	 *    restart, because it is a real cost otherwise paid silently.
	 *  - `"gone"` is ONE OBSERVATION of a daemon listing. `evaluate` treats it
	 *    as a HOLD and requires the same answer again after
	 *    `PUSH_GONE_CORROBORATION_MS` before it forgets anything, for the same
	 *    reason `reconcile` corroborates before `settle(stale)`: the action is
	 *    irreversible and one listing is fallible.
	 */
	fireVerdict(questionId: QuestionId): PushFireVerdict;
	/**
	 * (PUSH-CURATION-GATE) Is this question's thread OFF the user's sidebar right
	 * now — binned, archived, completed, hidden or snoozed?
	 *
	 * A HOLD, NOT A DISARM, and that is the whole point of asking here instead of
	 * at arm time. Curation is revocable: a snooze expires, an archive is undone,
	 * a bin is restored. Asked once when the question was captured, a `true` was
	 * permanent — the question stayed silent for its whole six-hour life while the
	 * sidebar it was suppressed for had long since put the thread back. Asked on
	 * every sweep, the same `true` only means "not this sweep", and the buzz
	 * arrives on the first sweep after the curation lapses.
	 *
	 * MUST FAIL TOWARD `false`. This is the opposite direction from
	 * `fireVerdict` and for the opposite reason: a `false` here costs at
	 * most one buzz the user might have preferred not to get, while a `true`
	 * reached by uncertainty silences a genuinely blocked agent for six hours. So
	 * curation that is not in force, a workspace the reader has no row for, and
	 * anything thrown while asking all answer `false`.
	 *
	 * It must not throw: it is called from a timer callback, where a throw is an
	 * unhandled rejection rather than a failed push. The implementation owns the
	 * catch, exactly as it owns the fail-toward-`false` rule.
	 */
	isCuratedOff(questionId: QuestionId): boolean;
	/**
	 * (PUSH-ARMED-ORPHAN) What does this question's OWN transcript say about it?
	 *
	 * Asked once per entry rebuilt from the fence at construction, and only of
	 * those: it is the one check available for a question the memory-only store
	 * cannot know about, because the pair it needs (`transcriptPath`,
	 * `toolUseId`) was persisted with the row. It is the same machinery guard 1
	 * uses (`findToolResultInTranscript`), pointed at the persisted path.
	 *
	 * THREE ANSWERS, AND ONLY TWO OF THEM ACT:
	 *
	 *   `"resolved"` — POSITIVE PROOF the question was answered while the
	 *     host-service was down. Cancels the buzz.
	 *   `"gone"` — POSITIVE, CORROBORATED PROOF the transcript file no longer
	 *     exists (`readOrphanTranscriptVerdict`). Retires the fence row too, but
	 *     for a different reason: not "somebody answered it" but "this
	 *     notification is inert". The phone's question view reads that transcript
	 *     and would render nothing, and guard 1 reads that same derived path and
	 *     refuses every answer attempt against it. Nobody can open this buzz and
	 *     nobody can answer it, and it would otherwise be rebuilt and re-held on
	 *     every restart until its 6-hour expiry.
	 *   `"unresolved"` — EVERYTHING ELSE. Unreadable, empty, a tree this process
	 *     cannot see, a check that threw. They all mean "cannot check" and the
	 *     entry then fires on the ordinary away rules. That direction is the
	 *     ruling this whole path is built on: a stale buzz self-corrects the
	 *     moment the user taps it and finds nothing, while a lost buzz is a
	 *     blocked agent nobody is ever told about.
	 *
	 * `null` disables the check entirely — every reconstructed entry then fires
	 * on the away rules. Required rather than optional so a composition root
	 * states that choice instead of inheriting it.
	 */
	verifyOrphanResolved:
		| ((input: {
				questionId: QuestionId;
				transcriptPath: string;
				toolUseId: string;
		  }) => Promise<OrphanTranscriptVerdict>)
		| null;
	/**
	 * Called on a fatal auth/config fault so the desktop can surface "push is
	 * broken" instead of degrading to silence.
	 */
	onFault(fault: PushFault): void;
	/**
	 * (ALERT-CONTEXT-NAMES) Which project, workspace and tab is this question
	 * about? Asked AT FIRE TIME, never at arm time.
	 *
	 * A question can be held for six hours, and in that time a workspace can be
	 * renamed, a tab retitled and a terminal moved. Resolving at arm time would
	 * have buzzed with whatever the names were when the agent got stuck; asking
	 * here means the notification describes the world the user is walking back
	 * into.
	 *
	 * MUST NOT THROW and must never be a reason not to send: it is called from
	 * the same synchronous accounting block that commits the entry to the `sent`
	 * set, so a throw would lose a buzz for a blocked agent. `null` is a
	 * first-class answer meaning "no context" — the phone then uses its generic
	 * strings — and `null` for the dep itself disables the feature entirely,
	 * required rather than optional so a composition root states that choice.
	 */
	resolveAlertContext:
		| ((input: {
				hostTerminalId: string | null;
				hostWorkspaceId: string | null;
		  }) => PushAlertContext | null)
		| null;
	/** Injectable for tests. Wall clock. */
	now?: () => number;
}

interface ArmedQuestion {
	questionId: QuestionId;
	workspaceId: WorkspaceId;
	questionCount: number;
	expiresAtMs: number;
	armedAtWallMs: number;
	/**
	 * (ALERT-CONTEXT-NAMES) The RAW host ids this push was armed for, retained so
	 * the fire path can resolve names for it.
	 *
	 * They were dropped on the way in until now: `workspaceId` above is the
	 * DERIVED opaque handle, which is all the wire needs and exactly the wrong
	 * thing to look a name up with. The fence has persisted both since
	 * `(PUSH-ARMED-ORPHAN)` — reconstruction simply threw them away — so a push
	 * held across a restart names its chat just as well as a fresh one.
	 *
	 * `null` means "cannot resolve", never "no context": a pre-upgrade fence row
	 * has no terminal id, and the alert still goes out with `t: ""`.
	 */
	hostTerminalId: string | null;
	hostWorkspaceId: string | null;
	/**
	 * (PUSH-ARMED-ORPHAN) True for an entry rebuilt from the fence at
	 * construction — every one of them, because `QuestionStore` is memory-only
	 * and a restart is the only way a row gets here.
	 *
	 * It exists because the fire path's ordinary re-check asks that store, and
	 * for these entries the store's honest answer is "never heard of it". Acted
	 * on, that answer discarded every push held across a restart on the first
	 * away sweep. An orphan is judged against its own persisted transcript
	 * instead — see `verifyOrphans`.
	 *
	 * Cleared if the question is re-captured, because the store then holds the
	 * record and the ordinary re-check applies again.
	 */
	storeOrphaned: boolean;
}

interface SentRecord {
	workspaceId: WorkspaceId;
	sentAtMs: number;
}

/**
 * What the fire-time re-check may answer. `"fire"` and `"settled"` are acted on
 * at once; `"gone"` is one observation and is HELD for corroboration — see
 * `PushSenderDeps.fireVerdict` and `PUSH_GONE_CORROBORATION_MS`.
 *
 * Lives here rather than beside its implementation (`createFireVerdictProbe` in
 * `index.ts`) because the CONTRACT belongs to the caller that acts on it, and
 * because `index.ts` already imports this module — the other direction would
 * close a cycle.
 */
export type PushFireVerdict = "fire" | "settled" | "gone";

/**
 * (PUSH-PRESENCE) A cancellable unit of FCM work.
 *
 * `cancelled` is checked between delivery attempts, so a retraction arriving
 * mid-send does not have to wait out four bounded backoffs before its own
 * message can go. Cancelling does NOT unsend anything already accepted by FCM —
 * that is what the retraction itself is for.
 */
interface SendToken {
	cancelled: boolean;
}

/**
 * (LIFECYCLE-ALERT-RETRY) What one device's send did. A push used to be
 * fire-and-forget end to end — every failure path logged and returned `void` —
 * which was fine while the only caller was the question scheduler, whose entry
 * is already committed to the `sent` set before the send starts. It is NOT fine
 * for a lifecycle alert: that caller holds the alert and can try again inside
 * its TTL, and it can only do that if a failure reaches it instead of being
 * swallowed here.
 *
 * `cancelled` is deliberately NOT a failure: the send was abandoned on purpose
 * (a retraction queued behind it, or shutdown), so there is nothing to retry.
 */
type DeliveryResult = "delivered" | "cancelled" | "failed";

/**
 * `no-devices` is NOT a success. Nothing was delivered, and the set of
 * registered devices is not fixed: a phone can pair, or re-register a rotated
 * token, at any point inside the six hours a lifecycle alert stays valid. A
 * caller that holds the alert must be told "not delivered" so it keeps holding;
 * only `cancelled` (a deliberate abandon, or shutdown) is terminal without a
 * delivery. It is kept distinct from `failed` so the reason is nameable.
 */
type BroadcastResult = "delivered" | "cancelled" | "failed" | "no-devices";

export function createPushSender(deps: PushSenderDeps): PushSender {
	const now = deps.now ?? (() => Date.now());
	if (
		deps.presence === null ||
		deps.presence === undefined ||
		typeof deps.presence.present !== "function"
	) {
		// (PUSH-PRESENCE) Validate at the boundary. Without a presence source the
		// scheduler has no basis for either decision it can make, and the failure
		// would present as a watch that either never buzzes or buzzes for
		// everything — both indistinguishable from a broken phone.
		throw new PushConfigError(
			"createPushSender requires a presence store; without it nothing can decide whether the user is at the desk",
		);
	}
	if (typeof deps.isCuratedOff !== "function") {
		// (PUSH-CURATION-GATE) Validate at the boundary. A missing probe would not
		// surface until the first sweep that finds the user away — inside a timer
		// callback, as an unhandled TypeError, hours after start.
		throw new PushConfigError(
			"createPushSender requires an isCuratedOff probe; without it a thread the user has taken off their sidebar would still buzz their watch",
		);
	}

	const armed = new Map<QuestionId, ArmedQuestion>();
	/** Questions a push actually went out for — the retraction's precondition. */
	const sent = new Map<QuestionId, SentRecord>();
	/**
	 * (PUSH-PRESENCE) One promise chain per id, so a send and its own
	 * retraction can never overlap or land out of order. Entries are dropped when
	 * the chain drains, so this cannot grow with traffic.
	 *
	 * (LIFECYCLE-ALERT) Keyed by `string` rather than `QuestionId` because
	 * lifecycle alerts share it. The key is an ORDERING token and nothing reads
	 * meaning out of it; the two id spaces are derived from different labels and
	 * cannot collide.
	 */
	const chains = new Map<string, Promise<void>>();
	/** The cancel token of the send currently on each question's chain. */
	const sendTokens = new Map<QuestionId, SendToken>();
	/**
	 * (PUSH-GONE-CORROBORATION) questionId -> the instant the fire path FIRST saw
	 * its terminal read as provably gone, while the entry was still armed.
	 *
	 * The second observation this map exists to enable is the whole point: one
	 * daemon listing is fallible, and `forget()` cannot be undone. An entry that
	 * recovers drops its candidacy and starts from zero if it ever comes back, so
	 * a flapping daemon can never accumulate its way to a drop.
	 *
	 * Bounded by `armed`: only an armed entry can add a row, and `forget()` clears
	 * one.
	 */
	const goneSince = new Map<QuestionId, number>();
	/**
	 * (PUSH-ARMED-ORPHAN) The transcript check for each reconstructed entry.
	 * `pending` while the read is in flight — the sweep HOLDS on that, so a
	 * question the check is about to prove resolved does not buzz in the
	 * meantime — and `unresolved` once it has come back without proof, which
	 * releases the entry to the ordinary away rules. A positive proof never
	 * lands here: it calls `forget()`.
	 */
	const orphanChecks = new Map<
		QuestionId,
		{ state: "pending" | "unresolved"; startedAtMs: number; generation: number }
	>();
	/**
	 * (PUSH-ORPHAN-STALE-VERDICT) Monotonic id for each transcript check, so a
	 * result that arrives after its check stopped being the current one can be
	 * recognised and dropped.
	 *
	 * The reads are fire-and-forget and can take as long as the filesystem takes.
	 * In that window the entry they were started for can be ADOPTED (the hook
	 * re-captured the question, so it is governed by the ordinary re-check again),
	 * FIRED past its deadline, forgotten, or retracted. Acting on a late verdict
	 * then operates on something that is no longer the thing that was asked about:
	 * a `gone` landing after adoption called `forget()` on a LIVE entry — a
	 * notification silently lost for an agent still blocked — and the same late
	 * callback after a deadline fire deleted the `sent` record, which is what a
	 * later retraction needs to pull the buzz off the phone.
	 */
	let orphanGeneration = 0;

	const abort = new AbortController();
	let sweepTimer: NodeJS.Timeout | null = null;
	let lastVerdict: PresenceVerdict | null = null;
	let fault: PushFault | null = null;
	let tokenSource: AccessTokenSource | null = null;
	let loading: Promise<AccessTokenSource> | null = null;
	let stopped = false;

	function raiseFault(kind: PushFault["kind"], message: string): void {
		const next: PushFault = { kind, atMs: now(), message };
		fault = next;
		// LOUD. A broken service account must never look like "no questions".
		console.error(
			`${LOG} PUSH IS DOWN (${kind}) — the watch will stay silent until this is fixed: ${message}`,
		);
		try {
			deps.onFault(next);
		} catch (error) {
			console.error(`${LOG} onFault handler threw`, error);
		}
	}

	function tokens(): Promise<AccessTokenSource> {
		if (tokenSource !== null) return Promise.resolve(tokenSource);
		if (loading !== null) return loading;
		const attempt = loadServiceAccount(deps.serviceAccountPath)
			.then((account) => {
				const source = createAccessTokenSource(account);
				tokenSource = source;
				return source;
			})
			.finally(() => {
				loading = null;
			});
		loading = attempt;
		return attempt;
	}

	async function targets(): Promise<DeviceRecord[]> {
		const all = await deps.devices.list();
		return all.filter(
			(device) =>
				device.revokedAtMs === null &&
				device.fcmToken !== null &&
				device.fcmToken.length > 0,
		);
	}

	async function deliver(
		device: DeviceRecord,
		data: PushData,
		cancel: SendToken | null,
	): Promise<DeliveryResult> {
		const token = device.fcmToken;
		if (token === null) return "failed";
		const envelope = buildEnvelope(token, data);

		for (let attempt = 1; attempt <= FCM_SEND_MAX_ATTEMPTS; attempt++) {
			if (stopped) return "cancelled";
			// (PUSH-PRESENCE) A retraction is waiting behind this send on the same
			// chain. Abandoning the remaining retries is not a lost push: whatever
			// FCM already accepted is exactly what the retraction is about to
			// collapse, and the alternative is making the retraction wait out four
			// bounded backoffs while the notification sits on the handset.
			if (cancel?.cancelled === true) {
				console.log(
					`${LOG} abandoning in-flight send for questionId=${data.i} — a retraction is queued behind it`,
				);
				return "cancelled";
			}

			let accessToken: string;
			try {
				const source = await tokens();
				accessToken = await source.get(now(), abort.signal);
			} catch (error) {
				if (error instanceof PushAuthError) {
					raiseFault("auth", error.message);
					return "failed";
				}
				if (error instanceof PushConfigError) {
					raiseFault("config", error.message);
					return "failed";
				}
				// Transient token failure (network, 5xx). Back off and retry.
				if (attempt === FCM_SEND_MAX_ATTEMPTS) {
					console.error(
						`${LOG} giving up minting an access token after ${attempt} attempts: ${error instanceof Error ? error.message : "unknown"}`,
					);
					return "failed";
				}
				await sleep(backoffDelayMs(attempt), {
					signal: abort.signal,
					unref: true,
				});
				continue;
			}

			const outcome = await sendOnce(envelope, accessToken, abort.signal);

			if (outcome.kind === "delivered") {
				if (fault !== null && fault.kind === "auth") {
					console.log(`${LOG} push recovered — auth fault cleared`);
					fault = null;
				}
				return "delivered";
			}

			if (outcome.kind === "token_dead") {
				// Prune. Never retry against a dead token.
				console.error(
					`${LOG} pruning dead FCM token deviceId=${device.deviceId} errorCode=${outcome.errorCode} — device must re-register`,
				);
				await deps.devices.setFcmToken(device.deviceId, null, now());
				return "failed";
			}

			if (outcome.kind === "auth_fault") {
				// One re-mint covers a token that expired mid-flight; a second
				// failure is a real configuration fault and is fatal.
				if (attempt === 1) {
					tokenSource?.invalidate();
					continue;
				}
				raiseFault("auth", `FCM rejected the credential: ${outcome.errorCode}`);
				return "failed";
			}

			if (attempt === FCM_SEND_MAX_ATTEMPTS) {
				console.error(
					`${LOG} push failed after ${attempt} attempts deviceId=${device.deviceId} errorCode=${outcome.errorCode}`,
				);
				return "failed";
			}
			// `unref: true` on every backoff here: a pending retry must never by
			// itself hold host-service open, exactly like the sweep timer.
			await sleep(outcome.retryAfterMs ?? backoffDelayMs(attempt), {
				signal: abort.signal,
				unref: true,
			});
		}
		return "failed";
	}

	async function broadcast(
		data: PushData,
		cancel: SendToken | null,
	): Promise<BroadcastResult> {
		const devices = await targets();
		if (devices.length === 0) {
			console.log(
				`${LOG} no registered device with a live token — skipping push kind ${data.k}`,
			);
			return "no-devices";
		}
		const results = await Promise.all(
			devices.map((device) => deliver(device, data, cancel)),
		);
		// One handset that took it is a delivered notification. Only a broadcast
		// where NOBODY took it is a failure the caller could act on.
		if (results.includes("delivered")) return "delivered";
		if (results.every((result) => result === "cancelled")) return "cancelled";
		return "failed";
	}

	/**
	 * (PUSH-PRESENCE) Run `work` after everything already queued for this
	 * question, and never concurrently with it.
	 *
	 * Serialising per QUESTION is strictly stronger than the per-(questionId,
	 * device) ordering that is actually required — a broadcast fans out to every
	 * device inside one job — and it is the version whose correctness is obvious.
	 *
	 * THE CHAIN ITSELF NEVER CARRIES A REJECTION. A failure must not poison it:
	 * the next operation for the same id still has to run, and the most likely
	 * next operation after a failed send is the retraction. The returned promise
	 * is a different matter — it rejects, so a caller that owns retry can see the
	 * failure. Callers that do not (`enqueue`) get it logged and swallowed.
	 */
	function enqueueOrdered(
		id: string,
		work: () => Promise<void>,
	): Promise<void> {
		const previous = chains.get(id) ?? Promise.resolve();
		const attempt = previous.then(work, work);
		const settled = attempt
			.catch(() => {
				// Observed here so an unawaited failure is never an unhandled rejection;
				// the caller's copy is what carries the error onwards.
			})
			.finally(() => {
				if (chains.get(id) === settled) chains.delete(id);
			});
		chains.set(id, settled);
		return attempt;
	}

	/** `enqueueOrdered`, with the failure logged and swallowed. */
	function enqueue(
		id: string,
		what: string,
		work: () => Promise<void>,
	): Promise<void> {
		return enqueueOrdered(id, work).catch((error: unknown) => {
			console.error(`${LOG} ${what} failed id=${id}`, error);
		});
	}

	function ensureSweeping(): void {
		if (sweepTimer !== null || stopped) return;
		sweepTimer = setInterval(sweep, PUSH_SWEEP_INTERVAL_MS);
		// Never hold host-service open on account of a pending buzz.
		sweepTimer.unref?.();
	}

	function stopSweepingIfIdle(): void {
		if (armed.size > 0 || sweepTimer === null) return;
		clearInterval(sweepTimer);
		sweepTimer = null;
	}

	/** Forgets a question in memory AND on disk, in that order. */
	function forget(questionId: QuestionId): void {
		armed.delete(questionId);
		sent.delete(questionId);
		goneSince.delete(questionId);
		orphanChecks.delete(questionId);
		try {
			deps.fence?.clear(questionId);
		} catch (error) {
			// A fence write failing is not a reason to lose the in-memory decision,
			// but it IS a reason to say so: the row will be re-read at the next
			// start and could resurrect a question that is already resolved.
			console.error(
				`${LOG} could not clear the push fence for questionId=${questionId}`,
				error,
			);
		}
	}

	/**
	 * (ALERT-CONTEXT-NAMES) Ask the resolver, and never let it break a send.
	 *
	 * The resolver reads host.db and a process-local cache; both can throw (a
	 * locked database, a reader that lost its file) and neither has any business
	 * deciding whether a blocked agent gets a notification. Anything it cannot
	 * answer becomes `null`, the frame carries `""` for every context key, and the
	 * phone renders the wording it used before this feature existed.
	 *
	 * KEPT HERE even though the composition root also wraps its own reads: this
	 * runs inside the synchronous accounting block that commits an entry to the
	 * `sent` set, so a throw would cost the BUZZ rather than the name, and the
	 * dep is an injection point any caller can supply. Depending on every future
	 * caller to be total is exactly the kind of unenforced convention this guard
	 * is cheap insurance against — see the "still fires when the resolver THROWS"
	 * test.
	 *
	 * THE FAILURE IS LOGGED WITHOUT ITS SUBJECT. The ids are diagnostic; the names
	 * are the private part and never appear in a log line, an error message or a
	 * thrown message anywhere in this feature.
	 */
	function resolveContextSafely(input: {
		hostTerminalId: string | null;
		hostWorkspaceId: string | null;
	}): PushAlertContext | null {
		const resolve = deps.resolveAlertContext;
		if (resolve === null) return null;
		try {
			return resolve(input);
		} catch (error) {
			console.error(
				`${LOG} could not resolve alert context; the notification will use its generic wording`,
				error,
			);
			return null;
		}
	}

	/**
	 * (PUSH-PRESENCE) THE PRESENCE DECISION. Everything else in this module
	 * serves these fifteen lines.
	 *
	 * Called from two places and they must behave identically: the sweep, and
	 * `schedule` itself so that a question captured while the user is already away
	 * fires on the spot instead of waiting for a tick.
	 *
	 * Accounting is SYNCHRONOUS from end to end, and every entry that fires is
	 * removed from `armed` and recorded in `sent` — in memory AND in the fence —
	 * before any `await` exists. A send can take tens of seconds (bounded
	 * retries), during which further ticks WILL run; if commitment happened after
	 * the await, a slow send would let the next tick collect the same question
	 * again and buzz twice.
	 */
	function evaluate(wallMs: number): void {
		if (stopped) return;

		const verdict = deps.presence.present(wallMs);
		lastVerdict = verdict;

		const due: { entry: ArmedQuestion; data: PushData }[] = [];
		for (const entry of [...armed.values()]) {
			if (wallMs >= entry.expiresAtMs) {
				// The client would discard it unopened; buzzing for it is pure noise.
				forget(entry.questionId);
				continue;
			}
			// HELD. No deadline, no ceiling: the user can see the question, and a
			// notification about something already on their screen is the noise that
			// gets a watch muted. It is released by absence, never by a timer.
			if (verdict.present) continue;

			// (PUSH-CURATION-GATE) HELD, on the same terms and for the same kind of
			// reason: the thread is not on the user's sidebar right now, so the tree
			// this notification would open does not contain it.
			//
			// THE HOLDS ARE INDEPENDENT AND COMPOSE — whichever holds, holds.
			// Presence is asked first only because it is free; none can release an
			// entry another is still holding, because they are `continue`s over the
			// same armed entry rather than a combined verdict computed once.
			//
			// CRUCIALLY BEFORE `armed.delete`. Everything below this line is one-shot:
			// the entry leaves `armed` and the next branch can only fire it or
			// `forget()` it forever. Curation is one of the inputs here that is
			// EXPECTED to change its mind — a snooze expires — so it has to be
			// answered while the entry is still armed, or "not now" would silently
			// mean "never".
			if (deps.isCuratedOff(entry.questionId)) continue;

			// (PUSH-ARMED-ORPHAN) A reconstructed entry does not consult the store.
			// The store is memory-only, this entry outlived the process that filled
			// it, and its honest "never heard of it" was the answer that discarded
			// every push held across a restart. It is judged against its own
			// persisted transcript instead:
			//
			//   check in flight  -> HOLD, like presence and curation. A question the
			//                       read is about to prove resolved must not buzz in
			//                       the meantime.
			//   proved resolved  -> already `forget()`-ten by the check itself, so it
			//                       is not in `armed` to reach here.
			//   anything else    -> FIRE on the ordinary away rules. Unreadable,
			//                       missing, or a check that outran its deadline all
			//                       mean "cannot check", and this feature buzzes when
			//                       it cannot tell.
			if (entry.storeOrphaned) {
				const check = orphanChecks.get(entry.questionId);
				if (
					check !== undefined &&
					check.state === "pending" &&
					wallMs - check.startedAtMs < ORPHAN_VERIFY_DEADLINE_MS
				) {
					continue;
				}
				if (check !== undefined && check.state === "pending") {
					// Deadline. Say so once, then treat it as unverifiable and let it fire.
					console.error(
						`${LOG} the transcript check for reconstructed questionId=${entry.questionId} has not returned in ${ORPHAN_VERIFY_DEADLINE_MS}ms; firing rather than holding a buzz on a read that may never finish`,
					);
					// (PUSH-ORPHAN-STALE-VERDICT) A NEW generation, so the read this
					// sweep gave up on cannot come back later and act on an entry that
					// has since fired.
					orphanGeneration += 1;
					orphanChecks.set(entry.questionId, {
						state: "unresolved",
						startedAtMs: check.startedAtMs,
						generation: orphanGeneration,
					});
				}
			} else {
				// NEVER trust that cancelPending was called.
				//
				// Asked while the entry is STILL ARMED, because one of its three
				// answers is a hold. `"settled"` is a fact about the record and is
				// acted on at once; `"gone"` is one daemon observation, and this used
				// to act on it immediately too — `forget()` dropped the fence row and
				// the buzz was gone forever, on the strength of a single listing, and
				// silently. That is below the bar every other irreversible verdict in
				// this feature is held to (`reconcile` corroborates before
				// `settle(stale)`; the reaper corroborates before correcting a row).
				// So `"gone"` HOLDS, like presence and curation, until the same
				// verdict comes back a corroboration window later.
				const fire = deps.fireVerdict(entry.questionId);
				if (fire === "settled") {
					forget(entry.questionId);
					continue;
				}
				if (fire === "gone") {
					const firstSeenGoneAtMs = goneSince.get(entry.questionId) ?? wallMs;
					goneSince.set(entry.questionId, firstSeenGoneAtMs);
					if (wallMs - firstSeenGoneAtMs < PUSH_GONE_CORROBORATION_MS) continue;
					// LOUD, because this is where a buzz is deliberately thrown away: a
					// blocked agent nobody will now be told about. Two observations a
					// minute apart agreed, which is the same standard `(QUESTION-EXPIRY)`
					// settles a question stale on.
					console.log(
						`${LOG} dropping the buzz for questionId=${entry.questionId} — its terminal has read as provably gone for ${Math.round(wallMs - firstSeenGoneAtMs)}ms across separate sweeps`,
					);
					forget(entry.questionId);
					continue;
				}
				// Recovered: a flap, a mid-restart daemon, a snapshot taken between
				// the terminal's rows. The clock starts from zero if it comes back.
				goneSince.delete(entry.questionId);
			}

			armed.delete(entry.questionId);

			due.push({
				entry,
				data: buildQuestionPushData({
					questionId: entry.questionId,
					workspaceId: entry.workspaceId,
					questionCount: entry.questionCount,
					expiresAtMs: entry.expiresAtMs,
					// (ALERT-CONTEXT-NAMES) Resolved HERE, at the due point, and never
					// allowed to break the send: this whole block is the synchronous
					// accounting that commits the entry to `sent`, so a throw would be a
					// buzz silently lost for a blocked agent.
					context: resolveContextSafely({
						hostTerminalId: entry.hostTerminalId,
						hostWorkspaceId: entry.hostWorkspaceId,
					}),
				}),
			});
			// Recorded BEFORE the send: a retraction for a push that failed is
			// harmless (a silent data message the client no-ops), whereas a
			// notification with no retraction record outlives its subject.
			sent.set(entry.questionId, {
				workspaceId: entry.workspaceId,
				sentAtMs: wallMs,
			});
			try {
				deps.fence?.markSent(entry.questionId, wallMs);
			} catch (error) {
				// Loud, and the send still happens. A missing `sent` row costs a
				// possible duplicate after a restart; refusing to send costs the buzz
				// this whole feature exists for.
				console.error(
					`${LOG} could not record questionId=${entry.questionId} as sent in the push fence — a restart could re-send it`,
					error,
				);
			}
		}

		for (const [questionId, record] of sent) {
			if (wallMs - record.sentAtMs > PUSH_SENT_RECORD_RETENTION_MS) {
				forget(questionId);
			}
		}
		// (RETRACT-WINDOW) Map iteration is insertion-ordered and entries are
		// inserted in send order, so the first keys are the oldest sends.
		while (sent.size > PUSH_MAX_SENT_RECORDS) {
			const oldest = sent.keys().next();
			if (oldest.done) break;
			forget(oldest.value);
			console.error(
				`${LOG} sent-record table exceeded ${PUSH_MAX_SENT_RECORDS}; dropped the oldest record. A retraction for it will now silently do nothing, and the notification on the handset will survive until the client's foreground sweep.`,
			);
		}

		stopSweepingIfIdle();

		for (const { entry, data } of due) {
			console.log(
				`${LOG} pushing questionId=${entry.questionId} — the user is away (${verdict.reason}, keystrokes ${verdict.humanInputAgeMs === null ? "none" : `${Math.round(verdict.humanInputAgeMs)}ms ago`}, beacon ${verdict.beaconAgeMs === null ? "none" : `${Math.round(verdict.beaconAgeMs)}ms old`}); held ${Math.round(wallMs - entry.armedAtWallMs)}ms`,
			);
			const token: SendToken = { cancelled: false };
			sendTokens.set(entry.questionId, token);
			void enqueue(entry.questionId, "push broadcast", async () => {
				try {
					await broadcast(data, token);
				} finally {
					if (sendTokens.get(entry.questionId) === token) {
						sendTokens.delete(entry.questionId);
					}
				}
			});
		}
	}

	function sweep(): void {
		evaluate(now());
	}

	/**
	 * §13.3. Cancels the in-flight original first, then runs BEHIND it on the same
	 * chain — so the retraction can never be overtaken by the push it retracts.
	 */
	function sendRetraction(questionId: QuestionId): Promise<void> {
		const record = sent.get(questionId);
		if (record === undefined) {
			// (RETRACT-WINDOW) A no-op, and it is SAID. Either no push ever went out
			// for this question — the common, uninteresting case — or one did and its
			// record has been reclaimed, in which case a notification is standing on
			// a handset that nothing here will now pull. Silence made those two
			// indistinguishable.
			console.log(
				`${LOG} no push record for questionId=${questionId} — retraction is a no-op (no push was sent, or its record aged past ${PUSH_SENT_RECORD_RETENTION_MS}ms)`,
			);
			return Promise.resolve();
		}
		forget(questionId);
		const inFlight = sendTokens.get(questionId);
		if (inFlight !== undefined) {
			inFlight.cancelled = true;
			sendTokens.delete(questionId);
		}
		console.log(`${LOG} retracting questionId=${questionId}`);
		return enqueue(questionId, "retraction", async () => {
			// The retraction's own outcome is not acted on: there is no held state to
			// return it to, and the client sweeps on foreground anyway.
			await broadcast(
				buildRetractPushData({
					questionId,
					// The workspaceId we actually pushed with, so the client matches
					// the notification it is holding.
					workspaceId: record.workspaceId,
					nowMs: now(),
				}),
				null,
			);
		});
	}

	/**
	 * (PUSH-PRESENCE) Rebuild the armed and sent sets from host.db.
	 *
	 * Runs at construction, before anything can be scheduled. A reconstructed
	 * ARMED entry is held exactly like a fresh one, and against `isCuratedOff`, so
	 * a restart is not a way for a thread the user has snoozed to buzz anyway. A
	 * reconstructed SENT entry blocks both a re-arm and a second send, and is what
	 * makes a later retraction able to carry the original workspaceId.
	 *
	 * (PUSH-ARMED-ORPHAN) Every armed entry it rebuilds is marked
	 * `storeOrphaned`, and that is a fact about reconstruction rather than a
	 * guess: `QuestionStore` lives in memory, so the only way a row reaches here
	 * is a process that outlived the store which held its question. The ordinary
	 * fire-time re-check therefore answers "never heard of it" for all of them,
	 * and acting on that answer discarded every held push on the first away sweep
	 * after a restart. `verifyOrphans` judges them against their own persisted
	 * transcripts instead.
	 */
	function reconstruct(): void {
		const fence = deps.fence;
		if (fence === null) return;
		const nowMs = now();
		let records: Awaited<ReturnType<PushFence["load"]>>;
		try {
			records = fence.load({
				nowMs,
				sentRetentionMs: PUSH_SENT_RECORD_RETENTION_MS,
			});
		} catch (error) {
			// LOUD, and not fatal: a bridge that refuses to start because it could
			// not read a notification fence is a worse outcome than one that starts
			// having forgotten some pushes.
			console.error(
				`${LOG} could not reconstruct the push fence — held pushes from before the restart are lost and already-sent ones could repeat`,
				error,
			);
			return;
		}

		for (const record of records) {
			if (record.state === "sent") {
				sent.set(record.questionId, {
					workspaceId: record.workspaceId,
					sentAtMs: record.sentAtMs ?? record.armedAtMs,
				});
				continue;
			}
			armed.set(record.questionId, {
				questionId: record.questionId,
				workspaceId: record.workspaceId,
				questionCount: record.questionCount,
				expiresAtMs: record.expiresAtMs,
				armedAtWallMs: record.armedAtMs,
				// (ALERT-CONTEXT-NAMES) The fence has carried these since
				// `(PUSH-ARMED-ORPHAN)`; reconstruction used to drop them, which left a
				// push held across a restart unable to name its chat.
				hostTerminalId: record.hostTerminalId,
				hostWorkspaceId: record.hostWorkspaceId,
				storeOrphaned: true,
			});
		}
		if (armed.size > 0) {
			console.log(
				`${LOG} reconstructed ${armed.size} held push(es) and ${sent.size} sent record(s) from the fence`,
			);
			verifyOrphans(records, nowMs);
			ensureSweeping();
		}
	}

	/**
	 * (PUSH-ARMED-ORPHAN) Ask each reconstructed row's own transcript whether its
	 * question was answered while the host-service was down.
	 *
	 * FIRE AND FORGET, DELIBERATELY. Construction is synchronous and must stay
	 * that way (the bridge's start path already cannot block), so these reads run
	 * beside it and the sweep HOLDS whatever is still in flight. A hold is the
	 * right shape: a check that is about to prove a question resolved must be
	 * allowed to finish before its notification goes out, and the hold has a
	 * deadline so a read that never returns cannot silence anything forever.
	 *
	 * Only a positive proof cancels. A row with no transcript pair is not even
	 * asked — it goes straight to `unresolved`, which means "fires on the away
	 * rules", because a missing path is the absence of evidence and this feature
	 * buzzes when it cannot tell. A path that IS there and whose file is provably
	 * GONE is the other kind of positive proof, and it retires the row for a
	 * different reason than an answer does — see `verifyOrphanResolved`.
	 */
	/**
	 * (PUSH-ORPHAN-STALE-VERDICT) May a transcript verdict that has just come back
	 * still be acted on?
	 *
	 * THE ENTRY IS RE-READ, never captured. `record` is a snapshot of a fence row
	 * taken at construction and says nothing about what the entry has done since;
	 * only the live maps do. Three things must hold, and each rules out a
	 * different way for the answer to be about something that is no longer there:
	 *
	 *   - the entry is STILL ARMED. If it has fired, been forgotten, retracted or
	 *     cancelled there is nothing left to cancel — and worse, `forget()` would
	 *     go on to delete the `sent` record a later retraction needs to pull the
	 *     buzz off the phone, so the retraction would silently no-op.
	 *   - it is still `storeOrphaned`. ADOPTION clears that flag: the hook
	 *     re-captured the question, the store holds it, and the ordinary fire-time
	 *     re-check governs it again. A `gone` landing after adoption would
	 *     `forget()` a LIVE entry — a notification lost for an agent still blocked.
	 *   - the check generation still matches, which covers a deadline the sweep
	 *     has already given up on and any later check that replaced this one.
	 */
	function orphanVerdictStillApplies(
		questionId: QuestionId,
		generation: number,
	): boolean {
		const entry = armed.get(questionId);
		if (entry === undefined || !entry.storeOrphaned) return false;
		return orphanChecks.get(questionId)?.generation === generation;
	}

	function verifyOrphans(
		records: readonly PushFenceRecord[],
		startedAtMs: number,
	): void {
		const verify = deps.verifyOrphanResolved;
		for (const record of records) {
			if (record.state !== "armed") continue;
			orphanGeneration += 1;
			const generation = orphanGeneration;
			if (
				verify === null ||
				record.transcriptPath === null ||
				record.toolUseId === null
			) {
				orphanChecks.set(record.questionId, {
					state: "unresolved",
					startedAtMs,
					generation,
				});
				continue;
			}
			const { transcriptPath, toolUseId } = record;
			orphanChecks.set(record.questionId, {
				state: "pending",
				startedAtMs,
				generation,
			});
			void verify({ questionId: record.questionId, transcriptPath, toolUseId })
				.then((verdict) => {
					if (!orphanVerdictStillApplies(record.questionId, generation)) return;
					if (verdict === "unresolved") {
						orphanChecks.set(record.questionId, {
							state: "unresolved",
							startedAtMs,
							generation,
						});
						return;
					}
					if (verdict === "gone") {
						// LOUD, because this is a buzz being deliberately thrown away. It
						// is not a claim that the question was answered: the fence row
						// names a transcript that no longer exists, so this notification
						// could not be opened or answered by anything, and leaving it
						// armed re-holds it on every restart until it expires.
						console.log(
							`${LOG} retiring reconstructed questionId=${record.questionId} — its transcript file no longer exists, so the buzz could not be opened or answered`,
						);
					} else {
						console.log(
							`${LOG} dropping reconstructed questionId=${record.questionId} — its transcript proves it was answered while the host-service was down`,
						);
					}
					forget(record.questionId);
					stopSweepingIfIdle();
				})
				.catch((error: unknown) => {
					// Not a reason to lose a buzz. "Could not check" is the same answer
					// as "no proof", and both fire.
					console.error(
						`${LOG} transcript check failed for reconstructed questionId=${record.questionId}; it will fire on the ordinary away rules`,
						error,
					);
					// Currency-checked too, and not merely for tidiness: writing here
					// unconditionally would re-create a row for a question that has
					// already been forgotten, and nothing would ever remove it.
					if (!orphanVerdictStillApplies(record.questionId, generation)) return;
					orphanChecks.set(record.questionId, {
						state: "unresolved",
						startedAtMs,
						generation,
					});
				});
		}
	}

	reconstruct();

	return {
		schedule(input) {
			if (stopped) {
				throw new PushConfigError("push sender is stopped");
			}
			const nowMs = now();
			if (input.expiresAtMs <= nowMs) {
				throw new PushConfigError(
					`refusing to arm a push for a question that already expired (${input.expiresAtMs} <= ${nowMs})`,
				);
			}
			// Idempotent against BOTH sets. `sent` matters as much as `armed`: after
			// a host-service restart the hook path re-captures live questions, and
			// re-arming one that has already buzzed would buzz it again.
			const existing = armed.get(input.questionId);
			if (existing !== undefined) {
				// (PUSH-ARMED-ORPHAN) ADOPTION. The hook has re-captured a question
				// this process only knew as a fence row, so the store now holds the
				// record and the ordinary fire-time re-check applies again. Leaving
				// the orphan flag on would keep judging it by a transcript check it no
				// longer needs — and would keep it out of the `settled` branch that
				// notices a desk answer.
				if (existing.storeOrphaned) {
					existing.storeOrphaned = false;
					orphanChecks.delete(input.questionId);
				}
				return;
			}
			if (sent.has(input.questionId)) return;
			// Validate the payload NOW, at the call site that introduced it — a bad
			// questionCount or a text leak must not surface later, from a timer.
			buildQuestionPushData({ ...input, context: null });

			armed.set(input.questionId, {
				questionId: input.questionId,
				workspaceId: input.workspaceId,
				questionCount: input.questionCount,
				expiresAtMs: input.expiresAtMs,
				armedAtWallMs: nowMs,
				hostTerminalId: input.hostTerminalId,
				hostWorkspaceId: input.hostWorkspaceId,
				storeOrphaned: false,
			});
			try {
				deps.fence?.arm({
					questionId: input.questionId,
					workspaceId: input.workspaceId,
					questionCount: input.questionCount,
					expiresAtMs: input.expiresAtMs,
					armedAtMs: nowMs,
					hostTerminalId: input.hostTerminalId,
					hostWorkspaceId: input.hostWorkspaceId,
					transcriptPath: input.transcriptPath,
					toolUseId: input.toolUseId,
				});
			} catch (error) {
				console.error(
					`${LOG} could not persist the armed push for questionId=${input.questionId} — a restart would lose it`,
					error,
				);
			}
			ensureSweeping();
			// (PUSH-PRESENCE) ZERO LATENCY WHEN NOBODY IS THERE. Evaluated inline
			// rather than left to the next tick: if the user is already away, the
			// whole value of the feature is that their phone buzzes NOW.
			evaluate(nowMs);
		},

		cancelPending(questionId) {
			const hadSent = sent.has(questionId);
			armed.delete(questionId);
			if (hadSent) {
				void sendRetraction(questionId);
			} else {
				forget(questionId);
			}
			stopSweepingIfIdle();
		},

		async retract(questionId) {
			// An armed-but-never-sent question is FORGOTTEN here, not merely
			// disarmed. `sendRetraction` clears the fence only when there is a sent
			// record to retract, so without this a retracted hold would leave its row
			// behind and a restart would reconstruct a hold for a question the caller
			// has explicitly given up on.
			const hadSent = sent.has(questionId);
			armed.delete(questionId);
			if (!hadSent) forget(questionId);
			stopSweepingIfIdle();
			await sendRetraction(questionId);
		},

		sendLifecycleAlert(input) {
			if (stopped) {
				throw new PushConfigError("push sender is stopped");
			}
			// Built (and therefore validated) HERE, at the call that introduced the
			// values, so a bad expiry or an id that could carry text throws to the
			// caller instead of surfacing later from inside a broadcast.
			const data = buildLifecyclePushData(input);
			console.log(
				`${LOG} sending lifecycle alert id=${input.alertId} kind=${input.kind}`,
			);
			// No cancel token: a lifecycle alert has no retraction to make room for
			// (see `buildLifecyclePushData`), so there is nothing that could need to
			// abandon an in-flight send.
			//
			// (LIFECYCLE-ALERT-RETRY) `enqueueOrdered`, not `enqueue`: a broadcast
			// that reached no handset must REJECT so the lifecycle manager can put
			// the alert back on hold and try again inside its TTL. Swallowing it here
			// is what made an undelivered alert indistinguishable from a delivered
			// one. NO REGISTERED DEVICE REJECTS TOO — a phone that pairs an hour
			// from now is inside the alert's six-hour life, so "nobody to send to"
			// is a reason to keep holding, not a reason to call it done.
			return enqueueOrdered(input.alertId, async () => {
				const result = await broadcast(data, null);
				if (result === "failed") {
					throw new Error(
						`FCM refused the lifecycle alert on every registered device (id=${input.alertId} kind=${input.kind})`,
					);
				}
				if (result === "no-devices") {
					throw new Error(
						`no registered device with a live token for the lifecycle alert (id=${input.alertId} kind=${input.kind})`,
					);
				}
			});
		},

		sendLifecycleRetraction(input) {
			if (stopped) return Promise.resolve();
			// Built OUTSIDE the queued job, like the alert path: a malformed id must
			// throw at the call site that introduced it rather than from inside a
			// chain nobody is awaiting.
			const data = buildLifecycleRetractPushData({
				alertId: input.alertId,
				workspaceId: input.workspaceId,
				terminalHandle: input.terminalHandle,
				outcomeAtMs: input.outcomeAtMs,
				nowMs: now(),
			});
			console.log(`${LOG} retracting lifecycle alert id=${input.alertId}`);
			// `enqueue`, not `enqueueOrdered`: the failure is logged and swallowed
			// because no caller can act on it — see `sendLifecycleRetraction` on the
			// interface. Same chain key as the alert, so the retraction cannot
			// overtake the send it cancels.
			return enqueue(input.alertId, "lifecycle retraction", async () => {
				await broadcast(data, null);
			});
		},

		getFault() {
			return fault;
		},

		inspect() {
			return {
				armed: [...armed.keys()],
				sent: [...sent.keys()],
				lastVerdict,
			};
		},

		stop() {
			stopped = true;
			if (sweepTimer !== null) {
				clearInterval(sweepTimer);
				sweepTimer = null;
			}
			abort.abort();
			for (const token of sendTokens.values()) token.cancelled = true;
			sendTokens.clear();
			chains.clear();
			// The MAPS are cleared, the ROWS are not: the fence is what a restart
			// reads back, and a clean shutdown must not be the thing that loses a
			// held push.
			armed.clear();
			sent.clear();
			goneSince.clear();
			orphanChecks.clear();
			// The parsed private key is a JS string and cannot be zeroized; it is
			// dropped and left to GC. Noted, not pretended otherwise.
			tokenSource?.invalidate();
			tokenSource = null;
		},
	};
}
