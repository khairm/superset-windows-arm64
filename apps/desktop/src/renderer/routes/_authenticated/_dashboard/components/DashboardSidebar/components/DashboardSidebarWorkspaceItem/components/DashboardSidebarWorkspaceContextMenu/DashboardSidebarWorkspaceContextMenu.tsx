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
import { eq } from "@tanstack/db";
import { useLiveQuery } from "@tanstack/react-db";
import { useState } from "react";
import {
	LuArchive,
	LuArchiveRestore,
	LuArrowRightLeft,
	LuArrowUp,
	LuBellOff,
	LuClock,
	LuCopy,
	LuEye,
	LuEyeOff,
	LuFolderOpen,
	LuFolderPlus,
	LuGitBranch,
	LuPencil,
	LuRotateCcw,
	LuTrash2,
	LuUndo2,
} from "react-icons/lu";
import { useCollections } from "renderer/routes/_authenticated/providers/CollectionsProvider";
import {
	SNOOZE_PRESET_OPTIONS,
	type SnoozeDuration,
} from "renderer/routes/_authenticated/providers/CollectionsProvider/dashboardSidebarLocal";
import { useDashboardSidebarHover } from "../../../../providers/DashboardSidebarHoverProvider";

/** Which reveal-able section a workspace row is rendered inside, if any. */
export type WorkspaceSectionState = "snoozed" | "archived" | "deleted";

interface DashboardSidebarWorkspaceContextMenuProps {
	projectId: string;
	isInSection?: boolean;
	isLocalWorkspace: boolean;
	isNonGit?: boolean;
	isPinned?: boolean;
	isUnread: boolean;
	/** Set when the row lives in the Snoozed / Archived / Recycle Bin section —
	 * swaps the snooze/archive actions for the matching restore actions. */
	sectionState?: WorkspaceSectionState;
	hasStatus: boolean;
	showDeleteHotkey?: boolean;
	onCreateSection: () => void;
	onMoveToSection: (sectionId: string | null) => void;
	onOpenInFinder: () => void;
	onCopyPath: () => void;
	onCopyBranchName: () => void;
	onRename: () => void;
	/** Default-mode Delete: a silent soft-delete to the Recycle Bin (RECYCLE-BIN).
	 * Omitted (undefined) for mains, which are never deletable. */
	onDelete?: () => void;
	/** (RECYCLE-BIN) Restore an in-bin row straight back to active. */
	onRestore?: () => void;
	/** (RECYCLE-BIN) Open the destroy dialog to PERMANENTLY delete an in-bin row
	 * (worktree + optional branch). The only path to the real git destroy. */
	onDeletePermanently?: () => void;
	onToggleUnread: () => void;
	onSnooze: (duration: SnoozeDuration) => void;
	onUnsnooze: () => void;
	onArchive: () => void;
	onUnarchive: () => void;
	onClearStatus: () => void;
	children: React.ReactNode;
}

/** Snooze duration picker: the presets plus an inline "N hours" field. */
function SnoozeSubmenu({
	label,
	onSnooze,
}: {
	label: string;
	onSnooze: (duration: SnoozeDuration) => void;
}) {
	const [hours, setHours] = useState("");
	const submitHours = () => {
		// Round fractional input to whole hours; reject non-positive / non-finite.
		const parsed = Math.round(Number(hours));
		if (Number.isFinite(parsed) && parsed > 0) {
			onSnooze({ kind: "hours", hours: parsed });
		}
	};

	return (
		<ContextMenuSub>
			<ContextMenuSubTrigger>
				<LuClock className="size-4 mr-2" />
				{label}
			</ContextMenuSubTrigger>
			<ContextMenuSubContent>
				{SNOOZE_PRESET_OPTIONS.map((option) => (
					<ContextMenuItem
						key={option.id}
						onSelect={() => onSnooze(option.duration)}
					>
						{option.label}
					</ContextMenuItem>
				))}
				<ContextMenuSeparator />
				<div className="flex items-center gap-1.5 px-2 py-1">
					<input
						type="number"
						min={1}
						value={hours}
						placeholder="N"
						aria-label="Custom snooze hours"
						className="h-6 w-12 rounded border border-input bg-transparent px-1 text-xs outline-none"
						onClick={(event) => event.stopPropagation()}
						onChange={(event) => setHours(event.target.value)}
						onKeyDown={(event) => {
							event.stopPropagation();
							if (event.key === "Enter") {
								event.preventDefault();
								submitHours();
							}
						}}
					/>
					<span className="text-xs text-muted-foreground">hours</span>
				</div>
			</ContextMenuSubContent>
		</ContextMenuSub>
	);
}

export function DashboardSidebarWorkspaceContextMenu({
	projectId,
	isInSection,
	isLocalWorkspace,
	isNonGit = false,
	isPinned = false,
	isUnread,
	sectionState,
	hasStatus,
	onCreateSection,
	onMoveToSection,
	onOpenInFinder,
	onCopyPath,
	onCopyBranchName,
	onRename,
	onDelete,
	onRestore,
	onDeletePermanently,
	onToggleUnread,
	onSnooze,
	onUnsnooze,
	onArchive,
	onUnarchive,
	onClearStatus,
	children,
}: DashboardSidebarWorkspaceContextMenuProps) {
	const collections = useCollections();
	const { setContextMenuOpen } = useDashboardSidebarHover();
	const isSectioned = sectionState !== undefined;
	const { data: sections = [] } = useLiveQuery(
		(q) =>
			q
				.from({ sidebarSections: collections.v2SidebarSections })
				.where(({ sidebarSections }) =>
					eq(sidebarSections.projectId, projectId),
				)
				.orderBy(({ sidebarSections }) => sidebarSections.tabOrder, "asc")
				.select(({ sidebarSections }) => ({
					id: sidebarSections.sectionId,
					name: sidebarSections.name,
					color: sidebarSections.color,
				})),
		[collections, projectId],
	);

	return (
		<ContextMenu onOpenChange={setContextMenuOpen}>
			<ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
			<ContextMenuContent onCloseAutoFocus={(event) => event.preventDefault()}>
				<ContextMenuItem onSelect={onRename}>
					<LuPencil className="size-4 mr-2" />
					Rename
				</ContextMenuItem>
				{isLocalWorkspace && (
					<>
						<ContextMenuSeparator />
						<ContextMenuItem onSelect={onOpenInFinder}>
							<LuFolderOpen className="size-4 mr-2" />
							Open in Finder
						</ContextMenuItem>
						<ContextMenuItem onSelect={onCopyPath}>
							<LuCopy className="size-4 mr-2" />
							Copy Path
						</ContextMenuItem>
					</>
				)}
				{/* (NON-GIT WORKSPACE) hide branch/git actions — the marker branch is
				not a real ref, so copying it is meaningless. */}
				{!isNonGit && (
					<>
						{!isLocalWorkspace && <ContextMenuSeparator />}
						<ContextMenuItem onSelect={onCopyBranchName}>
							<LuGitBranch className="size-4 mr-2" />
							Copy Branch Name
						</ContextMenuItem>
					</>
				)}
				{!isSectioned && (
					<>
						<ContextMenuSeparator />
						<ContextMenuItem onSelect={onToggleUnread}>
							{isUnread ? (
								<>
									<LuEye className="size-4 mr-2" />
									Mark as Read
								</>
							) : (
								<>
									<LuEyeOff className="size-4 mr-2" />
									Mark as Unread
								</>
							)}
						</ContextMenuItem>
						{hasStatus && (
							<ContextMenuItem onSelect={onClearStatus}>
								<LuBellOff className="size-4 mr-2" />
								Clear Status
							</ContextMenuItem>
						)}
					</>
				)}
				{!isPinned && !isSectioned && (
					<>
						<ContextMenuSeparator />
						<ContextMenuItem onSelect={onCreateSection}>
							<LuFolderPlus className="size-4 mr-2" />
							New group from workspace
						</ContextMenuItem>
						{(sections.length > 0 || isInSection) && <ContextMenuSeparator />}
						{sections.length > 0 && (
							<ContextMenuSub>
								<ContextMenuSubTrigger>
									<LuArrowRightLeft className="size-4 mr-2" />
									Move to group
								</ContextMenuSubTrigger>
								<ContextMenuSubContent>
									{sections.map((section) => (
										<ContextMenuItem
											key={section.id}
											onSelect={() => onMoveToSection(section.id)}
										>
											{section.color && (
												<span
													className="size-2 shrink-0 rounded-full mr-2"
													style={{ backgroundColor: section.color }}
												/>
											)}
											{section.name}
										</ContextMenuItem>
									))}
								</ContextMenuSubContent>
							</ContextMenuSub>
						)}
						{isInSection && (
							<ContextMenuItem onSelect={() => onMoveToSection(null)}>
								<LuArrowUp className="size-4 mr-2" />
								Ungroup
							</ContextMenuItem>
						)}
					</>
				)}
				{/* (RECYCLE-BIN) An in-bin row offers only Restore + Delete permanently —
				snooze/archive are meaningless once a thread is soft-deleted. */}
				{sectionState === "deleted" ? (
					<>
						<ContextMenuSeparator />
						{onRestore && (
							<ContextMenuItem onSelect={onRestore}>
								<LuRotateCcw className="size-4 mr-2" />
								Restore
							</ContextMenuItem>
						)}
						{onDeletePermanently && (
							<ContextMenuItem
								onSelect={onDeletePermanently}
								className="text-destructive focus:text-destructive"
							>
								<LuTrash2 className="size-4 mr-2 text-destructive" />
								Delete permanently
							</ContextMenuItem>
						)}
					</>
				) : (
					<>
						<ContextMenuSeparator />
						{sectionState === "snoozed" ? (
							<>
								<ContextMenuItem onSelect={onUnsnooze}>
									<LuUndo2 className="size-4 mr-2" />
									Unsnooze now
								</ContextMenuItem>
								<SnoozeSubmenu label="Re-snooze" onSnooze={onSnooze} />
								<ContextMenuItem onSelect={onArchive}>
									<LuArchive className="size-4 mr-2" />
									Archive
								</ContextMenuItem>
							</>
						) : sectionState === "archived" ? (
							<>
								<ContextMenuItem onSelect={onUnarchive}>
									<LuArchiveRestore className="size-4 mr-2" />
									Unarchive
								</ContextMenuItem>
								<SnoozeSubmenu label="Snooze" onSnooze={onSnooze} />
							</>
						) : (
							<>
								<SnoozeSubmenu label="Snooze" onSnooze={onSnooze} />
								<ContextMenuItem onSelect={onArchive}>
									<LuArchive className="size-4 mr-2" />
									Archive
								</ContextMenuItem>
							</>
						)}
						{onDelete ? (
							<>
								<ContextMenuSeparator />
								<ContextMenuItem
									onSelect={onDelete}
									className="text-destructive focus:text-destructive"
								>
									<LuTrash2 className="size-4 mr-2 text-destructive" />
									{/* (RECYCLE-BIN) No keyboard-shortcut hint here: this "Delete"
									soft-deletes to the Recycle Bin, whereas the CLOSE_WORKSPACE
									hotkey still opens the PERMANENT destroy dialog (see
									_dashboard/layout.tsx) — advertising it beside a soft-delete
									would point at a different, destructive action. */}
									Delete
								</ContextMenuItem>
							</>
						) : null}
					</>
				)}
			</ContextMenuContent>
		</ContextMenu>
	);
}
