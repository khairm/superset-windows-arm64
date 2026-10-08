import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const alreadyRegistered = GlobalRegistrator.isRegistered;
if (!alreadyRegistered) GlobalRegistrator.register();
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const calls = {
	getDiffPatch: [] as unknown[][],
	getDiff: [] as unknown[][],
	getBaseBranch: [] as unknown[][],
	listCommits: [] as unknown[][],
};
let onGitChanged: ((payload?: { paths?: string[] }) => void) | undefined;

const invalidate =
	(key: keyof typeof calls) =>
	(...args: unknown[]) => {
		calls[key].push(args);
		return Promise.resolve();
	};

mock.module("@superset/workspace-client", () => ({
	workspaceTrpc: {
		useUtils: () => ({
			git: {
				getDiffPatch: { invalidate: invalidate("getDiffPatch") },
				getDiff: { invalidate: invalidate("getDiff") },
				getBaseBranch: { invalidate: invalidate("getBaseBranch") },
				listCommits: { invalidate: invalidate("listCommits") },
			},
		}),
		git: {
			getBaseBranch: { useQuery: () => ({ data: { baseBranch: "main" } }) },
			getStatus: {
				useQuery: () => ({ data: undefined, refetch: () => Promise.resolve() }),
			},
		},
	},
}));

mock.module("../useWorkspaceEvent", () => ({
	useWorkspaceEvent: (
		_event: string,
		_workspaceId: string,
		callback: (payload?: { paths?: string[] }) => void,
	) => {
		onGitChanged = callback;
	},
}));

const { act, cleanup, render } = await import("@testing-library/react");
const { useGitStatus } = await import("./useGitStatus");

function Probe() {
	useGitStatus("workspace-1");
	return null;
}

/** A `git.getDiffPatch` query as the Changes pane registers it: keyed on
 * what is diffed, with the paths its cached patch covers in its data. */
function patchQuery(
	category: "against-base" | "staged" | "unstaged" | "commit",
	requestedPaths: string[],
) {
	const input = { workspaceId: "workspace-1", category };
	return {
		queryKey: [["git", "getDiffPatch"], { input, type: "query" }],
		state: { data: { kind: "patch", patch: "", requestedPaths } },
	};
}

function lastPatchPredicate() {
	const [, filters] = calls.getDiffPatch.at(-1) ?? [];
	const predicate = (
		filters as { predicate?: (query: unknown) => boolean } | undefined
	)?.predicate;
	if (!predicate)
		throw new Error("getDiffPatch was invalidated without a predicate");
	return predicate;
}

beforeEach(() => {
	for (const entries of Object.values(calls)) entries.length = 0;
	onGitChanged = undefined;
});

afterAll(async () => {
	cleanup();
	if (!alreadyRegistered) await GlobalRegistrator.unregister();
});

describe("useGitStatus git:changed invalidation", () => {
	test("invalidates commit lists and every patch after a broad git metadata change", async () => {
		render(<Probe />);
		await act(async () => onGitChanged?.({}));
		expect(calls.listCommits).toEqual([[{ workspaceId: "workspace-1" }]]);
		expect(calls.getDiffPatch).toEqual([[{ workspaceId: "workspace-1" }]]);
	});

	test("does not invalidate commit lists for path-scoped worktree edits", async () => {
		render(<Probe />);
		await act(async () => onGitChanged?.({ paths: ["src/file.ts"] }));
		expect(calls.listCommits).toEqual([]);
	});

	test("a worktree edit refetches the patch holding the file and not a sibling", async () => {
		render(<Probe />);
		await act(async () => onGitChanged?.({ paths: ["src/a.ts"] }));
		expect(calls.getDiffPatch).toHaveLength(1);
		expect(calls.getDiffPatch[0]?.[0]).toEqual({ workspaceId: "workspace-1" });
		const affected = lastPatchPredicate();
		expect(affected(patchQuery("against-base", ["src/a.ts", "src/b.ts"]))).toBe(
			true,
		);
		expect(affected(patchQuery("against-base", ["src/b.ts"]))).toBe(false);
		expect(affected(patchQuery("staged", ["src/b.ts"]))).toBe(false);
	});

	test("a worktree edit always refetches the unstaged patch, which the file may be joining", async () => {
		render(<Probe />);
		await act(async () => onGitChanged?.({ paths: ["src/new.ts"] }));
		expect(lastPatchPredicate()(patchQuery("unstaged", ["src/a.ts"]))).toBe(
			true,
		);
	});
});
