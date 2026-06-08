import type { DetectedPort } from "@superset/port-scanner";
import type { AgentIdentity } from "@superset/shared/agent-identity";
import type { FsWatchEvent } from "@superset/workspace-fs/host";
import type { AgentLifecycleEventType } from "./map-event-type.ts";

// ── Server → Client ────────────────────────────────────────────────

export interface FsEventsMessage {
	type: "fs:events";
	workspaceId: string;
	events: FsWatchEvent[];
}

export interface GitChangedMessage {
	type: "git:changed";
	workspaceId: string;
	/**
	 * Worktree-relative paths that changed when the batch was worktree-only.
	 * Absent means a broad git state change (`.git/` activity — commit, index,
	 * refs, or mixed) — consumers should invalidate everything for the
	 * workspace.
	 */
	paths?: string[];
}

export interface AgentLifecycleMessage {
	type: "agent:lifecycle";
	workspaceId: string;
	eventType: AgentLifecycleEventType;
	terminalId: string;
	// Absent when the hook ran without `SUPERSET_AGENT_ID` set (legacy shells
	// or third-party hook configs that bypass our wrappers).
	agent?: AgentIdentity;
	occurredAt: number;
}

/**
 * Terminal process / command lifecycle, fanned out to renderer clients.
 *
 * - "exit": the PTY process ended (existing behaviour).
 * - "command-start" / "command-end": a foreground command began / finished in
 *   the shell, detected from OSC 133 C/D markers (shell-running blue dot). These
 *   are NOT agent statuses — they drive a separate render-only axis.
 */
export type TerminalLifecycleMessage =
	| {
			type: "terminal:lifecycle";
			workspaceId: string;
			terminalId: string;
			eventType: "exit";
			exitCode: number;
			signal: number;
			occurredAt: number;
	  }
	| {
			type: "terminal:lifecycle";
			workspaceId: string;
			terminalId: string;
			eventType: "command-start";
			occurredAt: number;
	  }
	| {
			type: "terminal:lifecycle";
			workspaceId: string;
			terminalId: string;
			eventType: "command-end";
			exitCode: number | null;
			occurredAt: number;
	  };

export interface PortChangedMessage {
	type: "port:changed";
	workspaceId: string;
	eventType: "add" | "remove";
	port: DetectedPort;
	label: string | null;
	occurredAt: number;
}

export interface EventBusErrorMessage {
	type: "error";
	message: string;
}

export type ServerMessage =
	| FsEventsMessage
	| GitChangedMessage
	| AgentLifecycleMessage
	| TerminalLifecycleMessage
	| PortChangedMessage
	| EventBusErrorMessage;

// ── Client → Server ────────────────────────────────────────────────

export interface FsWatchCommand {
	type: "fs:watch";
	workspaceId: string;
}

export interface FsUnwatchCommand {
	type: "fs:unwatch";
	workspaceId: string;
}

export type ClientMessage = FsWatchCommand | FsUnwatchCommand;
