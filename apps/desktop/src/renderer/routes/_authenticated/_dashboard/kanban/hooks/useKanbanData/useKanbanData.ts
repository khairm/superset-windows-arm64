import type { SelectV2Project, SelectV2Workspace } from "@superset/db/schema";
import { useLiveQuery } from "@tanstack/react-db";
import { useEffect, useMemo, useState } from "react";
import { useRecycleBinRetention } from "renderer/routes/_authenticated/_dashboard/stores/recycleBinRetention";
import { useCollections } from "renderer/routes/_authenticated/providers/CollectionsProvider";
import {
	APP_LAUNCH_ID,
	type DashboardSidebarProjectRow,
	getWorkspaceSidebarBucket,
	isWithinRecycleBinWindow,
	isWorkspaceSnoozed,
	KANBAN_COMPLETED_COLUMN_ID,
	KANBAN_COMPLETED_TAB_ORDER,
	KANBAN_QUEUE_COLUMN_ID,
	KANBAN_QUEUE_TAB_ORDER,
	type KanbanCardRow,
	type KanbanColumnRow,
	kanbanBoundCardId,
	type WorkspaceLocalStateRow,
} from "renderer/routes/_authenticated/providers/CollectionsProvider/dashboardSidebarLocal";
import type {
	KanbanCardBucket,
	KanbanCardView,
	KanbanColumnView,
} from "../../types";
import {
	buildCompletedContext,
	getCompletedFilterRange,
	isWithinCompletedRange,
} from "../../utils/completedFilter";
import { deadlineGroupKey } from "../../utils/deadlineUrgency";
import { deriveCardTitle } from "../../utils/deriveCardTitle";

const TICK_INTERVAL_MS = 60_000;
const STARTER_COLUMN_NAME = "In Progress";

// (DEADLINE-TIE-ORDER) Within a deadline tie group (same due day, or the
// no-deadline tail): cards the user explicitly drag-ordered in deadline mode
// (deadlineTabOrder set) come first in that order; never-ordered cards (new
// arrivals, changed deadlines, column moves) follow underneath in manual
// tabOrder. The manual order itself is never touched from deadline mode.
function deadlineTieBreak(a: KanbanCardView, b: KanbanCardView): number {
	const oa = a.card.deadlineTabOrder;
	const ob = b.card.deadlineTabOrder;
	if (oa != null && ob != null) {
		return oa - ob || a.card.tabOrder - b.card.tabOrder;
	}
	if (oa != null) return -1;
	if (ob != null) return 1;
	return a.card.tabOrder - b.card.tabOrder;
}

// (KANBAN COMPLETED) The Completed column ignores sortMode entirely: most
// recently completed first (ties by manual tabOrder). Intra-column drags are
// no-ops there, so there is no manual order to preserve.
function sortCompletedCards(cards: KanbanCardView[]): KanbanCardView[] {
	return [...cards].sort(
		(a, b) =>
			(b.card.completedAt ?? 0) - (a.card.completedAt ?? 0) ||
			a.card.tabOrder - b.card.tabOrder,
	);
}

function sortCards(
	cards: KanbanCardView[],
	sortMode: string,
): KanbanCardView[] {
	const next = [...cards];
	if (sortMode === "deadline") {
		// Display-only: soonest due DAY first (deadlineGroupKey — the same group
		// identity the board's drag handler uses), no-deadline last; within a tie
		// group the deadline-mode drag order wins (see deadlineTieBreak) and the
		// manual tabOrder is preserved untouched underneath.
		next.sort((a, b) => {
			const ka = deadlineGroupKey(a.card.deadline);
			const kb = deadlineGroupKey(b.card.deadline);
			if (ka == null && kb == null) return deadlineTieBreak(a, b);
			if (ka == null) return 1;
			if (kb == null) return -1;
			return ka - kb || deadlineTieBreak(a, b);
		});
	} else {
		next.sort((a, b) => a.card.tabOrder - b.card.tabOrder);
	}
	return next;
}

/** Bucket for an UNBOUND (Queued) card, from its own delete/snooze/archive
 * fields. (RECYCLE-BIN) deletedAt wins first — a soft-deleted card shows ONLY in
 * the bin, mirroring getWorkspaceSidebarBucket's deleted-first precedence. */
function queuedCardBucket(card: KanbanCardRow, now: number): KanbanCardBucket {
	if (card.deletedAt != null) return "deleted";
	if (card.archivedAt != null) return "archived";
	if (isWorkspaceSnoozed(card, now)) return "snoozed";
	return "active";
}

export interface UseKanbanDataResult {
	isReady: boolean;
	columns: KanbanColumnView[];
	now: number;
}

/**
 * The board's read model + reconcile. Live-queries the local Kanban collections
 * joined against branches (v2Workspaces) and projects, materialises one card per
 * branch and drops cards for deleted branches (ready-gated, per AGENTS rule 9),
 * and classifies every card into active / snoozed / archived. Also owns a gated
 * 60s tick that auto-unsnoozes expired Queued cards (bound cards are handled by
 * the sidebar's own ticker).
 */
export function useKanbanData(): UseKanbanDataResult {
	const collections = useCollections();

	const { data: columnRows = [], isReady: columnsReady } = useLiveQuery(
		(q) => q.from({ c: collections.v2KanbanColumns }),
		[collections],
	);
	const { data: cardRows = [], isReady: cardsReady } = useLiveQuery(
		(q) => q.from({ c: collections.v2KanbanCards }),
		[collections],
	);
	const { data: workspaceRows = [], isReady: workspacesReady } = useLiveQuery(
		(q) => q.from({ w: collections.v2Workspaces }),
		[collections],
	);
	const { data: projectRows = [] } = useLiveQuery(
		(q) => q.from({ p: collections.v2Projects }),
		[collections],
	);
	const { data: localStateRows = [], isReady: localStateReady } = useLiveQuery(
		(q) => q.from({ s: collections.v2WorkspaceLocalState }),
		[collections],
	);
	const { data: sidebarProjectRows = [], isReady: sidebarProjectsReady } =
		useLiveQuery(
			(q) => q.from({ sp: collections.v2SidebarProjects }),
			[collections],
		);

	const isReady =
		columnsReady &&
		cardsReady &&
		workspacesReady &&
		localStateReady &&
		sidebarProjectsReady;

	const [now, setNow] = useState(() => Date.now());

	// (RECYCLE-BIN) The device-local retention window is a DISPLAY filter for the
	// per-column bin: cards deleted within the last N days show by default; older
	// ones collapse behind the section's "Show all" toggle. Nothing is purged.
	const retentionDays = useRecycleBinRetention((s) => s.retentionDays);

	// Gated tick: only run while something time-sensitive is pending (a snoozed
	// card, or any deadline that could flip yellow→red across a day boundary).
	const hasTimeSensitive = useMemo(() => {
		// Only deadlines + TIMED snoozes need the wall-clock tick. An "until next
		// launch" snooze (snoozeLaunchId) can't expire during this launch, so it
		// must NOT keep the 60s ticker alive forever. (KANBAN COMPLETED) an
		// active "Last month" filter is also wall-clock-relative — its range
		// flips at a month boundary, so it keeps the tick alive too ("custom"
		// ranges are static and "all" filters nothing).
		return (
			(cardRows as KanbanCardRow[]).some(
				// (RECYCLE-BIN) a soft-deleted UNBOUND card's deletedAt is wall-clock-
				// relative too: it crosses the retention boundary into recycleBinHidden
				// without a tick. Keep the ticker alive while any bin item exists.
				(c) =>
					c.deadline != null || c.snoozeUntil != null || c.deletedAt != null,
			) ||
			// (RECYCLE-BIN) a soft-deleted BOUND card carries its deletedAt on the
			// branch's local state, not the card — gate on that too.
			(localStateRows as WorkspaceLocalStateRow[]).some(
				(s) => s.sidebarState.deletedAt != null,
			) ||
			(columnRows as KanbanColumnRow[]).some(
				(c) => c.isCompleted && c.completedFilter === "last-month",
			)
		);
	}, [cardRows, columnRows, localStateRows]);
	useEffect(() => {
		if (!hasTimeSensitive) return;
		const id = setInterval(() => setNow(Date.now()), TICK_INTERVAL_MS);
		return () => clearInterval(id);
	}, [hasTimeSensitive]);

	const workspaceById = useMemo(() => {
		const map = new Map<string, SelectV2Workspace>();
		for (const w of workspaceRows as SelectV2Workspace[]) map.set(w.id, w);
		return map;
	}, [workspaceRows]);

	const projectNameById = useMemo(() => {
		const map = new Map<string, string>();
		for (const p of projectRows as SelectV2Project[]) map.set(p.id, p.name);
		return map;
	}, [projectRows]);

	const localStateByWorkspace = useMemo(() => {
		const map = new Map<string, WorkspaceLocalStateRow>();
		for (const s of localStateRows as WorkspaceLocalStateRow[]) {
			map.set(s.workspaceId, s);
		}
		return map;
	}, [localStateRows]);

	// Project-level sidebar membership. "Remove project from sidebar" deletes
	// the v2SidebarProjects row AND the project's per-workspace local state, so
	// the per-workspace bucket check alone can't see the removal (empty state
	// buckets "active"). A project absent from the left bar must not surface on
	// the board either.
	const sidebarProjectIds = useMemo(() => {
		const set = new Set<string>();
		for (const sp of sidebarProjectRows as DashboardSidebarProjectRow[]) {
			set.add(sp.projectId);
		}
		return set;
	}, [sidebarProjectRows]);

	// --- Reconcile (ready-gated; idempotent via get-before-write) -------------
	// biome-ignore lint/correctness/useExhaustiveDependencies: columnRows/cardRows are deliberate re-run triggers — the reconcile reads the collections' state imperatively, so it must re-fire when rows change.
	useEffect(() => {
		if (!isReady) return;

		// 1. Seed the fixed Queued column.
		if (!collections.v2KanbanColumns.get(KANBAN_QUEUE_COLUMN_ID)) {
			collections.v2KanbanColumns.insert({
				id: KANBAN_QUEUE_COLUMN_ID,
				name: "Queued",
				tabOrder: KANBAN_QUEUE_TAB_ORDER,
				isQueue: true,
				isCompleted: false,
				sortMode: "manual",
				completedFilter: "all",
				completedFilterFrom: null,
				completedFilterTo: null,
				showSnoozed: false,
				showArchived: false,
				snoozedCollapsed: false,
				archivedCollapsed: false,
				createdAt: Date.now(),
			});
		}

		// 1b. Seed the fixed FINAL Completed column (KANBAN COMPLETED).
		if (!collections.v2KanbanColumns.get(KANBAN_COMPLETED_COLUMN_ID)) {
			collections.v2KanbanColumns.insert({
				id: KANBAN_COMPLETED_COLUMN_ID,
				name: "Completed",
				tabOrder: KANBAN_COMPLETED_TAB_ORDER,
				isQueue: false,
				isCompleted: true,
				sortMode: "manual",
				completedFilter: "all",
				completedFilterFrom: null,
				completedFilterTo: null,
				showSnoozed: false,
				showArchived: false,
				snoozedCollapsed: false,
				archivedCollapsed: false,
				createdAt: Date.now(),
			});
		}

		// 2. Ensure ≥1 custom column (the landing column for new branches).
		// Completed is excluded EXACTLY like the Queue: were it a landing
		// candidate, a board with no custom columns would auto-complete every
		// newly-materialised branch.
		const currentColumns = Array.from(
			collections.v2KanbanColumns.state.values(),
		);
		const customColumns = currentColumns
			.filter(
				(c) =>
					!c.isQueue &&
					c.id !== KANBAN_QUEUE_COLUMN_ID &&
					!c.isCompleted &&
					c.id !== KANBAN_COMPLETED_COLUMN_ID,
			)
			.sort((a, b) => a.tabOrder - b.tabOrder);
		let landingColumnId: string;
		if (customColumns.length === 0) {
			landingColumnId = crypto.randomUUID();
			collections.v2KanbanColumns.insert({
				id: landingColumnId,
				name: STARTER_COLUMN_NAME,
				tabOrder: 1,
				isQueue: false,
				isCompleted: false,
				sortMode: "manual",
				completedFilter: "all",
				completedFilterFrom: null,
				completedFilterTo: null,
				showSnoozed: false,
				showArchived: false,
				snoozedCollapsed: false,
				archivedCollapsed: false,
				createdAt: Date.now(),
			});
		} else {
			landingColumnId = customColumns[0].id;
		}

		// 3. Materialise a card for every non-hidden branch lacking one.
		const existingCards = Array.from(collections.v2KanbanCards.state.values());
		// Defensive dup-guard: a branch is "covered" if ANY card already points at
		// it (not just the deterministic id), so we never create a second card.
		const coveredWorkspaceIds = new Set(
			existingCards
				.map((c) => c.workspaceId)
				.filter((id): id is string => id != null),
		);
		let nextOrder =
			existingCards
				.filter((c) => c.columnId === landingColumnId)
				.reduce((max, c) => Math.max(max, c.tabOrder), 0) + 1;
		for (const branch of workspaceRows as SelectV2Workspace[]) {
			// Project removed from the sidebar → none of its branches get cards.
			if (!sidebarProjectIds.has(branch.projectId)) continue;
			const local = localStateByWorkspace.get(branch.id);
			const bucket = getWorkspaceSidebarBucket(
				local?.sidebarState ?? {},
				Date.now(),
				branch.type,
			);
			// A removed-from-sidebar (hidden, non-archived) branch is not
			// representable on the board either.
			if (bucket === "hidden") continue;
			const cardId = kanbanBoundCardId(branch.id);
			if (collections.v2KanbanCards.get(cardId)) continue;
			if (coveredWorkspaceIds.has(branch.id)) continue;
			// (KANBAN COMPLETED) a completed branch whose card was lost (e.g. a
			// cleared cards blob) re-materialises INTO the Completed column with
			// its sidebar stamp as the date — never into the landing column.
			const isCompletedBranch = bucket === "completed";
			collections.v2KanbanCards.insert({
				id: cardId,
				columnId: isCompletedBranch
					? KANBAN_COMPLETED_COLUMN_ID
					: landingColumnId,
				tabOrder: isCompletedBranch ? 0 : nextOrder++,
				title: deriveCardTitle(branch),
				description: null,
				deadline: null,
				deadlineTabOrder: null,
				workspaceId: branch.id,
				snoozeUntil: null,
				snoozeLaunchId: null,
				archivedAt: null,
				completedAt: isCompletedBranch
					? (local?.sidebarState.completedAt ?? Date.now())
					: null,
				completedContext: isCompletedBranch
					? buildCompletedContext(
							projectNameById.get(branch.projectId) ?? null,
							branch.branch,
						)
					: null,
				createdAt: Date.now(),
			});
		}

		// 4. Drop bound cards whose branch is gone (branch deleted → card gone) —
		// EXCEPT completed cards: those survive as FROZEN records (title +
		// completedContext snapshot) so deleting a merged branch never erases the
		// work from the user's completed-history reports. workspaceId stays set,
		// so a transiently-missing workspace row re-binds with no duplicate.
		for (const card of Array.from(collections.v2KanbanCards.state.values())) {
			if (card.workspaceId && !workspaceById.has(card.workspaceId)) {
				if (card.columnId === KANBAN_COMPLETED_COLUMN_ID) continue;
				collections.v2KanbanCards.delete(card.id);
			}
		}

		// 5. Heal the two-writer pair (KANBAN COMPLETED). Card placement is the
		// single intent signal — complete/uncomplete write the card transaction
		// FIRST, so a crash between the two transactions always converges toward
		// the card's column here:
		//   (a) card in Completed but branch not completed → re-stamp the branch
		//   (b) branch completed but card elsewhere → clear the branch
		for (const card of Array.from(collections.v2KanbanCards.state.values())) {
			if (!card.workspaceId) continue;
			const ws = workspaceById.get(card.workspaceId);
			if (!ws) continue; // frozen record (or pending prune) — nothing to heal
			// While a project is removed from the sidebar its local-state rows are
			// deliberately deleted — don't resurrect them from here.
			if (!sidebarProjectIds.has(ws.projectId)) continue;
			const local = localStateByWorkspace.get(card.workspaceId);
			const bucket = getWorkspaceSidebarBucket(
				local?.sidebarState ?? {},
				Date.now(),
				ws.type,
			);
			const inCompleted = card.columnId === KANBAN_COMPLETED_COLUMN_ID;
			if (
				inCompleted &&
				bucket !== "completed" &&
				bucket !== "hidden" &&
				ws.type !== "main"
			) {
				const completedAt = card.completedAt ?? Date.now();
				// Decide insert-vs-update from the LIVE collection state, not the
				// render snapshot (`local`): useKanbanData runs in two instances
				// (the dashboard-level KanbanReconciler AND the mounted board), and
				// both can see a stale "no row" in the same commit cycle — the
				// second insert would throw a duplicate-key error. The live
				// get-before-write makes the second instance update instead.
				if (collections.v2WorkspaceLocalState.get(card.workspaceId)) {
					collections.v2WorkspaceLocalState.update(
						card.workspaceId,
						(draft) => {
							draft.sidebarState.completedAt = completedAt;
							draft.sidebarState.isHidden = true;
							draft.sidebarState.archivedAt = null;
							draft.sidebarState.snoozeUntil = null;
							draft.sidebarState.snoozeLaunchId = null;
						},
					);
				} else {
					// No local-state row (e.g. the project was just re-added to the
					// sidebar): the completion must be re-asserted via INSERT or the
					// branch would resurface in the active lane while its card sits in
					// Completed. Same minimal row hideWorkspaceInSidebar seeds.
					collections.v2WorkspaceLocalState.insert({
						workspaceId: card.workspaceId,
						createdAt: new Date(),
						sidebarState: {
							projectId: ws.projectId,
							tabOrder: 0,
							sectionId: null,
							isHidden: true,
							completedAt,
						},
						paneLayout: { version: 1, tabs: [], activeTabId: null },
					});
				}
				if (card.completedAt == null) {
					// Backfill the report datum from the stamp we just asserted.
					collections.v2KanbanCards.update(card.id, (draft) => {
						draft.completedAt = completedAt;
					});
				}
			} else if (
				inCompleted &&
				bucket === "completed" &&
				card.completedAt == null
			) {
				// Card transaction landed without its date (crash mid-complete):
				// backfill from the sidebar stamp.
				const stamp = local?.sidebarState.completedAt ?? Date.now();
				collections.v2KanbanCards.update(card.id, (draft) => {
					draft.completedAt = stamp;
				});
			} else if (!inCompleted && bucket === "completed") {
				if (collections.v2WorkspaceLocalState.get(card.workspaceId)) {
					collections.v2WorkspaceLocalState.update(
						card.workspaceId,
						(draft) => {
							draft.sidebarState.completedAt = null;
							draft.sidebarState.isHidden = false;
							draft.sidebarState.archivedAt = null;
						},
					);
				}
			}
		}
	}, [
		isReady,
		collections,
		workspaceRows,
		workspaceById,
		localStateByWorkspace,
		sidebarProjectIds,
		projectNameById,
		columnRows,
		cardRows,
	]);

	// --- Auto-unsnooze expired QUEUED cards (mirrors the sidebar ticker) -------
	useEffect(() => {
		if (!isReady) return;
		for (const card of cardRows as KanbanCardRow[]) {
			if (card.workspaceId) continue; // bound cards: sidebar ticker handles it
			const expiredTimed =
				typeof card.snoozeUntil === "number" && card.snoozeUntil <= now;
			const staleLaunch =
				card.snoozeLaunchId != null && card.snoozeLaunchId !== APP_LAUNCH_ID;
			if (expiredTimed || staleLaunch) {
				if (!collections.v2KanbanCards.get(card.id)) continue;
				collections.v2KanbanCards.update(card.id, (draft) => {
					draft.snoozeUntil = null;
					draft.snoozeLaunchId = null;
				});
			}
		}
	}, [isReady, now, cardRows, collections]);

	// --- Build the rendered column views --------------------------------------
	const columns = useMemo<KanbanColumnView[]>(() => {
		const orderedColumns = [...(columnRows as KanbanColumnRow[])].sort(
			(a, b) => a.tabOrder - b.tabOrder,
		);
		return orderedColumns.map((column) => {
			const active: KanbanCardView[] = [];
			const snoozed: KanbanCardView[] = [];
			const archived: KanbanCardView[] = [];
			// (RECYCLE-BIN) Soft-deleted cards in this column (bound branch deleted, or
			// an unbound card's deletedAt). Each carries its resolved deletedAt so the
			// retention window can split them into shown-by-default vs older-collapsed.
			const deleted: { view: KanbanCardView; deletedAt: number | null }[] = [];
			for (const card of cardRows as KanbanCardRow[]) {
				if (card.columnId !== column.id) continue;

				let workspace: SelectV2Workspace | null = null;
				let projectName: string | null = null;
				let bucket: KanbanCardBucket;
				// (RECYCLE-BIN) The deletedAt that feeds the retention window: a bound
				// card reads the branch's sidebarState (one source of truth), an unbound
				// card reads its own field. Only meaningful when bucket === "deleted".
				let deletedAt: number | null = null;

				if (card.workspaceId) {
					workspace = workspaceById.get(card.workspaceId) ?? null;
					if (!workspace) {
						// (KANBAN COMPLETED) FROZEN record: a completed card whose branch
						// was deleted renders from its title/completedContext snapshot —
						// it's a history record, so no project gate either (there is no
						// live projectId to check). Anywhere else a missing workspace is
						// just pending cleanup — don't render a ghost.
						if (card.columnId !== KANBAN_COMPLETED_COLUMN_ID) continue;
						bucket = "active";
					} else {
						// HIDE (never delete) cards of projects removed from the sidebar —
						// re-adding the project restores them with column/deadline intact.
						if (!sidebarProjectIds.has(workspace.projectId)) continue;
						projectName = projectNameById.get(workspace.projectId) ?? null;
						const local = localStateByWorkspace.get(workspace.id);
						const wsBucket = getWorkspaceSidebarBucket(
							local?.sidebarState ?? {},
							now,
							workspace.type,
						);
						if (wsBucket === "hidden") continue;
						// "completed" has no kanban section — completed cards render in
						// the Completed column's main (active) list.
						bucket = wsBucket === "completed" ? "active" : wsBucket;
						if (bucket === "deleted") {
							deletedAt = local?.sidebarState.deletedAt ?? null;
						}
					}
				} else {
					bucket = queuedCardBucket(card, now);
					if (bucket === "deleted") deletedAt = card.deletedAt;
				}

				// Bound cards take their title LIVE from the branch (same object the
				// sidebar reads — can't diverge); the stored card.title is only the
				// source for unbound (Queued) cards.
				const title = workspace ? deriveCardTitle(workspace) : card.title;
				const view: KanbanCardView = {
					card,
					workspace,
					projectName,
					bucket,
					title,
				};
				if (bucket === "deleted") deleted.push({ view, deletedAt });
				else if (bucket === "archived") archived.push(view);
				else if (bucket === "snoozed") snoozed.push(view);
				else active.push(view);
			}
			// (RECYCLE-BIN) Sort the bin deletedAt DESC (most-recently deleted first),
			// then split on the retention window: items within the last N days show by
			// default; older ones surface only via the section's "Show all" footer.
			const sortedDeleted = [...deleted].sort(
				(a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0),
			);
			const recycleBin: KanbanCardView[] = [];
			const recycleBinHidden: KanbanCardView[] = [];
			for (const entry of sortedDeleted) {
				if (isWithinRecycleBinWindow(entry.deletedAt, retentionDays, now)) {
					recycleBin.push(entry.view);
				} else {
					recycleBinHidden.push(entry.view);
				}
			}
			if (column.isCompleted) {
				// (KANBAN COMPLETED) date-sorted (latest first) + the persisted
				// completed-date filter; the filtered-out count surfaces as a footer
				// so a fresh drop "vanishing" under a narrow filter is explainable.
				const sorted = sortCompletedCards(active);
				const range = getCompletedFilterRange(column, now);
				const filtered = range
					? sorted.filter((v) =>
							isWithinCompletedRange(v.card.completedAt, range),
						)
					: sorted;
				return {
					column,
					active: filtered,
					snoozed: sortCards(snoozed, column.sortMode),
					archived: sortCards(archived, column.sortMode),
					recycleBin,
					recycleBinHidden,
					hiddenByFilter: sorted.length - filtered.length,
				};
			}
			return {
				column,
				active: sortCards(active, column.sortMode),
				snoozed: sortCards(snoozed, column.sortMode),
				archived: sortCards(archived, column.sortMode),
				recycleBin,
				recycleBinHidden,
				hiddenByFilter: 0,
			};
		});
	}, [
		columnRows,
		cardRows,
		workspaceById,
		projectNameById,
		localStateByWorkspace,
		sidebarProjectIds,
		retentionDays,
		now,
	]);

	return { isReady, columns, now };
}
