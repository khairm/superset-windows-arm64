import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuTrigger,
} from "@superset/ui/context-menu";
import { LuArchive, LuClock } from "react-icons/lu";

interface DashboardSidebarSessionsContextMenuProps {
	showSnoozed: boolean;
	showArchived: boolean;
	onToggleSnoozed: () => void;
	onToggleArchived: () => void;
	children: React.ReactNode;
}

/**
 * (SESSION-LIFECYCLE) Right-click menu on the Sessions header. Mirrors the
 * project row's reveal toggles — the only way to show or hide the Snoozed
 * Sessions / Archived Sessions subsections — so a snoozed or archived session
 * is reachable exactly the way a snoozed or archived project thread is.
 */
export function DashboardSidebarSessionsContextMenu({
	showSnoozed,
	showArchived,
	onToggleSnoozed,
	onToggleArchived,
	children,
}: DashboardSidebarSessionsContextMenuProps) {
	return (
		<ContextMenu>
			<ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
			<ContextMenuContent onCloseAutoFocus={(event) => event.preventDefault()}>
				<ContextMenuItem onSelect={onToggleSnoozed}>
					<LuClock className="size-4 mr-2" />
					{showSnoozed ? "Hide snoozed" : "Show snoozed"}
				</ContextMenuItem>
				<ContextMenuItem onSelect={onToggleArchived}>
					<LuArchive className="size-4 mr-2" />
					{showArchived ? "Hide archived" : "Show archived"}
				</ContextMenuItem>
			</ContextMenuContent>
		</ContextMenu>
	);
}
