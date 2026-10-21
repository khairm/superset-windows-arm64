/**
 * (MASTER-PLUS-LAUNCH) `isError` must describe the probe that is CURRENTLY in
 * charge, and nothing else.
 *
 * The hook runs two mutually exclusive probes: the main-workspace git probe
 * when the project has a master here, the multi-repo probe when it does not.
 * TanStack retains a query's `error` status after the query is disabled, so
 * OR-ing the two meant one transient multi-repo failure — routine before the
 * host workspace list has hydrated and the master id is known — left `isError`
 * true forever afterwards, and the new-workspace modal stayed stuck in the
 * branch flow for a project whose git probe had long since succeeded.
 */

import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	mock,
	test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const alreadyRegistered = GlobalRegistrator.isRegistered;
if (!alreadyRegistered) GlobalRegistrator.register();
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const MACHINE_ID = "host-1";
const PROJECT_ID = "project-1";
const MASTER_ID = "workspace-main";
const HOST_URL = "http://127.0.0.1:7777";

interface ProbeState {
	/** Result while the query is enabled. */
	isSuccess: boolean;
	isError: boolean;
	data: unknown;
}

let mainWorkspaceId: string | null = null;
let gitProbe: ProbeState = {
	isSuccess: false,
	isError: false,
	data: undefined,
};
let multiRepoProbe: ProbeState = {
	isSuccess: false,
	isError: false,
	data: null,
};

const realReactQuery = await import("@tanstack/react-query");

/**
 * The `useQuery` stub models TanStack's RETENTION: a disabled query keeps
 * whatever status it last had rather than resetting to idle. That retention is
 * the entire bug, so faking it away would make this test prove nothing.
 */
function installMocks(): void {
	mock.module("@tanstack/react-query", () => ({
		...realReactQuery,
		useQuery: (options: {
			queryKey: readonly unknown[];
			enabled?: boolean;
		}) => {
			const [kind] = options.queryKey;
			if (kind !== "is-git-repo" && kind !== "multi-repo-info") {
				return { data: undefined, isSuccess: false, isError: false };
			}
			const state = kind === "is-git-repo" ? gitProbe : multiRepoProbe;
			return {
				data: state.data,
				isSuccess: state.isSuccess,
				isError: state.isError,
			};
		},
	}));

	mock.module(
		"renderer/routes/_authenticated/providers/LocalHostServiceProvider",
		() => ({
			useLocalHostService: () => ({
				machineId: MACHINE_ID,
				activeHostUrl: HOST_URL,
			}),
		}),
	);

	// The master row's presence in this list is what `useProjectMainWorkspaceId`
	// and `useWorkspaceHostUrl` both read, so driving it here exercises the real
	// hooks instead of replacing them.
	mock.module(
		"renderer/routes/_authenticated/providers/HostWorkspacesProvider",
		() => ({
			useHostWorkspaces: () => ({
				workspaces: mainWorkspaceId
					? [
							{
								id: mainWorkspaceId,
								projectId: PROJECT_ID,
								hostId: MACHINE_ID,
								organizationId: "org-1",
								type: "main",
								name: "acme",
								branch: "main",
								worktreeExists: true,
								hostReachable: true,
							},
						]
					: [],
				isReady: true,
				isAuthoritative: true,
				isAbsenceAuthoritative: () => true,
				hostsSettled: true,
				cache: {},
			}),
		}),
	);

	mock.module(
		"renderer/routes/_authenticated/providers/SandboxAccessProvider",
		() => ({
			useSandboxAccess: () => ({ targets: [], isReady: true }),
		}),
	);

	mock.module("renderer/hooks/useRelayUrl", () => ({
		useRelayUrl: () => "https://relay.test",
	}));

	mock.module("renderer/lib/host-service-client", () => ({
		getHostServiceClientByUrl: () => ({}),
	}));
}

installMocks();

const { act, cleanup, render } = await import("@testing-library/react");
const React = await import("react");
const { useProjectGitState } = await import("../useProjectGitState");

type State = ReturnType<typeof useProjectGitState>;

let latest: State | null = null;

function Probe() {
	latest = useProjectGitState(PROJECT_ID);
	return null;
}

function mount() {
	return render(React.createElement(Probe));
}

beforeEach(() => {
	latest = null;
	mainWorkspaceId = null;
	gitProbe = { isSuccess: false, isError: false, data: undefined };
	multiRepoProbe = { isSuccess: false, isError: false, data: null };
});

afterEach(() => {
	cleanup();
});

afterAll(async () => {
	if (!alreadyRegistered) await GlobalRegistrator.unregister();
});

describe("(MASTER-PLUS-LAUNCH) useProjectGitState isError", () => {
	test("that same failure is forgotten once the master hydrates and the git probe answers", async () => {
		// Before hydration: no master id, so the multi-repo probe is the live
		// one — and it failed.
		multiRepoProbe = { isSuccess: false, isError: true, data: null };
		const view = mount();
		expect(latest?.isError).toBe(true);
		expect(latest?.isResolved).toBe(false);

		// The host workspace list lands. The master id appears, the git probe
		// takes over and succeeds. The multi-repo query is now DISABLED but
		// TanStack still reports its retained error — which must no longer count.
		mainWorkspaceId = MASTER_ID;
		gitProbe = { isSuccess: true, isError: false, data: { isGitRepo: false } };
		await act(async () => {
			view.rerender(React.createElement(Probe));
		});

		expect(latest?.isError).toBe(false);
		expect(latest?.isResolved).toBe(true);
		expect(latest?.isGitRepo).toBe(false);
		expect(latest?.mainWorkspaceId).toBe(MASTER_ID);
	});

	test("a stale git-probe error does not leak into the multi-repo answer", async () => {
		mainWorkspaceId = MASTER_ID;
		gitProbe = { isSuccess: false, isError: true, data: undefined };
		const view = mount();
		expect(latest?.isError).toBe(true);
		expect(latest?.isResolved).toBe(false);

		// The master row goes away (project converted to multi-repo). The git
		// probe is disabled with its error retained; the multi-repo probe is now
		// in charge and it is fine.
		mainWorkspaceId = null;
		multiRepoProbe = {
			isSuccess: true,
			isError: false,
			data: { isMultiRepo: true },
		};
		await act(async () => {
			view.rerender(React.createElement(Probe));
		});

		expect(latest?.isError).toBe(false);
		expect(latest?.isMultiRepo).toBe(true);
		expect(latest?.isResolved).toBe(true);
	});
});
