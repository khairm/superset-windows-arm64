import { cn } from "@superset/ui/utils";
import type { ActivePaneStatus } from "shared/tabs-types";

// Re-export for consumers
export type { ActivePaneStatus } from "shared/tabs-types";

/**
 * (AY) Render-only status union: the agent statuses plus "shell-running" (a
 * pulsing BLUE dot meaning a foreground command is running) and (BA)
 * "background-running" (the SAME blue, meaning the agent's turn ended but a
 * cloud/background session is still running). NOT PaneStatuses — they live on
 * separate axes in the v2-notifications store and are merged in with agent
 * status taking precedence. Widening the prop to this is non-breaking: every
 * ActivePaneStatus is still a DisplayStatus.
 */
export type DisplayStatus =
	| ActivePaneStatus
	| "shell-running"
	| "background-running";

/** Lookup object for status indicator styling - avoids if/else chains */
const STATUS_CONFIG = {
	permission: {
		pingColor: "bg-red-400",
		dotColor: "bg-red-500",
		pulse: true,
		tooltip: "Needs input",
	},
	failed: {
		pingColor: "bg-red-400",
		dotColor: "bg-red-500",
		pulse: true,
		tooltip: "Agent failed",
	},
	working: {
		pingColor: "bg-amber-400",
		dotColor: "bg-amber-500",
		pulse: true,
		tooltip: "Agent working",
	},
	review: {
		pingColor: "",
		dotColor: "bg-green-500",
		pulse: false,
		tooltip: "Ready for review",
	},
	// (AY) shell-running: a foreground command is running in the terminal.
	"shell-running": {
		pingColor: "bg-blue-400",
		dotColor: "bg-blue-500",
		pulse: true,
		tooltip: "Command running",
	},
	// (BA) background-running: the turn ended but a cloud/background session is
	// still running. Same blue as shell-running; distinct tooltip.
	"background-running": {
		pingColor: "bg-blue-400",
		dotColor: "bg-blue-500",
		pulse: true,
		tooltip: "Cloud session running",
	},
} as const satisfies Record<
	DisplayStatus,
	{ pingColor: string; dotColor: string; pulse: boolean; tooltip: string }
>;

interface StatusIndicatorProps {
	status: DisplayStatus;
	className?: string;
}

/**
 * Visual indicator for pane/workspace status.
 * - Red pulsing: needs user input (permission)
 * - Amber pulsing: agent working
 * - Green static: ready for review
 */
export function StatusIndicator({ status, className }: StatusIndicatorProps) {
	const config = STATUS_CONFIG[status];

	return (
		<span className={cn("relative flex size-2 shrink-0", className)}>
			{config.pulse && (
				<span
					className={cn(
						"absolute inline-flex h-full w-full animate-ping rounded-full opacity-75",
						config.pingColor,
					)}
				/>
			)}
			<span
				className={cn(
					"relative inline-flex size-2 rounded-full",
					config.dotColor,
				)}
			/>
		</span>
	);
}

/** Get tooltip text for a status - for consumers that wrap with Tooltip */
export function getStatusTooltip(status: DisplayStatus): string {
	return STATUS_CONFIG[status].tooltip;
}
