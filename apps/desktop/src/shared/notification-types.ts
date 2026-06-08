/**
 * Shared notification types used by both main and renderer processes.
 * Kept in shared/ to avoid cross-boundary imports.
 */

export interface NotificationIds {
	paneId?: string;
	tabId?: string;
	workspaceId?: string;
	sessionId?: string;
	terminalId?: string;
	/**
	 * Working directory of the agent process. Used by the Windows
	 * JSONL-watcher fallback when no other identity is available — the
	 * renderer resolves it against the live tabs store via
	 * `resolveNotificationTarget`. See `patches/agent-jsonl-watcher.patch`.
	 */
	cwd?: string;
}

export interface AgentLifecycleEvent extends NotificationIds {
	eventType: "Start" | "Stop" | "PermissionRequest" | "PendingQuestion";
}

export type V2NotificationSource =
	| { type: "terminal"; id: string }
	| { type: "chat"; id: string };

export interface V2NotificationSourceFocusTarget {
	workspaceId: string;
	source: V2NotificationSource;
}
