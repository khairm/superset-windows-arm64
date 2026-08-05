import { useLiveQuery } from "@tanstack/react-db";
import { useEffect, useMemo, useRef } from "react";
import { getHostServiceClientByUrl } from "renderer/lib/host-service-client";
import { useCollections } from "renderer/routes/_authenticated/providers/CollectionsProvider";
import { APP_LAUNCH_ID } from "renderer/routes/_authenticated/providers/CollectionsProvider/dashboardSidebarLocal";
import { useLocalHostService } from "renderer/routes/_authenticated/providers/LocalHostServiceProvider";

/**
 * (SIDEBAR-MIRROR) Publishes the renderer's sidebar CURATION into `host.db`.
 *
 * Everything the user decides about a thread — where it sits, whether it is
 * hidden, archived, snoozed, completed, binned, pinned, and in what order —
 * lives in two `localStorage` collections that only this process can read.
 * Anything outside the renderer that wants to show "the user's sidebar" is
 * otherwise reading raw `host.db`, which is every project, workspace and
 * session the machine has ever created with no notion of any of those
 * judgements. This hook is the one place that closes that gap.
 *
 * WHY A WHOLE-SNAPSHOT PUSH, NOT PER-MUTATION WRITES. Curation has no single
 * choke point: context menus, bulk actions, kanban drags, the snooze submenu,
 * drag-reordering and the CLI worktree placer all mutate these collections
 * independently, and a new entry point is added roughly every feature. Emitting
 * a delta from each one means the mirror is only ever as correct as the last
 * person who remembered — and forgetting is silent. Deriving the entire
 * snapshot from the collections instead makes the correctness condition
 * "something changed", which the live queries below observe for free. It is
 * also what makes the mirror SELF-HEALING: a failed sync, a host-service
 * restart, or a renderer reload all repair themselves on the next push.
 *
 * THE DEBOUNCE IS NOT AN OPTIMISATION. Dragging a thread emits a tabOrder write
 * per frame; a bulk bin emits one per selected row. Coalescing to a single
 * trailing push per quiet period keeps a drag from turning into a hundred
 * full-table replaces, and because each push is a complete snapshot, the
 * coalesced result is identical to the last one that would have been sent.
 *
 * ABSENCE IS SAFE; STALENESS IS NOT. Consumers are required to treat a MISSING
 * row as "no opinion recorded" and SHOW the row (see `db/schema.ts`), so an
 * unfilled mirror can only ever be too noisy. A STALE row is a different animal
 * and the two must not be conflated: a row still carrying `deletedAt` /
 * `archivedAt` / `isHidden` / `snoozeUntil` from before the user restored the
 * thread HIDES something that is no longer hidden — precisely the forbidden
 * direction. Nothing about a full-snapshot replace makes that self-correcting on
 * its own, so the two mechanisms below are load-bearing, not defensive polish:
 *
 *  - ONE PUSH IN FLIGHT AT A TIME. Two snapshots on separate loopback
 *    connections have no ordering guarantee. If the older one is served last,
 *    `host.db` keeps the older snapshot while `lastSyncedSignatureRef` believes
 *    the newer one landed, and every future push is suppressed until the next
 *    curation change. Serializing removes the reorder, not just its likelihood.
 *  - THE RETRY NEVER GIVES UP while the app runs (`RETRY_DELAY_CAP_MS`). A
 *    bounded retry has a terminal state — attempts exhausted, no signature
 *    change coming, a host-service that restarted on the same port so
 *    `activeHostUrl` never changes either — and that terminal state is a mirror
 *    frozen with stale HIDING fields forever.
 *
 * What is left after both is the honest floor: with the renderer gone, the
 * mirror holds the user's LAST RECORDED curation. It is never an invented
 * opinion, and while the renderer runs it lags by at most the debounce plus one
 * retry backoff. NOTE FOR CONSUMERS: there is no heartbeat, so
 * `sidebar_mirror_meta.last_full_sync_at_ms` measures the last CURATION CHANGE,
 * not renderer liveness — an hours-old timestamp usually means nobody touched
 * the sidebar, not that the desktop is gone.
 */

/** Trailing debounce. Long enough to swallow a drag, short enough to feel live. */
const SYNC_DEBOUNCE_MS = 1_000;

/**
 * Retry schedule after a failed push. Unlike the first cut of this hook, it does
 * NOT stop: every attempt past the schedule waits `RETRY_DELAY_CAP_MS`, forever.
 * Stopping looked cheap while "stale is safe" was believed, but a mirror holding
 * a stale `deletedAt`/`archivedAt`/`snoozeUntil` HIDES a live thread, and the
 * exhausted state has no exit — it re-arms only on a curation change or a new
 * `activeHostUrl`, and a host-service that restarts on the same port produces
 * neither. One request per five minutes against loopback is not a cost worth a
 * permanently wrong mirror.
 */
const RETRY_DELAYS_MS = [5_000, 15_000, 45_000, 120_000] as const;
const RETRY_DELAY_CAP_MS = 300_000;

interface MirrorWorkspaceRow {
	workspaceId: string;
	projectId: string;
	sectionId: string | null;
	tabOrder: number;
	isHidden: boolean;
	archivedAt: number | null;
	snoozeUntil: number | null;
	snoozeLaunchId: string | null;
	completedAt: number | null;
	deletedAt: number | null;
	pinnedAt: number | null;
}

interface MirrorProjectRow {
	projectId: string;
	tabOrder: number;
	isPinned: boolean;
	isCollapsed: boolean;
}

interface MirrorSnapshot {
	workspaces: MirrorWorkspaceRow[];
	projects: MirrorProjectRow[];
	/** Values the normalizers refused. Reported once per snapshot, never hidden. */
	rejectedFields: number;
	/** Rows with no usable identity/placement. Dropped, and never silently. */
	droppedRows: number;
}

/**
 * A curation timestamp, or null. Anything that is not a finite non-negative
 * number is not a timestamp a human action produced — it is a corrupt persisted
 * row — and it is mapped to "absent" rather than sent on. Sending it would fail
 * the bridge's boundary validation and reject the WHOLE snapshot, freezing the
 * mirror on one bad row; absent is the fail-toward-showing direction. The count
 * is surfaced by the caller so this stays visible rather than silent.
 */
function toEpochMs(value: unknown, reject: () => void): number | null {
	if (value == null) return null;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		reject();
		return null;
	}
	return Math.trunc(value);
}

/** Manual drag order. Negative is legitimate (prepend); non-finite is not. */
function toTabOrder(value: unknown, reject: () => void): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		reject();
		return 0;
	}
	return Math.trunc(value);
}

/**
 * A non-empty id, or null. These fields are typed `string`, but they are NOT
 * guaranteed to be one at runtime: localStorage collections do not run the zod
 * schema on READS (see `CollectionsProvider/withReadHeal.ts`), and the heal
 * deliberately refuses to synthesize identity fields — `workspaceId` and
 * `sidebarState.projectId` "must come from the stored row" or not at all. A
 * legacy or corrupt row therefore hands back `undefined` behind a `string`
 * type, and every existing reader of `sidebarState.projectId` compares it with
 * `===` and degrades to "row not shown". Touching `.length` on it instead
 * throws inside the `useMemo` below — and because `AgentHooks` is mounted
 * unconditionally with no boundary nearer than the ROOT route, that one row
 * would replace the entire app with the error page and take the command
 * watcher, device presence and worktree placer down with it.
 */
function toNullableId(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The live-query rows AS THEY ACTUALLY ARRIVE. Every field is `unknown` on
 * purpose. The collections declare them `string`/`number`, but a localStorage
 * collection validates on WRITE only, so the declared type is a claim about
 * what was once written and not about what comes back. Typing them honestly
 * here is what forces every field through a normalizer instead of being
 * trusted, and it is what makes the crash below impossible to reintroduce.
 */
interface LocalStateRowLike {
	workspaceId: unknown;
	projectId: unknown;
	sectionId: unknown;
	tabOrder: unknown;
	isHidden: unknown;
	archivedAt: unknown;
	snoozeUntil: unknown;
	snoozeLaunchId: unknown;
	completedAt: unknown;
	deletedAt: unknown;
	pinnedAt: unknown;
}

interface SidebarProjectRowLike {
	projectId: unknown;
	tabOrder: unknown;
	isPinned: unknown;
	isCollapsed: unknown;
}

/**
 * Derive the snapshot the mirror publishes from the two collections.
 *
 * Sorted by key, so the signature the hook derives from it is a function of
 * CONTENT only — without that, every live-query emission would produce a new
 * signature and re-push an identical snapshot.
 *
 * Exported, and free of React, so the normalization can be exercised directly;
 * `useSidebarMirrorSync` is the only production caller.
 */
export function buildMirrorSnapshot(
	localStateRows: readonly LocalStateRowLike[],
	sidebarProjectRows: readonly SidebarProjectRowLike[],
): MirrorSnapshot {
	let rejectedFields = 0;
	let droppedRows = 0;
	const reject = (): void => {
		rejectedFields += 1;
	};
	const workspaces = localStateRows
		.map((row): MirrorWorkspaceRow | null => {
			// Identity and placement go through `toNullableId` for the reason
			// documented on it: both are `string` by declared type and can be
			// `undefined` at runtime, so this must be a null check and never a
			// `.length` one.
			const workspaceId = toNullableId(row.workspaceId);
			const projectId = toNullableId(row.projectId);
			// A row with no identity, or whose placement project is missing, cannot
			// be mirrored: the column is NOT NULL on the far side, and a placement
			// of "nowhere" is not a statement the mirror can make. Dropping it means
			// the consumer sees no opinion and shows the thread — the safe direction.
			if (workspaceId === null || projectId === null) {
				droppedRows += 1;
				return null;
			}
			return {
				workspaceId,
				projectId,
				sectionId: toNullableId(row.sectionId),
				tabOrder: toTabOrder(row.tabOrder, reject),
				isHidden: row.isHidden === true,
				archivedAt: toEpochMs(row.archivedAt, reject),
				snoozeUntil: toEpochMs(row.snoozeUntil, reject),
				snoozeLaunchId: toNullableId(row.snoozeLaunchId),
				completedAt: toEpochMs(row.completedAt, reject),
				deletedAt: toEpochMs(row.deletedAt, reject),
				pinnedAt: toEpochMs(row.pinnedAt, reject),
			};
		})
		.filter((row): row is MirrorWorkspaceRow => row !== null)
		.sort((left, right) => left.workspaceId.localeCompare(right.workspaceId));

	const projects = sidebarProjectRows
		.map((row): MirrorProjectRow | null => {
			const projectId = toNullableId(row.projectId);
			if (projectId === null) {
				droppedRows += 1;
				return null;
			}
			return {
				projectId,
				tabOrder: toTabOrder(row.tabOrder, reject),
				isPinned: row.isPinned === true,
				isCollapsed: row.isCollapsed === true,
			};
		})
		.filter((row): row is MirrorProjectRow => row !== null)
		.sort((left, right) => left.projectId.localeCompare(right.projectId));

	return { workspaces, projects, rejectedFields, droppedRows };
}

export interface MirrorPushLoopDeps {
	/**
	 * The push currently on the wire, SHARED by every loop — that sharing IS the
	 * serialization. A loop that finds it non-null waits for it instead of
	 * issuing a second mutation, because two mutations on separate loopback
	 * connections have no ordering guarantee and an older one served last leaves
	 * `host.db` holding the older snapshot while the caller already recorded the
	 * newer one as synced.
	 */
	inFlight: { current: Promise<void> | null };
	/** The NEWEST snapshot at call time, never the one this loop was built for. */
	getSnapshot: () => MirrorSnapshot;
	send: (snapshot: MirrorSnapshot) => Promise<unknown>;
	/** Called iff this loop's own send resolved and the loop was not cancelled. */
	onSynced: () => void;
	/** Overridable so the timings can be exercised without waiting minutes. */
	debounceMs?: number;
	retryDelaysMs?: readonly number[];
	retryCapMs?: number;
	report?: (message: string, detail?: unknown) => void;
}

export interface MirrorPushLoop {
	start: () => void;
	cancel: () => void;
}

/**
 * The push loop for ONE signature: debounce, send, retry — and the part that
 * spans loops, serialization against whatever is already on the wire.
 *
 * Extracted from the hook and free of React so its ordering guarantees can be
 * exercised directly; `useSidebarMirrorSync` is the only production caller.
 */
export function createMirrorPushLoop(deps: MirrorPushLoopDeps): MirrorPushLoop {
	const debounceMs = deps.debounceMs ?? SYNC_DEBOUNCE_MS;
	const retryDelaysMs = deps.retryDelaysMs ?? RETRY_DELAYS_MS;
	const retryCapMs = deps.retryCapMs ?? RETRY_DELAY_CAP_MS;
	const report =
		deps.report ??
		((message: string, detail?: unknown): void => {
			if (detail === undefined) console.error(message);
			else console.error(message, detail);
		});

	let cancelled = false;
	let attempt = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;

	const push = (): void => {
		const inFlight = deps.inFlight.current;
		if (inFlight !== null) {
			// Wait for the outstanding push instead of racing it. No queue is
			// needed: `getSnapshot` always returns the newest snapshot, so
			// re-entering `push` after the settle sends current state rather than a
			// backlog. `cancelled` covers a newer signature taking over meanwhile.
			void inFlight.then(() => {
				if (!cancelled) push();
			});
			return;
		}
		const current = deps.getSnapshot();
		if (current.rejectedFields > 0) {
			report(
				`(SIDEBAR-MIRROR) ${current.rejectedFields} corrupt sidebar field(s) were sent as absent; the affected threads will show as un-curated.`,
			);
		}
		if (current.droppedRows > 0) {
			report(
				`(SIDEBAR-MIRROR) ${current.droppedRows} sidebar row(s) had no usable id and were dropped from the snapshot; the affected threads will show as un-curated.`,
			);
		}
		const settled = deps.send(current).then(
			() => {
				if (cancelled) return;
				deps.onSynced();
			},
			(error: unknown) => {
				if (cancelled) return;
				// Never silent. A mirror that stops updating is invisible from the
				// desktop — the desktop sidebar is correct either way — so the log
				// line is the only evidence it happened.
				report(
					"(SIDEBAR-MIRROR) publishing sidebar state to host.db failed",
					error instanceof Error ? error.message : String(error),
				);
				// No give-up branch. See RETRY_DELAY_CAP_MS.
				const delay = retryDelaysMs[attempt] ?? retryCapMs;
				attempt += 1;
				timer = setTimeout(push, delay);
			},
		);
		// Cleared on settle so the next push can start; assigned AFTER the handlers
		// are attached so a waiter always resumes past the clear.
		deps.inFlight.current = settled.finally(() => {
			deps.inFlight.current = null;
		});
	};

	return {
		start: (): void => {
			timer = setTimeout(push, debounceMs);
		},
		cancel: (): void => {
			cancelled = true;
			if (timer !== undefined) clearTimeout(timer);
		},
	};
}

export function useSidebarMirrorSync(): void {
	const collections = useCollections();
	const { activeHostUrl } = useLocalHostService();

	const { data: localStateRows = [], isReady: localStateReady } = useLiveQuery(
		(query) =>
			query
				.from({ state: collections.v2WorkspaceLocalState })
				.select(({ state }) => ({
					workspaceId: state.workspaceId,
					projectId: state.sidebarState.projectId,
					sectionId: state.sidebarState.sectionId,
					tabOrder: state.sidebarState.tabOrder,
					isHidden: state.sidebarState.isHidden,
					archivedAt: state.sidebarState.archivedAt,
					snoozeUntil: state.sidebarState.snoozeUntil,
					snoozeLaunchId: state.sidebarState.snoozeLaunchId,
					completedAt: state.sidebarState.completedAt,
					deletedAt: state.sidebarState.deletedAt,
					pinnedAt: state.sidebarState.pinnedAt,
				})),
		[collections],
	);

	const { data: sidebarProjectRows = [], isReady: sidebarProjectsReady } =
		useLiveQuery(
			(query) =>
				query
					.from({ sidebarProject: collections.v2SidebarProjects })
					.select(({ sidebarProject }) => ({
						projectId: sidebarProject.projectId,
						tabOrder: sidebarProject.tabOrder,
						isPinned: sidebarProject.isPinned,
						isCollapsed: sidebarProject.isCollapsed,
					})),
			[collections],
		);

	/**
	 * Sorted by key, so the serialized form below is a function of CONTENT only.
	 * Without that, every live-query emission would produce a new signature and
	 * re-push an identical snapshot.
	 */
	const snapshot = useMemo(
		(): MirrorSnapshot =>
			buildMirrorSnapshot(localStateRows, sidebarProjectRows),
		[localStateRows, sidebarProjectRows],
	);

	const signature = useMemo(
		() => JSON.stringify([snapshot.workspaces, snapshot.projects]),
		[snapshot],
	);

	// Latest-value ref: the effect below is keyed on `signature`, and identical
	// content must not re-run it just because the live query handed back new
	// array identities.
	const snapshotRef = useRef(snapshot);
	snapshotRef.current = snapshot;

	const lastSyncedSignatureRef = useRef<string | null>(null);

	/**
	 * The push currently on the wire, or null — deliberately a ref so it spans
	 * effect runs. Serializing pushes is a correctness requirement, not a load
	 * control: two mutations issued a second apart travel on separate loopback
	 * connections with no ordering guarantee, and if the OLDER one is served last
	 * `host.db` keeps the older snapshot while `lastSyncedSignatureRef` already
	 * records the newer one as synced — which suppresses every subsequent push
	 * until the next curation change. Stale HIDING fields (`deletedAt`,
	 * `archivedAt`, `isHidden`, `snoozeUntil`) surviving that way is exactly the
	 * failure direction the mirror is not allowed to have.
	 */
	const inFlightRef = useRef<Promise<void> | null>(null);

	const ready = localStateReady && sidebarProjectsReady;

	useEffect(() => {
		// Readiness gate: a full replace derived from a half-hydrated collection
		// would publish a snapshot that is missing rows. It is the safe direction
		// (missing = shown), but it is still wrong, and it is avoidable — the
		// collections settle within a tick of mount.
		if (!ready) return;
		// No local host-service yet (still starting, or none on this machine).
		// The effect re-runs when the URL appears.
		if (!activeHostUrl) return;
		if (signature === lastSyncedSignatureRef.current) return;

		const loop = createMirrorPushLoop({
			inFlight: inFlightRef,
			getSnapshot: () => snapshotRef.current,
			send: (current) =>
				getHostServiceClientByUrl(activeHostUrl).sidebarMirror.sync.mutate({
					appLaunchId: APP_LAUNCH_ID,
					workspaces: current.workspaces,
					projects: current.projects,
				}),
			onSynced: () => {
				lastSyncedSignatureRef.current = signature;
			},
		});
		loop.start();
		return () => {
			loop.cancel();
		};
	}, [ready, activeHostUrl, signature]);
}
