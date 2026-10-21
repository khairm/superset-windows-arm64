import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { createWorkspaceStore, type WorkspaceState } from "@superset/panes";
import {
	FORK_BROWSER_PANES_DISABLED,
	FORK_PULL_REQUESTS_DISABLED,
} from "@superset/shared/fork-disabled-features";
import type { PaneViewerData } from "../../../../types";

const openUrl = mock(async (_url: string) => {});

// mock.module is process-wide with no unmock: later files get the real client.
const realTrpcClient = await import("renderer/lib/trpc-client");
let faking = true;
afterAll(() => {
	faking = false;
});
mock.module("renderer/lib/trpc-client", () => ({
	...realTrpcClient,
	electronTrpcClient: new Proxy(realTrpcClient.electronTrpcClient, {
		get: (target, key) =>
			faking && key === "external"
				? { openUrl: { mutate: openUrl } }
				: Reflect.get(target, key),
	}),
}));

const { runUrlLinkAction, terminalPullRequestLinkAction } = await import(
	"./runTerminalLinkAction"
);
const { pullRequestRefFromBareUrl, pullRequestRefFromUrl } = await import(
	"renderer/lib/github/pullRequestRef"
);

const PR_URL = "https://github.com/superset-sh/superset/pull/8412";
const ACTIONS = ["pane", "newTab", "rightPane"] as const;

function workspaceState(): WorkspaceState<PaneViewerData> {
	return {
		version: 1,
		activeTabId: "tab-1",
		tabs: [
			{
				id: "tab-1",
				createdAt: 1,
				activePaneId: "pane-1",
				layout: { type: "pane", paneId: "pane-1" },
				panes: {
					"pane-1": {
						id: "pane-1",
						kind: "diff",
						data: { path: "", collapsedFiles: [] } as PaneViewerData,
					},
				},
			},
		],
	};
}

function expectOpensInSystemBrowser(url: string) {
	const start = workspaceState();
	const expected = { tabs: start.tabs, activeTabId: start.activeTabId };
	for (const action of ACTIONS) {
		openUrl.mockClear();
		const store = createWorkspaceStore<PaneViewerData>({
			initialState: workspaceState(),
		});

		runUrlLinkAction({ store, rightPane: null }, url, action);

		expect(openUrl).toHaveBeenCalledTimes(1);
		expect(openUrl).toHaveBeenCalledWith(url);
		const { tabs, activeTabId } = store.getState();
		expect({ tabs, activeTabId }).toEqual(expected);
	}
}

beforeEach(() => {
	openUrl.mockClear();
});

describe.skipIf(!FORK_PULL_REQUESTS_DISABLED)(
	"(FORK-PRS-OFF-LINKS) PR links with pull requests off",
	() => {
		it("finds no pull-request pane target in a PR URL", () => {
			expect(pullRequestRefFromBareUrl(PR_URL)).toBeNull();
			expect(pullRequestRefFromUrl(PR_URL)).toEqual({
				repoFullName: "superset-sh/superset",
				number: 8412,
			});
		});

		it("leaves every terminal click on a PR URL to the URL link settings", () => {
			const click = { metaKey: false, ctrlKey: false, shiftKey: false };
			for (const event of [
				click,
				{ ...click, shiftKey: true },
				{ ...click, ctrlKey: true },
				{ ...click, metaKey: true },
			]) {
				expect(terminalPullRequestLinkAction(event, PR_URL)).toBeNull();
			}
		});

		it("opens a PR URL in the system browser for every action", () => {
			expectOpensInSystemBrowser(PR_URL);
		});
	},
);

describe.skipIf(!FORK_BROWSER_PANES_DISABLED)(
	"(FORK-BROWSER-OFF) other links with browser panes off",
	() => {
		it("opens other GitHub URLs in the system browser for every action", () => {
			for (const url of [
				`${PR_URL}#discussion_r123`,
				`${PR_URL}/files`,
				`${PR_URL}/commits/abc123`,
				"https://github.com/a/b?next=/pull/123",
				"https://github.com/superset-sh/superset/issues/1",
			]) {
				expectOpensInSystemBrowser(url);
			}
		});
	},
);
