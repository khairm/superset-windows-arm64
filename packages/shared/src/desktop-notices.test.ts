import { describe, expect, test } from "bun:test";
import {
	type DesktopNotice,
	desktopVersionResponseSchema,
	filterApplicableNotices,
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
 * (NO-REMOTE-UPDATE-GATE): no data returned by `GET /api/desktop/version` may
 * produce a surface the user cannot get out of.
 *
 * Driven through the real pipeline — the response schema, then the shared filter
 * — over one deliberately hostile payload, and asserted over the WHOLE output
 * set rather than against any particular notice, render site or severity value:
 * upstream reshapes those freely, and what the fork actually needs is that
 * nothing coming back from the server can brick the app.
 */
describe("no remote payload can produce an unclosable surface", () => {
	/** Mirrors the legacy `minimumVersion` notice `useDesktopNotices` synthesizes
	 * (pushed in before filtering) when the app is below the server's minimum. */
	function minimumVersionNotice(message: string): DesktopNotice {
		return {
			id: "minimum-version",
			severity: "blocking",
			trigger: "immediate",
			body: message,
			cta: { label: "Install & restart", action: "install-update" },
			dismissible: false,
		};
	}

	const HOSTILE_PAYLOAD = {
		// the app under test is 1.14.2, so this demands a version it can never reach
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

	/** The production path: parse the payload, add the synthesized
	 * minimum-version notice, filter. */
	function visible(ctx: NoticeClientContext = makeCtx()): DesktopNotice[] {
		const parsed = desktopVersionResponseSchema.parse(HOSTILE_PAYLOAD);
		return filterApplicableNotices(
			[...parsed.notices, minimumVersionNotice(parsed.message)],
			ctx,
		);
	}

	test("every notice it yields is dismissible and not blocking", () => {
		const notices = visible();
		// non-vacuous: all three served notices plus the synthesized one get through
		expect(notices).toHaveLength(4);
		for (const notice of notices) {
			expect(notice.severity).not.toBe("blocking");
			expect(notice.dismissible).toBe(true);
		}
	});

	test("dismissing them is permanent — a later poll of the same payload shows none", () => {
		const dismissed = new Set(visible().map((n) => n.id));
		expect(dismissed.size).toBe(4);
		expect(
			visible(makeCtx({ isDismissed: (id) => dismissed.has(id) })),
		).toEqual([]);
	});

	test("dismissing one leaves the rest, still all dismissible", () => {
		const rest = visible(makeCtx({ isDismissed: (id) => id === "gate" }));
		expect(rest.map((n) => n.id)).not.toContain("gate");
		expect(rest).toHaveLength(3);
		for (const notice of rest) {
			expect(notice.severity).not.toBe("blocking");
			expect(notice.dismissible).toBe(true);
		}
	});
});
