import { useDndMonitor } from "@dnd-kit/core";
import {
	SortableContext,
	useSortable,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { OverflowFadeContainer } from "@superset/ui/overflow-fade-container";
import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { cn } from "@superset/ui/utils";
import { useMatchRoute, useNavigate } from "@tanstack/react-router";
import {
	memo,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { HiOutlineCog6Tooth } from "react-icons/hi2";
import { NotificationBusPill } from "renderer/components/NotificationBusPill";
import {
	SidebarCardSlot,
	useHiringCard,
	usePaymentFailedCard,
	useStarNagCard,
} from "renderer/components/SidebarCardSlot";
import { UpdatesPill } from "renderer/components/UpdatesPill";
import { useHotkeyDisplay } from "renderer/hotkeys";
import { DEFAULT_SETTINGS_ROUTE } from "renderer/lib/cloud-severed-routes";
import { useDashboardSidebarState } from "renderer/routes/_authenticated/hooks/useDashboardSidebarState";
import { useLocalHostService } from "renderer/routes/_authenticated/providers/LocalHostServiceProvider";
import { useSidebarSectionsCollapseStore } from "renderer/stores/sidebar-sections-collapse";
import { DashboardSidebarBulkActions } from "./components/DashboardSidebarBulkActions";
import { DashboardSidebarCloudSection } from "./components/DashboardSidebarCloudSection";
import { DashboardSidebarHeader } from "./components/DashboardSidebarHeader";
import { DashboardSidebarHoverCardOverlay } from "./components/DashboardSidebarHoverCardOverlay";
import { DashboardSidebarPinnedSection } from "./components/DashboardSidebarPinnedSection";
import { DashboardSidebarProjectSection } from "./components/DashboardSidebarProjectSection";
import { DashboardSidebarSectionRenameProvider } from "./components/DashboardSidebarSectionRenameContext";
import { DashboardSidebarSessionsSection } from "./components/DashboardSidebarSessionsSection";
import { DashboardSidebarWorkspacesHeader } from "./components/DashboardSidebarWorkspacesHeader";
import { SectionDragSpacer } from "./components/SectionDragSpacer";
import { useV2SetupScriptCard } from "./components/V2SetupScriptCard";
import { useDashboardSidebarData } from "./hooks/useDashboardSidebarData";
import { useDashboardSidebarShortcuts } from "./hooks/useDashboardSidebarShortcuts";
import { useDashboardSidebarDnd } from "./hooks/useSidebarDnd";
import { ClaudeAccountSidebarProvider } from "./providers/ClaudeAccountSidebarProvider";
import { DashboardSidebarDndProvider } from "./providers/DashboardSidebarDndProvider";
import { DashboardSidebarHoverProvider } from "./providers/DashboardSidebarHoverProvider";
import { DashboardSidebarSelectionProvider } from "./providers/DashboardSidebarSelectionProvider";
import {
	DashboardSidebarWorkspaceStatusProvider,
	type SidebarStatusWorkspaceRef,
	useSidebarWorkspaceHostTargets,
} from "./providers/DashboardSidebarWorkspaceStatusProvider";
import type {
	DashboardSidebarProject,
	DashboardSidebarWorkspace,
} from "./types";
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

/**
 * (HOVER-FREEZE) Bridges the sidebar's single DndContext back out to the order
 * freeze. The geometry probe below covers a pointer drag over the list, but not
 * a keyboard drag (no pointermove at all) nor a pointer that wanders off the
 * list mid-drag — and a re-sort under an in-flight drag moves dnd-kit's indices
 * out from under it. Rendered inside DashboardSidebarDndProvider; renders
 * nothing.
 */
function SidebarDragFreezeMonitor({
	onDragActiveChange,
	onSnapshotOrder,
}: {
	onDragActiveChange: (active: boolean) => void;
	onSnapshotOrder: () => void;
}) {
	useDndMonitor({
		onDragStart: () => {
			onSnapshotOrder();
			onDragActiveChange(true);
		},
		onDragEnd: () => onDragActiveChange(false),
		onDragCancel: () => onDragActiveChange(false),
	});
	return null;
}

interface SortableProjectWrapperProps {
	project: DashboardSidebarProject;
	isCollapsed: boolean;
	workspaceShortcutLabels: Map<string, string>;
	onWorkspaceHover: (workspaceId: string) => void | Promise<void>;
	onToggleCollapse: (projectId: string) => void;
}

const SortableProjectWrapper = memo(function SortableProjectWrapper({
	project,
	isCollapsed,
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
	const { activeType } = useDashboardSidebarDnd();
	const isDraggingProject = activeType === "project";

	// useSortable re-renders this wrapper on every pointer move of any drag in
	// the sidebar's DndContext; the project section subtree is expensive, so
	// keep it referentially stable while only the wrapper transform changes.
	const section = useMemo(
		() => (
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
		),
		[
			project,
			isCollapsed,
			isDraggingProject,
			workspaceShortcutLabels,
			onWorkspaceHover,
			onToggleCollapse,
			listeners,
			attributes,
		],
	);

	return (
		<div
			ref={setNodeRef}
			style={{
				transform: CSS.Translate.toString(transform),
				transition,
				opacity: isDragging ? 0.5 : undefined,
			}}
		>
			{section}
		</div>
	);
});

export function DashboardSidebar({
	isCollapsed = false,
}: DashboardSidebarProps) {
	const {
		groups,
		pinnedWorkspaces,
		sessionWorkspaces,
		snoozedSessionWorkspaces,
		archivedSessionWorkspaces,
		deletedSessionWorkspaces,
		refreshWorkspacePullRequest,
		toggleProjectCollapsed,
	} = useDashboardSidebarData();
	const { reorderProjects } = useDashboardSidebarState();
	const navigate = useNavigate();
	const matchRoute = useMatchRoute();
	const settingsHotkey = useHotkeyDisplay("OPEN_SETTINGS").text;
	const isSettingsOpen = !!matchRoute({ to: "/settings", fuzzy: true });
	const { activeHostUrl } = useLocalHostService();
	const v2RouteMatch = matchRoute({ to: "/v2-workspace/$workspaceId" });
	const activeV2WorkspaceId = v2RouteMatch ? v2RouteMatch.workspaceId : null;
	const workspacesListCollapsed = useSidebarSectionsCollapseStore(
		(s) => s.collapsed.workspaces,
	);

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
		// A pinned active workspace renders outside its project group, so
		// resolve its project by id instead.
		const pinned = pinnedWorkspaces.find(
			(workspace) => workspace.id === activeV2WorkspaceId,
		);
		if (pinned) {
			return pinned.projectId;
		}
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
	}, [groups, pinnedWorkspaces, activeV2WorkspaceId]);

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

	// Freeze also spans an active drag (the pointer can wander off the list, and
	// a keyboard drag never moves it at all) — see SidebarDragFreezeMonitor.
	const [isDraggingSidebar, setIsDraggingSidebar] = useState(false);
	// A drag that starts without the geometry probe having fired must snapshot
	// NOW, or the freeze renders a stale order from an earlier hover.
	const snapshotFrozenOrder = useCallback(() => {
		if (!isPointerOverListRef.current) {
			frozenOrderRef.current = orderedIdsRef.current;
		}
	}, []);
	const orderFrozen = isPointerOverList || isDraggingSidebar;
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
	// Read by the drop handler, which runs inside the shared DndContext and so
	// must not close over a render-captured order.
	const displayIdsRef = useRef<string[]>(displayIds);
	displayIdsRef.current = displayIds;
	const displayGroupsRef = useRef<DashboardSidebarProject[]>(displayGroups);
	displayGroupsRef.current = displayGroups;

	// Shortcut numbering follows the RENDERED (tiered + hover-frozen) order so a
	// label never points at a different row than the one on screen.
	const workspaceShortcutLabels = useDashboardSidebarShortcuts(
		displayGroups,
		sessionWorkspaces,
	);

	const selectableWorkspaceIds = useMemo(() => {
		const ids = new Set<string>();
		const addWorkspace = (workspace: DashboardSidebarWorkspace) => {
			if (
				workspace.type === "worktree" &&
				workspace.pendingTransaction?.type !== "insert"
			) {
				ids.add(workspace.id);
			}
		};
		for (const project of orderedGroups) {
			for (const child of project.children) {
				if (child.type === "workspace") {
					addWorkspace(child.workspace);
					continue;
				}
				// Members of collapsed groups are hidden and unclickable; keeping
				// them selected would leave invisible rows armed for bulk actions
				// (including Delete), so collapsing prunes them from the selection.
				if (child.section.isCollapsed) continue;
				for (const workspace of child.section.workspaces) {
					addWorkspace(workspace);
				}
			}
		}
		return ids;
	}, [orderedGroups]);

	// Every workspace the sidebar can render (pinned, sessions, project rows) —
	// the status provider fans out bindings queries and event subscriptions for
	// these once, instead of per row.
	const statusWorkspaces = useMemo<SidebarStatusWorkspaceRef[]>(() => {
		const byId = new Map<string, SidebarStatusWorkspaceRef>();
		for (const workspace of pinnedWorkspaces) {
			byId.set(workspace.id, { id: workspace.id, hostId: workspace.hostId });
		}
		for (const workspace of sessionWorkspaces) {
			byId.set(workspace.id, { id: workspace.id, hostId: workspace.hostId });
		}
		for (const project of orderedGroups) {
			for (const workspace of getProjectChildrenWorkspaces(project.children)) {
				byId.set(workspace.id, { id: workspace.id, hostId: workspace.hostId });
			}
		}
		return [...byId.values()];
	}, [pinnedWorkspaces, sessionWorkspaces, orderedGroups]);
	const sidebarWorkspaceHostTargets =
		useSidebarWorkspaceHostTargets(statusWorkspaces);
	const claudeAccountWorkspaceIds = useMemo(
		() =>
			sidebarWorkspaceHostTargets
				.filter((target) => target.hostUrl === activeHostUrl)
				.map((target) => target.workspaceId),
		[sidebarWorkspaceHostTargets, activeHostUrl],
	);

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

	// Ordered by priority for the single card slot below — blocking first,
	// then actionable, then nags.
	const paymentFailedCard = usePaymentFailedCard({ surface: "v2" });
	const setupScriptCard = useV2SetupScriptCard({
		hostUrl: activeHostUrl,
		projectId: activeV2Project?.id ?? null,
		projectName: activeV2Project?.name ?? null,
	});
	const starNagCard = useStarNagCard({ isCollapsed });
	const hiringCard = useHiringCard({ surface: "v2" });

	// (ACTIVE-FIRST) (HOVER-FREEZE) dnd-kit hands back the whole display order
	// after a project move, so reconstruct the single move it made: exactly one
	// row travels, every other shifts by one, so the largest displacement names
	// it. Two fork rules then still apply on top of upstream's shared DnD.
	const handleReorderProjects = useCallback(
		(reordered: string[]) => {
			const previous = displayIdsRef.current;
			let movedId: string | null = null;
			let oldIndex = -1;
			let maxShift = 0;
			for (const [index, id] of previous.entries()) {
				const shift = Math.abs(reordered.indexOf(id) - index);
				if (shift > maxShift) {
					maxShift = shift;
					movedId = id;
					oldIndex = index;
				}
			}
			if (movedId === null) return;
			const newIndex = reordered.indexOf(movedId);
			if (newIndex === -1) return;
			// A row can't be dragged OUT of its tier: ignore a drop whose target is
			// in a different pinned/active/idle tier (otherwise the re-partition
			// would silently shuffle the row's within-tier position). Only
			// same-tier reorders persist.
			const activeGroup = displayGroupsRef.current[oldIndex];
			const overGroup = displayGroupsRef.current[newIndex];
			if (
				activeGroup &&
				overGroup &&
				getProjectTierRank(activeGroup) !== getProjectTierRank(overGroup)
			) {
				return;
			}
			// Visual: the user's drop becomes the frozen view (no snap-back while
			// the pointer is still over the list).
			frozenOrderRef.current = reordered;
			// Persisted: apply the SINGLE move (movedId next to its drop target) to
			// the LIVE order — order changes that landed underneath during the
			// freeze (e.g. a tier-transition move-to-top) survive instead of being
			// wholesale overwritten by the stale frozen arrangement. The 3-tier
			// partition re-applies on render so the same-tier reorder sticks.
			const overId = previous[newIndex];
			const liveOrder = orderedIdsRef.current.filter((id) => id !== movedId);
			const overLiveIndex = overId === undefined ? -1 : liveOrder.indexOf(overId);
			if (overLiveIndex === -1) return;
			const insertAt = newIndex > oldIndex ? overLiveIndex + 1 : overLiveIndex;
			liveOrder.splice(insertAt, 0, movedId);
			setProjectOrder(liveOrder);
			reorderProjects(liveOrder);
		},
		[reorderProjects],
	);

	return (
		<DashboardSidebarSelectionProvider
			availableWorkspaceIds={selectableWorkspaceIds}
		>
			<DashboardSidebarSectionRenameProvider>
				<DashboardSidebarHoverProvider>
					<ClaudeAccountSidebarProvider
						hostUrl={activeHostUrl}
						workspaceIds={claudeAccountWorkspaceIds}
						includeRoster={!isCollapsed}
					>
						<DashboardSidebarWorkspaceStatusProvider
							targets={sidebarWorkspaceHostTargets}
							activeWorkspaceId={activeV2WorkspaceId}
						>
							{/* Port data comes from the single DashboardSidebarPortsProvider in the
							    dashboard layout, which wraps this sidebar. */}
							<DashboardSidebarHoverCardOverlay>
								<DashboardSidebarDndProvider
									// (HOVER-FREEZE) The DnD order must be the RENDERED
									// (tiered + frozen) one, or drag indices point at rows
									// that are not where the user sees them.
									projects={displayGroups}
									pinnedWorkspaces={pinnedWorkspaces}
									sessionWorkspaces={sessionWorkspaces}
									isSidebarCollapsed={isCollapsed}
									workspaceShortcutLabels={workspaceShortcutLabels}
									onReorderProjects={handleReorderProjects}
								>
									<SidebarDragFreezeMonitor
										onDragActiveChange={setIsDraggingSidebar}
										onSnapshotOrder={snapshotFrozenOrder}
									/>
									<div className="flex h-full flex-col border-r border-border bg-sidebar dark:bg-muted/35">
										<DashboardSidebarHeader isCollapsed={isCollapsed} />

										<OverflowFadeContainer
											ref={listRef}
											fadeEdges={["top", "bottom"]}
											className="flex-1 overflow-y-auto hide-scrollbar"
										>
											{(isCollapsed || !workspacesListCollapsed) && (
												<DashboardSidebarPinnedSection
													pinnedWorkspaces={pinnedWorkspaces}
													isCollapsed={isCollapsed}
													onWorkspaceHover={refreshWorkspacePullRequest}
												/>
											)}
											<DashboardSidebarCloudSection
												isCollapsed={isCollapsed}
												onWorkspaceHover={refreshWorkspacePullRequest}
											/>
											<DashboardSidebarSessionsSection
												sessionWorkspaces={sessionWorkspaces}
												snoozedSessionWorkspaces={snoozedSessionWorkspaces}
												archivedSessionWorkspaces={archivedSessionWorkspaces}
												deletedSessionWorkspaces={deletedSessionWorkspaces}
												isCollapsed={isCollapsed}
												rowsHidden={!isCollapsed && workspacesListCollapsed}
												workspaceShortcutLabels={workspaceShortcutLabels}
												onWorkspaceHover={refreshWorkspacePullRequest}
											/>
											{!isCollapsed && (
												<DashboardSidebarBulkActions projects={orderedGroups}>
													<DashboardSidebarWorkspacesHeader />
												</DashboardSidebarBulkActions>
											)}
											{(isCollapsed || !workspacesListCollapsed) && (
												<SortableContext
													items={displayIds}
													strategy={verticalListSortingStrategy}
												>
													{displayGroups.map((project) => (
														<SortableProjectWrapper
															key={project.id}
															project={project}
															isCollapsed={isCollapsed}
															workspaceShortcutLabels={workspaceShortcutLabels}
															onWorkspaceHover={refreshWorkspacePullRequest}
															onToggleCollapse={toggleProjectCollapsed}
														/>
													))}
												</SortableContext>
											)}
											<SectionDragSpacer />
										</OverflowFadeContainer>
										<SidebarCardSlot
											isCollapsed={isCollapsed}
											entries={[
												paymentFailedCard,
												setupScriptCard,
												starNagCard,
												hiringCard,
											]}
										/>
										{/* (CLOUD-SEVERANCE-P2) The organization menu used to
										    anchor this footer: switch org, manage members, log
										    out. All three are gone — there is one organization,
										    it is this machine's, and nothing can be switched to
										    or signed out of — so the footer is now just the
										    status pills and Settings. */}
										<div
											className={cn(
												isCollapsed
													? "flex flex-col items-center gap-2 py-2"
													: "flex items-center gap-1 p-2",
											)}
										>
											<NotificationBusPill isCollapsed={isCollapsed} />
											<UpdatesPill isCollapsed={isCollapsed} />
											<Tooltip delayDuration={300}>
												<TooltipTrigger asChild>
													<button
														type="button"
														aria-label="Settings"
														onClick={() =>
															navigate({ to: DEFAULT_SETTINGS_ROUTE })
														}
														className={cn(
															"flex size-8 shrink-0 items-center justify-center rounded-md transition-colors",
															isSettingsOpen
																? "bg-fill-selected text-muted-foreground"
																: "text-muted-foreground hover:bg-fill-hover",
														)}
													>
														<HiOutlineCog6Tooth className="size-3.5" />
													</button>
												</TooltipTrigger>
												<TooltipContent side={isCollapsed ? "right" : "top"}>
													{settingsHotkey !== "Unassigned"
														? `Settings (${settingsHotkey})`
														: "Settings"}
												</TooltipContent>
											</Tooltip>
										</div>
									</div>
								</DashboardSidebarDndProvider>
							</DashboardSidebarHoverCardOverlay>
						</DashboardSidebarWorkspaceStatusProvider>
					</ClaudeAccountSidebarProvider>
				</DashboardSidebarHoverProvider>
			</DashboardSidebarSectionRenameProvider>
		</DashboardSidebarSelectionProvider>
	);
}
