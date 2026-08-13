import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { LuPlus } from "react-icons/lu";
import { useV2UserPreferences } from "renderer/hooks/useV2UserPreferences";
import { useDashboardSidebarState } from "renderer/routes/_authenticated/hooks/useDashboardSidebarState";
import type { SessionSectionFlag } from "renderer/routes/_authenticated/providers/CollectionsProvider/dashboardSidebarLocal";
import { useOpenNewSessionModal } from "renderer/stores/new-workspace-modal";
import type { DashboardSidebarWorkspace } from "../../types";
import { DashboardSidebarStateSection } from "../DashboardSidebarStateSection";
import { DashboardSidebarWorkspaceItem } from "../DashboardSidebarWorkspaceItem";
import { DashboardSidebarSessionsContextMenu } from "./components/DashboardSidebarSessionsContextMenu";

interface DashboardSidebarSessionsSectionProps {
	sessionWorkspaces: DashboardSidebarWorkspace[];
	/** (SESSION-LIFECYCLE) Rows for the Snoozed Sessions subsection, soonest
	 * wake first. */
	snoozedSessionWorkspaces?: DashboardSidebarWorkspace[];
	/** (SESSION-LIFECYCLE) Rows for the Archived Sessions subsection, most
	 * recently archived first. */
	archivedSessionWorkspaces?: DashboardSidebarWorkspace[];
	isCollapsed?: boolean;
	/** The workspaces-list collapse toggle hides rows; the header stays. */
	rowsHidden?: boolean;
	workspaceShortcutLabels?: Map<string, string>;
	onWorkspaceHover: (workspaceId: string) => void | Promise<void>;
}

/**
 * Top-level "Sessions" section, rendered above the Projects header. The
 * header (and its "+", which opens the create surface with "No project"
 * preselected) always renders in expanded mode — like the Projects header —
 * so sessions stay discoverable at zero. Collapsed rail renders a plain icon
 * stack with a trailing divider, matching the Pinned section.
 *
 * (SESSION-LIFECYCLE) A snoozed or archived session leaves the active list and
 * moves into the matching subsection below, which the header's right-click menu
 * reveals or hides. Sessions never reach the Kanban board: every card is bound
 * to a sidebar project, and a session has none.
 */
export function DashboardSidebarSessionsSection({
	sessionWorkspaces,
	snoozedSessionWorkspaces = [],
	archivedSessionWorkspaces = [],
	isCollapsed = false,
	rowsHidden = false,
	workspaceShortcutLabels,
	onWorkspaceHover,
}: DashboardSidebarSessionsSectionProps) {
	const openNewSessionModal = useOpenNewSessionModal();
	const { preferences, setSessionSectionFlag, toggleSessionSectionFlag } =
		useV2UserPreferences();
	const { unsnoozeAllInProject, unarchiveWorkspaces } =
		useDashboardSidebarState();

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
						onHoverCardOpen={() => onWorkspaceHover(workspace.id)}
					/>
				))}
				<div className="mx-3 mt-1 border-b border-border" />
			</div>
		);
	}

	// One config entry per subsection keeps the two reveal blocks in sync, the
	// same way DashboardSidebarProjectSection drives its own state sections.
	const stateSections: Array<{
		variant: "snoozed" | "archived";
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
	];

	return (
		<div className="pb-1">
			<DashboardSidebarSessionsContextMenu
				showSnoozed={preferences.showSnoozedSessions}
				showArchived={preferences.showArchivedSessions}
				onToggleSnoozed={() => toggleSessionSectionFlag("showSnoozedSessions")}
				onToggleArchived={() =>
					toggleSessionSectionFlag("showArchivedSessions")
				}
			>
				{/* Header styled to match the Projects header below it. */}
				<div className="flex min-h-8 w-full shrink-0 items-center gap-1.5 py-1.5 pl-4 pr-2 text-[10px] font-semibold uppercase tracking-[0.075em] text-muted-foreground">
					<span className="min-w-0 truncate text-left">Sessions</span>
					<div className="min-w-0 flex-1" />
					<Tooltip delayDuration={700}>
						<TooltipTrigger asChild>
							<button
								type="button"
								aria-label="New session"
								onClick={openNewSessionModal}
								className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-fill-hover hover:text-foreground"
							>
								<LuPlus className="size-3.5" />
							</button>
						</TooltipTrigger>
						<TooltipContent side="bottom">New session</TooltipContent>
					</Tooltip>
				</div>
			</DashboardSidebarSessionsContextMenu>
			{!rowsHidden &&
				sessionWorkspaces.map((workspace) => (
					<DashboardSidebarWorkspaceItem
						key={workspace.id}
						workspace={workspace}
						shortcutLabel={workspaceShortcutLabels?.get(workspace.id)}
						onHoverCardOpen={() => onWorkspaceHover(workspace.id)}
					/>
				))}
			{!rowsHidden &&
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
