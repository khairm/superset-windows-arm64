import { useCallback, useEffect, useRef, useState } from "react";

export interface LinkClickHint {
	clientX: number;
	clientY: number;
	/**
	 * Optional message. When set it overrides the default "unbound link" hint
	 * and is NOT subject to the per-session cap — used for the (AZ) single-click
	 * "Copied!" confirmation, which must show on every copy.
	 */
	label?: string;
}

const HINT_DURATION_MS = 2000;
const COPIED_DURATION_MS = 1100;
const MAX_HINTS_PER_SESSION = 2;

let hintsRemaining = MAX_HINTS_PER_SESSION;

export function useLinkClickHint() {
	const [hint, setHint] = useState<LinkClickHint | null>(null);
	const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const flash = useCallback((next: LinkClickHint, durationMs: number) => {
		if (timeoutRef.current) clearTimeout(timeoutRef.current);
		setHint(next);
		timeoutRef.current = setTimeout(() => {
			setHint(null);
			timeoutRef.current = null;
		}, durationMs);
	}, []);

	const showHint = useCallback(
		(clientX: number, clientY: number) => {
			if (hintsRemaining <= 0) return;
			hintsRemaining -= 1;
			flash({ clientX, clientY }, HINT_DURATION_MS);
		},
		[flash],
	);

	// (AZ) Confirm a single-click URL copy. Uncapped (every copy confirms) and
	// carries its own label so the shared hint bubble reads "Copied!".
	const showCopied = useCallback(
		(clientX: number, clientY: number) => {
			flash({ clientX, clientY, label: "Copied!" }, COPIED_DURATION_MS);
		},
		[flash],
	);

	useEffect(() => {
		return () => {
			if (timeoutRef.current) clearTimeout(timeoutRef.current);
		};
	}, []);

	return { hint, showHint, showCopied };
}
