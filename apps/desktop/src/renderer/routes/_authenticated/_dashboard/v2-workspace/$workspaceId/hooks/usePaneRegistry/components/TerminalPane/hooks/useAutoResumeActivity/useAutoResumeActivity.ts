// (AUTO-RESUME) Takeover signal: any TRUSTED user interaction with this terminal cancels
// its armed auto-resume (the user is handling it). Only user-originated events count —
// NOT xterm output-driven onScroll, and not the auto-resume write echo. Calling cancel is
// a cheap no-op server-side when nothing is armed, so we don't track armed state here
// (which keeps it race-free: we can never "miss" a cancel because of stale arming state).
import type { Terminal as XTerm } from "@xterm/xterm";
import { type RefObject, useEffect, useRef } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";

// Suppress repeat cancels for this long after a leading-edge fire (typing bursts).
const COOLDOWN_MS = 1_000;
const TRUSTED_DOM_EVENTS = [
	"keydown",
	"pointerdown",
	"wheel",
	"paste",
	"drop",
] as const;

export function useAutoResumeActivity(params: {
	terminalId: string;
	containerRef: RefObject<HTMLDivElement | null>;
	terminal: XTerm | null;
}): void {
	const { terminalId, containerRef, terminal } = params;
	const notifyActivity = electronTrpc.autoResume.notifyActivity.useMutation();
	const mutateRef = useRef(notifyActivity.mutate);
	mutateRef.current = notifyActivity.mutate;

	useEffect(() => {
		// Fire the cancel on the LEADING edge (so a fast workspace-switch/park can't drop
		// it), then cool down to suppress repeats. No pending timer to lose on unmount.
		let cooldownUntil = 0;
		const onActivity = () => {
			const now = Date.now();
			if (now < cooldownUntil) return;
			cooldownUntil = now + COOLDOWN_MS;
			mutateRef.current({ terminalId });
		};

		const disposers: Array<() => void> = [];
		const container = containerRef.current;
		if (container) {
			const opts: AddEventListenerOptions = { capture: true };
			for (const ev of TRUSTED_DOM_EVENTS) {
				container.addEventListener(ev, onActivity, opts);
				disposers.push(() =>
					container.removeEventListener(ev, onActivity, opts),
				);
			}
		}
		if (terminal) {
			// onKey = real keypresses only. NOT terminal.onData — xterm emits onData for
			// emulator-generated replies too (cursor-position/device-attribute responses to
			// the agent's own TUI redraws), which would spuriously cancel auto-resume.
			const onKey = terminal.onKey(onActivity);
			disposers.push(() => onKey.dispose());
		}
		return () => {
			for (const dispose of disposers) dispose();
		};
	}, [terminalId, containerRef, terminal]);
}
