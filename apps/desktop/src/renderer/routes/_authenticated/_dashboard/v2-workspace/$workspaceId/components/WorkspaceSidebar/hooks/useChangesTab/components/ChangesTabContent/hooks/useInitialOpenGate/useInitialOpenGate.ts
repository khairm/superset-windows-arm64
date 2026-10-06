import { useEffect, useState } from "react";

const FALLBACK_MS = 1000;

/**
 * When `gated` on a workspace's first render, false until the task after the
 * next paint. Decided once per workspace, so content arriving later renders
 * at once. The fallback only covers a frame that never comes; a short one
 * would fire before a busy open's first paint.
 */
export function useInitialOpenGate(workspaceId: string, gated: boolean) {
	const [gate, setGate] = useState(() => ({ workspaceId, ready: !gated }));
	if (gate.workspaceId !== workspaceId) {
		setGate({ workspaceId, ready: !gated });
	}
	const ready = gate.workspaceId === workspaceId && gate.ready;

	useEffect(() => {
		if (ready) return;
		const open = () =>
			setGate((prev) =>
				prev.workspaceId === workspaceId ? { workspaceId, ready: true } : prev,
			);
		let afterPaint = 0;
		const frame = requestAnimationFrame(() => {
			afterPaint = window.setTimeout(open, 0);
		});
		const fallback = window.setTimeout(open, FALLBACK_MS);
		return () => {
			cancelAnimationFrame(frame);
			window.clearTimeout(afterPaint);
			window.clearTimeout(fallback);
		};
	}, [ready, workspaceId]);

	return ready;
}
