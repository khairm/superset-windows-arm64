import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PaneViewerData } from "../../types";

const alreadyRegistered = GlobalRegistrator.isRegistered;
if (!alreadyRegistered) GlobalRegistrator.register();
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const realWorkspaceProvider = await import(
	"renderer/routes/_authenticated/_dashboard/v2-workspace/providers/WorkspaceProvider"
);
const realCollectionsProvider = await import(
	"renderer/routes/_authenticated/providers/CollectionsProvider"
);
const realHostUrl = await import(
	"renderer/hooks/host-service/useWorkspaceHostUrl"
);
const realAgentSessionLauncher = await import("../useAgentSessionLauncher");

// Later files inherit these mocks; after this file they get the real code.
let faking = true;
afterAll(() => {
	faking = false;
});
function whileFaking<Args extends unknown[]>(
	fake: () => unknown,
	real: (...args: Args) => unknown,
): (...args: Args) => unknown {
	return (...args) => (faking ? fake() : real(...args));
}

mock.module(
	"renderer/routes/_authenticated/_dashboard/v2-workspace/providers/WorkspaceProvider",
	() => ({
		...realWorkspaceProvider,
		useWorkspace: whileFaking(
			() => ({ workspace: { id: "saved-workspace" } }),
			realWorkspaceProvider.useWorkspace,
		),
	}),
);
mock.module(
	"renderer/routes/_authenticated/providers/CollectionsProvider",
	() => ({
		...realCollectionsProvider,
		useCollections: whileFaking(
			() => ({
				v2WorkspaceLocalState: { get: () => null, update: mock(() => {}) },
			}),
			realCollectionsProvider.useCollections,
		),
	}),
);
mock.module("renderer/hooks/host-service/useWorkspaceHostUrl", () => ({
	...realHostUrl,
	useWorkspaceHostTarget: whileFaking(
		() => ({ status: "ready", kind: "local" }),
		realHostUrl.useWorkspaceHostTarget,
	),
}));
mock.module("../useAgentSessionLauncher", () => ({
	...realAgentSessionLauncher,
	useAgentSessionLauncher: whileFaking(
		() => ({
			createNewAgentSession: mock(() => {}),
			focusAgentTerminal: mock(() => {}),
		}),
		realAgentSessionLauncher.useAgentSessionLauncher,
	),
}));

const { cleanup, renderHook } = await import("@testing-library/react");
const { createWorkspaceStore } = await import("@superset/panes");
const { WorkspaceClientProvider } = await import("@superset/workspace-client");
const { usePaneRegistry } = await import("./usePaneRegistry");

function withWorkspaceClient({ children }: { children: ReactNode }) {
	return (
		<WorkspaceClientProvider
			cacheKey="usePaneRegistry-test"
			hostUrl="http://127.0.0.1:1"
		>
			{children}
		</WorkspaceClientProvider>
	);
}

afterEach(cleanup);
afterAll(async () => {
	if (!alreadyRegistered) await GlobalRegistrator.unregister();
});

describe("saved disabled panes (FORK-BROWSER-OFF) (FORK-CHAT-V3-OFF) (FORK-PRS-OFF)", () => {
	for (const [kind, title] of [
		["browser", "Browser"],
		["chat-v3", "Chat"],
		["review", "Review"],
		["pull-request", "Pull request"],
	] as const) {
		test(`${kind} is inert and closes from the actual workspace registry`, () => {
			const store = createWorkspaceStore<PaneViewerData>();
			store
				.getState()
				.addTab({ panes: [{ kind, data: {} as PaneViewerData }] });
			const { result } = renderHook(
				() =>
					usePaneRegistry({
						store,
						launcher: {} as never,
						onOpenDiff: mock(() => {}),
						onOpenFile: mock(() => {}),
						onRevealPath: mock(() => {}),
					}),
				{ wrapper: withWorkspaceClient },
			);
			const pane = store.getState().getActivePane();
			if (!pane) throw new Error(`no active ${kind} pane`);
			expect(pane.pane.kind).toBe(kind);
			const definition = result.current[kind];
			expect(definition).toBeDefined();
			expect(definition.getTitle?.(pane.pane)).toBe(title);
			expect(renderToStaticMarkup(definition.renderPane({} as never))).toBe("");
			expect(definition.onBeforeClose).toBeUndefined();
			store.getState().closePane({ tabId: pane.tabId, paneId: pane.pane.id });
			expect(store.getState().getPane(pane.pane.id)).toBeNull();
		});
	}
});
