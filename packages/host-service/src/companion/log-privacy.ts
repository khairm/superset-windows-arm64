/**
 * (CHAT-CONTEXT-NAMES) What a diagnostic about a failed name lookup is allowed
 * to say, and how to say it without the saying becoming its own failure.
 *
 * This lives beside `BridgeLogger` rather than in `read-api.ts` because the
 * rule is the LOGGING contract's, not the read path's: the composition root's
 * alert resolver (`resolveAlertContext` in `index.ts`) reads the same rows and
 * has the same leak. Two copies of a privacy rule are two chances for one of
 * them to be relaxed alone.
 */

/**
 * (CHAT-CONTEXT-NAMES) An error's CLASS, and nothing else.
 *
 * The privacy rule for the whole feature in one function: a diagnostic about a
 * failed name lookup may say what KIND of failure it was and which ids it was
 * about, never what the failure said. `new Error(projectName)` is a plausible
 * thing for a resolver to throw, and logging `error`, `error.message` or the
 * object itself would put the name straight into the log the feature exists to
 * keep it out of.
 */
export function errorClassName(error: unknown): string {
	// TOTAL over hostile values. `throw` takes any value at all, including one
	// whose `constructor` or `name` is an accessor that throws — and this
	// function is called from the CATCH block of a never-throw wrapper, so a
	// secondary throw here escapes the wrapper and costs the caller the whole
	// tree or the whole question. That is the one outcome degrading a name is
	// supposed to prevent.
	try {
		const name = (
			error as { constructor?: { name?: unknown } } | null | undefined
		)?.constructor?.name;
		return typeof name === "string" && name.length > 0 ? name : "unknown";
	} catch {
		return "unknown";
	}
}

/**
 * (CHAT-CONTEXT-NAMES) Emit a diagnostic, or drop it. NEVER THROWS.
 *
 * A never-throw wrapper is only never-throw if the logging it does on the way
 * out cannot throw either. `log` is a composition-root callback — a full disk,
 * a closed stream, a transport that rejects synchronously — and a failure there
 * turning a degraded tab title into a failed `/v1/tree` is the same bad trade
 * the wrappers exist to refuse, one layer up. There is nothing left to report
 * the failure to, so it is dropped.
 */
export function logSafely(
	log: (event: Record<string, unknown>) => void,
	event: Record<string, unknown>,
): void {
	try {
		log(event);
	} catch {
		// Deliberately silent: the reporting channel is the thing that failed.
	}
}
