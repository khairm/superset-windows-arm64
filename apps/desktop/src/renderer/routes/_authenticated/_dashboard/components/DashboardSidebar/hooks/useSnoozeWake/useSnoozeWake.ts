import {
	useCallback,
	useLayoutEffect,
	useRef,
	useSyncExternalStore,
} from "react";
import { snoozeTicker } from "renderer/lib/shared-ticker";
import {
	hasDueSnooze,
	hasTimedSnooze,
} from "../useDashboardSidebarData/hasDueSnooze";

const noop = () => () => {};

// (SNOOZE-WAKE-TICK) subscribe is keyed on `timed` only: a rows-keyed identity
// would resubscribe on every row change and restart the shared interval's phase.
export function useSnoozeWake(
	rows: readonly { snoozeUntil?: number | null }[],
): number {
	const rowsRef = useRef(rows);
	useLayoutEffect(() => {
		rowsRef.current = rows;
	});
	const epochRef = useRef(0);
	const timed = hasTimedSnooze(rows);
	const subscribe = useCallback(
		(onChange: () => void) =>
			timed
				? snoozeTicker.subscribe(() => {
						if (hasDueSnooze(rowsRef.current, Date.now())) {
							epochRef.current += 1;
							onChange();
						}
					})
				: noop(),
		[timed],
	);
	return useSyncExternalStore(subscribe, () => epochRef.current);
}
