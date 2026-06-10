import type {
	SelectV2Project,
	SelectV2Workspace,
} from "@superset/db/schema";
import { useLiveQuery } from "@tanstack/react-db";
import { useEffect, useMemo, useState } from "react";
import { useCollections } from "renderer/routes/_authenticated/providers/CollectionsProvider";
import {
	APP_LAUNCH_ID,
	type DashboardSidebarProjectRow,
	getWorkspaceSidebarBucket,
	isWorkspaceSnoozed,
	type KanbanCardRow,
	type KanbanColumnRow,
	KANBAN_QUEUE_COLUMN_ID,
	KANBAN_QUEUE_TAB_ORDER,
	kanbanBoundCardId,
	type WorkspaceLocalStateRow,
} from "renderer/routes/_authenticated/providers/CollectionsProvider/dashboardSidebarLocal";
import type {
	KanbanCardBucket,
	KanbanCardView,
	KanbanColumnView,
} from "../../types";
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

function sortCards(cards: KanbanCardView[], sortMode: string): KanbanCardView[] {
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

/** Bucket for an UNBOUND (Queued) card, from its own snooze/archive fields. */
function queuedCardBucket(card: KanbanCardRow, now: number): KanbanCardBucket {
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

	// Gated tick: only run while something time-sensitive is pending (a snoozed
	// card, or any deadline that could flip yellow→red across a day boundary).
	const hasTimeSensitive = useMemo(() => {
		// Only deadlines + TIMED snoozes need the wall-clock tick. An "until next
		// launch" snooze (snoozeLaunchId) can't expire during this launch, so it
		// must NOT keep the 60s ticker alive forever.
		return (cardRows as KanbanCardRow[]).some(
			(c) => c.deadline != null || c.snoozeUntil != null,
		);
	}, [cardRows]);
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
				sortMode: "manual",
				showSnoozed: false,
				showArchived: false,
				snoozedCollapsed: false,
				archivedCollapsed: false,
				createdAt: Date.now(),
			});
		}

		// 2. Ensure ≥1 custom column (the landing column for new branches).
		const currentColumns = Array.from(
			collections.v2KanbanColumns.state.values(),
		);
		const customColumns = currentColumns
			.filter((c) => !c.isQueue && c.id !== KANBAN_QUEUE_COLUMN_ID)
			.sort((a, b) => a.tabOrder - b.tabOrder);
		let landingColumnId: string;
		if (customColumns.length === 0) {
			landingColumnId = crypto.randomUUID();
			collections.v2KanbanColumns.insert({
				id: landingColumnId,
				name: STARTER_COLUMN_NAME,
				tabOrder: 1,
				isQueue: false,
				sortMode: "manual",
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
			collections.v2KanbanCards.insert({
				id: cardId,
				columnId: landingColumnId,
				tabOrder: nextOrder++,
				title: deriveCardTitle(branch),
				description: null,
				deadline: null,
				deadlineTabOrder: null,
				workspaceId: branch.id,
				snoozeUntil: null,
				snoozeLaunchId: null,
				archivedAt: null,
				createdAt: Date.now(),
			});
		}

		// 4. Drop bound cards whose branch is gone (branch deleted → card gone).
		for (const card of Array.from(collections.v2KanbanCards.state.values())) {
			if (card.workspaceId && !workspaceById.has(card.workspaceId)) {
				collections.v2KanbanCards.delete(card.id);
			}
		}
	}, [
		isReady,
		collections,
		workspaceRows,
		workspaceById,
		localStateByWorkspace,
		sidebarProjectIds,
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
			for (const card of cardRows as KanbanCardRow[]) {
				if (card.columnId !== column.id) continue;

				let workspace: SelectV2Workspace | null = null;
				let projectName: string | null = null;
				let bucket: KanbanCardBucket;

				if (card.workspaceId) {
					workspace = workspaceById.get(card.workspaceId) ?? null;
					if (!workspace) continue; // pending cleanup — don't render a ghost
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
					bucket = wsBucket;
				} else {
					bucket = queuedCardBucket(card, now);
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
				if (bucket === "archived") archived.push(view);
				else if (bucket === "snoozed") snoozed.push(view);
				else active.push(view);
			}
			return {
				column,
				active: sortCards(active, column.sortMode),
				snoozed: sortCards(snoozed, column.sortMode),
				archived: sortCards(archived, column.sortMode),
			};
		});
	}, [
		columnRows,
		cardRows,
		workspaceById,
		projectNameById,
		localStateByWorkspace,
		sidebarProjectIds,
		now,
	]);

	return { isReady, columns, now };
}
