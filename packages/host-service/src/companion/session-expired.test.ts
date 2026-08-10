import { describe, expect, it } from "bun:test";
import {
	type NegotiatedSession,
	ROUTES,
	requireCapabilities,
	requireLiveSession,
	requireProtocolPath,
} from "./http";
import { type Capability, SealedError, type SealedPath } from "./types";

// ---------------------------------------------------------------------------
// (SESSION-EXPIRED-VERDICT)
//
// The session registry is in-memory and per-mount, so "the bridge restarted" and
// "this capability is withheld" used to be the same bytes on the wire: a dead
// session degraded `granted` to `[]`, and every gated route answered `501
// capability_unsupported`. The phone's documented action for 501 ends at "answer
// at the desk", which is the wrong terminal state for a condition one `hello`
// fixes.
//
// These cases pin the split. What is deliberately NOT split is a LIVE session
// that lacks the capability — that is still 501, and the last two cases exist to
// keep it that way.
// ---------------------------------------------------------------------------

const NOW = 1_700_000_000_000;

function liveSession(
	overrides: Partial<NegotiatedSession> = {},
): NegotiatedSession {
	return {
		protocolVersion: 1,
		granted: ["answer.single", "message.send"],
		expiresAtMs: NOW + 60_000,
		...overrides,
	};
}

const ALL_PATHS = Object.keys(ROUTES) as SealedPath[];
const GATED_PATHS = ALL_PATHS.filter(
	(path) => ROUTES[path].capability !== null,
);
const UNGATED_PATHS = ALL_PATHS.filter(
	(path) => ROUTES[path].capability === null,
);

function verdict(fn: () => void): SealedError {
	try {
		fn();
	} catch (error) {
		if (error instanceof SealedError) return error;
		throw error;
	}
	throw new Error("expected a SealedError, got a pass");
}

describe("protocol 0 paths", () => {
	const admitted: SealedPath[] = [
		"/v1/heartbeat",
		"/v1/session/hello",
		"/v1/tree",
	];

	it("keeps protocol 0 read-only even when no negotiated session exists", () => {
		const blocked: SealedPath[] = [];
		for (const path of ALL_PATHS) {
			try {
				requireProtocolPath(path, 0);
			} catch (error) {
				if (!(error instanceof SealedError)) throw error;
				expect(error.statusCode).toBe(501);
				expect(error.body.code).toBe("capability_unsupported");
				blocked.push(path);
			}
		}

		expect(ALL_PATHS.filter((path) => !blocked.includes(path)).sort()).toEqual(
			admitted,
		);
		expect(blocked).toContain("/v1/answer");
	});

	it("does not restrict protocol 1 paths", () => {
		for (const path of ALL_PATHS) {
			expect(() => requireProtocolPath(path, 1)).not.toThrow();
		}
	});
});

describe("(SESSION-EXPIRED-VERDICT) no live session", () => {
	it("refuses every capability-gated route with 409 session_expired", () => {
		// A vacuous loop would pass silently if the route table lost its gates.
		expect(GATED_PATHS.length).toBeGreaterThan(0);

		for (const path of GATED_PATHS) {
			const error = verdict(() => requireLiveSession(path, null));
			expect(error.statusCode).toBe(409);
			expect(error.body.code).toBe("session_expired");
			expect(error.body.detail).toEqual({ path });
			expect(error.body.retryAfterMs).toBeNull();
		}
	});

	it("admits baseline, panic, and guardless question routes", () => {
		// Asserted as a SET, not a count: hello creates sessions, panic must work
		// when negotiation failed, and (ANSWER-GUARDLESS) question discovery,
		// detail, submission, and status depend on paired-device authentication
		// rather than negotiated grants.
		expect([...UNGATED_PATHS].sort()).toEqual([
			"/v1/answer",
			"/v1/answer/status",
			"/v1/heartbeat",
			"/v1/panic",
			"/v1/question",
			"/v1/session/hello",
			"/v1/tree",
		]);

		for (const path of UNGATED_PATHS) {
			expect(() => requireLiveSession(path, null)).not.toThrow();
		}
	});
});

describe("(SESSION-EXPIRED-VERDICT) a live session", () => {
	it("passes the session check on every gated route", () => {
		for (const path of GATED_PATHS) {
			expect(() => requireLiveSession(path, liveSession())).not.toThrow();
		}
	});

	it("still gets 501 capability_unsupported when the capability is withheld", () => {
		const path: SealedPath = "/v1/message";
		const session = liveSession({ granted: ["answer.single"] });

		expect(() => requireLiveSession(path, session)).not.toThrow();

		const error = verdict(() =>
			requireCapabilities(session.granted, [ROUTES[path].capability]),
		);
		expect(error.statusCode).toBe(501);
		expect(error.body.code).toBe("capability_unsupported");
		expect(error.body.detail).toEqual({ capability: "message.send" });
	});

	it("gets 501 rather than 409 even when its grant set is empty", () => {
		// The whole point of the split: an EMPTY grant set that a `hello` really
		// negotiated is a withheld capability, not a dead session.
		const path: SealedPath = "/v1/message";
		const session = liveSession({ granted: [] as readonly Capability[] });

		expect(() => requireLiveSession(path, session)).not.toThrow();
		expect(
			verdict(() =>
				requireCapabilities(session.granted, [ROUTES[path].capability]),
			).statusCode,
		).toBe(501);
	});
});
