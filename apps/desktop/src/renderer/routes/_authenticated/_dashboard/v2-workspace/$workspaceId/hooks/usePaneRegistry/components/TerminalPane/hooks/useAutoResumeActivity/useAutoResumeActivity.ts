// (AUTO-RESUME) Takeover signal: any TRUSTED user interaction with this terminal cancels
// its armed auto-resume (the user is handling it). Only user-originated events count —
// NOT xterm output-driven onScroll, and not the auto-resume write echo. Calling cancel is
// a cheap no-op server-side when nothing is armed, so we don't track armed state here
// (which keeps it race-free: we can never "miss" a cancel because of stale arming state).
import type { Terminal as XTerm } from "@xterm/xterm";
import { type RefObject, useEffect, useRef } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";

const DEBOUNCE_MS = 400;
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
		let timer: ReturnType<typeof setTimeout> | null = null;
		const onActivity = () => {
			if (timer) return; // already scheduled within the debounce window
			timer = setTimeout(() => {
				timer = null;
				mutateRef.current({ terminalId });
			}, DEBOUNCE_MS);
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
			const onData = terminal.onData(onActivity);
			const onKey = terminal.onKey(onActivity);
			disposers.push(() => onData.dispose());
			disposers.push(() => onKey.dispose());
		}
		return () => {
			if (timer) clearTimeout(timer);
			for (const dispose of disposers) dispose();
		};
	}, [terminalId, containerRef, terminal]);
}
