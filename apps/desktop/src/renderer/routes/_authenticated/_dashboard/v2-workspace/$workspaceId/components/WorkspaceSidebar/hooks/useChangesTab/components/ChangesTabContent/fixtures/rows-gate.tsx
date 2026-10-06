import { afterAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://localhost" });
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

mock.module("../../ChangesToolbar", () => ({ ChangesToolbar: () => null }));
mock.module("../../ChangesFileList", () => ({
	ChangesFileList: ({
		files,
		rowsReady,
	}: {
		files: unknown[];
		rowsReady: boolean;
	}) => (
		<div
			data-testid="list"
			data-rows-ready={String(rowsReady)}
			data-count={files.length}
		/>
	),
}));

const { act, cleanup, render } = await import("@testing-library/react/pure");
const { ChangesTabContent } = await import("../ChangesTabContent");

afterAll(() => {
	cleanup();
	GlobalRegistrator.unregister();
});

const noop = () => {};
const files = Array.from({ length: 40 }, (_, i) => ({
	path: `src/file-${i}.ts`,
	status: "modified" as const,
	additions: 1,
	deletions: 0,
	source: { kind: "unstaged" as const },
}));
const statusData = {
	staged: [],
	unstaged: [],
	defaultBranch: { name: "main" },
	currentBranch: { name: "feature" },
};

type Props = Parameters<typeof ChangesTabContent>[0];

function props(overrides: Partial<Props> = {}): Props {
	return {
		workspaceId: "ws-a",
		status: {
			data: statusData as unknown as Props["status"]["data"],
			isFetching: false,
			isLoading: false,
		},
		commits: { data: undefined },
		branches: { data: undefined },
		filter: { kind: "all" },
		viewMode: "folders",
		baseBranch: null,
		files: files as Props["files"],
		isLoading: false,
		onFilterChange: noop,
		onViewModeChange: noop,
		onBaseBranchChange: noop,
		onRenameBranch: noop,
		canRenameBranch: false,
		...overrides,
	};
}

function rowsReady(container: HTMLElement) {
	return (
		container
			.querySelector('[data-testid="list"]')
			?.getAttribute("data-rows-ready") ?? null
	);
}

test("a cached re-open of a large list holds its rows until after the first frame", async () => {
	const frames: FrameRequestCallback[] = [];
	const realFrame = globalThis.requestAnimationFrame;
	globalThis.requestAnimationFrame = (callback) => frames.push(callback);
	try {
		const { container, unmount } = render(<ChangesTabContent {...props()} />);
		expect(rowsReady(container)).toBe("false");
		await act(async () => {
			for (const frame of frames.splice(0)) frame(0);
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(rowsReady(container)).toBe("true");
		unmount();
	} finally {
		globalThis.requestAnimationFrame = realFrame;
	}
});

test("a cold open shows its rows as soon as the data arrives", () => {
	const { container, rerender, unmount } = render(
		<ChangesTabContent
			{...props({
				status: { data: undefined, isFetching: true, isLoading: true },
				files: [],
			})}
		/>,
	);
	expect(rowsReady(container)).toBeNull();
	rerender(<ChangesTabContent {...props()} />);
	expect(rowsReady(container)).toBe("true");
	unmount();
});

test("tree view and small lists are never held back", () => {
	for (const overrides of [
		{ viewMode: "tree" as const },
		{ files: files.slice(0, 30) as Props["files"] },
	]) {
		const { container, unmount } = render(
			<ChangesTabContent {...props(overrides)} />,
		);
		expect(rowsReady(container)).toBe("true");
		unmount();
	}
});
