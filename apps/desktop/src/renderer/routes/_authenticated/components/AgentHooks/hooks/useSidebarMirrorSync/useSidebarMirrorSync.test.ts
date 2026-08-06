import { describe, expect, test } from "bun:test";
import {
	buildMirrorSnapshot,
	createMirrorPushLoop,
	type MirrorSnapshot,
	signatureOf,
} from "./useSidebarMirrorSync";

// The loop's timings are injected, so these drive real timers at millisecond
// scale rather than waiting out the production debounce.
const DEBOUNCE_MS = 1;
const RETRY_DELAYS_MS = [2, 4] as const;
const RETRY_CAP_MS = 8;

function tick(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function localStateRow(overrides: Record<string, unknown> = {}) {
	return {
		workspaceId: "w-1",
		projectId: "p-1",
		sectionId: null,
		tabOrder: 0,
		isHidden: false,
		archivedAt: null,
		snoozeUntil: null,
		snoozeLaunchId: null,
		completedAt: null,
		deletedAt: null,
		pinnedAt: null,
		...overrides,
	};
}

function projectRow(overrides: Record<string, unknown> = {}) {
	return {
		projectId: "p-1",
		tabOrder: 0,
		isPinned: false,
		isCollapsed: false,
		...overrides,
	};
}

describe("buildMirrorSnapshot", () => {
	test("sorts both collections by key, so the signature is a function of CONTENT and a live-query re-emission does not re-push", () => {
		const forwards = buildMirrorSnapshot(
			[localStateRow({ workspaceId: "w-2" }), localStateRow()],
			[projectRow({ projectId: "p-2" }), projectRow()],
		);
		const backwards = buildMirrorSnapshot(
			[localStateRow(), localStateRow({ workspaceId: "w-2" })],
			[projectRow(), projectRow({ projectId: "p-2" })],
		);
		expect(signatureOf(forwards)).toBe(signatureOf(backwards));
	});

	test("DROPS a row with no identity and counts it — a NOT NULL column on the far side, and no row means the consumer shows the thread", () => {
		const snapshot = buildMirrorSnapshot(
			[localStateRow(), localStateRow({ workspaceId: undefined })],
			[projectRow()],
		);
		expect(snapshot.workspaces).toHaveLength(1);
		expect(snapshot.droppedRows).toBe(1);
	});

	test("DROPS a row whose placement project is missing — 'nowhere' is not a statement the mirror can make", () => {
		const snapshot = buildMirrorSnapshot(
			[localStateRow({ projectId: null })],
			[projectRow()],
		);
		expect(snapshot.workspaces).toEqual([]);
		expect(snapshot.droppedRows).toBe(1);
	});

	test("sends a corrupt timestamp as ABSENT and counts it, rather than mirroring a hiding field it cannot trust", () => {
		const snapshot = buildMirrorSnapshot(
			[localStateRow({ deletedAt: "yesterday" })],
			[projectRow()],
		);
		expect(snapshot.workspaces[0]?.deletedAt).toBeNull();
		expect(snapshot.rejectedFields).toBeGreaterThan(0);
	});

	test("the counters are not part of the identity — they describe the derivation, not the curation", () => {
		const clean = buildMirrorSnapshot([localStateRow()], [projectRow()]);
		const withJunk = buildMirrorSnapshot(
			[localStateRow(), localStateRow({ workspaceId: null })],
			[projectRow()],
		);
		expect(signatureOf(clean)).toBe(signatureOf(withJunk));
	});
});

/** A snapshot distinguishable by its single workspace's `tabOrder`. */
function snapshotAt(tabOrder: number): MirrorSnapshot {
	return buildMirrorSnapshot([localStateRow({ tabOrder })], [projectRow()]);
}

describe("createMirrorPushLoop", () => {
	test("debounces, then sends the NEWEST snapshot — not the one the loop was built for", async () => {
		const inFlight = { current: null as Promise<void> | null };
		let newest = snapshotAt(0);
		const sent: MirrorSnapshot[] = [];

		const loop = createMirrorPushLoop({
			inFlight,
			getSnapshot: () => newest,
			send: async (snapshot) => {
				sent.push(snapshot);
			},
			onSynced: () => {},
			debounceMs: DEBOUNCE_MS,
			retryDelaysMs: RETRY_DELAYS_MS,
			retryCapMs: RETRY_CAP_MS,
			report: () => {},
		});
		loop.start();
		newest = snapshotAt(7);
		await tick(20);

		expect(sent).toHaveLength(1);
		expect(sent[0]?.workspaces[0]?.tabOrder).toBe(7);
	});

	test("WAITS for an outstanding push instead of racing it, then re-pushes current state", async () => {
		let releaseFirst = (): void => {};
		const first = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const inFlight: { current: Promise<void> | null } = { current: first };
		const sent: MirrorSnapshot[] = [];

		const loop = createMirrorPushLoop({
			inFlight,
			getSnapshot: () => snapshotAt(3),
			send: async (snapshot) => {
				sent.push(snapshot);
			},
			onSynced: () => {},
			debounceMs: DEBOUNCE_MS,
			retryDelaysMs: RETRY_DELAYS_MS,
			retryCapMs: RETRY_CAP_MS,
			report: () => {},
		});
		loop.start();
		await tick(10);
		// Two mutations on separate loopback connections have no ordering
		// guarantee, so nothing may go out while one is outstanding.
		expect(sent).toEqual([]);

		inFlight.current = null;
		releaseFirst();
		await tick(20);
		expect(sent).toHaveLength(1);
	});

	test("retries on a failed send, on the schedule it was given, and never gives up", async () => {
		const inFlight = { current: null as Promise<void> | null };
		let attempts = 0;
		const reported: string[] = [];

		const loop = createMirrorPushLoop({
			inFlight,
			getSnapshot: () => snapshotAt(1),
			send: async () => {
				attempts += 1;
				if (attempts < 3) throw new Error("host-service is down");
			},
			onSynced: () => {},
			debounceMs: DEBOUNCE_MS,
			retryDelaysMs: RETRY_DELAYS_MS,
			retryCapMs: RETRY_CAP_MS,
			report: (message) => {
				reported.push(message);
			},
		});
		loop.start();
		await tick(60);

		expect(attempts).toBe(3);
		// A mirror that stops updating is invisible from the desktop, so every
		// failure is said out loud.
		expect(reported.length).toBeGreaterThanOrEqual(2);
		loop.cancel();
	});

	test("a cancelled loop stops retrying — a newer signature has taken over", async () => {
		const inFlight = { current: null as Promise<void> | null };
		let attempts = 0;

		const loop = createMirrorPushLoop({
			inFlight,
			getSnapshot: () => snapshotAt(1),
			send: async () => {
				attempts += 1;
				throw new Error("host-service is down");
			},
			onSynced: () => {},
			debounceMs: DEBOUNCE_MS,
			retryDelaysMs: RETRY_DELAYS_MS,
			retryCapMs: RETRY_CAP_MS,
			report: () => {},
		});
		loop.start();
		await tick(10);
		loop.cancel();
		const afterCancel = attempts;
		await tick(30);

		expect(attempts).toBe(afterCancel);
	});

	/**
	 * (MIRROR-SYNC-CANCEL-RACE) The finding this file was written for. A push
	 * that resolves after its loop was cancelled has still CHANGED `host.db`, and
	 * if nothing records what it sent, the hook's skip-gate can suppress the very
	 * push that would undo it.
	 */
	test("records the snapshot it actually sent even when the loop was cancelled mid-flight", async () => {
		const inFlight = { current: null as Promise<void> | null };
		let releaseSend = (): void => {};
		const synced: MirrorSnapshot[] = [];
		const intermediate = snapshotAt(42);

		const loop = createMirrorPushLoop({
			inFlight,
			getSnapshot: () => intermediate,
			send: () =>
				new Promise<void>((resolve) => {
					releaseSend = resolve;
				}),
			onSynced: (sent) => {
				synced.push(sent);
			},
			debounceMs: DEBOUNCE_MS,
			retryDelaysMs: RETRY_DELAYS_MS,
			retryCapMs: RETRY_CAP_MS,
			report: () => {},
		});
		loop.start();
		await tick(10);

		// A newer signature arrives and cancels this loop while its send is still
		// on the wire.
		loop.cancel();
		releaseSend();
		await tick(10);

		expect(synced).toHaveLength(1);
		expect(signatureOf(synced[0] as MirrorSnapshot)).toBe(
			signatureOf(intermediate),
		);
	});

	test("does NOT report a cancelled send that FAILED — nothing landed, so there is nothing to record", async () => {
		const inFlight = { current: null as Promise<void> | null };
		let rejectSend = (_error: Error): void => {};
		const synced: MirrorSnapshot[] = [];

		const loop = createMirrorPushLoop({
			inFlight,
			getSnapshot: () => snapshotAt(5),
			send: () =>
				new Promise<void>((_resolve, reject) => {
					rejectSend = reject;
				}),
			onSynced: (sent) => {
				synced.push(sent);
			},
			debounceMs: DEBOUNCE_MS,
			retryDelaysMs: RETRY_DELAYS_MS,
			retryCapMs: RETRY_CAP_MS,
			report: () => {},
		});
		loop.start();
		await tick(10);

		loop.cancel();
		rejectSend(new Error("host-service is down"));
		await tick(10);

		expect(synced).toEqual([]);
	});
});
