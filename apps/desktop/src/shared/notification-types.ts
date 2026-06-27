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
	// Full lifecycle union carried on this channel. `SubagentActive` (the
	// red-respecting working hold) is emitted directly by the JSONL watcher
	// (UNTAGGED-BG-RED held interrupt) as well as by the host-service POST path;
	// `BackgroundRunning` is the blue cloud/background signal. `PendingQuestion`
	// is the legacy awaiting-input alias still recognized by the notification
	// manager. The notification manager only chimes on `Stop`/permission.
	eventType:
		| "Start"
		| "Stop"
		| "PermissionRequest"
		| "PendingQuestion"
		| "SubagentActive"
		| "BackgroundRunning";
}

export type V2NotificationSource =
	| { type: "terminal"; id: string }
	| { type: "chat"; id: string };

export interface V2NotificationSourceFocusTarget {
	workspaceId: string;
	source: V2NotificationSource;
}
