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
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { HiOutlineCog6Tooth } from "react-icons/hi2";
import { useHotkeyDisplay } from "renderer/hotkeys";
import { useDashboardSidebarState } from "renderer/routes/_authenticated/hooks/useDashboardSidebarState";
import { useLocalHostService } from "renderer/routes/_authenticated/providers/LocalHostServiceProvider";
import { useInlineWorkspacePortsEnabled } from "renderer/stores/inline-workspace-ports";
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
import { DashboardSidebarPortsProvider } from "./providers/DashboardSidebarPortsProvider";
import type { DashboardSidebarProject } from "./types";
import { getProjectChildrenWorkspaces } from "./utils/projectChildren";

interface DashboardSidebarProps {
	isCollapsed?: boolean;
}

// (ACTIVE-FIRST) Sort tier for a repo (project) row: pinned (manual) > active
// (has >=1 non-snoozed/archived workspace, i.e. the project badge count > 0) >
// idle (badge 0). Lower rank sorts higher. The badge is
// getProjectChildrenWorkspaces(children).length (snoozed/archived live in
// separate arrays), so this matches exactly what the user sees per project row.
const PROJECT_TIER_RANKS = 3;

function getProjectTierRank(project: DashboardSidebarProject): number {
	if (project.isPinned) return 0;
	return getProjectChildrenWorkspaces(project.children).length > 0 ? 1 : 2;
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
	const inlineWorkspacePortsEnabled = useInlineWorkspacePortsEnabled();
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

	// The project whose workspace is currently open. Used only by the footer /
	// view-in-place card below (resolved to `activeV2Project`) — it does NOT
	// affect sort order (opening/viewing is unrelated to the sidebar sort).
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
			// pane) — resolve its project for the footer card regardless.
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

		// (ACTIVE-FIRST) Stable 3-tier partition of the manual drag order:
		// pinned > active (badge > 0: has >=1 non-snoozed/archived workspace) >
		// idle (badge 0). The manual order is preserved WITHIN each tier; a project
		// that just changed tier was already moved to the top of its new tier in
		// `projectOrder` by the transition effect below, so it lands first here.
		// Opening/viewing a project does NOT affect the order.
		const tiers: DashboardSidebarProject[][] = Array.from(
			{ length: PROJECT_TIER_RANKS },
			() => [],
		);
		for (const group of ordered) {
			tiers[getProjectTierRank(group)].push(group);
		}
		return tiers.flat();
	}, [groups, projectOrder]);

	// dnd-kit's SortableContext + handleDragEnd MUST use the SAME order the DOM
	// renders (the tiered `orderedGroups`), so drag indices map to the right slot.
	// A within-tier drag reorders and persists; a cross-tier drag re-tiers on the
	// next render (a row can't be dragged out of its pinned/active/idle group).
	const orderedIds = useMemo(
		() => orderedGroups.map((g) => g.id),
		[orderedGroups],
	);

	// (HOVER-FREEZE) Don't reshuffle rows while the pointer is over the project
	// list — tier transitions (active/idle flips, pins) re-sort the sidebar, and
	// rows jumping under the cursor mid-interaction is jarring. While the
	// pointer is physically inside the list (and for the whole of a drag) the
	// rendered ORDER is pinned to the snapshot taken on entry; row CONTENT
	// (dots, badges, children) stays live. The real order keeps updating and
	// persisting underneath and applies the moment the freeze lifts.
	//
	// The inside/outside signal is GEOMETRY-based (a window-level pointermove
	// against the list's bounding rect), NOT pointerenter/leave hit-testing:
	// Radix menus set body{pointer-events:none} and the dnd-kit DragOverlay
	// steals the hit-test, both of which fire pointerleave while the cursor is
	// still visually over the list — which would lift the freeze mid-menu and
	// mid-drag, the exact interactions it exists to protect.
	const [isPointerOverList, setIsPointerOverList] = useState(false);
	const isPointerOverListRef = useRef(false);
	const listRef = useRef<HTMLDivElement | null>(null);
	const frozenOrderRef = useRef<string[]>([]);
	const orderedIdsRef = useRef<string[]>(orderedIds);
	orderedIdsRef.current = orderedIds;
	useEffect(() => {
		let raf = 0;
		let lastX = 0;
		let lastY = 0;
		const evaluate = () => {
			raf = 0;
			const el = listRef.current;
			if (!el) return;
			const rect = el.getBoundingClientRect();
			const inside =
				rect.width > 0 &&
				rect.height > 0 &&
				lastX >= rect.left &&
				lastX <= rect.right &&
				lastY >= rect.top &&
				lastY <= rect.bottom;
			if (inside === isPointerOverListRef.current) return;
			isPointerOverListRef.current = inside;
			// Snapshot via refs (not closure state) — immune to the stale-closure
			// race a render-captured handler had between a state flip and commit.
			if (inside) frozenOrderRef.current = orderedIdsRef.current;
			setIsPointerOverList(inside);
		};
		const onPointerMove = (event: PointerEvent) => {
			lastX = event.clientX;
			lastY = event.clientY;
			if (!raf) raf = window.requestAnimationFrame(evaluate);
		};
		window.addEventListener("pointermove", onPointerMove, { passive: true });
		return () => {
			window.removeEventListener("pointermove", onPointerMove);
			if (raf) window.cancelAnimationFrame(raf);
		};
	}, []);

	// Freeze also spans an active drag (the pointer can wander off the list).
	const orderFrozen = isPointerOverList || activeProject != null;
	const displayGroups = useMemo(() => {
		if (!orderFrozen) return orderedGroups;
		const byId = new Map(orderedGroups.map((g) => [g.id, g]));
		const kept = frozenOrderRef.current
			.map((id) => byId.get(id))
			.filter((g): g is DashboardSidebarProject => g != null);
		if (kept.length === orderedGroups.length) return kept;
		// Projects that appeared while frozen append at the end — visible
		// without reshuffling the rows already under the pointer.
		const keptIds = new Set(kept.map((g) => g.id));
		return [...kept, ...orderedGroups.filter((g) => !keptIds.has(g.id))];
	}, [orderFrozen, orderedGroups]);
	// dnd-kit indices must match the RENDERED (possibly frozen) order.
	const displayIds = useMemo(
		() => displayGroups.map((g) => g.id),
		[displayGroups],
	);

	const workspaceShortcutLabels = useDashboardSidebarShortcuts(displayGroups);

	// Resolve the full project object for the active workspace from the id above
	// (used by the footer / view-in-place logic).
	const activeV2Project = useMemo(
		() =>
			activeProjectId
				? (groups.find((g) => g.id === activeProjectId) ?? null)
				: null,
		[groups, activeProjectId],
	);

	// (ACTIVE-FIRST) When a project changes tier — pinned/unpinned, or it gained
	// or lost its last active workspace — move it to the TOP of its new tier.
	// Done by moving its id to the FRONT of the manual order; the stable partition
	// above then renders it first within its tier. Persisted so it sticks, and it
	// converges: reordering within a tier never changes a tier, so the next run
	// sees no transition. First render seeds prevTierRef WITHOUT moving anything
	// (every id is "new", not a transition), so a saved order isn't reshuffled.
	const prevTierRef = useRef<Map<string, number>>(new Map());
	useEffect(() => {
		const currentTiers = new Map(
			groups.map((g) => [g.id, getProjectTierRank(g)] as const),
		);
		const previous = prevTierRef.current;
		const transitioned = groups
			.filter(
				(g) =>
					previous.has(g.id) && previous.get(g.id) !== currentTiers.get(g.id),
			)
			.map((g) => g.id);
		prevTierRef.current = currentTiers;
		if (transitioned.length === 0) return;
		const moved = new Set(transitioned);
		const baseOrder = groups.map((g) => g.id);
		const nextOrder = [
			...transitioned,
			...baseOrder.filter((id) => !moved.has(id)),
		];
		if (nextOrder.every((id, index) => id === baseOrder[index])) return;
		setProjectOrder(nextOrder);
		reorderProjects(nextOrder);
	}, [groups, reorderProjects]);

	const handleDragEnd = useCallback(
		({ active, over }: DragEndEvent) => {
			setActiveProject(null);
			if (!over || active.id === over.id) return;
			const activeId = String(active.id);
			const overId = String(over.id);
			// Reorder in the RENDERED (possibly hover-frozen) order so indices
			// match the drag.
			const oldIndex = displayIds.indexOf(activeId);
			const newIndex = displayIds.indexOf(overId);
			if (oldIndex === -1 || newIndex === -1) return;
			// A row can't be dragged OUT of its tier: ignore a drop whose target is
			// in a different pinned/active/idle tier (otherwise the re-partition would
			// silently shuffle the row's within-tier position). Only same-tier
			// reorders persist.
			const activeGroup = displayGroups[oldIndex];
			const overGroup = displayGroups[newIndex];
			if (
				activeGroup &&
				overGroup &&
				getProjectTierRank(activeGroup) !== getProjectTierRank(overGroup)
			) {
				return;
			}
			// Visual: the user's drop becomes the frozen view (no snap-back while
			// the pointer is still over the list).
			frozenOrderRef.current = arrayMove(displayIds, oldIndex, newIndex);
			// Persisted: apply the SINGLE move (activeId next to overId) to the
			// LIVE order — order changes that landed underneath during the freeze
			// (e.g. a tier-transition move-to-top) survive instead of being
			// wholesale overwritten by the stale frozen arrangement. The 3-tier
			// partition re-applies on render so the same-tier reorder sticks.
			const liveOrder = orderedIds.filter((id) => id !== activeId);
			const overLiveIndex = liveOrder.indexOf(overId);
			if (overLiveIndex === -1) return;
			const insertAt = newIndex > oldIndex ? overLiveIndex + 1 : overLiveIndex;
			liveOrder.splice(insertAt, 0, activeId);
			setProjectOrder(liveOrder);
			reorderProjects(liveOrder);
		},
		[displayGroups, displayIds, orderedIds, reorderProjects],
	);

	return (
		<DashboardSidebarSectionRenameProvider>
			<DashboardSidebarHoverProvider>
				<DashboardSidebarPortsProvider enabled={!isCollapsed}>
					<DashboardSidebarHoverCardOverlay>
						<div className="flex h-full flex-col border-r border-border bg-muted/45 dark:bg-muted/35">
							<DashboardSidebarHeader isCollapsed={isCollapsed} />

							<div
								ref={listRef}
								className="flex-1 overflow-y-auto hide-scrollbar"
							>
								<DndContext
									sensors={sensors}
									collisionDetection={closestCenter}
									measuring={{
										droppable: { strategy: MeasuringStrategy.Always },
									}}
									onDragStart={({ active }) => {
										// A drag freezes the order via activeProject. If the
										// pointer-geometry freeze isn't already active (keyboard
										// drag), snapshot NOW so the freeze can't render a stale
										// order from an earlier hover.
										if (!isPointerOverListRef.current) {
											frozenOrderRef.current = orderedIdsRef.current;
										}
										const project = groups.find((p) => p.id === active.id);
										setActiveProject(project ?? null);
									}}
									onDragEnd={handleDragEnd}
									onDragCancel={() => setActiveProject(null)}
								>
									<SortableContext
										items={displayIds}
										strategy={verticalListSortingStrategy}
									>
										{displayGroups.map((project) => (
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
							{!isCollapsed && !inlineWorkspacePortsEnabled && (
								<DashboardSidebarPortsList />
							)}
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
				</DashboardSidebarPortsProvider>
			</DashboardSidebarHoverProvider>
		</DashboardSidebarSectionRenameProvider>
	);
}
