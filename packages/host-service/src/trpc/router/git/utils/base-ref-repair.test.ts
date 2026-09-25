// (DIFFSTATS-COLD-CACHE)
import { expect, mock, test } from "bun:test";
import type { SimpleGit } from "simple-git";
import { resolveBaseRefFetchKey } from "./base-ref-freshness";
import { awaitBaseRefRepairs, scheduleBaseRefRepair } from "./base-ref-repair";
import { emptyGitStatusSnapshot } from "./git-status";
import { gitStatusStore } from "./git-status-store";

// (DIFFSTATS-COLD-CACHE) Answers the two reads a repair makes: the common dir
// that keys the fetch, and the remote-tracking sha either side of the fetch.
function fakeGit(commonDir: string, sha: () => string): SimpleGit {
	return {
		raw: mock(async (args: string[]) =>
			args[0] === "for-each-ref" ? `${sha()}\n` : `${commonDir}\n`,
		),
	} as never as SimpleGit;
}

let straddleSha = "straddle-before";
const git = fakeGit("/repo-straddle/.git", () => straddleSha);

const target = { remote: "origin", branch: "straddle-repair" };

function coldRead(args: {
	workspaceId: string;
	worktreePath: string;
	directoryId: string;
	onWalk: () => void;
}): Promise<unknown> {
	return gitStatusStore.read({
		workspaceId: args.workspaceId,
		baseBranch: null,
		coldCache: {
			worktreePath: args.worktreePath,
			directoryId: args.directoryId,
		},
		computeFull: async () => {
			args.onWalk();
			return emptyGitStatusSnapshot();
		},
		computePartial: async () => {
			throw new Error("cold reads must not compute partial status");
		},
	});
}

test("invalidates a walk that started before another worktree's fetch landed", async () => {
	let reads = 0;
	const read = () =>
		gitStatusStore.read({
			workspaceId: "straddle-b",
			baseBranch: null,
			coldCache: {
				worktreePath: "/repo-straddle/wt-b",
				directoryId: "straddle-directory",
			},
			computeFull: async () => {
				reads++;
				return emptyGitStatusSnapshot();
			},
			computePartial: async () => {
				throw new Error("cold reads must not compute partial status");
			},
		});

	const walkStartedAt = Date.now();
	await read();
	expect(reads).toBe(1);

	scheduleBaseRefRepair({
		git,
		worktreePath: "/repo-straddle/wt-a",
		workspaceId: "straddle-a",
		baseBranch: null,
		target,
		walkStartedAt: Date.now(),
		fetchBaseRef: async () => {
			straddleSha = "straddle-after";
		},
	});
	await awaitBaseRefRepairs();
	await read();
	expect(reads).toBe(1);

	scheduleBaseRefRepair({
		git,
		worktreePath: "/repo-straddle/wt-b",
		workspaceId: "straddle-b",
		baseBranch: null,
		target,
		walkStartedAt,
		fetchBaseRef: async () => {
			throw new Error("the live TTL must suppress a second fetch");
		},
	});
	await awaitBaseRefRepairs();
	await read();
	expect(reads).toBe(2);
});

let siblingSha = "sibling-before";
const siblingGit = fakeGit("/repo-sibling/.git", () => siblingSha);

const siblingTarget = { remote: "origin", branch: "sibling-repair" };
const unrelatedTarget = { remote: "origin", branch: "unrelated-repair" };

test("a landed fetch drops only the cold entries walked against that base ref", async () => {
	let siblingReads = 0;
	const sibling = () =>
		coldRead({
			workspaceId: "sibling-b",
			worktreePath: "/repo-sibling/wt-b",
			directoryId: "sibling-b-directory",
			onWalk: () => {
				siblingReads++;
			},
		});
	let unrelatedReads = 0;
	const unrelated = () =>
		coldRead({
			workspaceId: "unrelated-c",
			worktreePath: "/repo-unrelated/wt-c",
			directoryId: "unrelated-c-directory",
			onWalk: () => {
				unrelatedReads++;
			},
		});
	const tag = async (workspaceId: string, target: typeof siblingTarget) =>
		gitStatusStore.noteColdBaseRefFetch({
			workspaceId,
			baseBranch: null,
			fetchKey: await resolveBaseRefFetchKey(
				siblingGit,
				"/repo-sibling/wt-b",
				target,
			),
		});

	await sibling();
	await unrelated();
	await tag("sibling-b", siblingTarget);
	await tag("unrelated-c", unrelatedTarget);
	expect([siblingReads, unrelatedReads]).toEqual([1, 1]);

	scheduleBaseRefRepair({
		git: siblingGit,
		worktreePath: "/repo-sibling/wt-a",
		workspaceId: "sibling-a",
		baseBranch: null,
		target: siblingTarget,
		walkStartedAt: Date.now(),
		fetchBaseRef: async () => {
			siblingSha = "sibling-after";
		},
	});
	await awaitBaseRefRepairs();

	await sibling();
	await unrelated();
	expect([siblingReads, unrelatedReads]).toEqual([2, 1]);
});

// (DIFFSTATS-COLD-CACHE)
const idleGit = fakeGit("/repo-idle/.git", () => "idle-unmoved");
const idleTarget = { remote: "origin", branch: "idle-repair" };

test("a fetch that leaves the base ref unmoved keeps the cold entries", async () => {
	let reads = 0;
	const read = () =>
		coldRead({
			workspaceId: "idle-a",
			worktreePath: "/repo-idle/wt-a",
			directoryId: "idle-a-directory",
			onWalk: () => {
				reads++;
			},
		});

	await read();
	gitStatusStore.noteColdBaseRefFetch({
		workspaceId: "idle-a",
		baseBranch: null,
		fetchKey: await resolveBaseRefFetchKey(
			idleGit,
			"/repo-idle/wt-a",
			idleTarget,
		),
	});
	expect(reads).toBe(1);

	scheduleBaseRefRepair({
		git: idleGit,
		worktreePath: "/repo-idle/wt-a",
		workspaceId: "idle-a",
		baseBranch: null,
		target: idleTarget,
		walkStartedAt: Date.now(),
		fetchBaseRef: async () => {},
	});
	await awaitBaseRefRepairs();

	await read();
	expect(reads).toBe(1);
});

// (DIFFSTATS-COLD-CACHE)
const joinedGit = fakeGit("/repo-joined/.git", () => "joined-unmoved");
const joinedTarget = { remote: "origin", branch: "joined-repair" };

test("a repair that joins an in-flight fetch keeps entries when the ref is unmoved", async () => {
	let reads = 0;
	const read = () =>
		coldRead({
			workspaceId: "joined-a",
			worktreePath: "/repo-joined/wt-a",
			directoryId: "joined-a-directory",
			onWalk: () => {
				reads++;
			},
		});

	await read();
	gitStatusStore.noteColdBaseRefFetch({
		workspaceId: "joined-a",
		baseBranch: null,
		fetchKey: await resolveBaseRefFetchKey(
			joinedGit,
			"/repo-joined/wt-a",
			joinedTarget,
		),
	});
	expect(reads).toBe(1);

	let releaseFetch = () => {};
	const fetching = new Promise<void>((resolve) => {
		releaseFetch = resolve;
	});
	let announceFetchStarted = () => {};
	const fetchStarted = new Promise<void>((resolve) => {
		announceFetchStarted = resolve;
	});
	scheduleBaseRefRepair({
		git: joinedGit,
		worktreePath: "/repo-joined/wt-a",
		workspaceId: "joined-a",
		baseBranch: null,
		target: joinedTarget,
		walkStartedAt: Date.now(),
		fetchBaseRef: () => {
			announceFetchStarted();
			return fetching;
		},
	});
	await fetchStarted;

	scheduleBaseRefRepair({
		git: joinedGit,
		worktreePath: "/repo-joined/wt-b",
		workspaceId: "joined-b",
		baseBranch: null,
		target: joinedTarget,
		walkStartedAt: Date.now(),
		fetchBaseRef: async () => {
			throw new Error("the in-flight fetch must be joined, not restarted");
		},
	});
	// A macrotask drains every microtask the joining repair runs on, so it has
	// reached the in-flight fetch before the fetch resolves.
	await new Promise((resolve) => setTimeout(resolve, 0));
	releaseFetch();
	await awaitBaseRefRepairs();

	await read();
	expect(reads).toBe(1);
});
