import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { renderToStaticMarkup } from "react-dom/server";
import type { PaneViewerData } from "../../types";

const alreadyRegistered = GlobalRegistrator.isRegistered;
if (!alreadyRegistered) GlobalRegistrator.register();
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

mock.module("renderer/lib/fileIcons", () => ({ FileIcon: () => null }));

const realWorkspaceClient = await import("@superset/workspace-client");
const realWorkspaceProvider = await import(
	"renderer/routes/_authenticated/_dashboard/v2-workspace/providers/WorkspaceProvider"
);
const realCollectionsProvider = await import(
	"renderer/routes/_authenticated/providers/CollectionsProvider"
);
const realHostUrl = await import(
	"renderer/hooks/host-service/useWorkspaceHostUrl"
);
const realHotkeys = await import("renderer/hotkeys");
const realAgentSessionLauncher = await import("../useAgentSessionLauncher");

mock.module("@superset/workspace-client", () => ({
	...realWorkspaceClient,
	workspaceTrpc: {
		terminal: {
			killSession: {
				useMutation: () => ({ mutate: mock(() => {}), isPending: false }),
			},
		},
		useUtils: () => ({
			terminal: { list: { invalidate: mock(() => Promise.resolve()) } },
		}),
	},
}));
mock.module(
	"renderer/routes/_authenticated/_dashboard/v2-workspace/providers/WorkspaceProvider",
	() => ({
		...realWorkspaceProvider,
		useWorkspace: () => ({ workspace: { id: "saved-workspace" } }),
	}),
);
mock.module(
	"renderer/routes/_authenticated/providers/CollectionsProvider",
	() => ({
		...realCollectionsProvider,
		useCollections: () => ({
			v2WorkspaceLocalState: { get: () => null, update: mock(() => {}) },
		}),
	}),
);
mock.module("renderer/hooks/host-service/useWorkspaceHostUrl", () => ({
	...realHostUrl,
	useWorkspaceHostTarget: () => ({ status: "ready", kind: "local" }),
}));
mock.module("renderer/hotkeys", () => ({
	...realHotkeys,
	useHotkeyDisplay: () => ({ text: "Ctrl+K" }),
}));
mock.module("../useAgentSessionLauncher", () => ({
	...realAgentSessionLauncher,
	useAgentSessionLauncher: () => ({
		createNewAgentSession: mock(() => {}),
		focusAgentTerminal: mock(() => {}),
	}),
}));

const { cleanup, renderHook } = await import("@testing-library/react");
const { createWorkspaceStore } = await import("@superset/panes");
const { usePaneRegistry } = await import("./usePaneRegistry");

afterEach(cleanup);
afterAll(async () => {
	if (!alreadyRegistered) await GlobalRegistrator.unregister();
});

describe("saved disabled panes (FORK-BROWSER-OFF) (FORK-CHAT-V3-OFF)", () => {
	for (const [kind, title] of [
		["browser", "Browser"],
		["chat-v3", "Chat"],
	] as const) {
		test(`${kind} is inert and closes from the actual workspace registry`, () => {
			const store = createWorkspaceStore<PaneViewerData>();
			store
				.getState()
				.addTab({ panes: [{ kind, data: {} as PaneViewerData }] });
			const { result } = renderHook(() =>
				usePaneRegistry({
					store,
					launcher: {} as never,
					onOpenDiff: mock(() => {}),
					onOpenComment: mock(() => {}),
					onOpenFile: mock(() => {}),
					onRevealPath: mock(() => {}),
				}),
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
