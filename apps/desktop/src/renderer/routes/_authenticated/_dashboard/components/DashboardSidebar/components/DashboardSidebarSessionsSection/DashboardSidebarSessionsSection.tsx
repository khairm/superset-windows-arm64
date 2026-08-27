import {
	SortableContext,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { LuPlus } from "react-icons/lu";
import { useV2UserPreferences } from "renderer/hooks/useV2UserPreferences";
import { useDashboardSidebarState } from "renderer/routes/_authenticated/hooks/useDashboardSidebarState";
import type { SessionSectionFlag } from "renderer/routes/_authenticated/providers/CollectionsProvider/dashboardSidebarLocal";
import { useOpenNewSessionModal } from "renderer/stores/new-workspace-modal";
import { useSidebarSectionsCollapseStore } from "renderer/stores/sidebar-sections-collapse";
import {
	dropZoneId,
	parseId,
	SESSIONS_CONTAINER,
	useDashboardSidebarDnd,
} from "../../hooks/useSidebarDnd";
import type { DashboardSidebarWorkspace } from "../../types";
import { DashboardSidebarSectionHeader } from "../DashboardSidebarSectionHeader";
import { DashboardSidebarStateSection } from "../DashboardSidebarStateSection";
import { DashboardSidebarWorkspaceItem } from "../DashboardSidebarWorkspaceItem";
import { SidebarDropZone } from "../SidebarDropZone";
import { SortableWorkspaceItem } from "../SortableWorkspaceItem";
import { DashboardSidebarSessionsContextMenu } from "./components/DashboardSidebarSessionsContextMenu";

interface DashboardSidebarSessionsSectionProps {
	sessionWorkspaces: DashboardSidebarWorkspace[];
	/** (SESSION-LIFECYCLE) Rows for the Snoozed Sessions subsection, soonest
	 * wake first. */
	snoozedSessionWorkspaces?: DashboardSidebarWorkspace[];
	/** (SESSION-LIFECYCLE) Rows for the Archived Sessions subsection, most
	 * recently archived first. */
	archivedSessionWorkspaces?: DashboardSidebarWorkspace[];
	/** (RECYCLE-BIN-SESSIONS) Rows for the session Recycle Bin, most recently
	 * deleted first. */
	deletedSessionWorkspaces?: DashboardSidebarWorkspace[];
	isCollapsed?: boolean;
	workspaceShortcutLabels?: Map<string, string>;
	onWorkspaceHover: (workspaceId: string) => void | Promise<void>;
}

/**
 * Top-level "Sessions" section, rendered above the Projects header. The
 * header (and its "+", which opens the create surface with "No project"
 * preselected) always renders in expanded mode — like the Projects header —
 * so sessions stay discoverable at zero, and toggles a persisted section
 * collapse that hides the rows. Expanded rows are sortable: sessions
 * reorder among themselves, can be dragged into the Pinned section (pin), and
 * a pinned session dragged back here unpins. Collapsed rail renders a plain
 * icon stack with a trailing divider, matching the Pinned section.
 *
 * (SESSION-LIFECYCLE) A snoozed or archived session leaves the active list and
 * moves into the matching subsection below, which the header's right-click menu
 * reveals or hides. (RECYCLE-BIN-SESSIONS) A soft-deleted session lands in the
 * Recycle Bin subsection the same way — the only surface it renders on.
 * Sessions never reach the Kanban board: every card is bound to a sidebar
 * project, and a session has none.
 */
export function DashboardSidebarSessionsSection({
	sessionWorkspaces,
	snoozedSessionWorkspaces = [],
	archivedSessionWorkspaces = [],
	deletedSessionWorkspaces = [],
	isCollapsed = false,
	workspaceShortcutLabels,
	onWorkspaceHover,
}: DashboardSidebarSessionsSectionProps) {
	const openNewSessionModal = useOpenNewSessionModal();
	const { preferences, setSessionSectionFlag, toggleSessionSectionFlag } =
		useV2UserPreferences();
	const { restoreWorkspace, unsnoozeAllInProject, unarchiveWorkspaces } =
		useDashboardSidebarState();
	const { sessionItems, workspacesById, activeWorkspaceHome } =
		useDashboardSidebarDnd();
	const isSectionCollapsed = useSidebarSectionsCollapseStore(
		(s) => s.collapsed.sessions,
	);
	// Only a project-less session may land here, and only when there are no
	// rows to target directly. An empty section has nothing to hide, so the
	// zone renders regardless of the section collapse.
	const dropZoneEligible =
		!isCollapsed &&
		sessionItems.length === 0 &&
		activeWorkspaceHome === SESSIONS_CONTAINER;

	if (isCollapsed) {
		if (sessionWorkspaces.length === 0) return null;
		return (
			<div className="flex flex-col gap-0.5 py-1">
				{sessionWorkspaces.map((workspace) => (
					<DashboardSidebarWorkspaceItem
						key={workspace.id}
						workspace={workspace}
						isCollapsed
						isInSection={false}
						onHoverCardOpen={onWorkspaceHover}
					/>
				))}
				<div className="mx-3 mt-1 border-b border-border" />
			</div>
		);
	}

	// One config entry per subsection keeps the reveal blocks in sync, the
	// same way DashboardSidebarProjectSection drives its own state sections.
	const stateSections: Array<{
		variant: "snoozed" | "archived" | "deleted";
		title: string;
		show: boolean;
		workspaces: DashboardSidebarWorkspace[];
		collapsed: boolean;
		collapsedFlag: SessionSectionFlag;
		showFlag: SessionSectionFlag;
		onRestoreAll: () => void;
	}> = [
		{
			variant: "snoozed",
			title: "Snoozed Sessions",
			show: preferences.showSnoozedSessions,
			workspaces: snoozedSessionWorkspaces,
			collapsed: preferences.snoozedSessionsCollapsed,
			collapsedFlag: "snoozedSessionsCollapsed",
			showFlag: "showSnoozedSessions",
			// Sessions hold a null projectId, which is exactly the lane this
			// bulk-unsnooze filters on.
			onRestoreAll: () => unsnoozeAllInProject(null),
		},
		{
			variant: "archived",
			title: "Archived Sessions",
			show: preferences.showArchivedSessions,
			workspaces: archivedSessionWorkspaces,
			collapsed: preferences.archivedSessionsCollapsed,
			collapsedFlag: "archivedSessionsCollapsed",
			showFlag: "showArchivedSessions",
			onRestoreAll: () =>
				unarchiveWorkspaces(
					archivedSessionWorkspaces.map((workspace) => workspace.id),
				),
		},
		{
			// (RECYCLE-BIN-SESSIONS) Restore returns a soft-deleted session to the
			// ACTIVE lane, exactly like the per-project bin. Permanent destroy stays
			// per-row ("Delete permanently") inside the bin.
			variant: "deleted",
			title: "Recycle Bin",
			show: preferences.showDeletedSessions,
			workspaces: deletedSessionWorkspaces,
			collapsed: preferences.deletedSessionsCollapsed,
			collapsedFlag: "deletedSessionsCollapsed",
			showFlag: "showDeletedSessions",
			onRestoreAll: () => {
				for (const workspace of deletedSessionWorkspaces) {
					restoreWorkspace(workspace.id);
				}
			},
		},
	];

	return (
		<div className="mt-3 pb-1 first:mt-0">
			{/* (SESSION-LIFECYCLE) The reveal toggles for the subsections below
			    live on the header's right-click menu. The wrapper div is the
			    trigger's `asChild` target: the shared section header renders its
			    own strip and does not forward foreign props. */}
			<DashboardSidebarSessionsContextMenu
				showSnoozed={preferences.showSnoozedSessions}
				showArchived={preferences.showArchivedSessions}
				showDeleted={preferences.showDeletedSessions}
				onToggleSnoozed={() => toggleSessionSectionFlag("showSnoozedSessions")}
				onToggleArchived={() =>
					toggleSessionSectionFlag("showArchivedSessions")
				}
				onToggleDeleted={() => toggleSessionSectionFlag("showDeletedSessions")}
			>
				<div>
					<DashboardSidebarSectionHeader label="Sessions" section="sessions">
						<Tooltip delayDuration={700}>
							<TooltipTrigger asChild>
								<button
									type="button"
									aria-label="New session"
									onClick={(event) => {
										event.stopPropagation();
										openNewSessionModal();
									}}
									onKeyDown={(event) => event.stopPropagation()}
									className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-fill-hover hover:text-foreground"
								>
									<LuPlus className="size-3.5" />
								</button>
							</TooltipTrigger>
							<TooltipContent side="bottom">New session</TooltipContent>
						</Tooltip>
					</DashboardSidebarSectionHeader>
				</div>
			</DashboardSidebarSessionsContextMenu>
			{!isSectionCollapsed && (
				<SortableContext
					items={sessionItems}
					strategy={verticalListSortingStrategy}
				>
					{sessionItems.map((id) => {
						const parsed = parseId(id);
						if (!parsed || parsed.type !== "workspace") return null;
						const workspace = workspacesById.get(parsed.realId);
						if (!workspace) return null;
						return (
							<SortableWorkspaceItem
								key={String(id)}
								sortableId={String(id)}
								workspace={workspace}
								shortcutLabel={workspaceShortcutLabels?.get(parsed.realId)}
								onHoverCardOpen={onWorkspaceHover}
							/>
						);
					})}
				</SortableContext>
			)}
			{dropZoneEligible && (
				<SidebarDropZone
					dropZoneId={dropZoneId(SESSIONS_CONTAINER)}
					label="Drop to unpin"
				/>
			)}
			{!isSectionCollapsed &&
				stateSections
					.filter((section) => section.show)
					.map((section) => (
						<DashboardSidebarStateSection
							key={section.variant}
							variant={section.variant}
							title={section.title}
							workspaces={section.workspaces}
							collapsed={section.collapsed}
							onToggleCollapsed={() =>
								toggleSessionSectionFlag(section.collapsedFlag)
							}
							onHide={() => setSessionSectionFlag(section.showFlag, false)}
							onRestoreAll={section.onRestoreAll}
							onWorkspaceHover={onWorkspaceHover}
						/>
					))}
		</div>
	);
}
