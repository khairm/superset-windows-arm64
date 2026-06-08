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
import { LuChevronRight } from "react-icons/lu";
import type { DashboardSidebarWorkspace } from "../../../../types";
import { DashboardSidebarWorkspaceItem } from "../../../DashboardSidebarWorkspaceItem/DashboardSidebarWorkspaceItem";

interface DashboardSidebarStateSectionProps {
	variant: "snoozed" | "archived";
	workspaces: DashboardSidebarWorkspace[];
	collapsed: boolean;
	onToggleCollapsed: () => void;
	onHide: () => void;
	onRestoreAll: () => void;
	onWorkspaceHover: (workspaceId: string) => void | Promise<void>;
}

const COPY = {
	snoozed: { title: "Snoozed", hide: "Hide snoozed", restoreAll: "Unsnooze all" },
	archived: {
		title: "Archived",
		hide: "Hide archived",
		restoreAll: "Unarchive all",
	},
} as const;

/**
 * A reveal-able, collapsible section listing a project's snoozed or archived
 * threads. The whole section (header included) only renders when the project
 * has it revealed; right-clicking the header hides it again or bulk-restores.
 */
export function DashboardSidebarStateSection({
	variant,
	workspaces,
	collapsed,
	onToggleCollapsed,
	onHide,
	onRestoreAll,
	onWorkspaceHover,
}: DashboardSidebarStateSectionProps) {
	const copy = COPY[variant];

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
							<ContextMenuSeparator />
						</>
					)}
					<ContextMenuItem onSelect={onHide}>{copy.hide}</ContextMenuItem>
				</ContextMenuContent>
			</ContextMenu>
			<CollapsibleContent>
				{workspaces.map((workspace) => (
					<DashboardSidebarWorkspaceItem
						key={workspace.id}
						workspace={workspace}
						sectionState={variant}
						isInSection
						onHoverCardOpen={() => onWorkspaceHover(workspace.id)}
					/>
				))}
			</CollapsibleContent>
		</Collapsible>
	);
}
