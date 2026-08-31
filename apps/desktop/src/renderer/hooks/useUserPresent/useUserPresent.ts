import { useSyncExternalStore } from "react";

/**
 * Is the user actually AT the machine — window shown and focused?
 *
 * ONE PREDICATE, THREE CALLERS, and they ask it for opposite reasons: do not
 * ring a chime at someone who is watching; do not raise a review dot for a
 * finish they saw happen; do not retract a phone alert for someone who is not
 * there. Two hand-written copies of that test drifting apart is how a card gets
 * taken off a phone nobody has looked at.
 *
 * LAYOUT IS NOT ATTENTION. Where a pane sits in the tab tree is equally true
 * with the screen locked, the window behind a browser, or the user out of the
 * room — which is the companion feature's primary scenario, and the one where
 * acting on "visible" is both wrong and irreversible. Composing the two is the
 * notification code's business, not this hook's.
 */
export function isUserPresent(): boolean {
	if (typeof document !== "undefined" && document.hidden) return false;
	if (typeof window !== "undefined" && !document.hasFocus()) return false;
	return true;
}

/**
 * The three DOM events that can change the answer, in one place beside the
 * predicate they re-read. Nothing else in the renderer re-renders when a user
 * comes back to a window that has been hidden for an hour.
 */
function subscribeToPresence(onChange: () => void): () => void {
	window.addEventListener("focus", onChange);
	window.addEventListener("blur", onChange);
	document.addEventListener("visibilitychange", onChange);
	return () => {
		window.removeEventListener("focus", onChange);
		window.removeEventListener("blur", onChange);
		document.removeEventListener("visibilitychange", onChange);
	};
}

/** `isUserPresent`, as a reactive dependency. */
export function useUserPresent(): boolean {
	return useSyncExternalStore(subscribeToPresence, isUserPresent);
}
