/**
 * Where a deleted custom column's cards go. Cards move to the nearest custom
 * column to the LEFT; if the deleted column is the leftmost custom column, they
 * move to the next custom column on the RIGHT. Cards can never be pushed into
 * the Queued column (it is unbound-only), and the board always keeps at least
 * one custom column, so deleting the only custom column is blocked.
 *
 * @param orderedCustomColumnIds custom (non-Queue) column ids, left→right.
 */
export function getColumnDeleteTarget(
	orderedCustomColumnIds: readonly string[],
	columnId: string,
): { allowed: boolean; targetColumnId: string | null } {
	const idx = orderedCustomColumnIds.indexOf(columnId);
	if (idx === -1) return { allowed: false, targetColumnId: null };
	// Last remaining custom column — block (new branches need a landing column).
	if (orderedCustomColumnIds.length <= 1) {
		return { allowed: false, targetColumnId: null };
	}
	const left = idx > 0 ? orderedCustomColumnIds[idx - 1] : null;
	const right =
		idx < orderedCustomColumnIds.length - 1
			? orderedCustomColumnIds[idx + 1]
			: null;
	return { allowed: true, targetColumnId: left ?? right };
}
