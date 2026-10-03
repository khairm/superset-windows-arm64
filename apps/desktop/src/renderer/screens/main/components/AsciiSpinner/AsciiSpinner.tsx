import { cn } from "@superset/ui/utils";
import { useSyncExternalStore } from "react";
import { spinnerTicker } from "renderer/lib/shared-ticker";

/** Braille-based spinner frames for a smooth animation */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

interface AsciiSpinnerProps {
	className?: string;
}

/**
 * ASCII spinner using braille characters.
 * Replaces the folder icon when an agent is working.
 */
export function AsciiSpinner({ className }: AsciiSpinnerProps) {
	const epoch = useSyncExternalStore(
		spinnerTicker.subscribe,
		spinnerTicker.getSnapshot,
	);

	return (
		<span
			className={cn("text-amber-500 font-mono select-none", className)}
			aria-hidden="true"
		>
			{SPINNER_FRAMES[epoch % SPINNER_FRAMES.length]}
		</span>
	);
}
