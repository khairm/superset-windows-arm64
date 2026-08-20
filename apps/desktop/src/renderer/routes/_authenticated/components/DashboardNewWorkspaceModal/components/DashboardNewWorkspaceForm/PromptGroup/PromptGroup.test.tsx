/**
 * (MASTER-PLUS-LAUNCH) The new-workspace modal's master mode, exercised
 * through `PromptGroup` — the component that owns both the branch-vs-master
 * rendering and every submit trigger.
 *
 * `resolveMasterMode.test.ts` owns WHICH mode a project resolves to. This file
 * owns what the form does once it is in one: what disappears, what stays, what
 * submit blocks on, and the order the master submit does things in.
 *
 * The data sources are stubbed at their leaves (host workspaces, the git-ness
 * probe's `useQuery`, the host client) rather than at `useMasterWorkspaceTarget`,
 * so the hook's own plumbing — which field feeds which rung — is covered too.
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

// happy-dom over the preloaded plain-object document, so this renders a real
// tree. Bun runs test files in one process and happy-dom's globals are
// process-wide, so this MUST be unregistered in afterAll.
const alreadyRegistered = GlobalRegistrator.isRegistered;
if (!alreadyRegistered) GlobalRegistrator.register();
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const MACHINE_ID = "host-1";
const PROJECT_ID = "project-1";
const MASTER_WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const HOST_URL = "http://127.0.0.1:7777";
const AGENT_ID = "claude";

// ── Mutable test state, read by the stubs below ──────────────────────
let isGitRepo = false;
let gitProbeSucceeded = true;
let gitProbeErrored = false;
let absenceAuthoritative = true;
let hostWorkspaceRows: Array<Record<string, unknown>> = [];
let uploadErrors: Array<{ filename?: string; message: string }> = [];
let uploadIds: string[] = [];
let promptBuildError: Error | null = null;
let agentsRunImpl: (input: unknown) => Promise<unknown> = async () => ({});

let agentsRunCalls: unknown[] = [];
let workspaceCreateCalls: unknown[] = [];
let toastErrors: string[] = [];
let order: string[] = [];
let sidebarCalls: string[] = [];

function resetState(): void {
	isGitRepo = false;
	gitProbeSucceeded = true;
	gitProbeErrored = false;
	absenceAuthoritative = true;
	hostWorkspaceRows = [
		{
			id: MASTER_WORKSPACE_ID,
			projectId: PROJECT_ID,
			hostId: MACHINE_ID,
			organizationId: "org-1",
			type: "main",
			name: "acme",
			branch: "main",
			worktreeExists: true,
			hostReachable: true,
		},
	];
	uploadErrors = [];
	uploadIds = [];
	promptBuildError = null;
	agentsRunImpl = async () => ({});
	agentsRunCalls = [];
	workspaceCreateCalls = [];
	toastErrors = [];
	order = [];
	sidebarCalls = [];
}
resetState();

// ── Stubs ────────────────────────────────────────────────────────────
// `mock.module` is PROCESS-GLOBAL with no unmock, so every module below is
// either re-exported whole with a single override, or is a leaf whose only
// consumer is this component tree.

const realReactQuery = await import("@tanstack/react-query");
const realRouter = await import("@tanstack/react-router");
const realSonner = await import("@superset/ui/sonner");
const realCloudTrpc = await import("renderer/lib/cloud-trpc");
const realHostServiceClient = await import("renderer/lib/host-service-client");
const realHostServiceUnavailable = await import(
	"renderer/lib/host-service-unavailable"
);
const realLocalHostServiceProvider = await import(
	"renderer/routes/_authenticated/providers/LocalHostServiceProvider"
);
const realHostWorkspacesProvider = await import(
	"renderer/routes/_authenticated/providers/HostWorkspacesProvider"
);
const realWorkspaceCreates = await import("renderer/stores/workspace-creates");
const realNewWorkspaceModal = await import(
	"renderer/stores/new-workspace-modal"
);
const realPromptContext = await import(
	"renderer/stores/new-workspace-prompt-context"
);

function installMocks(): void {
	// The git-ness / multi-repo probes. Dispatched on the query key so the two
	// answer independently; anything else gets a neutral idle result.
	mock.module("@tanstack/react-query", () => ({
		...realReactQuery,
		useQuery: (options: {
			queryKey: readonly unknown[];
			enabled?: boolean;
		}) => {
			const [kind] = options.queryKey;
			if (kind === "is-git-repo") {
				const enabled = options.enabled !== false;
				return {
					data: enabled && gitProbeSucceeded ? { isGitRepo } : undefined,
					isSuccess: enabled && gitProbeSucceeded,
					isError: enabled && gitProbeErrored,
				};
			}
			if (kind === "multi-repo-info") {
				return { data: null, isSuccess: false, isError: false };
			}
			return { data: undefined, isSuccess: false, isError: false };
		},
	}));

	mock.module("@tanstack/react-router", () => ({
		...realRouter,
		useNavigate: () => (args: unknown) => {
			order.push("navigate");
			void args;
			return Promise.resolve();
		},
		useMatchRoute: () => () => false,
	}));

	mock.module("@superset/ui/sonner", () => ({
		...realSonner,
		toast: Object.assign(
			(message: string) => {
				toastErrors.push(message);
			},
			{
				error: (message: string) => {
					toastErrors.push(String(message));
				},
				success: () => {},
				info: () => {},
				warning: () => {},
				message: () => {},
				dismiss: () => {},
			},
		),
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

	mock.module(
		"renderer/routes/_authenticated/providers/HostWorkspacesProvider",
		() => ({
			...realHostWorkspacesProvider,
			useHostWorkspaces: () => ({
				workspaces: hostWorkspaceRows,
				isReady: true,
				isAuthoritative: absenceAuthoritative,
				isAbsenceAuthoritative: () => absenceAuthoritative,
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

	mock.module("renderer/lib/host-service-client", () => ({
		...realHostServiceClient,
		getHostServiceClientByUrl: (url: string) => ({
			agents: {
				run: {
					mutate: (input: unknown) => {
						order.push("agents.run");
						agentsRunCalls.push({ url, input });
						return agentsRunImpl(input);
					},
				},
			},
		}),
	}));

	mock.module(
		"renderer/routes/_authenticated/hooks/useDashboardSidebarState",
		() => ({
			useDashboardSidebarState: () => ({
				// `restoreWorkspace` is the one primitive that clears EVERY
				// inactive marker (deletedAt / archivedAt / completedAt / snooze /
				// isHidden). What it clears is asserted where it lives; here we
				// assert the master submit reaches for it rather than for the
				// narrower unarchive+unsnooze pair, which left a Recycle-Binned
				// master in the bin while the agent launched into it.
				restoreWorkspace: (id: string) => {
					sidebarCalls.push(`restore:${id}`);
				},
				ensureWorkspaceInSidebar: (id: string, projectId: string | null) => {
					sidebarCalls.push(`ensure:${id}:${projectId}`);
				},
			}),
		}),
	);

	mock.module("renderer/stores/workspace-creates", () => ({
		...realWorkspaceCreates,
		useWorkspaceCreates: () => ({
			submit: (payload: unknown) => {
				order.push("workspaces.create");
				workspaceCreateCalls.push(payload);
				return { completed: Promise.resolve({ ok: false }) };
			},
		}),
	}));

	mock.module("renderer/stores/new-workspace-prompt-context", () => ({
		...realPromptContext,
		useNewWorkspacePromptContext: () => ({
			build: async ({ userPrompt }: { userPrompt: string }) => {
				if (promptBuildError) throw promptBuildError;
				return userPrompt;
			},
			register: () => {},
		}),
	}));

	mock.module("renderer/stores/new-workspace-modal", () => ({
		...realNewWorkspaceModal,
		// The window-level Cmd/Ctrl+Enter listener only arms while the modal is
		// open, and one of the submit tests fires exactly that.
		useNewWorkspaceModalOpen: () => true,
	}));

	mock.module("renderer/hooks/useV2AgentChoices", () => ({
		useV2AgentChoices: () => ({
			agents: [
				{ id: AGENT_ID, label: "Claude", iconId: "claude", kind: "terminal" },
			],
			isFetched: true,
		}),
	}));

	mock.module("renderer/lib/host-service-unavailable", () => ({
		...realHostServiceUnavailable,
		showHostServiceUnavailableToast: () => {},
	}));

	// Uploads: submit awaits these before anything else happens.
	mock.module("./hooks/useUploadAttachments", () => ({
		useUploadAttachments: () => ({
			awaitUploads: async () => ({ readyIds: uploadIds, errors: uploadErrors }),
		}),
		useFileIdsForHost: () => [],
		useUploadStateFor: () => undefined,
	}));

	mock.module("./hooks/useBranchPickerController", () => ({
		useBranchPickerController: () => ({ pickerProps: {} }),
	}));

	mock.module(
		"../components/DevicePicker/hooks/useWorkspaceHostOptions",
		() => ({
			useWorkspaceHostOptions: () => ({
				currentDeviceName: "This device",
				localHostId: MACHINE_ID,
				otherHosts: [],
			}),
		}),
	);

	// ── Child components ────────────────────────────────────────────
	// Command wrappers pass their children straight through, so the assertions
	// below hit the REAL trigger buttons PromptGroup renders.
	const passthrough = ({ children }: { children?: unknown }) => children;
	mock.module("renderer/components/IssueLinkCommand", () => ({
		IssueLinkCommand: passthrough,
	}));
	mock.module("./components/GitHubIssueLinkCommand", () => ({
		GitHubIssueLinkCommand: passthrough,
	}));
	mock.module("./components/PRLinkCommand", () => ({
		PRLinkCommand: passthrough,
	}));
	mock.module("./components/PromptHistoryCommand", () => ({
		PromptHistoryCommand: passthrough,
	}));
	mock.module("./components/CompareBaseBranchPicker", () => ({
		CompareBaseBranchPicker: () => (
			<div data-testid="compare-base-branch-picker" />
		),
	}));
	mock.module("../components/DevicePicker", () => ({
		DevicePicker: () => <div data-testid="device-picker" />,
	}));
	mock.module("./components/ProjectPickerPill", () => ({
		ProjectPickerPill: () => <div data-testid="project-picker-pill" />,
	}));
	mock.module("renderer/components/AgentSelect", () => ({
		AgentSelect: () => <div data-testid="agent-select" />,
	}));
	mock.module("renderer/components/AgentModelSelect", () => ({
		AgentModelSelect: () => <div data-testid="agent-model-select" />,
	}));
	mock.module("renderer/components/MarkdownEditor", () => ({
		MarkdownEditor: ({ content }: { content: string }) => (
			<div data-testid="prompt-editor">{content}</div>
		),
	}));
}

installMocks();

// Deliberately NOT `screen`: it binds to whatever `document.body` existed when
// @testing-library/dom was first imported, and happy-dom's globals are
// process-wide — an earlier renderer suite that registered and unregistered
// leaves `screen` pointing at a dead document, so every query finds an empty
// body. The queries returned by `render()` are bound to the live one.
const { act, cleanup, fireEvent, render } = await import(
	"@testing-library/react"
);
type RenderedForm = ReturnType<typeof renderForm>;
const { PromptInputProvider, createPromptInputAttachmentsStore } = await import(
	"@superset/ui/ai-elements/prompt-input"
);
const { useNewWorkspaceDraftStore } = await import(
	"renderer/stores/new-workspace-draft"
);
const { usePromptHistoryStore } = await import(
	"renderer/stores/prompt-history"
);
const { DashboardNewWorkspaceDraftProvider } = await import(
	"../../../DashboardNewWorkspaceDraftContext"
);
const { AGENT_STORAGE_KEY } = await import("./types");
const { PromptGroup } = await import("./PromptGroup");

const PROJECT_OPTION = {
	id: PROJECT_ID,
	name: "Acme",
	githubOwner: null,
	githubRepoName: null,
	iconUrl: null,
	needsSetup: false,
};

function renderForm() {
	return render(
		<DashboardNewWorkspaceDraftProvider onClose={() => {}}>
			<PromptInputProvider
				attachmentsStore={createPromptInputAttachmentsStore()}
			>
				<PromptGroup
					projectId={PROJECT_ID}
					selectedProject={PROJECT_OPTION}
					recentProjects={[PROJECT_OPTION]}
					onSelectProject={() => {}}
				/>
			</PromptInputProvider>
		</DashboardNewWorkspaceDraftProvider>,
	);
}

function submitButton(view: RenderedForm): HTMLButtonElement {
	const button = view.baseElement.querySelector('button[type="submit"]');
	if (!button) throw new Error("submit button not found");
	return button as HTMLButtonElement;
}

/** Clicks the form's submit button and drains the submit's microtasks. */
async function submit(view: RenderedForm): Promise<void> {
	const button = submitButton(view);
	await act(async () => {
		fireEvent.click(button);
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
	});
}

beforeEach(() => {
	installMocks();
	resetState();
	localStorage.setItem(AGENT_STORAGE_KEY, AGENT_ID);
	useNewWorkspaceDraftStore.setState({
		selectedProjectId: PROJECT_ID,
		isSession: false,
		hostId: MACHINE_ID,
		prompt: "",
		baseBranch: null,
		baseBranchSource: null,
		workspaceName: "",
		workspaceNameEdited: false,
		branchName: "",
		branchNameEdited: false,
		branchNameFromProvider: false,
		linkedIssues: [],
		linkedPR: null,
		selectedAgentId: null,
		attachments: [],
		resetDraft: () => {
			order.push("reset");
		},
	});
	usePromptHistoryStore.setState({
		recordPrompt: (prompt: string) => {
			order.push(`recordPrompt:${prompt}`);
		},
	});
});

afterEach(() => {
	cleanup();
});

afterAll(async () => {
	if (!alreadyRegistered) await GlobalRegistrator.unregister();
});

describe("PromptGroup master mode rendering", () => {
	test("hides everything branch-shaped and says where the agent runs", () => {
		const view = renderForm();
		expect(view.getByTestId("master-runs-in").textContent).toBe("Runs in acme");
		expect(view.queryByPlaceholderText("Workspace name (optional)")).toBeNull();
		expect(view.queryByPlaceholderText("branch name")).toBeNull();
		expect(view.queryByLabelText("Update naming instructions")).toBeNull();
		expect(view.queryByLabelText("Link pull request")).toBeNull();
		expect(view.queryByTestId("compare-base-branch-picker")).toBeNull();
	});

	test("keeps the prompt, the agent pickers and the context controls", () => {
		const view = renderForm();
		expect(view.getByTestId("prompt-editor")).toBeTruthy();
		expect(view.getByTestId("agent-select")).toBeTruthy();
		expect(view.getByTestId("device-picker")).toBeTruthy();
		expect(view.getByTestId("project-picker-pill")).toBeTruthy();
		expect(view.getByLabelText("Add attachment")).toBeTruthy();
		expect(view.getByLabelText("Link GitHub issue")).toBeTruthy();
		expect(view.getByLabelText("Link issue")).toBeTruthy();
	});

	test("branch mode is untouched: every branch control is still there", () => {
		isGitRepo = true;
		const view = renderForm();
		expect(view.queryByTestId("master-runs-in")).toBeNull();
		expect(view.getByPlaceholderText("Workspace name (optional)")).toBeTruthy();
		expect(view.getByPlaceholderText("branch name")).toBeTruthy();
		expect(view.getByLabelText("Update naming instructions")).toBeTruthy();
		expect(view.getByLabelText("Link pull request")).toBeTruthy();
		expect(view.getByTestId("compare-base-branch-picker")).toBeTruthy();
	});
});

describe("PromptGroup submit gating", () => {
	test("a pending probe blocks submit with 'Checking project…'", async () => {
		gitProbeSucceeded = false;
		const view = renderForm();
		await submit(view);
		expect(toastErrors).toEqual(["Checking project…"]);
		expect(agentsRunCalls).toEqual([]);
		expect(workspaceCreateCalls).toEqual([]);
	});

	test("a FAILED probe falls back to the branch flow instead of spinning", async () => {
		// Rung 7: an errored probe is not a pending one. Blocking on
		// "Checking project…" forever would strand the modal on a host whose
		// git.isRepo call keeps failing.
		gitProbeSucceeded = false;
		gitProbeErrored = true;
		const view = renderForm();
		expect(view.queryByTestId("master-runs-in")).toBeNull();
		expect(view.getByPlaceholderText("branch name")).toBeTruthy();
		await submit(view);
		expect(toastErrors).toEqual([]);
		expect(workspaceCreateCalls).toHaveLength(1);
		expect(agentsRunCalls).toEqual([]);
	});

	test("a folder missing from disk blocks submit with the reason", async () => {
		hostWorkspaceRows[0].worktreeExists = false;
		const view = renderForm();
		await submit(view);
		expect(toastErrors).toEqual(["Project folder is missing on disk"]);
		expect(agentsRunCalls).toEqual([]);
	});
});

describe("PromptGroup master submit", () => {
	test("an empty prompt still launches the picked agent, with prompt ''", async () => {
		const view = renderForm();
		await submit(view);
		expect(agentsRunCalls).toHaveLength(1);
		expect(agentsRunCalls[0]).toEqual({
			url: HOST_URL,
			input: {
				workspaceId: MASTER_WORKSPACE_ID,
				agent: AGENT_ID,
				prompt: "",
				attachmentIds: undefined,
				model: undefined,
				effort: undefined,
			},
		});
		expect(workspaceCreateCalls).toEqual([]);
	});

	test("restores the master to Active before launching", async () => {
		// `restoreWorkspace` is called unconditionally, and that is what makes a
		// Recycle-Binned master safe: it still resolves to master mode (the bin
		// is renderer-side display state; the host row is untouched) and
		// `ensure` deliberately refuses to resurrect a "deleted" row, so without
		// the restore the agent started in a workspace that stayed in the bin.
		const view = renderForm();
		await submit(view);
		expect(sidebarCalls).toEqual([
			`restore:${MASTER_WORKSPACE_ID}`,
			`ensure:${MASTER_WORKSPACE_ID}:${PROJECT_ID}`,
		]);
	});

	test("a failed prompt build leaves the master where it was", async () => {
		// The restore/ensure pair runs AFTER everything that can throw, so a
		// build failure is a clean no-op: the error toast used to appear over a
		// master that had already been pulled out of the bin and into Active.
		promptBuildError = new Error("prompt build blew up");
		useNewWorkspaceDraftStore.setState({ prompt: "do the thing" });
		const view = renderForm();
		await submit(view);
		expect(toastErrors).toEqual(["prompt build blew up"]);
		expect(sidebarCalls).toEqual([]);
		expect(agentsRunCalls).toEqual([]);
		expect(order).toEqual([]);
	});

	test("'No agent' with an empty prompt navigates without launching anything", async () => {
		localStorage.setItem(AGENT_STORAGE_KEY, "none");
		const view = renderForm();
		await submit(view);
		expect(agentsRunCalls).toEqual([]);
		expect(order).toContain("navigate");
		expect(sidebarCalls).toHaveLength(2);
	});

	test("'No agent' with a typed prompt is refused instead of dropping it", async () => {
		// Master mode has nowhere to put a prompt without an agent — no
		// workspace is created, so there is not even a `namingPrompt` to keep it
		// in. Dropping it silently looked like a successful submit.
		localStorage.setItem(AGENT_STORAGE_KEY, "none");
		useNewWorkspaceDraftStore.setState({ prompt: "do the thing" });
		const view = renderForm();
		await submit(view);
		expect(toastErrors).toEqual(["Pick an agent to run in acme"]);
		expect(sidebarCalls).toEqual([]);
		expect(agentsRunCalls).toEqual([]);
		expect(order).toEqual([]);
	});

	test("'No agent' with attachments is refused too", async () => {
		localStorage.setItem(AGENT_STORAGE_KEY, "none");
		uploadIds = ["a0000000-0000-4000-8000-000000000001"];
		const view = renderForm();
		await submit(view);
		expect(toastErrors).toEqual(["Pick an agent to run in acme"]);
		expect(sidebarCalls).toEqual([]);
		expect(agentsRunCalls).toEqual([]);
	});

	test("branch mode still keeps a prompt with no agent, as the naming prompt", async () => {
		// The refusal above is master-mode-only: the branch flow has somewhere
		// for that text to live, and must not start rejecting it.
		isGitRepo = true;
		localStorage.setItem(AGENT_STORAGE_KEY, "none");
		useNewWorkspaceDraftStore.setState({ prompt: "do the thing" });
		const view = renderForm();
		await submit(view);
		expect(toastErrors).toEqual([]);
		expect(workspaceCreateCalls).toHaveLength(1);
		expect(
			(
				workspaceCreateCalls[0] as {
					snapshot: { namingPrompt?: string; agents?: unknown };
				}
			).snapshot.namingPrompt,
		).toBe("do the thing");
	});

	test("records the prompt before the reset and closes before navigating", async () => {
		useNewWorkspaceDraftStore.setState({ prompt: "do the thing" });
		const view = renderForm();
		await submit(view);
		expect(order).toEqual([
			"recordPrompt:do the thing",
			"reset",
			"navigate",
			"agents.run",
		]);
	});

	test("a linked PR is refused before anything mutates", async () => {
		useNewWorkspaceDraftStore.setState({
			linkedPR: {
				prNumber: 7,
				title: "Fix it",
				url: "https://example.test/pr/7",
				state: "open",
			},
		});
		const view = renderForm();
		await submit(view);
		expect(toastErrors).toEqual([
			"Checking out a PR requires a branch workspace",
		]);
		expect(sidebarCalls).toEqual([]);
		expect(agentsRunCalls).toEqual([]);
		expect(order).toEqual([]);
	});

	test("an upload failure stops the submit before the master path", async () => {
		uploadErrors = [{ filename: "a.png", message: "boom" }];
		const view = renderForm();
		await submit(view);
		expect(toastErrors).toEqual(["Attachment upload failed (a.png): boom"]);
		expect(sidebarCalls).toEqual([]);
		expect(agentsRunCalls).toEqual([]);
		expect(order).toEqual([]);
	});

	test("two rapid submits launch exactly one agent", async () => {
		const view = renderForm();
		const button = submitButton(view);
		await act(async () => {
			fireEvent.click(button);
			fireEvent.click(button);
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});
		expect(agentsRunCalls).toHaveLength(1);
	});

	test("uploaded attachments ride along on the launch", async () => {
		uploadIds = ["a0000000-0000-4000-8000-000000000001"];
		const view = renderForm();
		await submit(view);
		expect(agentsRunCalls).toHaveLength(1);
		expect(
			(agentsRunCalls[0] as { input: { attachmentIds?: string[] } }).input
				.attachmentIds,
		).toEqual(["a0000000-0000-4000-8000-000000000001"]);
	});

	test("the Cmd/Ctrl+Enter window listener launches exactly one agent", async () => {
		// The listener is on `window`, not on the form, so nothing here is queried.
		renderForm();
		await act(async () => {
			fireEvent.keyDown(window, { key: "Enter", metaKey: true });
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});
		expect(agentsRunCalls).toHaveLength(1);
		expect(workspaceCreateCalls).toEqual([]);
	});

	test("a remote host keeps the branch flow, master or not", async () => {
		useNewWorkspaceDraftStore.setState({ hostId: "host-2" });
		const view = renderForm();
		expect(view.queryByTestId("master-runs-in")).toBeNull();
		expect(view.getByPlaceholderText("branch name")).toBeTruthy();
	});

	test("a rejected agents.run toasts, after the navigation has happened", async () => {
		agentsRunImpl = async () => {
			throw new Error("agent refused");
		};
		const view = renderForm();
		await submit(view);
		expect(order).toEqual(["reset", "navigate", "agents.run"]);
		expect(toastErrors).toEqual(["agent refused"]);
	});
});
