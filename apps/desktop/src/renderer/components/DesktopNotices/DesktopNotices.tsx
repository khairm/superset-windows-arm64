import { forkSafeNotice } from "@superset/shared/desktop-notices";
import { type ReactNode, useEffect } from "react";
import { env } from "renderer/env.renderer";
import { useDesktopNotices } from "renderer/hooks/useDesktopNotices";
import { useDesktopNoticePreviewStore } from "renderer/stores/desktop-notice-preview";
import { NoticeDialog } from "./components/NoticeDialog";

/**
 * Server-driven version notices (plans/done/20260720-remote-version-notices.md).
 * Every notice renders as one dismissible modal over the app.
 *
 * (NO-REMOTE-UPDATE-GATE): upstream branched on `severity === "blocking"` here
 * and rendered `UpdateRequiredPage` — a full-screen forced-update gate with no
 * way out whose "Download Manually" button installs UPSTREAM's build over this
 * fork. That branch is gone and the component is DELETED from the fork, so no
 * severity has a full-screen surface to reach. `filterApplicableNotices` owns
 * the invariant, which makes the `forkSafeNotice` call below redundant TODAY;
 * it is kept because it is the layer that still holds if a refactor moves the
 * legacy `minimumVersion` synthesis to AFTER filtering, and because
 * `NoticeDialog` is itself unclosable when handed `dismissible: false`. A merge
 * that re-adds a severity branch or re-imports `UpdateRequiredPage` must delete
 * it again.
 */
export function DesktopNoticesGate({ children }: { children: ReactNode }) {
	const { current, dismiss } = useDesktopNotices();
	const preview = useDesktopNoticePreviewStore((s) => s.preview);
	const setPreview = useDesktopNoticePreviewStore((s) => s.setPreview);

	// Escape clears a dev preview.
	useEffect(() => {
		if (env.NODE_ENV !== "development" || !preview) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setPreview(null);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [preview, setPreview]);

	const notice = current ? forkSafeNotice(current) : null;

	return (
		<>
			{children}
			{notice && <NoticeDialog notice={notice} onDismiss={dismiss} />}
		</>
	);
}
