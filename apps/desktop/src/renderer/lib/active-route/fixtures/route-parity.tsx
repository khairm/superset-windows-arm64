import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ParsedLocation, RouterState } from "@tanstack/react-router";

GlobalRegistrator.register({ url: "http://localhost" });
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const { act, cleanup, render } = await import("@testing-library/react");
const {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	Outlet,
	RouterProvider,
} = await import("@tanstack/react-router");
const { isUnder, matchLocation, useActiveRoute, v2WorkspaceIdOf } =
	await import("../active-route");
const { selectActiveV2WorkspaceId, selectIsSettingsOpen } = await import(
	"renderer/routes/_authenticated/_dashboard/components/DashboardSidebar/DashboardSidebar.utils"
);
const { selectIsWorkspaceRowActive } = await import(
	"renderer/routes/_authenticated/_dashboard/components/DashboardSidebar/components/DashboardSidebarWorkspaceItem/hooks/useDashboardSidebarWorkspaceItemActions/useDashboardSidebarWorkspaceItemActions.utils"
);
const {
	selectCurrentWorkspaceId,
	selectOnDashboardViewRoute,
	selectOnNewWorkspaceRoute,
	selectOnV2WorkspaceRoute,
} = await import("renderer/routes/_authenticated/_dashboard/layout.utils");

type Select = (
	matched: ParsedLocation,
	state: Pick<RouterState, "location">,
) => string | boolean | null;

const ROWS = ["A", "B"];
const SELECTS: Record<string, Select> = {
	...Object.fromEntries(
		ROWS.map((id): [string, Select] => [
			`row ${id} isActive`,
			(matched, state) => selectIsWorkspaceRowActive(matched, state, id),
		]),
	),
	"sidebar activeV2WorkspaceId": selectActiveV2WorkspaceId,
	"sidebar isSettingsOpen": selectIsSettingsOpen,
	"fuzzy v2 id": (matched) =>
		v2WorkspaceIdOf(matched.pathname, { fuzzy: true }),
	"layout currentWorkspaceId": selectCurrentWorkspaceId,
	"layout onV2WorkspaceRoute": selectOnV2WorkspaceRoute,
	"layout onNewWorkspaceRoute": selectOnNewWorkspaceRoute,
	"layout onDashboardViewRoute": selectOnDashboardViewRoute,
};

const rendered: Record<string, unknown> = {};
function Probe({ name, select }: { name: string; select: Select }) {
	rendered[name] = useActiveRoute(select);
	return null;
}
function Probes() {
	return (
		<>
			{Object.entries(SELECTS).map(([name, select]) => (
				<Probe key={name} name={name} select={select} />
			))}
			<Outlet />
		</>
	);
}

let gate: Promise<void> = Promise.resolve();
let release: () => void = () => {};
function hold() {
	gate = new Promise((resolve) => {
		release = resolve;
	});
}

const rootRoute = createRootRoute({ component: Probes });
const v2Workspace = createRoute({
	getParentRoute: () => rootRoute,
	path: "/v2-workspace/$workspaceId",
	loader: () => gate,
	gcTime: 0,
});
const v2WorkspaceNested = createRoute({
	getParentRoute: () => v2Workspace,
	path: "/nested",
});
const kanban = createRoute({
	getParentRoute: () => rootRoute,
	path: "/kanban/",
	validateSearch: (raw: Record<string, unknown>): { cardId?: string } => ({
		cardId:
			typeof raw.cardId === "string" && raw.cardId.length > 0
				? raw.cardId
				: undefined,
	}),
	loaderDeps: ({ search }) => ({ cardId: search.cardId }),
	loader: () => gate,
	gcTime: 0,
});
const plainPaths = [
	"/workspace/$workspaceId",
	"/settings",
	"/settings/appearance",
	"/new-workspace",
	"/pull-requests",
	"/plugins",
	"/pages",
	"/v2-workspaces",
	"/kanbanfoo",
];
const router = createRouter({
	routeTree: rootRoute.addChildren([
		v2Workspace.addChildren([v2WorkspaceNested]),
		kanban,
		...plainPaths.map((path) =>
			createRoute({ getParentRoute: () => rootRoute, path }),
		),
	]),
	history: createMemoryHistory({ initialEntries: ["/"] }),
});

type AnyTo = Parameters<typeof router.matchRoute>[0];
function today(to: string, params?: Record<string, string>, fuzzy = false) {
	return router.matchRoute({ to, params } as AnyTo, { fuzzy }) as
		| false
		| Record<string, string>;
}

const DASHBOARD_VIEWS = [
	"/pull-requests",
	"/plugins",
	"/pages",
	"/v2-workspaces",
];

function todayValues(): Record<string, unknown> {
	const cardId = (router.state.location.search as { cardId?: string }).cardId;
	const v2Fuzzy = today("/v2-workspace/$workspaceId", undefined, true);
	const v2Exact = today("/v2-workspace/$workspaceId");
	const v1 = today("/workspace/$workspaceId", undefined, true);
	const onKanban = !!today("/kanban", undefined, true);
	return {
		...Object.fromEntries(
			ROWS.map((id) => [
				`row ${id} isActive`,
				!!today("/v2-workspace/$workspaceId", { workspaceId: id }, true) ||
					(onKanban && cardId === id),
			]),
		),
		"sidebar activeV2WorkspaceId": v2Exact ? v2Exact.workspaceId : null,
		"sidebar isSettingsOpen": !!today("/settings", undefined, true),
		"fuzzy v2 id": v2Fuzzy !== false ? v2Fuzzy.workspaceId : null,
		"layout currentWorkspaceId": v1 ? v1.workspaceId : null,
		"layout onV2WorkspaceRoute": v2Fuzzy !== false,
		"layout onNewWorkspaceRoute": today("/new-workspace") !== false,
		"layout onDashboardViewRoute": DASHBOARD_VIEWS.some(
			(base) => today(base, undefined, true) !== false,
		),
	};
}

function compareAll(): string[] {
	const state = router.state;
	const matched = matchLocation(state);
	const expected = todayValues();
	return Object.entries(SELECTS)
		.map(([name, select]): [string, unknown] => [name, select(matched, state)])
		.filter(([name, helper]) => helper !== expected[name])
		.map(
			([name, helper]) =>
				`${name}: helper=${String(helper)} today=${String(expected[name])} at location=${state.location.href} resolved=${state.resolvedLocation?.href} isLoading=${state.isLoading}`,
		);
}

const mismatches: string[] = [];
let notifications = 0;
let pendingNotifications = 0;
function onNotify() {
	notifications++;
	const state = router.state;
	if (
		state.isLoading &&
		state.resolvedLocation !== undefined &&
		state.resolvedLocation.href !== state.location.href
	) {
		pendingNotifications++;
	}
	mismatches.push(...compareAll());
}
type Subscribable = { subscribe: (fn: () => void) => { unsubscribe(): void } };
const subscriptions = [
	router.stores.location,
	router.stores.isLoading,
	router.stores.resolvedLocation,
].map((store) => (store as unknown as Subscribable).subscribe(onNotify));

render(<RouterProvider router={router} />);
await act(() => router.load());

afterAll(() => {
	for (const subscription of subscriptions) subscription.unsubscribe();
	cleanup();
});

type Href = Parameters<typeof router.history.push>[0];

async function visit(href: Href) {
	await act(async () => {
		router.history.push(href);
	});
	await act(() => router.latestLoadPromise ?? Promise.resolve());
}

async function settled(hrefs: Href[]) {
	mismatches.length = 0;
	notifications = 0;
	for (const href of hrefs) await visit(href);
	expect(router.state.location.href).toBe(hrefs[hrefs.length - 1]);
	expect(notifications).toBeGreaterThan(0);
	expect(mismatches).toEqual([]);
}

async function pending(from: Href, to: Href) {
	await visit(from);
	mismatches.length = 0;
	notifications = 0;
	pendingNotifications = 0;
	hold();
	await act(async () => {
		router.history.push(to);
	});
	expect(router.state.isLoading).toBe(true);
	expect(router.state.resolvedLocation?.href).toBe(from);
	expect(mismatches).toEqual([]);
	expect(rendered).toEqual(todayValues());
	await act(async () => {
		release();
		await (router.latestLoadPromise ?? Promise.resolve());
	});
	expect(router.state.resolvedLocation?.href).toBe(to);
	expect(pendingNotifications).toBeGreaterThan(0);
	expect(mismatches).toEqual([]);
	expect(rendered).toEqual(todayValues());
}

describe("active-route selects match router.matchRoute at every notification", () => {
	test("active row, other row and a nested v2 path", async () => {
		await settled(["/v2-workspace/A", "/v2-workspace/A/nested"]);
	});
	test("fixed segments compare case-insensitively", async () => {
		await settled([
			"/V2-Workspace/A",
			"/KANBAN?cardId=A",
			"/Settings/appearance",
			"/New-Workspace",
		]);
	});
	test("/kanban with and without a card", async () => {
		await settled(["/kanban", "/kanban?cardId=A", "/kanban?cardId=B"]);
	});
	test("/kanbanfoo never matches /kanban", async () => {
		await settled(["/kanbanfoo?cardId=A"]);
		const path = matchLocation(router.state).pathname;
		expect(isUnder(path, "/kanban")).toBe(false);
	});
	test("dashboard views, v1 workspace and new-workspace", async () => {
		await settled([
			"/workspace/W1",
			"/new-workspace",
			"/pull-requests",
			"/plugins",
			"/pages",
			"/v2-workspaces",
		]);
	});
	test("settled v2 A to B", async () => {
		await settled(["/v2-workspace/A", "/v2-workspace/B"]);
	});
	test("pending v2 A to B", async () => {
		await pending("/v2-workspace/A", "/v2-workspace/B");
	});
	test("pending kanban A to B", async () => {
		await pending("/kanban?cardId=A", "/kanban?cardId=B");
	});
	test("v2 to settings", async () => {
		await settled(["/v2-workspace/A", "/settings/appearance"]);
	});
});
