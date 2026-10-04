import {
	useCallback,
	useLayoutEffect,
	useMemo,
	useRef,
	useSyncExternalStore,
} from "react";
import { noopSubscribe, snoozeTicker } from "renderer/lib/shared-ticker";
import { isSnoozeDue } from "renderer/routes/_authenticated/providers/CollectionsProvider/dashboardSidebarLocal";

// (SNOOZE-WAKE-TICK) subscribe is keyed on `timed` only: a rows-keyed identity
// would resubscribe on every row change and restart the shared interval's phase.
export function useSnoozeWake(
	rows: readonly { snoozeUntil?: number | null }[],
): number {
	const rowsRef = useRef(rows);
	useLayoutEffect(() => {
		rowsRef.current = rows;
	}, [rows]);
	const epochRef = useRef(0);
	const timed = useMemo(
		() => rows.some((r) => typeof r.snoozeUntil === "number"),
		[rows],
	);
	const subscribe = useCallback(
		(onChange: () => void) =>
			timed
				? snoozeTicker.subscribe(() => {
						if (rowsRef.current.some((r) => isSnoozeDue(r, Date.now()))) {
							epochRef.current += 1;
							onChange();
						}
					})
				: noopSubscribe(),
		[timed],
	);
	return useSyncExternalStore(subscribe, () => epochRef.current);
}
