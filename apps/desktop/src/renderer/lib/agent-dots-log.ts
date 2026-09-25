/**
 * Diagnostic logging for the agent-status-dots pipeline. Emitted via
 * console.info with an "[agent-dots]" prefix so the main process's production
 * console-message forwarder persists it to electron-log (main.log).
 * Logging-only — never alters behaviour. Flip AGENT_DOTS_LOG to re-arm. Hot
 * selectors are deliberately NOT instrumented. See
 * patches/notification-logging.patch.
 */
export const AGENT_DOTS_LOG: boolean = false;

export function agentDotsLog(record: Record<string, unknown>): void {
	if (!AGENT_DOTS_LOG) return;
	try {
		console.info(
			`[agent-dots] ${JSON.stringify({ ts: new Date().toISOString(), ...record })}`,
		);
	} catch {
		// never let logging crash the renderer
	}
}
