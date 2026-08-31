import { workspaceLocalStateStorageKey } from "./collectionStorageKeys";
import {
	beginLocalCollectionWrite,
	confirmLocalCollectionWrite,
	type PersistableTransaction,
} from "./localCollectionPersistence";

export interface WorkspaceExitMutation {
	readonly storageKey: string;
	readonly mutate: () => PersistableTransaction;
}

interface PendingAttempt {
	readonly settled: Promise<void>;
	resolve: () => void;
}

interface WorkspaceExitEntry {
	readonly cleanupStamp: number;
	readonly attempts: Set<PendingAttempt>;
	failed: boolean;
}

const pendingExits = new Map<string, WorkspaceExitEntry>();

function validateOrganizationId(organizationId: string): void {
	if (organizationId.length === 0) {
		throw new Error(
			"Cannot persist a workspace exit without an organization ID",
		);
	}
}

function workspaceExitKey(organizationId: string, workspaceId: string): string {
	validateOrganizationId(organizationId);
	if (workspaceId.length === 0) {
		throw new Error("Cannot persist a workspace exit without a workspace ID");
	}
	return JSON.stringify([organizationId, workspaceId]);
}

function validateCleanupStamp(cleanupStamp: number): void {
	if (!Number.isSafeInteger(cleanupStamp) || cleanupStamp <= 0) {
		throw new Error(
			"Cannot persist a workspace exit with an invalid cleanup stamp",
		);
	}
}

function createAttempt(): PendingAttempt {
	let resolve!: () => void;
	const settled = new Promise<void>((settle) => {
		resolve = settle;
	});
	return { settled, resolve };
}

function getOrReplaceEntry(
	key: string,
	cleanupStamp: number,
): WorkspaceExitEntry {
	const existing = pendingExits.get(key);
	if (existing?.cleanupStamp === cleanupStamp) return existing;
	if (existing) {
		for (const attempt of existing.attempts) attempt.resolve();
	}
	const entry: WorkspaceExitEntry = {
		cleanupStamp,
		attempts: new Set(),
		failed: false,
	};
	pendingExits.set(key, entry);
	return entry;
}

function finishAttempt(
	key: string,
	entry: WorkspaceExitEntry,
	attempt: PendingAttempt,
	persisted: boolean,
): void {
	entry.attempts.delete(attempt);
	if (!persisted) entry.failed = true;
	attempt.resolve();
	if (
		pendingExits.get(key) === entry &&
		entry.attempts.size === 0 &&
		!entry.failed
	) {
		pendingExits.delete(key);
	}
}

export function persistWorkspaceExitMutations(
	organizationId: string,
	workspaceId: string,
	cleanupStamp: number,
	mutations: readonly WorkspaceExitMutation[],
): Promise<void> {
	validateCleanupStamp(cleanupStamp);
	if (mutations.length === 0) {
		throw new Error("Cannot persist a workspace exit without any mutations");
	}
	const key = workspaceExitKey(organizationId, workspaceId);
	const entry = getOrReplaceEntry(key, cleanupStamp);
	const attempt = createAttempt();
	entry.attempts.add(attempt);

	let trackedMutations: Array<{
		receipt: ReturnType<typeof beginLocalCollectionWrite>;
		mutate: () => PersistableTransaction;
	}>;
	try {
		trackedMutations = mutations.map(({ storageKey, mutate }) => ({
			receipt: beginLocalCollectionWrite(storageKey),
			mutate,
		}));
	} catch (error) {
		finishAttempt(key, entry, attempt, false);
		throw error;
	}

	// Persist intent first and the destructive exit row last. Starting the exit
	// write before an earlier intent write is durable can leave cleanup debt on
	// disk without the user action that created it after a renderer restart.
	const persistInOrder = async () => {
		for (const { receipt, mutate } of trackedMutations) {
			await confirmLocalCollectionWrite(receipt, mutate());
		}
	};
	return persistInOrder().then(
		() => {
			finishAttempt(key, entry, attempt, true);
		},
		(error: unknown) => {
			finishAttempt(key, entry, attempt, false);
			throw new Error(`Workspace exit was not saved for ${workspaceId}`, {
				cause: error,
			});
		},
	);
}

export function persistWorkspaceExitMutation(
	organizationId: string,
	workspaceId: string,
	cleanupStamp: number,
	mutate: () => PersistableTransaction,
	additionalMutations: readonly WorkspaceExitMutation[] = [],
): Promise<void> {
	return persistWorkspaceExitMutations(
		organizationId,
		workspaceId,
		cleanupStamp,
		[
			...additionalMutations,
			{
				storageKey: workspaceLocalStateStorageKey(organizationId),
				mutate,
			},
		],
	);
}

export async function waitForWorkspaceExitPersistence(
	organizationId: string,
	workspaceId: string,
	cleanupStamp: number,
): Promise<boolean> {
	validateCleanupStamp(cleanupStamp);
	const key = workspaceExitKey(organizationId, workspaceId);
	while (true) {
		const entry = pendingExits.get(key);
		if (!entry || entry.cleanupStamp !== cleanupStamp) return true;
		if (entry.failed) return false;
		await Promise.all(
			Array.from(entry.attempts, (attempt) => attempt.settled),
		);
		if (pendingExits.get(key) !== entry) continue;
		if (entry.failed) return false;
		if (entry.attempts.size > 0) continue;
		return true;
	}
}
