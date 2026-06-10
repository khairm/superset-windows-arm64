/**
 * Normalized lifecycle event types broadcast over the WS event bus.
 *
 * - `Start` / `Stop`: per-turn working-state cadence — drives the working
 *   indicator and the completion chime.
 * - `PermissionRequest`: agent is blocked waiting for a tool/exec decision.
 * - `Attached` / `Detached`: session-lifetime signal — drives the pane icon
 *   binding only. NOT working state: SessionStart fires on agent boot when
 *   the agent is still idle waiting for input.
 * - `BackgroundRunning`: (BA) the main turn ENDED but a cloud/background session
 *   is still running (non-empty `background_tasks` in the Stop hook payload).
 *   Drives the pulsing BLUE dot on a SEPARATE render axis. The agent dot itself
 *   is handled exactly like a normal turn-end (review-or-clear); the renderer's
 *   precedence is red > yellow > blue > green, so this blue outranks a fresh
 *   review green and shows as soon as the turn ends with a task still running.
 * - `SubagentActive`: (TEAM-YELLOW) the turn ended but agent-type background
 *   work (teammates/forks/workflows/codex-companion) is still running. The
 *   renderer asserts working/yellow UNLESS the source is already red — a plain
 *   `Start` here would stomp a pending permission/question from a teammate
 *   (red must trump yellow). Quiet: no chime, no native notification.
 */
export type AgentLifecycleEventType =
	| "Start"
	| "Stop"
	| "PermissionRequest"
	| "Attached"
	| "Detached"
	| "BackgroundRunning"
	| "SubagentActive";

export function mapEventType(
	eventType: string | undefined,
): AgentLifecycleEventType | null {
	if (!eventType) {
		return null;
	}
	if (
		eventType === "Attached" ||
		eventType === "attached" ||
		eventType === "SessionStart" ||
		eventType === "sessionStart" ||
		eventType === "session_start"
	) {
		return "Attached";
	}
	if (
		eventType === "Detached" ||
		eventType === "detached" ||
		eventType === "SessionEnd" ||
		eventType === "sessionEnd" ||
		eventType === "session_end"
	) {
		return "Detached";
	}
	// (BA) Cloud/background-session-still-running signal from the notify hook.
	if (eventType === "BackgroundRunning") {
		return "BackgroundRunning";
	}
	// (TEAM-YELLOW) Turn-end working-hold from the notify hook: agent-type
	// background work still running. Red-respecting in the renderer.
	if (eventType === "SubagentActive") {
		return "SubagentActive";
	}
	if (
		eventType === "Start" ||
		eventType === "UserPromptSubmit" ||
		eventType === "PostToolUse" ||
		eventType === "PostToolUseFailure" ||
		eventType === "BeforeAgent" ||
		eventType === "AfterTool" ||
		eventType === "userPromptSubmitted" ||
		eventType === "user_prompt_submit" ||
		eventType === "postToolUse" ||
		eventType === "post_tool_use" ||
		eventType === "task_started"
	) {
		return "Start";
	}
	if (
		eventType === "PermissionRequest" ||
		eventType === "Notification" ||
		eventType === "PreToolUse" ||
		eventType === "preToolUse" ||
		eventType === "pre_tool_use" ||
		eventType === "exec_approval_request" ||
		eventType === "apply_patch_approval_request" ||
		eventType === "request_user_input"
	) {
		return "PermissionRequest";
	}
	if (
		eventType === "Stop" ||
		eventType === "stop" ||
		eventType === "agent-turn-complete" ||
		eventType === "AfterAgent" ||
		eventType === "task_complete"
	) {
		return "Stop";
	}
	return null;
}
