import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { cn } from "@superset/ui/utils";
import { useEffect, useState } from "react";
import { LuWifiOff } from "react-icons/lu";
import {
	selectEarliestNotificationBusDisconnect,
	useNotificationBusStatusStore,
} from "renderer/stores/notification-bus";

/**
 * (BUS-RESYNC) How long the bus may be down before we say so. Ordinary
 * reconnects finish inside partysocket's 1-30s backoff, and a pill that
 * flickers on every blip is noise; a pill that never appears is how a bus stays
 * dead for hours without anyone noticing.
 */
const DISCONNECTED_GRACE_MS = 15_000;

/**
 * (BUS-RESYNC) Visible state for "agent notifications are not arriving".
 *
 * The dots are driven entirely by host-service events over WebSockets — one per
 * host, and a window commonly holds several: the local host plus a relay socket
 * for every off-machine host in the sidebar. When any of them is down the dots
 * for its workspaces are silently frozen, rendering whatever they last heard,
 * which is indistinguishable from "nothing is happening". This says which one
 * it is: it appears when ANY bus the notification controller subscribes to has
 * been down past the grace window, and disappears when they are all back — the
 * reconnect itself resyncs the dots.
 */
export function NotificationBusPill({
	isCollapsed = false,
}: {
	isCollapsed?: boolean;
}) {
	const disconnectedSince = useNotificationBusStatusStore(
		selectEarliestNotificationBusDisconnect,
	);
	const [visible, setVisible] = useState(false);

	useEffect(() => {
		if (disconnectedSince === null) {
			setVisible(false);
			return;
		}
		// Grace runs from when that bus went down, not from this render: a bus
		// already down for an hour when the sidebar mounts must show immediately.
		const remaining = disconnectedSince + DISCONNECTED_GRACE_MS - Date.now();
		if (remaining <= 0) {
			setVisible(true);
			return;
		}
		setVisible(false);
		const timer = setTimeout(() => setVisible(true), remaining);
		return () => clearTimeout(timer);
	}, [disconnectedSince]);

	if (!visible) return null;

	const tooltip =
		"Agent notifications disconnected — dots may be stale until it reconnects";

	return (
		<Tooltip delayDuration={300}>
			<TooltipTrigger asChild>
				<output
					aria-label={tooltip}
					className={cn(
						"animate-in fade-in duration-300",
						"text-amber-600 dark:text-amber-400",
						isCollapsed
							? "flex size-8 shrink-0 items-center justify-center rounded-md"
							: cn(
									"inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-1",
									"font-mono text-[10px] leading-none",
									"bg-amber-500/15 ring-1 ring-inset ring-amber-500/25",
								),
					)}
				>
					<LuWifiOff className={isCollapsed ? "size-4" : "size-3 shrink-0"} />
					{!isCollapsed && <span>offline</span>}
				</output>
			</TooltipTrigger>
			<TooltipContent side={isCollapsed ? "right" : "top"}>
				{tooltip}
			</TooltipContent>
		</Tooltip>
	);
}
