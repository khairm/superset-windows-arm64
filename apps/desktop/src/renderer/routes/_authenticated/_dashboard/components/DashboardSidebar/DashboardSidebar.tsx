import {
	closestCenter,
	DndContext,
	type DragEndEvent,
	DragOverlay,
	KeyboardSensor,
	MeasuringStrategy,
	MouseSensor,
	TouchSensor,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import {
	arrayMove,
	SortableContext,
	sortableKeyboardCoordinates,
	useSortable,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { cn } from "@superset/ui/utils";
import { useMatchRoute, useNavigate } from "@tanstack/react-router";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { HiOutlineCog6Tooth } from "react-icons/hi2";
import { useHotkeyDisplay } from "renderer/hotkeys";
import { useDashboardSidebarState } from "renderer/routes/_authenticated/hooks/useDashboardSidebarState";
import { useLocalHostService } from "renderer/routes/_authenticated/providers/LocalHostServiceProvider";
import { DashboardSidebarHeader } from "./components/DashboardSidebarHeader";
import { DashboardSidebarHelpMenu } from "./components/DashboardSidebarHelpMenu";
import { DashboardSidebarHoverCardOverlay } from "./components/DashboardSidebarHoverCardOverlay";
import { DashboardSidebarPortsList } from "./components/DashboardSidebarPortsList";
import { DashboardSidebarProjectSection } from "./components/DashboardSidebarProjectSection";
import { DashboardSidebarSectionRenameProvider } from "./components/DashboardSidebarSectionRenameContext";
import { V2SetupScriptCard } from "./components/V2SetupScriptCard";
import { useDashboardSidebarData } from "./hooks/useDashboardSidebarData";
import { useDashboardSidebarShortcuts } from "./hooks/useDashboardSidebarShortcuts";
import { DashboardSidebarHoverProvider } from "./providers/DashboardSidebarHoverProvider";
import type { DashboardSidebarProject } from "./types";

interface DashboardSidebarProps {
	isCollapsed?: boolean;
}

interface SortableProjectWrapperProps {
	project: DashboardSidebarProject;
	isCollapsed: boolean;
	isDraggingProject: boolean;
	workspaceShortcutLabels: Map<string, string>;
	onWorkspaceHover: (workspaceId: string) => void | Promise<void>;
	onToggleCollapse: (projectId: string) => void;
}

const SortableProjectWrapper = memo(function SortableProjectWrapper({
	project,
	isCollapsed,
	isDraggingProject,
	workspaceShortcutLabels,
	onWorkspaceHover,
	onToggleCollapse,
}: SortableProjectWrapperProps) {
	const {
		attributes,
		listeners,
		setNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({ id: project.id });

	return (
		<div
			ref={setNodeRef}
			style={{
				transform: CSS.Translate.toString(transform),
				transition,
				opacity: isDragging ? 0.5 : undefined,
			}}
		>
			<DashboardSidebarProjectSection
				project={project}
				isSidebarCollapsed={isCollapsed}
				isDraggingProject={isDraggingProject}
				workspaceShortcutLabels={workspaceShortcutLabels}
				onWorkspaceHover={onWorkspaceHover}
				onToggleCollapse={onToggleCollapse}
				dragHandleListeners={listeners}
				dragHandleAttributes={attributes}
			/>
		</div>
	);
});

export function DashboardSidebar({
	isCollapsed = false,
}: DashboardSidebarProps) {
	const { groups, refreshWorkspacePullRequest, toggleProjectCollapsed } =
		useDashboardSidebarData();
	const { reorderProjects } = useDashboardSidebarState();
	const navigate = useNavigate();
	const matchRoute = useMatchRoute();
	const settingsHotkey = useHotkeyDisplay("OPEN_SETTINGS").text;
	const isSettingsOpen = !!matchRoute({ to: "/settings", fuzzy: true });
	const { activeHostUrl } = useLocalHostService();
	const v2RouteMatch = matchRoute({ to: "/v2-workspace/$workspaceId" });
	const activeV2WorkspaceId = v2RouteMatch ? v2RouteMatch.workspaceId : null;

	const sensors = useSensors(
		useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
		useSensor(TouchSensor, {
			activationConstraint: { delay: 200, tolerance: 5 },
		}),
		useSensor(KeyboardSensor, {
			coordinateGetter: sortableKeyboardCoordinates,
		}),
	);

	const [activeProject, setActiveProject] =
		useState<DashboardSidebarProject | null>(null);

	// Local project order — syncs from groups, updated on drag end
	const [projectOrder, setProjectOrder] = useState(() =>
		groups.map((p) => p.id),
	);
	useEffect(() => {
		setProjectOrder(groups.map((p) => p.id));
	}, [groups]);

	// (ACTIVE-FIRST) The project whose workspace is currently open. It floats to
	// the top of the sidebar, above the manual drag order of everything else.
	const activeProjectId = useMemo(() => {
		if (!activeV2WorkspaceId) return null;
		for (const project of groups) {
			for (const child of project.children) {
				if (
					child.type === "workspace" &&
					child.workspace.id === activeV2WorkspaceId
				) {
					return project.id;
				}
				if (child.type === "section") {
					for (const ws of child.section.workspaces) {
						if (ws.id === activeV2WorkspaceId) return project.id;
					}
				}
			}
			// The open thread may be snoozed/archived (still shown in the main
			// pane) — resolve its project so it still floats to the top.
			for (const ws of project.snoozedWorkspaces) {
				if (ws.id === activeV2WorkspaceId) return project.id;
			}
			for (const ws of project.archivedWorkspaces) {
				if (ws.id === activeV2WorkspaceId) return project.id;
			}
		}
		return null;
	}, [groups, activeV2WorkspaceId]);

	const orderedGroups = useMemo(() => {
		const byId = new Map(groups.map((g) => [g.id, g]));
		const ordered = projectOrder
			.map((id) => byId.get(id))
			.filter((g): g is DashboardSidebarProject => g != null);
		// (ACTIVE-FIRST) Pin the currently-open project to the top, above the
		// manual drag order of everything else.
		if (!activeProjectId) return ordered;
		const idx = ordered.findIndex((g) => g.id === activeProjectId);
		if (idx <= 0) return ordered;
		const next = [...ordered];
		const [active] = next.splice(idx, 1);
		next.unshift(active);
		return next;
	}, [groups, projectOrder, activeProjectId]);

	// dnd-kit's SortableContext + handleDragEnd MUST use the SAME order the DOM
	// renders (the floated `orderedGroups`). Driving the context from the raw
	// projectOrder while rendering the floated order mis-maps drag indices and
	// lands drops in the wrong slot. Dragging while a project is floated to the
	// top simply re-pins it on the next render (the active project is pinned).
	const orderedIds = useMemo(
		() => orderedGroups.map((g) => g.id),
		[orderedGroups],
	);

	const workspaceShortcutLabels = useDashboardSidebarShortcuts(orderedGroups);

	// Resolve the full project object for the active workspace from the id above
	// (used by the footer / view-in-place logic).
	const activeV2Project = useMemo(
		() =>
			activeProjectId
				? (groups.find((g) => g.id === activeProjectId) ?? null)
				: null,
		[groups, activeProjectId],
	);

	const handleDragEnd = useCallback(
		({ active, over }: DragEndEvent) => {
			setActiveProject(null);
			if (!over || active.id === over.id) return;
			const activeId = String(active.id);
			const overId = String(over.id);
			// The pinned active project floats to the top for display only —
			// dragging it is a no-op (it re-pins on the next render).
			if (activeProjectId && activeId === activeProjectId) return;
			// Reorder in the rendered (floated) order so indices match what the
			// user dragged.
			const oldIndex = orderedIds.indexOf(activeId);
			const newIndex = orderedIds.indexOf(overId);
			if (oldIndex === -1 || newIndex === -1) return;
			const reorderedDisplayed = arrayMove(orderedIds, oldIndex, newIndex);
			// Translate back to a PURE manual order before persisting: the active
			// project is floated only for display, so restore it to its prior
			// manual position instead of persisting its floated top index —
			// otherwise dragging any other project drifts the active one to the
			// manual top (Codex review).
			let manualOrder = reorderedDisplayed;
			const priorActiveIndex = activeProjectId
				? projectOrder.indexOf(activeProjectId)
				: -1;
			if (priorActiveIndex !== -1) {
				const withoutActive = reorderedDisplayed.filter(
					(id) => id !== activeProjectId,
				);
				withoutActive.splice(priorActiveIndex, 0, activeProjectId);
				manualOrder = withoutActive;
			}
			setProjectOrder(manualOrder);
			reorderProjects(manualOrder);
		},
		[orderedIds, projectOrder, activeProjectId, reorderProjects],
	);

	return (
		<DashboardSidebarSectionRenameProvider>
			<DashboardSidebarHoverProvider>
				<DashboardSidebarHoverCardOverlay>
					<div className="flex h-full flex-col border-r border-border bg-muted/45 dark:bg-muted/35">
						<DashboardSidebarHeader isCollapsed={isCollapsed} />

						<div className="flex-1 overflow-y-auto hide-scrollbar">
							<DndContext
								sensors={sensors}
								collisionDetection={closestCenter}
								measuring={{
									droppable: { strategy: MeasuringStrategy.Always },
								}}
								onDragStart={({ active }) => {
									const project = groups.find((p) => p.id === active.id);
									setActiveProject(project ?? null);
								}}
								onDragEnd={handleDragEnd}
								onDragCancel={() => setActiveProject(null)}
							>
								<SortableContext
									items={orderedIds}
									strategy={verticalListSortingStrategy}
								>
									{orderedGroups.map((project) => (
										<SortableProjectWrapper
											key={project.id}
											project={project}
											isCollapsed={isCollapsed}
											isDraggingProject={activeProject != null}
											workspaceShortcutLabels={workspaceShortcutLabels}
											onWorkspaceHover={refreshWorkspacePullRequest}
											onToggleCollapse={toggleProjectCollapsed}
										/>
									))}
								</SortableContext>

								{createPortal(
									<DragOverlay dropAnimation={null}>
										{activeProject && (
											<div className="bg-background shadow-lg border-b border-border">
												<DashboardSidebarProjectSection
													project={activeProject}
													isSidebarCollapsed={isCollapsed}
													isDraggingProject
													workspaceShortcutLabels={workspaceShortcutLabels}
													onWorkspaceHover={() => {}}
													onToggleCollapse={() => {}}
												/>
											</div>
										)}
									</DragOverlay>,
									document.body,
								)}
							</DndContext>
						</div>
						{!isCollapsed && <DashboardSidebarPortsList />}
						{!isCollapsed && activeV2Project && activeHostUrl && (
							<V2SetupScriptCard
								hostUrl={activeHostUrl}
								projectId={activeV2Project.id}
								projectName={activeV2Project.name}
							/>
						)}
						<div
							className={cn(
								"border-t border-border",
								isCollapsed
									? "flex flex-col items-center gap-1 py-1"
									: "flex items-center gap-1 px-2 py-1",
							)}
						>
							{isCollapsed ? (
								<Tooltip delayDuration={300}>
									<TooltipTrigger asChild>
										<button
											type="button"
											aria-label="Settings"
											onClick={() => navigate({ to: "/settings/account" })}
											className={cn(
												"flex size-8 items-center justify-center rounded-md transition-colors",
												isSettingsOpen
													? "bg-accent text-foreground"
													: "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
											)}
										>
											<HiOutlineCog6Tooth className="size-4" />
										</button>
									</TooltipTrigger>
									<TooltipContent side="right">Settings</TooltipContent>
								</Tooltip>
							) : (
								<button
									type="button"
									onClick={() => navigate({ to: "/settings/account" })}
									className={cn(
										"group flex flex-1 min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium transition-colors",
										isSettingsOpen
											? "bg-accent text-foreground"
											: "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
									)}
								>
									<HiOutlineCog6Tooth className="size-4 shrink-0" />
									<span className="flex-1 text-left">Settings</span>
									{settingsHotkey !== "Unassigned" && (
										<span
											className={cn(
												"shrink-0 text-[10px] font-mono tabular-nums text-muted-foreground/60",
												"opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100",
											)}
										>
											{settingsHotkey}
										</span>
									)}
								</button>
							)}

							<DashboardSidebarHelpMenu isCollapsed={isCollapsed} />
						</div>
					</div>
				</DashboardSidebarHoverCardOverlay>
			</DashboardSidebarHoverProvider>
		</DashboardSidebarSectionRenameProvider>
	);
}
