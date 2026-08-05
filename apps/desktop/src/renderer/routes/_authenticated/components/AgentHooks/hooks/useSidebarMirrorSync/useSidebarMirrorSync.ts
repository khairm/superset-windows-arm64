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
 * STALENESS IS SAFE IN EXACTLY ONE DIRECTION. Consumers of the mirror are
 * required to treat a missing or older row as "no opinion recorded" and SHOW
 * the row (see `db/schema.ts`). That is why this hook never tries harder than
 * it should: a failed sync leaves the previous snapshot in place and retries a
 * bounded number of times, and the worst outcome is a consumer showing
 * something the user has already tidied away — never hiding an agent that is
 * blocked on them.
 */

/** Trailing debounce. Long enough to swallow a drag, short enough to feel live. */
const SYNC_DEBOUNCE_MS = 1_000;

/**
 * Retry schedule after a failed push, then stop. Stopping is deliberate: the
 * next curation change re-arms the whole thing anyway, and a mirror that is one
 * snapshot behind is a documented-safe state, so an unbounded retry loop would
 * be spending the user's CPU to avoid a harmless condition.
 */
const RETRY_DELAYS_MS = [5_000, 15_000, 45_000] as const;

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

function toNullableId(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
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
	const snapshot = useMemo((): MirrorSnapshot => {
		let rejectedFields = 0;
		const reject = (): void => {
			rejectedFields += 1;
		};
		const workspaces = localStateRows
			.map(
				(row): MirrorWorkspaceRow => ({
					workspaceId: row.workspaceId,
					projectId: row.projectId,
					sectionId: toNullableId(row.sectionId),
					tabOrder: toTabOrder(row.tabOrder, reject),
					isHidden: row.isHidden === true,
					archivedAt: toEpochMs(row.archivedAt, reject),
					snoozeUntil: toEpochMs(row.snoozeUntil, reject),
					snoozeLaunchId: toNullableId(row.snoozeLaunchId),
					completedAt: toEpochMs(row.completedAt, reject),
					deletedAt: toEpochMs(row.deletedAt, reject),
					pinnedAt: toEpochMs(row.pinnedAt, reject),
				}),
			)
			// A row whose placement project is missing cannot be mirrored: the
			// column is NOT NULL on the far side, and a placement of "nowhere" is
			// not a statement the mirror can make. Dropping it means the consumer
			// sees no opinion and shows the thread — the safe direction.
			.filter((row) => row.workspaceId.length > 0 && row.projectId.length > 0)
			.sort((left, right) => left.workspaceId.localeCompare(right.workspaceId));

		const projects = sidebarProjectRows
			.map(
				(row): MirrorProjectRow => ({
					projectId: row.projectId,
					tabOrder: toTabOrder(row.tabOrder, reject),
					isPinned: row.isPinned === true,
					isCollapsed: row.isCollapsed === true,
				}),
			)
			.filter((row) => row.projectId.length > 0)
			.sort((left, right) => left.projectId.localeCompare(right.projectId));

		return { workspaces, projects, rejectedFields };
	}, [localStateRows, sidebarProjectRows]);

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

		let cancelled = false;
		let attempt = 0;
		let timer: ReturnType<typeof setTimeout> | undefined;

		const push = (): void => {
			const current = snapshotRef.current;
			if (current.rejectedFields > 0) {
				console.error(
					`(SIDEBAR-MIRROR) ${current.rejectedFields} corrupt sidebar field(s) were sent as absent; the affected threads will show as un-curated.`,
				);
			}
			void getHostServiceClientByUrl(activeHostUrl)
				.sidebarMirror.sync.mutate({
					appLaunchId: APP_LAUNCH_ID,
					workspaces: current.workspaces,
					projects: current.projects,
				})
				.then(
					() => {
						if (cancelled) return;
						lastSyncedSignatureRef.current = signature;
					},
					(error: unknown) => {
						if (cancelled) return;
						// Never silent. A mirror that stops updating is invisible from
						// the desktop — the desktop sidebar is correct either way — so
						// the log line is the only evidence it happened.
						console.error(
							"(SIDEBAR-MIRROR) publishing sidebar state to host.db failed",
							error instanceof Error ? error.message : String(error),
						);
						const delay = RETRY_DELAYS_MS[attempt];
						if (delay === undefined) return;
						attempt += 1;
						timer = setTimeout(push, delay);
					},
				);
		};

		timer = setTimeout(push, SYNC_DEBOUNCE_MS);

		return () => {
			cancelled = true;
			if (timer) clearTimeout(timer);
		};
	}, [ready, activeHostUrl, signature]);
}
