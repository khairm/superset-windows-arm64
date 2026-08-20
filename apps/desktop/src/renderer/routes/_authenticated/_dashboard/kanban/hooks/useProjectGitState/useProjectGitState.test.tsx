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
const realLocalHostServiceProvider = await import(
	"renderer/routes/_authenticated/providers/LocalHostServiceProvider"
);
const realHostWorkspacesProvider = await import(
	"renderer/routes/_authenticated/providers/HostWorkspacesProvider"
);
const realCloudTrpc = await import("renderer/lib/cloud-trpc");

/**
 * `mock.module` is PROCESS-GLOBAL with no unmock and bun runs every test file
 * in one process, so a stub installed here is still installed for whatever
 * file runs next. The mocked SET is therefore deliberately identical to
 * `PromptGroup.test.tsx`'s (the other suite that drives this hook's inputs),
 * and every install is repeated in `beforeEach` — whichever file runs second
 * takes its own stubs back. Nothing that only THIS file needs is stubbed:
 * `useProjectMainWorkspaceId` and `useWorkspaceHostUrl` are driven through the
 * real hooks by way of the host workspace list, because stubbing them was
 * exactly how this file broke the other one.
 *
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
			...realLocalHostServiceProvider,
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
			...realHostWorkspacesProvider,
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

	mock.module("renderer/hooks/useRelayUrl", () => ({
		useRelayUrl: () => "https://relay.test",
	}));

	// Named explicitly rather than spread from the real module: importing it
	// installs a better-auth proxy client and its token plumbing.
	mock.module("renderer/lib/auth-client", () => ({
		authClient: {
			useSession: () => ({
				data: { session: { activeOrganizationId: "org-1" } },
			}),
		},
		setAuthToken: () => {},
		getAuthToken: () => null,
		useAuthToken: () => null,
		setJwt: () => {},
		getJwt: () => null,
		ensureFreshJwt: async () => null,
	}));

	mock.module("renderer/lib/cloud-trpc", () => ({
		...realCloudTrpc,
		cloudTrpc: {
			cloudWorkspace: {
				create: {
					useMutation: () => ({
						mutateAsync: async () => ({}),
						isPending: false,
					}),
				},
				list: { useQuery: () => ({ data: [], isFetched: true }) },
				access: { useMutation: () => ({ mutateAsync: async () => ({}) }) },
			},
			useUtils: () => ({
				cloudWorkspace: {
					list: {
						cancel: async () => {},
						setData: () => {},
						invalidate: () => {},
					},
				},
			}),
		},
	}));
}

installMocks();

const { act, cleanup, render } = await import("@testing-library/react");
const React = await import("react");
const { useProjectGitState } = await import("./useProjectGitState");

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
	installMocks();
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
	test("a failed multi-repo probe is an error while it is the live probe", () => {
		multiRepoProbe = { isSuccess: false, isError: true, data: null };
		mount();
		expect(latest?.isError).toBe(true);
		expect(latest?.isResolved).toBe(false);
	});

	test("that same failure is forgotten once the master hydrates and the git probe answers", async () => {
		// Before hydration: no master id, so the multi-repo probe is the live
		// one — and it failed.
		multiRepoProbe = { isSuccess: false, isError: true, data: null };
		const view = mount();
		expect(latest?.isError).toBe(true);

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

	test("a failed git probe is still an error", () => {
		mainWorkspaceId = MASTER_ID;
		gitProbe = { isSuccess: false, isError: true, data: undefined };
		mount();
		expect(latest?.isError).toBe(true);
		expect(latest?.isResolved).toBe(false);
	});

	test("a stale git-probe error does not leak into the multi-repo answer", async () => {
		mainWorkspaceId = MASTER_ID;
		gitProbe = { isSuccess: false, isError: true, data: undefined };
		const view = mount();
		expect(latest?.isError).toBe(true);

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

	test("a healthy git project reports no error", () => {
		mainWorkspaceId = MASTER_ID;
		gitProbe = { isSuccess: true, isError: false, data: { isGitRepo: true } };
		mount();
		expect(latest?.isError).toBe(false);
		expect(latest?.isGitRepo).toBe(true);
		expect(latest?.isResolved).toBe(true);
	});
});
