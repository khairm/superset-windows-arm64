import {
	createLastKnownSidebarCuration,
	MIRROR_MAX_AGE_MS,
	type SidebarCuration,
	type WorkspaceCurationInput,
} from "../../companion/sidebar-filter";
import type { HostDb } from "../../db";
import {
	sidebarMirrorMeta,
	sidebarProjectState,
	sidebarWorkspaceState,
} from "../../db/schema";

// (PR-SWEEP-LAST-KNOWN-MIRROR)
export const PR_SWEEP_MIRROR_LIMIT_MS = 86_400_000;
export const MIRROR_WARN_INTERVAL_MS = 300_000;

export type ExitedWorkspaceFilterSlot = "branch-sweep" | "pr-refresh";

type MirrorState = "none" | "fresh" | "old" | "expired";

const LOG_PREFIX =
	"[host-service:pull-request-runtime] (PR-SWEEP-SKIPS-EXITED) Sidebar mirror";

const STATE_LOG: Record<
	MirrorState,
	{ level: "warn" | "error"; message: string }
> = {
	none: {
		level: "warn",
		message: "is absent or for another org; PR sweeps cover every workspace",
	},
	fresh: {
		level: "warn",
		message: "is fresh; PR sweeps skip workspaces off the sidebar",
	},
	old: {
		level: "warn",
		message: "is old; PR sweeps keep skipping its last known exited workspaces",
	},
	expired: {
		level: "error",
		message:
			"is over 24 h old; PR sweeps keep skipping its last known exited workspaces, with one full pass per sweep a day",
	},
};

function readSidebarCuration(
	db: HostDb,
	organizationId: string,
	nowMs: number,
): SidebarCuration {
	const [meta = null] = db.select().from(sidebarMirrorMeta).limit(1).all();
	const metaOnly = createLastKnownSidebarCuration(
		{ meta, workspaces: [], projects: [] },
		nowMs,
		organizationId,
	);
	if (!metaOnly.enabled) return metaOnly;
	return createLastKnownSidebarCuration(
		{
			meta,
			workspaces: db
				.select({
					workspaceId: sidebarWorkspaceState.workspaceId,
					projectId: sidebarWorkspaceState.projectId,
					isHidden: sidebarWorkspaceState.isHidden,
					archivedAt: sidebarWorkspaceState.archivedAt,
					snoozeUntil: sidebarWorkspaceState.snoozeUntil,
					snoozeLaunchId: sidebarWorkspaceState.snoozeLaunchId,
					completedAt: sidebarWorkspaceState.completedAt,
					deletedAt: sidebarWorkspaceState.deletedAt,
					pinnedAt: sidebarWorkspaceState.pinnedAt,
					tabOrder: sidebarWorkspaceState.tabOrder,
				})
				.from(sidebarWorkspaceState)
				.all(),
			projects: db
				.select({
					projectId: sidebarProjectState.projectId,
					tabOrder: sidebarProjectState.tabOrder,
					isPinned: sidebarProjectState.isPinned,
					isCollapsed: sidebarProjectState.isCollapsed,
				})
				.from(sidebarProjectState)
				.all(),
		},
		nowMs,
		organizationId,
	);
}

function mirrorState(curation: SidebarCuration): MirrorState {
	if (!curation.enabled) return "none";
	const ageMs = curation.lastSyncAgeMs;
	if (ageMs === null) {
		throw new Error("enabled sidebar curation has no mirror age");
	}
	if (ageMs > PR_SWEEP_MIRROR_LIMIT_MS || ageMs < -PR_SWEEP_MIRROR_LIMIT_MS) {
		return "expired";
	}
	if (ageMs >= 0 && ageMs <= MIRROR_MAX_AGE_MS) return "fresh";
	return "old";
}

export function createExitedWorkspaceFilterLoader({
	db,
	organizationId,
	nowMs,
	elapsedMs,
}: {
	db: HostDb;
	organizationId: string;
	nowMs: () => number;
	elapsedMs: () => number;
}): (
	slot: ExitedWorkspaceFilterSlot | null,
) => (workspace: WorkspaceCurationInput) => boolean {
	let loggedState: MirrorState | null = null;
	let loggedAtElapsedMs = 0;
	const lastFullPassAtElapsedMs = new Map<ExitedWorkspaceFilterSlot, number>();
	return (slot) => {
		if (slot !== null && slot !== "branch-sweep" && slot !== "pr-refresh") {
			throw new Error(`invalid exited-workspace filter slot: ${String(slot)}`);
		}
		const now = nowMs();
		const elapsed = elapsedMs();
		const curation = readSidebarCuration(db, organizationId, now);
		const state = mirrorState(curation);
		const age = {
			lastSyncAgeMs: curation.lastSyncAgeMs,
			lastFullSyncAt:
				curation.lastSyncAgeMs === null
					? null
					: new Date(now - curation.lastSyncAgeMs).toISOString(),
		};
		const repeats = state === "old" || state === "expired";
		if (
			state !== loggedState ||
			(repeats && elapsed - loggedAtElapsedMs >= MIRROR_WARN_INTERVAL_MS)
		) {
			loggedState = state;
			loggedAtElapsedMs = elapsed;
			const { level, message } = STATE_LOG[state];
			console[level](`${LOG_PREFIX} ${message}`, age);
		}
		if (state !== "expired") {
			lastFullPassAtElapsedMs.clear();
		} else if (slot !== null) {
			const lastPassAt = lastFullPassAtElapsedMs.get(slot);
			if (
				lastPassAt === undefined ||
				elapsed - lastPassAt >= PR_SWEEP_MIRROR_LIMIT_MS
			) {
				lastFullPassAtElapsedMs.set(slot, elapsed);
				console.error(`${LOG_PREFIX} is over 24 h old; full pass started`, {
					slot,
					...age,
				});
				return () => false;
			}
		}
		return (workspace) => curation.workspaceVerdict(workspace) !== "show";
	};
}
