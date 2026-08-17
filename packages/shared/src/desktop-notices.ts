import * as semver from "semver";
import { z } from "zod";

/**
 * Wire format for server-driven desktop notices, returned by
 * `GET /api/desktop/version` alongside the legacy `minimumVersion` gate.
 * See plans/done/20260720-remote-version-notices.md.
 */

const desktopNoticeSchema = z.object({
	id: z.string(),
	severity: z.enum(["info", "warning", "blocking"]),
	trigger: z.enum(["immediate", "pre-update", "post-update"]),
	minVersion: z.string().nullish(),
	maxVersion: z.string().nullish(),
	platforms: z.array(z.string()).nullish(),
	channels: z.array(z.string()).nullish(),
	/** Markdown; the whole rendered content, headings and images included. */
	body: z.string(),
	cta: z
		.object({
			label: z.string(),
			action: z.enum(["install-update", "open-url"]),
			url: z.string().nullish(),
		})
		.nullish(),
	dismissible: z.boolean(),
});
export type DesktopNotice = z.infer<typeof desktopNoticeSchema>;

export const desktopVersionResponseSchema = z.object({
	minimumVersion: z.string(),
	message: z.string(),
	// older servers don't return this field
	notices: z.array(desktopNoticeSchema).default([]),
});

const SEVERITY_RANK: Record<DesktopNotice["severity"], number> = {
	blocking: 2,
	warning: 1,
	info: 0,
};

export interface NoticeClientContext {
	appVersion: string;
	platform: string;
	channel: "stable" | "canary";
	/** Version this install ran before its most recent update; null on fresh installs. */
	previousVersion: string | null;
	isDismissed: (id: string) => boolean;
}

function noticeApplies(
	notice: DesktopNotice,
	ctx: NoticeClientContext,
): boolean {
	if (notice.dismissible && ctx.isDismissed(notice.id)) return false;
	if (notice.platforms?.length && !notice.platforms.includes(ctx.platform))
		return false;
	if (notice.channels?.length && !notice.channels.includes(ctx.channel))
		return false;

	const version = semver.coerce(ctx.appVersion);
	// fail open on an unparseable version rather than spamming everyone
	if (!version) return false;
	if (notice.minVersion && semver.lt(version, notice.minVersion)) return false;
	if (notice.maxVersion && semver.gt(version, notice.maxVersion)) return false;

	// post-update = release announcement: only for installs that updated INTO
	// the announced version (previousVersion below minVersion); never for
	// fresh installs, which have no previous version.
	if (notice.trigger === "post-update") {
		const prev = ctx.previousVersion
			? semver.coerce(ctx.previousVersion)
			: null;
		if (!prev) return false;
		if (notice.minVersion && !semver.lt(prev, notice.minVersion)) return false;
	}
	return true;
}

/**
 * (NO-REMOTE-UPDATE-GATE) — permanent fork override.
 *
 * Nothing the notice API returns may produce a surface the user cannot get out
 * of. Upstream has two: a `blocking` notice replaces the whole window with a
 * forced-update page whose only actions are "Check for Update" (which can never
 * satisfy an upstream minimum — this fork's releases are fork-owned and its
 * updater does not track upstream) and "Download Manually" (which installs
 * UPSTREAM's build over the fork); and ANY notice with `dismissible: false`
 * renders as a modal with no close button, no Escape and no outside-click. So a
 * `warning` is just as good a brick as a `blocking` one.
 *
 * Every notice therefore becomes at most `warning` and always dismissible.
 * Downgrading BEFORE the applicability check is the point: `noticeApplies`
 * consults the dismissals store only for a dismissible notice, so this is what
 * makes a dismissal permanent for a notice the server authored as unclosable —
 * including the synthesized `minimumVersion` one.
 */
export function forkSafeNotice(notice: DesktopNotice): DesktopNotice {
	return {
		...notice,
		severity: notice.severity === "blocking" ? "warning" : notice.severity,
		dismissible: true,
	};
}

/**
 * Applicable notices, highest severity first.
 *
 * (NO-REMOTE-UPDATE-GATE): this is the fork's single choke point — every notice
 * the renderer can show reaches it, remote ones and the legacy
 * `minimumVersion`-synthesized one alike, so the invariant lives here rather
 * than at a caller or a render site that a new one could bypass.
 */
export function filterApplicableNotices(
	notices: DesktopNotice[],
	ctx: NoticeClientContext,
): DesktopNotice[] {
	return notices
		.map(forkSafeNotice)
		.filter((n) => noticeApplies(n, ctx))
		.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
}
