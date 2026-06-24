import { create } from "zustand";
import { persist } from "zustand/middleware";

export const DEFAULT_RECYCLE_BIN_RETENTION_DAYS = 30;
export const RECYCLE_BIN_RETENTION_MIN = 1;
export const RECYCLE_BIN_RETENTION_MAX = 365;

/** Preset day windows offered by the settings <Select> (default 30). All sit
 * within [MIN, MAX]. */
export const RECYCLE_BIN_RETENTION_DEFAULT_OPTIONS = [
	7, 14, 30, 60, 90, 180, 365,
] as const;

/**
 * Coerce ANY input to a valid retention-day count in [MIN, MAX]. Non-number /
 * non-finite input (NaN, Infinity, a corrupt or legacy persisted value, etc.)
 * falls back to the default — a NaN here would make the retention filter hide
 * EVERY deleted item (no comparison is true against NaN), silently emptying the
 * bin from view. Used by the setter AND by persist rehydration so neither path
 * can ever store NaN.
 */
export function clampRetentionDays(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return DEFAULT_RECYCLE_BIN_RETENTION_DAYS;
	}
	return Math.max(
		RECYCLE_BIN_RETENTION_MIN,
		Math.min(RECYCLE_BIN_RETENTION_MAX, Math.round(value)),
	);
}

interface RecycleBinRetentionState {
	/** How many days back the Recycle Bin shows deleted items BY DEFAULT. This is
	 * a DISPLAY filter only — nothing is ever auto-purged; older items are kept
	 * but collapsed behind each bin's "Show all" toggle. */
	retentionDays: number;
	setRetentionDays: (days: number) => void;
}

/**
 * (RECYCLE-BIN) Device-local retention preference for the soft-delete Recycle
 * Bin. Renderer-only (localStorage via zustand persist) — no SQLite/Drizzle.
 * The value is clamped to [MIN, MAX] days and rounded. It only filters what the
 * bin DISPLAYS by default; it never deletes anything.
 */
export const useRecycleBinRetention = create<RecycleBinRetentionState>()(
	persist(
		(set) => ({
			retentionDays: DEFAULT_RECYCLE_BIN_RETENTION_DAYS,
			setRetentionDays: (days) =>
				set({ retentionDays: clampRetentionDays(days) }),
		}),
		{
			name: "recycle-bin-retention",
			// Persisted hydration bypasses setRetentionDays, so re-clamp here too:
			// a corrupt/legacy stored value (string, NaN, out-of-range) can never
			// reach the store as-is and blank the bin.
			merge: (persisted, current) => ({
				...current,
				...(persisted as Partial<RecycleBinRetentionState>),
				retentionDays: clampRetentionDays(
					(persisted as Partial<RecycleBinRetentionState> | undefined)
						?.retentionDays,
				),
			}),
		},
	),
);
