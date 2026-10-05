import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://localhost" });
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const { act, cleanup, render } = await import("@testing-library/react/pure");
const {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	RouterProvider,
} = await import("@tanstack/react-router");
const { useActiveRoute, v2WorkspaceIdOf } = await import(
	"renderer/lib/active-route"
);
const { DashboardSidebarSelectionProvider, useDashboardSidebarSelection } =
	await import("../DashboardSidebarSelectionProvider");

type SelectionValue = ReturnType<typeof useDashboardSidebarSelection>;

const ORDERED = ["A", "B", "C", "D"];
const AVAILABLE = new Set(ORDERED);
const seen: SelectionValue[] = [];
const activeIds: (string | null)[] = [];

function Consumer() {
	seen.push(useDashboardSidebarSelection());
	return null;
}

function Harness() {
	const activeWorkspaceId = useActiveRoute((matched) =>
		v2WorkspaceIdOf(matched.pathname, { fuzzy: false }),
	);
	activeIds.push(activeWorkspaceId);
	return (
		<DashboardSidebarSelectionProvider
			availableWorkspaceIds={AVAILABLE}
			activeWorkspaceId={activeWorkspaceId}
		>
			<Consumer />
		</DashboardSidebarSelectionProvider>
	);
}

const rootRoute = createRootRoute({ component: Harness });
const router = createRouter({
	routeTree: rootRoute.addChildren([
		createRoute({
			getParentRoute: () => rootRoute,
			path: "/v2-workspace/$workspaceId",
		}),
	]),
	history: createMemoryHistory({ initialEntries: ["/v2-workspace/A"] }),
});

render(<RouterProvider router={router} />);
await act(() => router.load());

afterAll(() => cleanup());

function shiftEvent() {
	return {
		ctrlKey: false,
		metaKey: false,
		shiftKey: true,
		preventDefault: () => {},
		stopPropagation: () => {},
	};
}

describe("DashboardSidebarSelectionProvider", () => {
	test("a new active workspace keeps the context value's identity", async () => {
		expect(activeIds.at(-1)).toBe("A");
		const before = seen.at(-1);
		const rendersBefore = seen.length;
		await act(async () => {
			await router.navigate({
				to: "/v2-workspace/$workspaceId",
				params: { workspaceId: "B" },
			});
		});
		expect(activeIds.at(-1)).toBe("B");
		expect(seen.length).toBeGreaterThan(rendersBefore);
		expect(seen.at(-1)).toBe(before);
	});

	test("shift-click anchors the range on the new active workspace", async () => {
		await act(async () => {
			seen.at(-1)?.selectWorkspaceFromEvent(shiftEvent(), {
				workspaceId: "D",
				projectId: "project-1",
				orderedWorkspaceIds: ORDERED,
			});
		});
		expect(seen.at(-1)?.selectedWorkspaceIds).toEqual(["B", "C", "D"]);
	});
});
