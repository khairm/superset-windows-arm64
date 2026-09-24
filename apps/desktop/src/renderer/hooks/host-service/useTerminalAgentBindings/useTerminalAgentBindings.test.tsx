import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, StrictMode } from "react";

const alreadyRegistered = GlobalRegistrator.isRegistered;
if (!alreadyRegistered) GlobalRegistrator.register();
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const WORKSPACE_ID = "workspace-1";
const HOST_A = "http://host-a";
const HOST_B = "http://host-b";
let hostUrl: string | null = HOST_A;
let fetchBindings: (url: string) => Promise<Array<{ terminalId: string }>> =
	async () => [];
const fetchUrls: string[] = [];
type Listener = (workspaceId: string, payload: unknown) => void;

class TestBus {
	listeners = new Map<string, Set<Listener>>();
	retains = 0;
	releases = 0;

	on(type: string, workspaceId: string, callback: Listener) {
		const key = `${type}:${workspaceId}`;
		let listeners = this.listeners.get(key);
		if (!listeners) {
			listeners = new Set();
			this.listeners.set(key, listeners);
		}
		listeners.add(callback);
		return () => {
			listeners.delete(callback);
			if (listeners.size === 0) this.listeners.delete(key);
		};
	}

	retain() {
		this.retains++;
		return () => {
			this.releases++;
		};
	}

	emit(type: string, workspaceId = WORKSPACE_ID, payload: unknown = {}) {
		for (const listener of this.listeners.get(`${type}:${workspaceId}`) ?? []) {
			listener(workspaceId, payload);
		}
	}
}

const buses = new Map<string, TestBus>();
function bus(url: string) {
	let result = buses.get(url);
	if (!result) {
		result = new TestBus();
		buses.set(url, result);
	}
	return result;
}

mock.module("renderer/lib/host-event-bus", () => ({
	getHostEventBus: (url: string) => bus(url),
}));
mock.module("renderer/lib/host-service-client", () => ({
	getHostServiceClientByUrl: (url: string) => ({
		terminalAgents: {
			listByWorkspace: {
				query: ({ workspaceId }: { workspaceId: string }) => {
					if (workspaceId !== WORKSPACE_ID)
						throw new Error("unexpected workspace");
					fetchUrls.push(url);
					return fetchBindings(url);
				},
			},
		},
	}),
}));
mock.module("../useWorkspaceHostUrl", () => ({
	useWorkspaceHostUrl: () => hostUrl,
}));
mock.module("renderer/hooks/host-service/useDiffStats", () => ({
	getDiffStatsQueryKey: (url: string, workspaceId: string) => [
		"diff-stats",
		url,
		workspaceId,
	],
	useDiffStats: () => null,
}));
mock.module("renderer/hooks/host-service/useTerminalAgentStatuses", () => ({
	deriveTerminalAgentStatus: () => null,
}));
mock.module(
	"renderer/routes/_authenticated/providers/HostWorkspacesProvider",
	() => ({
		useHostWorkspaces: () => {
			throw new Error("unexpected host workspace read");
		},
	}),
);
mock.module("renderer/stores/v2-notifications", () => ({
	useV2NotificationStore: (selector: (state: object) => unknown) =>
		selector({
			manualUnread: {},
			terminalSeenAt: {},
			markTerminalSeen: () => {},
		}),
}));

const { act, cleanup, render, waitFor } = await import(
	"@testing-library/react"
);
const { useTerminalAgentBindings } = await import("./useTerminalAgentBindings");
const { DashboardSidebarWorkspaceStatusProvider, useSidebarWorkspaceStatus } =
	await import(
		"renderer/routes/_authenticated/_dashboard/components/DashboardSidebar/providers/DashboardSidebarWorkspaceStatusProvider/DashboardSidebarWorkspaceStatusProvider"
	);

function SidebarRow() {
	const entry = useSidebarWorkspaceStatus(WORKSPACE_ID);
	return (
		<output data-testid="sidebar">
			{[...entry.bindings.keys()].join(",")}
		</output>
	);
}

function WithSidebar() {
	return (
		<DashboardSidebarWorkspaceStatusProvider
			targets={[{ workspaceId: WORKSPACE_ID, hostUrl: HOST_A }]}
			activeWorkspaceId={null}
		>
			<Consumer />
			<SidebarRow />
		</DashboardSidebarWorkspaceStatusProvider>
	);
}

function Consumer({ enabled = true }: { enabled?: boolean }) {
	const bindings = useTerminalAgentBindings(WORKSPACE_ID, { enabled });
	return (
		<output data-testid="bindings">{[...bindings.keys()].join(",")}</output>
	);
}

function withClient(client: QueryClient, children: ReactNode) {
	return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function newClient() {
	return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function oneTerminalPerHost() {
	fetchBindings = async (url) => [
		{ terminalId: url === HOST_A ? "old-terminal" : "new-terminal" },
	];
}

beforeEach(() => {
	cleanup();
	buses.clear();
	fetchUrls.length = 0;
	hostUrl = HOST_A;
	fetchBindings = async () => [];
});

afterAll(async () => {
	cleanup();
	if (!alreadyRegistered) await GlobalRegistrator.unregister();
});

describe("useTerminalAgentBindings (BINDINGS-COALESCE)", () => {
	test("shares one bus subscription through StrictMode remounts", async () => {
		const client = newClient();
		const children = (
			<StrictMode>
				{withClient(
					client,
					<>
						<Consumer />
						<Consumer />
					</>,
				)}
			</StrictMode>
		);
		const view = render(children);
		const hostBus = bus(HOST_A);
		expect(hostBus.retains).toBe(2);
		expect(hostBus.releases).toBe(1);
		expect(hostBus.listeners.size).toBe(3);
		await waitFor(() => expect(fetchUrls).toHaveLength(1));

		act(() => hostBus.emit("agent:lifecycle"));
		await waitFor(() => expect(fetchUrls).toHaveLength(2));
		view.unmount();
		expect(hostBus.releases).toBe(2);
		expect(hostBus.listeners.size).toBe(0);

		const remounted = render(children);
		expect(hostBus.retains).toBe(4);
		expect(hostBus.releases).toBe(3);
		expect(hostBus.listeners.size).toBe(3);
		remounted.unmount();
		expect(hostBus.releases).toBe(4);
	});

	test("disabled consumers do not acquire or keep subscriptions", () => {
		const client = newClient();
		const view = render(withClient(client, <Consumer enabled={false} />));
		expect(buses.size).toBe(0);
		expect(fetchUrls).toHaveLength(0);

		view.rerender(withClient(client, <Consumer />));
		const hostBus = bus(HOST_A);
		expect(hostBus.retains).toBe(1);
		view.rerender(withClient(client, <Consumer enabled={false} />));
		expect(hostBus.releases).toBe(1);
		expect(hostBus.listeners.size).toBe(0);
	});

	test("moves the subscription when the workspace host changes", async () => {
		const client = newClient();
		const view = render(withClient(client, <Consumer />));
		await waitFor(() => expect(fetchUrls).toHaveLength(1));
		const oldBus = bus(HOST_A);
		hostUrl = HOST_B;
		view.rerender(withClient(client, <Consumer />));
		expect(oldBus.releases).toBe(1);
		expect(oldBus.listeners.size).toBe(0);
		expect(bus(HOST_B).retains).toBe(1);

		act(() => oldBus.emit("terminal:lifecycle"));
		await waitFor(() => expect(fetchUrls).toEqual([HOST_A, HOST_B]));
		view.unmount();
		expect(bus(HOST_B).releases).toBe(1);
	});

	test("refetches fresh cached bindings on host change without an event", async () => {
		const client = newClient();
		oneTerminalPerHost();
		const view = render(withClient(client, <Consumer />));
		await waitFor(() =>
			expect(view.getByTestId("bindings").textContent).toBe("old-terminal"),
		);
		hostUrl = HOST_B;
		view.rerender(withClient(client, <Consumer />));
		await waitFor(() =>
			expect(view.getByTestId("bindings").textContent).toBe("new-terminal"),
		);
		expect(fetchUrls).toEqual([HOST_A, HOST_B]);
		view.unmount();
	});

	test("refetches cached bindings after the host changes while disabled", async () => {
		const client = newClient();
		oneTerminalPerHost();
		const view = render(withClient(client, <Consumer />));
		await waitFor(() =>
			expect(view.getByTestId("bindings").textContent).toBe("old-terminal"),
		);
		view.rerender(withClient(client, <Consumer enabled={false} />));
		hostUrl = HOST_B;
		view.rerender(withClient(client, <Consumer enabled={false} />));
		expect(fetchUrls).toEqual([HOST_A]);
		view.rerender(withClient(client, <Consumer />));
		await waitFor(() =>
			expect(view.getByTestId("bindings").textContent).toBe("new-terminal"),
		);
		expect(fetchUrls).toEqual([HOST_A, HOST_B]);
		view.unmount();
	});

	test("refetches cached bindings after the host changes while unmounted", async () => {
		const client = newClient();
		oneTerminalPerHost();
		const first = render(withClient(client, <Consumer />));
		await waitFor(() =>
			expect(first.getByTestId("bindings").textContent).toBe("old-terminal"),
		);
		first.unmount();
		hostUrl = HOST_B;
		const remounted = render(withClient(client, <Consumer />));
		await waitFor(() =>
			expect(remounted.getByTestId("bindings").textContent).toBe(
				"new-terminal",
			),
		);
		expect(fetchUrls).toEqual([HOST_A, HOST_B]);
		remounted.unmount();
	});

	test("does not share an owner across QueryClients", async () => {
		const first = render(withClient(newClient(), <Consumer />));
		const second = render(withClient(newClient(), <Consumer />));
		const hostBus = bus(HOST_A);
		expect(hostBus.retains).toBe(2);
		expect(hostBus.listeners.get(`agent:lifecycle:${WORKSPACE_ID}`)?.size).toBe(
			2,
		);
		await waitFor(() => expect(fetchUrls).toHaveLength(2));
		act(() => hostBus.emit("agent:lifecycle"));
		await waitFor(() => expect(fetchUrls).toHaveLength(4));

		first.unmount();
		expect(hostBus.releases).toBe(1);
		expect(hostBus.listeners.get(`agent:lifecycle:${WORKSPACE_ID}`)?.size).toBe(
			1,
		);
		second.unmount();
		expect(hostBus.releases).toBe(2);
	});

	test("fetches after a lifecycle event joins an external refresh", async () => {
		const client = newClient();
		let completeOld!: (bindings: Array<{ terminalId: string }>) => void;
		let requests = 0;
		fetchBindings = () => {
			requests++;
			if (requests === 2) {
				return new Promise((resolve) => {
					completeOld = resolve;
				});
			}
			return Promise.resolve(requests === 1 ? [{ terminalId: "exited" }] : []);
		};
		const view = render(withClient(client, <Consumer />));
		await waitFor(() =>
			expect(view.getByTestId("bindings").textContent).toBe("exited"),
		);
		let externalRefresh!: Promise<void>;
		act(() => {
			externalRefresh = client.refetchQueries({
				queryKey: ["terminal-agent-bindings", WORKSPACE_ID],
			});
		});
		await waitFor(() => expect(requests).toBe(2));
		act(() => bus(HOST_A).emit("terminal:lifecycle"));
		expect(requests).toBe(2);
		await act(async () => {
			completeOld([{ terminalId: "exited" }]);
			await externalRefresh;
		});
		await waitFor(() => expect(requests).toBe(3));
		await waitFor(() =>
			expect(view.getByTestId("bindings").textContent).toBe(""),
		);
		view.unmount();
	});

	test("finishes a trailing refresh after the last consumer unmounts", async () => {
		const client = newClient();
		let completeOld!: (bindings: Array<{ terminalId: string }>) => void;
		let requests = 0;
		fetchBindings = () => {
			requests++;
			if (requests === 2) {
				return new Promise((resolve) => {
					completeOld = resolve;
				});
			}
			return Promise.resolve(
				requests === 1 ? [{ terminalId: "old" }] : [{ terminalId: "new" }],
			);
		};
		const first = render(withClient(client, <Consumer />));
		await waitFor(() =>
			expect(first.getByTestId("bindings").textContent).toBe("old"),
		);
		const hostBus = bus(HOST_A);
		act(() => hostBus.emit("agent:lifecycle"));
		await waitFor(() => expect(requests).toBe(2));
		act(() => hostBus.emit("terminal:lifecycle"));
		first.unmount();
		expect(hostBus.releases).toBe(1);
		expect(hostBus.listeners.size).toBe(0);
		await act(async () => completeOld([{ terminalId: "old" }]));
		await waitFor(() => expect(requests).toBe(3));
		const remounted = render(withClient(client, <Consumer />));
		await waitFor(() =>
			expect(remounted.getByTestId("bindings").textContent).toBe("new"),
		);
		expect(fetchUrls).toHaveLength(3);
		remounted.unmount();
	});

	test("sidebar and hook share one non-cancelling refresh", async () => {
		const client = newClient();
		let completeOld!: (bindings: Array<{ terminalId: string }>) => void;
		let requests = 0;
		fetchBindings = () => {
			requests++;
			if (requests === 2) {
				return new Promise((resolve) => {
					completeOld = resolve;
				});
			}
			return Promise.resolve(
				requests === 1 ? [{ terminalId: "old" }] : [{ terminalId: "new" }],
			);
		};
		const view = render(withClient(client, <WithSidebar />));
		await waitFor(() =>
			expect(view.getByTestId("sidebar").textContent).toBe("old"),
		);
		const hostBus = bus(HOST_A);
		expect(hostBus.retains).toBe(1);
		expect(hostBus.listeners.get(`agent:lifecycle:${WORKSPACE_ID}`)?.size).toBe(
			1,
		);
		act(() => hostBus.emit("agent:lifecycle"));
		await waitFor(() => expect(requests).toBe(2));
		act(() => {
			hostBus.emit("terminal:lifecycle");
			hostBus.emit("agent:bindings-changed");
		});
		expect(requests).toBe(2);
		await act(async () => completeOld([{ terminalId: "old" }]));
		await waitFor(() => expect(requests).toBe(3));
		await waitFor(() =>
			expect(view.getByTestId("sidebar").textContent).toBe("new"),
		);
		view.unmount();
		expect(hostBus.releases).toBe(1);
	});

	test("runs one non-cancelling trailing refresh for events during a refresh", async () => {
		const client = newClient();
		let completeFirst!: (bindings: Array<{ terminalId: string }>) => void;
		let refreshes = 0;
		fetchBindings = () => {
			refreshes++;
			if (refreshes === 2) {
				return new Promise((resolve) => {
					completeFirst = resolve;
				});
			}
			return Promise.resolve([]);
		};
		const view = render(withClient(client, <Consumer />));
		await waitFor(() => expect(refreshes).toBe(1));
		const hostBus = bus(HOST_A);
		act(() => hostBus.emit("agent:lifecycle"));
		await waitFor(() => expect(refreshes).toBe(2));
		act(() => {
			hostBus.emit("terminal:lifecycle");
			hostBus.emit("agent:bindings-changed");
		});
		expect(refreshes).toBe(2);
		await act(async () => completeFirst([]));
		await waitFor(() => expect(refreshes).toBe(3));
		expect(fetchUrls).toHaveLength(3);
		view.unmount();
	});
});
