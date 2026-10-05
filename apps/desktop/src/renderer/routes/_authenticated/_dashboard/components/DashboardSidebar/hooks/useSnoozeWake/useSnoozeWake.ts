import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { noopSubscribe, snoozeTicker } from "renderer/lib/shared-ticker";
import { isSnoozeDue } from "renderer/routes/_authenticated/providers/CollectionsProvider/dashboardSidebarLocal";

// (SNOOZE-WAKE-TICK) subscribe changes identity only when `timed` flips: a
// rows-keyed identity would resubscribe on every row change and restart the
// shared interval's phase.
export function useSnoozeWake(
	rows: readonly { snoozeUntil?: number | null }[],
): number {
	const rowsRef = useRef(rows);
	useLayoutEffect(() => {
		rowsRef.current = rows;
	}, [rows]);
	const epochRef = useRef(0);
	const [subscribeTimed] = useState(
		() => (onChange: () => void) =>
			snoozeTicker.subscribe(() => {
				if (rowsRef.current.some((r) => isSnoozeDue(r, Date.now()))) {
					epochRef.current += 1;
					onChange();
				}
			}),
	);
	const timed = rows.some((r) => typeof r.snoozeUntil === "number");
	return useSyncExternalStore(
		timed ? subscribeTimed : noopSubscribe,
		() => epochRef.current,
	);
}
