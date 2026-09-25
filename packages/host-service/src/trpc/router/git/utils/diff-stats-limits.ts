// (DIFFSTATS-COLD-CACHE)
import { MAX_UNTRACKED_STAT_FILES } from "./git-status";

/** Upper bound for one getDiffStatsByWorkspaces call — a page's host rarely
 * has more than a few dozen workspaces; anything larger is a runaway caller. */
export const MAX_DIFF_STATS_BATCH = 500;

/** Several dashboard targets (one per organization/machine pair) poll the same
 * host in the same window, so the cold cache holds more than one batch's keys
 * or every key is evicted before the poll that would read it. */
export const MAX_COLD_ENTRIES = 4 * MAX_DIFF_STATS_BATCH;

/** A cold entry pins every ChangedFile of its walk for the whole TTL, and one
 * long branch carries thousands, so retention is budgeted in files as well as
 * in entries. Sized so a board's worth of workspaces each at the per-walk
 * untracked cap still fit; a flat entry budget that a few large branches
 * exhaust is a silent hit-rate cliff. */
export const MAX_COLD_RETAINED_FILES = 40 * MAX_UNTRACKED_STAT_FILES;
