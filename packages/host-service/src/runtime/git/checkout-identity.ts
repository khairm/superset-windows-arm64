import { stat } from "node:fs/promises";

// (DIFFSTATS-COLD-CACHE)
export interface CheckoutIdentity {
	worktreePath: string;
	directoryId: string;
}

export async function resolveCheckoutIdentity(
	worktreePath: string,
): Promise<CheckoutIdentity> {
	const directory = await stat(worktreePath, { bigint: true });
	return {
		worktreePath,
		directoryId: [directory.dev, directory.ino, directory.birthtimeNs].join(
			"\0",
		),
	};
}
