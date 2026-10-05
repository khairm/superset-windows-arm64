import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

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
	RouterProvider,
} = await import("@tanstack/react-router");
const { isExactly, isUnder, matchLocation, v1WorkspaceIdOf, v2WorkspaceIdOf } =
	await import("../active-route");

let gate: Promise<void> = Promise.resolve();
let release: () => void = () => {};
function hold() {
	gate = new Promise((resolve) => {
		release = resolve;
	});
}

const rootRoute = createRootRoute();
const v2Workspace = createRoute({
	getParentRoute: () => rootRoute,
	path: "/v2-workspace/$workspaceId",
	loader: () => gate,
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

const ROWS = ["A", "B"];
const DASHBOARD_VIEWS = [
	"/pull-requests",
	"/plugins",
	"/pages",
	"/v2-workspaces",
];

function compareAll(): string[] {
	const state = router.state;
	const matched = matchLocation(state);
	const path = matched.pathname;
	const cardId = (state.location.search as { cardId?: string }).cardId;
	const v2Fuzzy = today("/v2-workspace/$workspaceId", undefined, true);
	const v2Exact = today("/v2-workspace/$workspaceId");
	const v1 = today("/workspace/$workspaceId", undefined, true);
	const onKanban = !!today("/kanban", undefined, true);
	const pairs: [string, unknown, unknown][] = [
		...ROWS.map((id): [string, unknown, unknown] => [
			`row ${id} isActive`,
			v2WorkspaceIdOf(path, { fuzzy: true }) === id ||
				(isUnder(path, "/kanban") && cardId === id),
			!!today("/v2-workspace/$workspaceId", { workspaceId: id }, true) ||
				(onKanban && cardId === id),
		]),
		[
			"sidebar activeV2WorkspaceId",
			v2WorkspaceIdOf(path, { fuzzy: false }),
			v2Exact ? v2Exact.workspaceId : null,
		],
		[
			"sidebar isSettingsOpen",
			isUnder(path, "/settings"),
			!!today("/settings", undefined, true),
		],
		[
			"fuzzy v2 id",
			v2WorkspaceIdOf(path, { fuzzy: true }),
			v2Fuzzy !== false ? v2Fuzzy.workspaceId : null,
		],
		[
			"layout currentWorkspaceId",
			v1WorkspaceIdOf(path),
			v1 ? v1.workspaceId : null,
		],
		[
			"layout onV2WorkspaceRoute",
			v2WorkspaceIdOf(path, { fuzzy: true }) !== null,
			v2Fuzzy !== false,
		],
		[
			"layout onNewWorkspaceRoute",
			isExactly(path, "/new-workspace"),
			today("/new-workspace") !== false,
		],
		[
			"layout onDashboardViewRoute",
			DASHBOARD_VIEWS.some((base) => isUnder(path, base)),
			DASHBOARD_VIEWS.some((base) => today(base, undefined, true) !== false),
		],
	];
	return pairs
		.filter(([, helper, expected]) => helper !== expected)
		.map(
			([name, helper, expected]) =>
				`${name}: helper=${String(helper)} today=${String(expected)} at location=${state.location.href} resolved=${state.resolvedLocation?.href} isLoading=${state.isLoading}`,
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
	expect(mismatches).toEqual([]);
	await act(async () => {
		release();
		await (router.latestLoadPromise ?? Promise.resolve());
	});
	expect(router.state.resolvedLocation?.href).toBe(to);
	expect(pendingNotifications).toBeGreaterThan(0);
	expect(mismatches).toEqual([]);
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
