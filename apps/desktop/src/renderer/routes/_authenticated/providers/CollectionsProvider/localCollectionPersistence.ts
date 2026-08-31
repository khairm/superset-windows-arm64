export interface PersistableTransaction {
	isPersisted: { promise: Promise<unknown> };
}

interface LocalCollectionWriteReceipt {
	readonly storageKey: string;
	readonly failureGeneration: number;
}

const failureGenerations = new Map<string, number>();

export function recordLocalCollectionPersistFailure(storageKey: string): void {
	failureGenerations.set(
		storageKey,
		(failureGenerations.get(storageKey) ?? 0) + 1,
	);
}

export function beginLocalCollectionWrite(
	storageKey: string,
): LocalCollectionWriteReceipt {
	if (storageKey.length === 0) {
		throw new Error("Cannot track persistence without a storage key");
	}
	return {
		storageKey,
		failureGeneration: failureGenerations.get(storageKey) ?? 0,
	};
}

export async function confirmLocalCollectionWrite(
	receipt: LocalCollectionWriteReceipt,
	transaction: PersistableTransaction,
): Promise<void> {
	if (
		!transaction ||
		typeof transaction !== "object" ||
		!transaction.isPersisted ||
		typeof transaction.isPersisted.promise?.then !== "function"
	) {
		throw new Error("Local collection mutation returned no persistence promise");
	}
	await transaction.isPersisted.promise;
	if (
		(failureGenerations.get(receipt.storageKey) ?? 0) !==
		receipt.failureGeneration
	) {
		throw new Error(
			`Local collection write was not saved because storage is full: ${receipt.storageKey}`,
		);
	}
}
