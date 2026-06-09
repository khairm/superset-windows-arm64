import { useKanbanData } from "../../kanban/hooks/useKanbanData";
import { useKanbanBackup } from "./useKanbanBackup";

/**
 * (KANBAN) Runs the board's ready-gated reconcile (materialise a card per
 * branch, seed Queue + a starter column, drop deleted-branch cards, auto-
 * unsnooze queued cards) at the DASHBOARD level — not only when the /kanban
 * route is mounted. This guarantees a branch's bound card row exists even when
 * the user opens a workspace directly, so the right-panel "Card" tab is never
 * stuck on the empty state. Renders nothing.
 */
export function KanbanReconciler() {
	useKanbanData();
	// (KANBAN BACKUP) append-only daily snapshot; see useKanbanBackup.
	useKanbanBackup();
	return null;
}
