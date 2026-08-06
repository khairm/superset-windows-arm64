import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { cn } from "@superset/ui/utils";
import { getEventBus } from "@superset/workspace-client";
import { useEffect, useState } from "react";
import { LuWifiOff } from "react-icons/lu";
import { getHostServiceWsToken } from "renderer/lib/host-service-auth";
import { useLocalHostService } from "renderer/routes/_authenticated/providers/LocalHostServiceProvider";

/**
 * (BUS-RESYNC) How long the bus may be down before we say so. Ordinary
 * reconnects finish inside partysocket's 1-30s backoff, and a pill that
 * flickers on every blip is noise; a pill that never appears is how a bus stays
 * dead for hours without anyone noticing.
 */
const DISCONNECTED_GRACE_MS = 15_000;

function useHostBusConnected(hostUrl: string | null): boolean {
	const [connected, setConnected] = useState(true);

	useEffect(() => {
		if (!hostUrl) {
			setConnected(true);
			return;
		}
		const bus = getEventBus(hostUrl, () => getHostServiceWsToken(hostUrl));
		setConnected(bus.isConnected());
		const removeListener = bus.onConnectionChange(setConnected);
		// Connection listeners alone don't keep the socket alive.
		const release = bus.retain();
		return () => {
			removeListener();
			release();
		};
	}, [hostUrl]);

	return connected;
}

/**
 * (BUS-RESYNC) Visible state for "agent notifications are not arriving".
 *
 * The dots are driven entirely by host-service events over one WebSocket. When
 * that socket is down the UI is silently frozen — every dot keeps rendering
 * whatever it last heard — which is indistinguishable from "nothing is
 * happening". This says which one it is. It disappears the moment the socket
 * reopens, and the reconnect itself resyncs the dots.
 */
export function NotificationBusPill({
	isCollapsed = false,
}: {
	isCollapsed?: boolean;
}) {
	const { activeHostUrl } = useLocalHostService();
	const connected = useHostBusConnected(activeHostUrl);
	const [visible, setVisible] = useState(false);

	useEffect(() => {
		if (connected) {
			setVisible(false);
			return;
		}
		const timer = setTimeout(() => setVisible(true), DISCONNECTED_GRACE_MS);
		return () => clearTimeout(timer);
	}, [connected]);

	if (!activeHostUrl || !visible) return null;

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
