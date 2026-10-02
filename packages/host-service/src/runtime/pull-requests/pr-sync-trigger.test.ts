import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { GitWatcher } from "../../events/git-watcher";
import { createPrSyncTrigger } from "./pr-sync-trigger";

const BROAD_MS = 5_000;
const FILE_ONLY_MS = 30_000;
const FILE = { workspaceId: "w", paths: ["src/a.ts"] };
const BROAD = { workspaceId: "w" };

function createRecordedTrigger() {
	const trigger = createPrSyncTrigger({
		broadIntervalMs: BROAD_MS,
		fileOnlyIntervalMs: FILE_ONLY_MS,
	});
	const t0 = Date.now();
	const fires: number[] = [];
	trigger.onChanged(() => fires.push(Date.now() - t0));
	return { trigger, fires };
}

describe("(GIT-LAUNCH-BUDGET-B) PR-sync trigger", () => {
	beforeEach(() => {
		jest.useFakeTimers();
	});
	afterEach(() => {
		jest.useRealTimers();
	});

	test("after a fire, file-only events for 29 s emit nothing, then one sync at 30 s", () => {
		const { trigger, fires } = createRecordedTrigger();
		trigger.push(FILE);
		expect(fires).toEqual([0]);
		for (let i = 1; i <= 50; i++) {
			jest.advanceTimersByTime(580);
			trigger.push(FILE);
		}
		jest.advanceTimersByTime(FILE_ONLY_MS - 1 - 50 * 580);
		expect(fires).toEqual([0]);
		jest.advanceTimersByTime(1);
		expect(fires).toEqual([0, FILE_ONLY_MS]);
		expect(jest.getTimerCount()).toBe(0);
	});

	test("a broad event after 5 s quiet fires at once; a broad burst fires at most once per 5 s", () => {
		const { trigger, fires } = createRecordedTrigger();
		trigger.push(BROAD);
		jest.advanceTimersByTime(BROAD_MS);
		trigger.push(BROAD);
		expect(fires).toEqual([0, BROAD_MS]);
		for (let i = 0; i < 100; i++) {
			jest.advanceTimersByTime(100);
			trigger.push(BROAD);
		}
		jest.advanceTimersByTime(BROAD_MS);
		expect(fires).toEqual([0, 1, 2, 3, 4].map((n) => n * BROAD_MS));
		expect(jest.getTimerCount()).toBe(0);
	});

	test("a broad event pulls a pending file-only sync earlier; a file-only event never pushes a broad one later", () => {
		const { trigger, fires } = createRecordedTrigger();
		trigger.push(FILE);
		jest.advanceTimersByTime(1_000);
		trigger.push(FILE);
		jest.advanceTimersByTime(1_000);
		trigger.push(BROAD);
		jest.advanceTimersByTime(BROAD_MS - 2_000 - 1);
		expect(fires).toEqual([0]);
		jest.advanceTimersByTime(1);
		expect(fires).toEqual([0, BROAD_MS]);
		jest.advanceTimersByTime(1_000);
		trigger.push(BROAD);
		trigger.push(FILE);
		jest.advanceTimersByTime(BROAD_MS);
		expect(fires).toEqual([0, BROAD_MS, BROAD_MS * 2]);
		jest.advanceTimersByTime(FILE_ONLY_MS * 2);
		expect(fires).toEqual([0, BROAD_MS, BROAD_MS * 2]);
	});

	test("cancelWorkspace drops the pending sync, and the next event starts fresh", () => {
		const { trigger, fires } = createRecordedTrigger();
		trigger.push(FILE);
		jest.advanceTimersByTime(1_000);
		trigger.push(FILE);
		jest.advanceTimersByTime(9_000);
		trigger.cancelWorkspace("w");
		expect(jest.getTimerCount()).toBe(0);
		jest.advanceTimersByTime(FILE_ONLY_MS);
		expect(fires).toEqual([0]);
		trigger.push(FILE);
		expect(fires).toEqual([0, 10_000 + FILE_ONLY_MS]);
	});

	test("workspaces are rate-limited independently", () => {
		const { trigger, fires } = createRecordedTrigger();
		trigger.push(FILE);
		trigger.push({ workspaceId: "other", paths: ["b.ts"] });
		expect(fires).toEqual([0, 0]);
	});

	test("dispose clears every timer; push and cancelWorkspace afterwards are silent no-ops", () => {
		const { trigger, fires } = createRecordedTrigger();
		trigger.push(FILE);
		trigger.push(FILE);
		expect(jest.getTimerCount()).toBe(1);
		trigger.dispose();
		expect(jest.getTimerCount()).toBe(0);
		trigger.push(BROAD);
		trigger.cancelWorkspace("w");
		jest.advanceTimersByTime(FILE_ONLY_MS * 2);
		expect(fires).toEqual([0]);
		expect(jest.getTimerCount()).toBe(0);
	});
});

interface GitWatcherInternals {
	watched: Map<string, unknown>;
}

describe("(GIT-LAUNCH-BUDGET-B) unwatch cancels a pending PR sync", () => {
	beforeEach(() => {
		jest.useFakeTimers();
	});
	afterEach(() => {
		jest.useRealTimers();
	});

	test("a workspace whose .git watcher is null still cancels on unwatch", () => {
		const { trigger, fires } = createRecordedTrigger();
		const watcher = new GitWatcher(
			{} as unknown as ConstructorParameters<typeof GitWatcher>[0],
			{} as unknown as ConstructorParameters<typeof GitWatcher>[1],
			(workspaceId, watched) => {
				if (!watched) trigger.cancelWorkspace(workspaceId);
			},
		);
		const internals = watcher as unknown as GitWatcherInternals;
		let worktreeWatchDisposed = false;
		internals.watched.set("w", {
			workspaceId: "w",
			worktreePath: "/nowhere",
			gitDir: null,
			watcher: null,
			disposeWorktreeWatch: () => {
				worktreeWatchDisposed = true;
			},
		});
		try {
			watcher.watchWorkspace("w");
			trigger.push(FILE);
			trigger.push(FILE);
			expect(jest.getTimerCount()).toBe(1);

			watcher.unwatchWorkspace("w");

			expect(internals.watched.has("w")).toBe(false);
			expect(worktreeWatchDisposed).toBe(true);
			expect(jest.getTimerCount()).toBe(0);
			jest.advanceTimersByTime(FILE_ONLY_MS * 2);
			expect(fires).toEqual([0]);
		} finally {
			watcher.close();
			trigger.dispose();
		}
	});
});
