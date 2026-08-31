import { describe, expect, it } from "bun:test";
import {
	kanbanCardsStorageKey,
	workspaceLocalStateStorageKey,
} from "./collectionStorageKeys";
import { recordLocalCollectionPersistFailure } from "./localCollectionPersistence";
import { withQuotaGuard } from "./withQuotaGuard";
import {
	persistWorkspaceExitMutation,
	waitForWorkspaceExitPersistence,
} from "./workspaceExitPersistence";

function deferred(): {
	promise: Promise<void>;
	resolve: () => void;
} {
	let resolve!: () => void;
	const promise = new Promise<void>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

function quotaError(): Error {
	const error = new Error("exceeded the quota");
	error.name = "QuotaExceededError";
	return error;
}

describe("workspace exit persistence", () => {
	it("blocks cleanup until both the card intent and exit row are persisted", async () => {
		const organizationId = "org-success";
		const cardTransaction = deferred();
		const exitTransaction = deferred();
		let exitMutated = false;
		const confirmation = persistWorkspaceExitMutation(
			organizationId,
			"workspace-1",
			100,
			() => {
				exitMutated = true;
				return { isPersisted: exitTransaction };
			},
			[
				{
					storageKey: kanbanCardsStorageKey(organizationId),
					mutate: () => ({ isPersisted: cardTransaction }),
				},
			],
		);
		let waitSettled = false;
		const wait = waitForWorkspaceExitPersistence(
			organizationId,
			"workspace-1",
			100,
		).then((result) => {
			waitSettled = true;
			return result;
		});

		await Promise.resolve();
		expect(waitSettled).toBe(false);
		expect(exitMutated).toBe(false);

		cardTransaction.resolve();
		await Promise.resolve();
		await Promise.resolve();
		expect(exitMutated).toBe(true);
		expect(waitSettled).toBe(false);

		exitTransaction.resolve();
		await confirmation;
		expect(await wait).toBe(true);
	});

	it("keeps cleanup blocked when quota handling drops either durable write", async () => {
		for (const failedCollection of ["card", "exit"] as const) {
			const organizationId = `org-quota-failure-${failedCollection}`;
			const workspaceId = `workspace-${failedCollection}`;
			const cleanupStamp = 200;
			const cardStorageKey = kanbanCardsStorageKey(organizationId);
			const exitStorageKey = workspaceLocalStateStorageKey(organizationId);
			const guarded = withQuotaGuard(
				{},
				{
					storage: {
						getItem: () => null,
						removeItem: () => {},
						setItem: () => {
							throw quotaError();
						},
					},
					reclaim: () => 0,
					onPersistFailed: (key) =>
						recordLocalCollectionPersistFailure(key),
				},
			) as { storage: { setItem: (key: string, value: string) => void } };

			const confirmation = persistWorkspaceExitMutation(
				organizationId,
				workspaceId,
				cleanupStamp,
				() => {
					if (failedCollection === "exit") {
						guarded.storage.setItem(exitStorageKey, "exit state");
					}
					return { isPersisted: { promise: Promise.resolve() } };
				},
				[
					{
						storageKey: cardStorageKey,
						mutate: () => {
							if (failedCollection === "card") {
								guarded.storage.setItem(cardStorageKey, "card intent");
							}
							return { isPersisted: { promise: Promise.resolve() } };
						},
					},
				],
			);

			await expect(confirmation).rejects.toThrow(
				`Workspace exit was not saved for ${workspaceId}`,
			);
			expect(
				await waitForWorkspaceExitPersistence(
					organizationId,
					workspaceId,
					cleanupStamp,
				),
			).toBe(false);

			const replacementStamp = cleanupStamp + 1;
			await persistWorkspaceExitMutation(
				organizationId,
				workspaceId,
				replacementStamp,
				() => ({ isPersisted: { promise: Promise.resolve() } }),
			);
			expect(
				await waitForWorkspaceExitPersistence(
					organizationId,
					workspaceId,
					replacementStamp,
				),
			).toBe(true);
		}
	});
});
