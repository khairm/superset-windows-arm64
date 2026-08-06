/**
 * (SIDEBAR-MIRROR) The write door for the desktop sidebar's curation mirror.
 *
 * THE PROBLEM THIS SOLVES. Sidebar membership, project placement, soft-delete,
 * archive, snooze, complete, hide, pin and manual order are decisions the user
 * makes, and every one of them is stored in renderer `localStorage`
 * collections (`v2WorkspaceLocalState`, `v2SidebarProjects`) that no other
 * process can read. `host.db` — the thing anything OUTSIDE the renderer reads
 * when it wants to know what the user is working on — has no column for any of
 * it. So a consumer built on `host.db` does not see "the sidebar plus some
 * cruft": it sees a structurally different, strictly larger set, in which a
 * thread the user binned last month is indistinguishable from one they are
 * blocked on right now.
 *
 * WHY A FULL REPLACE AND NOT DELTAS. There is no single choke point for
 * curation: threads are hidden from a context menu, binned from a bulk action,
 * snoozed from a submenu, completed from a kanban drag, reordered by dragging,
 * placed by a CLI-created worktree reconciler. A delta API would need every one
 * of those call sites to remember to emit, and the failure mode of forgetting
 * one is silent and permanent. `sync` instead takes the WHOLE current snapshot
 * and replaces the mirror with it, so the renderer only has to notice that
 * *something* changed. Any missed write self-heals on the next one, and the
 * first sync after a restart repairs an arbitrarily stale mirror.
 *
 * THE RENDERER IS THE SOURCE OF TRUTH — always. Nothing in the host-service
 * writes these tables, and no consumer may treat the mirror as authoritative
 * against the renderer. It is a projection with a fixed failure direction: when
 * a row is ABSENT, consumers must fall back to SHOWING it. Staleness is not the
 * same thing and is not automatically safe — a stale row's hiding fields hide a
 * thread that is no longer hidden — which is why the writer serializes its
 * pushes and never stops retrying; see `db/schema.ts` and
 * `useSidebarMirrorSync`. It is also the reason this router has no "delete one
 * workspace" verb — a partial write is exactly the state that could hide
 * something live.
 *
 * IT IS ALSO NOT A READ SURFACE FOR THE PHONE. The companion bridge reads
 * `host.db` directly through its own connection; it never calls tRPC. `state`
 * below exists so a human (or a probe) can ask whether the mirror is being
 * filled at all, which is otherwise only answerable by opening the database.
 */

import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { publishCompanionMirrorChanged } from "../../../companion/registry";
import type { HostDb } from "../../../db";
import {
	sidebarMirrorMeta,
	sidebarProjectState,
	sidebarWorkspaceState,
} from "../../../db/schema";
import { protectedProcedure, queryProcedure, router } from "../../index";

/**
 * Hard bounds on one snapshot. A real sidebar is tens of projects and a few
 * hundred workspaces; these are two orders of magnitude above that, so hitting
 * one means the caller is not sending a sidebar. Rejecting the whole payload is
 * deliberate — a truncated snapshot would be indistinguishable from a curated
 * one, and the mirror would then be quietly wrong instead of loudly absent.
 */
const MAX_MIRROR_WORKSPACES = 10_000;
const MAX_MIRROR_PROJECTS = 2_000;

/**
 * Ids are bounded non-empty strings, NOT uuids, on purpose. The renderer's own
 * zod already types them as uuids; re-asserting that here would mean one
 * corrupt localStorage row — the kind the read-time heal is there to tolerate —
 * rejects the entire snapshot on every sync from then on, freezing the mirror
 * permanently. An id that matches nothing in `host.db` is inert; an id that is
 * empty or a megabyte long is a caller bug, and that is what this catches.
 */
const mirrorId = z.string().min(1).max(200);

/** Epoch-ms stamps. Negative time is never a real curation timestamp. */
const epochMs = z.number().int().min(0);

const workspaceStateInput = z.object({
	workspaceId: mirrorId,
	/** The project this thread is PLACED under — the renderer's own value. */
	projectId: mirrorId,
	sectionId: mirrorId.nullable(),
	/** Manual drag order; negative values are legitimate. */
	tabOrder: z.number().int(),
	isHidden: z.boolean(),
	archivedAt: epochMs.nullable(),
	snoozeUntil: epochMs.nullable(),
	snoozeLaunchId: mirrorId.nullable(),
	completedAt: epochMs.nullable(),
	deletedAt: epochMs.nullable(),
	pinnedAt: epochMs.nullable(),
});

const projectStateInput = z.object({
	projectId: mirrorId,
	tabOrder: z.number().int(),
	isPinned: z.boolean(),
	isCollapsed: z.boolean(),
});

const syncInput = z.object({
	/**
	 * The renderer's per-launch id, current AT SYNC TIME. An "until next launch"
	 * snooze is only still in force while a workspace's `snoozeLaunchId` equals
	 * this; without it the predicate cannot be evaluated outside the renderer.
	 */
	appLaunchId: mirrorId,
	workspaces: z.array(workspaceStateInput).max(MAX_MIRROR_WORKSPACES),
	projects: z.array(projectStateInput).max(MAX_MIRROR_PROJECTS),
});

export type SidebarMirrorSyncInput = z.infer<typeof syncInput>;

/**
 * Rows per INSERT. SQLite binds one parameter per column per row and caps the
 * total per statement, so a 10 000-row snapshot has to be split. 100 rows x 12
 * columns keeps every statement an order of magnitude under the limit while
 * still being one statement per hundred threads.
 */
const INSERT_CHUNK_ROWS = 100;

function chunk<T>(rows: readonly T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < rows.length; i += size) {
		out.push(rows.slice(i, i + size));
	}
	return out;
}

/**
 * (MIRROR-CHANGE-GSEQ) A hash of everything a consumer can observe about this
 * snapshot, so a curation change can be told apart from the five-minute
 * heartbeat re-push of an identical one.
 *
 * ORDER-INDEPENDENT BY CONSTRUCTION: both collections are sorted by their key
 * before hashing, because the renderer derives them from live queries whose row
 * ORDER is not stable, and a hash that moved with row order would report every
 * heartbeat as a change — which is the failure this exists to avoid.
 *
 * `appLaunchId` is IN the hash, and that is not incidental. An "until next
 * launch" snooze is only in force while a row's `snoozeLaunchId` equals the
 * mirror's current launch id, so the same rows under a new launch id are a
 * different curation: threads the previous launch hid are visible again.
 */
function computeContentHash(
	input: SidebarMirrorSyncInput,
	organizationId: string,
): string {
	const workspaces = [...input.workspaces].sort((a, b) =>
		a.workspaceId < b.workspaceId ? -1 : a.workspaceId > b.workspaceId ? 1 : 0,
	);
	const projects = [...input.projects].sort((a, b) =>
		a.projectId < b.projectId ? -1 : a.projectId > b.projectId ? 1 : 0,
	);
	return createHash("sha256")
		.update(
			JSON.stringify({
				organizationId,
				appLaunchId: input.appLaunchId,
				workspaces,
				projects,
			}),
		)
		.digest("hex");
}

/**
 * Replace the mirror with `input`, atomically.
 *
 * The delete-then-insert pair MUST stay inside one transaction: a reader that
 * caught the gap would see an empty mirror and — under the fail-toward-showing
 * rule — fall back to showing everything, which is a visible flicker of the
 * exact noise the mirror exists to remove. `better-sqlite3` transactions are
 * synchronous, so no await can interleave inside the callback.
 *
 * Rows the caller did not send are GONE, not tombstoned. That is what makes the
 * mirror self-healing: a workspace the user removed from the sidebar disappears
 * from the snapshot, and a consumer treating "no row" as "no opinion" then
 * shows it again — which is correct, because the user removed it from the
 * sidebar, not from the machine.
 *
 * (MIRROR-CHANGE-GSEQ) Returns whether this write CHANGED anything, decided
 * inside the transaction against the hash the previous write stored. A row with
 * no stored hash (written before the column existed) counts as changed: one
 * spurious refetch on upgrade beats a mirror that can never announce itself.
 */
function replaceMirror(
	db: HostDb,
	input: SidebarMirrorSyncInput,
	organizationId: string,
	nowMs: number,
): { changed: boolean } {
	const contentHash = computeContentHash(input, organizationId);
	return db.transaction((tx) => {
		const [previous] = tx.select().from(sidebarMirrorMeta).limit(1).all();
		const changed = previous?.contentHash !== contentHash;
		tx.delete(sidebarWorkspaceState).run();
		tx.delete(sidebarProjectState).run();

		for (const rows of chunk(input.workspaces, INSERT_CHUNK_ROWS)) {
			tx.insert(sidebarWorkspaceState)
				.values(
					rows.map((row) => ({
						workspaceId: row.workspaceId,
						projectId: row.projectId,
						sectionId: row.sectionId,
						tabOrder: row.tabOrder,
						isHidden: row.isHidden,
						archivedAt: row.archivedAt,
						snoozeUntil: row.snoozeUntil,
						snoozeLaunchId: row.snoozeLaunchId,
						completedAt: row.completedAt,
						deletedAt: row.deletedAt,
						pinnedAt: row.pinnedAt,
						syncedAtMs: nowMs,
					})),
				)
				.run();
		}

		for (const rows of chunk(input.projects, INSERT_CHUNK_ROWS)) {
			tx.insert(sidebarProjectState)
				.values(
					rows.map((row) => ({
						projectId: row.projectId,
						tabOrder: row.tabOrder,
						isPinned: row.isPinned,
						isCollapsed: row.isCollapsed,
						syncedAtMs: nowMs,
					})),
				)
				.run();
		}

		// The meta row is written LAST and in the same transaction: its presence
		// is the bootstrap signal ("a renderer has synced against this database"),
		// so it must never become visible before the rows it describes.
		tx.insert(sidebarMirrorMeta)
			.values({
				id: 1,
				lastFullSyncAtMs: nowMs,
				appLaunchId: input.appLaunchId,
				organizationId,
				workspaceCount: input.workspaces.length,
				projectCount: input.projects.length,
				contentHash,
			})
			.onConflictDoUpdate({
				target: sidebarMirrorMeta.id,
				set: {
					lastFullSyncAtMs: nowMs,
					appLaunchId: input.appLaunchId,
					organizationId,
					workspaceCount: input.workspaces.length,
					projectCount: input.projects.length,
					contentHash,
				},
			})
			.run();
		return { changed };
	});
}

export const sidebarMirrorRouter = router({
	/**
	 * Replace the mirror with the renderer's current curation state.
	 *
	 * Idempotent by construction — the same snapshot sent twice leaves the same
	 * rows — which is what lets the renderer debounce aggressively and re-send on
	 * reconnect without reasoning about what it already sent.
	 */
	sync: protectedProcedure
		.input(syncInput)
		.mutation(({ ctx, input }): { syncedAtMs: number } => {
			const nowMs = Date.now();
			// Duplicate keys would fail mid-transaction with a constraint error
			// that says nothing about which side sent the duplicate. Both inputs
			// are keyed collections on the renderer, so a duplicate means the
			// payload was assembled wrong — name it.
			assertUniqueKeys(
				input.workspaces.map((row) => row.workspaceId),
				"workspaces",
			);
			assertUniqueKeys(
				input.projects.map((row) => row.projectId),
				"projects",
			);
			const { changed } = replaceMirror(
				ctx.db,
				input,
				ctx.organizationId,
				nowMs,
			);
			// (MIRROR-CHANGE-GSEQ) Only a write that CHANGED the mirror announces
			// itself. The renderer re-pushes the identical snapshot every five
			// minutes as a liveness heartbeat, and announcing those would move the
			// event sequence on every beat — invalidating every client's tree cache
			// twelve times an hour for a mirror nobody touched.
			if (changed) {
				publishCompanionMirrorChanged({
					syncedAtMs: nowMs,
					workspaceCount: input.workspaces.length,
					projectCount: input.projects.length,
				});
			}
			return { syncedAtMs: nowMs };
		}),

	/**
	 * What the mirror currently holds — the freshness question, answerable
	 * without opening the database. `null` means no renderer has ever synced
	 * against it, which is the state every consumer must read as "pass
	 * everything through".
	 */
	state: queryProcedure.query(
		({
			ctx,
		}): {
			lastFullSyncAtMs: number;
			appLaunchId: string;
			organizationId: string;
			workspaceCount: number;
			projectCount: number;
		} | null => {
			const [meta] = ctx.db.select().from(sidebarMirrorMeta).limit(1).all();
			if (!meta) return null;
			return {
				lastFullSyncAtMs: meta.lastFullSyncAtMs,
				appLaunchId: meta.appLaunchId,
				organizationId: meta.organizationId,
				workspaceCount: meta.workspaceCount,
				projectCount: meta.projectCount,
			};
		},
	),
});

function assertUniqueKeys(keys: readonly string[], label: string): void {
	const seen = new Set<string>();
	for (const key of keys) {
		if (seen.has(key)) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: `(SIDEBAR-MIRROR) duplicate ${label} key in snapshot: ${key}`,
			});
		}
		seen.add(key);
	}
}

/**
 * (MIRROR-CHANGE-GSEQ) Exposed for the change-detection tests only. The
 * changed/unchanged decision is the one bit that tells the phone its tree is
 * stale, and both mistakes are real — never announcing leaves it blessing a
 * stale list forever, announcing every heartbeat invalidates every client's
 * cache twelve times an hour — so it is exercised directly against SQL rather
 * than through a mocked tRPC context.
 */
export const __testing = { replaceMirror, computeContentHash };
