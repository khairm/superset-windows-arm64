import { afterAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://localhost" });
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

mock.module("posthog-js/react", () => ({
	useFeatureFlagEnabled: () => false,
}));
mock.module("renderer/lib/cloud-trpc", () => ({
	cloudTrpc: {
		cloudWorkspace: { list: { useQuery: () => ({ data: undefined }) } },
	},
}));
mock.module("renderer/hooks/useActiveOrganizationId", () => ({
	useActiveOrganizationId: () => "org-1",
}));

const { act, cleanup, render } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import(
	"@tanstack/react-query"
);
const {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	RouterProvider,
	useRouterState,
} = await import("@tanstack/react-router");
const { SandboxAccessProvider, useSandboxAccess } = await import(
	"../SandboxAccessProvider"
);

const seen: ReturnType<typeof useSandboxAccess>[] = [];

function Probe() {
	seen.push(useSandboxAccess());
	return null;
}

function Harness() {
	useRouterState({ select: (state) => state.location.pathname });
	return (
		<SandboxAccessProvider>
			<Probe />
		</SandboxAccessProvider>
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
const queryClient = new QueryClient();

render(
	<QueryClientProvider client={queryClient}>
		<RouterProvider router={router} />
	</QueryClientProvider>,
);
await act(() => router.load());

afterAll(() => {
	cleanup();
	queryClient.clear();
});

describe("SandboxAccessProvider with the cloud flag off", () => {
	test("renders across a navigation keep the same value", async () => {
		const rendersBefore = seen.length;
		await act(async () => {
			await router.navigate({
				to: "/v2-workspace/$workspaceId",
				params: { workspaceId: "B" },
			});
		});
		expect(seen.length).toBeGreaterThan(rendersBefore);
		expect(seen.at(-1)).toBe(seen[0]);
		expect(seen[0]).toEqual({ targets: [], isReady: true });
	});
});
