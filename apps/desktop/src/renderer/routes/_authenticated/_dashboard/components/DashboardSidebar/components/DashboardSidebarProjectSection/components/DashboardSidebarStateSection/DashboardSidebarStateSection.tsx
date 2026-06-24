import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@superset/ui/collapsible";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "@superset/ui/context-menu";
import { cn } from "@superset/ui/utils";
import { useEffect, useMemo, useState } from "react";
import { LuChevronRight, LuTrash2 } from "react-icons/lu";
import { useRecycleBinRetention } from "renderer/routes/_authenticated/_dashboard/stores/recycleBinRetention";
import { isWithinRecycleBinWindow } from "renderer/routes/_authenticated/providers/CollectionsProvider/dashboardSidebarLocal";
import type { DashboardSidebarWorkspace } from "../../../../types";
import { DashboardSidebarWorkspaceItem } from "../../../DashboardSidebarWorkspaceItem/DashboardSidebarWorkspaceItem";

type StateSectionVariant = "snoozed" | "archived" | "deleted";

interface DashboardSidebarStateSectionProps {
	variant: StateSectionVariant;
	workspaces: DashboardSidebarWorkspace[];
	collapsed: boolean;
	onToggleCollapsed: () => void;
	onHide: () => void;
	onRestoreAll: () => void;
	/** (RECYCLE-BIN) Only the "deleted" variant offers a bulk permanent destroy. */
	onEmptyBin?: () => void;
	onWorkspaceHover: (workspaceId: string) => void | Promise<void>;
}

const COPY = {
	snoozed: {
		title: "Snoozed",
		hide: "Hide snoozed",
		restoreAll: "Unsnooze all",
	},
	archived: {
		title: "Archived",
		hide: "Hide archived",
		restoreAll: "Unarchive all",
	},
	deleted: {
		title: "Recycle Bin",
		hide: "Hide Recycle Bin",
		restoreAll: "Restore all",
	},
} as const;

/**
 * A reveal-able, collapsible section listing a project's snoozed, archived, or
 * soft-deleted (RECYCLE-BIN) threads. The whole section (header included) only
 * renders when the project has it revealed; right-clicking the header hides it
 * again, bulk-restores, or (Recycle Bin only) permanently empties.
 *
 * (RECYCLE-BIN) The Recycle Bin applies the device-local retention window as a
 * DISPLAY filter: by default it shows only items deleted within the last N days
 * (older ones are kept but collapsed behind a per-bin "Show all" toggle, with an
 * "N hidden by filter" footer — mirroring the kanban Completed column).
 */
export function DashboardSidebarStateSection({
	variant,
	workspaces,
	collapsed,
	onToggleCollapsed,
	onHide,
	onRestoreAll,
	onEmptyBin,
	onWorkspaceHover,
}: DashboardSidebarStateSectionProps) {
	const copy = COPY[variant];
	const isDeleted = variant === "deleted";
	const retentionDays = useRecycleBinRetention((s) => s.retentionDays);
	// Local "Show all" override per bin — overrides the retention DISPLAY filter
	// so older-than-N-days items can be revealed without changing the setting.
	const [showAll, setShowAll] = useState(false);

	// (RECYCLE-BIN) The retention partition is wall-clock-relative, so a coarse
	// tick re-runs it as items age past the boundary (mirrors useKanbanData's
	// `now`). Gated: only ticks for a non-empty, expanded, NOT-"Show all" bin —
	// an idle/collapsed/showing-all bin has nothing to re-partition.
	const [nowMs, setNowMs] = useState(() => Date.now());
	const needsTick =
		isDeleted && !showAll && !collapsed && workspaces.length > 0;
	useEffect(() => {
		if (!needsTick) return;
		const interval = setInterval(() => setNowMs(Date.now()), 60_000);
		return () => clearInterval(interval);
	}, [needsTick]);

	// (RECYCLE-BIN) Partition the bin into the items shown by default (within the
	// retention window) and the older ones hidden behind "Show all". Non-bin
	// variants show everything (the window check passes a null deletedAt → true).
	const { visibleWorkspaces, hiddenCount } = useMemo(() => {
		if (!isDeleted) {
			return { visibleWorkspaces: workspaces, hiddenCount: 0 };
		}
		const within = workspaces.filter((workspace) =>
			isWithinRecycleBinWindow(workspace.deletedAt, retentionDays, nowMs),
		);
		return {
			visibleWorkspaces: showAll ? workspaces : within,
			hiddenCount: workspaces.length - within.length,
		};
	}, [isDeleted, workspaces, retentionDays, showAll, nowMs]);

	return (
		<Collapsible open={!collapsed} onOpenChange={() => onToggleCollapsed()}>
			<ContextMenu>
				<ContextMenuTrigger asChild>
					<div className="flex items-center">
						<CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-1.5 py-1 pl-5 pr-2 text-left text-xs text-muted-foreground hover:bg-muted/50">
							<LuChevronRight
								className={cn(
									"size-3 shrink-0 transition-transform",
									!collapsed && "rotate-90",
								)}
							/>
							{isDeleted && <LuTrash2 className="size-3 shrink-0 opacity-70" />}
							<span className="truncate font-medium">{copy.title}</span>
							<span className="shrink-0 text-[10px] tabular-nums opacity-70">
								({workspaces.length})
							</span>
						</CollapsibleTrigger>
					</div>
				</ContextMenuTrigger>
				<ContextMenuContent
					onCloseAutoFocus={(event) => event.preventDefault()}
				>
					{workspaces.length > 0 && (
						<>
							<ContextMenuItem onSelect={onRestoreAll}>
								{copy.restoreAll}
							</ContextMenuItem>
							{isDeleted && onEmptyBin && (
								<ContextMenuItem
									onSelect={onEmptyBin}
									className="text-destructive focus:text-destructive"
								>
									<LuTrash2 className="size-4 mr-2 text-destructive" />
									Empty Recycle Bin
								</ContextMenuItem>
							)}
							<ContextMenuSeparator />
						</>
					)}
					<ContextMenuItem onSelect={onHide}>{copy.hide}</ContextMenuItem>
				</ContextMenuContent>
			</ContextMenu>
			<CollapsibleContent>
				{visibleWorkspaces.map((workspace) => (
					<DashboardSidebarWorkspaceItem
						key={workspace.id}
						workspace={workspace}
						sectionState={variant}
						isInSection
						onHoverCardOpen={() => onWorkspaceHover(workspace.id)}
					/>
				))}
				{/* (RECYCLE-BIN) "N hidden by filter" footer + a "Show all" toggle so
				older-than-retention items stay reachable without losing them. */}
				{isDeleted && hiddenCount > 0 && (
					<button
						type="button"
						onClick={() => setShowAll((previous) => !previous)}
						className="flex w-full items-center gap-1.5 py-1 pl-7 pr-2 text-left text-[10px] text-muted-foreground hover:bg-muted/50"
					>
						{showAll
							? "Show recent only"
							: `${hiddenCount} hidden by filter — Show all`}
					</button>
				)}
			</CollapsibleContent>
		</Collapsible>
	);
}
