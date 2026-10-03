import { cn } from "@superset/ui/utils";
import { useSyncExternalStore } from "react";
import { redPingTicker } from "renderer/lib/shared-ticker";

interface RedPingProps {
	className?: string;
}

export function RedPing({ className }: RedPingProps) {
	const epoch = useSyncExternalStore(
		redPingTicker.subscribe,
		redPingTicker.getSnapshot,
	);

	return (
		<span
			key={epoch}
			className={cn(
				"absolute inline-flex h-full w-full animate-ping-finite rounded-full opacity-75",
				className,
			)}
		/>
	);
}
