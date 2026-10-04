import type { WorkspaceActivityById } from "renderer/hooks/host-workspaces/useHostWorkspaces";
import type { SidebarProjectSortMode } from "renderer/routes/_authenticated/providers/CollectionsProvider/dashboardSidebarLocal/schema";
import type {
	DashboardSidebarProject,
	DashboardSidebarProjectChild,
	DashboardSidebarWorkspace,
} from "../../types";

// Timestamps are typed as Date but can arrive as ISO strings at runtime
// (IndexedDB snapshots, persisted query caches). Sorting is cosmetic, so
// coerce instead of trusting the type — a bad value must never throw
// mid-render and take the sidebar down with it (that is what got the first
// version of this feature reverted).
function toTime(value: Date | string | number | null | undefined): number {
	if (value == null) return Number.NaN;
	if (value instanceof Date) return value.getTime();
	if (typeof value === "number") return value;
	return new Date(value).getTime();
}

// An item with no usable timestamp sinks below everything dated. Mapping
// NaN to -Infinity keeps the comparator a consistent total order instead of
// interleaving unknowns by name.
function rankTime(time: number): number {
	return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
}

function newest(times: number[]): number {
	const known = times.filter((time) => !Number.isNaN(time));
	return known.length > 0 ? Math.max(...known) : Number.NaN;
}

/**
 * When a workspace was last active. The host's activity stamp, set on agent
 * lifecycle events, alone ranks the row once present; only rows from a host
 * that predates it fall back to `updatedAt`. Deliberately not `max` of the
 * two: `updatedAt` moves on renames and bulk moves, and housekeeping must not
 * jump a workspace to the top of "Last active". A row the map does not know
 * yet takes the same fallback for one render.
 */
export function getWorkspaceActivityTime(
	workspace: DashboardSidebarWorkspace,
	activityById: WorkspaceActivityById | null,
): number {
	const activity = activityById?.get(workspace.id);
	if (typeof activity === "number" && Number.isFinite(activity)) {
		return activity;
	}
	return toTime(workspace.updatedAt);
}

function makeStableComparator<Item>(
	byTimestamp: (item: Item) => number,
	byName: (item: Item) => string,
	byId: (item: Item) => string,
): (left: Item, right: Item) => number {
	return (left, right) => {
		const diff = rankTime(byTimestamp(right)) - rankTime(byTimestamp(left));
		if (!Number.isNaN(diff) && diff !== 0) return diff;
		const names = byName(left).localeCompare(byName(right));
		if (names !== 0) return names;
		return byId(left).localeCompare(byId(right));
	};
}

function getWorkspaceTimestamp(
	workspace: DashboardSidebarWorkspace,
	mode: SidebarProjectSortMode,
	activityById: WorkspaceActivityById | null,
): number {
	return mode === "created"
		? toTime(workspace.createdAt)
		: getWorkspaceActivityTime(workspace, activityById);
}

// Mirrors the project-level rules one level down: "created" uses the
// section's own createdAt, "active" uses its most recently active workspace
// (falling back to createdAt when empty).
function getChildTimestamp(
	child: DashboardSidebarProjectChild,
	mode: SidebarProjectSortMode,
	activityById: WorkspaceActivityById | null,
): number {
	if (child.type === "workspace") {
		return getWorkspaceTimestamp(child.workspace, mode, activityById);
	}
	const { section } = child;
	if (mode === "created") return toTime(section.createdAt);
	const activity = newest(
		section.workspaces.map((workspace) =>
			getWorkspaceActivityTime(workspace, activityById),
		),
	);
	return Number.isNaN(activity) ? toTime(section.createdAt) : activity;
}

function haveSameItems<Item>(left: Item[], right: Item[]): boolean {
	return (
		left.length === right.length &&
		left.every((item, index) => item === right[index])
	);
}

/**
 * Orders a project's children for a non-manual sort mode: workspaces inside
 * each section sort by the mode, sections reorder among the loose workspaces
 * by their own timestamp. Returns the input array (and the input section objects) when nothing
 * moves, so memoized rows keep their identity.
 */
export function sortDashboardSidebarProjectChildren(
	children: DashboardSidebarProjectChild[],
	mode: SidebarProjectSortMode,
	activityById: WorkspaceActivityById | null,
): DashboardSidebarProjectChild[] {
	if (mode === "manual") return children;

	const compareWorkspaces = makeStableComparator<DashboardSidebarWorkspace>(
		(workspace) => getWorkspaceTimestamp(workspace, mode, activityById),
		(workspace) => workspace.name,
		(workspace) => workspace.id,
	);
	const compareChildren = makeStableComparator<DashboardSidebarProjectChild>(
		(child) => getChildTimestamp(child, mode, activityById),
		(child) =>
			child.type === "workspace" ? child.workspace.name : child.section.name,
		(child) =>
			child.type === "workspace" ? child.workspace.id : child.section.id,
	);

	const sortedInside = children.map((child) => {
		if (child.type !== "section") return child;
		const workspaces = [...child.section.workspaces].sort(compareWorkspaces);
		return haveSameItems(workspaces, child.section.workspaces)
			? child
			: { ...child, section: { ...child.section, workspaces } };
	});

	const sorted = [...sortedInside].sort(compareChildren);
	return haveSameItems(sorted, children) ? children : sorted;
}

/**
 * Sorts each project's children for a sort mode. The project list itself is
 * always the manual (drag) order: projects are the stable landmarks people
 * navigate by, and reshuffling them under the user because an agent touched
 * a workspace loses the map. `manual` returns the input untouched; the other
 * modes never mutate it, and a project whose children are already in order
 * keeps its identity.
 */
export function sortDashboardSidebarProjects(
	projects: DashboardSidebarProject[],
	mode: SidebarProjectSortMode,
	activityById: WorkspaceActivityById | null,
): DashboardSidebarProject[] {
	if (mode === "manual") return projects;

	return projects.map((project) => {
		const children = sortDashboardSidebarProjectChildren(
			project.children,
			mode,
			activityById,
		);
		return children === project.children ? project : { ...project, children };
	});
}

function haveSameValuesExcept<Item extends object>(
	left: Item,
	right: Item,
	except: keyof Item,
): boolean {
	const leftKeys = Object.keys(left).filter((key) => key !== except);
	const rightKeys = Object.keys(right).filter((key) => key !== except);
	return (
		leftKeys.length === rightKeys.length &&
		leftKeys.every(
			(key) =>
				Object.hasOwn(right, key) &&
				Object.is(
					(left as Record<string, unknown>)[key],
					(right as Record<string, unknown>)[key],
				),
		)
	);
}

function getChildKey(child: DashboardSidebarProjectChild): string {
	return child.type === "workspace"
		? `workspace:${child.workspace.id}`
		: `section:${child.section.id}`;
}

function isSameChild(
	prev: DashboardSidebarProjectChild,
	next: DashboardSidebarProjectChild,
): boolean {
	if (prev === next) return true;
	if (prev.type !== "section" || next.type !== "section") return false;
	return (
		haveSameValuesExcept(prev, next, "section") &&
		haveSameValuesExcept(prev.section, next.section, "workspaces") &&
		haveSameItems(prev.section.workspaces, next.section.workspaces)
	);
}

function stabiliseChildren(
	prev: DashboardSidebarProjectChild[],
	next: DashboardSidebarProjectChild[],
): DashboardSidebarProjectChild[] {
	const prevByKey = new Map(prev.map((child) => [getChildKey(child), child]));
	const stabilised = next.map((child) => {
		const previous = prevByKey.get(getChildKey(child));
		return previous && isSameChild(previous, child) ? previous : child;
	});
	if (haveSameItems(stabilised, prev)) return prev;
	return haveSameItems(stabilised, next) ? next : stabilised;
}

/**
 * (ACTIVITY-SPLIT) Reuses the previous sorted tree's objects by identity
 * wherever a re-sort produced an equal copy, so an unchanged order returns
 * `prev` itself. Every reused object holds exactly the leaves of its
 * counterpart in `next`. The only objects it creates are project shells, for a
 * project that cannot be reused whole but has reusable children.
 */
export function stabiliseSortedProjects(
	prev: DashboardSidebarProject[],
	next: DashboardSidebarProject[],
): DashboardSidebarProject[] {
	const prevById = new Map(prev.map((project) => [project.id, project]));
	const stabilised = next.map((project) => {
		const previous = prevById.get(project.id);
		if (!previous || previous === project) return project;
		const children = stabiliseChildren(previous.children, project.children);
		if (
			children === previous.children &&
			haveSameValuesExcept(previous, project, "children")
		) {
			return previous;
		}
		return children === project.children ? project : { ...project, children };
	});
	return haveSameItems(stabilised, prev) ? prev : stabilised;
}
