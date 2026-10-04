import { useSyncExternalStore } from "react";
import { noopSubscribe, snoozeTicker } from "renderer/lib/shared-ticker";
import { formatSnoozeRemaining } from "renderer/routes/_authenticated/providers/CollectionsProvider/dashboardSidebarLocal";

interface SnoozeRemainingBadgeProps {
	snoozeUntil: number | null | undefined;
	snoozeLaunchId: string | null | undefined;
}

// (SNOOZE-BADGE-LEAF) the clock is clamped below the deadline: until the data
// hook's due tick moves the row out of Snoozed, the badge shows "1m", not blank.
export function SnoozeRemainingBadge({
	snoozeUntil,
	snoozeLaunchId,
}: SnoozeRemainingBadgeProps) {
	const timed = typeof snoozeUntil === "number";
	useSyncExternalStore(
		timed ? snoozeTicker.subscribe : noopSubscribe,
		snoozeTicker.getSnapshot,
	);
	const label = formatSnoozeRemaining(
		snoozeUntil,
		snoozeLaunchId,
		timed ? Math.min(Date.now(), snoozeUntil - 1) : undefined,
	);
	if (label === "") return null;
	return (
		<span className="ml-auto shrink-0 text-[10px] tabular-nums text-amber-500/80">
			{label}
		</span>
	);
}
