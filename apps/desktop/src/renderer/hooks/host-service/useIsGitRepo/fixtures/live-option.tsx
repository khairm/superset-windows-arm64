import { afterAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://localhost" });
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const gitWatches: string[] = [];

mock.module("renderer/hooks/host-service/useWorkspaceHostUrl", () => ({
	useWorkspaceHostUrl: () => "http://host",
}));
mock.module("renderer/lib/host-service-client", () => ({
	getHostServiceClientByUrl: () => ({
		git: { isRepo: { query: async () => ({ isGitRepo: true }) } },
	}),
}));
mock.module("renderer/lib/host-event-bus", () => ({
	getHostEventBus: () => ({
		watchGit: (workspaceId: string) => gitWatches.push(workspaceId),
		unwatchGit: () => {},
		on: () => () => {},
		retain: () => () => {},
	}),
}));

const { act, cleanup, render } = await import("@testing-library/react/pure");
const { QueryClient, QueryClientProvider } = await import(
	"@tanstack/react-query"
);
const { useIsGitRepo } = await import("../useIsGitRepo");

function Row({ live }: { live: boolean }) {
	useIsGitRepo("workspace-1", true, { live });
	return null;
}

const queryClient = new QueryClient();

afterAll(() => {
	cleanup();
	queryClient.clear();
});

describe("(SIDEBAR-ROW-NO-GIT-WATCH) useIsGitRepo", () => {
	test("live: false sends no git:watch; the default still does", async () => {
		await act(async () => {
			render(
				<QueryClientProvider client={queryClient}>
					<Row live={false} />
				</QueryClientProvider>,
			);
		});
		expect(gitWatches).toEqual([]);

		await act(async () => {
			render(
				<QueryClientProvider client={queryClient}>
					<Row live />
				</QueryClientProvider>,
			);
		});
		expect(gitWatches).toEqual(["workspace-1"]);
	});
});
