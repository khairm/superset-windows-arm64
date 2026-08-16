import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuTrigger,
} from "@superset/ui/context-menu";
import { LuArchive, LuClock, LuTrash2 } from "react-icons/lu";

interface DashboardSidebarSessionsContextMenuProps {
	showSnoozed: boolean;
	showArchived: boolean;
	/** (RECYCLE-BIN-SESSIONS) Reveal state of the session Recycle Bin. */
	showDeleted: boolean;
	onToggleSnoozed: () => void;
	onToggleArchived: () => void;
	onToggleDeleted: () => void;
	children: React.ReactNode;
}

/**
 * (SESSION-LIFECYCLE) Right-click menu on the Sessions header. Mirrors the
 * project row's reveal toggles — the only way to show or hide the Snoozed
 * Sessions / Archived Sessions / (RECYCLE-BIN-SESSIONS) Recycle Bin
 * subsections — so a snoozed, archived or soft-deleted session is reachable
 * exactly the way a snoozed, archived or deleted project thread is.
 */
export function DashboardSidebarSessionsContextMenu({
	showSnoozed,
	showArchived,
	showDeleted,
	onToggleSnoozed,
	onToggleArchived,
	onToggleDeleted,
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
				<ContextMenuItem onSelect={onToggleDeleted}>
					<LuTrash2 className="size-4 mr-2" />
					{showDeleted ? "Hide Recycle Bin" : "Show Recycle Bin"}
				</ContextMenuItem>
			</ContextMenuContent>
		</ContextMenu>
	);
}
