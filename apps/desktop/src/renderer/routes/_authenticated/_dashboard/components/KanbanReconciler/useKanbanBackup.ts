import { useLiveQuery } from "@tanstack/react-db";
import { useEffect, useRef } from "react";
import { authClient } from "renderer/lib/auth-client";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useCollections } from "renderer/routes/_authenticated/providers/CollectionsProvider";

const BACKUP_DEBOUNCE_MS = 10_000;
// Change-driven writes alone can skip a whole calendar day: the day's file is
// only created by the first write attempt AFTER midnight, so a day where the
// board never changes would get no snapshot. A low-frequency retry guarantees
// every day (with a non-empty board) gets one; the writer no-ops once it exists.
const BACKUP_RETRY_MS = 30 * 60_000;

/**
 * (KANBAN BACKUP) Append-only daily snapshot of the board to
 * ~/.superset/backups/kanban/<org>-<YYYY-MM-DD>.json.
 *
 * SAFETY CONTRACT (user-mandated): the entire feature — this hook and the
 * main-process writer — has NO code path that deletes or overwrites a
 * snapshot. The writer is write-once per day (no-op when today's file
 * exists) and skips empty boards, so an accidentally wiped board can never
 * become the day's snapshot. Snapshots live outside the Electron profile,
 * surviving profile corruption and reinstalls. Restore is manual by design:
 * the files are plain JSON of {columns, cards}.
 *
 * Fires on dashboard boot and (debounced) on any board change — both no-op
 * once today's snapshot exists.
 */
export function useKanbanBackup(): void {
	const collections = useCollections();
	const { data: session } = authClient.useSession();
	const organizationId = session?.session?.activeOrganizationId ?? null;
	const writeBackup = electronTrpc.window.writeKanbanBackup.useMutation();

	const { data: columns } = useLiveQuery(
		(q) => q.from({ c: collections.v2KanbanColumns }),
		[collections],
	);
	const { data: cards } = useLiveQuery(
		(q) => q.from({ c: collections.v2KanbanCards }),
		[collections],
	);

	const mutateRef = useRef(writeBackup.mutate);
	mutateRef.current = writeBackup.mutate;

	useEffect(() => {
		if (!organizationId) return;
		if (!cards || cards.length === 0) return;
		const write = () => {
			mutateRef.current({
				organizationId,
				cardCount: cards.length,
				payload: JSON.stringify(
					{
						version: 1,
						savedAt: new Date().toISOString(),
						organizationId,
						columnCount: columns?.length ?? 0,
						cardCount: cards.length,
						columns: columns ?? [],
						cards,
					},
					null,
					2,
				),
			});
		};
		const timer = setTimeout(write, BACKUP_DEBOUNCE_MS);
		const retry = setInterval(write, BACKUP_RETRY_MS);
		return () => {
			clearTimeout(timer);
			clearInterval(retry);
		};
	}, [organizationId, cards, columns]);
}
