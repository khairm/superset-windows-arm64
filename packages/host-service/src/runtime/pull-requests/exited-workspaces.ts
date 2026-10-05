import {
	createLastKnownSidebarCuration,
	isMirrorFresh,
	type SidebarCuration,
	type SidebarMirrorSnapshot,
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

function readMirrorRows(
	db: HostDb,
): Pick<SidebarMirrorSnapshot, "workspaces" | "projects"> {
	return {
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
	};
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
	if (isMirrorFresh(ageMs)) return "fresh";
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
		const [meta = null] = db.select().from(sidebarMirrorMeta).limit(1).all();
		const metaOnly = createLastKnownSidebarCuration(
			{ meta, workspaces: [], projects: [] },
			now,
			organizationId,
		);
		const state = mirrorState(metaOnly);
		const age = {
			lastSyncAgeMs: metaOnly.lastSyncAgeMs,
			lastFullSyncAt:
				metaOnly.lastSyncAgeMs === null
					? null
					: new Date(now - metaOnly.lastSyncAgeMs).toISOString(),
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
		if (state === "fresh" || state === "none") {
			lastFullPassAtElapsedMs.clear();
		} else if (state === "expired" && slot !== null) {
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
		if (!metaOnly.enabled) return () => false;
		const curation = createLastKnownSidebarCuration(
			{ meta, ...readMirrorRows(db) },
			now,
			organizationId,
		);
		return (workspace) => curation.workspaceVerdict(workspace) !== "show";
	};
}
