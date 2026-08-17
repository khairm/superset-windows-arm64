import { describe, expect, test } from "bun:test";
import {
	type DesktopNotice,
	desktopVersionResponseSchema,
	filterApplicableNotices,
	forkVisibleNotices,
	type NoticeClientContext,
} from "./desktop-notices";

function makeNotice(overrides: Partial<DesktopNotice> = {}): DesktopNotice {
	return {
		id: "n1",
		severity: "warning",
		trigger: "immediate",
		minVersion: null,
		maxVersion: null,
		platforms: null,
		channels: null,
		body: "b",
		cta: null,
		dismissible: true,
		...overrides,
	};
}

function makeCtx(
	overrides: Partial<NoticeClientContext> = {},
): NoticeClientContext {
	return {
		appVersion: "1.14.2",
		platform: "darwin",
		channel: "stable",
		previousVersion: null,
		isDismissed: () => false,
		...overrides,
	};
}

describe("filterApplicableNotices", () => {
	test("untargeted notice applies", () => {
		expect(filterApplicableNotices([makeNotice()], makeCtx())).toHaveLength(1);
	});

	test("maxVersion bounds: below shows, above hides", () => {
		const notice = makeNotice({ maxVersion: "1.99.0" });
		expect(filterApplicableNotices([notice], makeCtx())).toHaveLength(1);
		expect(
			filterApplicableNotices([notice], makeCtx({ appVersion: "2.0.0" })),
		).toHaveLength(0);
	});

	test("minVersion bounds: above shows, below hides", () => {
		const notice = makeNotice({ minVersion: "1.10.0" });
		expect(filterApplicableNotices([notice], makeCtx())).toHaveLength(1);
		expect(
			filterApplicableNotices([notice], makeCtx({ appVersion: "1.9.0" })),
		).toHaveLength(0);
	});

	test("semver compares numerically, not lexically", () => {
		const notice = makeNotice({ maxVersion: "9.0.0" });
		expect(
			filterApplicableNotices([notice], makeCtx({ appVersion: "10.0.0" })),
		).toHaveLength(0);
	});

	test("canary prerelease versions coerce into range", () => {
		const notice = makeNotice({ maxVersion: "1.99.0" });
		expect(
			filterApplicableNotices(
				[notice],
				makeCtx({
					appVersion: "1.14.1-canary.20260711221936",
					channel: "canary",
				}),
			),
		).toHaveLength(1);
	});

	test("platform and channel targeting", () => {
		const notice = makeNotice({ platforms: ["win32"], channels: ["canary"] });
		expect(filterApplicableNotices([notice], makeCtx())).toHaveLength(0);
		expect(
			filterApplicableNotices(
				[notice],
				makeCtx({ platform: "win32", channel: "canary" }),
			),
		).toHaveLength(1);
	});

	// (NO-REMOTE-UPDATE-GATE) inverts upstream's second case: the filter makes
	// every notice dismissible, so a recorded dismissal hides one the server
	// authored unclosable too — which is what makes dismissing the synthesized
	// minimum-version notice stick instead of it returning on the next poll.
	test("a recorded dismissal hides any notice, including one authored unclosable", () => {
		const dismissed = makeCtx({ isDismissed: () => true });
		expect(filterApplicableNotices([makeNotice()], dismissed)).toHaveLength(0);
		expect(
			filterApplicableNotices(
				[makeNotice({ severity: "blocking", dismissible: false })],
				dismissed,
			),
		).toHaveLength(0);
	});

	test("orders by severity, most severe first", () => {
		const result = filterApplicableNotices(
			[
				makeNotice({ id: "a", severity: "info" }),
				makeNotice({ id: "b", severity: "blocking", dismissible: false }),
				makeNotice({ id: "c", severity: "warning" }),
			],
			makeCtx(),
		);
		expect(result.map((n) => n.id)).toEqual(["b", "c", "a"]);
	});

	test("post-update: hidden on fresh installs, shown after updating into range", () => {
		const notice = makeNotice({ trigger: "post-update", minVersion: "1.14.0" });
		// fresh install: no previous version
		expect(filterApplicableNotices([notice], makeCtx())).toHaveLength(0);
		// updated 1.13 → 1.14.2: announce
		expect(
			filterApplicableNotices([notice], makeCtx({ previousVersion: "1.13.0" })),
		).toHaveLength(1);
		// updated 1.14.0 → 1.14.2: already had the announced release
		expect(
			filterApplicableNotices([notice], makeCtx({ previousVersion: "1.14.0" })),
		).toHaveLength(0);
	});

	test("unparseable app version fails open (no notices)", () => {
		expect(
			filterApplicableNotices(
				[makeNotice({ maxVersion: "1.99.0" })],
				makeCtx({ appVersion: "not-a-version" }),
			),
		).toHaveLength(0);
	});
});

/**
 * (NO-REMOTE-UPDATE-GATE): `minimumVersion` and `message` reach no notice and no
 * version comparison. Upstream synthesized an unclosable `blocking` notice from
 * them whenever the app was below the server's minimum — unsatisfiable in this
 * fork — and compared the raw remote string with `semver.lt`, which throws on
 * anything that is not strict semver.
 */
describe("forkVisibleNotices", () => {
	function payload(overrides: Record<string, unknown> = {}) {
		return desktopVersionResponseSchema.parse({
			minimumVersion: "99.0.0",
			message: "Please update to the latest version to continue.",
			notices: [],
			...overrides,
		});
	}

	for (const minimumVersion of ["latest", "1.15", "", "v1.2.3.4"]) {
		test(`a non-semver minimumVersion (${JSON.stringify(minimumVersion)}) neither throws nor yields a notice`, () => {
			expect(
				forkVisibleNotices(payload({ minimumVersion }), makeCtx()),
			).toEqual([]);
		});
	}

	test("an app below the server minimum gets no synthesized notice at all", () => {
		// the app under test is 1.14.2 and can never reach 99.0.0
		expect(forkVisibleNotices(payload(), makeCtx())).toEqual([]);
	});

	test("`message` never becomes a notice body", () => {
		const notices = forkVisibleNotices(
			payload({
				message: "Superset needs an update to keep syncing your workspaces.",
				notices: [makeNotice({ id: "served" })],
			}),
			makeCtx(),
		);
		// non-vacuous: the served notice comes through, the server's message does not
		expect(notices.map((n) => n.id)).toEqual(["served"]);
	});

	test("served notices still come through, downgraded to dismissible warnings", () => {
		const notices = forkVisibleNotices(
			payload({
				notices: [makeNotice({ severity: "blocking", dismissible: false })],
			}),
			makeCtx(),
		);
		expect(notices).toHaveLength(1);
		expect(notices[0]?.severity).toBe("warning");
		expect(notices[0]?.dismissible).toBe(true);
	});
});

/**
 * (NO-REMOTE-UPDATE-GATE): no data returned by `GET /api/desktop/version` may
 * produce a surface the user cannot get out of.
 *
 * Driven through the real pipeline — the response schema, then
 * `forkVisibleNotices` — over one deliberately hostile payload, and asserted
 * over the WHOLE output set rather than against any particular notice, render
 * site or severity value: upstream reshapes those freely, and what the fork
 * actually needs is that nothing coming back from the server can brick the app.
 */
describe("no remote payload can produce an unclosable surface", () => {
	const HOSTILE_PAYLOAD = {
		// the app under test is 1.14.2, so this demands a version it can never
		// reach — the fork reads neither this nor `message`
		minimumVersion: "99.0.0",
		message: "Superset needs an update to keep syncing your workspaces.",
		notices: [
			{
				id: "gate",
				severity: "blocking",
				trigger: "immediate",
				body: "This version depends on a background sync service that is being retired.",
				cta: { label: "Install & restart", action: "install-update" },
				dismissible: false,
			},
			{
				// the quieter brick: an unclosable modal needs no `blocking` severity
				id: "quiet-brick",
				severity: "warning",
				trigger: "immediate",
				body: "Heads up",
				cta: { label: "Update now", action: "install-update" },
				dismissible: false,
			},
			{
				id: "announcement",
				severity: "info",
				trigger: "immediate",
				body: "What changed",
				cta: {
					label: "Read the changelog",
					action: "open-url",
					url: "https://superset.sh/changelog",
				},
				dismissible: true,
			},
		],
	};

	/** The production path: parse the payload, then filter it. */
	function visible(ctx: NoticeClientContext = makeCtx()): DesktopNotice[] {
		return forkVisibleNotices(
			desktopVersionResponseSchema.parse(HOSTILE_PAYLOAD),
			ctx,
		);
	}

	test("every notice it yields is dismissible and not blocking", () => {
		const notices = visible();
		// non-vacuous: all three served notices get through
		expect(notices).toHaveLength(3);
		for (const notice of notices) {
			expect(notice.severity).not.toBe("blocking");
			expect(notice.dismissible).toBe(true);
		}
	});

	test("dismissing them is permanent — a later poll of the same payload shows none", () => {
		const dismissed = new Set(visible().map((n) => n.id));
		expect(dismissed.size).toBe(3);
		expect(
			visible(makeCtx({ isDismissed: (id) => dismissed.has(id) })),
		).toEqual([]);
	});

	test("dismissing one leaves the rest, still all dismissible", () => {
		const rest = visible(makeCtx({ isDismissed: (id) => id === "gate" }));
		expect(rest.map((n) => n.id)).not.toContain("gate");
		expect(rest).toHaveLength(2);
		for (const notice of rest) {
			expect(notice.severity).not.toBe("blocking");
			expect(notice.dismissible).toBe(true);
		}
	});
});
