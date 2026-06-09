import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "@superset/ui/context-menu";
import {
	LuArchive,
	LuClock,
	LuFolderOpen,
	LuFolderPlus,
	LuPencil,
	LuPin,
	LuPinOff,
	LuSettings,
	LuX,
} from "react-icons/lu";

interface DashboardSidebarProjectContextMenuProps {
	/** Snooze/Archive reveal toggles. Omitted in the collapsed sidebar — it
	 * renders no sections — so the menu items are hidden there too. */
	showSnoozed?: boolean;
	showArchived?: boolean;
	// (ACTIVE-FIRST) Manual pin state + toggle. Pinned projects sort into the top
	// sidebar tier (pinned > active > idle).
	isPinned?: boolean;
	onTogglePin?: () => void;
	onCreateSection: () => void;
	onOpenInFinder: () => void;
	onOpenSettings: () => void;
	onRemoveFromSidebar: () => void;
	onRename: () => void;
	onToggleSnoozed?: () => void;
	onToggleArchived?: () => void;
	children: React.ReactNode;
}

export function DashboardSidebarProjectContextMenu({
	showSnoozed,
	showArchived,
	isPinned,
	onTogglePin,
	onCreateSection,
	onOpenInFinder,
	onOpenSettings,
	onRemoveFromSidebar,
	onRename,
	onToggleSnoozed,
	onToggleArchived,
	children,
}: DashboardSidebarProjectContextMenuProps) {
	return (
		<ContextMenu>
			<ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
			<ContextMenuContent onCloseAutoFocus={(event) => event.preventDefault()}>
				{onTogglePin && (
					<ContextMenuItem onSelect={onTogglePin}>
						{isPinned ? (
							<LuPinOff className="size-4 mr-2" />
						) : (
							<LuPin className="size-4 mr-2" />
						)}
						{isPinned ? "Unpin" : "Pin to top"}
					</ContextMenuItem>
				)}
				<ContextMenuItem onSelect={onRename}>
					<LuPencil className="size-4 mr-2" />
					Rename
				</ContextMenuItem>
				<ContextMenuSeparator />
				<ContextMenuItem onSelect={onOpenInFinder}>
					<LuFolderOpen className="size-4 mr-2" />
					Open in Finder
				</ContextMenuItem>
				<ContextMenuItem onSelect={onOpenSettings}>
					<LuSettings className="size-4 mr-2" />
					Project Settings
				</ContextMenuItem>
				<ContextMenuItem onSelect={onCreateSection}>
					<LuFolderPlus className="size-4 mr-2" />
					New group
				</ContextMenuItem>
				{onToggleSnoozed && onToggleArchived && (
					<>
						<ContextMenuSeparator />
						<ContextMenuItem onSelect={onToggleSnoozed}>
							<LuClock className="size-4 mr-2" />
							{showSnoozed ? "Hide snoozed" : "Show snoozed"}
						</ContextMenuItem>
						<ContextMenuItem onSelect={onToggleArchived}>
							<LuArchive className="size-4 mr-2" />
							{showArchived ? "Hide archived" : "Show archived"}
						</ContextMenuItem>
					</>
				)}
				<ContextMenuSeparator />
				<ContextMenuItem
					onSelect={onRemoveFromSidebar}
					className="text-destructive focus:text-destructive"
				>
					<LuX className="size-4 mr-2 text-destructive" />
					Remove from Sidebar
				</ContextMenuItem>
			</ContextMenuContent>
		</ContextMenu>
	);
}
