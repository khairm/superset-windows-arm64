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
	LuCircleCheck,
	LuClock,
	LuCopy,
	LuEye,
	LuEyeOff,
	LuFolderOpen,
	LuFolderPlus,
	LuGitBranch,
	LuPencil,
	LuPin,
	LuPinOff,
	LuRadioTower,
	LuRotateCcw,
	LuTrash2,
	LuUndo2,
	LuUnlink,
	LuX,
} from "react-icons/lu";
import { useCollections } from "renderer/routes/_authenticated/providers/CollectionsProvider";
import {
	SNOOZE_PRESET_OPTIONS,
	type SnoozeDuration,
} from "renderer/routes/_authenticated/providers/CollectionsProvider/dashboardSidebarLocal";
import { useDashboardSidebarPortKill } from "../../../../hooks/useDashboardSidebarPortKill";
import { useDashboardSidebarHoverActions } from "../../../../providers/DashboardSidebarHoverProvider";
import { useDashboardSidebarWorkspacePorts } from "../../../../providers/DashboardSidebarPortsProvider";
import { ClaudeAccountPicker } from "../ClaudeAccountPicker";

/** Which reveal-able section a workspace row is rendered inside, if any. */
export type WorkspaceSectionState = "snoozed" | "archived" | "deleted";

interface DashboardSidebarWorkspaceContextMenuProps {
	workspaceId: string;
	/** Null for project-less "session" workspaces (no group actions yet). */
	projectId: string | null;
	isInSection?: boolean;
	isLocalWorkspace: boolean;
	isNonGit?: boolean;
	isLocalMainWorkspace?: boolean;
	isPinned: boolean;
	isUnread: boolean;
	/** Set when the row lives in the Snoozed / Archived / Recycle Bin section —
	 * swaps the snooze/archive actions for the matching restore actions. */
	sectionState?: WorkspaceSectionState;
	hasStatus: boolean;
	hasPullRequest: boolean;
	/** Accepted for call-site parity with upstream, deliberately not rendered:
	 * this menu's "Delete" is the (RECYCLE-BIN) soft-delete, while the
	 * CLOSE_WORKSPACE hotkey opens the permanent destroy dialog. */
	showDeleteHotkey?: boolean;
	onTogglePin: () => void;
	onCreateSection: () => void;
	onMoveToSection: (sectionId: string | null) => void;
	onOpenInFinder: () => void;
	onCopyPath: () => void;
	onCopyBranchName: () => void;
	onRemoveFromSidebar: () => void;
	onRename?: () => void;
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
	onMarkCompleted?: () => void;
	onClearStatus: () => void;
	onRemovePullRequest: () => void;
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
	workspaceId,
	projectId,
	isInSection,
	isLocalWorkspace,
	isNonGit = false,
	isLocalMainWorkspace = false,
	isPinned,
	isUnread,
	sectionState,
	hasStatus,
	hasPullRequest,
	onTogglePin,
	onCreateSection,
	onMoveToSection,
	onOpenInFinder,
	onCopyPath,
	onCopyBranchName,
	onRemoveFromSidebar,
	onRename,
	onDelete,
	onRestore,
	onDeletePermanently,
	onToggleUnread,
	onSnooze,
	onUnsnooze,
	onArchive,
	onUnarchive,
	onMarkCompleted,
	onClearStatus,
	onRemovePullRequest,
	children,
}: DashboardSidebarWorkspaceContextMenuProps) {
	const collections = useCollections();
	const { setContextMenuOpen } = useDashboardSidebarHoverActions();
	const isSectioned = sectionState !== undefined;
	// Group actions mutate placement (sectionId/tabOrder). They need a project
	// (sessions have none) and a row that actually renders its placement — a
	// pinned, main, or sectioned row does not.
	const canUseGroupActions =
		!isPinned && !isLocalMainWorkspace && !isSectioned && projectId !== null;
	const portGroup = useDashboardSidebarWorkspacePorts(workspaceId);
	const { isPending: isKillingPorts, killPorts } =
		useDashboardSidebarPortKill();
	const ports = portGroup?.ports ?? [];
	const { data: sections = [] } = useLiveQuery(
		(q) =>
			q
				.from({ sidebarSections: collections.v2SidebarSections })
				// `?? ""` and not null: TanStack DB's eq(col, null) never
				// matches, and no section can have an empty-string projectId,
				// so sessions resolve to an empty list without relying on the
				// eq(null) quirk.
				.where(({ sidebarSections }) =>
					eq(sidebarSections.projectId, projectId ?? ""),
				)
				.orderBy(({ sidebarSections }) => sidebarSections.tabOrder, "asc")
				.select(({ sidebarSections }) => ({
					id: sidebarSections.sectionId,
					name: sidebarSections.name,
					color: sidebarSections.color,
				})),
		[collections, projectId],
	);
	const handleCloseAllPorts = () => {
		if (isKillingPorts) return;
		void killPorts(ports);
	};

	return (
		<ContextMenu onOpenChange={setContextMenuOpen}>
			<ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
			<ContextMenuContent onCloseAutoFocus={(event) => event.preventDefault()}>
				<ClaudeAccountPicker workspaceId={workspaceId} />
				<ContextMenuSeparator />
				{/* A snoozed / archived / in-bin row isn't in the active lane, so the
				Pinned section can't show it — offer Pin only on normal rows. */}
				{!isSectioned && (
					<>
						<ContextMenuItem onSelect={onTogglePin}>
							{isPinned ? (
								<>
									<LuPinOff className="size-4 mr-2" />
									Unpin
								</>
							) : (
								<>
									<LuPin className="size-4 mr-2" />
									Pin
								</>
							)}
						</ContextMenuItem>
						<ContextMenuSeparator />
					</>
				)}
				{onRename && (
					<ContextMenuItem onSelect={onRename}>
						<LuPencil className="size-4 mr-2" />
						Rename
					</ContextMenuItem>
				)}
				{isLocalWorkspace && (
					<>
						{onRename && <ContextMenuSeparator />}
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
						{!isLocalWorkspace && onRename && <ContextMenuSeparator />}
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
				{hasPullRequest && (
					<ContextMenuItem onSelect={onRemovePullRequest}>
						<LuUnlink className="size-4 mr-2" />
						Remove PR Link
					</ContextMenuItem>
				)}
				{canUseGroupActions && (
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
								{onMarkCompleted && (
									<ContextMenuItem onSelect={onMarkCompleted}>
										<LuCircleCheck className="size-4 mr-2" />
										Mark completed
									</ContextMenuItem>
								)}
								<SnoozeSubmenu label="Snooze" onSnooze={onSnooze} />
								<ContextMenuItem onSelect={onArchive}>
									<LuArchive className="size-4 mr-2" />
									Archive
								</ContextMenuItem>
							</>
						)}
						<ContextMenuSeparator />
						{ports.length > 0 && (
							<ContextMenuItem
								onSelect={handleCloseAllPorts}
								disabled={isKillingPorts}
								variant="destructive"
							>
								<LuRadioTower className="size-4 mr-2" />
								Close all ports
							</ContextMenuItem>
						)}
						<ContextMenuItem onSelect={onRemoveFromSidebar}>
							<LuX className="size-4 mr-2" />
							Remove from Sidebar
						</ContextMenuItem>
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
