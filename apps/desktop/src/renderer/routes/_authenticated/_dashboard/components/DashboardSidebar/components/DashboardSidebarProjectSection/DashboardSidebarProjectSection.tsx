import type {
	DraggableAttributes,
	DraggableSyntheticListeners,
} from "@dnd-kit/core";
import { cn } from "@superset/ui/utils";
import { AnimatePresence, motion } from "framer-motion";
import { useMemo } from "react";
import { useDashboardSidebarState } from "renderer/routes/_authenticated/hooks/useDashboardSidebarState";
import type { DashboardSidebarProject } from "../../types";
import { getProjectChildrenWorkspaces } from "../../utils/projectChildren";
import { DashboardSidebarCollapsedProjectContent } from "./components/DashboardSidebarCollapsedProjectContent";
import { DashboardSidebarExpandedProjectContent } from "./components/DashboardSidebarExpandedProjectContent";
import { DashboardSidebarProjectContextMenu } from "./components/DashboardSidebarProjectContextMenu";
import { DashboardSidebarProjectRow } from "./components/DashboardSidebarProjectRow";
import { DashboardSidebarStateSection } from "./components/DashboardSidebarStateSection";
import { useDashboardSidebarProjectSectionActions } from "./hooks/useDashboardSidebarProjectSectionActions";

interface DashboardSidebarProjectSectionProps {
	project: DashboardSidebarProject;
	isSidebarCollapsed?: boolean;
	isDraggingProject?: boolean;
	workspaceShortcutLabels: Map<string, string>;
	onWorkspaceHover: (workspaceId: string) => void | Promise<void>;
	onToggleCollapse: (projectId: string) => void;
	dragHandleListeners?: DraggableSyntheticListeners;
	dragHandleAttributes?: DraggableAttributes;
}

export function DashboardSidebarProjectSection({
	project,
	isSidebarCollapsed = false,
	isDraggingProject = false,
	workspaceShortcutLabels,
	onWorkspaceHover,
	onToggleCollapse,
	dragHandleListeners,
	dragHandleAttributes,
}: DashboardSidebarProjectSectionProps) {
	const flattenedCollapsedWorkspaces = useMemo(
		() => getProjectChildrenWorkspaces(project.children),
		[project.children],
	);

	const {
		cancelRename,
		confirmRemoveFromSidebar,
		deleteSection,
		emptyRecycleBin,
		handleNewSection,
		handleNewWorkspace,
		handleOpenInFinder,
		handleOpenSettings,
		isRenaming,
		renameSection,
		renameValue,
		restoreAllDeleted,
		setRenameValue,
		startRename,
		submitRename,
		toggleSectionCollapsed,
	} = useDashboardSidebarProjectSectionActions({
		project,
	});

	const {
		togglePinProject,
		toggleProjectSectionFlag,
		setProjectSectionFlag,
		unsnoozeAllInProject,
		unarchiveWorkspaces,
	} = useDashboardSidebarState();

	const totalWorkspaceCount = flattenedCollapsedWorkspaces.length;

	// Snoozed + Archived + Recycle Bin render through the same
	// DashboardSidebarStateSection; one config entry per variant keeps the reveal
	// blocks in sync. onEmptyBin is only set for the "deleted" variant.
	const stateSections: Array<{
		variant: "snoozed" | "archived" | "deleted";
		show: boolean;
		workspaces: typeof project.snoozedWorkspaces;
		collapsed: boolean;
		collapsedFlag:
			| "snoozedCollapsed"
			| "archivedCollapsed"
			| "deletedCollapsed";
		showFlag: "showSnoozed" | "showArchived" | "showDeleted";
		onRestoreAll: () => void;
		onEmptyBin?: () => void;
	}> = [
		{
			variant: "snoozed",
			show: project.showSnoozed,
			workspaces: project.snoozedWorkspaces,
			collapsed: project.snoozedCollapsed,
			collapsedFlag: "snoozedCollapsed",
			showFlag: "showSnoozed",
			onRestoreAll: () => unsnoozeAllInProject(project.id),
		},
		{
			variant: "archived",
			show: project.showArchived,
			workspaces: project.archivedWorkspaces,
			collapsed: project.archivedCollapsed,
			collapsedFlag: "archivedCollapsed",
			showFlag: "showArchived",
			onRestoreAll: () =>
				unarchiveWorkspaces(
					project.archivedWorkspaces.map((workspace) => workspace.id),
				),
		},
		// (RECYCLE-BIN) per-project soft-delete bin; restore-all + empty-bin live in
		// the header context menu, the retention "Show all" filter lives in-section.
		{
			variant: "deleted",
			show: project.showDeleted,
			workspaces: project.deletedWorkspaces,
			collapsed: project.deletedCollapsed,
			collapsedFlag: "deletedCollapsed",
			showFlag: "showDeleted",
			onRestoreAll: restoreAllDeleted,
			onEmptyBin: emptyRecycleBin,
		},
	];

	if (isSidebarCollapsed) {
		return (
			<DashboardSidebarProjectContextMenu
				isPinned={project.isPinned}
				onTogglePin={() => togglePinProject(project.id)}
				onCreateSection={handleNewSection}
				onOpenInFinder={handleOpenInFinder}
				onOpenSettings={handleOpenSettings}
				onRemoveFromSidebar={confirmRemoveFromSidebar}
				onRename={startRename}
			>
				<div className={cn("border-b border-border last:border-b-0")}>
					<DashboardSidebarCollapsedProjectContent
						projectId={project.id}
						projectName={project.name}
						iconUrl={project.iconUrl}
						isCollapsed={project.isCollapsed}
						totalWorkspaceCount={totalWorkspaceCount}
						projectChildren={project.children}
						workspaceShortcutLabels={workspaceShortcutLabels}
						onWorkspaceHover={onWorkspaceHover}
						onToggleCollapse={() => onToggleCollapse(project.id)}
					/>
				</div>
			</DashboardSidebarProjectContextMenu>
		);
	}

	return (
		<div className={cn("border-b border-border last:border-b-0")}>
			<DashboardSidebarProjectContextMenu
				isPinned={project.isPinned}
				onTogglePin={() => togglePinProject(project.id)}
				onCreateSection={handleNewSection}
				onOpenInFinder={handleOpenInFinder}
				onOpenSettings={handleOpenSettings}
				onRemoveFromSidebar={confirmRemoveFromSidebar}
				onRename={startRename}
				showSnoozed={project.showSnoozed}
				showArchived={project.showArchived}
				showDeleted={project.showDeleted}
				onToggleSnoozed={() =>
					toggleProjectSectionFlag(project.id, "showSnoozed")
				}
				onToggleArchived={() =>
					toggleProjectSectionFlag(project.id, "showArchived")
				}
				onToggleDeleted={() =>
					toggleProjectSectionFlag(project.id, "showDeleted")
				}
			>
				<DashboardSidebarProjectRow
					projectName={project.name}
					iconUrl={project.iconUrl}
					isCollapsed={project.isCollapsed}
					isRenaming={isRenaming}
					renameValue={renameValue}
					onRenameValueChange={setRenameValue}
					onSubmitRename={submitRename}
					onCancelRename={cancelRename}
					onStartRename={startRename}
					onToggleCollapse={() => onToggleCollapse(project.id)}
					onNewWorkspace={handleNewWorkspace}
					{...(dragHandleAttributes ?? {})}
					{...(dragHandleListeners ?? {})}
				/>
			</DashboardSidebarProjectContextMenu>

			<AnimatePresence initial={false}>
				{!isDraggingProject && (
					<motion.div
						initial={{ height: 0, opacity: 0 }}
						animate={{ height: "auto", opacity: 1 }}
						exit={{ height: 0, opacity: 0 }}
						transition={{ duration: 0.15, ease: "easeOut" }}
						className="overflow-hidden"
					>
						<DashboardSidebarExpandedProjectContent
							projectId={project.id}
							isCollapsed={project.isCollapsed}
							projectChildren={project.children}
							workspaceShortcutLabels={workspaceShortcutLabels}
							onWorkspaceHover={onWorkspaceHover}
							onDeleteSection={deleteSection}
							onRenameSection={renameSection}
							onToggleSectionCollapse={toggleSectionCollapsed}
						/>
						{!project.isCollapsed &&
							stateSections
								.filter((section) => section.show)
								.map((section) => (
									<DashboardSidebarStateSection
										key={section.variant}
										variant={section.variant}
										workspaces={section.workspaces}
										collapsed={section.collapsed}
										onToggleCollapsed={() =>
											toggleProjectSectionFlag(
												project.id,
												section.collapsedFlag,
											)
										}
										onHide={() =>
											setProjectSectionFlag(project.id, section.showFlag, false)
										}
										onRestoreAll={section.onRestoreAll}
										onEmptyBin={section.onEmptyBin}
										onWorkspaceHover={onWorkspaceHover}
									/>
								))}
					</motion.div>
				)}
			</AnimatePresence>
		</div>
	);
}
