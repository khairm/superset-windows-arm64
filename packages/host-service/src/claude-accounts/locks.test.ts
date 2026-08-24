import { describe, expect, it } from "bun:test";
import {
	WorkspaceLockBusyError,
	WorkspaceLocks,
	WorkspaceLockTimeoutError,
} from "./locks";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";

describe("WorkspaceLocks", () => {
	it("allows the current operation to re-enter its workspace lock", async () => {
		const locks = new WorkspaceLocks();
		const result = await locks.withLock(WORKSPACE_ID, () =>
			locks.withLock(WORKSPACE_ID, async () => "done"),
		);
		expect(result).toBe("done");
	});

	it("fails immediately when tryOnly finds a held lock", async () => {
		const locks = new WorkspaceLocks();
		let release!: () => void;
		const held = locks.withLock(
			WORKSPACE_ID,
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		await Promise.resolve();
		await expect(
			locks.withLock(WORKSPACE_ID, async () => undefined, { tryOnly: true }),
		).rejects.toBeInstanceOf(WorkspaceLockBusyError);
		release();
		await held;
	});

	it("does not treat detached work as reentrant after release", async () => {
		const locks = new WorkspaceLocks();
		let startDetached!: () => void;
		let detached!: Promise<"acquired" | "busy">;
		await locks.withLock(WORKSPACE_ID, async () => {
			detached = (async () => {
				await new Promise<void>((resolve) => {
					startDetached = resolve;
				});
				try {
					await locks.withLock(WORKSPACE_ID, async () => undefined, {
						tryOnly: true,
					});
					return "acquired";
				} catch (error) {
					if (error instanceof WorkspaceLockBusyError) return "busy";
					throw error;
				}
			})();
		});

		let releaseContender!: () => void;
		const contender = locks.withLock(
			WORKSPACE_ID,
			() =>
				new Promise<void>((resolve) => {
					releaseContender = resolve;
				}),
		);
		await Promise.resolve();
		startDetached();
		expect(await detached).toBe("busy");
		releaseContender();
		await contender;
	});

	it("sorts multi-lock ids before acquiring them", async () => {
		const locks = new WorkspaceLocks();
		let releaseFirst!: () => void;
		const firstHeld = locks.withLock(
			WORKSPACE_ID,
			() =>
				new Promise<void>((resolve) => {
					releaseFirst = resolve;
				}),
		);
		await Promise.resolve();
		const multiple = locks.withLocks(
			[SECOND_WORKSPACE_ID, WORKSPACE_ID],
			async () => "done",
		);
		await Promise.resolve();
		await expect(
			locks.withLock(SECOND_WORKSPACE_ID, async () => undefined, {
				tryOnly: true,
			}),
		).resolves.toBeUndefined();
		releaseFirst();
		expect(await multiple).toBe("done");
		await firstHeld;
	});

	it("allows a multi-lock operation to re-enter a subset", async () => {
		const locks = new WorkspaceLocks();
		const result = await locks.withLocks(
			[SECOND_WORKSPACE_ID, WORKSPACE_ID],
			() => locks.withLocks([WORKSPACE_ID], async () => "done"),
		);
		expect(result).toBe("done");
	});

	it("bounds queued lock acquisition", async () => {
		const locks = new WorkspaceLocks();
		let release!: () => void;
		const held = locks.withLock(
			WORKSPACE_ID,
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		await Promise.resolve();
		await expect(
			locks.withLock(WORKSPACE_ID, async () => undefined, { timeoutMs: 5 }),
		).rejects.toBeInstanceOf(WorkspaceLockTimeoutError);
		release();
		await held;
	});
});
