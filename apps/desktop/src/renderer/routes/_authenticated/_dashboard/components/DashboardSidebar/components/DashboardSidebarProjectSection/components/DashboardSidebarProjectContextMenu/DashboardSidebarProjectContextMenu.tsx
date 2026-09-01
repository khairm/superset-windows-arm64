import { Trans } from "@lingui/react/macro";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuSub,
	ContextMenuSubContent,
	ContextMenuSubTrigger,
	ContextMenuTrigger,
} from "@superset/ui/context-menu";
import {
	LuArchive,
	LuClock,
	LuEye,
	LuFolderInput,
	LuFolderOpen,
	LuFolderPlus,
	LuPencil,
	LuPin,
	LuPinOff,
	LuSettings,
	LuTrash2,
	LuX,
} from "react-icons/lu";
import { useV2UserPreferences } from "renderer/hooks/useV2UserPreferences";

interface DashboardSidebarProjectContextMenuProps {
	projectId: string;
	/** Snooze/Archive/Recycle Bin reveal toggles. Omitted in the collapsed
	 * sidebar — it renders no sections — so the menu items are hidden there too. */
	showSnoozed?: boolean;
	showArchived?: boolean;
	// (RECYCLE-BIN) reveal toggle for the per-project Recycle Bin section.
	showDeleted?: boolean;
	// (ACTIVE-FIRST) Manual pin state + toggle. Pinned projects sort into the top
	// sidebar tier (pinned > active > idle).
	isPinned?: boolean;
	onTogglePin?: () => void;
	onCreateSection: () => void;
	onImportWorktrees: () => void;
	onOpenInFinder: () => void;
	onOpenSettings: () => void;
	onRemoveFromSidebar: () => void;
	onRename: () => void;
	onToggleSnoozed?: () => void;
	onToggleArchived?: () => void;
	// (RECYCLE-BIN) reveal toggle for the per-project Recycle Bin section.
	onToggleDeleted?: () => void;
	children: React.ReactNode;
}

export function DashboardSidebarProjectContextMenu({
	projectId,
	showSnoozed,
	showArchived,
	showDeleted,
	isPinned,
	onTogglePin,
	onCreateSection,
	onImportWorktrees,
	onOpenInFinder,
	onOpenSettings,
	onRemoveFromSidebar,
	onRename,
	onToggleSnoozed,
	onToggleArchived,
	onToggleDeleted,
	children,
}: DashboardSidebarProjectContextMenuProps) {
	const { preferences, setTagFolderHidden } = useV2UserPreferences();
	const hiddenTags = preferences.hiddenTagFolders[projectId] ?? [];
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
					<Trans id="dashboard.sidebar.projectMenu.rename">Rename</Trans>
				</ContextMenuItem>
				<ContextMenuSeparator />
				<ContextMenuItem onSelect={onOpenInFinder}>
					<LuFolderOpen className="size-4 mr-2" />
					<Trans id="dashboard.sidebar.projectMenu.openInFinder">
						Open in Finder
					</Trans>
				</ContextMenuItem>
				<ContextMenuItem onSelect={onOpenSettings}>
					<LuSettings className="size-4 mr-2" />
					<Trans id="dashboard.sidebar.projectMenu.projectSettings">
						Project Settings
					</Trans>
				</ContextMenuItem>
				<ContextMenuItem onSelect={onCreateSection}>
					<LuFolderPlus className="size-4 mr-2" />
					<Trans id="dashboard.sidebar.projectMenu.newGroup">New group</Trans>
				</ContextMenuItem>
				{hiddenTags.length > 0 ? (
					<ContextMenuSub>
						<ContextMenuSubTrigger>
							<LuEye className="size-4 mr-2" />
							<Trans id="dashboard.sidebar.projectMenu.hiddenFolders">
								Hidden folders
							</Trans>
						</ContextMenuSubTrigger>
						<ContextMenuSubContent className="w-48 max-h-80 overflow-y-auto">
							{hiddenTags.map((tag) => (
								<ContextMenuItem
									key={tag}
									onSelect={() => setTagFolderHidden(projectId, tag, false)}
								>
									{tag}
								</ContextMenuItem>
							))}
						</ContextMenuSubContent>
					</ContextMenuSub>
				) : null}
				<ContextMenuItem onSelect={onImportWorktrees}>
					<LuFolderInput className="size-4 mr-2" />
					<Trans id="dashboard.sidebar.projectMenu.importWorktrees">
						Import untracked worktrees
					</Trans>
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
						{onToggleDeleted && (
							<ContextMenuItem onSelect={onToggleDeleted}>
								<LuTrash2 className="size-4 mr-2" />
								{showDeleted ? "Hide Recycle Bin" : "Show Recycle Bin"}
							</ContextMenuItem>
						)}
					</>
				)}
				<ContextMenuSeparator />
				<ContextMenuItem onSelect={onRemoveFromSidebar}>
					<LuX className="size-4 mr-2" />
					<Trans id="dashboard.sidebar.projectMenu.removeFromSidebar">
						Remove from Sidebar
					</Trans>
				</ContextMenuItem>
			</ContextMenuContent>
		</ContextMenu>
	);
}
